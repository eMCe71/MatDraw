<?php
// Bridge for tests/core.test.mjs (plan §11): backend-api functions called with JSON on STDIN, no database.
// RateLimit and People run against an in-memory stand-in for PDO that understands exactly their statements.
declare(strict_types=1);
require dirname(__DIR__).'/backend/bootstrap.php';
use MatDraw\{Access,Accounts,Auth,ClientIp,Config,Domain,Jobs,Paths,People,RateLimit,RouteContext,Routes,Text};
date_default_timezone_set('Europe/Warsaw');

/** login_limits and users ⋈ user_profiles in memory; records every statement it is given. */
final class FakeStatement extends PDOStatement {
 private array $rows=[];private int $count=0;
 public function __construct(private FakeDb $db,public string $sql){}
 public function execute(?array $params=null):bool{[$this->rows,$this->count]=$this->db->run($this->sql,$params??[]);return true;}
 public function fetch(int $mode=PDO::FETCH_DEFAULT,int $orientation=PDO::FETCH_ORI_NEXT,int $offset=0):mixed{return array_shift($this->rows)??false;}
 public function fetchAll(int $mode=PDO::FETCH_DEFAULT,mixed ...$args):array{$r=$this->rows;$this->rows=[];return $r;}
 public function fetchColumn(int $column=0):mixed{$r=array_shift($this->rows);return $r?array_values($r)[$column]:false;}
 public function rowCount():int{return $this->count;}
 public function closeCursor():bool{$this->rows=[];return true;}
}
final class FakeDb extends PDO {
 public array $limits=[],$users=[],$log=[];
 public function __construct(){}
 public function prepare(string $query,array $options=[]):PDOStatement|false{return new FakeStatement($this,$query);}
 public function run(string $sql,array $p):array {
  $this->log[]=['sql'=>$sql,'params'=>$p];
  if(str_starts_with($sql,'INSERT INTO login_limits')){
   [$bucket,$now,$cut]=$p;$r=$this->limits[$bucket]??null;
   $this->limits[$bucket]=$r===null?['attempts'=>1,'window_start'=>$now]:($r['window_start']<=$cut?['attempts'=>1,'window_start'=>$now]:['attempts'=>$r['attempts']+1,'window_start'=>$r['window_start']]);
   return [[],1];
  }
  if(str_starts_with($sql,'SELECT attempts,window_start FROM login_limits'))return [isset($this->limits[$p[0]])?[$this->limits[$p[0]]]:[],0];
  if(str_starts_with($sql,'DELETE FROM login_limits')){$n=0;foreach($this->limits as $b=>$r)if($r['window_start']<$p[0]){unset($this->limits[$b]);$n++;}return [[],$n];}
  if(str_contains($sql,'FROM users u JOIN user_profiles p'))return [array_values(array_filter($this->users,fn($u)=>in_array($u['id'],$p,true))),0];
  throw new RuntimeException('unexpected statement: '.$sql);
 }
}
function attempt(callable $fn):array{try{return ['ok'=>$fn()];}catch(Throwable $e){return ['error'=>get_class($e).': '.$e->getMessage()];}}

