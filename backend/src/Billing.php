<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Payments for people and the Admin (plan §6.1–§6.2, §6.7, §3.8–§3.9): Checkout, confirm, Customer Portal, forced sync,
 * the Admin's free accounts and tools, and the Stripe side of account deletion and e-mail changes.
 *  - Amounts, currency and price ids never come from the client: the currency is that of an ongoing subscription, else an
 *    Admin override (billing_kv currency:<userId>), else the profile country (PL → pln, any other → usd); the price id is
 *    resolved from the lookup key (cached 24 h in billing_kv, refreshed once on resource_missing).
 *  - Callers release the session before any method that talks to Stripe ($ctx->releaseSession()); no Stripe call runs
 *    inside a transaction. Stripe failures surface as StripeError; routes turn them into one generic 503 (guard()).
 *  - Nothing reaches Stripe before the person starts a checkout: the Customer gets the account e-mail, the preferred
 *    language and our opaque id only (Idempotency-Key matbravo-customer-<userId>-<mode>-<seq>).
 */
final class Billing {
 /** Statuses the Admin can end at the period end (cancelAtPeriodEnd); a new checkout is refused for every ongoing one (BillingSync::ONGOING). */
 private const CANCELABLE=['active','trialing','past_due'];
 public static function enabled(array $c):bool{return !empty($c['billing_enabled']);}
 public static function live(array $c):bool{return ($c['billing_mode']??'test')==='live';}
 public static function requireEnabled(array $c):void{if(!self::enabled($c))throw new AppError('Płatności są wyłączone.',404);}
 /** Runs $fn; any Stripe failure becomes the one generic answer (the raw Stripe message is never shown). */
 public static function guard(callable $fn):mixed {
  try{return $fn();}catch(StripeError $e){header('Retry-After: 60');throw new ApiError('Płatności są chwilowo niedostępne. Spróbuj ponownie później.',503,['code'=>'stripe_unavailable']);}
 }
 private static function appUrl(array $c):string{return rtrim((string)$c['app_url'],'/');}
 private static function lang(mixed $lang,?string $country):string{return in_array($lang,['pl','en'],true)?$lang:($country==='PL'?'pl':'en');}
 private static function country(PDO $pdo,string $userId):?string {
  $q=$pdo->prepare('SELECT country FROM user_profiles WHERE user_id=?');$q->execute([$userId]);$v=$q->fetchColumn();$q->closeCursor();return is_string($v)?$v:null;
 }
 private static function sameMode(?array $row,array $c):bool{return $row!==null&&((int)$row['livemode']===1)===self::live($c);}
 /** Plan currency (§6.1): ongoing subscription, else the Admin's override, else the country rule (Access::currency). */
 public static function currencyFor(PDO $pdo,array $c,?array $row,?string $country,string $userId):?string {
  if(in_array(Access::subStatus($row,$c),BillingSync::ONGOING,true)&&($cur=Access::currency($row,$country,$c))!==null)return $cur;
  $o=BillingSync::kv($pdo,'currency:'.$userId);
  if($o!==null&&isset($c['stripe_prices'][$o]))return $o;
  return Access::currency(null,$country,$c);
 }
 /** The billing part of me (§4.3), shared by confirm, billing-sync and the Admin view. */
 public static function summary(PDO $pdo,array $c,array $u,?array $row,?string $country):array {
  if(!self::enabled($c))return ['enabled'=>false];
  $now=time();
  $exempt=$u['role']==='admin'||($row?!empty($row['billing_exempt'])&&($row['exempt_until']===null||(int)$row['exempt_until']>$now):in_array($u['role'],['editor','club'],true));
  return ['enabled'=>true,'enforce'=>!empty($c['billing_enforce']),'mode'=>$c['billing_mode'],'currency'=>self::currencyFor($pdo,$c,$row,$country,$u['id']),'amounts'=>$c['billing_amounts'],
   'exempt'=>$exempt,'hasCustomer'=>self::sameMode($row,$c)&&$row['stripe_customer_id']!==null,'pending'=>$row!==null&&$row['pending_checkout_id']!==null&&(int)$row['pending_checkout_expires']>$now];
 }
 /** {access, billing, status} after confirm or billing-sync; status is the subscription status of this mode or a session state. */
 private static function state(PDO $pdo,array $c,array $u,?string $status=null):array {
  $row=Access::row($pdo,$u['id']);
  return ['access'=>Access::compute($row,$u,$c,time()),'billing'=>self::summary($pdo,$c,$u,$row,self::country($pdo,$u['id'])),'status'=>$status??Access::subStatus($row,$c)];
 }

