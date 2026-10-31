<?php
// Chat routes (plan §4.2, §5.4–5.7, §5.10). Every route has tag chat: the file <shared>/chat-off or config
// chat_force_off answers 503 chat_off before any database work (Routes::dispatch). Guests read through public routes
// that never read cookies (public-chat-channels, public-chat; shared caches may keep them 30 s / 2 s); signed-in people
// read through peek routes (no session write, no file, no cookie; PHP's files handler still takes the session file lock
// while it reads, so a poll can wait behind a long request of the same session; it holds the lock only for that read
// and, for a member session, one short refresh write per idle/4). Writes are session POSTs with Origin and CSRF checks.
// Limits (§5.7): sending by chat_settings.send (gap 2 s, 20/min, 300/day), deleting 60/h, reporting 20/h per person;
// reading has no per-IP limit in v1 (sports halls share one address behind NAT).
// After a message is sent, background jobs may run (Jobs::maybe from a shutdown function; it releases the session first).
declare(strict_types=1);
use MatDraw\{AppError,ApiError,Chat,ChatModeration,ChatSettings,Jobs,RateLimit,RouteContext,Routes};

/** RateLimit per person for chat writes; the caller's literal message (i18n) is thrown by $fail. */
$limit=static function(RouteContext $ctx,string $scope,int $max,callable $fail):void{
 if($s=RateLimit::hit($ctx->pdo(),$ctx->config['app_key'],$scope,$ctx->user()['id'],$max,3600))$fail(Routes::retryAfter($s));
};
return [
 'public-chat-channels'=>['method'=>'GET','auth'=>'public','tag'=>'chat','handler'=>function(RouteContext $ctx):array{
  $out=Chat::lists($ctx->pdo(),null,time());header('Cache-Control: public, max-age=30');return $out;
 }],
 'public-chat'=>['method'=>'GET','auth'=>'public','tag'=>'chat','handler'=>function(RouteContext $ctx):?array{
  $q=Chat::parseQuery($_GET);$out=Chat::feed($ctx->pdo(),$ctx->config,$q,null,Chat::nowMs());header('Cache-Control: public, max-age=2');return $out;
 }],
 'chat-channels'=>['method'=>'GET','auth'=>'peek','user'=>'required','tag'=>'chat','handler'=>function(RouteContext $ctx):array{
  return Chat::lists($ctx->pdo(),$ctx->user(),time());
 }],
 // Signed in: own one-query viewer (users ⋈ billing_accounts) instead of RouteContext::user(), so an idle poll of a
 // member costs the session read and 3–4 queries by key (§2.7). Without full access: the guest projection.
 'chat-feed'=>['method'=>'GET','auth'=>'peek','user'=>'optional','tag'=>'chat','handler'=>function(RouteContext $ctx):?array{
  $q=Chat::parseQuery($_GET);$v=Chat::peekViewer($ctx->config,fn()=>$ctx->pdo(),time());
  if(!$v)throw new AppError('Zaloguj się ponownie.',401);
  return Chat::feed($ctx->pdo(),$ctx->config,$q,$v,Chat::nowMs());
 }],
 // user optional: the chat switch of the settings (503) is checked before the sign-in (401), as §5.5 orders.
 'chat-send'=>['method'=>'POST','auth'=>'session','user'=>'optional','tag'=>'chat','max'=>8192,'handler'=>function(RouteContext $ctx):array{
  $pdo=$ctx->pdo();$c=$ctx->config;$settings=ChatSettings::get($pdo);$u=$settings['data']['on']?$ctx->user():null;
  $out=Chat::send($pdo,$c,$u?Chat::viewer($pdo,$u['id'],$c,time(),true):null,$settings,$ctx->body);
  register_shutdown_function(static fn()=>Jobs::maybe($pdo,$c));
  return $out;
 }],
 'chat-delete'=>['method'=>'POST','auth'=>'session','tag'=>'chat','max'=>2048,'handler'=>function(RouteContext $ctx)use($limit):array{
  $limit($ctx,'chat-delete',60,fn(int $s)=>throw new ApiError('Zbyt wiele usunięć wiadomości. Spróbuj ponownie później.',429,['retry'=>$s]));
  return Chat::delete($ctx->pdo(),$ctx->user(),$ctx->input('id'),$ctx->input('note'),ChatSettings::get($ctx->pdo())['data']['graceDays']);
 }],
 'chat-report'=>['method'=>'POST','auth'=>'session','tag'=>'chat','max'=>4096,'handler'=>function(RouteContext $ctx)use($limit):array{
  $limit($ctx,'chat-report',20,fn(int $s)=>throw new ApiError('Zbyt wiele zgłoszeń. Spróbuj ponownie później.',429,['retry'=>$s]));
  $pdo=$ctx->pdo();$v=Chat::viewer($pdo,$ctx->user()['id'],$ctx->config,time());if(!$v)throw new AppError('Zaloguj się ponownie.',401);
  return ChatModeration::report($pdo,$v,$ctx->body,ChatSettings::get($pdo));
 }],
 'admin-chat-reports'=>['method'=>'GET','auth'=>'peek','user'=>'admin','tag'=>'chat','handler'=>function(RouteContext $ctx):array{
  return ChatModeration::adminReports($ctx->pdo(),$_GET,time());
 }],
 'admin-chat-action'=>['method'=>'POST','auth'=>'session','user'=>'admin','tag'=>'chat','max'=>4096,'handler'=>function(RouteContext $ctx):array{
  return ChatModeration::adminAction($ctx->pdo(),$ctx->user(),$ctx->body,ChatSettings::get($ctx->pdo()));
 }],
 'admin-chat-settings'=>['method'=>'GET','auth'=>'peek','user'=>'admin','tag'=>'chat','handler'=>function(RouteContext $ctx):array{
  return ChatSettings::view($ctx->pdo(),time());
 }],
 'admin-chat-settings-save'=>['method'=>'POST','auth'=>'session','user'=>'admin','tag'=>'chat','max'=>4096,'handler'=>function(RouteContext $ctx):array{
  return ChatSettings::save($ctx->pdo(),$ctx->body,$ctx->user()['id'],time());
 }],
];
