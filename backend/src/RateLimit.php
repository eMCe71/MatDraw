<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Fixed-window rate limits in the login_limits table (plan §3.6). The bucket is hash_hmac('sha256',"$scope|$key",app_key),
 * so no IP address or e-mail is ever stored. One atomic upsert reserves the attempt (simultaneous requests are all
 * counted, as in the login limit); a window that has fully passed starts again at 1. Windows longer than one day are not
 * supported: rows older than two days are deleted (1 % of calls here, and by the housekeeping job).
 * The caller throws its own literal Polish message (the i18n test finds it there): when hit() returns $s>0, it calls
 * Routes::retryAfter($s) and throws an ApiError with status 429 and data ['retry'=>$s].
 */
final class RateLimit {
 public const KEEP_SECONDS=172800;
 /** Counts one attempt; returns 0 while at most $limit attempts fall in the current window, else seconds until it ends (≥ 1). */
 public static function hit(PDO $pdo,string $appKey,string $scope,string $key,int $limit,int $window,?int $now=null):int {
  $now??=time();$cut=$now-$window;$bucket=hash_hmac('sha256',$scope.'|'.$key,$appKey);
  $pdo->prepare('INSERT INTO login_limits (bucket,attempts,window_start) VALUES (?,1,?) ON DUPLICATE KEY UPDATE attempts=IF(window_start<=?,1,attempts+1),window_start=IF(window_start<=?,?,window_start)')->execute([$bucket,$now,$cut,$cut,$now]);
  $q=$pdo->prepare('SELECT attempts,window_start FROM login_limits WHERE bucket=?');$q->execute([$bucket]);$row=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();
  if(random_int(1,100)===1)$pdo->prepare('DELETE FROM login_limits WHERE window_start<?')->execute([$now-self::KEEP_SECONDS]);
  if(!$row||(int)$row['attempts']<=$limit)return 0;
  return max(1,(int)$row['window_start']+$window-$now);
 }
}
