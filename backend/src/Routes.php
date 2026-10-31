<?php
declare(strict_types=1);
namespace MatDraw;

/**
 * Route registry and dispatcher (plan §4.1). Every backend/routes/*.php file returns
 *   ['name'=>['method'=>'GET'|'POST','auth'=>'public'|'peek'|'session'|'upload'|'webhook',
 *             'user'=>'required'|'optional'|'admin'|'member'|'anon' (peek/session/upload; default required),
 *             'max'=>bytes, 'types'=>[content types] (upload), 'tag'=>'chat'|null,
 *             'reject'=>callable(int $status) (upload: throws the route's own 413/415 message),
 *             'handler'=>callable(RouteContext):mixed]]
 * Names are unique across files and never one of LEGACY (index.php serves those); a duplicate stops every request
 * with a RuntimeException. Modes:
 *   public  GET only, no session functions and no cookies read; Cache-Control: no-store unless the handler sets its own.
 *   peek    GET only, Auth::peek (read-only session, no file, no cookie); Cache-Control: private, no-store.
 *   session Auth::start; POST needs Origin/CSRF and a JSON body (application/json, max bytes, default 16 KB, depth 32).
 *   upload  Auth::start, Origin/CSRF, raw body with a Content-Type from types, max bytes (CONTENT_LENGTH and max+1 read).
 *   webhook no session, raw body up to max (default 1 MiB); the handler verifies the signature.
 * The user requirement is checked before the handler runs (an admin route answers 403 before reading any data).
 * The handler returns the JSON value (null → 204) or emits its own response and exits (images). Errors: AppError and
 * ApiError → {error, csrf (session/upload), ...data}; schema behind code (SQLSTATE 42S02/42S22) → 503; anything else
 * → 500, logged by logThrowable() without PDO messages.
 */
