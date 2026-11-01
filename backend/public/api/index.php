<?php
declare(strict_types=1);
use MatDraw\{Access,Accounts,Actors,ApiError,AppError,Auth,Domain,GuestView,MemberTx,Members,RateLimit,Repository,Routes,Settings};
ini_set('display_errors','0');ini_set('log_errors','1');
// In the release: public/api/index.php and backend/ are siblings of public/.
require dirname(__DIR__,2).'/backend/bootstrap.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, private');header('X-Content-Type-Options: nosniff');
// Public, unauthenticated, read-only GET routes for the login screen and the guest preview. They run before
// Auth::start(): no session, cookie or CSRF token. GuestView (backend/src/GuestView.php) defines every field sent.
// Which community tournaments count as trusted (the home list, the preview's badge) follows organizers.trustRequired of the
// effective configuration (PLAN-REJESTRACJA-ROLE §17, §3.2): one query by key on the connection these routes open anyway.
function respond_public(array $config,string $route):never{
 try{
  if(($_SERVER['REQUEST_METHOD']??'')!=='GET'){header('Allow: GET');throw new AppError('Niedozwolona metoda.',405);}
  $today=date('Y-m-d');// Europe/Warsaw, set by matdraw_config().
  $pdo=matdraw_database($config);$repo=new Repository($pdo);$flags=Settings::flags(Settings::effective($pdo,$config));
  if($route==='public')$out=GuestView::upcoming($repo->guestTournaments($today,null,$flags),$today);
  else{
   $id=$_GET['id']??null;if(!is_string($id)||!preg_match('/^[A-Za-z0-9_-]{1,40}$/D',$id))throw new AppError('Turniej nie jest dostępny.',404);
   $out=GuestView::tournament($repo->guestTournaments($today,$id,$flags),$id,$today);if(!$out)throw new AppError('Turniej nie jest dostępny.',404);
  }
 }catch(Throwable $e){Routes::fail($e);}
 header('Cache-Control: public, max-age=60');Routes::respond($out);
}
/**
 * bootstrap?t=<id>&rev=<n> (PLAN-REJESTRACJA-ROLE §8.1): true when tournament t still carries the revision stamp n, so the
 * #screen poll gets {unchanged:true} for one query by key instead of a workspace. Tournament ids are random (128 bits),
 * so the answer tells nothing about tournaments the caller does not already know.
 */
function bootstrap_unchanged(PDO $pdo):bool{
 $t=$_GET['t']??null;$rev=$_GET['rev']??null;
 if(!is_string($t)||!preg_match('/^[A-Za-z0-9_-]{1,40}$/D',$t)||!is_string($rev)||!preg_match('/^\d{1,18}$/D',$rev))return false;
 $q=$pdo->prepare('SELECT rev FROM tournaments WHERE id=?');$q->execute([$t]);$v=$q->fetchColumn();$q->closeCursor();
 return $v!==false&&(int)$v===(int)$rev;
}
/** Organizer limits of §3.7 (bootstrap per session, commands per account): 429 with Retry-After. */
function organizer_limit(PDO $pdo,array $c,string $scope,string $key,int $limit,int $window):void{
 if($s=RateLimit::hit($pdo,$c['app_key'],$scope,$key,$limit,$window)){Routes::retryAfter($s);throw new ApiError('Zbyt wiele operacji. Spróbuj ponownie za chwilę.',429,['retry'=>$s]);}
}
/**
 * account_audit of the Administrator's commands on community data (§3.5 point 6, §11): tournament.hide, club.*,
 * profile.forget. Written inside the command's transaction, so it exists exactly when the change does. The note names
 * tournaments and clubs, never a person (no athlete names, no e-mails); target_user_id is the member concerned (the
 * creator of the tournament, the owner or creator of the profile), so the member's history in the panel shows it.
 */
