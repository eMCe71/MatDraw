<?php
declare(strict_types=1);
use MatDraw\{AppError,Auth,Domain,Repository};
ini_set('display_errors','0');ini_set('log_errors','1');
// In the release: public/api/index.php and backend/ are siblings of public/.
require dirname(__DIR__,2).'/backend/bootstrap.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, private');header('X-Content-Type-Options: nosniff');
function respond(mixed $value,int $status=200):never{http_response_code($status);echo json_encode($value,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);exit;}
try {
 $config=matdraw_config();Auth::start($config);$pdo=matdraw_database($config);$repo=new Repository($pdo);
 $route=$_GET['route']??'session';$method=$_SERVER['REQUEST_METHOD'];
 $methods=['session'=>'GET','bootstrap'=>'GET','login'=>'POST','logout'=>'POST','command'=>'POST'];
 if(!isset($methods[$route]))throw new AppError('Nie ma takiej operacji.',404);
 if($method!==$methods[$route]){header('Allow: '.$methods[$route]);throw new AppError('Niedozwolona metoda.',405);}
 $p=[];
 if($method==='POST'){
  Auth::requireCsrf($config);
  if(!str_starts_with($_SERVER['CONTENT_TYPE']??'','application/json'))throw new AppError('Wymagany format JSON.',415);
  if((int)($_SERVER['CONTENT_LENGTH']??0)>65536)throw new AppError('Żądanie jest zbyt duże.',413);
  $raw=file_get_contents('php://input',false,null,0,65537);if(strlen($raw)>65536)throw new AppError('Żądanie jest zbyt duże.',413);
  try{$p=json_decode($raw,true,32,JSON_THROW_ON_ERROR);}catch(JsonException){throw new AppError('Niepoprawny JSON.',400);}if(!is_array($p))throw new AppError('Niepoprawny formularz.',400);
 }
 if($route==='logout'){Auth::clear();respond(['csrf'=>$_SESSION['csrf'],'ok'=>true]);}
 if($route==='command'){
  if(!is_string($p['type']??null)||!is_array($p['payload']??null)||!is_int($p['expectedRevision']??null))throw new AppError('Niepoprawna operacja.',400);
  $out=$repo->transaction(function(array &$db)use($p){$u=Auth::current($db);$result=Domain::execute($db,$u['id'],$p['type'],$p['payload'],$p['expectedRevision']);$after=Domain::entity($db['users'],$u['id'],'Konto');return ['workspace'=>$after['active']?Domain::publicData($db,$after):null,'result'=>$result,'authVersion'=>$after['authVersion']];});
  if(!$out['workspace']){Auth::clear();respond(['error'=>'Konto zostało zablokowane.','csrf'=>$_SESSION['csrf']],401);}
  $_SESSION['authVersion']=$out['authVersion'];unset($out['authVersion']);respond($out);
 }
 if($route==='login'){
  $email=mb_strtolower(trim(is_string($p['email']??null)?$p['email']:''));$password=is_string($p['password']??null)?$p['password']:'';
  if(strlen($email)>254||strlen($password)>72)throw new AppError('Nieprawidłowy e-mail lub hasło.',401);
  Auth::reserveLogin($pdo,$config,$email);
  $u=$repo->transaction(function(array &$db)use($email,$password){$found=null;foreach($db['users'] as $u)if($u['email']===$email)$found=$u;
   // Fixed valid bcrypt hash provides a password check for unknown accounts too.
   $hash=$found['passwordHash']??'$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.';
   $valid=password_verify($password,$hash);if(!$found||!$found['active']||!$valid)throw new AppError('Nieprawidłowy e-mail lub hasło.',401);return $found;});
  Auth::enter($u);respond(['user'=>Domain::safeUser($u),'csrf'=>$_SESSION['csrf']]);
 }
 $db=$repo->snapshot();$u=Auth::current($db,$route!=='session');
 if($route==='session')respond(['user'=>$u?Domain::safeUser($u):null,'csrf'=>$_SESSION['csrf']]);
 respond(Domain::publicData($db,$u));
}catch(AppError $e){respond(['error'=>$e->getMessage(),'csrf'=>$_SESSION['csrf']??null],$e->status);}
catch(Throwable $e){error_log('MatDraw: '.get_class($e).' '.$e->getMessage());respond(['error'=>'Błąd serwera. Skontaktuj się z Administratorem.'],500);}
