<?php
// One-off Stripe setup over SSH (plan §6.9, report 03 §4 with the override of §6.11), per mode, idempotent:
//   /usr/local/php83/bin/php ~/domains/matbravo.com/backend/bin/stripe-setup.php --mode=test [--webhook] [--rotate-webhook] [--reprice] [--dry-run]
// The full secret key (sk_test_… / sk_live_…) is never an argument: argv is visible in `ps` and the shell history.
//  - On a terminal the script asks for it with echo switched off (stty -echo, restored afterwards, also on errors and
//    Ctrl-C); without stty it refuses and shows the safe form: read -rs K; printf '%s\n' "$K" | php stripe-setup.php …; unset K
//  - With STDIN from a pipe (CI, the form above) it reads one line. The key is never printed, logged or written to disk.
//  - Any argument such as --key=… or a value starting with sk_/rk_ is refused.
// Steps: account check (country, currency, Stripe-Version), product matbravo_membership, one monthly price per configured
// currency (lookup keys from stripe_prices, amounts from billing_amounts; a mismatch stops unless --reprice creates a new
// price with transfer_lookup_key=true), the Customer Portal configuration (metadata matbravo_key=portal_v1) and, only with
// --webhook, the webhook endpoint (its secret is printed once). Ends with a config block to paste into
// ~/matdraw/shared/config.php and the reminder to roll the sk_ key. Uses app_url, stripe_api_base, stripe_api_version,
// stripe_prices and billing_amounts of the config (MATDRAW_CONFIG or backend/config.php).
// Exit codes: 0 done; 1 Stripe error; 2 wrong arguments or key; 3 price mismatch (use --reprice).
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/bootstrap.php';
use MatDraw\{BillingSync,StripeClient,StripeError};

$self='stripe-setup.php';
$safe="read -rs K; printf '%s\\n' \"\$K\" | /usr/local/php83/bin/php $self --mode=test; unset K";
$err=function(string $s,int $code)use(&$restoreTty):never{if(isset($restoreTty))$restoreTty();fwrite(STDERR,$s."\n");exit($code);};
$args=array_slice($argv,1);
// 1. No key in argv: refuse before doing anything else and never repeat the value.
foreach($args as $a)if(preg_match('/^--?(key|secret|sk|rk|api[-_]?key|stripe[-_]?key|secret[-_]?key)(=|$)/i',$a)||preg_match('/(^|[=:\s])(sk|rk)_(test|live)_/i',$a))
 $err("Klucz Stripe nie może być podany w linii poleceń (trafiłby do historii powłoki i listy procesów).\nUruchom skrypt bez klucza i wklej klucz, gdy zapyta, albo użyj:\n  $safe",2);
$opt=['mode'=>null,'webhook'=>false,'rotate-webhook'=>false,'reprice'=>false,'dry-run'=>false];
foreach($args as $a){
 if(preg_match('/^--mode=(test|live)$/D',$a,$m))$opt['mode']=$m[1];
 elseif(in_array($a,['--webhook','--rotate-webhook','--reprice','--dry-run'],true))$opt[substr($a,2)]=true;
 elseif($a==='--no-webhook')$opt['webhook']=false;
 elseif($a==='--help'){fwrite(STDOUT,"Użycie: $self --mode=test|live [--webhook] [--rotate-webhook] [--reprice] [--dry-run]\nKlucz sk_ podaj na wejściu (skrypt zapyta), nigdy w poleceniu.\n");exit(0);}
 else $err('Nieznany argument: '.preg_replace('/[^A-Za-z0-9=_.-]/','?',substr($a,0,40))."\nUżycie: $self --mode=test|live [--webhook] [--rotate-webhook] [--reprice] [--dry-run]",2);
}
if($opt['mode']===null)$err("Podaj tryb: --mode=test albo --mode=live.",2);
if($opt['rotate-webhook'])$opt['webhook']=true;
$mode=$opt['mode'];$dry=$opt['dry-run'];