function admin_audit(PDO $pdo,array $before,array $db,string $admin,string $type,array $p,array $result):void{
 if(!in_array($type,['tournament.hide','profile.forget','club.save','club.merge','club.adopt'],true))return;
 $staff=Domain::staffIds($before);$member=fn($id)=>is_string($id)&&!isset($staff[$id])?$id:null;$find=fn(array $rows,$id)=>array_values(array_filter($rows,fn($x)=>$x['id']===$id))[0]??null;
 $target=null;
 if($type==='tournament.hide'){$t=$find($db['tournaments'],$p['tournamentId']??null);$target=$member($t['createdBy']??null);$note=(($t['hiddenBy']??null)!==null?'hidden ':'restored ').($t['id']??'').' · '.($t['name']??'');}
 elseif($type==='profile.forget'){$a=$find($before['profiles'],$result['id']??null);$target=$member($a['ownerId']??null)??$member($a['createdBy']??null);$note=($result['id']??'').' '.($result['state']??'');}
 else{$c=$find($db['clubs'],$result['id']??null);$note=($type==='club.merge'?($p['id']??'').' → ':'').($c['id']??'').' · '.($c['name']??'').($type==='club.adopt'?' · profiles='.count((array)($p['profileIds']??[])):'');}
 Members::audit($pdo,$admin,$type,$target,mb_substr($note,0,200));
}
// Order (plan §4.1): config, then before any session or database work the maintenance flag and the client contract,
// then the route registry (backend/routes/*.php), then the original routes below with unchanged contracts.
try {
 $config=matdraw_config();$route=$_GET['route']??'session';if(!is_string($route))$route='';
 Routes::guard($config);
 if(Routes::has($route))Routes::dispatch($route,$config);
 if($route==='public'||$route==='public-tournament')respond_public($config,$route);
 $method=$_SERVER['REQUEST_METHOD'];
 $methods=['session'=>'GET','bootstrap'=>'GET','login'=>'POST','logout'=>'POST','command'=>'POST'];
 if(!isset($methods[$route]))throw new AppError('Nie ma takiej operacji.',404);
 if($method!==$methods[$route]){header('Allow: '.$methods[$route]);throw new AppError('Niedozwolona metoda.',405);}
 // The effective configuration (database switches over config.php, PLAN-REJESTRACJA-ROLE §3.2) right after the connection opens.
 Auth::start($config);Routes::withCsrf();$pdo=matdraw_database($config);$config=Settings::effective($pdo,$config);$flags=Settings::flags($config);
 $p=$method==='POST'?(function()use($config){Auth::requireCsrf($config);return Routes::json(65536);})():[];
 if($route==='logout'){Auth::clear();Routes::respond(['csrf'=>$_SESSION['csrf'],'ok'=>true]);}
 if($route==='login'){
  // Lightweight (§3.3): one query by e-mail, no workspace lock; the password is always verified with a hash of the
  // same algorithm and cost, then one message for unknown, blocked and wrong (limits per IP bucket and IP+e-mail).
  $email=mb_strtolower(trim(is_string($p['email']??null)?$p['email']:''));$password=is_string($p['password']??null)?$p['password']:'';
  if(strlen($email)>254||strlen($password)>72)throw new AppError('Nieprawidłowy e-mail lub hasło.',401);
  Auth::reserveLogin($pdo,$config,$email);
  $u=Accounts::verifyLogin($pdo,$email,$password);if(!$u)throw new AppError('Nieprawidłowy e-mail lub hasło.',401);
  Accounts::ensureProfile($pdo,$u['id']);Accounts::touchLogin($pdo,$u['id']);
  Auth::enter($u,$config);Routes::respond(['user'=>Domain::safeUser($u),'csrf'=>$_SESSION['csrf']]);
 }
 if($route==='session'){$u=Accounts::current($pdo,false);Routes::respond(['user'=>$u?Domain::safeUser($u):null,'csrf'=>$_SESSION['csrf']]);}
 if($route==='bootstrap'){
  // A member without the organizer role gets an empty workspace (with caps when it has any); staff get the workspace as
  // before, also without full access (preview, §6.6). A member organizer (§4.3, §4.6, B2): the password step-up, then
  // only the snapshot he may see (Repository::organizerSnapshot), at most 1500 per hour and session. ?t&rev answers
  // {unchanged:true} for staff and organizers, never counted.
  $u=Accounts::current($pdo,true);
  if($u['role']==='member'){
   $actor=Actors::of($pdo,$u);if(!$actor['caps']['organizer'])Routes::respond(Accounts::memberWorkspace($u,$actor));
   Auth::stepUp($config);if(bootstrap_unchanged($pdo))Routes::respond(['unchanged'=>true]);
   organizer_limit($pdo,$config,'organizer-bootstrap',(string)session_id(),1500,3600);
   $db=(new Repository($pdo))->organizerSnapshot($u['id'],date('Y-m-d'));$db['flags']=$flags;
   Routes::respond(array_replace(Domain::publicData($db,$actor),['user'=>Accounts::withCaps($u,$actor)]));
  }
  if(bootstrap_unchanged($pdo))Routes::respond(['unchanged'=>true]);
  $db=(new Repository($pdo))->snapshot();$db['flags']=$flags;Routes::respond(Domain::publicData($db,Auth::current($db)));
 }
 if(!is_string($p['type']??null)||!is_array($p['payload']??null)||!is_int($p['expectedRevision']??null))throw new AppError('Niepoprawna operacja.',400);
 $u=Accounts::current($pdo,true);
 if($u['role']==='member'){
  // A member organizer (§4.4, §3.7, R12): only ORGANIZER_TYPES (never account.password: members have member-password),
  // the step-up, 60 per minute and 1200 per hour per account, full access except to remove data (entry.remove,
  // profile.forget), then the budget of member transactions (MemberTx, final review B2: the global bucket of committed
  // member writes, 120 per minute, checked before the lock and charged only after the command committed, and 30
  // transactions per minute per account; staff never count; removing data is never refused by it) and the transaction
  // with the actor and the flags of the effective configuration.
  $actor=Actors::of($pdo,$u);
  if(!$actor['caps']['organizer']||!in_array($p['type'],Domain::ORGANIZER_TYPES,true))throw new AppError('Brak uprawnień.',403);
  Auth::stepUp($config);
  organizer_limit($pdo,$config,'organizer-command-minute',$u['id'],60,60);organizer_limit($pdo,$config,'organizer-command-hour',$u['id'],1200,3600);
  if(!in_array($p['type'],['entry.remove','profile.forget'],true)&&!Access::of($pdo,$u,$config)['full'])throw new ApiError('Ta funkcja wymaga aktywnej subskrypcji.',402);
  $budget=!MemberTx::exempt($p['type']);if($budget)MemberTx::check($pdo,$config,$u['id']);
  $out=(new Repository($pdo))->transaction(function(array &$db)use($pdo,$p,$u){
   // The role again under the workspace lock: a block by the Administrator or the person's own switch-off committed since Actors::of above wins.
   $now=Actors::of($pdo,$u);if(!$now['caps']['organizer'])throw new AppError('Brak uprawnień.',403);
   $result=Domain::execute($db,$u['id'],$p['type'],$p['payload'],$p['expectedRevision']);
   return ['workspace'=>array_replace(Domain::publicData($db,$now),['user'=>Accounts::withCaps($u,$now)]),'result'=>$result];
  },$actor,$flags);
  if($budget)MemberTx::count($pdo,$config);
  Routes::respond($out);
 }
 // Staff without full access only change their own password (402 otherwise).
 if($p['type']!=='account.password'&&!Access::of($pdo,$u,$config)['full'])throw new ApiError('Ta funkcja wymaga aktywnej subskrypcji.',402);
 $out=(new Repository($pdo))->transaction(function(array &$db)use($p,$pdo){
  $u=Auth::current($db);$before=$db;$result=Domain::execute($db,$u['id'],$p['type'],$p['payload'],$p['expectedRevision']);
  if($u['role']==='admin')admin_audit($pdo,$before,$db,$u['id'],$p['type'],$p['payload'],$result);
  $after=Domain::entity($db['users'],$u['id'],'Konto');return ['workspace'=>$after['active']?Domain::publicData($db,$after):null,'result'=>$result,'authVersion'=>$after['authVersion']];
 },null,$flags);
 if(!$out['workspace']){Auth::clear();Routes::respond(['error'=>'Konto zostało zablokowane.','csrf'=>$_SESSION['csrf']],401);}
 $_SESSION['authVersion']=$out['authVersion'];unset($out['authVersion']);Routes::respond($out);
}catch(Throwable $e){Routes::fail($e);}
