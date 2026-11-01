<?php
// Account routes (plan §4.2–4.3): sign-up, profile, usernames, own password/e-mail/deletion, profile photos, the Admin's
// member panel and diagnostics. Personal data never travels in a URL: searches and username checks are POST bodies.
// Limits (RateLimit buckets are HMACs): signup-begin 60/h per address; signup §3.6; username-check 30/10 min per
// session and 300/10 min per address; profile 30/h; member-password 10/h, member-email and account-delete 5/h, each
// plus the login limits on the own e-mail; avatar-upload 10/h (≤ 512 KB); avatar-delete 30/h; diagnostics?probe=stripe 6/h.
// Roles (PLAN-REJESTRACJA-ROLE §4.5, §4.6, §8.1): roles {organizer} switches the member's own organizer role (10/h, on: 3
// per day per network, 403 while the Administrator blocks it; off: 409 while tournaments have open or closed
// registration); organizer-unlock {password} opens the organizer tools again after 30 minutes without them or 12 hours
// after the password (the login limits on the own e-mail, new session id and CSRF token).
// Calls into slices of the same wave (class_exists): ChatSettings::health(PDO) and StripeClient::probe($config) for
// diagnostics; the others are listed in Members.
// diagnostics also reports settings {mode, degraded, version, source} (Settings::diagnostics: the effective sign-up mode and
// whether the row or config.php decides, PLAN-REJESTRACJA-ROLE §8.1) and, with ?probe=perf (6 per hour), the performance
// budget of §12 measured on this database: perf {loadMs (Repository::snapshot, the workspace of staff and of every
// command), organizerSnapshotMs (Repository::organizerSnapshot of the member with the most tournaments, null without one),
// unchangedMs (the query of bootstrap?t&rev by key), counts {profiles, tournaments, entries, members, staff}, budget};
// medians of 3 runs in milliseconds, counts and times only (no ids, names or e-mails).
declare(strict_types=1);
use MatDraw\{Accounts,AppError,Auth,Avatars,Capabilities,Chat,ChatSettings,Members,Migrator,Paths,Profiles,Repository,RouteContext,Routes,Settings,StripeClient};

