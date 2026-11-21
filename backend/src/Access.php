<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Access state machine (plan §6.5), a pure function of the billing_accounts row, the account, config and the time.
 * Rows are checked in order; a row whose time window has passed does not match, so evaluation continues:
 *   1 billing_enforce=false                                   → full, open
 *   2 role admin                                              → full, staff
 *   3 role editor/club without a billing row, type free       → full, free (reason staff-default)
 *   4 billing_exempt=1 and (exempt_until null or > now)       → full, free, until exempt_until
 *   5 active/trialing, cancel_at_period_end=0                 → full while now < period_end + leeway (72 h), active, until period_end
 *   6 active/trialing, cancel_at_period_end=1                 → full while now < period_end, ending, until period_end
 *   7 past_due                                                → full while now < period_start + grace_days, past_due, until that time
 *   8 billing_exempt=1, exempt_until ≤ now < exempt_until + grace_days → full, grace, until exempt_until + grace
 *   8b member account free by its kinds and no individual decision → full, free or partial (memberFree, byType)
 *   9 incomplete                                              → no, processing
 *  10 canceled, unpaid, incomplete_expired, paused, foreign    → no, ended
 *  11 anything else (no member row, none, other mode, grace over) → no, none
 * Subscription fields of a row whose livemode differs from billing_mode count as empty (test data after going live);
 * the exemption fields are not subscription fields and still apply. An expired exemption next to a live subscription
 * therefore gives active, not grace.
 *
 * "Type free" is the column "Płatne konto" of the Administrator's matrix (Permissions billing.required in discipline $sport,
 * null for an action outside any discipline: the global set; read from $cfg['permissions'], the effective configuration; without one the defaults: editor and club free, every kind of member
 * account paying, so rows 3 and 8b give exactly the behaviour before the panel). Staff keep their old rule (free only
 * without a billing row). A member account is free by type only when every one of its kinds (Permissions::types, passed as
 * $user['types'] by withTypes()/memberTypes()) is free and the Administrator decided nothing for that one account (no
 * exemption, current or expired, and no "Wymagaj płatności": billing_exempt=0 and exempt_by null); a running subscription
 * still shows as active. Without loaded kinds a member account pays (the rule before the panel).
 */
