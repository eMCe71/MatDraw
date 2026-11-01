<?php
// Athlete routes (PLAN-REJESTRACJA-ROLE §6–§8.1): the public club list and a member's own athlete profiles and self-entries.
//   public-clubs      GET public: verified clubs that are not merged, by name, at most 2000, Cache-Control 300 s
//   athlete           GET peek, member: AthleteView::build (no workspace, no lock)
//   athlete-save      POST session, member: athlete.save (§6.1)                       20/h per account (with athlete-archive)
//   athlete-archive   POST session, member: athlete.archive {profileId, archived}      20/h (shared)
//   athlete-forget    POST session, member: athlete.forget {profileId, password}       5/h, password with the login limits
//   athlete-entry     POST session, member, 4 KB: entry.self (§7.2); 402 without full access in paid mode   30/h (with withdraw)
//                     except a correction (update:true) of an own entry without new events (R12: correcting own data)
//   athlete-withdraw  POST session, member: entry.remove {tournamentId, id=profileId} of an own profile (§7.3)   30/h (shared)
// Every write is one Repository::transaction with the member actor (Actors::of) and Domain::execute at the current revision
// (scoped revisions, §5.8), after the account's own limit and the global bucket of member transactions (member-tx, 120 per
// minute for all members together; staff never wait for it, §3.7). Withdrawing, correcting and deleting own data and the
// view never need full access (R12). Only the listed body fields reach Domain (closed field lists, §6.1, §11).
// Settings::effective is idempotent: the routes call it so the switches are the effective ones also before the central
// overlay (settings-backend); Settings::flags gives Domain's trust rule (§17).
declare(strict_types=1);
use MatDraw\{Access,Actors,ApiError,AppError,AthleteView,Auth,Domain,RateLimit,Repository,RouteContext,Routes,Settings};

