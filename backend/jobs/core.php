<?php
// Core background jobs (plan §3.5, §3.7), run by MatDraw\Jobs after responses or by bin/cron.php.
// housekeeping (hourly): rate-limit rows older than two days, and session files by kind, only in the app's own session
// directory (Paths::ownSessions, ~/matdraw/shared/sessions; never PHP's shared default path):
//   - anonymous (no userId) older than anon_session_seconds (3 h),
//   - staff (stored max ≤ session_max_seconds, or no max) older than session_max_seconds (12 h),
//   - every file older than member_session_idle_seconds (14 days).
// Age is the file's mtime (PHP writes or touches it on every locked session start; peek refreshes it once per idle/4).
// At most 5000 directory entries or 2 seconds per run; the next run continues at the saved position (next=N).
// Only files named sess_<id> are considered; with a serialize handler other than php/php_serialize only the 14-day
// rule applies (the kind cannot be read safely).
declare(strict_types=1);
use MatDraw\{Paths,RateLimit};
return [
 'housekeeping'=>['every'=>3600,'needsFlush'=>false,'run'=>function(PDO $pdo,array $c,int $now):string{
  $q=$pdo->prepare('DELETE FROM login_limits WHERE window_start<?');$q->execute([$now-RateLimit::KEEP_SECONDS]);$limits=$q->rowCount();
  $dir=Paths::ownSessions($c);if($dir===null)return "login_limits=$limits sessions=default-path";
  $prev=$pdo->query("SELECT last_result FROM job_runs WHERE name='housekeeping'")->fetchColumn();
  $skip=is_string($prev)&&preg_match('/\bnext=(\d+)\b/',$prev,$m)?(int)$m[1]:0;
  $anon=(int)$c['anon_session_seconds'];$staff=(int)$c['session_max_seconds'];$all=(int)$c['member_session_idle_seconds'];
  $handler=ini_get('session.serialize_handler');$known=in_array($handler,['php','php_serialize'],true);
  [$userRe,$maxRe]=$handler==='php_serialize'?['/s:6:"userId";/','/s:3:"max";i:(\d+);/']:['/(?:^|[;}])userId\|/','/(?:^|[;}])max\|i:(\d+);/'];
  $start=microtime(true);$i=0;$scanned=0;$deleted=0;$complete=true;
  foreach(new DirectoryIterator($dir) as $f){
   if($f->isDot())continue;
   if($i++<$skip)continue;
   if($scanned>=5000||microtime(true)-$start>2){$complete=false;break;}
   $scanned++;
   if(!preg_match('/^sess_[A-Za-z0-9,-]{22,256}$/D',$f->getFilename())||$f->isLink()||!$f->isFile())continue;
   $age=$now-$f->getMTime();if($age<=min($anon,$staff,$all))continue;
   $delete=$age>$all;
   if(!$delete&&$known){
    $data=@file_get_contents($f->getPathname(),false,null,0,65536);if(!is_string($data))continue;
    if(!preg_match($userRe,$data))$delete=$age>$anon;
    else{$max=preg_match($maxRe,$data,$mm)?(int)$mm[1]:null;if($max===null||$max<=$staff)$delete=$age>$staff;}
   }
   if($delete&&@unlink($f->getPathname()))$deleted++;
  }
  $next=$complete?0:$skip+$scanned-$deleted;
  return "login_limits=$limits sessions scanned=$scanned deleted=$deleted next=$next";
 }],
];