final class Access {
 public const STATES=['open','staff','free','partial','grace','active','ending','past_due','processing','none','ended'];
 private const ONGOING=['active','trialing','past_due','incomplete'];
 /** {full:bool, state, until:?int} */
 public static function compute(?array $row,array $user,array $cfg,int $now,?string $sport=null):array {
  $out=fn(bool $full,string $state,?int $until=null)=>['full'=>$full,'state'=>$state,'until'=>$until];
  if(empty($cfg['billing_enforce']))return $out(true,'open');
  $role=$user['role']??'';
  if($role==='admin')return $out(true,'staff');
  if($row===null&&in_array($role,['editor','club'],true)&&($k=self::byType([$role],$cfg['permissions']??null,$sport))!==null)return $out(true,$k);
  $row??=[];$grace=max(0,(int)($cfg['billing_grace_days']??7))*86400;
  $exempt=!empty($row['billing_exempt']);$until=isset($row['exempt_until'])?(int)$row['exempt_until']:null;
  if($exempt&&($until===null||$until>$now))return $out(true,'free',$until);
  $sub=self::subStatus($row,$cfg);$end=isset($row['current_period_end'])?(int)$row['current_period_end']:null;
  if(in_array($sub,['active','trialing'],true)&&$end!==null){
   if(empty($row['cancel_at_period_end'])){if($now<$end+max(0,(int)($cfg['billing_stale_leeway_hours']??72))*3600)return $out(true,'active',$end);}
   elseif($now<$end)return $out(true,'ending',$end);
  }
  if($sub==='past_due'&&isset($row['current_period_start'])){$t=(int)$row['current_period_start']+$grace;if($now<$t)return $out(true,'past_due',$t);}
  if($exempt&&$until!==null&&$until<=$now&&$now<$until+$grace)return $out(true,'grace',$until+$grace);
  if($role==='member'&&($k=self::memberFree($row,$user,$cfg,$sport))!==null)return $out(true,$k);
  if($sub==='incomplete')return $out(false,'processing');
  if(in_array($sub,['canceled','unpaid','incomplete_expired','paused','foreign'],true))return $out(false,'ended');
  return $out(false,'none');
 }
 /** compute() for an account, reading its billing row by primary key only when the answer depends on it. */
 public static function of(PDO $pdo,array $user,array $cfg,?int $now=null,?string $sport=null):array {
  $now??=time();if(empty($cfg['billing_enforce'])||($user['role']??'')==='admin')return self::compute(null,$user,$cfg,$now);
  return self::compute(self::row($pdo,(string)$user['id']),self::withTypes($pdo,$user,$cfg),$cfg,$now,$sport);
 }
 /**
  * Whether some discipline's own set of the matrix answers "Płatne konto" differently from the global set: only then does
  * a gate need the discipline of an action (commandSport); otherwise compute() without one gives the same answer.
  */
 public static function varies(array $cfg):bool {
  $m=$cfg['permissions']??null;if(empty($cfg['billing_enforce'])||!is_array($m))return false;
  foreach($m['sports']??[] as $set)foreach($set as $type=>$perms)if(isset($perms['billing.required'])&&$perms['billing.required']!==Permissions::allows($type,'billing.required',null,$m))return true;
  return false;
 }
 /** The discipline a gate checks for $user (null without differences, varies() false) of tournament $id. */
 public static function tournamentSport(PDO $pdo,array $cfg,mixed $id):?string {
  if(!self::varies($cfg)||!is_string($id))return null;
  $q=$pdo->prepare('SELECT sport FROM tournaments WHERE id=?');$q->execute([$id]);$s=$q->fetchColumn();$q->closeCursor();
  return $s===false?null:Sports::of(['sport'=>$s]);
 }
 /**
  * The discipline of a workspace command for the payment gate (null: outside any discipline, or no differences): the
  * tournament of payload.tournamentId; for tournament.save the discipline it is saved in (payload.sport, else the stored one).
  */
 public static function commandSport(PDO $pdo,array $cfg,string $type,array $p):?string {
  if(!self::varies($cfg))return null;
  if($type==='tournament.save'&&Sports::valid($p['sport']??null))return $p['sport'];
  return self::tournamentSport($pdo,$cfg,$type==='tournament.save'?($p['id']??null):($p['tournamentId']??null));
 }
 /** Row 8b: a member account free by the kinds of its account, with no individual decision of the Administrator. */
 private static function memberFree(array $row,array $user,array $cfg,?string $sport):?string {
  if(!empty($row['billing_exempt'])||($row['exempt_by']??null)!==null||!is_array($user['types']??null)||!$user['types'])return null;
  return self::byType($user['types'],$cfg['permissions']??null,$sport);
 }
 /**
  * Free by type: 'free', 'partial' or null (pays). In a discipline: free when no type pays there. Outside any discipline
  * ($sport null: the account as a whole, its profile, the general chat): 'free' when it pays nowhere, 'partial' when it is
  * free in the global set or in some discipline's own set but pays in another (full access; the discipline gates
  * (commandSport, tournamentSport, Chat::send) ask for the subscription there), null when it pays everywhere.
  */
 private static function byType(array $types,?array $m,?string $sport):?string {
  if($sport!==null)return Permissions::paid($types,$m,$sport)?null:'free';
  $free=[];foreach([null,...array_keys(is_array($m)?($m['sports']??[]):[])] as $s)$free[]=!Permissions::paid($types,$m,$s);
  if(!in_array(true,$free,true))return null;
  return in_array(false,$free,true)?'partial':'free';
 }
 /** Whether some kind of member account is free in the matrix of $cfg (only then compute() needs the kinds of an account). */
 public static function needsTypes(array $cfg):bool {
  if(empty($cfg['billing_enforce'])||!is_array($cfg['permissions']??null))return false;
  foreach(['organizer','athlete','guardian','member'] as $t)foreach([null,...array_keys($cfg['permissions']['sports']??[])] as $s)if(!Permissions::allows($t,'billing.required',$s,$cfg['permissions']))return true;
  return false;
 }
 /** $user with 'types' (the kinds of a member account) when compute() needs them; one read by key. */
 public static function withTypes(PDO $pdo,array $user,array $cfg):array {
  if(($user['role']??null)!=='member'||isset($user['types'])||!self::needsTypes($cfg))return $user;
  return $user+['types'=>self::memberTypes($pdo,[(string)$user['id']])[(string)$user['id']]??['member']];
 }
 /**
  * id => Permissions::types of member accounts ($ids, or every member account when null): organizer from users.organizer
  * without organizer_blocked_at (Domain::organizer), athlete/guardian from own profiles that are not archived.
  * Empty when compute() does not need them ($cfg given and needsTypes false).
  */
 public static function memberTypes(PDO $pdo,?array $ids=null,?array $cfg=null):array {
  if($cfg!==null&&!self::needsTypes($cfg))return [];
  if($ids===[])return [];
  $in=$ids===null?'':' AND id IN ('.implode(',',array_fill(0,count($ids),'?')).')';
  $q=$pdo->prepare("SELECT id,organizer,organizer_blocked_at FROM users WHERE role='member'".$in);$q->execute($ids??[]);
  $org=[];foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r)$org[(string)$r['id']]=!empty($r['organizer'])&&$r['organizer_blocked_at']===null;
  $q=$pdo->prepare('SELECT owner_user_id,data FROM profiles WHERE archived=0 AND owner_user_id IS NOT NULL'.($ids===null?'':' AND owner_user_id IN ('.implode(',',array_fill(0,count($ids),'?')).')'));$q->execute($ids??[]);
  $rel=[];foreach($q->fetchAll(PDO::FETCH_ASSOC) as $p){$d=json_decode((string)$p['data'],true);if(is_array($d)&&in_array($d['relation']??null,['self','guardian'],true))$rel[(string)$p['owner_user_id']][]=$d['relation'];}
  $out=[];foreach($org as $id=>$o)$out[$id]=Permissions::types('member',$o,$rel[$id]??[]);
  return $out;
 }
 /** The billing_accounts row of an account, or null. */
 public static function row(PDO $pdo,string $userId):?array{$q=$pdo->prepare('SELECT * FROM billing_accounts WHERE user_id=?');$q->execute([$userId]);$r=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();return $r?:null;}
 /** sub_status of the row, or 'none' when it has none or its livemode is not the current billing_mode. */
 public static function subStatus(?array $row,array $cfg):string {
  if(!$row)return 'none';$live=($cfg['billing_mode']??'test')==='live';
  return ((int)($row['livemode']??0)===1)===$live?(string)($row['sub_status']??'none'):'none';
 }
 /**
  * Plan currency (§6.1), the single rule for me and checkout: the currency of an ongoing subscription (active, trialing,
  * past_due, incomplete in the current mode); otherwise 'pln' for country PL, 'usd' for any other country, null without one.
  */
 public static function currency(?array $row,?string $country,array $cfg):?string {
  if(in_array(self::subStatus($row,$cfg),self::ONGOING,true)&&in_array($row['currency']??null,['pln','usd'],true))return $row['currency'];
  if(!is_string($country)||!preg_match('/^[A-Z]{2}$/D',$country))return null;
  return $country==='PL'?'pln':'usd';
 }
}