// 2. The key from STDIN: hidden prompt on a terminal, one line from a pipe.
$restoreTty=null;
if(stream_isatty(STDIN)){
 $disabled=array_map('trim',explode(',',(string)ini_get('disable_functions')));
 $saved=function_exists('shell_exec')&&!in_array('shell_exec',$disabled,true)?trim((string)@shell_exec('stty -g 2>/dev/null')):'';
 if($saved===''||!preg_match('/^[0-9A-Za-z:=-]+$/D',$saved))$err("Nie można ukryć wpisywanego klucza (brak polecenia stty albo shell_exec jest wyłączone).\nPodaj klucz bez wyświetlania go i bez zapisu w historii powłoki:\n  $safe",2);
 $restoreTty=function()use($saved){static $done=false;if($done)return;$done=true;@shell_exec('stty '.escapeshellarg($saved).' 2>/dev/null');};
 register_shutdown_function($restoreTty);
 if(function_exists('pcntl_async_signals')&&function_exists('pcntl_signal')){pcntl_async_signals(true);foreach([SIGINT,SIGTERM,SIGHUP] as $sig)pcntl_signal($sig,function()use($restoreTty){$restoreTty();fwrite(STDERR,"\nPrzerwano.\n");exit(130);});}
 // Echo goes off before the prompt appears, so nothing typed after the prompt is ever shown.
 try{@shell_exec('stty -echo 2>/dev/null');fwrite(STDERR,'Wklej klucz sk_'.$mode.'_… (nie będzie widoczny): ');$line=fgets(STDIN);}finally{$restoreTty();fwrite(STDERR,"\n");}
}else $line=fgets(STDIN);
$key=trim(is_string($line)?$line:'');unset($line);
if(!preg_match('/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,250}$/D',$key))$err('To nie wygląda na klucz Stripe (oczekiwany sk_'.$mode.'_…). Klucz nie został wyświetlony ani zapisany.',2);
if(!str_contains($key,'_'.$mode.'_'))$err("Klucz nie pasuje do trybu --mode=$mode (oczekiwany sk_{$mode}_…).",2);
if(str_starts_with($key,'rk_'))fwrite(STDOUT,"Uwaga: podano klucz ograniczony rk_. Do konfiguracji potrzebne są uprawnienia zapisu produktów, cen, portalu i webhooków.\n");

