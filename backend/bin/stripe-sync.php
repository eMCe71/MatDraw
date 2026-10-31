<?php
// Stripe synchronisation from the command line or cron (plan §6.3, §6.9; report 03 §8.5). Optional: payments stay correct
// without it (confirm, Portal return, lazy sync and the billing jobs), it only refreshes accounts sooner.
//   /usr/local/php83/bin/php ~/domains/matbravo.com/backend/bin/stripe-sync.php --events --due     every 20 min
//   /usr/local/php83/bin/php ~/domains/matbravo.com/backend/bin/stripe-sync.php --reconcile        nightly
//   --events     /v1/events from the stored cursor (all pages), each event once (shared with the webhook)
//   --due        accounts whose next_sync_at passed (--limit, default 50) and pending Stripe customer deletions
//   --reconcile  every subscription of this mode, the best one per customer
//   --user=<id>  forced sync of one account
//   --dry-run    read from Stripe, change nothing; prints what would be processed
// One run at a time (GET_LOCK matbravo_stripe_sync per database); always prunes stripe_events older than 90 days.
// Output: counters only, never e-mails or names. Exit codes: 0 done, nothing to do, payments off or another run in
// progress; 1 Stripe or database error; 2 wrong arguments.
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/bootstrap.php';
use MatDraw\{BillingSync,Routes,StripeClient,StripeError};
$opts=getopt('',['events','due','reconcile','user:','limit:','dry-run','help']);
$out=fn(string $s)=>fwrite(STDOUT,$s."\n");
if(isset($opts['help'])||!array_intersect_key($opts,['events'=>1,'due'=>1,'reconcile'=>1,'user'=>1])){fwrite(STDERR,"Użycie: stripe-sync.php [--events] [--due] [--reconcile] [--user=<id>] [--limit=50] [--dry-run]\n");exit(isset($opts['help'])?0:2);}
$limit=isset($opts['limit'])?(int)$opts['limit']:50;if($limit<1||$limit>1000){fwrite(STDERR,"--limit: od 1 do 1000.\n");exit(2);}
$user=isset($opts['user'])?(string)$opts['user']:null;if($user!==null&&!preg_match('/^[A-Za-z0-9_-]{1,40}$/D',$user)){fwrite(STDERR,"--user: niepoprawny identyfikator.\n");exit(2);}
$dry=isset($opts['dry-run']);
try{
 $c=matdraw_config();
 if(empty($c['billing_enabled'])){$out('Płatności są wyłączone (billing_enabled=false). Bez zmian.');exit(0);}
 $pdo=matdraw_database($c);
 $lock="CONCAT('matbravo_stripe_sync:',LEFT(IFNULL(DATABASE(),''),40))";
 if((int)$pdo->query("SELECT GET_LOCK($lock,0)")->fetchColumn()!==1){$out('Inna synchronizacja jest właśnie w toku.');exit(0);}
 $rc=0;$client=StripeClient::interactive($c);
 try{
  $out('Tryb: '.$c['billing_mode'].($dry?' (dry-run)':''));
  $run=function(string $label,callable $fn)use(&$rc,$out){
   try{$out($label.': '.BillingSync::counts($fn()));}
   catch(StripeError $e){$rc=1;$out($label.': błąd Stripe ('.$e->code().')');}
  };
  if($user!==null)$run('user',function()use($pdo,$c,$client,$user,$dry){
   if($dry){$r=MatDraw\Access::row($pdo,$user);return ['customer'=>$r&&$r['stripe_customer_id']!==null?'yes':'no'];}
   return ['outcome'=>BillingSync::syncUser($pdo,$c,$user,$client,'cli')['outcome']];
  });
  if(isset($opts['events']))$run('events',fn()=>BillingSync::pullEvents($pdo,$c,$client,200,$dry));
  if(isset($opts['due']))$run('due',function()use($pdo,$c,$client,$limit,$dry){
   if(!$dry)return BillingSync::due($pdo,$c,$client,$limit,null,'cli',100);
   $q=$pdo->prepare('SELECT COUNT(*) FROM billing_accounts WHERE next_sync_at IS NOT NULL AND next_sync_at<=? AND livemode=? AND deleted_at IS NULL AND stripe_customer_id IS NOT NULL');$q->execute([time(),(int)($c['billing_mode']==='live')]);
   $r=$pdo->prepare('SELECT COUNT(*) FROM billing_accounts WHERE stripe_redact_pending=1 AND stripe_customer_id IS NOT NULL AND livemode=?');$r->execute([(int)($c['billing_mode']==='live')]);
   return ['due'=>(int)$q->fetchColumn(),'redactPending'=>(int)$r->fetchColumn()];
  });
  if(isset($opts['reconcile']))$run('reconcile',fn()=>BillingSync::reconcile($pdo,$c,$client,'cli',$dry));
  if(!$dry)$out('stripe_events: usunięto '.BillingSync::prune($pdo).' starszych niż 90 dni');
 }finally{$pdo->query("SELECT RELEASE_LOCK($lock)")->fetchAll();}
 exit($rc);
}catch(Throwable $e){Routes::logThrowable($e,'MatDraw stripe-sync');fwrite(STDERR,'Błąd synchronizacji: '.Routes::describe($e)."\n");exit(1);}