$in=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
$out=match($in['job']){
 'access'=>array_map(fn($c)=>Access::compute($c['row'],$c['user'],$c['cfg'],$c['now']),$in['cases']),
 'currency'=>array_map(fn($c)=>Access::currency($c['row'],$c['country'],$c['cfg']),$in['cases']),
 'clean'=>array_map(fn($c)=>Text::clean(isset($c['hex'])?hex2bin($c['hex']):$c['s'],['multiline'=>!empty($c['multiline'])]),$in['cases']),
 'complete'=>array_map(fn($p)=>Accounts::profileComplete($p),$in['cases']),
 'hash'=>['dummy'=>password_get_info(Accounts::dummyHash()),'domain'=>password_get_info(Domain::password('Probe-password-2026')),
  'verifies'=>password_verify('Probe-password-2026',Accounts::dummyHash())||password_verify('',Accounts::dummyHash()),'same'=>Accounts::dummyHash()===Accounts::dummyHash()],
 'public-ids'=>array_map(fn()=>Accounts::publicId(),range(1,$in['n'])),
 'config'=>array_map(fn($c)=>attempt(function()use($c){Config::validate(array_replace(Config::DEFAULTS,$c));return 'valid';}),$in['cases']),
 'config-load'=>(function()use($in){
  $file=tempnam(sys_get_temp_dir(),'mdcfg');file_put_contents($file,"<?php\nreturn ".var_export($in['config'],true).";\n");putenv('MATDRAW_CONFIG='.$file);
  try{return attempt(fn()=>array_intersect_key(matdraw_config(),array_flip($in['keys'])));}finally{unlink($file);}
 })(),
 'client-ip'=>array_map(function($c){$_SERVER=['REMOTE_ADDR'=>$c['remote']]+($c['server']??[]);$cfg=array_replace(Config::DEFAULTS,$c['cfg']??[]);return [ClientIp::get($cfg),ClientIp::bucket($cfg)];},$in['cases']),
 'buckets'=>array_map([ClientIp::class,'bucketOf'],$in['ips']),
 'rate-limit'=>(function()use($in){
  $db=new FakeDb();$out=[];
  foreach($in['hits'] as $h)$out[]=RateLimit::hit($db,'k'.str_repeat('0',63),$h['scope'],$h['key'],$h['limit'],$h['window'],$h['now']);
  $stored=array_keys($db->limits);
  return ['results'=>$out,'buckets'=>$stored,'plain'=>array_values(array_filter($stored,fn($b)=>!preg_match('/^[0-9a-f]{64}$/D',$b))),
   'expected'=>array_map(fn($h)=>hash_hmac('sha256',$h['scope'].'|'.$h['key'],'k'.str_repeat('0',63)),$in['hits'])];
 })(),
 'people'=>(function()use($in){$db=new FakeDb();$db->users=$in['rows'];$out=People::project($db,$in['ids']);return ['out'=>$out,'queries'=>count($db->log),'params'=>$db->log[0]['params']??null];})(),
 'names'=>array_map(fn($c)=>People::name($c[0],$c[1],$c[2]),$in['cases']),
 'paths'=>(function()use($in){
  $_SERVER['DOCUMENT_ROOT']=$in['docroot'];$cfg=fn($dir)=>array_replace(Config::DEFAULTS,['uploads_dir'=>$dir]);
  return ['uploads'=>array_map(fn($d)=>attempt(fn()=>Paths::uploads($cfg($d))),$in['uploads']),'resolve'=>array_map([Paths::class,'resolve'],$in['resolve']),'savePath'=>array_map([Paths::class,'savePath'],$in['savePath'])];
 })(),
 'routes'=>(function()use($in){
  if(isset($in['dir']))return attempt(fn()=>array_map(fn($r)=>[$r['method'],$r['auth'],$r['user']],Routes::all($in['dir'])));
  return array_map(fn($r)=>[$r['method'],$r['auth'],$r['user'],$r['tag']??null],Routes::all());
 })(),
 'jobs'=>(function()use($in){
  if(isset($in['dir']))return attempt(fn()=>array_map(fn($j)=>[$j['every'],$j['needsFlush']],Jobs::all($in['dir'])));
  return array_map(fn($j)=>[$j['every'],$j['needsFlush']],Jobs::all());
 })(),
 'describe'=>(function()use($in){
  $pdo=new PDOException('SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry \''.$in['email'].'\' for key \'user_email\'');$pdo->errorInfo=['23000',1062,'Duplicate entry \''.$in['email'].'\''];
  $behind=new PDOException('SQLSTATE[42S02]: Base table or view not found');$behind->errorInfo=['42S02',1146,'Table x doesn\'t exist'];
  return ['pdo'=>Routes::describe($pdo),'other'=>Routes::describe(new RuntimeException(str_repeat('x',300))),'behind'=>Routes::schemaBehind($behind),'notBehind'=>Routes::schemaBehind($pdo)];
 })(),
 'api-base'=>array_map(fn($c)=>Config::apiBaseAllowed($c[0],$c[1]),$in['cases']),
 // RouteContext::user() of peek and session routes with a database that cannot be opened: guests (no cookie, a malformed
 // cookie, an unknown session id, an anonymous session) never touch it; a live session does (PDOException).
 'lazy-db'=>(function()use($in){
  putenv('MATDRAW_CONFIG='.$in['dir'].'/config.php');$now=time();
  $cfg=array_replace(Config::DEFAULTS,['app_url'=>'http://127.0.0.1','db'=>['dsn'=>'nodriver:matdraw','user'=>'','password'=>''],'session_dir'=>$in['dir']]);
  file_put_contents($in['dir'].'/sess_'.$in['live'],'userId|s:1:"u";authVersion|i:1;created|i:'.$now.';last|i:'.$now.';csrf|s:1:"x";');
  file_put_contents($in['dir'].'/sess_'.$in['anon'],'csrf|s:1:"x";');
  $user=function(string $mode,?string $cookie)use($cfg){
   $_COOKIE=$cookie===null?[]:[Auth::COOKIE=>$cookie];$ctx=new RouteContext('x',['auth'=>$mode,'user'=>'optional'],$cfg);
   return attempt(function()use($ctx,$mode,$cfg){
    if($mode==='session'){ini_set('session.use_cookies','0');ini_set('session.cache_limiter','');session_save_path($cfg['session_dir']);session_id($_COOKIE[Auth::COOKIE]??'');session_start(['read_and_close'=>true]);}
    return $ctx->user();
   });
  };
  return ['peek'=>array_map(fn($c)=>$user('peek',$c),$in['cookies']),'session'=>array_map(fn($c)=>$user('session',$c),[$in['anon'],$in['live']])];
 })(),
 // Jobs::afterSent after Jobs::maybe skipped by sampling (fresh jobs-tick, nothing sent): with fastcgi_finish_request
 // (stand-in like PHP-FPM: true once, false afterwards) the work runs after the response was sent, with the session
 // released first; without it (CLI, php -S, mod_php) the work is skipped.
 'after-sent'=>(function()use($in){
  putenv('MATDRAW_CONFIG='.$in['dir'].'/config.php');$GLOBALS['log']=[];
  if($in['fpm']){function fastcgi_finish_request():bool{$GLOBALS['log'][]=session_status()===PHP_SESSION_ACTIVE?'sent, session open':'sent';return count(array_filter($GLOBALS['log'],fn($l)=>str_starts_with($l,'sent')))===1;}}
  ini_set('session.use_cookies','0');ini_set('session.cache_limiter','');session_save_path($in['dir']);session_start();$_SESSION['x']=1;
  Jobs::maybe(new FakeDb(),array_replace(Config::DEFAULTS,[]));$GLOBALS['log'][]='jobs';
  session_start();// a session opened again after the jobs (e.g. by a later shutdown function)
  $ran=Jobs::afterSent(function(){$GLOBALS['log'][]='sync';},'test');
  $again=Jobs::afterSent(function(){$GLOBALS['log'][]='again';throw new RuntimeException('logged, not thrown');},'test');
  return ['ran'=>$ran,'again'=>$again,'log'=>$GLOBALS['log'],'session'=>session_status()===PHP_SESSION_ACTIVE];
 })(),
 // Jobs::maybe releases an open session first, even when sampling then skips all work (fresh jobs-tick).
 'jobs-release'=>(function()use($in){
  putenv('MATDRAW_CONFIG='.$in['dir'].'/config.php');ini_set('session.use_cookies','0');ini_set('session.cache_limiter','');session_save_path($in['dir']);
  session_start();$_SESSION['x']=1;$before=session_status()===PHP_SESSION_ACTIVE;
  Jobs::maybe(new FakeDb(),array_replace(Config::DEFAULTS,[]));
  return ['before'=>$before,'after'=>session_status()===PHP_SESSION_ACTIVE,'written'=>is_file($in['dir'].'/sess_'.session_id())];
 })(),
};
echo json_encode($out,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);
