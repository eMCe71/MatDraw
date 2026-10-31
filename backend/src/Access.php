<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Access state machine (plan §6.5), a pure function of the billing_accounts row, the account, config and the time.
 * Rows are checked in order; a row whose time window has passed does not match, so evaluation continues:
 *   1 billing_enforce=false                                   → full, open
 *   2 role admin                                              → full, staff
 *   3 role editor/club without a billing row                  → full, free (reason staff-default)
 *   4 billing_exempt=1 and (exempt_until null or > now)       → full, free, until exempt_until
 *   5 active/trialing, cancel_at_period_end=0                 → full while now < period_end + leeway (72 h), active, until period_end
 *   6 active/trialing, cancel_at_period_end=1                 → full while now < period_end, ending, until period_end
 *   7 past_due                                                → full while now < period_start + grace_days, past_due, until that time
 *   8 billing_exempt=1, exempt_until ≤ now < exempt_until + grace_days → full, grace, until exempt_until + grace
 *   9 incomplete                                              → no, processing
 *  10 canceled, unpaid, incomplete_expired, paused, foreign    → no, ended
 *  11 anything else (no member row, none, other mode, grace over) → no, none
 * Subscription fields of a row whose livemode differs from billing_mode count as empty (test data after going live);
 * the exemption fields are not subscription fields and still apply. An expired exemption next to a live subscription
 * therefore gives active, not grace.
 */
final class Access {
 public const STATES=['open','staff','free','grace','active','ending','past_due','processing','none','ended'];
 private const ONGOING=['active','trialing','past_due','incomplete'];
 /** {full:bool, state, until:?int} */
 public static function compute(?array $row,array $user,array $cfg,int $now):array {
  $out=fn(bool $full,string $state,?int $until=null)=>['full'=>$full,'state'=>$state,'until'=>$until];
  if(empty($cfg['billing_enforce']))return $out(true,'open');
  $role=$user['role']??'';
  if($role==='admin')return $out(true,'staff');
  if($row===null&&in_array($role,['editor','club'],true))return $out(true,'free');
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
  if($sub==='incomplete')return $out(false,'processing');
  if(in_array($sub,['canceled','unpaid','incomplete_expired','paused','foreign'],true))return $out(false,'ended');
  return $out(false,'none');
 }
 /** compute() for an account, reading its billing row by primary key only when the answer depends on it. */
 public static function of(PDO $pdo,array $user,array $cfg,?int $now=null):array {
  $now??=time();if(empty($cfg['billing_enforce'])||($user['role']??'')==='admin')return self::compute(null,$user,$cfg,$now);
  return self::compute(self::row($pdo,(string)$user['id']),$user,$cfg,$now);
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
