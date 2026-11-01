<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Switches of the Administrator's panel "Ustawienia" (PLAN-REJESTRACJA-ROLE §3.1–§3.6, §17): one versioned row
 * app_settings(id=1) (migration 0008), data as JSON text, modelled on ChatSettings. config.php gives the starting values
 * until the Administrator saves (no row = config behaviour) and stays the emergency ceiling (signup_force_off, no Stripe).
 *  data       signup 'off'|'on' (config signup_enabled), payments 'free'|'paid' (config billing_enforce), organizers
 *             'on'|'paused' (config organizers, default 'on'), trustRequired bool (config organizers_trust_required,
 *             default false: full automation, §17), supportEmail (config support_email ?: hello@matbravo.com, D4),
 *             stripeCheck null|{at, ok, mode, prices:{pln,usd}, error: null|code} (codes only, never Stripe's text).
 *             normalize() replaces every invalid value by its default; unknown keys of a later release stay in the JSON.
 *  effective(PDO|null, config): the configuration every route reads (§3.2, computed in one place: Routes::dispatch for
 *             session, upload and peek-with-cookie routes and routes flagged 'settings'; index.php; the jobs). One query
 *             by primary key per connection (cached per PDO object, dropped after a write); a missing table (42S02) or no
 *             PDO gives the values derived from config alone. Idempotent: effective(p, effective(p, c)) == effective(p, c).
 *   signup_enabled    signup 'on' and no signup_force_off
 *   billing_enforce   payments 'paid'; without billing_enabled in config.php: false, sign-up closed and
 *                     settings_degraded 'billing-missing' (registration fails closed, access fails open, R2)
 *                     A stored Stripe check that failed or was made against another Stripe configuration (fingerprint():
 *                     billing_mode, the key's hash, price keys, advertised amounts) does the same with settings_degraded
 *                     'stripe-check' until a fresh check passes (final review B4); without any stored check the payments
 *                     switch works as before (config.php alone, the release a67ad42)
 *   settings_degraded 'billing-missing' | 'stripe-check' | 'force-off' (signup 'on', or an invite token for the paid test
 *                     window, under signup_force_off)
 *   signup_invite_token null under signup_force_off: the emergency ceiling closes the invite path too (B6)
 *   signup_free_beta = !billing_enforce;  support_email;  organizers;  organizers_trust_required
 *   signup_mode       'off' | 'free' | 'paid'
 *  rolesOpen(effective): members may gain roles (switch the organizer role on, create an athlete profile) only while
 *             sign-up is open (signup_mode not 'off', B10): after the deploy nothing changes until the Administrator opens it.
 *  flags(effective) gives Domain's read-only $db['flags'] {organizers, trustRequired}; the JS mirror reads db.flags the same way.
 *  save()     admin-settings-save (§3.4): version check (409 stale); starting payments (free → paid) or opening the paid
 *             sign-up (mode → 'paid') only with billing_enabled, a fresh Stripe check outside any transaction (resolvePrice
 *             of every currency, amounts compared with billing_amounts), in Stripe test mode the explicit confirmation
 *             (allowTestMode or confirmTestMode; 409 code test_mode, confirmTestMode:true, B5) and, while payments are not
 *             effectively enforced yet, the decision about accounts of the free period (Billing::freePeriodSet, groups A and
 *             B); then one transaction with the free-period action, the row (version+1) and account_audit (settings.save,
 *             settings.support old -> new).
 *  view()     admin-settings (§8.2), with stripeCheck {ok, stale, checkedAt, mode} of the last check (stale: the Stripe
 *             configuration of config.php changed since).
 */
final class Settings {
 public const SUPPORT_DEFAULT='hello@matbravo.com';
 public const SIGNUP=['off','on'],PAYMENTS=['free','paid'],ORGANIZERS=['on','paused'];
 /** Fields the panel changes (stripeCheck is written by the Stripe check only). */
 public const FIELDS=['signup','payments','organizers','trustRequired','supportEmail'];
 /** account_audit actions listed in "Historia zmian" (§3.5 point 6). */
 public const HISTORY_LIKE=['settings.%','organizer.%','club.%'],HISTORY_IN=['tournament.hide','profile.forget'];
 public const HISTORY_MAX=50,NOTE_VALUE=90;
 /** Labels of history actors without a display name (dictionary keys of the panel). */
 private const ROLE_LABEL=['admin'=>'Administrator','editor'=>'Edytor','club'=>'Reprezentant klubu','member'=>'Członek'],ACTOR_GONE='Konto usunięte';
 private const CODE='/^[a-z0-9_]{1,40}$/D';
 /** PDO => ['row'=>?array] for the request (WeakMap: a closed connection drops its entry). */
 private static ?\WeakMap $rows=null;

 /** Starting values from config.php (§3.1): what applies while the row or a field is missing. */
 public static function defaults(array $c):array {
  return ['signup'=>!empty($c['signup_enabled'])?'on':'off','payments'=>!empty($c['billing_enforce'])?'paid':'free','organizers'=>($c['organizers']??null)==='paused'?'paused':'on',
   'trustRequired'=>($c['organizers_trust_required']??false)===true,'supportEmail'=>self::email($c['support_email']??null)??self::SUPPORT_DEFAULT,'stripeCheck'=>null];
 }
 /** A lower-case e-mail of at most 254 characters, or null. */
 public static function email(mixed $v):?string{$e=is_string($v)?mb_strtolower(trim($v)):'';return $e!==''&&strlen($e)<=254&&filter_var($e,FILTER_VALIDATE_EMAIL)?$e:null;}
 /** Stored data merged over defaults($c), each field checked; an invalid value falls back to its default. */
 public static function normalize(mixed $d,array $c):array {
  $d=is_array($d)?$d:[];$o=self::defaults($c);
  foreach(['signup'=>self::SIGNUP,'payments'=>self::PAYMENTS,'organizers'=>self::ORGANIZERS] as $k=>$allowed)if(in_array($d[$k]??null,$allowed,true))$o[$k]=$d[$k];
  if(is_bool($d['trustRequired']??null))$o['trustRequired']=$d['trustRequired'];
  if(($e=self::email($d['supportEmail']??null))!==null)$o['supportEmail']=$e;
  $o['stripeCheck']=self::check($d['stripeCheck']??null);
  return $o;
 }
 /** A valid stripeCheck object or null; fp (the fingerprint() it was made against) is kept only in its exact shape. */
 private static function check(mixed $v):?array {
  if(!is_array($v)||!is_int($v['at']??null)||!is_bool($v['ok']??null)||!in_array($v['mode']??null,['test','live'],true)||!is_array($v['prices']??null))return null;
  $e=$v['error']??null;if($e!==null&&!(is_string($e)&&preg_match(self::CODE,$e)))return null;
  $fp=is_string($v['fp']??null)&&preg_match('/^[0-9a-f]{16}$/D',$v['fp'])?$v['fp']:null;
  return ['at'=>$v['at'],'ok'=>$v['ok'],'mode'=>$v['mode'],'prices'=>['pln'=>($v['prices']['pln']??false)===true,'usd'=>($v['prices']['usd']??false)===true],'error'=>$e,'fp'=>$fp];
 }
 /** 'off' | 'free' | 'paid' of normalized data (what the owner sees, §3.1). */
 public static function mode(array $s):string{return $s['signup']!=='on'?'off':($s['payments']==='paid'?'paid':'free');}
 /**
  * The Stripe configuration of config.php a check is made against (B4): billing_mode, the identity of the secret key (its
  * SHA-256, never the key), the price lookup keys and the amounts shown to guests, as an HMAC with app_key cut to 16 hex
  * characters (stored in data.stripeCheck.fp). Null without billing_enabled.
  */
 public static function fingerprint(array $c):?string {
  if(!Billing::enabled($c))return null;
  $sorted=static function(mixed $v){if(!is_array($v))return $v;ksort($v,SORT_STRING);return $v;};$key=$c['stripe_secret_key']??'';
  $s=json_encode([($c['billing_mode']??'test')==='live'?'live':'test',hash('sha256',is_string($key)?$key:''),$sorted($c['stripe_prices']??null),$sorted($c['billing_amounts']??null)],JSON_THROW_ON_ERROR|JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE);
  return substr(hash_hmac('sha256',$s,(string)($c['app_key']??'')),0,16);
 }
 /** Whether a stored check $k passed against the current Stripe configuration of $c (false without a check). */
 private static function verified(?array $k,array $c):bool{$fp=self::fingerprint($c);return $k!==null&&$k['ok']&&$fp!==null&&$k['fp']===$fp;}
 /** Members may gain roles (the organizer role switched on, a new athlete profile) only while sign-up is open (B10). */
 public static function rolesOpen(array $eff):bool{return in_array($eff['signup_mode']??null,['free','paid'],true);}

 /** The stored row {version, data, updated_at, updated_by} or null (none, or the table is missing: 42S02); cached per connection. */
 private static function row(PDO $pdo):?array {
  self::$rows??=new \WeakMap();
  if(isset(self::$rows[$pdo]))return self::$rows[$pdo]['row'];
  try{$q=$pdo->query('SELECT version,data,updated_at,updated_by FROM app_settings WHERE id=1');$r=$q->fetch(PDO::FETCH_ASSOC)?:null;$q->closeCursor();}
  catch(\PDOException $e){if((string)($e->errorInfo[0]??$e->getCode())!=='42S02')throw $e;$r=null;}
  self::$rows[$pdo]=['row'=>$r];
  return $r;
 }
 /** Drops the cached row of a connection (after a write). */
 public static function forget(PDO $pdo):void{if(self::$rows!==null)unset(self::$rows[$pdo]);}
 /** {version (0 without a row), data (normalized), stored (the raw JSON object), updatedAt, updatedBy}. */
 public static function get(PDO $pdo,array $c):array {
  $r=self::row($pdo);$raw=$r?json_decode((string)$r['data'],true):null;$raw=is_array($raw)?$raw:[];$v=$r?(int)$r['version']:0;
  return ['version'=>$v,'data'=>self::normalize($raw,$c),'stored'=>$raw,'updatedAt'=>$r&&$v>0?(int)$r['updated_at']:null,'updatedBy'=>$r&&$v>0?$r['updated_by']:null];
 }
 public static function effective(?PDO $pdo,array $c):array {
  $s=self::normalize($pdo?json_decode((string)(self::row($pdo)['data']??''),true):null,$c);$eff=$c;
  $eff['signup_enabled']=$s['signup']==='on'&&empty($c['signup_force_off']);
  $eff['billing_enforce']=$s['payments']==='paid';
  if($eff['billing_enforce']&&empty($c['billing_enabled'])){$eff['billing_enforce']=false;$eff['signup_enabled']=false;$eff['settings_degraded']='billing-missing';}
  // B4: payments run only against the Stripe configuration a check passed for; a failed check or a changed config.php
  // (test → live keys, prices, amounts) closes the sign-up and lifts enforcement (fail closed / fail open, as above).
  elseif($eff['billing_enforce']&&$s['stripeCheck']!==null&&!self::verified($s['stripeCheck'],$c)){$eff['billing_enforce']=false;$eff['signup_enabled']=false;$eff['settings_degraded']='stripe-check';}
  // B6: signup_force_off is the ceiling over every self sign-up path, the invite token of the paid test window included.
  $token=is_string($c['signup_invite_token']??null)&&$c['signup_invite_token']!=='';
  if(!empty($c['signup_force_off'])){if($s['signup']==='on'||$token&&$eff['billing_enforce'])$eff['settings_degraded']??='force-off';$eff['signup_invite_token']=null;}
  $eff['signup_free_beta']=!$eff['billing_enforce'];
  $eff['support_email']=$s['supportEmail'];
  $eff['organizers']=$s['organizers'];
  $eff['organizers_trust_required']=$s['trustRequired'];
  $eff['signup_mode']=!$eff['signup_enabled']?'off':($eff['billing_enforce']?'paid':'free');
  return $eff;
 }
 public static function flags(array $eff):array{return ['organizers'=>($eff['organizers']??'on')==='paused'?'paused':'on','trustRequired'=>($eff['organizers_trust_required']??false)===true];}
 /** For diagnostics (§8.1): {mode, degraded, version, source:'db'|'config'} of the raw config.php $file. */
 public static function diagnostics(PDO $pdo,array $file):array {
  $s=self::get($pdo,$file);$eff=self::effective($pdo,$file);
  return ['mode'=>$eff['signup_mode'],'degraded'=>$eff['settings_degraded']??null,'version'=>$s['version'],'source'=>$s['version']>0?'db':'config'];
 }

 // ---- Admin panel ---------------------------------------------------------------------------------------------------
 /** admin-settings (§8.2) for the raw config.php $file. */
 public static function view(PDO $pdo,array $file,int $now):array {
  $s=self::get($pdo,$file);$d=$s['data'];$k=$d['stripeCheck'];$eff=self::effective($pdo,$file);$set=Billing::freePeriodSet($pdo,$eff,$now);
  $pending=(int)$pdo->query("SELECT COUNT(*) FROM users u LEFT JOIN billing_accounts b ON b.user_id=u.id WHERE u.role='member' AND u.active=1 AND u.organizer=1 AND u.organizer_blocked_at IS NULL AND u.organizer_trusted_at IS NULL AND b.deleted_at IS NULL")->fetchColumn();
  $where=implode(' OR ',array_merge(array_fill(0,count(self::HISTORY_LIKE),'action LIKE ?'),['action IN ('.implode(',',array_fill(0,count(self::HISTORY_IN),'?')).')']));
  $q=$pdo->prepare("SELECT actor_id,action,note,created_at FROM account_audit WHERE $where ORDER BY created_at DESC,id DESC LIMIT ".self::HISTORY_MAX);$q->execute([...self::HISTORY_LIKE,...self::HISTORY_IN]);$rows=$q->fetchAll(PDO::FETCH_ASSOC);
  $names=self::names($pdo,[...array_column($rows,'actor_id'),$s['updatedBy']]);
  return ['version'=>$s['version'],'signup'=>$d['signup'],'payments'=>$d['payments'],'organizers'=>$d['organizers'],'trustRequired'=>$d['trustRequired'],'mode'=>self::mode($d),
   'effective'=>['mode'=>$eff['signup_mode'],'degraded'=>$eff['settings_degraded']??null],
   'support'=>['email'=>$d['supportEmail'],'source'=>self::email($s['stored']['supportEmail']??null)!==null?'db':(self::email($file['support_email']??null)!==null?'config':'default')],
   'stripe'=>['enabled'=>Billing::enabled($file),'mode'=>($file['billing_mode']??'test')==='live'?'live':'test','check'=>$k===null?null:array_diff_key($k,['fp'=>1])],
   'stripeCheck'=>['ok'=>$k!==null&&$k['ok'],'stale'=>$k!==null&&($fp=self::fingerprint($file))!==null&&$k['fp']!==$fp,'checkedAt'=>$k===null?null:gmdate('c',$k['at']),'mode'=>$k['mode']??null],
   'freeSignups'=>['a'=>count($set['a']),'b'=>count($set['b']),'scheduled'=>$set['scheduled']],
   'organizersPending'=>$pending,
   'limits'=>['organizerDay'=>Domain::ORGANIZER_DAY,'organizerActive'=>Domain::ORGANIZER_ACTIVE,'communityDayGlobal'=>Domain::COMMUNITY_DAY_GLOBAL,'organizerProfilesDay'=>Domain::ORGANIZER_PROFILES_DAY,
    'clubsDayPerUser'=>Domain::CLUBS_DAY_PER_USER,'clubsDayGlobal'=>Domain::CLUBS_DAY_GLOBAL,'minorSelfAge'=>Domain::MINOR_SELF_AGE,'adultAge'=>Domain::ADULT_AGE,'athletesPerAccount'=>Domain::ATHLETES_PER_ACCOUNT,'retentionMonths'=>Domain::RETENTION_MONTHS],
   'history'=>array_map(fn($r)=>['at'=>(int)$r['created_at'],'actor'=>$names[$r['actor_id']]??(in_array($r['actor_id'],['system','self'],true)?$r['actor_id']:self::ACTOR_GONE),'action'=>$r['action'],'note'=>$r['note']],$rows),
   'updatedAt'=>$s['updatedAt'],'updatedBy'=>$s['updatedBy']===null?null:($names[$s['updatedBy']]??null)];
 }
 /**
  * Display names of audit actors (id => name, §3.5 point 6, §11: readable, never a person's e-mail or an internal id): the
  * profile name ("Marta K."), else the username, else the club name of a club account, else the role label of a staff
  * account ('Administrator', 'Edytor', 'Reprezentant klubu'; 'Członek' for a member without a profile); an id without an
  * account (erased) is 'Konto usunięte'. The labels are Polish literals the panel translates (existing dictionary keys);
  * 'system' and 'self' stay as they are.
  */
 private static function names(PDO $pdo,array $ids):array {
  $ids=array_values(array_unique(array_filter($ids,fn($v)=>is_string($v)&&$v!==''&&$v!=='system'&&$v!=='self')));$out=array_fill_keys($ids,self::ACTOR_GONE);
  foreach(array_chunk($ids,500) as $chunk){
   $q=$pdo->prepare('SELECT u.id,u.role,c.name AS club,p.username,p.first_name,p.last_name FROM users u LEFT JOIN clubs c ON c.id=u.club_id LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id IN ('.implode(',',array_fill(0,count($chunk),'?')).')');$q->execute($chunk);
   foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r){$n=People::name($r['first_name'],$r['last_name'],false);$out[$r['id']]=$n!==''?$n:($r['username']??($r['role']==='club'&&$r['club']!==null&&$r['club']!==''?$r['club']:(self::ROLE_LABEL[$r['role']]??self::ROLE_LABEL['member'])));}
  }
  return $out;
 }
 /**
  * The Stripe check (§3.4 point 3, admin-stripe-check): StripeClient::interactive and Billing::resolvePrice (fresh) for
  * every currency of stripe_prices, outside any transaction (the caller released the session); the amount of each price
  * must equal billing_amounts, which guests see (B16: error amount_mismatch). The result, with the fingerprint() of the
  * configuration it was made against, is stored in data.stripeCheck without a version change (it is not a setting) and
  * returned without the fingerprint; a failed check replaces a passed one, so effective() stops the paid mode (B4). A
  * missing price or another amount: 409 stripe_not_ready; any other Stripe failure is rethrown (the route answers 503
  * through Billing::guard).
  */
 public static function stripeCheck(PDO $pdo,array $file,int $now):array {
  if(!Billing::enabled($file))self::notReady();
  $prices=['pln'=>false,'usd'=>false];$fail=null;$missing=false;$amount=false;$mode=($file['billing_mode']??'test')==='live'?'live':'test';
  try{
   $client=StripeClient::interactive($file);
   foreach(array_keys((array)$file['stripe_prices']) as $cur){
    try{Billing::resolvePrice($pdo,$file,$client,(string)$cur,true);}catch(StripeError $e){if(!$e->missing())throw $e;$missing=true;continue;}
    // resolvePrice stored the price's unit_amount next to its id (billing_kv price:<mode>:<lookup key>).
    $want=$file['billing_amounts'][$cur]??null;$hit=json_decode((string)BillingSync::kv($pdo,'price:'.$file['billing_mode'].':'.$file['stripe_prices'][$cur]),true);
    if($want!==null&&(!is_array($hit)||($hit['amount']??null)!==$want)){$amount=true;continue;}
    $prices[$cur]=true;
   }
  }catch(StripeError $e){$fail=$e;}
  $code=$fail?($fail->unavailable()?'unavailable':(in_array($fail->status,[401,403],true)?'auth':'error')):($missing?'price_missing':($amount?'amount_mismatch':null));
  $check=['at'=>$now,'ok'=>$code===null,'mode'=>$mode,'prices'=>$prices,'error'=>$code];
  self::write($pdo,fn(array $raw,int $v)=>[$v,['stripeCheck'=>$check+['fp'=>self::fingerprint($file)]]+$raw,false],$now,null);
  if($fail)throw $fail;
  if($missing||$amount)self::notReady(['stripeCheck'=>$check]);
  return $check;
 }
 private static function notReady(array $extra=[]):never{throw new ApiError('Płatności nie są skonfigurowane. Najpierw skonfiguruj Stripe (DEPLOY-PL.md).',409,['code'=>'stripe_not_ready']+$extra);}
 private static function stale():never{throw new ApiError('Ustawienia zmienił w międzyczasie ktoś inny. Odśwież stronę.',409,['code'=>'stale']);}
 /**
  * One locked read-modify-write of the row: a placeholder row (version 0, '{}', the same as no row) makes FOR UPDATE lock
  * something even on the first write; $fn(raw, version) returns [new version, new raw data, touched (updated_at/by)].
  * The placeholder is written with ON DUPLICATE KEY UPDATE, which takes the exclusive lock on an existing row at once
  * (INSERT IGNORE takes a shared one: two concurrent writers would both hold it and deadlock on FOR UPDATE, 1213).
  * Runs inside the caller's transaction when one is open. Drops the cached row.
  */
 private static function write(PDO $pdo,callable $fn,int $now,?string $by):mixed {
  $own=!$pdo->inTransaction();if($own)$pdo->beginTransaction();
  try{
   $pdo->prepare("INSERT INTO app_settings (id,version,data,updated_at,updated_by) VALUES (1,0,'{}',?,NULL) ON DUPLICATE KEY UPDATE id=id")->execute([$now]);
   $r=$pdo->query('SELECT version,data FROM app_settings WHERE id=1 FOR UPDATE')->fetch(PDO::FETCH_ASSOC);
   $raw=json_decode((string)$r['data'],true);[$version,$data,$touch]=$fn(is_array($raw)?$raw:[],(int)$r['version']);
   $json=json_encode($data?:new \stdClass(),JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
   if($touch)$pdo->prepare('UPDATE app_settings SET version=?,data=?,updated_at=?,updated_by=? WHERE id=1')->execute([$version,$json,$now,$by]);
   else $pdo->prepare('UPDATE app_settings SET data=? WHERE id=1')->execute([$json]);
   if($own)$pdo->commit();
  }catch(\Throwable $e){if($own&&$pdo->inTransaction())$pdo->rollBack();self::forget($pdo);throw $e;}
  self::forget($pdo);
  return $data;
 }
 /**
  * admin-settings-save {version, signup?, payments?, organizers?, trustRequired?, supportEmail?, freePeriod?,
  * allowTestMode? (confirmTestMode? is the same)} for the raw config.php $file (§3.4, §3.6, §17); returns view().
  * Starting payments (free → paid) and opening the paid sign-up (mode → 'paid', also off → on while payments are already
  * 'paid', B5) are the transitions with conditions: a fresh Stripe check, the test-mode confirmation and, while payments
  * are not effectively enforced (also when effective() lifted them after a failed or outdated check, B4), the free-period
  * decision. 'paid' → 'free' is always allowed; saving other fields while Stripe is missing or not verified keeps the
  * degraded state of effective().
  */
 public static function save(PDO $pdo,array $file,array $admin,array $in,int $now):array {
  $bad=fn()=>throw new AppError('Niepoprawny formularz.',400);
  $version=$in['version']??null;if(!is_int($version)||$version<0)$bad();
  foreach(['signup'=>self::SIGNUP,'payments'=>self::PAYMENTS,'organizers'=>self::ORGANIZERS] as $k=>$allowed)if(array_key_exists($k,$in)&&!in_array($in[$k],$allowed,true))$bad();
  foreach(['trustRequired','confirmTestMode','allowTestMode'] as $k)if(array_key_exists($k,$in)&&!is_bool($in[$k]))$bad();
  $email=null;
  if(array_key_exists('supportEmail',$in)){if(!is_string($in['supportEmail']))$bad();$email=self::email($in['supportEmail'])??throw new AppError('Podaj poprawny e-mail.',422);}
  $decision=$in['freePeriod']??null;$from=null;
  if($decision!==null){
   $action=is_array($decision)?($decision['action']??null):null;if(!in_array($action,['keep','requireFrom'],true))$bad();
   if($action==='requireFrom'){$from=Billing::dayStart($decision['date']??null);if($from<Billing::grandfatheredMin($now))throw new AppError('Płatność można wymagać od daty co najmniej 14 dni od dziś.',422);}
  }
  $cur=self::get($pdo,$file);if($version!==$cur['version'])self::stale();
  $apply=function(array $d)use($in,$email):array{foreach(['signup','payments','organizers','trustRequired'] as $k)if(array_key_exists($k,$in))$d[$k]=$in[$k];if($email!==null)$d['supportEmail']=$email;return $d;};
  $next=$apply($cur['data']);
  if(array_intersect_key($next,array_flip(self::FIELDS))==array_intersect_key($cur['data'],array_flip(self::FIELDS)))return self::view($pdo,$file,$now);
  // Payments start (free → paid) or the paid sign-up opens to everybody (B5: also off → on while payments are 'paid').
  $toPaid=$next['payments']==='paid'&&($cur['data']['payments']!=='paid'||self::mode($next)==='paid'&&self::mode($cur['data'])!=='paid');$test=false;
  // The free-period decision whenever enforcement is not effective yet (free, or lifted by effective() after a failed or
  // outdated Stripe check: test subscribers would lose access on the switch to live keys, B4); its set is the one of the
  // current state, where payments are not required yet (group B: who would lose access).
  $decide=$toPaid&&empty(self::effective($pdo,$file)['billing_enforce']);
  $free=['billing_enforce'=>false]+$file;
  if($toPaid){
   if(!Billing::enabled($file))self::notReady();
   self::stripeCheck($pdo,$file,$now);
   $test=($file['billing_mode']??'test')!=='live';
   if($test&&($in['allowTestMode']??false)!==true&&($in['confirmTestMode']??false)!==true)throw new ApiError('Stripe działa w trybie testowym: nikt nie zapłaci prawdziwymi pieniędzmi. Potwierdź, jeśli to zamierzone.',409,['code'=>'test_mode','confirmTestMode'=>true]);
   if($decide){$set=Billing::freePeriodSet($pdo,$free,$now);if(($set['a']||$set['b'])&&$decision===null)self::decide($set);}
  }
  $pdo->beginTransaction();
  try{
   $counts=null;
   $saved=self::write($pdo,function(array $raw,int $v)use($pdo,$version,$file,$free,$apply,$decide,$decision,$from,$admin,$now,&$counts):array{
    if($v!==$version)self::stale();
    if($decide){
     // The set again under the lock: an account created since the check above is decided as well, never silently cut off.
     $set=Billing::freePeriodSet($pdo,$free,$now);
     if(($set['a']||$set['b'])&&$decision===null)self::decide($set);
     $counts=$decision===null?['a'=>0,'b'=>0]:Billing::freePeriodApply($pdo,$admin['id'],$set,$from,$now);
    }
    return [$v+1,array_intersect_key($apply(self::normalize($raw,$file)),array_flip(self::FIELDS))+$raw,true];
   },$now,$admin['id']);
   $s=self::normalize($saved,$file);
   $note='signup='.$s['signup'].' payments='.$s['payments'].' organizers='.$s['organizers'].' trustRequired='.($s['trustRequired']?1:0);
   if($toPaid)$note.=($decision===null||!$decide?'':' '.($from===null?'keep':'requireFrom:'.date('Y-m-d',$from))).($decide?' a='.$counts['a'].' b='.$counts['b']:'').($test?' test':'');
   Members::audit($pdo,$admin['id'],'settings.save',null,mb_substr($note,0,200));
   if($s['supportEmail']!==$cur['data']['supportEmail'])Members::audit($pdo,$admin['id'],'settings.support',null,mb_substr($cur['data']['supportEmail'],0,self::NOTE_VALUE).' -> '.mb_substr($s['supportEmail'],0,self::NOTE_VALUE));
   $pdo->commit();
  }catch(\Throwable $e){if($pdo->inTransaction())$pdo->rollBack();self::forget($pdo);throw $e;}
  return self::view($pdo,$file,$now);
 }
 private static function decide(array $set):never{throw new ApiError('Zdecyduj, co z kontami założonymi w okresie bezpłatnym.',409,['code'=>'free_period_decision','counts'=>['a'=>count($set['a']),'b'=>count($set['b'])]]);}
}
