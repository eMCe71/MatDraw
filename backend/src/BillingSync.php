<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Billing state from Stripe without relying on webhooks (plan §6.3, report 03 §7–§8 with the overrides of §6.11).
 *
 * Every write starts from an object fetched in the pinned API version (event payloads only name what changed) and goes
 * through apply(): owner by stripe_subscription_id, then stripe_customer_id, then metadata.matbravo_user_id (only for a
 * row without a customer of this mode); a tombstone row (deleted_at, §3.8) never changes and only gets an audit entry;
 * a row that already points at ANOTHER subscription takes the incoming one only when it is better (prefer(): a non-terminal
 * status beats a terminal one, then the newer created; otherwise only billing_audit 'sub.ignored'), and the UPDATE is
 * conditional on the subscription the decision was made against and on last_synced_at <= the fetch start (stale-write
 * guard), so neither an old event nor a slower fetch can overwrite newer state.
 *
 * Sources: confirm and checkout events (session), syncUser() (one call lists the customer's subscriptions with the
 * customer expanded: best subscription, customer e-mail compared and corrected, deleted customer detected, more than one
 * ongoing subscription audited as 'sub.multiple'), handleEvent() (15 types, idempotent through stripe_events shared by
 * webhook and pull), pullEvents() (forward from the cursor in billing_kv, then the 120 s up to it once more for events
 * Stripe lists late), reconcile() (all subscriptions, best per customer), due() (rows whose next_sync_at passed, plus
 * retries of customer deletions, stripe_redact_pending), lazy() (after the response of me only).
 * Concurrency: a sync claims the row (sync_claimed_at, 60 s lease, rowCount 1) and never holds a transaction or lock
 * while talking to Stripe. Background work uses StripeClient::background (no retries, 3 s / 8 s, circuit breaker).
 * Audit rows hold ids and short codes only, never e-mails or addresses.
 */