final class Routes {
 /** Oldest client contract (X-MatBravo-Client) the server accepts unless config min_client_api says otherwise (D19). */
 public const MIN_CLIENT_API=1;
 public const LEGACY=['session','bootstrap','login','logout','command','public','public-tournament'];
 private const MODES=['public','peek','session','upload','webhook'],USERS=['required','optional','admin','member','anon'];
 private static array $cache=[];
 /** Whether error responses carry the session's CSRF token (set once a session route started the session). */
 private static bool $csrf=false;
 public static function dir():string{return dirname(__DIR__).'/routes';}
 /** name => validated definition, from every *.php file in $dir (default backend/routes). */
 public static function all(?string $dir=null):array {
  $dir??=self::dir();if(isset(self::$cache[$dir]))return self::$cache[$dir];
  $out=[];$files=glob(rtrim($dir,'/').'/*.php')?:[];sort($files);
  foreach($files as $file){
   $defs=(static fn(string $f)=>require $f)($file);
   if(!is_array($defs))throw new \RuntimeException('Route file must return an array: '.basename($file));
   foreach($defs as $name=>$r){
    if(isset($out[$name])||in_array($name,self::LEGACY,true))throw new \RuntimeException("Duplicate route $name in ".basename($file));
    $out[$name]=self::check($name,$r);
   }
  }
  return self::$cache[$dir]=$out;
 }
 private static function check(mixed $name,mixed $r):array {
  $bad=fn()=>throw new \RuntimeException('Invalid route definition: '.(is_string($name)?$name:'?'));
  if(!is_string($name)||!preg_match('/^[a-z][a-z0-9-]{0,39}$/D',$name)||!is_array($r))$bad();
  $mode=$r['auth']??null;if(!in_array($mode,self::MODES,true)||!in_array($r['method']??null,['GET','POST'],true)||!is_callable($r['handler']??null))$bad();
  if(in_array($mode,['public','peek'],true)&&$r['method']!=='GET'||in_array($mode,['upload','webhook'],true)&&$r['method']!=='POST')$bad();
  if(in_array($mode,['public','webhook'],true)){if(isset($r['user']))$bad();$r['user']=null;}
  else{$r['user']??='required';if(!in_array($r['user'],self::USERS,true))$bad();}
  if(isset($r['max'])&&(!is_int($r['max'])||$r['max']<1))$bad();
  if($mode==='upload'&&(!is_array($r['types']??null)||!$r['types']))$bad();
  if(isset($r['tag'])&&$r['tag']!=='chat'||isset($r['reject'])&&!is_callable($r['reject']))$bad();
  return $r;
 }
 public static function has(string $name):bool{return isset(self::all()[$name]);}
 /**
  * Checks that run for every request before any database or session work (§4.1): the maintenance flag file
  * (503, Retry-After 120) and the client contract header (409 client_outdated). A missing or non-numeric header is allowed.
  */
 public static function guard(array $c):void {
  if(is_file(Paths::shared($c).'/maintenance')){header('Retry-After: 120');self::respond(['error'=>'Trwa przerwa techniczna. Spróbuj ponownie za kilka minut.'],503);}
  $v=$_SERVER['HTTP_X_MATBRAVO_CLIENT']??null;
  if(is_string($v)&&preg_match('/^\d{1,9}$/D',trim($v))&&(int)trim($v)<(int)$c['min_client_api'])self::respond(['error'=>'Dostępna jest nowa wersja MatBravo. Odśwież stronę.','code'=>'client_outdated'],409);
 }
 /** Emergency switch for chat routes: config chat_force_off or the file <shared>/chat-off (§5.10). */
 public static function chatOff(array $c):bool{return !empty($c['chat_force_off'])||is_file(Paths::shared($c).'/chat-off');}
 public static function dispatch(string $name,array $c):never {
  $r=self::all()[$name]??null;
  try{
   if(!$r)throw new AppError('Nie ma takiej operacji.',404);
   if(($_SERVER['REQUEST_METHOD']??'GET')!==$r['method']){header('Allow: '.$r['method']);throw new AppError('Niedozwolona metoda.',405);}
   if(($r['tag']??null)==='chat'&&self::chatOff($c)){header('Retry-After: 300');throw new ApiError('Czat jest chwilowo wyłączony. Spróbuj później.',503,['code'=>'chat_off']);}
   $mode=$r['auth'];
   if($mode==='public')header('Cache-Control: no-store');elseif($mode==='peek')header('Cache-Control: private, no-store');
   $body=[];$raw=null;
   if($mode==='session'||$mode==='upload'){Auth::start($c);self::$csrf=true;}
   if($r['method']==='POST'){
    if($mode!=='webhook')Auth::requireCsrf($c);
    if($mode==='session')$body=self::json((int)($r['max']??16384));else $raw=self::raw($r);
   }
   $ctx=new RouteContext($name,$r,$c,$body,$raw);
   self::requireUser($ctx,$r['user']);
   $out=($r['handler'])($ctx);
  }catch(\Throwable $e){self::fail($e);}
  if($out===null){http_response_code(204);header_remove('Content-Type');exit;}
  self::respond($out);
 }
 /** Marks a legacy route that started a session, so its errors carry the CSRF token as before. */
 public static function withCsrf():void{self::$csrf=true;}
 private static function requireUser(RouteContext $ctx,?string $need):void {
  if($need===null||$need==='optional')return;
  $u=$ctx->user();
  if($need==='anon'){if($u)throw new AppError('Brak uprawnień.',403);return;}
  if(!$u)throw new AppError('Zaloguj się ponownie.',401);
  if($need==='admin'&&$u['role']!=='admin'||$need==='member'&&$u['role']!=='member')throw new AppError('Brak uprawnień.',403);
 }
 /** JSON object or list from a session POST (415, 413, 400 as the legacy routes). */
 public static function json(int $max):array {
  if(!str_starts_with(strtolower((string)($_SERVER['CONTENT_TYPE']??'')),'application/json'))throw new AppError('Wymagany format JSON.',415);
  if((int)($_SERVER['CONTENT_LENGTH']??0)>$max)throw new AppError('Żądanie jest zbyt duże.',413);
  $raw=(string)file_get_contents('php://input',false,null,0,$max+1);if(strlen($raw)>$max)throw new AppError('Żądanie jest zbyt duże.',413);
  try{$p=json_decode($raw,true,32,JSON_THROW_ON_ERROR);}catch(\JsonException){throw new AppError('Niepoprawny JSON.',400);}
  if(!is_array($p))throw new AppError('Niepoprawny formularz.',400);
  return $p;
 }
 private static function raw(array $r):string {
  $max=(int)($r['max']??($r['auth']==='webhook'?1048576:524288));
  if($r['auth']==='upload'){$type=strtolower(trim(explode(';',(string)($_SERVER['CONTENT_TYPE']??''))[0]));if(!in_array($type,$r['types'],true))self::reject($r,415);}
  if((int)($_SERVER['CONTENT_LENGTH']??0)>$max)self::reject($r,413);
  $raw=(string)file_get_contents('php://input',false,null,0,$max+1);if(strlen($raw)>$max)self::reject($r,413);
  return $raw;
 }
 private static function reject(array $r,int $status):never {
  if(isset($r['reject']))($r['reject'])($status);
  if($status===413)throw new AppError('Żądanie jest zbyt duże.',413);
  throw new AppError('Nieobsługiwany format danych.',415);
 }
 /** Sets Retry-After and returns the seconds (≥ 1), for {retry} in the error data. */
 public static function retryAfter(int $seconds):int{$s=max(1,$seconds);header('Retry-After: '.$s);return $s;}
 public static function respond(mixed $value,int $status=200):never{http_response_code($status);echo json_encode($value,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);exit;}
 /** The one error answer of the API (registry and legacy routes). */
 public static function fail(\Throwable $e):never {
  header('Content-Type: application/json; charset=utf-8');header('Cache-Control: no-store');
  $extra=self::$csrf?['csrf'=>$_SESSION['csrf']??null]:[];
  if($e instanceof AppError)self::respond(['error'=>$e->getMessage()]+$extra+($e instanceof ApiError?$e->data:[]),$e->status);
  if($e instanceof \PDOException&&self::schemaBehind($e)){
   // Code newer than the database (deploy before migrate): a calm 503 instead of 500 (§4.1, D18).
   self::logThrowable($e,'MatDraw: schema behind code');header('Retry-After: 120');
   self::respond(['error'=>'Trwa przerwa techniczna. Spróbuj ponownie za kilka minut.']+$extra,503);
  }
  self::logThrowable($e);self::respond(['error'=>'Błąd serwera. Skontaktuj się z Administratorem.']+$extra,500);
 }
 /** Missing table (42S02) or column (42S22). */
 public static function schemaBehind(\PDOException $e):bool{return in_array((string)($e->errorInfo[0]??$e->getCode()),['42S02','42S22'],true);}
 /**
  * One log line without personal data: class, file:line and, for PDOException, only SQLSTATE and driver code (MySQL
  * puts duplicate values such as e-mails into the message); for StripeError only its status, type and code (Stripe's
  * text may quote request values such as the customer's e-mail); other messages are cut to 200 characters.
  */
 public static function logThrowable(\Throwable $e,string $prefix='MatDraw'):void{error_log($prefix.': '.self::describe($e));}
 public static function describe(\Throwable $e):string {
  $where=get_class($e).' '.basename($e->getFile()).':'.$e->getLine();
  if($e instanceof \PDOException)return $where.' SQLSTATE '.($e->errorInfo[0]??$e->getCode()).' code '.($e->errorInfo[1]??'-');
  // instanceof never autoloads: without the billing slice no StripeError can exist here.
  if($e instanceof StripeError)return $where.' '.$e->code();
  return $where.' '.mb_substr((string)preg_replace('/\s+/u',' ',$e->getMessage()),0,200);
 }
}
