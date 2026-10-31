<?php
// Background jobs from cron (plan §3.7, §9.11 step 11). Optional: without cron the same jobs run after ordinary
// requests (MatDraw\Jobs::maybe). Runs every overdue job of backend/jobs/*.php once, under GET_LOCK per database.
//   /usr/local/php83/bin/php ~/domains/matbravo.com/backend/bin/cron.php                    every overdue job
//   /usr/local/php83/bin/php ~/domains/matbravo.com/backend/bin/cron.php --job=housekeeping one job, if overdue
// Exit codes: 0 done, nothing due or another run in progress; 1 error. Output: job names and their short results only.
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/bootstrap.php';
use MatDraw\{Jobs,Routes};
$opts=getopt('',['job:']);
try{
 $c=matdraw_config();$pdo=matdraw_database($c);$only=isset($opts['job'])?(string)$opts['job']:null;
 if($only!==null&&!isset(Jobs::all()[$only])){fwrite(STDERR,"Nieznane zadanie: $only\n");exit(1);}
 $lock="CONCAT('matdraw_cron:',LEFT(IFNULL(DATABASE(),''),48))";
 if((int)$pdo->query("SELECT GET_LOCK($lock,0)")->fetchColumn()!==1){fwrite(STDOUT,"Inne zadania są właśnie w toku.\n");exit(0);}
 try{$done=Jobs::runAll($pdo,$c,time(),$only);}finally{$pdo->query("SELECT RELEASE_LOCK($lock)")->fetchAll();}
 foreach($done as $name=>$result)fwrite(STDOUT,"$name: $result\n");
 if(!$done)fwrite(STDOUT,"Brak zaległych zadań.\n");
}catch(Throwable $e){Routes::logThrowable($e,'MatDraw cron');fwrite(STDERR,'Błąd zadań: '.Routes::describe($e)."\n");exit(1);}