 // ---- Checkout --------------------------------------------------------------------------------------------------
 /**
  * billing-checkout (§6.2): 409 {portal:true} with an ongoing subscription (active, trialing, past_due and incomplete:
  * an async payment still running would charge twice next to a second subscription); 422 without a country; an open
  * session of the same currency that expires in more than 5 minutes is reused; otherwise Stripe's view of a returning
  * customer comes first (BillingSync::syncUser: one list call; while another sync holds the claim, the same read without
  * writing, BillingSync::fetchCustomer): an ongoing subscription the cache did not know yet (a stale 'incomplete', a
  * session paid in another tab) refuses the checkout, and a customer deleted in the Dashboard or whose Customer.currency
  * (fixed by its first invoice, 03 §3.3) differs from the plan currency is replaced before the session is created.
  * Then Customer (once) and a new subscription session. Returns {url} on checkout.stripe.com.
  */
 public static function checkout(PDO $pdo,array $c,array $u,mixed $lang=null):array {
  $row=Access::row($pdo,$u['id']);$now=time();
  if($row&&$row['deleted_at']!==null)throw new AppError('Brak uprawnień.',403);
  $status=Access::subStatus($row,$c);
  if($status!=='incomplete'&&in_array($status,BillingSync::ONGOING,true))self::locked();
  $country=self::country($pdo,$u['id']);$currency=self::currencyFor($pdo,$c,$row,$country,$u['id']);
  if($currency===null)throw new AppError('Wybierz kraj w profilu, aby wybrać plan.',422);
  $client=StripeClient::interactive($c);
  if(!isset($c['stripe_prices'][$currency]))throw new StripeError('No price for '.$currency,0,'config');
  $known=$row!==null&&$row['stripe_customer_id']!==null&&self::sameMode($row,$c);
  if($known&&$status!=='incomplete'&&$row['pending_checkout_id']!==null&&(int)$row['pending_checkout_expires']>$now+300&&$row['currency']===$currency){
   try{$s=$client->get('/v1/checkout/sessions/'.$row['pending_checkout_id']);
    if(($s['status']??null)==='open'&&BillingSync::ref($s['customer']??null)===$row['stripe_customer_id']&&self::checkoutUrl($s['url']??null))return ['url'=>$s['url']];
   }catch(StripeError $e){if(!$e->missing())throw $e;}
  }
  $replace=false;
  if($known){
   $r=BillingSync::syncUser($pdo,$c,$u['id'],$client,$u['id']);$row=$r['row']??$row;$cus=$r['customer']??null;
   if($r['outcome']==='busy'){
    // Another sync holds the claim (the lazy sync after me, a double click) and only the cached row came back: Stripe is
    // read here without writing, so a subscription the cache does not know yet still refuses the checkout and the
    // Customer.currency check below still has the customer.
    [$subs,$cus]=BillingSync::fetchCustomer($client,(string)$row['stripe_customer_id']);
    if(BillingSync::ongoingIds($c,$subs))self::locked();
    if(!empty($cus['deleted']))$r['outcome']='customer-deleted';
   }
   if(in_array(Access::subStatus($row,$c),BillingSync::ONGOING,true))self::locked();
   $currency=self::currencyFor($pdo,$c,$row,$country,$u['id'])??$currency;
   if(!isset($c['stripe_prices'][$currency]))throw new StripeError('No price for '.$currency,0,'config');
   $cur=is_array($cus)&&empty($cus['deleted'])&&is_string($cus['currency']??null)?strtolower($cus['currency']):'';
   $replace=$r['outcome']==='customer-deleted'||($cur!==''&&$cur!==$currency);
  }
  $row=BillingSync::ensureRow($pdo,$u);$lang=self::lang($lang,$country);
  $customer=self::ensureCustomer($pdo,$c,$client,$u,$row,$country,$replace);
  $params=['mode'=>'subscription','line_items'=>[['price'=>self::resolvePrice($pdo,$c,$client,$currency),'quantity'=>1]],'customer'=>$customer,
   'customer_update'=>['address'=>'auto','name'=>'auto'],'client_reference_id'=>$u['id'],'metadata'=>['matbravo_user_id'=>$u['id'],'matbravo_env'=>$c['billing_mode']],
   'subscription_data'=>['metadata'=>['matbravo_user_id'=>$u['id']],'description'=>'MatBravo'],
   'success_url'=>self::appUrl($c).'/?billing=success&session_id={CHECKOUT_SESSION_ID}','cancel_url'=>self::appUrl($c).'/?billing=cancel',
   'locale'=>$lang,'billing_address_collection'=>$c['billing_address_collection'],'expires_at'=>$now+3600];
  try{$s=$client->post('/v1/checkout/sessions',$params);}
  catch(StripeError $e){
   if($e->missing()&&$e->param==='customer'){
    // The customer was deleted in the Dashboard: forget it and create a new one (customer_seq+1).
    BillingSync::customerGone($pdo,$customer,$u['id']);$params['customer']=self::ensureCustomer($pdo,$c,$client,$u,$row,$country,true);$s=$client->post('/v1/checkout/sessions',$params);
   }elseif($e->missing()&&($e->param===null||str_contains($e->param,'price'))){$params['line_items'][0]['price']=self::resolvePrice($pdo,$c,$client,$currency,true);$s=$client->post('/v1/checkout/sessions',$params);}
   elseif($e->status===400&&$e->type==='invalid_request_error'&&stripos($e->getMessage(),'currenc')!==false){
    // Fallback only (Customer.currency above decides first): Stripe refused the customer's currency, so a new Customer.
    $params['customer']=self::ensureCustomer($pdo,$c,$client,$u,$row,$country,true);$s=$client->post('/v1/checkout/sessions',$params);
   }else throw $e;
  }
  $id=(string)($s['id']??'');$url=$s['url']??null;$exp=is_int($s['expires_at']??null)?$s['expires_at']:$now+3600;
  if(!preg_match('/^cs_(test|live)_[A-Za-z0-9]{10,250}$/D',$id)||!self::checkoutUrl($url))throw new StripeError('Unexpected checkout session',502,'api_error');
  $pdo->prepare('UPDATE billing_accounts SET pending_checkout_id=?,pending_checkout_expires=?,currency=?,next_sync_at=IF(next_sync_at IS NULL OR next_sync_at>?,?,next_sync_at),updated_at=? WHERE user_id=?')
   ->execute([$id,$exp,$currency,$exp+300,$exp+300,time(),$u['id']]);
  BillingSync::audit($pdo,$u['id'],$u['id'],'checkout.create',null,null,$id.' '.$currency);
  return ['url'=>$url];
 }
 /** §6.2 point 2: an ongoing subscription is managed in the Portal. */
 private static function locked():never{throw new ApiError('Masz już aktywną subskrypcję.',409,['portal'=>true]);}
 private static function checkoutUrl(mixed $u):bool{return is_string($u)&&str_starts_with($u,'https://checkout.stripe.com/');}
 /** The Stripe Customer of the account in this mode, created on the first checkout ($replace: a new one, customer_seq+1). */
 private static function ensureCustomer(PDO $pdo,array $c,StripeClient $client,array $u,array $row,?string $country,bool $replace=false):string {
  $row=Access::row($pdo,$u['id'])??$row;
  if(!$replace&&$row['stripe_customer_id']!==null&&self::sameMode($row,$c))return $row['stripe_customer_id'];
  $mode=$c['billing_mode'];$seq=(int)$row['customer_seq']+($replace?1:0);
  $params=['email'=>$u['email'],'preferred_locales'=>[$country==='PL'?'pl':'en'],'metadata'=>['matbravo_user_id'=>$u['id'],'matbravo_env'=>$mode]];
  try{$cus=$client->post('/v1/customers',$params,"matbravo-customer-{$u['id']}-$mode-$seq");}
  catch(StripeError $e){if($e->type!=='idempotency_error')throw $e;$seq++;$cus=$client->post('/v1/customers',$params,"matbravo-customer-{$u['id']}-$mode-$seq");}
  $id=(string)($cus['id']??'');if(!preg_match('/^cus_[A-Za-z0-9]{1,250}$/D',$id))throw new StripeError('Unexpected customer',502,'api_error');
  $old=$row['stripe_customer_id'];$otherMode=!self::sameMode($row,$c);
  // A customer of the other mode (test data after going live) or a replaced one: its subscription fields go with it.
  $pdo->prepare("UPDATE billing_accounts SET stripe_customer_id=?,livemode=?,customer_seq=?,".($otherMode||$replace?"stripe_subscription_id=NULL,sub_status='none',price_lookup_key=NULL,current_period_start=NULL,current_period_end=NULL,cancel_at_period_end=0,cancel_at=NULL,canceled_at=NULL,ended_at=NULL,latest_invoice_status=NULL,pending_checkout_id=NULL,pending_checkout_expires=NULL,last_synced_at=0,":'')."updated_at=? WHERE user_id=?")
   ->execute([$id,(int)self::live($c),$seq,time(),$u['id']]);
  BillingSync::audit($pdo,$u['id'],$u['id'],$old!==null?'customer.replace':'customer.create',null,null,$old!==null?$old.' -> '.$id:$id);
  return $id;
 }
 /** Price id of a currency from its lookup key (03 §3.2): billing_kv price:<mode>:<key> for 24 h; $fresh skips the cache. */
 public static function resolvePrice(PDO $pdo,array $c,StripeClient $client,string $currency,bool $fresh=false):string {
  $key=(string)$c['stripe_prices'][$currency];$kv='price:'.$c['billing_mode'].':'.$key;
  $hit=json_decode((string)BillingSync::kv($pdo,$kv),true);
  if(!$fresh&&is_array($hit)&&is_string($hit['id']??null)&&(int)($hit['at']??0)>time()-86400)return $hit['id'];
  $r=$client->get('/v1/prices',['lookup_keys'=>[$key],'active'=>true,'limit'=>1]);$p=$r['data'][0]??null;
  if(!is_array($p)||!is_string($p['id']??null)||!preg_match('/^price_[A-Za-z0-9_]{1,250}$/D',$p['id'])||strtolower((string)($p['currency']??''))!==$currency){
   BillingSync::kvSet($pdo,$kv,null);throw new StripeError('Price not found',404,'invalid_request_error','resource_missing');
  }
  if(isset($c['billing_amounts'][$currency])&&($p['unit_amount']??null)!==$c['billing_amounts'][$currency])error_log('MatDraw stripe: price '.$key.' amount differs from billing_amounts');
  BillingSync::kvSet($pdo,$kv,json_encode(['id'=>$p['id'],'at'=>time()],JSON_THROW_ON_ERROR));
  return $p['id'];
 }