$say=fn(string $s)=>fwrite(STDOUT,$s."\n");
try{
 $c=matdraw_config();$c['billing_mode']=$mode;$app=rtrim((string)$c['app_url'],'/');
 $s=StripeClient::interactive($c,$key);unset($key);
 $idem=fn(string $step)=>"matbravo-setup-$step-$mode-v1";
 $say("Stripe: konfiguracja w trybie $mode".($dry?' (dry-run: bez zmian)':'').'.');
 // 1. Account and version.
 try{
  $acc=$s->get('/v1/account');$ver=$s->lastHeaders()['stripe-version']??null;
  $say(sprintf('Konto: %s, kraj %s, waluta %s.',(string)($acc['settings']['dashboard']['display_name']??$acc['id']??'?'),(string)($acc['country']??'?'),(string)($acc['default_currency']??'?')));
  if(($acc['country']??'PL')!=='PL'||($acc['default_currency']??'pln')!=='pln')$say('Uwaga: oczekiwano kraju PL i waluty pln.');
  if($ver!==null&&$ver!==$c['stripe_api_version'])$say("Uwaga: Stripe odpowiada wersją API $ver, a config przypina {$c['stripe_api_version']}. Potwierdź wersję w Workbench.");
 }catch(StripeError $e){if($e->status!==403)throw $e;$say('Uwaga: klucz nie może odczytać konta (403); pomijam sprawdzenie konta.');}
 // 2. Product.
 $product=null;
 try{$product=$s->get('/v1/products/'.BillingSync::PRODUCT);}catch(StripeError $e){if(!$e->missing())throw $e;}
 if(!$product){
  if($dry)$say('[dry-run] Utworzyłbym produkt '.BillingSync::PRODUCT.'.');
  else{$s->post('/v1/products',['id'=>BillingSync::PRODUCT,'name'=>'MatBravo','description'=>'MatBravo account (monthly)','metadata'=>['matbravo_key'=>'membership']],$idem('product'));$say('Produkt '.BillingSync::PRODUCT.': utworzony.');}
 }elseif(empty($product['active'])){
  if($dry)$say('[dry-run] Aktywowałbym produkt '.BillingSync::PRODUCT.'.');
  else{$s->post('/v1/products/'.BillingSync::PRODUCT,['active'=>true],$idem('product-active'));$say('Produkt '.BillingSync::PRODUCT.': aktywowany.');}
 }else $say('Produkt '.BillingSync::PRODUCT.': jest.');
 // 3. One monthly price per currency.
 $mismatch=false;
 foreach((array)$c['stripe_prices'] as $cur=>$lookup){
  $amount=(int)($c['billing_amounts'][$cur]??0);if($amount<1){$say("Brak kwoty billing_amounts dla $cur; pomijam.");continue;}
  $found=$s->get('/v1/prices',['lookup_keys'=>[$lookup],'active'=>true,'limit'=>1])['data'][0]??null;
  $params=['product'=>BillingSync::PRODUCT,'currency'=>$cur,'unit_amount'=>$amount,'recurring'=>['interval'=>'month','interval_count'=>1],'lookup_key'=>$lookup,'nickname'=>'MatBravo monthly '.strtoupper($cur),'metadata'=>['matbravo_key'=>'monthly_'.$cur]];
  if(is_array($found)){
   $ok=BillingSync::ref($found['product']??null)===BillingSync::PRODUCT&&($found['currency']??null)===$cur&&($found['unit_amount']??null)===$amount&&($found['type']??'recurring')==='recurring'
    &&($found['recurring']['interval']??null)==='month'&&(int)($found['recurring']['interval_count']??0)===1;
   if($ok){$say("Cena $lookup: jest ($amount $cur).");continue;}
   if(!$opt['reprice']){$say("Cena $lookup różni się od oczekiwanej ($amount $cur miesięcznie). Uruchom z --reprice, aby utworzyć nową cenę (dotychczasowi subskrybenci zostają przy starej).");$mismatch=true;continue;}
   if($dry){$say("[dry-run] Utworzyłbym nową cenę $lookup ($amount $cur) z przeniesieniem klucza.");continue;}
   $s->post('/v1/prices',$params+['transfer_lookup_key'=>true],$idem("price-$cur-$amount-reprice"));$say("Cena $lookup: nowa ($amount $cur); dotychczasowi subskrybenci zostają przy starej cenie.");continue;
  }
  if($dry){$say("[dry-run] Utworzyłbym cenę $lookup ($amount $cur).");continue;}
  $s->post('/v1/prices',$params,$idem("price-$cur-$amount"));$say("Cena $lookup: utworzona ($amount $cur).");
 }
 // 4. Customer Portal configuration.
 $portalParams=['business_profile'=>['headline'=>'MatBravo'],'default_return_url'=>$app.'/?billing=portal',
  'features'=>['customer_update'=>['enabled'=>true,'allowed_updates'=>['address','name']],'invoice_history'=>['enabled'=>true],'payment_method_update'=>['enabled'=>true],
   'subscription_cancel'=>['enabled'=>true,'mode'=>'at_period_end','proration_behavior'=>'none','cancellation_reason'=>['enabled'=>true,'options'=>['too_expensive','unused','other']]],
   'subscription_update'=>['enabled'=>false]],'login_page'=>['enabled'=>false],'metadata'=>['matbravo_key'=>'portal_v1']];
 $portal=null;foreach(($s->get('/v1/billing_portal/configurations',['active'=>true,'limit'=>100])['data']??[]) as $p)if(($p['metadata']['matbravo_key']??null)==='portal_v1'){$portal=$p;break;}
 if($dry)$say($portal?'[dry-run] Zaktualizowałbym konfigurację portalu '.$portal['id'].'.':'[dry-run] Utworzyłbym konfigurację portalu.');
 elseif($portal){$s->post('/v1/billing_portal/configurations/'.$portal['id'],$portalParams);$say('Portal klienta: zaktualizowany ('.$portal['id'].').');}
 else{$portal=$s->post('/v1/billing_portal/configurations',$portalParams,$idem('portal'));$say('Portal klienta: utworzony ('.($portal['id']??'?').').');}
 // 5. Webhook endpoint (only after the host lets Stripe's addresses through, §6.4).
 $secret=null;
 if($opt['webhook']){
  $url=$app.'/api/index.php?route=stripe-webhook';$events=BillingSync::EVENT_TYPES;$hook=null;
  foreach(($s->get('/v1/webhook_endpoints',['limit'=>100])['data']??[]) as $w)if(($w['url']??null)===$url){$hook=$w;break;}
  if($dry)$say('[dry-run] Webhook: '.($hook?($opt['rotate-webhook']?'usunąłbym i utworzył na nowo':'sprawdziłbym zdarzenia'):'utworzyłbym').'.');
  else{
   if($hook&&$opt['rotate-webhook']){$s->delete('/v1/webhook_endpoints/'.$hook['id']);$hook=null;$say('Webhook: usunięty przed ponownym utworzeniem.');}
   if($hook){$have=(array)($hook['enabled_events']??[]);sort($have);$want=$events;sort($want);
    if($have!==$want){$s->post('/v1/webhook_endpoints/'.$hook['id'],['enabled_events'=>$events]);$say('Webhook: zaktualizowano listę zdarzeń.');}else $say('Webhook: jest ('.$hook['id'].').');}
   else{$w=$s->post('/v1/webhook_endpoints',['url'=>$url,'api_version'=>$c['stripe_api_version'],'description'=>'MatBravo billing','metadata'=>['matbravo_key'=>'webhook_v1'],'enabled_events'=>$events]);
    $secret=is_string($w['secret']??null)?$w['secret']:null;$say('Webhook: utworzony ('.($w['id']??'?').'). Sekret jest pokazany tylko raz, w bloku poniżej.');}
  }
 }
 // 6. Config block (no secret key; the webhook secret only when it was created now).
 $prices=implode(', ',array_map(fn($k,$v)=>"'$k' => '$v'",array_keys((array)$c['stripe_prices']),(array)$c['stripe_prices']));
 $amounts=implode(', ',array_map(fn($k,$v)=>"'$k' => ".(int)$v,array_keys((array)$c['billing_amounts']),(array)$c['billing_amounts']));
 $say('');$say("// --- Wklej do ~/matdraw/shared/config.php (chmod 600) ---");
 $say(" 'billing_mode' => '$mode',");
 $say(" 'stripe_secret_key' => 'REPLACE_WITH_rk_{$mode}_key', // klucz ograniczony rk_ z panelu Stripe, nigdy sk_");
 $say(" 'stripe_api_version' => '{$c['stripe_api_version']}',");
 $say(" 'stripe_prices' => [$prices],");$say(" 'billing_amounts' => [$amounts],");
 $say(" 'stripe_portal_configuration' => ".(is_string($portal['id']??null)?"'{$portal['id']}'":'null').",");
 if($secret!==null)$say(" 'stripe_webhook_secrets' => ['$secret'], // przy rotacji: ['nowy', 'stary'] do końca okresu przejściowego");
 $say('');
 $say('W panelu Stripe ustaw ręcznie: Limit customers to one subscription, Smart Retries z anulowaniem po ostatniej próbie, e-maile o nieudanej płatności i 3DS, paragony; Adaptive Pricing i Tax wyłączone.');
 $say('Po konfiguracji wygeneruj nowy klucz sk_ w panelu Stripe (Roll key). Na serwerze zostaje tylko klucz ograniczony rk_.');
 exit($mismatch?3:0);
}catch(StripeError $e){fwrite(STDERR,'Błąd Stripe: '.$e->code().($e->requestId?' (Request-Id '.$e->requestId.')':'')."\n");exit(1);}
catch(Throwable $e){fwrite(STDERR,'Błąd: '.MatDraw\Routes::describe($e)."\n");exit(1);}
