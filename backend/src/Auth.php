<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

final class Auth {
 public static function start(array $c):void {
  ini_set('session.use_strict_mode','1');ini_set('session.use_only_cookies','1');ini_set('session.use_trans_sid','0');
  ini_set('session.gc_maxlifetime',(string)$c['session_max_seconds']);
  session_name('matdraw_session');
  session_set_cookie_params(['lifetime'=>0,'path'=>'/','secure'=>parse_url($c['app_url'],PHP_URL_SCHEME)==='https','httponly'=>true,'samesite'=>'Strict']);if(!session_start())throw new \RuntimeException('Cannot start PHP session.');
  $now=time();
  if(isset($_SESSION['userId'])&&($now-($_SESSION['last']??0)>$c['session_idle_seconds']||$now-($_SESSION['created']??0)>$c['session_max_seconds']))self::clear();
  $_SESSION['csrf']??=bin2hex(random_bytes(32));$_SESSION['last']=$now;
 }
 public static function clear():void{$_SESSION=[];session_regenerate_id(true);$_SESSION['csrf']=bin2hex(random_bytes(32));}
 public static function requireCsrf(array $c):void {
  $url=parse_url($c['app_url']);$origin=$url['scheme'].'://'.$url['host'].(isset($url['port'])?':'.$url['port']:'');
  if(isset($_SERVER['HTTP_ORIGIN'])&&$_SERVER['HTTP_ORIGIN']!==$origin)throw new AppError('Niedozwolone źródło żądania.',403);
  $token=$_SERVER['HTTP_X_CSRF_TOKEN']??'';if(!$token||!hash_equals($_SESSION['csrf'],$token))throw new AppError('Sesja formularza wygasła. Odśwież stronę.',403);
 }
 public static function current(array $db,bool $required=true):?array {
  foreach($db['users'] as $u)if($u['id']===($_SESSION['userId']??null)&&$u['active']&&$u['authVersion']===($_SESSION['authVersion']??null))return $u;
  if(isset($_SESSION['userId']))self::clear();if($required)throw new AppError('Zaloguj się ponownie.',401);return null;
 }
 public static function enter(array $u):void{session_regenerate_id(true);$_SESSION=['userId'=>$u['id'],'authVersion'=>$u['authVersion'],'created'=>time(),'last'=>time(),'csrf'=>bin2hex(random_bytes(32))];}
 public static function reserveLogin(PDO $pdo,array $c,string $email):void {
  $ip=$_SERVER['REMOTE_ADDR']??'unknown';$now=time();$cut=$now-900;
  // Atomic reservation counts simultaneous attempts and avoids IPs/emails in logs.
  foreach([[$ip,40],[$ip.'|'.$email,8]] as [$key,$limit]){
   $bucket=hash_hmac('sha256',$key,$c['app_key']);
   $pdo->prepare('INSERT INTO login_limits (bucket,attempts,window_start) VALUES (?,1,?) ON DUPLICATE KEY UPDATE attempts=IF(window_start<?,1,attempts+1),window_start=IF(window_start<?,?,window_start)')->execute([$bucket,$now,$cut,$cut,$now]);
   $q=$pdo->prepare('SELECT attempts FROM login_limits WHERE bucket=?');$q->execute([$bucket]);if((int)$q->fetchColumn()>$limit)throw new AppError('Zbyt wiele prób logowania. Spróbuj ponownie za 15 minut.',429);
  }
  $pdo->prepare('DELETE FROM login_limits WHERE window_start<?')->execute([$now-86400]);
 }
}