 // ---- Return from Checkout, Portal, forced sync ---------------------------------------------------------------------
 /** billing-confirm (§6.2): ownership checks (403 without details), then the session's subscription is written. */
 public static function confirm(PDO $pdo,array $c,array $u,mixed $sessionId):array {
  if(!is_string($sessionId)||!preg_match('/^cs_(test|live)_[A-Za-z0-9]{10,250}$/D',$sessionId))throw new AppError('Nie można potwierdzić tej płatności.',403);
  $row=Access::row($pdo,$u['id']);
  if(!$row||$row['stripe_customer_id']===null||$row['deleted_at']!==null||!self::sameMode($row,$c))throw new AppError('Nie można potwierdzić tej płatności.',403);
  $client=StripeClient::interactive($c);$started=time();
  try{$s=$client->get('/v1/checkout/sessions/'.$sessionId,['expand'=>['subscription','subscription.latest_invoice']]);}
  catch(StripeError $e){if($e->missing()||$e->status===400)throw new AppError('Nie można potwierdzić tej płatności.',403);throw $e;}
  if(($s['client_reference_id']??null)!==$u['id']||BillingSync::ref($s['customer']??null)!==$row['stripe_customer_id']||($s['mode']??null)!=='subscription'||!empty($s['livemode'])!==self::live($c))
   throw new AppError('Nie można potwierdzić tej płatności.',403);
  $out=BillingSync::applySession($pdo,$c,$client,$s,$u['id'],$started,$u['id']);
  if($out==='foreign')throw new AppError('Nie można potwierdzić tej płatności.',403);
  return self::state($pdo,$c,$u,in_array($out,['open','expired'],true)?$out:null);
 }
 /** billing-portal (§6.2): a Portal session for the stored customer of this mode; {url} on billing.stripe.com. */
 public static function portal(PDO $pdo,array $c,array $u,mixed $lang=null):array {
  $row=Access::row($pdo,$u['id']);
  if(!$row||$row['stripe_customer_id']===null||$row['deleted_at']!==null||!self::sameMode($row,$c))throw new AppError('Najpierw wybierz plan.',409);
  $params=['customer'=>$row['stripe_customer_id'],'return_url'=>self::appUrl($c).'/?billing=portal','locale'=>self::lang($lang,self::country($pdo,$u['id']))];
  if(is_string($c['stripe_portal_configuration'])&&$c['stripe_portal_configuration']!=='')$params['configuration']=$c['stripe_portal_configuration'];
  $s=StripeClient::interactive($c)->post('/v1/billing_portal/sessions',$params);$url=$s['url']??null;
  if(!is_string($url)||!str_starts_with($url,'https://billing.stripe.com/'))throw new StripeError('Unexpected portal session',502,'api_error');
  return ['url'=>$url];
 }
 /** billing-sync: forced sync after the Portal (another sync in progress → the current state). */
 public static function syncSelf(PDO $pdo,array $c,array $u):array {
  BillingSync::syncUser($pdo,$c,$u['id'],StripeClient::interactive($c),$u['id']);
  return self::state($pdo,$c,$u);
 }

