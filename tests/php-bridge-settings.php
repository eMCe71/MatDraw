<?php
// Bridge for tests/settings.test.mjs (PLAN-REJESTRACJA-ROLE §3, §12): Settings and the overlay of Routes::dispatch without a
// MariaDB, JSON on STDIN, JSON on STDOUT. A stored row lives in an SQLite memory database (the read is one SELECT by key).
//  effective  {cases:[{config, row?: data object|string|null, table?: false, error?: SQLSTATE}]}: Settings::effective on a
//             connection (twice: idempotence) and on its own result, Settings::flags, the number of queries (cache per PDO).
//  normalize  {cases:[{data, config}]}: Settings::normalize.   defaults {cases:[config]}.   mode {cases:[data]}.
//  save       {now, cases:[input]}: Settings::save input checks; a valid input reaches the database ('db').
//  fingerprint {cases:[config]}: Settings::fingerprint.   rolesOpen {cases:[config]}: Settings::rolesOpen(Settings::effective).
//  signupOpen {cases:[{config, row?, invite}]}: Members::signupOpen on the effective configuration (with a stored row).
//  needs      {}: [auth, Routes::needsSettings without a cookie, with a session cookie, with a bad one, user] of every route.
//  dispatch   {name, route, cookie?}: Routes::dispatch of one test route (the registry is replaced) with a database that
//             cannot be opened ('nodriver:'), so any connection attempt answers 500. Prints the response and "STATUS <code>".
declare(strict_types=1);
require dirname(__DIR__).'/backend/bootstrap.php';
date_default_timezone_set('Europe/Warsaw');
use MatDraw\{AppError,ApiError,Config,Members,RouteContext,Routes,Settings};

/** SQLite with app_settings (or none), counting queries. */
final class CountingPdo extends PDO {
 public int $n=0;
 public function query(string $query,?int $fetchMode=null,mixed ...$args):PDOStatement|false{$this->n++;return parent::query($query);}
}
/** A connection whose every query fails with the given SQLSTATE (42S02: table missing) or, without one, a RuntimeException. */
final class FailingPdo extends PDO {
 public int $n=0;
 public function __construct(private ?string $state=null){}
 public function query(string $query,?int $fetchMode=null,mixed ...$args):PDOStatement|false{
  $this->n++;if($this->state===null)throw new RuntimeException('database touched');
  $e=new PDOException('SQLSTATE['.$this->state.']');$e->errorInfo=[$this->state,1146,'x'];throw $e;
 }
 public function prepare(string $query,array $options=[]):PDOStatement|false{return $this->query($query);}
 public function inTransaction():bool{return false;}
}
function settings_pdo(array $case):PDO {
 if(isset($case['error']))return new FailingPdo($case['error']);
 if(($case['table']??true)===false)return new FailingPdo('42S02');
 $pdo=new CountingPdo('sqlite::memory:',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
 $pdo->exec('CREATE TABLE app_settings (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NULL)');
 if(array_key_exists('row',$case)&&$case['row']!==null)$pdo->prepare('INSERT INTO app_settings VALUES (1,3,?,1,NULL)')->execute([is_string($case['row'])?$case['row']:json_encode($case['row'])]);
 $pdo->n=0;return $pdo;
}
$in=json_decode(stream_get_contents(STDIN),true,64,JSON_THROW_ON_ERROR);
if($in['job']==='dispatch'){
 $c=array_replace(Config::DEFAULTS,['app_url'=>'http://127.0.0.1','app_key'=>str_repeat('a',64),'db'=>['dsn'=>'nodriver:matdraw','user'=>'','password'=>''],'session_dir'=>sys_get_temp_dir()]);
 $route=$in['route']+['handler'=>fn(RouteContext $ctx):array=>['user'=>$ctx->user(),'same'=>$ctx->config===$ctx->file,'mode'=>$ctx->config['signup_mode']??null]];
 (new ReflectionProperty(Routes::class,'cache'))->setValue(null,[Routes::dir()=>[$in['name']=>$route+['user'=>in_array($route['auth'],['public','webhook'],true)?null:'optional']]]);
 $_SERVER['REQUEST_METHOD']='GET';$_COOKIE=isset($in['cookie'])?['matdraw_session'=>$in['cookie']]:[];
 ini_set('error_log','/dev/null');
 register_shutdown_function(function(){echo "\nSTATUS ".http_response_code();});
 Routes::dispatch($in['name'],$c);
}
$attempt=function(callable $fn):array{
 try{return ['status'=>200,'result'=>$fn()];}
 catch(AppError $e){return ['status'=>$e->status,'error'=>$e->getMessage()]+($e instanceof ApiError?['data'=>$e->data]:[]);}
 catch(PDOException $e){return ['status'=>'pdo','state'=>$e->errorInfo[0]??null];}
 catch(RuntimeException $e){return ['status'=>'db'];}
};
$out=match($in['job']){
 'effective'=>array_map(function($case)use($attempt){
  $pdo=settings_pdo($case);
  return $attempt(function()use($pdo,$case){
   $e=Settings::effective($pdo,$case['config']);$again=Settings::effective($pdo,$case['config']);$twice=Settings::effective($pdo,$e);
   return ['effective'=>$e,'again'=>$again===$e,'twice'=>$twice===$e,'flags'=>Settings::flags($e),'queries'=>$pdo->n];
  });
 },$in['cases']),
 'normalize'=>array_map(fn($c)=>Settings::normalize($c['data'],$c['config']),$in['cases']),
 'fingerprint'=>array_map(fn($c)=>Settings::fingerprint($c),$in['cases']),
 'rolesOpen'=>array_map(fn($c)=>Settings::rolesOpen(Settings::effective(null,$c)),$in['cases']),
 'signupOpen'=>array_map(fn($c)=>Members::signupOpen(Settings::effective(settings_pdo($c),$c['config']),$c['invite']??null),$in['cases']),
 'defaults'=>array_map(fn($c)=>Settings::defaults($c),$in['cases']),
 'mode'=>array_map(fn($d)=>Settings::mode($d),$in['cases']),
 'save'=>array_map(fn($b)=>$attempt(fn()=>Settings::save(new FailingPdo(),Config::DEFAULTS,['id'=>'admin'],$b,(int)$in['now'])),$in['cases']),
 'needs'=>(function(){
  $out=[];foreach(Routes::all() as $name=>$r)$out[$name]=[$r['auth'],Routes::needsSettings($name,$r,null),Routes::needsSettings($name,$r,str_repeat('a',26)),Routes::needsSettings($name,$r,'bad cookie'),$r['user']];
  return $out;
 })(),
};
echo json_encode($out,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);
