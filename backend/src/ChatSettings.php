<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Chat tuning and switch (plan §2.4, §5.6, §5.10): one versioned row chat_settings(id=1). data is JSON text; get() merges
 * it over DEFAULTS and replaces every invalid value with its default, so a hand-edited row can never break polling.
 * Only CLIENT fields (on, t, ms, idle, bg, boost, safety, notice) are sent to browsers (cfg); send limits, autoHide and
 * the retention periods stay on the server. Every save bumps version, so clients pick the change up on their next poll
 * (cv), without a deploy. The Admin panel changes the switch, the pace preset and the notice (a free text shown as text,
 * never translated); other values are changed in the database only.
 * Hosting health (§5.10): clients report 429/503/508 answers and non-JSON/network failures (status 0) with the next
 * successful poll (parameter e); report() adds them to chat_health(hour, status) with one upsert, health() estimates the
 * last 60 minutes for the panel and diagnostics. No address and no account is ever stored there.
 */
final class ChatSettings {
 public const DEFAULTS=['on'=>true,'t'=>'poll','ms'=>[2500,5000,10000,30000,60000],'idle'=>[60,180,600,1800],'bg'=>30000,'boost'=>300,'safety'=>60000,'notice'=>null,
  'send'=>['gap'=>2,'perMin'=>20,'perDay'=>300],'autoHide'=>3,'retentionDays'=>365,'modKeepDays'=>30,'graceDays'=>1];
 /** Fields sent to the browser (cfg). */
 public const CLIENT=['on','t','ms','idle','bg','boost','safety','notice'];
 /** Pace presets of the Admin panel (§5.6): normal 2.5 s, saver, emergency. */
 public const PRESETS=['normal'=>[2500,5000,10000,30000,60000],'saver'=>[5000,10000,30000,60000,120000],'emergency'=>[15000,30000,60000,120000,300000]];
 public const HEALTH_STATUSES=[429,503,508,0];
 public const HEALTH_CAP=1000000,NOTICE_MAX=300;
 /** {version, data (normalized), updatedAt, updatedBy}; version 0 and the defaults when the row is missing. */
 public static function get(PDO $pdo):array {
  $r=$pdo->query('SELECT version,data,updated_at,updated_by FROM chat_settings WHERE id=1')->fetch(PDO::FETCH_ASSOC);
  if(!$r)return ['version'=>0,'data'=>self::DEFAULTS,'updatedAt'=>null,'updatedBy'=>null];
  return ['version'=>(int)$r['version'],'data'=>self::normalize(json_decode((string)$r['data'],true)),'updatedAt'=>(int)$r['updated_at'],'updatedBy'=>$r['updated_by']];
 }
 /** Stored data merged over DEFAULTS, each field checked; an invalid value falls back to its default. */
 public static function normalize(mixed $d):array {
  $d=is_array($d)?$d:[];$o=self::DEFAULTS;
  $int=fn($v,int $min,int $max)=>is_int($v)&&$v>=$min&&$v<=$max;
  $steps=fn($v,int $n,int $min,int $max)=>is_array($v)&&array_is_list($v)&&count($v)===$n&&count(array_filter($v,fn($x)=>$int($x,$min,$max)))===$n&&$v===self::sorted($v);
  if(is_bool($d['on']??null))$o['on']=$d['on'];
  if(in_array($d['t']??null,['poll','beacon','push'],true))$o['t']=$d['t'];
  if($steps($d['ms']??null,5,1000,600000))$o['ms']=$d['ms'];
  if($steps($d['idle']??null,4,1,86400))$o['idle']=$d['idle'];
  foreach(['bg'=>[1000,600000],'safety'=>[1000,600000],'boost'=>[0,86400],'autoHide'=>[1,100],'retentionDays'=>[1,3650],'modKeepDays'=>[1,3650],'graceDays'=>[0,30]] as $k=>[$min,$max])if($int($d[$k]??null,$min,$max))$o[$k]=$d[$k];
  if(is_string($d['notice']??null)){$n=Text::clean($d['notice']);$o['notice']=$n!==null&&$n!==''?mb_substr($n,0,self::NOTICE_MAX):null;}
  $send=is_array($d['send']??null)?$d['send']:[];
  foreach(['gap'=>[0,3600],'perMin'=>[1,1000],'perDay'=>[1,100000]] as $k=>[$min,$max])if($int($send[$k]??null,$min,$max))$o['send'][$k]=$send[$k];
  return $o;
 }
 private static function sorted(array $v):array{sort($v);return $v;}
 /** The cfg object for browsers. */
 public static function client(array $data):array{return array_intersect_key($data,array_flip(self::CLIENT));}
 /** Name of the preset whose intervals are $ms, or 'custom'. */
 public static function preset(array $ms):string{$p=array_search($ms,self::PRESETS,true);return is_string($p)?$p:'custom';}
 /** What the Admin panel reads (admin-chat-settings). */
 public static function view(PDO $pdo,int $now):array {
  $s=self::get($pdo);$d=$s['data'];
  return ['version'=>$s['version'],'on'=>$d['on'],'preset'=>self::preset($d['ms']),'ms'=>$d['ms'],'notice'=>$d['notice'],'presets'=>self::PRESETS,
   'send'=>$d['send'],'autoHide'=>$d['autoHide'],'updatedAt'=>$s['updatedAt'],'health'=>self::health($pdo,$now)];
 }
 /**
  * admin-chat-settings-save {on?, preset?, notice?, version?}: changes only the given fields, bumps version, writes the
  * moderation log (action settings). A stale version (the panel of another Admin saved meanwhile) answers 409.
  */
 public static function save(PDO $pdo,array $in,string $by,int $now):array {
  if(array_key_exists('on',$in)&&!is_bool($in['on']))throw new AppError('Niepoprawny formularz.',400);
  if(array_key_exists('preset',$in)&&!(is_string($in['preset'])&&isset(self::PRESETS[$in['preset']])))throw new AppError('Nieznany tryb tempa czatu.',422);
  if(array_key_exists('version',$in)&&!is_int($in['version']))throw new AppError('Niepoprawny formularz.',400);
  $notice=false;
  if(array_key_exists('notice',$in)){
   if($in['notice']!==null&&!is_string($in['notice']))throw new AppError('Niepoprawny formularz.',400);
   $notice=$in['notice']===null?null:Text::clean($in['notice']);if($notice==='')$notice=null;
   if($notice!==null&&mb_strlen($notice)>self::NOTICE_MAX)throw new AppError('Komunikat może mieć najwyżej 300 znaków.',422);
  }
  $pdo->beginTransaction();
  try{
   $r=$pdo->query('SELECT version,data FROM chat_settings WHERE id=1 FOR UPDATE')->fetch(PDO::FETCH_ASSOC);
   $version=$r?(int)$r['version']:0;
   if(isset($in['version'])&&$in['version']!==$version)throw new AppError('Ustawienia czatu zmienił w międzyczasie ktoś inny. Odśwież stronę.',409);
   // The stored JSON keeps unknown keys of a later release; only the changed fields are replaced.
   $raw=$r?json_decode((string)$r['data'],true):[];$raw=is_array($raw)?$raw:[];$data=self::normalize($raw);
   if(isset($in['on']))$data['on']=$in['on'];
   if(isset($in['preset']))$data['ms']=self::PRESETS[$in['preset']];
   if($notice!==false)$data['notice']=$notice;
   $stored=json_encode(array_replace($raw,$data),JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);
   $pdo->prepare('INSERT INTO chat_settings (id,version,data,updated_at,updated_by) VALUES (1,?,?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),data=VALUES(data),updated_at=VALUES(updated_at),updated_by=VALUES(updated_by)')->execute([$version+1,$stored,$now,$by]);
   ChatModeration::log($pdo,$by,'settings',null,null,'on='.($data['on']?1:0).' preset='.self::preset($data['ms']).' notice='.($data['notice']===null?0:1),null,$now);
   $pdo->commit();
  }catch(\Throwable $e){if($pdo->inTransaction())$pdo->rollBack();throw $e;}
  return self::view($pdo,$now);
 }
 /** Adds $n reports of $status in the hour of $now (one upsert, capped). */
 public static function report(PDO $pdo,int $n,int $status,int $now):void {
  if($n<1||!in_array($status,self::HEALTH_STATUSES,true))return;
  $pdo->prepare('INSERT INTO chat_health (hour_at,status,n) VALUES (?,?,?) ON DUPLICATE KEY UPDATE n=LEAST(n+VALUES(n),'.self::HEALTH_CAP.')')->execute([intdiv($now,3600)*3600,$status,min($n,50)]);
 }
 /**
  * Reported answers of the last 60 minutes: {"429":n,"503":n,"508":n,"0":n} (what the panel shows as "the last hour"
  * and DEPLOY-PL.md compares with its threshold), from the two hour buckets that overlap them (window()).
  */
 public static function health(PDO $pdo,?int $now=null):array {
  $now??=time();$hour=intdiv($now,3600)*3600;
  $q=$pdo->prepare('SELECT hour_at,status,n FROM chat_health WHERE hour_at IN (?,?)');$q->execute([$hour-3600,$hour]);
  return self::window($q->fetchAll(PDO::FETCH_ASSOC),$now);
 }
 /**
  * Sliding-window estimate of the 60 minutes before $now from hour buckets {hour_at, status, n} (pure): the current
  * hour in full plus the previous one weighted by the part of it still inside the window (at 10:15 three quarters of
  * the 9:00 bucket), rounded. It neither drops to zero at the top of every hour nor covers up to two hours.
  */
 public static function window(array $rows,int $now):array {
  $hour=intdiv($now,3600)*3600;$w=($hour+3600-$now)/3600;$sum=array_fill_keys(self::HEALTH_STATUSES,0.0);
  foreach($rows as $r){$s=(int)$r['status'];$at=(int)$r['hour_at'];if(isset($sum[$s])&&($at===$hour||$at===$hour-3600))$sum[$s]+=(int)$r['n']*($at===$hour?1:$w);}
  return array_map(fn(float $v):int=>(int)round($v),$sum);
 }
}