$config=static fn(RouteContext $ctx):array=>Settings::effective($ctx->pdo(),$ctx->config);
$fields=static fn(array $body,array $keys):array=>array_intersect_key($body,array_flip($keys));
/** One member transaction: the global bucket, then Domain::execute under the workspace lock with the member actor. */
$run=static function(RouteContext $ctx,array $c,array $actor,string $type,array $payload):array{
 $pdo=$ctx->pdo();
 if($s=RateLimit::hit($pdo,$c['app_key'],'member-tx','all',120,60))throw new ApiError('Serwer jest teraz mocno obciążony. Spróbuj ponownie za chwilę.',429,['retry'=>Routes::retryAfter($s)]);
 return (new Repository($pdo))->transaction(fn(array &$db)=>Domain::execute($db,$actor['id'],$type,$payload,(int)$db['revision']),$actor,Settings::flags($c));
};
$saveLimit=static function(RouteContext $ctx,array $c):void{if($s=RateLimit::hit($ctx->pdo(),$c['app_key'],'athlete-save',$ctx->user()['id'],20,3600))throw new ApiError('Zbyt wiele zmian danych zawodnika. Spróbuj ponownie później.',429,['retry'=>Routes::retryAfter($s)]);};
$entryLimit=static function(RouteContext $ctx,array $c):void{if($s=RateLimit::hit($ctx->pdo(),$c['app_key'],'athlete-entry',$ctx->user()['id'],30,3600))throw new ApiError('Zbyt wiele zmian zgłoszeń. Spróbuj ponownie później.',429,['retry'=>Routes::retryAfter($s)]);};
/** R12: a correction of an own existing entry (update:true, the events a subset of the entry's) never needs full access; anything else does. */
$correction=static function(RouteContext $ctx):bool{
 if($ctx->input('update')!==true||!is_string($t=$ctx->input('tournamentId'))||!is_string($id=$ctx->input('profileId')))return false;
 $q=$ctx->pdo()->prepare('SELECT e.snapshot FROM entries e JOIN profiles p ON p.id=e.profile_id WHERE e.tournament_id=? AND e.profile_id=? AND p.owner_user_id=?');$q->execute([$t,$id,$ctx->user()['id']]);
 $old=$q->fetchColumn();if(!is_string($old))return false;$had=json_decode($old,true)['events']??[];$events=$ctx->input('events');
 return $events===null||(is_array($events)&&is_array($had)&&$events===array_values(array_filter($events,fn($e)=>in_array($e,$had,true))));
};
$view=static fn(RouteContext $ctx,array $c):array=>AthleteView::build($ctx->pdo(),$ctx->user(),date('Y-m-d'),Settings::flags($c));
$caps=static fn(RouteContext $ctx):array=>Actors::of($ctx->pdo(),$ctx->user())['caps'];
return [
 'public-clubs'=>['method'=>'GET','auth'=>'public','handler'=>function(RouteContext $ctx):array{
  $q=$ctx->pdo()->prepare('SELECT id,name FROM clubs WHERE verified=1 AND merged_into IS NULL AND id<>? ORDER BY name,id LIMIT 2000');$q->execute(['unaffiliated']);
  header('Cache-Control: public, max-age=300');
  return ['clubs'=>array_map(fn($r)=>['id'=>$r['id'],'name'=>$r['name']],$q->fetchAll(PDO::FETCH_ASSOC)),'unaffiliated'=>'unaffiliated'];
 }],
 'athlete'=>['method'=>'GET','auth'=>'peek','user'=>'member','handler'=>fn(RouteContext $ctx):array=>$view($ctx,$config($ctx))],
 'athlete-save'=>['method'=>'POST','auth'=>'session','user'=>'member','handler'=>function(RouteContext $ctx)use($config,$fields,$run,$saveLimit,$view,$caps):array{
  $c=$config($ctx);$saveLimit($ctx,$c);
  $r=$run($ctx,$c,Actors::of($ctx->pdo(),$ctx->user()),'athlete.save',$fields($ctx->body,['id','name','birthDate','sex','weight','height','gradeType','grade','club','relation']));
  $profile=null;foreach($view($ctx,$c)['profiles'] as $p)if($p['id']===$r['id'])$profile=$p;
  return ['profile'=>$profile,'caps'=>$caps($ctx)]+(isset($r['notice'])?['notice'=>$r['notice']]:[]);
 }],
 'athlete-archive'=>['method'=>'POST','auth'=>'session','user'=>'member','handler'=>function(RouteContext $ctx)use($config,$run,$saveLimit,$caps):array{
  $c=$config($ctx);$saveLimit($ctx,$c);
  $run($ctx,$c,Actors::of($ctx->pdo(),$ctx->user()),'athlete.archive',['profileId'=>$ctx->input('profileId'),'archived'=>$ctx->input('archived')!==false]);
  return ['caps'=>$caps($ctx)];
 }],
 'athlete-forget'=>['method'=>'POST','auth'=>'session','user'=>'member','handler'=>function(RouteContext $ctx)use($config,$run,$caps):array{
  $c=$config($ctx);$pdo=$ctx->pdo();$u=$ctx->user();
  if($s=RateLimit::hit($pdo,$c['app_key'],'athlete-forget',$u['id'],5,3600))throw new ApiError('Zbyt wiele prób. Spróbuj ponownie później.',429,['retry'=>Routes::retryAfter($s)]);
  Auth::reserveLogin($pdo,$c,$u['email']);$password=$ctx->input('password');
  if(!is_string($password)||!password_verify($password,$u['passwordHash']))throw new AppError('Nieprawidłowe obecne hasło.');
  $run($ctx,$c,Actors::of($pdo,$u),'athlete.forget',['profileId'=>$ctx->input('profileId')]);
  return ['caps'=>$caps($ctx)];
 }],
 'athlete-entry'=>['method'=>'POST','auth'=>'session','user'=>'member','max'=>4096,'handler'=>function(RouteContext $ctx)use($config,$fields,$run,$entryLimit,$view,$correction):array{
  $c=$config($ctx);$entryLimit($ctx,$c);
  if(!Access::of($ctx->pdo(),$ctx->user(),$c)['full']&&!$correction($ctx))throw new ApiError('Zgłoszenia do turniejów wymagają aktywnego konta.',402);
  $r=$run($ctx,$c,Actors::of($ctx->pdo(),$ctx->user()),'entry.self',$fields($ctx->body,['tournamentId','profileId','events','weight','height','gradeType','grade','saveToProfile','update']));
  $entry=null;foreach($view($ctx,$c)['entries'] as $e)if($e['profileId']===$r['id']&&$e['tournament']['id']===$r['tournamentId'])$entry=$e;
  return ['ok'=>true,'entry'=>$entry];
 }],
 'athlete-withdraw'=>['method'=>'POST','auth'=>'session','user'=>'member','handler'=>function(RouteContext $ctx)use($config,$run,$entryLimit):array{
  $c=$config($ctx);$entryLimit($ctx,$c);$actor=Actors::of($ctx->pdo(),$ctx->user());$profileId=$ctx->input('profileId');
  // Only the own profiles' entries: never another person's entry through a tournament this member organizes (that is the organizer's command with its password check, §4.6).
  if(!is_string($profileId)||!in_array($profileId,array_column($actor['athletes'],'id'),true))throw new AppError('Zawodnik nie istnieje.',404);
  $run($ctx,$c,$actor,'entry.remove',['tournamentId'=>$ctx->input('tournamentId'),'id'=>$profileId]);
  return ['ok'=>true];
 }],
];
