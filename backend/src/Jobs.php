<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Background work without cron (plan §3.7). Every backend/jobs/*.php file returns
 *   ['name'=>['every'=>seconds,'needsFlush'=>bool,'run'=>callable(PDO $pdo,array $config,int $now):string]]
 * (unique names). maybe() runs from a shutdown function of me (and chat-send), after the response:
 *   0. session_write_close() first: PHP keeps the session file locked until after shutdown functions, and
 *      fastcgi/litespeed_finish_request do not release it, so other requests of the same person would wait;
 *   1. sampling: when <shared>/jobs-tick changed less than 30 s ago nothing happens, else it is touched (one stat
 *      instead of a database write per request);
 *   2. the response is sent early when fastcgi_finish_request or litespeed_finish_request exists;
 *   3. one SELECT of job_runs, INSERT IGNORE only for missing names, then the single most overdue job is claimed with
 *      a conditional UPDATE (rowCount 1 = this request runs it, others skip);
 *   4. the job runs with set_time_limit(20) and should stop after about 2 s of work (batches); a job with needsFlush
 *      (Stripe) is skipped when the response could not be sent first.
 * bin/cron.php runs every overdue job the same way. A failing job is logged without personal data and retried after
 * its interval. job_test_sleep_ms (tests only) makes a job slower.
 */
final class Jobs {
 public const TICK_SECONDS=30,CLAIM_SECONDS=120;
 private static array $cache=[];
 public static function dir():string{return dirname(__DIR__).'/jobs';}
 /** name => definition from every *.php file in $dir (default backend/jobs). */
 public static function all(?string $dir=null):array {
  $dir??=self::dir();if(isset(self::$cache[$dir]))return self::$cache[$dir];
  $out=[];$files=glob(rtrim($dir,'/').'/*.php')?:[];sort($files);
  foreach($files as $file){
   $defs=(static fn(string $f)=>require $f)($file);
   if(!is_array($defs))throw new \RuntimeException('Job file must return an array: '.basename($file));
   foreach($defs as $name=>$j){
    if(isset($out[$name]))throw new \RuntimeException("Duplicate job $name in ".basename($file));
    if(!is_string($name)||!preg_match('/^[a-z][a-z0-9-]{0,39}$/D',$name)||!is_array($j)||!is_int($j['every']??null)||$j['every']<1||!is_callable($j['run']??null)||!is_bool($j['needsFlush']??false))throw new \RuntimeException('Invalid job definition: '.(is_string($name)?$name:'?'));
    $out[$name]=['every'=>$j['every'],'needsFlush'=>(bool)($j['needsFlush']??false),'run'=>$j['run']];
   }
  }
  return self::$cache[$dir]=$out;
 }
 /** After a response: at most one overdue job, never an error for the caller. */
 public static function maybe(PDO $pdo,array $c):void {
  try{
   if(session_status()===PHP_SESSION_ACTIVE)session_write_close();
   $tick=Paths::shared($c).'/jobs-tick';$now=time();clearstatcache(true,$tick);$m=@filemtime($tick);
   if($m!==false&&$now-$m<self::TICK_SECONDS&&$m<=$now)return;
   if(!@touch($tick))return;
   ignore_user_abort(true);$flushed=self::flush();
   self::run($pdo,$c,$now,$flushed,1);
  }catch(\Throwable $e){Routes::logThrowable($e,'MatDraw jobs');}
 }
 /** Sends the response now when the SAPI can; true when it did. */
 public static function flush():bool {
  if(function_exists('fastcgi_finish_request'))return fastcgi_finish_request();
  if(function_exists('litespeed_finish_request'))return (bool)litespeed_finish_request();
  return false;
 }
 /** Every overdue job (bin/cron.php; no response to send, so needsFlush jobs run too); $only limits it to one name. */
 public static function runAll(PDO $pdo,array $c,int $now,?string $only=null):array{return self::run($pdo,$c,$now,true,PHP_INT_MAX,$only);}
 /** Claims and runs up to $limit overdue jobs, most overdue first; returns name => result. */
 private static function run(PDO $pdo,array $c,int $now,bool $flushed,int $limit,?string $only=null):array {
  $jobs=self::all();if($only!==null)$jobs=array_intersect_key($jobs,[$only=>1]);if(!$jobs)return [];
  $rows=[];foreach($pdo->query('SELECT name,last_run_at,claimed_until FROM job_runs') as $r)$rows[$r['name']]=$r;
  foreach(array_diff_key($jobs,$rows) as $name=>$_){$pdo->prepare('INSERT IGNORE INTO job_runs (name) VALUES (?)')->execute([$name]);$rows[$name]=['last_run_at'=>0,'claimed_until'=>0];}
  $due=[];
  foreach($jobs as $name=>$j){$late=$now-(int)$rows[$name]['last_run_at']-$j['every'];if($late>=0&&(int)$rows[$name]['claimed_until']<$now&&($flushed||!$j['needsFlush']))$due[$name]=$late;}
  arsort($due);$done=[];
  foreach(array_keys($due) as $name){
   if(count($done)>=$limit)break;$j=$jobs[$name];
   $claim=$pdo->prepare('UPDATE job_runs SET claimed_until=?,last_run_at=? WHERE name=? AND last_run_at<=? AND claimed_until<?');
   $claim->execute([$now+self::CLAIM_SECONDS,$now,$name,$now-$j['every'],$now]);
   if($claim->rowCount()!==1)continue;
   @set_time_limit(20);
   try{if(($ms=(int)($c['job_test_sleep_ms']??0))>0)usleep($ms*1000);$result=(string)($j['run'])($pdo,$c,$now);}
   catch(\Throwable $e){Routes::logThrowable($e,'MatDraw job '.$name);$result='error '.get_class($e);}
   $result=mb_substr($result,0,200);
   $pdo->prepare('UPDATE job_runs SET claimed_until=0,last_result=? WHERE name=?')->execute([$result,$name]);
   $done[$name]=$result;
  }
  return $done;
 }
}
