<?php
// Test-only fixture jobs of the backend-api slice (loaded by tests/helpers/fixture.php; CLI, test database only).
//   config-set {set:{key:value}}         rewrites MATDRAW_CONFIG atomically (allow-listed keys); returns the old values
//   session-read {sid}                   data of a session file (read only) or null; also its mtime
//   session-edit {sid,set:{k:v}}         changes keys of an existing session file
//   session-create {sid,data,mtime}      writes a session file with PHP's own encoder, then sets its mtime
//   jobs-reset {}                        every job overdue again (job_runs) and the jobs-tick sample file removed
//   job-runs {}                          the job_runs rows
//   table-hide {table} / table-restore   renames a table away and back (schema-behind-code scenario)
declare(strict_types=1);
use MatDraw\Paths;
const FIXTURE_CORE_CONFIG_KEYS=['job_test_sleep_ms','min_client_api'];
const FIXTURE_CORE_TABLES=['user_profiles','billing_accounts','job_runs'];
/** Opens the session $sid of the app's own session directory in this CLI process (no cookies, no strict mode). */
function fixture_core_session(array $c,string $sid,bool $readOnly):?array {
 if(!preg_match('/^[A-Za-z0-9,-]{22,256}$/D',$sid))throw new RuntimeException('session: invalid id');
 $dir=Paths::ownSessions($c);if($dir===null)throw new RuntimeException('session: no own session directory');
 if(!is_file("$dir/sess_$sid"))return null;
 ini_set('session.use_strict_mode','0');ini_set('session.use_cookies','0');ini_set('session.use_only_cookies','0');ini_set('session.cache_limiter','');
 session_save_path($dir);session_id($sid);session_start($readOnly?['read_and_close'=>true]:[]);return $_SESSION;
}
return [
 'config-set'=>function(PDO $pdo,array $p):array{
  $path=getenv('MATDRAW_CONFIG');if(!$path||!is_file($path))throw new RuntimeException('config-set: MATDRAW_CONFIG');
  $c=require $path;$old=[];
  foreach((array)($p['set']??[]) as $k=>$v){if(!in_array($k,FIXTURE_CORE_CONFIG_KEYS,true))throw new RuntimeException("config-set: key $k not allowed");$old[$k]=$c[$k]??null;if($v===null)unset($c[$k]);else $c[$k]=$v;}
  $tmp=$path.'.tmp.'.getmypid();file_put_contents($tmp,"<?php\nreturn ".var_export($c,true).";\n");chmod($tmp,0600);rename($tmp,$path);
  return $old;
 },
 'session-read'=>function(PDO $pdo,array $p,array $c):?array{
  $data=fixture_core_session($c,(string)($p['sid']??''),true);if($data===null)return null;
  clearstatcache();return ['data'=>$data,'mtime'=>filemtime(Paths::ownSessions($c).'/sess_'.$p['sid'])];
 },
 'session-edit'=>function(PDO $pdo,array $p,array $c):array{
  $data=fixture_core_session($c,(string)($p['sid']??''),false);if($data===null)throw new RuntimeException('session-edit: no such session');
  foreach((array)($p['set']??[]) as $k=>$v)$_SESSION[$k]=$v;$out=$_SESSION;session_write_close();return $out;
 },
 'session-create'=>function(PDO $pdo,array $p,array $c):string{
  $sid=(string)($p['sid']??'');$dir=Paths::ownSessions($c);if($dir===null||!preg_match('/^[A-Za-z0-9,-]{22,256}$/D',$sid))throw new RuntimeException('session-create');
  ini_set('session.use_strict_mode','0');ini_set('session.use_cookies','0');ini_set('session.use_only_cookies','0');ini_set('session.cache_limiter','');
  session_save_path($dir);session_id($sid);session_start();$_SESSION=(array)($p['data']??[]);session_write_close();
  if(isset($p['mtime']))touch("$dir/sess_$sid",(int)$p['mtime']);
  return "$dir/sess_$sid";
 },
 'jobs-reset'=>function(PDO $pdo,array $p,array $c):array{
  $pdo->exec('UPDATE job_runs SET last_run_at=0,claimed_until=0,last_result=NULL');@unlink(Paths::shared($c).'/jobs-tick');
  return $pdo->query('SELECT name,last_run_at FROM job_runs ORDER BY name')->fetchAll();
 },
 'job-runs'=>fn(PDO $pdo):array=>$pdo->query('SELECT name,last_run_at,claimed_until,last_result FROM job_runs ORDER BY name')->fetchAll(),
 'table-hide'=>function(PDO $pdo,array $p):bool{$t=(string)($p['table']??'');if(!in_array($t,FIXTURE_CORE_TABLES,true))throw new RuntimeException('table-hide');$pdo->exec("RENAME TABLE `$t` TO `{$t}__hidden`");return true;},
 'table-restore'=>function(PDO $pdo,array $p):bool{$t=(string)($p['table']??'');if(!in_array($t,FIXTURE_CORE_TABLES,true))throw new RuntimeException('table-restore');
  if($pdo->query("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='{$t}__hidden'")->fetchColumn())$pdo->exec("RENAME TABLE `{$t}__hidden` TO `$t`");return true;},
];
