<?php
// Test-only fixture jobs of the billing-backend slice (loaded by tests/helpers/fixture.php; CLI, test database only).
//   billing-row {userId}                     the billing_accounts row (or null)
//   billing-audit {userId?, action?}         billing_audit rows, oldest first
//   stripe-events {}                         stripe_events rows, oldest first
//   billing-kv {get?:key, set?:{key:value|null}}  read or change billing_kv (e.g. the circuit breaker)
//   billing-run {fn, userId?, limit?, background?, pages?}  runs BillingSync/Billing directly:
//        due | events | reconcile | sync (forced, never throws) | sync-user (throws) | lazy | delete-customer | push-email | prune
//   billing-config-set {set:{key:value}}     rewrites MATDRAW_CONFIG atomically (allow-listed keys); returns the old values
//   billing-country {userId, country}        sets the profile country (staff accounts have no profile fixture)
//   billing-user-email {userId, email}       changes users.email directly (the member-email route belongs to another slice)
//   billing-tombstone {userId}               turns the row into the tombstone of §3.8 (deleted_at, exemption and pending cleared)
declare(strict_types=1);
use MatDraw\{Billing,BillingSync,StripeClient,StripeError};
const FIXTURE_BILLING_CONFIG_KEYS=['stripe_webhook_secrets','stripe_down_seconds','billing_sync_min_interval','stripe_portal_configuration','billing_grace_days'];
return [
 'billing-row'=>function(PDO $pdo,array $p):?array{$q=$pdo->prepare('SELECT * FROM billing_accounts WHERE user_id=?');$q->execute([(string)($p['userId']??'')]);return $q->fetch(PDO::FETCH_ASSOC)?:null;},
 'billing-audit'=>function(PDO $pdo,array $p):array{
  $w=[];$v=[];if(isset($p['userId'])){$w[]='user_id=?';$v[]=$p['userId'];}if(isset($p['action'])){$w[]='action=?';$v[]=$p['action'];}
  $q=$pdo->prepare('SELECT * FROM billing_audit'.($w?' WHERE '.implode(' AND ',$w):'').' ORDER BY id');$q->execute($v);return $q->fetchAll(PDO::FETCH_ASSOC);
 },
 'stripe-events'=>fn(PDO $pdo):array=>$pdo->query('SELECT * FROM stripe_events ORDER BY received_at,event_id')->fetchAll(PDO::FETCH_ASSOC),
 'billing-kv'=>function(PDO $pdo,array $p):array{
  foreach((array)($p['set']??[]) as $k=>$v)BillingSync::kvSet($pdo,(string)$k,$v===null?null:(string)$v);
  $out=[];foreach($pdo->query('SELECT k,v FROM billing_kv ORDER BY k') as $r)$out[$r['k']]=$r['v'];return $out;
 },
 'billing-run'=>function(PDO $pdo,array $p,array $c):mixed{
  $client=!empty($p['background'])?StripeClient::background($pdo,$c):StripeClient::interactive($c);$uid=(string)($p['userId']??'');
  try{
   return match($p['fn']??''){
    'due'=>BillingSync::due($pdo,$c,$client,(int)($p['limit']??5)),
    'events'=>BillingSync::pullEvents($pdo,$c,$client,(int)($p['pages']??1)),
    'reconcile'=>BillingSync::reconcile($pdo,$c,$client,'cli'),
    'sync'=>BillingSync::sync($pdo,$c,$uid),
    'sync-user'=>BillingSync::syncUser($pdo,$c,$uid,$client,'cli')['outcome'],
    'lazy'=>(function()use($pdo,$c,$uid){BillingSync::lazy($pdo,$c,$uid);return 'done';})(),
    'delete-customer'=>Billing::deleteCustomer($pdo,$c,$uid),
    'push-email'=>Billing::pushCustomerEmail($pdo,$c,$uid),
    'prune'=>BillingSync::prune($pdo),
    default=>throw new RuntimeException('billing-run: unknown fn'),
   };
  }catch(StripeError $e){return ['stripeError'=>$e->code(),'status'=>$e->status];}
 },
 'billing-config-set'=>function(PDO $pdo,array $p):array{
  $path=getenv('MATDRAW_CONFIG');if(!$path||!is_file($path))throw new RuntimeException('billing-config-set: MATDRAW_CONFIG');
  $c=require $path;$old=[];
  foreach((array)($p['set']??[]) as $k=>$v){if(!in_array($k,FIXTURE_BILLING_CONFIG_KEYS,true))throw new RuntimeException("billing-config-set: key $k not allowed");$old[$k]=$c[$k]??null;if($v===null)unset($c[$k]);else $c[$k]=$v;}
  $tmp=$path.'.tmp.'.getmypid();file_put_contents($tmp,"<?php\nreturn ".var_export($c,true).";\n");chmod($tmp,0600);rename($tmp,$path);
  return $old;
 },
 'billing-country'=>function(PDO $pdo,array $p):?string{$uid=(string)($p['userId']??'');MatDraw\Accounts::ensureProfile($pdo,$uid);$pdo->prepare('UPDATE user_profiles SET country=? WHERE user_id=?')->execute([$p['country']??null,$uid]);return $p['country']??null;},
 'billing-user-email'=>function(PDO $pdo,array $p):bool{$pdo->prepare('UPDATE users SET email=? WHERE id=?')->execute([mb_strtolower((string)$p['email']),(string)$p['userId']]);return true;},
 'billing-tombstone'=>function(PDO $pdo,array $p):array{
  $pdo->prepare('UPDATE billing_accounts SET deleted_at=?,billing_exempt=0,exempt_reason=NULL,exempt_by=NULL,exempt_at=NULL,exempt_until=NULL,pending_checkout_id=NULL,pending_checkout_expires=NULL,updated_at=? WHERE user_id=?')->execute([time(),time(),(string)$p['userId']]);
  $q=$pdo->prepare('SELECT * FROM billing_accounts WHERE user_id=?');$q->execute([(string)$p['userId']]);return $q->fetch(PDO::FETCH_ASSOC);
 },
];