 // ---- For other slices (class_exists contracts) -------------------------------------------------------------------
 /**
  * Account e-mail changed (§3.9): the Stripe Customer gets the new address. On failure next_sync_at=now, so the next sync
  * (which always compares the e-mails) corrects it. Never throws for Stripe failures; true when nothing is left to do.
  */
 public static function pushCustomerEmail(PDO $pdo,array $c,string $userId):bool {
  $row=Access::row($pdo,$userId);$u=Accounts::find($pdo,$userId);
  if(!self::enabled($c)||!$u||!$row||$row['stripe_customer_id']===null||$row['deleted_at']!==null||!self::sameMode($row,$c))return true;
  try{StripeClient::interactive($c)->post('/v1/customers/'.$row['stripe_customer_id'],['email'=>$u['email']]);BillingSync::audit($pdo,$userId,'system','customer.email',null,null,$row['stripe_customer_id']);return true;}
  catch(StripeError){$pdo->prepare('UPDATE billing_accounts SET next_sync_at=?,updated_at=? WHERE user_id=?')->execute([time(),time(),$userId]);return false;}
 }
 /**
  * Account deletion (§3.8 step 4): DELETE /v1/customers/{id} (Stripe ends the subscriptions at once and removes the
  * customer's personal data). A failure (network, 5xx, other mode, payments off) never stops the deletion: the row gets
  * stripe_redact_pending=1 and billing-due retries it. Never throws for Stripe failures; true when the customer is gone.
  */
 public static function deleteCustomer(PDO $pdo,array $c,string $userId):bool {
  $row=Access::row($pdo,$userId);if(!$row||$row['stripe_customer_id']===null)return true;$cus=$row['stripe_customer_id'];$ok=false;
  if(self::enabled($c)&&self::sameMode($row,$c)){try{StripeClient::interactive($c)->delete('/v1/customers/'.$cus);$ok=true;}catch(StripeError $e){$ok=$e->missing();}}
  $pdo->prepare('UPDATE billing_accounts SET stripe_redact_pending=?,updated_at=? WHERE user_id=?')->execute([$ok?0:1,time(),$userId]);
  BillingSync::audit($pdo,$userId,'system',$ok?'customer.redact':'customer.redact.pending',null,null,$cus);
  return $ok;
 }

