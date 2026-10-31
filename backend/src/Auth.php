<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * PHP sessions (plan §3.5). Staff: 30 min idle, 12 h maximum, session cookie, as before. Members: 14 days idle, 30 days
 * maximum, a cookie that expires with the session. The limits are stored in the session at sign-in (idle, max).
 * With the files handler and an own directory (Paths::ownSessions, ~/matdraw/shared/sessions) PHP's probabilistic GC is
 * off: the housekeeping job deletes files by kind (jobs/core.php). peek() reads a session without writing it, creating a
 * file or sending a cookie, for GET routes that poll (PHP's files handler still waits for the file lock while it reads,
 * so a poll can wait behind a long request of the same session; it never holds the lock itself beyond the read).
 * Peek routes keep member sessions alive; a staff session only when the route passes $active (chat-feed with a=1 and a
 * chat on screen, sent by the client only after the person's own recent interaction; plan §3.5 step 6: a club
 * representative who only reads the chat is not signed out). Background polls (chat heads every 30 s, the moderation
 * badge) never pass it, so they cannot keep an unattended staff tab signed in until the 12 h maximum.
 */
final class Auth {
 public const COOKIE='matdraw_session';
 /** ini settings, save path and cookie parameters shared by start() and peek(); no session is opened. */
 private static function configure(array $c):void {
  ini_set('session.use_strict_mode','1');ini_set('session.use_only_cookies','1');ini_set('session.use_trans_sid','0');
  if(ini_get('session.save_handler')==='files'&&($dir=Paths::ownSessions($c))!==null){
   session_save_path($dir);ini_set('session.gc_probability','0');
   ini_set('session.gc_maxlifetime',(string)max((int)$c['session_max_seconds'],(int)$c['member_session_max_seconds']));
  }else ini_set('session.gc_maxlifetime',(string)$c['session_max_seconds']);
  session_name(self::COOKIE);
  session_set_cookie_params(['lifetime'=>0,'path'=>'/','secure'=>self::secure($c),'httponly'=>true,'samesite'=>'Strict']);
 }
 private static function secure(array $c):bool{return parse_url($c['app_url'],PHP_URL_SCHEME)==='https';}
 /** Idle and maximum age of a session: the values stored at sign-in, else the staff limits from config. */
 private static function limits(array $s,array $c):array{return [(int)($s['idle']??$c['session_idle_seconds']),(int)($s['max']??$c['session_max_seconds'])];}
 private static function expired(array $s,array $c,int $now):bool{[$idle,$max]=self::limits($s,$c);return $now-(int)($s['last']??0)>$idle||$now-(int)($s['created']??0)>$max;}
 public static function start(array $c):void {
  self::configure($c);if(!session_start())throw new \RuntimeException('Cannot start PHP session.');
  $now=time();
  if(isset($_SESSION['userId'])&&self::expired($_SESSION,$c,$now))self::clear();
  $_SESSION['csrf']??=bin2hex(random_bytes(32));$_SESSION['last']=$now;
 }
 /**
  * Read-only session for GET routes (plan §3.5, in this order): returns {userId, authVersion} or null. Never creates a
  * session file, never sends Set-Cookie or PHP's cache headers, never clears or regenerates a session. Activity of a
  * member session is refreshed at most once per idle/4 with one short locked write under the same id; a staff session
  * (admin, editor, club) only when $active says the person is reading (the route decides, see the class comment), so
  * otherwise its 30-minute idle limit (D16) counts from its last session request (bootstrap, command, any POST),
  * whatever the page keeps polling.
  */
 public static function peek(array $c,bool $active=false):?array {
  $id=$_COOKIE[self::COOKIE]??null;
  if(!is_string($id)||!preg_match('/^[A-Za-z0-9,-]{22,256}$/D',$id))return null;
  self::configure($c);
  // With use_strict_mode an unknown id would create a file and send a new cookie: answer null before session_start.
  if(ini_get('session.save_handler')==='files'&&!is_file(self::file($id)))return null;
  // The id whose file was checked is the one read, even if a session id was set earlier in this process.
  session_cache_limiter('');session_id($id);
  if(!session_start(['read_and_close'=>true])){header_remove('Set-Cookie');return null;}
  $s=$_SESSION;$_SESSION=[];header_remove('Set-Cookie');$now=time();
  if(!isset($s['userId'],$s['authVersion'])||self::expired($s,$c,$now))return null;
  [$idle]=self::limits($s,$c);
  if(($active||self::member($s,$c))&&$now-(int)($s['last']??0)>intdiv($idle,4)){
   session_id($id);
   if(session_start()){
    if(session_id()!==$id){$new=session_id();session_abort();if(ini_get('session.save_handler')==='files')@unlink(self::file($new));}
    else{if(($_SESSION['userId']??null)===$s['userId'])$_SESSION['last']=$now;session_write_close();}
   }
   $_SESSION=[];header_remove('Set-Cookie');
  }
  return ['userId'=>$s['userId'],'authVersion'=>$s['authVersion']];
 }
 /** A member session: the kind stored at sign-in, else (no kind stored) an idle limit above the staff one. */
 private static function member(array $s,array $c):bool{return isset($s['kind'])?$s['kind']==='member':(int)($s['idle']??0)>(int)$c['session_idle_seconds'];}
 /** Path of the session file of $id in the configured save path (files handler, with "N;" subdirectory levels). */
 private static function file(string $id):string {
  [$dir,$depth]=Paths::savePath((string)session_save_path());$sub='';
  for($i=0;$i<$depth&&$i<strlen($id);$i++)$sub.=$id[$i].'/';
  return rtrim($dir,'/').'/'.$sub.'sess_'.$id;
 }
 public static function clear():void{$_SESSION=[];session_regenerate_id(true);$_SESSION['csrf']=bin2hex(random_bytes(32));}
 public static function requireCsrf(array $c):void {
  $url=parse_url($c['app_url']);$origin=$url['scheme'].'://'.$url['host'].(isset($url['port'])?':'.$url['port']:'');
  if(isset($_SERVER['HTTP_ORIGIN'])&&$_SERVER['HTTP_ORIGIN']!==$origin)throw new AppError('Niedozwolone źródło żądania.',403);
  $token=$_SERVER['HTTP_X_CSRF_TOKEN']??'';if(!$token||!hash_equals($_SESSION['csrf'],$token))throw new AppError('Sesja formularza wygasła. Odśwież stronę.',403);
 }
 /** The signed-in account in a workspace snapshot (command and staff bootstrap); a stale session is cleared. */
 public static function current(array $db,bool $required=true):?array {
  foreach($db['users'] as $u)if($u['id']===($_SESSION['userId']??null)&&$u['active']&&$u['authVersion']===($_SESSION['authVersion']??null))return $u;
  if(isset($_SESSION['userId']))self::clear();if($required)throw new AppError('Zaloguj się ponownie.',401);return null;
 }
 /**
  * Signs $u in under a new session id with the limits of its role. A member's cookie expires with the session
  * (created + member_session_max_seconds); staff keep a browser-session cookie.
  */
 public static function enter(array $u,array $c):void {
  session_regenerate_id(true);$now=time();$member=($u['role']??'')==='member';
  $idle=(int)$c[$member?'member_session_idle_seconds':'session_idle_seconds'];$max=(int)$c[$member?'member_session_max_seconds':'session_max_seconds'];
  $_SESSION=['userId'=>$u['id'],'authVersion'=>$u['authVersion'],'created'=>$now,'last'=>$now,'csrf'=>bin2hex(random_bytes(32)),'idle'=>$idle,'max'=>$max,'kind'=>$member?'member':'staff'];
  if($member&&!headers_sent()){header_remove('Set-Cookie');setcookie(session_name(),session_id(),['expires'=>$now+$max,'path'=>'/','secure'=>self::secure($c),'httponly'=>true,'samesite'=>'Strict']);}
 }
 /** Login limits (plan §3.3): login_limit_ip per address bucket (IPv6 /64) and 8 per bucket and e-mail, 15 minutes each. */
 public static function reserveLogin(PDO $pdo,array $c,string $email):void {
  $ip=ClientIp::bucket($c);
  foreach([['login-ip',$ip,(int)$c['login_limit_ip']],['login-email',$ip.'|'.$email,8]] as [$scope,$key,$limit])
   if($s=RateLimit::hit($pdo,$c['app_key'],$scope,$key,$limit,900)){Routes::retryAfter($s);throw new ApiError('Zbyt wiele prób logowania. Spróbuj ponownie za 15 minut.',429,['retry'=>$s]);}
 }
}