final class BillingSync {
 public const ONGOING=['active','trialing','past_due','incomplete'];
 public const PRODUCT='matbravo_membership';
 public const LEASE=60,RETRY_AFTER_ERROR=900,MAX_INTERVAL=604800,EVENTS_KEEP=7776000,EVENT_ATTEMPTS=5,REDACT_BACKOFF=3600;
 /** Seconds of work per job run (Jobs: a job should stop after about 2 s of work). */
 public const JOB_BUDGET=2.0;
 /** Pages of 100 read again behind the event cursor (lateEvents). */
 public const LATE_PAGES=3;
 public const EVENT_TYPES=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired',
  'customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed','customer.subscription.trial_will_end',
  'invoice.paid','invoice.payment_failed','invoice.payment_action_required','invoice.finalized','customer.deleted'];
 // Audit-only types (owner handles them in the Dashboard); not in the pull list (types[] stays within 20 entries).
 private const AUDIT_TYPES=['charge.dispute.created','charge.refunded'];

 // ---- pure functions (tests/billing.test.mjs) -------------------------------------------------------------------
 /** Id of a Stripe reference that may be a string or an expanded object. */
 public static function ref(mixed $v):?string{return is_string($v)&&$v!==''?$v:(is_array($v)&&is_string($v['id']??null)?$v['id']:null);}
 /**
  * billing_accounts fields from a Subscription (03 §8.2). Our item is the one whose price has one of our lookup keys or
  * belongs to our product (a price replaced with --reprice loses its lookup key but keeps the product); without one the
  * status is 'foreign'. Periods come from the item ('basil'+ API versions) with a fallback to the old top-level fields.
  * latest_invoice may be an expanded object or a bare id (then its status is unknown).
  */
 public static function stateFromSubscription(array $sub,array $priceKeys):array {
  $ours=null;
  foreach(($sub['items']['data']??[]) as $i){if(!is_array($i))continue;$p=is_array($i['price']??null)?$i['price']:[];
   if(in_array($p['lookup_key']??null,$priceKeys,true)||self::ref($p['product']??null)===self::PRODUCT){$ours=$i;break;}}
  $int=fn($v)=>is_int($v)?$v:(is_numeric($v)?(int)$v:null);
  $end=$int($ours['current_period_end']??null)??$int($sub['current_period_end']??null);
  $start=$int($ours['current_period_start']??null)??$int($sub['current_period_start']??null);
  $inv=is_array($sub['latest_invoice']??null)?$sub['latest_invoice']:null;$cur=is_string($sub['currency']??null)?strtolower($sub['currency']):null;
  return ['stripe_subscription_id'=>(string)($sub['id']??''),'sub_status'=>$ours?(string)($sub['status']??'none'):'foreign',
   'price_lookup_key'=>is_string($ours['price']['lookup_key']??null)?$ours['price']['lookup_key']:null,'currency'=>$cur!==null&&preg_match('/^[a-z]{3}$/D',$cur)?$cur:null,
   'current_period_start'=>$start,'current_period_end'=>$end,'cancel_at_period_end'=>(int)!empty($sub['cancel_at_period_end']),
   'cancel_at'=>$int($sub['cancel_at']??null),'canceled_at'=>$int($sub['canceled_at']??null),'ended_at'=>$int($sub['ended_at']??null),
   'latest_invoice_status'=>is_string($inv['status']??null)?$inv['status']:null,'livemode'=>(int)!empty($sub['livemode']),
   'stripe_customer_id'=>self::ref($sub['customer']??null),'created'=>$int($sub['created']??null)];
 }
 /**
  * Subscription precedence for the single billing row (§6.3): whether the incoming subscription replaces the current one.
  * Non-terminal (active, trialing, past_due, incomplete) beats everything else (canceled, incomplete_expired, unpaid,
  * paused, foreign, none); within the same class the newer created wins; a tie keeps the current one.
  */
 public static function prefer(string $curStatus,?int $curCreated,string $inStatus,?int $inCreated):bool {
  $in=in_array($inStatus,self::ONGOING,true);$cur=in_array($curStatus,self::ONGOING,true);
  if($in!==$cur)return $in;
  return ($inCreated??0)>($curCreated??0);
 }
 /** The best subscription of a list (reconcile groups by customer): states from stateFromSubscription(), order-independent. */
 public static function best(array $states):?array {
  $best=null;
  foreach($states as $s)if($best===null||self::prefer($best['sub_status'],$best['created'],$s['sub_status'],$s['created'])||(!self::prefer($s['sub_status'],$s['created'],$best['sub_status'],$best['created'])&&strcmp($s['stripe_subscription_id'],$best['stripe_subscription_id'])>0))$best=$s;
  return $best;
 }
 /**
  * When to look at Stripe again (03 §8.3): active/trialing with a paid invoice → period end + 2 h; renewal invoice
  * draft/open → now + 2 h; cancel at period end → period end + 5 min; past_due → now + 6 h; incomplete → now + 10 min;
  * paused → 7 days; a pending checkout without an ongoing subscription → its expiry + 5 min; anything else → null (no
  * polling). Capped at now + 7 days and never sooner than now + $minInterval (billing_sync_min_interval).
  */
 public static function nextSyncAt(array $s,int $now,int $minInterval=600):?int {
  $status=(string)($s['sub_status']??'none');$end=isset($s['current_period_end'])?(int)$s['current_period_end']:null;
  if(in_array($status,['active','trialing'],true)){
   if(!empty($s['cancel_at_period_end']))$t=($end??$now)+300;
   elseif(in_array($s['latest_invoice_status']??null,['draft','open'],true))$t=$now+7200;
   else $t=($end??$now)+7200;
  }elseif($status==='past_due')$t=$now+21600;
  elseif($status==='incomplete')$t=$now+600;
  elseif($status==='paused')$t=$now+self::MAX_INTERVAL;
  elseif(!empty($s['pending_checkout_id'])&&isset($s['pending_checkout_expires']))$t=(int)$s['pending_checkout_expires']+300;
  else return null;
  return max($now+max(0,$minInterval),min($t,$now+self::MAX_INTERVAL));
 }
 /** Subscription id of an Invoice: parent.subscription_details.subscription ('basil'+), else the old invoice.subscription. */
 public static function invoiceSubscription(array $inv):?string {
  $p=is_array($inv['parent']??null)?$inv['parent']:null;
  if($p&&($p['type']??null)==='subscription_details'&&($id=self::ref($p['subscription_details']['subscription']??null)))return $id;
  return self::ref($inv['subscription']??null);
 }
 /** A Stripe event we accept (§6.4): object 'event', id evt_…, a type, livemode of the configured mode, data.object. */
 public static function validEvent(mixed $e,array $c):bool {
  return is_array($e)&&($e['object']??null)==='event'&&is_string($e['id']??null)&&preg_match('/^evt_[A-Za-z0-9]{1,250}$/D',$e['id'])
   &&is_string($e['type']??null)&&preg_match('/^[a-z0-9_.]{1,100}$/D',$e['type'])&&is_bool($e['livemode']??null)&&$e['livemode']===(($c['billing_mode']??'test')==='live')
   &&is_array($e['data']['object']??null);
 }
 public static function live(array $c):bool{return ($c['billing_mode']??'test')==='live';}
 private static function priceKeys(array $c):array{return array_values(array_filter((array)$c['stripe_prices'],'is_string'));}

 // ---- storage helpers --------------------------------------------------------------------------------------------
 public static function audit(PDO $pdo,?string $userId,string $actor,string $action,?string $old=null,?string $new=null,?string $detail=null):void {
  $pdo->prepare('INSERT INTO billing_audit (user_id,actor,action,old_status,new_status,detail,created_at) VALUES (?,?,?,?,?,?,?)')
   ->execute([$userId,mb_substr($actor,0,40),substr($action,0,50),$old===null?null:substr($old,0,32),$new===null?null:substr($new,0,32),$detail===null?null:mb_substr($detail,0,500),time()]);
 }
 public static function kv(PDO $pdo,string $k):?string{$q=$pdo->prepare('SELECT v FROM billing_kv WHERE k=?');$q->execute([$k]);$v=$q->fetchColumn();$q->closeCursor();return is_string($v)?$v:null;}
 public static function kvSet(PDO $pdo,string $k,?string $v):void {
  if($v===null){$pdo->prepare('DELETE FROM billing_kv WHERE k=?')->execute([$k]);return;}
  $pdo->prepare('INSERT INTO billing_kv (k,v,updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE v=VALUES(v),updated_at=VALUES(updated_at)')->execute([$k,$v,time()]);
 }
 /**
  * Every Stripe Customer an account ever had (billing_customers, migration 0006): Billing records each one it creates
  * or replaces, and account deletion deletes them all (§3.8 step 4), not only the current one.
  */
 public static function remember(PDO $pdo,string $userId,string $customerId,int $livemode):void {
  $pdo->prepare('INSERT IGNORE INTO billing_customers (customer_id,user_id,livemode,created_at) VALUES (?,?,?,?)')->execute([$customerId,$userId,$livemode,time()]);
 }
 /** customer id => livemode of the account's customers not yet deleted in Stripe (the current one included once remembered). */
 public static function customersOf(PDO $pdo,string $userId):array {
  $q=$pdo->prepare('SELECT customer_id,livemode FROM billing_customers WHERE user_id=? AND redacted_at IS NULL ORDER BY created_at,customer_id');$q->execute([$userId]);
  $out=[];foreach($q->fetchAll(PDO::FETCH_NUM) as [$id,$live])$out[(string)$id]=(int)$live;return $out;
 }
 /** Stripe confirmed the deletion (or no longer knows the customer). */
 public static function redacted(PDO $pdo,string $customerId):void{$pdo->prepare('UPDATE billing_customers SET redacted_at=? WHERE customer_id=? AND redacted_at IS NULL')->execute([time(),$customerId]);}
 /** The account an orphaned subscription belongs to after all: a former customer of it, else metadata naming an account. */
 private static function formerOwner(PDO $pdo,array $state,array $metadata):?string {
  if($state['stripe_customer_id']!==null){$q=$pdo->prepare('SELECT user_id FROM billing_customers WHERE customer_id=?');$q->execute([$state['stripe_customer_id']]);$v=$q->fetchColumn();$q->closeCursor();if(is_string($v))return $v;}
  $uid=$metadata['matbravo_user_id']??null;
  return is_string($uid)&&preg_match('/^[A-Za-z0-9_-]{1,40}$/D',$uid)&&Accounts::find($pdo,$uid)?$uid:null;
 }
 private static function rowBy(PDO $pdo,string $column,string $value):?array {
  if(!in_array($column,['user_id','stripe_customer_id','stripe_subscription_id','pending_checkout_id'],true))throw new \InvalidArgumentException('column');
  $q=$pdo->prepare("SELECT * FROM billing_accounts WHERE $column=?");$q->execute([$value]);$r=$q->fetch(PDO::FETCH_ASSOC);$q->closeCursor();return $r?:null;
 }
 /** sub_status of a row for this mode ('none' for another mode). */
 private static function rowStatus(?array $row,array $c):string{return Access::subStatus($row,$c);}
 private static function sameMode(array $row,array $c):bool{return ((int)$row['livemode']===1)===self::live($c);}

 // ---- applying fetched objects -----------------------------------------------------------------------------------
 /**
  * The row a subscription belongs to (03 §8.2): same subscription id, else same customer id, else
  * metadata.matbravo_user_id when that row has no customer of this mode or the same one. A missing row of an existing
  * account is created (staff without a row stay free: billing_exempt with reason staff-default).
  */
 public static function owner(PDO $pdo,array $c,array $state,array $metadata):?array {
  if($state['stripe_subscription_id']!==''&&($r=self::rowBy($pdo,'stripe_subscription_id',$state['stripe_subscription_id'])))return $r;
  if($state['stripe_customer_id']!==null&&($r=self::rowBy($pdo,'stripe_customer_id',$state['stripe_customer_id'])))return $r;
  $uid=$metadata['matbravo_user_id']??null;if(!is_string($uid)||!preg_match('/^[A-Za-z0-9_-]{1,40}$/D',$uid))return null;
  $r=self::rowBy($pdo,'user_id',$uid);
  if(!$r){$u=Accounts::find($pdo,$uid);if(!$u)return null;$r=self::ensureRow($pdo,$u);}
  return $r['stripe_customer_id']===null||!self::sameMode($r,$c)||$r['stripe_customer_id']===$state['stripe_customer_id']?$r:null;
 }
 /** The billing row of an account, created when missing: staff keep their free default (§3.2), members start unpaid. */
 public static function ensureRow(PDO $pdo,array $u):array {
  $staff=in_array($u['role'],['admin','editor','club'],true);$now=time();
  $pdo->prepare('INSERT IGNORE INTO billing_accounts (user_id,billing_exempt,exempt_reason,exempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?)')
   ->execute([$u['id'],$staff?1:0,$staff?'staff-default':null,$staff?$now:null,$now,$now]);
  return self::rowBy($pdo,'user_id',$u['id'])??throw new \RuntimeException('Cannot create the billing row.');
 }
 /**
  * Writes a fetched subscription (with latest_invoice expanded when possible) to its owner row. $known maps subscription
  * ids to objects already fetched (the customer's list), so the precedence check needs no extra call. Returns an outcome
  * code: updated, unchanged, ignored, orphan, tombstone, other-mode or stale.
  */
 public static function apply(PDO $pdo,array $c,StripeClient $client,array $sub,string $actor,int $started,array $opts=[]):string {
  $keys=self::priceKeys($c);$state=self::stateFromSubscription($sub,$keys);$meta=is_array($sub['metadata']??null)?$sub['metadata']:[];
  if($state['stripe_subscription_id']===''||!preg_match('/^sub_[A-Za-z0-9_]{1,250}$/D',$state['stripe_subscription_id']))return 'ignored';
  if(($state['livemode']===1)!==self::live($c))return 'other-mode';
  $row=$opts['row']??self::owner($pdo,$c,$state,$meta);
  // No row takes it (e.g. a subscription on a customer the account no longer uses): the audit names the account when it
  // can, so the Admin sees it in admin-billing?userId= (the person may be charged without access).
  if(!$row){self::audit($pdo,self::formerOwner($pdo,$state,$meta),$actor,'orphan',null,$state['sub_status'],$state['stripe_subscription_id'].' '.($state['stripe_customer_id']??'-'));return 'orphan';}
  if($row['deleted_at']!==null){self::audit($pdo,$row['user_id'],$actor,'tombstone',null,$state['sub_status'],$state['stripe_subscription_id']);return 'tombstone';}
  $cur=self::sameMode($row,$c)?$row['stripe_subscription_id']:null;$curStatus=self::rowStatus($row,$c);
  if($cur!==null&&$cur!==$state['stripe_subscription_id']&&$curStatus!=='none'){
   $inOngoing=in_array($state['sub_status'],self::ONGOING,true);$replace=null;
   if($inOngoing!==in_array($curStatus,self::ONGOING,true))$replace=$inOngoing;
   else{
    // Same class: the created time of the current subscription decides (fetched fresh unless already known).
    $curSub=$opts['known'][$cur]??null;
    if($curSub===null){try{$curSub=$client->get('/v1/subscriptions/'.$cur,['expand'=>['latest_invoice']]);}catch(StripeError $e){if(!$e->missing())throw $e;}}
    if(!is_array($curSub))$replace=true;
    else{$curState=self::stateFromSubscription($curSub,$keys);
     if(in_array($curState['sub_status'],self::ONGOING,true)&&in_array($state['sub_status'],self::ONGOING,true))self::multiple($pdo,$row['user_id'],$actor,[$cur,$state['stripe_subscription_id']]);
     $replace=self::prefer($curState['sub_status'],$curState['created'],$state['sub_status'],$state['created']);
     if(!$replace){self::audit($pdo,$row['user_id'],$actor,'sub.ignored',$curState['sub_status'],$state['sub_status'],$state['stripe_subscription_id'].' kept '.$cur);
      $state=$curState;$opts['clearPending']=false;}// keep the current subscription, refreshed
    }
   }
   if($replace===false&&$state['stripe_subscription_id']!==$cur){self::audit($pdo,$row['user_id'],$actor,'sub.ignored',$curStatus,$state['sub_status'],$state['stripe_subscription_id'].' kept '.$cur);return 'ignored';}
   if($replace)self::audit($pdo,$row['user_id'],$actor,'sub.replace',$curStatus,$state['sub_status'],$cur.' -> '.$state['stripe_subscription_id']);
  }
  return self::write($pdo,$c,$row,$state,$actor,$started,!empty($opts['clearPending'])||in_array($state['sub_status'],self::ONGOING,true));
 }
 /** Guarded write of a subscription state (last_synced_at <= fetch start, row still on the subscription decided against). */
 private static function write(PDO $pdo,array $c,array $row,array $s,string $actor,int $started,bool $clearPending):string {
  $now=time();$pending=$clearPending?null:$row['pending_checkout_id'];$pendingExp=$clearPending?null:$row['pending_checkout_expires'];
  $next=self::nextSyncAt($s+['pending_checkout_id'=>$pending,'pending_checkout_expires'=>$pendingExp],$now,(int)$c['billing_sync_min_interval']);
  $customer=$s['stripe_customer_id']??$row['stripe_customer_id'];$was=self::sameMode($row,$c)?$row['stripe_subscription_id']:null;
  $q=$pdo->prepare('UPDATE billing_accounts SET stripe_subscription_id=?,sub_status=?,price_lookup_key=?,currency=COALESCE(?,currency),current_period_start=?,current_period_end=?,cancel_at_period_end=?,cancel_at=?,canceled_at=?,ended_at=?,latest_invoice_status=?,livemode=?,stripe_customer_id=?,
   pending_checkout_id=?,pending_checkout_expires=?,last_synced_at=?,next_sync_at=?,sync_error=NULL,updated_at=? WHERE user_id=? AND deleted_at IS NULL AND last_synced_at<=? AND stripe_subscription_id <=> ? AND livemode=?');
  $q->execute([$s['stripe_subscription_id'],$s['sub_status'],$s['price_lookup_key'],$s['currency'],$s['current_period_start'],$s['current_period_end'],$s['cancel_at_period_end'],$s['cancel_at'],$s['canceled_at'],$s['ended_at'],$s['latest_invoice_status'],$s['livemode'],$customer,
   $pending,$pendingExp,$started,$next,$now,$row['user_id'],$started,$row['stripe_subscription_id'],(int)$row['livemode']]);
  if($q->rowCount()!==1){
   $fresh=self::rowBy($pdo,'user_id',$row['user_id']);
   return $fresh&&$fresh['stripe_subscription_id']===$s['stripe_subscription_id']&&$fresh['sub_status']===$s['sub_status']&&(int)$fresh['last_synced_at']<=$started?'unchanged':'stale';
  }
  $old=self::rowStatus($row,$c);if($was!==$s['stripe_subscription_id'])$old=$was===null?'none':$old;
  if($old!==$s['sub_status'])self::audit($pdo,$row['user_id'],$actor,'status.change',$old,$s['sub_status'],$s['stripe_subscription_id']);
  return 'updated';
 }
 /**
  * A Checkout Session (expanded subscription and subscription.latest_invoice): complete → its subscription is written to
  * the row of client_reference_id when the customer matches, and the pending checkout is cleared; expired → the pending
  * checkout is cleared. $userId (confirm) restricts it to that account; other mismatches are audited as orphans.
  */
 public static function applySession(PDO $pdo,array $c,StripeClient $client,array $s,string $actor,int $started,?string $userId=null):string {
  $sid=(string)($s['id']??'');$uid=$s['client_reference_id']??null;$customer=self::ref($s['customer']??null);
  $row=is_string($uid)&&preg_match('/^[A-Za-z0-9_-]{1,40}$/D',$uid)?self::rowBy($pdo,'user_id',$uid):null;
  if($userId!==null&&$uid!==$userId)return 'foreign';
  if(!$row||$customer===null||$row['stripe_customer_id']!==$customer||($s['mode']??null)!=='subscription'||!self::sameMode($row,$c)){
   if($userId===null)self::audit($pdo,is_string($uid)?mb_substr($uid,0,40):null,$actor,'orphan',null,null,'session '.$sid);return 'foreign';
  }
  $status=$s['status']??null;
  if($status==='expired'){self::clearPending($pdo,$row['user_id'],$sid);return 'expired';}
  if($status!=='complete')return 'open';
  $sub=is_array($s['subscription']??null)?$s['subscription']:null;
  if(!$sub&&($id=self::ref($s['subscription']??null)))$sub=$client->get('/v1/subscriptions/'.$id,['expand'=>['latest_invoice']]);
  if(!$sub)return 'open';
  return self::apply($pdo,$c,$client,$sub,$actor,$started,['row'=>$row,'clearPending'=>true]);
 }
 private static function clearPending(PDO $pdo,string $userId,string $sessionId):void {
  $pdo->prepare('UPDATE billing_accounts SET pending_checkout_id=NULL,pending_checkout_expires=NULL,next_sync_at=IF(sub_status IN (\'none\',\'canceled\',\'incomplete_expired\',\'unpaid\'),NULL,next_sync_at),updated_at=? WHERE user_id=? AND pending_checkout_id=?')->execute([time(),$userId,$sessionId]);
 }
 /** The customer was deleted in Stripe: the row forgets customer and subscription (tombstones only note it). */
 public static function customerGone(PDO $pdo,string $customerId,string $actor):string {
  $row=self::rowBy($pdo,'stripe_customer_id',$customerId);if(!$row)return 'orphan';
  if($row['deleted_at']!==null){$pdo->prepare('UPDATE billing_accounts SET stripe_redact_pending=0,updated_at=? WHERE user_id=?')->execute([time(),$row['user_id']]);self::audit($pdo,$row['user_id'],$actor,'tombstone',null,null,'customer.deleted '.$customerId);return 'tombstone';}
  $pdo->prepare("UPDATE billing_accounts SET stripe_customer_id=NULL,stripe_subscription_id=NULL,sub_status='none',price_lookup_key=NULL,current_period_start=NULL,current_period_end=NULL,cancel_at_period_end=0,cancel_at=NULL,canceled_at=NULL,ended_at=NULL,latest_invoice_status=NULL,pending_checkout_id=NULL,pending_checkout_expires=NULL,next_sync_at=NULL,stripe_redact_pending=0,updated_at=? WHERE user_id=? AND stripe_customer_id=?")->execute([time(),$row['user_id'],$customerId]);
  self::audit($pdo,$row['user_id'],$actor,'customer.deleted',(string)$row['sub_status'],'none',$customerId);
  return 'updated';
 }
 /**
  * Report 03 §5.3 guard 4: the customer has more than one ongoing subscription, so the person may be charged twice (the
  * row keeps only the best one). billing_audit 'sub.multiple' with the ids, shown in admin-billing?userId=; written once
  * per set of ids, not on every sync.
  */
 private static function multiple(PDO $pdo,string $userId,string $actor,array $ids):void {
  $ids=array_values(array_unique($ids));sort($ids);$detail=mb_substr(implode(' ',$ids),0,500);
  $q=$pdo->prepare("SELECT detail FROM billing_audit WHERE user_id=? AND action='sub.multiple' ORDER BY id DESC LIMIT 1");$q->execute([$userId]);$last=$q->fetchColumn();$q->closeCursor();
  if($last!==$detail)self::audit($pdo,$userId,$actor,'sub.multiple',null,null,$detail);
 }

 // ---- per-account sync -------------------------------------------------------------------------------------------
 /**
  * Forced sync of one account for other slices (account deletion, §3.8): interactive client, claims the row, and never
  * throws for Stripe failures (they are recorded in sync_error and retried later). Returns the billing row afterwards.
  */
 public static function sync(PDO $pdo,array $c,string $userId):?array {
  if(empty($c['billing_enabled']))return Access::row($pdo,$userId);
  try{self::syncUser($pdo,$c,$userId,StripeClient::interactive($c),'system');}catch(StripeError){}
  return Access::row($pdo,$userId);
 }
 /**
  * One account against Stripe (one list call with the customer expanded, plus a customer read when there is no
  * subscription and an e-mail update when it differs). Returns {outcome,row,customer?}: customer is the Stripe Customer
  * just read (Billing::checkout compares its currency); outcome busy = another sync holds the claim. Stripe errors are
  * recorded (sync_error, next_sync_at in 15 min) and rethrown.
  */
 public static function syncUser(PDO $pdo,array $c,string $userId,StripeClient $client,string $actor,bool $claim=true):array {
  $row=Access::row($pdo,$userId);$now=time();
  if(!$row||$row['deleted_at']!==null||$row['stripe_customer_id']===null)return ['outcome'=>'none','row'=>$row];
  if(!self::sameMode($row,$c)){
   if($row['next_sync_at']!==null)$pdo->prepare('UPDATE billing_accounts SET next_sync_at=NULL WHERE user_id=?')->execute([$userId]);
   return ['outcome'=>'other-mode','row'=>$row];
  }
  if($claim){$q=$pdo->prepare('UPDATE billing_accounts SET sync_claimed_at=? WHERE user_id=? AND sync_claimed_at<?');$q->execute([$now,$userId,$now-self::LEASE]);if($q->rowCount()!==1)return ['outcome'=>'busy','row'=>$row];}
  $cus=$row['stripe_customer_id'];
  try{
   $started=time();[$subs,$customer]=self::fetchCustomer($client,$cus);
   if(!empty($customer['deleted'])){self::customerGone($pdo,$cus,$actor);return ['outcome'=>'customer-deleted','row'=>Access::row($pdo,$userId)];}
   $keys=self::priceKeys($c);$states=[];foreach($subs as $s)$states[]=self::stateFromSubscription($s,$keys);
   $best=self::best($states);$min=(int)$c['billing_sync_min_interval'];
   if($best)$outcome=self::apply($pdo,$c,$client,$subs[$best['stripe_subscription_id']],$actor,$started,['row'=>$row,'known'=>$subs]);
   else{
    // No subscription: an expired pending checkout is cleared; only the bookkeeping changes.
    $pending=$row['pending_checkout_id']!==null&&(int)$row['pending_checkout_expires']>$now;
    $next=self::nextSyncAt(['sub_status'=>self::rowStatus($row,$c),'pending_checkout_id'=>$pending?$row['pending_checkout_id']:null,'pending_checkout_expires'=>$row['pending_checkout_expires']]+$row,$now,$min);
    $pdo->prepare('UPDATE billing_accounts SET pending_checkout_id=IF(?,pending_checkout_id,NULL),pending_checkout_expires=IF(?,pending_checkout_expires,NULL),last_synced_at=?,next_sync_at=?,sync_error=NULL,updated_at=? WHERE user_id=? AND last_synced_at<=?')
     ->execute([(int)$pending,(int)$pending,$started,$next,$now,$userId,$started]);
    $outcome='unchanged';
   }
   // Nothing written (an ignored, orphaned or stale result): still move a due next_sync_at on, so billing-due does not
   // pick the same account again and again.
   if(!in_array($outcome,['updated','unchanged'],true)){$f=Access::row($pdo,$userId);if($f)$pdo->prepare('UPDATE billing_accounts SET next_sync_at=? WHERE user_id=? AND next_sync_at<=?')->execute([self::nextSyncAt($f,$now,$min),$userId,$now]);}
   $on=self::ongoingIds($c,$subs);if(count($on)>1)self::multiple($pdo,$userId,$actor,$on);
   // The Stripe customer's e-mail follows the account (§3.9): receipts and payment reminders must reach the person. A
   // failure does not undo the sync; it is recorded and retried in 15 minutes.
   $u=Accounts::find($pdo,$userId);
   if($u&&is_string($customer['email']??null)&&mb_strtolower($customer['email'])!==mb_strtolower($u['email'])){
    try{$client->post('/v1/customers/'.$cus,['email'=>$u['email']]);self::audit($pdo,$userId,$actor,'customer.email',null,null,$cus);}
    catch(StripeError $e){$pdo->prepare('UPDATE billing_accounts SET sync_error=?,next_sync_at=? WHERE user_id=?')->execute([substr($e->code(),0,200),time()+self::RETRY_AFTER_ERROR,$userId]);}
   }
   return ['outcome'=>$outcome,'row'=>Access::row($pdo,$userId),'customer'=>$customer];
  }catch(StripeError $e){
   $pdo->prepare('UPDATE billing_accounts SET sync_error=?,next_sync_at=?,updated_at=? WHERE user_id=?')->execute([substr($e->code(),0,200),time()+self::RETRY_AFTER_ERROR,time(),$userId]);
   throw $e;
  }finally{
   if($claim)$pdo->prepare('UPDATE billing_accounts SET sync_claimed_at=0 WHERE user_id=? AND sync_claimed_at=?')->execute([$userId,$now]);
  }
 }
 /**
  * Stripe's view of one customer, read only: [subscriptions (id → object, latest_invoice and customer expanded; one list
  * call), Customer] where the Customer comes from that list, else from its own read ({deleted:true} when Stripe answers
  * that it is deleted or does not know it). syncUser() writes from it; Billing::checkout reads it while another sync
  * holds the claim.
  */
 public static function fetchCustomer(StripeClient $client,string $cus):array {
  $list=$client->get('/v1/subscriptions',['customer'=>$cus,'status'=>'all','limit'=>20,'expand'=>['data.latest_invoice','data.customer']]);
  $subs=[];$customer=null;
  foreach(is_array($list['data']??null)?$list['data']:[] as $s)if(is_array($s)&&is_string($s['id']??null)&&self::ref($s['customer']??null)===$cus){$subs[$s['id']]=$s;if(is_array($s['customer']))$customer=$s['customer'];}
  if($customer===null){try{$customer=$client->get('/v1/customers/'.$cus);}catch(StripeError $e){if(!$e->missing())throw $e;$customer=['deleted'=>true];}}
  return [$subs,$customer];
 }
 /** Ids of our ongoing subscriptions (ONGOING; a subscription of another product is 'foreign') among fetched objects. */
 public static function ongoingIds(array $c,array $subs):array {
  $keys=self::priceKeys($c);$on=[];
  foreach($subs as $s){$st=self::stateFromSubscription($s,$keys);if(in_array($st['sub_status'],self::ONGOING,true))$on[]=$st['stripe_subscription_id'];}
  return $on;
 }
 /**
  * Lazy sync of the signed-in account after the response of me (§6.3 point 3; called through Jobs::afterSent, so only
  * once the response was sent). Releases the session first, honours the circuit breaker, next_sync_at and
  * billing_sync_min_interval, and uses the background client. Never throws for Stripe failures.
  */
 public static function lazy(PDO $pdo,array $c,string $userId):void {
  if(session_status()===PHP_SESSION_ACTIVE)session_write_close();
  if(empty($c['billing_enabled'])||StripeClient::downFor($pdo)>0)return;
  $row=Access::row($pdo,$userId);$now=time();
  if(!$row||$row['next_sync_at']===null||(int)$row['next_sync_at']>$now||$now-(int)$row['last_synced_at']<(int)$c['billing_sync_min_interval'])return;
  try{self::syncUser($pdo,$c,$userId,StripeClient::background($pdo,$c),'system');}catch(StripeError){}
 }

 // ---- events -----------------------------------------------------------------------------------------------------
 /**
  * One Stripe event, from the webhook or the /v1/events pull (§6.3–§6.4), at most once: stripe_events is shared by
  * both sources. A processed duplicate returns 'duplicate' at once; an earlier failed attempt is retried (attempts+1).
  * The payload only names the object; it is fetched again in the pinned version. Unknown types are recorded and
  * acknowledged. A failure stores a short code (no personal data) and is rethrown (the webhook answers 500).
  * $memo (pull only, one page): objects already fetched in this page; a later event about one of them is answered
  * 'deduped' without another fetch (every event of a page was created before the page was read, so before that fetch).
  */
 public static function handleEvent(PDO $pdo,array $c,StripeClient $client,array $event,string $source,?array &$memo=null):string {
  $id=(string)$event['id'];$now=time();
  $ins=$pdo->prepare('INSERT IGNORE INTO stripe_events (event_id,type,livemode,source,received_at) VALUES (?,?,?,?,?)');
  $ins->execute([$id,substr((string)$event['type'],0,100),(int)!empty($event['livemode']),$source==='webhook'?'webhook':'pull',$now]);
  if($ins->rowCount()!==1){
   $q=$pdo->prepare('SELECT processed_at FROM stripe_events WHERE event_id=?');$q->execute([$id]);$done=$q->fetchColumn();$q->closeCursor();
   if($done!==null&&$done!==false)return 'duplicate';
   $pdo->prepare('UPDATE stripe_events SET attempts=attempts+1 WHERE event_id=?')->execute([$id]);
  }
  try{$out=self::process($pdo,$c,$client,$event,$source==='webhook'?'stripe':'cron',$memo);}
  catch(\Throwable $e){
   $code=$e instanceof StripeError?$e->code():get_class($e);
   $pdo->prepare('UPDATE stripe_events SET error=? WHERE event_id=?')->execute([mb_substr($code,0,200),$id]);
   throw $e;
  }
  $pdo->prepare('UPDATE stripe_events SET processed_at=?,error=NULL WHERE event_id=?')->execute([time(),$id]);
  return $out;
 }
 private static function process(PDO $pdo,array $c,StripeClient $client,array $e,string $actor,?array &$memo):string {
  $type=(string)$e['type'];$o=$e['data']['object'];$oid=self::ref($o['id']??null);$started=time();
  // A subscription fetched again and applied (memo key sub:<id>); missing in Stripe counts as done too.
  $sub=function(string $sid)use($pdo,$c,$client,$actor,$started,&$memo):string{
   if(isset($memo['sub:'.$sid]))return 'deduped';
   try{$s=$client->get('/v1/subscriptions/'.$sid,['expand'=>['latest_invoice']]);}catch(StripeError $x){if(!$x->missing())throw $x;$memo['sub:'.$sid]=1;return 'missing';}
   $out=self::apply($pdo,$c,$client,$s,$actor,$started);$memo['sub:'.$sid]=1;return $out;
  };
  switch(true){
   case in_array($type,['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'],true):
    if(!$oid||!preg_match('/^cs_(test|live)_[A-Za-z0-9]{10,250}$/D',$oid))return 'ignored';
    if($type==='checkout.session.expired'){$r=self::rowBy($pdo,'pending_checkout_id',$oid);if($r)self::clearPending($pdo,$r['user_id'],$oid);return $r?'expired':'ignored';}
    if(isset($memo['cs:'.$oid]))return 'deduped';
    $s=$client->get('/v1/checkout/sessions/'.$oid,['expand'=>['subscription','subscription.latest_invoice']]);
    $out=self::applySession($pdo,$c,$client,$s,$actor,$started);$memo['cs:'.$oid]=1;
    // The session's subscription was applied with it (not for a foreign, open or expired session).
    if(!in_array($out,['foreign','open','expired'],true)&&($sid=self::ref($s['subscription']??null)))$memo['sub:'.$sid]=1;
    return $out;
   case str_starts_with($type,'customer.subscription.'):
    return $oid&&str_starts_with($oid,'sub_')?$sub($oid):'ignored';
   case str_starts_with($type,'invoice.'):
    if($sid=self::invoiceSubscription($o))return $sub($sid);
    $cus=self::ref($o['customer']??null);$r=$cus?self::rowBy($pdo,'stripe_customer_id',$cus):null;
    if(!$r||$r['deleted_at']!==null)return 'ignored';
    if(isset($memo['user:'.$r['user_id']]))return 'deduped';
    $out=self::syncUser($pdo,$c,$r['user_id'],$client,$actor)['outcome'];if($out!=='busy')$memo['user:'.$r['user_id']]=1;
    return $out;
   case $type==='customer.deleted':
    return $oid?self::customerGone($pdo,$oid,$actor):'ignored';
   case in_array($type,self::AUDIT_TYPES,true):
    $cus=self::ref($o['customer']??null);$r=$cus?self::rowBy($pdo,'stripe_customer_id',$cus):null;
    self::audit($pdo,$r['user_id']??null,$actor,$type==='charge.refunded'?'charge.refunded':'charge.dispute',null,null,($oid??'-').' '.($cus??'-'));
    return 'audited';
  }
  return 'ignored';
 }
 /**
  * Pull of /v1/events ("webhooks by polling", §6.3). The cursor in billing_kv (events_cursor:<mode>) is the last event
  * handled, {created,id}, and the pull walks forward from it: GET /v1/events?ending_before=<id> answers the $limit events
  * directly after the cursor (Stripe lists newest first, so a page is handled from its end), the next page starts after
  * the newest event of the page, and the cursor moves event by event. A run may therefore stop anywhere (time budget,
  * failure, $maxPages) and the next run continues exactly there; nothing between two runs is skipped.
  * After a complete forward pass, lateEvents() reads the 120 s before the cursor once more (report 03 §8.5 margin).
  * Without a cursor (first run) or when Stripe no longer knows the cursor event (older than 30 days), the window from the
  * cursor time minus 120 s (or the last 24 h) is read newest first with starting_after, up to $maxPages pages, and
  * handled oldest first; anything older than what was read is left to the due syncs and reconcile (complete=no).
  * Failures: Stripe unavailable, 401/403 (key or permission), 409 and 429 stop the run before the event, which the next
  * run starts with; any other Stripe refusal, or another error at its EVENT_ATTEMPTS-th attempt, marks the event done with
  * its error (billing_audit 'event.skipped') and the pull goes on, so one bad event never blocks the ones after it.
  * $budget (seconds, 0 = none): no further event or page is started after that much time, at least one event per run.
  * Returns counts (events: read forward or in the window; late: found behind the cursor, also counted as handled);
  * complete=yes when everything up to now was handled.
  */
 public static function pullEvents(PDO $pdo,array $c,StripeClient $client,int $maxPages=1,bool $dry=false,int $limit=100,float $budget=0.0):array {
  $key='events_cursor:'.(self::live($c)?'live':'test');$saved=json_decode((string)self::kv($pdo,$key),true);$t0=hrtime(true);
  $saved=is_array($saved)&&is_int($saved['created']??null)?$saved:null;$cursor=$saved;
  $n=['events'=>0,'processed'=>0,'deduped'=>0,'duplicates'=>0,'skipped'=>0,'failed'=>0,'late'=>0,'complete'=>false];
  $q=['types'=>self::EVENT_TYPES,'limit'=>max(1,min(100,$limit))];$over=fn():bool=>$budget>0&&(hrtime(true)-$t0)/1e9>=$budget;
  $rows=fn(array $r):array=>array_values(array_filter(is_array($r['data']??null)?$r['data']:[],'is_array'));
  try{
   $before=is_string($saved['id']??null)&&preg_match('/^evt_[A-Za-z0-9]{1,250}$/D',$saved['id'])?$saved['id']:null;
   for($page=0;$before!==null&&$page<$maxPages;$page++){
    if($page>0&&$over())return $n;
    try{$r=$client->get('/v1/events',$q+['ending_before'=>$before]);}
    catch(StripeError $x){if($page===0&&!$x->unavailable()&&in_array($x->status,[400,404],true)){$before=null;break;}throw $x;}
    $data=$rows($r);$events=array_reverse(array_values(array_filter($data,fn($e)=>self::validEvent($e,$c))));$n['events']+=count($events);
    if(!self::pullBatch($pdo,$c,$client,$events,$dry,$n,$cursor,$over))return $n;
    // The whole page is handled: the cursor passes its newest entry (also one that failed validEvent).
    if(is_string($data[0]['id']??null)){$before=$data[0]['id'];if(!$dry&&is_int($data[0]['created']??null))$cursor=['created'=>$data[0]['created'],'id'=>$before];}
    if(!$data||empty($r['has_more'])){$n['complete']=$dry||self::lateEvents($pdo,$c,$client,$q,$cursor,$n,$over);return $n;}
   }
   if($before!==null)return $n;
   $since=$saved?$saved['created']-120:time()-86400;$all=[];$after=null;$read=false;
   for($page=0;$page<$maxPages;$page++){
    $r=$client->get('/v1/events',$q+['created'=>['gte'=>$since]]+($after?['starting_after'=>$after]:[]));
    $data=$rows($r);foreach($data as $e)if(self::validEvent($e,$c))$all[]=$e;
    $last=end($data);$after=is_array($last)&&is_string($last['id']??null)?$last['id']:null;
    if(empty($r['has_more'])||!$after){$read=true;break;}
   }
   $all=array_reverse($all);$n['events']+=count($all);
   $n['complete']=self::pullBatch($pdo,$c,$client,$all,$dry,$n,$cursor,$over)&&$read;
   return $n;
  }finally{if(!$dry&&$cursor!==null&&$cursor!==$saved)self::kvSet($pdo,$key,json_encode($cursor,JSON_THROW_ON_ERROR));}
 }
 /**
  * Report 03 §8.5 margin after a complete forward pass: ending_before only returns events listed after the cursor event,
  * so an event created before it (or in the same second) that shows up in Stripe's list later would never be read. The
  * 120 s up to the cursor time (created[gte] and [lte]) are read again, newest first in pages of 100 (at most
  * LATE_PAGES, none after the budget); the events stripe_events has not processed are handled oldest first ($n['late'])
  * and the cursor stays where it is. Usually one GET per complete run; anything older is left to the due syncs and
  * reconcile. Returns false when a late event has to be retried (the run is not complete).
  */
 private static function lateEvents(PDO $pdo,array $c,StripeClient $client,array $q,?array $cursor,array &$n,\Closure $over):bool {
  if($cursor===null)return true;
  $all=[];$after=null;$at=$cursor['created'];
  for($page=0;$page<self::LATE_PAGES&&!$over();$page++){
   $r=$client->get('/v1/events',['limit'=>100]+$q+['created'=>['gte'=>$at-120,'lte'=>$at]]+($after?['starting_after'=>$after]:[]));
   $data=array_values(array_filter(is_array($r['data']??null)?$r['data']:[],'is_array'));
   foreach($data as $e)if(self::validEvent($e,$c)&&is_int($e['created']??null)&&$e['created']<=$at)$all[]=$e;
   $last=end($data);$after=is_array($last)&&is_string($last['id']??null)?$last['id']:null;if(empty($r['has_more'])||!$after)break;
  }
  if(!$all)return true;
  $s=$pdo->prepare('SELECT event_id FROM stripe_events WHERE processed_at IS NOT NULL AND event_id IN ('.implode(',',array_fill(0,count($all),'?')).')');$s->execute(array_column($all,'id'));
  $done=array_flip($s->fetchAll(PDO::FETCH_COLUMN));$late=array_reverse(array_values(array_filter($all,fn($e)=>!isset($done[$e['id']]))));
  $n['late']+=count($late);$stay=$cursor;
  return self::pullBatch($pdo,$c,$client,$late,false,$n,$stay,$over);
 }
 /** Events of one read (oldest first) through handleEvent('pull'); moves $cursor past each one handled; false = stop the run. */
 private static function pullBatch(PDO $pdo,array $c,StripeClient $client,array $events,bool $dry,array &$n,?array &$cursor,\Closure $over):bool {
  if($dry){$q=$pdo->prepare('SELECT 1 FROM stripe_events WHERE event_id=? AND processed_at IS NOT NULL');foreach($events as $e){$q->execute([$e['id']]);if($q->fetchColumn())$n['duplicates']++;$q->closeCursor();}return true;}
  $memo=[];
  foreach($events as $e){
   if($n['processed']+$n['deduped']+$n['duplicates']+$n['skipped']>0&&$over())return false;
   try{$out=self::handleEvent($pdo,$c,$client,$e,'pull',$memo);$n[$out==='duplicate'?'duplicates':($out==='deduped'?'deduped':'processed')]++;}
   catch(\Throwable $x){
    $stripe=$x instanceof StripeError;if(!$stripe)Routes::logThrowable($x,'MatDraw stripe event');
    $retry=$stripe?$x->unavailable()||in_array($x->status,[401,403,409,429],true):self::attempts($pdo,(string)$e['id'])<self::EVENT_ATTEMPTS;
    if($retry){$n['failed']++;return false;}
    self::skipEvent($pdo,$e,$stripe?$x->code():get_class($x));$n['skipped']++;
   }
   $cursor=['created'=>(int)$e['created'],'id'=>(string)$e['id']];
  }
  return true;
 }
 private static function attempts(PDO $pdo,string $id):int{$q=$pdo->prepare('SELECT attempts FROM stripe_events WHERE event_id=?');$q->execute([$id]);$v=$q->fetchColumn();$q->closeCursor();return (int)$v;}
 /** An event that cannot succeed is given up: done with its error, billing_audit 'event.skipped' (ids and the code only). */
 private static function skipEvent(PDO $pdo,array $e,string $code):void {
  $pdo->prepare('UPDATE stripe_events SET processed_at=?,error=? WHERE event_id=?')->execute([time(),mb_substr('skipped: '.$code,0,200),(string)$e['id']]);
  self::audit($pdo,null,'cron','event.skipped',null,null,$e['id'].' '.$e['type'].' '.$code);
  error_log('MatDraw stripe: event '.$e['id'].' skipped ('.$code.')');
 }
 /** Prunes stripe_events older than 90 days (§10 retention); returns the number deleted. */
 public static function prune(PDO $pdo,?int $now=null):int{$q=$pdo->prepare('DELETE FROM stripe_events WHERE received_at<?');$q->execute([($now??time())-self::EVENTS_KEEP]);return $q->rowCount();}
 /**
  * Nightly full scan (03 §8.5, §6.3): every subscription of this mode, grouped by customer, and only the best one of each
  * customer is applied (so an old canceled subscription listed after a new active one cannot cut access).
  */
 public static function reconcile(PDO $pdo,array $c,StripeClient $client,string $actor='cli',bool $dry=false,int $maxPages=100):array {
  $started=time();$all=[];$after=null;
  for($page=0;$page<$maxPages;$page++){
   $r=$client->get('/v1/subscriptions',['status'=>'all','limit'=>100,'expand'=>['data.latest_invoice']]+($after?['starting_after'=>$after]:[]));
   $data=is_array($r['data']??null)?$r['data']:[];foreach($data as $s)if(is_array($s)&&is_string($s['id']??null))$all[$s['id']]=$s;
   $last=end($data);$after=is_array($last)?($last['id']??null):null;if(empty($r['has_more'])||!$after)break;
  }
  $keys=self::priceKeys($c);$groups=[];
  foreach($all as $id=>$s){$cus=self::ref($s['customer']??null)??'-';$groups[$cus][$id]=$s;}
  $n=['subscriptions'=>count($all),'customers'=>count($groups),'updated'=>0,'unchanged'=>0,'ignored'=>0,'orphan'=>0,'other'=>0];
  foreach($groups as $subs){
   $best=self::best(array_map(fn($s)=>self::stateFromSubscription($s,$keys),array_values($subs)));if(!$best)continue;
   if($dry){$n['unchanged']++;continue;}
   $out=self::apply($pdo,$c,$client,$subs[$best['stripe_subscription_id']],$actor,$started,['known'=>$subs]);
   $k=in_array($out,['updated','unchanged','ignored','orphan'],true)?$out:'other';$n[$k]++;
  }
  return $n;
 }
 /**
  * Accounts whose next_sync_at passed (this mode, oldest first) and retries of Stripe customer deletions
  * (stripe_redact_pending, also on tombstones: the current customer and every remembered one of this mode not yet
  * deleted, billing_customers), $limit accounts in all. Deletions come first but take at most half of
  * the slots (at least one), so due syncs always get their share; a refused deletion goes to the back of the queue and
  * waits REDACT_BACKOFF (sync_error 'redact …', updated_at). Stops at the first unavailable error, and with $budget
  * (seconds, 0 = none) starts no further account after that much time (at least one per run).
  */
 public static function due(PDO $pdo,array $c,StripeClient $client,int $limit,?int $now=null,string $actor='cron',int $pauseMs=0,float $budget=0.0):array {
  $now??=time();$t0=hrtime(true);$n=['synced'=>0,'busy'=>0,'failed'=>0,'redacted'=>0,'redactFailed'=>0];$live=(int)self::live($c);$done=0;
  $over=function()use(&$done,$budget,$t0):bool{return $budget>0&&$done>0&&(hrtime(true)-$t0)/1e9>=$budget;};
  $q=$pdo->prepare("SELECT user_id,stripe_customer_id FROM billing_accounts WHERE stripe_redact_pending=1 AND livemode=? AND (sync_error IS NULL OR sync_error NOT LIKE 'redact %' OR updated_at<=?) ORDER BY updated_at LIMIT ".max(1,intdiv($limit,2)));
  $q->execute([$live,$now-self::REDACT_BACKOFF]);
  foreach($q->fetchAll(PDO::FETCH_ASSOC) as $r){
   if($over())return $n;$done++;$limit--;
   // The current customer may predate the list (an older release): remembered first; one already deleted stays out.
   if($r['stripe_customer_id']!==null)self::remember($pdo,$r['user_id'],$r['stripe_customer_id'],$live);
   $ids=array_keys(array_filter(self::customersOf($pdo,$r['user_id']),fn($m)=>$m===$live));
   foreach($ids as $i=>$cus){
    try{$client->delete('/v1/customers/'.$cus);}catch(StripeError $e){if(!$e->missing()){$n['redactFailed']++;if($e->unavailable())return $n;
     $pdo->prepare('UPDATE billing_accounts SET sync_error=?,updated_at=? WHERE user_id=?')->execute([substr('redact '.$e->code(),0,200),time(),$r['user_id']]);continue 2;}}
    self::redacted($pdo,$cus);self::audit($pdo,$r['user_id'],$actor,'customer.redact',null,null,$cus);
   }
   $pdo->prepare('UPDATE billing_accounts SET stripe_redact_pending=0,sync_error=NULL,updated_at=? WHERE user_id=?')->execute([time(),$r['user_id']]);
   $n['redacted']++;
   if($pauseMs)usleep($pauseMs*1000);
  }
  if($limit<=0)return $n;
  $q=$pdo->prepare('SELECT user_id FROM billing_accounts WHERE next_sync_at IS NOT NULL AND next_sync_at<=? AND livemode=? AND deleted_at IS NULL AND stripe_customer_id IS NOT NULL ORDER BY next_sync_at LIMIT '.max(1,$limit));
  $q->execute([$now,$live]);
  foreach($q->fetchAll(PDO::FETCH_COLUMN) as $uid){
   if($over())break;$done++;
   try{$out=self::syncUser($pdo,$c,(string)$uid,$client,$actor)['outcome'];$out==='busy'?$n['busy']++:$n['synced']++;}
   catch(StripeError $e){$n['failed']++;if($e->unavailable())break;}
   if($pauseMs)usleep($pauseMs*1000);
  }
  return $n;
 }
 /** Job billing-due (every 10 min, needsFlush): up to 5 accounts within JOB_BUDGET; skipped while payments are off or Stripe is down. */
 public static function dueJob(PDO $pdo,array $c,int $now):string {
  if(empty($c['billing_enabled']))return 'billing off';if($s=StripeClient::downFor($pdo))return "stripe down {$s}s";
  try{return self::counts(self::due($pdo,$c,StripeClient::background($pdo,$c),5,$now,'cron',0,self::JOB_BUDGET));}catch(StripeError $e){return 'error '.$e->code();}
 }
 /**
  * Job billing-events (every 15 min, needsFlush): /v1/events forward from the cursor in pages of 20 (at most 5) and the
  * 120 s margin (lateEvents) within JOB_BUDGET, then stripe_events older than 90 days are pruned. The CLI
  * (stripe-sync.php --events) reads pages of 100.
  */
 public static function eventsJob(PDO $pdo,array $c,int $now):string {
  if(empty($c['billing_enabled']))return 'billing off';if($s=StripeClient::downFor($pdo))return "stripe down {$s}s";
  // A Stripe error is reported by its code only (Jobs would log the message, which may quote request values).
  try{$n=self::pullEvents($pdo,$c,StripeClient::background($pdo,$c),5,false,20,self::JOB_BUDGET);}catch(StripeError $e){$n=['error'=>$e->code()];}
  $n['pruned']=self::prune($pdo,$now);
  return self::counts($n);
 }
 public static function counts(array $n):string{$o=[];foreach($n as $k=>$v)$o[]=$k.'='.(is_bool($v)?($v?'yes':'no'):$v);return implode(' ',$o);}
}