 // ---- Admin (§6.7) -------------------------------------------------------------------------------------------------
 /** Epoch of 00:00 Europe/Warsaw of a YYYY-MM-DD date (422 'Podaj poprawną datę.' otherwise). */
 public static function dayStart(mixed $date):int{return (new \DateTimeImmutable(Domain::date($date).' 00:00:00',new \DateTimeZone('Europe/Warsaw')))->getTimestamp();}
 private static function today():int{return (new \DateTimeImmutable('today',new \DateTimeZone('Europe/Warsaw')))->getTimestamp();}
 /** Plan badges of every staff account (admin-billing?list=staff), computed as if payments were enforced. */
 public static function adminList(PDO $pdo,array $c):array {
  $now=time();$cfg=['billing_enforce'=>true]+$c;$out=[];
  $rows=$pdo->query("SELECT u.id,u.role,b.user_id AS row_id,b.billing_exempt,b.exempt_reason,b.exempt_until,b.livemode,b.sub_status,b.current_period_start,b.current_period_end,b.cancel_at_period_end FROM users u LEFT JOIN billing_accounts b ON b.user_id=u.id WHERE u.role IN ('admin','editor','club') ORDER BY u.id")->fetchAll(PDO::FETCH_ASSOC);
  foreach($rows as $r){
   $row=$r['row_id']===null?null:$r;$a=Access::compute($row,['id'=>$r['id'],'role'=>$r['role']],$cfg,$now);
   $out[$r['id']]=['state'=>$a['state'],'exempt'=>$r['role']==='admin'||$row===null||(!empty($row['billing_exempt'])&&($row['exempt_until']===null||(int)$row['exempt_until']>$now)),
    'until'=>$a['until'],'reason'=>$row===null?($r['role']==='admin'?null:'staff-default'):$row['exempt_reason']];
  }
  return ['users'=>(object)$out];
 }
 /** One account for the Admin form (admin-billing?userId=): plan state, subscription, sync and Stripe ids. */
 public static function account(PDO $pdo,array $c,array $u):array {
  $row=Access::row($pdo,$u['id']);$now=time();$a=Access::compute($row,$u,['billing_enforce'=>true]+$c,$now);$staff=in_array($u['role'],['admin','editor','club'],true);
  $cus=$row['stripe_customer_id']??null;$livemode=$row!==null&&(int)$row['livemode']===1;$int=fn($v)=>$v===null?null:(int)$v;
  return ['userId'=>$u['id'],'role'=>$u['role'],'active'=>$u['active'],'state'=>$a['state'],'full'=>$a['full'],'until'=>$a['until'],
   'exempt'=>$u['role']==='admin'||($row===null?$staff:!empty($row['billing_exempt'])&&($row['exempt_until']===null||(int)$row['exempt_until']>$now)),
   'exemptReason'=>$row===null?($staff&&$u['role']!=='admin'?'staff-default':null):$row['exempt_reason'],'exemptUntil'=>$int($row['exempt_until']??null),'exemptBy'=>$row['exempt_by']??null,'exemptAt'=>$int($row['exempt_at']??null),
   'currency'=>self::currencyFor($pdo,$c,$row,self::country($pdo,$u['id']),$u['id']),'currencyOverride'=>BillingSync::kv($pdo,'currency:'.$u['id']),
   'mode'=>$row===null?null:($livemode?'live':'test'),'sameMode'=>self::sameMode($row,$c),'customerId'=>$cus,'subscriptionId'=>$row['stripe_subscription_id']??null,
   'subStatus'=>$row['sub_status']??'none','periodStart'=>$int($row['current_period_start']??null),'periodEnd'=>$int($row['current_period_end']??null),
   'cancelAtPeriodEnd'=>!empty($row['cancel_at_period_end']),'latestInvoiceStatus'=>$row['latest_invoice_status']??null,
   'pending'=>$row!==null&&$row['pending_checkout_id']!==null&&(int)$row['pending_checkout_expires']>$now,'lastSyncedAt'=>!empty($row['last_synced_at'])?(int)$row['last_synced_at']:null,
   'nextSyncAt'=>$int($row['next_sync_at']??null),'syncError'=>$row['sync_error']??null,'redactPending'=>!empty($row['stripe_redact_pending']),'deletedAt'=>$int($row['deleted_at']??null),
   'dashboardUrl'=>$cus!==null?'https://dashboard.stripe.com/'.($livemode?'':'test/').'customers/'.rawurlencode($cus):null];
 }
 public static function target(PDO $pdo,mixed $userId):array {
  $u=is_string($userId)&&preg_match('/^[A-Za-z0-9_-]{1,40}$/D',$userId)?Accounts::find($pdo,$userId):null;
  if(!$u)throw new AppError('Konto nie istnieje.',404);
  return $u;
 }
 /** admin-billing?userId=: {account, audit: last 50 entries} (ids and codes only). */
 public static function adminDetail(PDO $pdo,array $c,mixed $userId):array {
  $u=self::target($pdo,$userId);
  $q=$pdo->prepare('SELECT id,actor,action,old_status,new_status,detail,created_at FROM billing_audit WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 50');$q->execute([$u['id']]);
  $audit=array_map(fn($r)=>['id'=>(int)$r['id'],'actor'=>$r['actor'],'action'=>$r['action'],'oldStatus'=>$r['old_status'],'newStatus'=>$r['new_status'],'detail'=>$r['detail'],'at'=>(int)$r['created_at']],$q->fetchAll(PDO::FETCH_ASSOC));
  return ['account'=>self::account($pdo,$c,$u),'audit'=>$audit];
 }
 /**
  * admin-billing-action (§6.7): exempt {userId,reason,until?} (warnLive with an ongoing subscription), require {userId},
  * requireFrom {date,scope:'user'|'grandfathered',userId?}, currency {userId,currency|null}, resync {userId},
  * cancelAtPeriodEnd {userId}. Every action is written to billing_audit with the Admin as actor.
  */
 public static function adminAction(PDO $pdo,array $c,array $admin,array $b):array {
  $action=$b['action']??null;$now=time();$actor=$admin['id'];
  if($action==='requireFrom'&&($b['scope']??null)==='grandfathered'){
   $from=self::dayStart($b['date']??null);if($from<self::today()+14*86400)throw new AppError('Płatność można wymagać od daty co najmniej 14 dni od dziś.',422);
   $pdo->beginTransaction();
   try{
    $pdo->prepare("INSERT INTO billing_audit (user_id,actor,action,detail,created_at) SELECT user_id,?,'exempt.requireFrom',?,? FROM billing_accounts WHERE billing_exempt=1 AND exempt_reason='grandfathered' AND deleted_at IS NULL")->execute([$actor,'from='.date('Y-m-d',$from).' scope=grandfathered',$now]);
    $q=$pdo->prepare("UPDATE billing_accounts SET exempt_until=?,updated_at=? WHERE billing_exempt=1 AND exempt_reason='grandfathered' AND deleted_at IS NULL");$q->execute([$from,$now]);$count=$q->rowCount();
    $pdo->commit();
   }catch(\Throwable $e){$pdo->rollBack();throw $e;}
   return ['ok'=>true,'count'=>$count,'from'=>$from];
  }
  $u=self::target($pdo,$b['userId']??null);$uid=$u['id'];$row=Access::row($pdo,$uid);
  if($row&&$row['deleted_at']!==null)throw new AppError('Konto nie istnieje.',404);
  $before=Access::compute($row,$u,['billing_enforce'=>true]+$c,$now)['state'];$extra=[];
  $after=function()use($pdo,$c,$u,$now):string{return Access::compute(Access::row($pdo,$u['id']),$u,['billing_enforce'=>true]+$c,$now)['state'];};
  switch($action){
   case 'exempt':
    $reason=Text::clean($b['reason']??null);if($reason===null||$reason===''||mb_strlen($reason)>200)throw new AppError('Podaj powód darmowego konta.',422);
    $until=isset($b['until'])&&$b['until']!==null&&$b['until']!==''?self::dayStart($b['until']):null;
    if($until!==null&&$until<=$now)throw new AppError('Koniec darmowego okresu musi być w przyszłości.',422);
    $pdo->prepare('INSERT INTO billing_accounts (user_id,billing_exempt,exempt_reason,exempt_by,exempt_at,exempt_until,created_at,updated_at) VALUES (?,1,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE billing_exempt=1,exempt_reason=VALUES(exempt_reason),exempt_by=VALUES(exempt_by),exempt_at=VALUES(exempt_at),exempt_until=VALUES(exempt_until),updated_at=VALUES(updated_at)')
     ->execute([$uid,$reason,$actor,$now,$until,$now,$now]);
    // A paying person made free keeps being charged until the subscription is stopped (03 §10.2): the Admin is warned.
    $extra['warnLive']=in_array(Access::subStatus($row,$c),BillingSync::ONGOING,true)&&empty($row['cancel_at_period_end']);
    BillingSync::audit($pdo,$uid,$actor,'exempt.grant',$before,$after(),$until!==null?'until='.date('Y-m-d',$until):null);
    break;
   case 'require':
    $pdo->prepare('INSERT INTO billing_accounts (user_id,billing_exempt,exempt_by,exempt_at,created_at,updated_at) VALUES (?,0,?,?,?,?) ON DUPLICATE KEY UPDATE billing_exempt=0,exempt_reason=NULL,exempt_until=NULL,exempt_by=VALUES(exempt_by),exempt_at=VALUES(exempt_at),updated_at=VALUES(updated_at)')
     ->execute([$uid,$actor,$now,$now,$now]);
    BillingSync::audit($pdo,$uid,$actor,'exempt.revoke',$before,$after());
    break;
   case 'requireFrom':
    if(($b['scope']??'user')!=='user')throw new AppError('Niepoprawna operacja.',400);
    $from=self::dayStart($b['date']??null);if($from<self::today())throw new AppError('Data wymagania płatności nie może być w przeszłości.',422);
    if($row===null&&in_array($u['role'],['editor','club'],true))$row=BillingSync::ensureRow($pdo,$u);
    if(!$row||empty($row['billing_exempt']))throw new AppError('To konto nie jest darmowe.',409);
    $pdo->prepare('UPDATE billing_accounts SET exempt_until=?,updated_at=? WHERE user_id=?')->execute([$from,$now,$uid]);
    BillingSync::audit($pdo,$uid,$actor,'exempt.requireFrom',$before,$after(),'from='.date('Y-m-d',$from));
    break;
   case 'currency':
    $cur=$b['currency']??null;if($cur!==null&&(!is_string($cur)||!isset($c['stripe_prices'][$cur])))throw new AppError('Niepoprawna waluta.',422);
    if(in_array(Access::subStatus($row,$c),BillingSync::ONGOING,true))throw new AppError('Nie można zmienić waluty trwającej subskrypcji.',409);
    BillingSync::kvSet($pdo,'currency:'.$uid,$cur);
    BillingSync::audit($pdo,$uid,$actor,'currency.set',null,null,$cur??'country');
    break;
   case 'resync':
    self::requireStripe($c);
    $out=BillingSync::syncUser($pdo,$c,$uid,StripeClient::interactive($c),$actor)['outcome'];
    if($out==='busy')$extra['busy']=true;
    BillingSync::audit($pdo,$uid,$actor,'resync',$before,$after(),$out);
    break;
   case 'cancelAtPeriodEnd':
    self::requireStripe($c);
    if(!in_array(Access::subStatus($row,$c),self::CANCELABLE,true)||$row['stripe_subscription_id']===null)throw new AppError('To konto nie ma trwającej subskrypcji.',409);
    $client=StripeClient::interactive($c);$started=time();
    $sub=$client->post('/v1/subscriptions/'.$row['stripe_subscription_id'],['cancel_at_period_end'=>true,'expand'=>['latest_invoice']]);
    BillingSync::apply($pdo,$c,$client,$sub,$actor,$started,['row'=>$row]);
    BillingSync::audit($pdo,$uid,$actor,'cancel.request',$before,$after(),$row['stripe_subscription_id']);
    break;
   default:throw new AppError('Niepoprawna operacja.',400);
  }
  return ['ok'=>true,'account'=>self::account($pdo,$c,$u)]+$extra;
 }
 private static function requireStripe(array $c):void{if(!self::enabled($c))throw new AppError('Płatności są wyłączone.',409);}
}