/** Number of session files in the app's own directory (at most 100000 entries and about one second), or null. */
$sessionFiles=static function(array $c):?int{
 $dir=Paths::ownSessions($c);if($dir===null)return null;$n=0;$start=microtime(true);
 foreach(new DirectoryIterator($dir) as $f){if(str_starts_with($f->getFilename(),'sess_'))$n++;if($n>=100000||microtime(true)-$start>1)break;}
 return $n;
};
/** Hours since the newest file in ~/matdraw/backups, or null when the directory cannot be read or is empty. */
$backupAge=static function(array $c):?int{
 $dir=Paths::backups($c);if($dir===null||!is_dir($dir)||!is_readable($dir))return null;$newest=0;
 foreach(new DirectoryIterator($dir) as $f)if($f->isFile()&&!$f->isLink())$newest=max($newest,$f->getMTime());
 return $newest?intdiv(max(0,time()-$newest),3600):null;
};
/** The performance budget of PLAN-REJESTRACJA-ROLE §12 on this database (diagnostics?probe=perf): medians of 3 runs in ms, and counts. */
$perf=static function(PDO $pdo):array{
 $median=static function(callable $fn):float{$t=[];for($i=0;$i<3;$i++){$s=hrtime(true);$fn();$t[]=(hrtime(true)-$s)/1e6;}sort($t);return round($t[1],1);};
 $repo=new Repository($pdo);$count=static fn(string $sql):int=>(int)$pdo->query($sql)->fetchColumn();
 $organizer=$pdo->query("SELECT t.created_by FROM tournaments t JOIN users u ON u.id=t.created_by WHERE u.role='member' GROUP BY t.created_by ORDER BY COUNT(*) DESC,t.created_by LIMIT 1")->fetchColumn();
 $tournament=$pdo->query('SELECT id FROM tournaments ORDER BY id LIMIT 1')->fetchColumn();$today=date('Y-m-d');
 $byKey=$pdo->prepare('SELECT rev FROM tournaments WHERE id=?');
 return ['loadMs'=>$median(fn()=>$repo->snapshot()),'organizerSnapshotMs'=>is_string($organizer)?$median(fn()=>$repo->organizerSnapshot($organizer,$today)):null,
  'unchangedMs'=>is_string($tournament)?$median(function()use($byKey,$tournament){$byKey->execute([$tournament]);$byKey->fetchColumn();$byKey->closeCursor();}):null,
  'counts'=>['profiles'=>$count('SELECT COUNT(*) FROM profiles'),'tournaments'=>$count('SELECT COUNT(*) FROM tournaments'),'entries'=>$count('SELECT COUNT(*) FROM entries'),
   'members'=>$count("SELECT COUNT(*) FROM users WHERE role='member'"),'staff'=>$count("SELECT COUNT(*) FROM users WHERE role IN ('admin','editor','club')")],
  'budget'=>['loadMs'=>400,'organizerSnapshotMs'=>50,'unchangedMs'=>20]];
};
return [
 'signup-begin'=>['method'=>'POST','auth'=>'session','user'=>'anon','handler'=>fn(RouteContext $ctx):array=>Members::signupBegin($ctx->pdo(),$ctx->config,$ctx->body)],
 'signup'=>['method'=>'POST','auth'=>'session','user'=>'anon','handler'=>fn(RouteContext $ctx):array=>Members::signup($ctx->pdo(),$ctx->config,$ctx->body)],
 'username-check'=>['method'=>'POST','auth'=>'session','user'=>'optional','handler'=>fn(RouteContext $ctx):array=>Members::usernameCheck($ctx->pdo(),$ctx->config,$ctx->user(),$ctx->body)],
 'profile'=>['method'=>'POST','auth'=>'session','handler'=>function(RouteContext $ctx):array{
  $u=$ctx->user();$pdo=$ctx->pdo();Members::limit($pdo,$ctx->config,'profile',$u['id'],30,3600);
  return ['profile'=>Profiles::save($pdo,$u,$ctx->body)];
 }],
 'member-password'=>['method'=>'POST','auth'=>'session','user'=>'member','handler'=>fn(RouteContext $ctx):array=>Members::password($ctx->pdo(),$ctx->config,$ctx->user(),$ctx->body)],
 'member-email'=>['method'=>'POST','auth'=>'session','user'=>'member','handler'=>fn(RouteContext $ctx):array=>Members::changeEmail($ctx,$ctx->user(),$ctx->body)],
 'roles'=>['method'=>'POST','auth'=>'session','user'=>'member','max'=>1024,'handler'=>fn(RouteContext $ctx):array=>Members::roles($ctx->pdo(),$ctx->config,$ctx->user(),$ctx->body)],
 'organizer-unlock'=>['method'=>'POST','auth'=>'session','user'=>'member','max'=>1024,'handler'=>function(RouteContext $ctx):array{
  Auth::unlock($ctx->pdo(),$ctx->config,$ctx->user(),$ctx->input('password'));return ['ok'=>true,'csrf'=>$ctx->csrf()];
 }],
 'account-delete'=>['method'=>'POST','auth'=>'session','user'=>'member','handler'=>fn(RouteContext $ctx):array=>Members::deleteOwn($ctx,$ctx->user(),$ctx->body)],
 'avatar-upload'=>['method'=>'POST','auth'=>'upload','types'=>['image/webp','image/jpeg','image/png'],'max'=>Avatars::MAX_BYTES,
  'reject'=>static fn(int $status)=>Avatars::reject(matdraw_config(),$status),
  'handler'=>fn(RouteContext $ctx):array=>Avatars::upload($ctx->pdo(),$ctx->config,$ctx->user(),$ctx->raw())],
 'avatar-delete'=>['method'=>'POST','auth'=>'session','handler'=>fn(RouteContext $ctx):array=>Avatars::delete($ctx->pdo(),$ctx->config,$ctx->user())],
 // Guests get the same 404 as everyone without access (user optional, not 401), see Avatars::serve.
 'avatar'=>['method'=>'GET','auth'=>'peek','user'=>'optional','handler'=>fn(RouteContext $ctx)=>Avatars::serve($ctx)],
 'admin-members'=>['method'=>'POST','auth'=>'session','user'=>'admin','handler'=>fn(RouteContext $ctx):array=>Members::adminList($ctx->pdo(),$ctx->config,$ctx->body)],
 'admin-member'=>['method'=>'POST','auth'=>'session','user'=>'admin','handler'=>fn(RouteContext $ctx):array=>Members::adminAction($ctx,$ctx->user(),$ctx->body)],
 // Server state for the Admin (§4.3): no secrets, no personal data. server.afterResponse: whether this SAPI can send
 // the response early (fastcgi/litespeed_finish_request); without it the lazy payment sync and the background jobs that
 // need it (billing-due, billing-events) never run on web requests, so the stripe-sync.php cron becomes mandatory.
 'diagnostics'=>['method'=>'GET','auth'=>'peek','user'=>'admin','handler'=>function(RouteContext $ctx)use($sessionFiles,$backupAge,$perf):array{
  $c=$ctx->config;$pdo=$ctx->pdo();$probe=$ctx->query('probe');
  if($probe!==null&&$probe!=='stripe'&&$probe!=='perf')throw new AppError('Nieznana operacja.',400);
  $timing=null;if($probe==='perf'){Members::limit($pdo,$c,'diagnostics-perf','all',6,3600);$timing=$perf($pdo);}
  $writable=false;try{$dir=Paths::uploads($c);$writable=is_dir($dir)&&is_writable($dir);}catch(\RuntimeException){}
  $chatOn=!Routes::chatOff($c)&&class_exists(Chat::class);$health=null;
  if(class_exists(ChatSettings::class)&&method_exists(ChatSettings::class,'health'))try{$health=ChatSettings::health($pdo);}catch(\Throwable $e){Routes::logThrowable($e,'MatDraw diagnostics');}
  $stripe=null;
  if($probe==='stripe'){
   Members::limit($pdo,$c,'diagnostics-probe','all',6,3600);
   $missing='not-installed';$stripe=['reachable'=>null,'status'=>null,'ms'=>null,'tls'=>null,'error'=>$missing];
   if(class_exists(StripeClient::class)&&method_exists(StripeClient::class,'probe'))try{$stripe=StripeClient::probe($c);}catch(\Throwable $e){Routes::logThrowable($e,'MatDraw diagnostics');$stripe['error']='failed';}
  }
  $m=new Migrator($pdo,dirname(__DIR__).'/migrations');
  return ['php'=>PHP_VERSION,'gd'=>Capabilities::gd(),'exif'=>extension_loaded('exif'),'curl'=>extension_loaded('curl'),'openssl'=>extension_loaded('openssl'),'intl'=>extension_loaded('intl'),
   'server'=>['sapi'=>PHP_SAPI,'afterResponse'=>function_exists('fastcgi_finish_request')||function_exists('litespeed_finish_request')],
   'uploadsWritable'=>$writable,'avatarMode'=>Capabilities::avatarMode($c),'schema'=>['db'=>$m->current(),'code'=>Migrator::target(dirname(__DIR__).'/migrations')],
   'sessions'=>['handler'=>(string)ini_get('session.save_handler'),'ownDir'=>Paths::ownSessions($c)!==null,'files'=>$sessionFiles($c)],'backups'=>['newestAgeHours'=>$backupAge($c)],
   'billing'=>['enabled'=>!empty($c['billing_enabled']),'mode'=>$c['billing_mode']],'chat'=>['on'=>$chatOn,'health'=>$health],'stripe'=>$stripe,
   'settings'=>Settings::diagnostics($pdo,$ctx->file),'perf'=>$timing];
 }],
];
