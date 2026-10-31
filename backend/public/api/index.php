<?php
declare(strict_types=1);
use MatDraw\{Access,Accounts,ApiError,AppError,Auth,Domain,GuestView,Repository,Routes};
ini_set('display_errors','0');ini_set('log_errors','1');
// In the release: public/api/index.php and backend/ are siblings of public/.
require dirname(__DIR__,2).'/backend/bootstrap.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, private');header('X-Content-Type-Options: nosniff');
// Public, unauthenticated, read-only GET routes for the login screen and the guest preview. They run before
// Auth::start(): no session, cookie or CSRF token. GuestView (backend/src/GuestView.php) defines every field sent.
function respond_public(array $config,string $route):never{
 try{
  if(($_SERVER['REQUEST_METHOD']??'')!=='GET'){header('Allow: GET');throw new AppError('Niedozwolona metoda.',405);}
  $today=date('Y-m-d');// Europe/Warsaw, set by matdraw_config().
  $repo=new Repository(matdraw_database($config));
  if($route==='public')$out=GuestView::upcoming($repo->guestTournaments($today),$today);
  else{
   $id=$_GET['id']??null;if(!is_string($id)||!preg_match('/^[A-Za-z0-9_-]{1,40}$/D',$id))throw new AppError('Turniej nie jest dostępny.',404);
   $out=GuestView::tournament($repo->guestTournaments($today,$id),$id,$today);if(!$out)throw new AppError('Turniej nie jest dostępny.',404);
  }
 }catch(Throwable $e){Routes::fail($e);}
 header('Cache-Control: public, max-age=60');Routes::respond($out);
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
 Auth::start($config);Routes::withCsrf();$pdo=matdraw_database($config);
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
  // A member gets an empty workspace; staff get the workspace as before, also without full access (preview, §6.6).
  $u=Accounts::current($pdo,true);if($u['role']==='member')Routes::respond(Accounts::memberWorkspace($u));
  $db=(new Repository($pdo))->snapshot();Routes::respond(Domain::publicData($db,Auth::current($db)));
 }
 // command: members never write the workspace; staff without full access only change their own password (402 otherwise).
 if(!is_string($p['type']??null)||!is_array($p['payload']??null)||!is_int($p['expectedRevision']??null))throw new AppError('Niepoprawna operacja.',400);
 $u=Accounts::current($pdo,true);
 if($u['role']==='member')throw new AppError('Brak uprawnień.',403);
 if($p['type']!=='account.password'&&!Access::of($pdo,$u,$config)['full'])throw new ApiError('Ta funkcja wymaga aktywnej subskrypcji.',402);
 $out=(new Repository($pdo))->transaction(function(array &$db)use($p){$u=Auth::current($db);$result=Domain::execute($db,$u['id'],$p['type'],$p['payload'],$p['expectedRevision']);$after=Domain::entity($db['users'],$u['id'],'Konto');return ['workspace'=>$after['active']?Domain::publicData($db,$after):null,'result'=>$result,'authVersion'=>$after['authVersion']];});
 if(!$out['workspace']){Auth::clear();Routes::respond(['error'=>'Konto zostało zablokowane.','csrf'=>$_SESSION['csrf']],401);}
 $_SESSION['authVersion']=$out['authVersion'];unset($out['authVersion']);Routes::respond($out);
}catch(Throwable $e){Routes::fail($e);}
