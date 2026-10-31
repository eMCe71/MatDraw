<?php
// Bridge for tests/billing.test.mjs (plan §11): billing-backend functions called with JSON on STDIN, no database.
// The circuit breaker runs against an in-memory stand-in for PDO that understands exactly the billing_kv statements.
declare(strict_types=1);
require dirname(__DIR__).'/backend/bootstrap.php';
use MatDraw\{BillingSync,Config,StripeClient,StripeError,StripeSignature};
date_default_timezone_set('Europe/Warsaw');
class_exists(StripeClient::class);// also defines StripeError

/** billing_kv in memory; records every statement. */
final class FakeKvStatement extends PDOStatement {
 private array $rows=[];
 public function __construct(private FakeKv $db,public string $sql){}
 public function execute(?array $params=null):bool{$this->rows=$this->db->run($this->sql,$params??[]);return true;}
 public function fetchColumn(int $column=0):mixed{$r=array_shift($this->rows);return $r?array_values($r)[$column]:false;}
 public function closeCursor():bool{$this->rows=[];return true;}
}
final class FakeKv extends PDO {
 public array $kv=[],$log=[];
 public function __construct(){}
 public function prepare(string $query,array $options=[]):PDOStatement|false{return new FakeKvStatement($this,$query);}
 public function run(string $sql,array $p):array {
  $this->log[]=$sql;
  if(str_starts_with($sql,'SELECT v FROM billing_kv WHERE k=?'))return isset($this->kv[$p[0]])?[['v'=>$this->kv[$p[0]]]]:[];
  if(str_starts_with($sql,'INSERT INTO billing_kv')){$this->kv[$p[0]]=$p[1];return [];}
  throw new RuntimeException('unexpected statement: '.$sql);
 }
}
function attempt(callable $fn):array{try{return ['ok'=>$fn()];}catch(StripeError $e){return ['stripe'=>$e->code(),'status'=>$e->status,'type'=>$e->type];}catch(Throwable $e){return ['error'=>get_class($e).': '.$e->getMessage()];}}
$cfg=fn(array $o=[])=>array_replace(Config::DEFAULTS,['allow_insecure_http'=>true,'stripe_secret_key'=>'rk_test_stub'],$o);

$in=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
$out=match($in['job']){
 'signature'=>array_map(fn($c)=>StripeSignature::verify($c['payload'],$c['header'],$c['secrets'],$c['tolerance']??300,$c['now']),$in['cases']),
 'state'=>array_map(fn($s)=>BillingSync::stateFromSubscription($s,$in['keys']),$in['subs']),
 'next'=>array_map(fn($c)=>BillingSync::nextSyncAt($c['state'],$c['now'],$c['min']??600),$in['cases']),
 'norm'=>['norm'=>StripeClient::norm($in['params']),'encoded'=>StripeClient::encode($in['params'])],
 'prefer'=>array_map(fn($c)=>BillingSync::prefer($c[0],$c[1],$c[2],$c[3]),$in['cases']),
 'best'=>array_map(fn($list)=>BillingSync::best($list)['stripe_subscription_id']??null,$in['lists']),
 'invoice-sub'=>array_map(fn($i)=>BillingSync::invoiceSubscription($i),$in['invoices']),
 'valid-event'=>array_map(fn($c)=>BillingSync::validEvent($c['event'],['billing_mode'=>$c['mode']]),$in['cases']),
 'registry'=>['routes'=>array_map(fn($r)=>[$r['method'],$r['auth'],$r['user'],$r['max']??null],array_intersect_key(MatDraw\Routes::all(),array_flip($in['routes']))),
  'jobs'=>array_map(fn($j)=>[$j['every'],$j['needsFlush']],array_intersect_key(MatDraw\Jobs::all(),array_flip($in['jobs'])))],
 'config'=>array_map(fn($c)=>attempt(function()use($c){Config::validate(array_replace(Config::DEFAULTS,$c));return 'valid';}),$in['cases']),
 // StripeClient against the stub (tests/stubs/stripe-stub.mjs on $in['base']): one call per case, with the breaker table.
 'client'=>(function()use($in,$cfg){
  $db=new FakeKv();$out=[];
  foreach($in['cases'] as $c){
   $config=$cfg(['stripe_api_base'=>$c['base']??$in['base']]+($c['cfg']??[]));
   if(isset($c['kv']))$db->kv=$c['kv'];
   $client=($c['background']??false)?StripeClient::background($db,$config):StripeClient::interactive($config);
   $t=microtime(true);
   $r=attempt(fn()=>$c['method']==='POST'?$client->post($c['path'],$c['params']??[],$c['idem']??null):$client->get($c['path'],$c['params']??[]));
   $out[]=$r+['kv'=>$db->kv,'ms'=>(int)round((microtime(true)-$t)*1000)];
  }
  return $out;
 })(),
 'probe'=>array_map(fn($b)=>StripeClient::probe($cfg(['stripe_api_base'=>$b])),$in['bases']),
 'bad-path'=>attempt(fn()=>StripeClient::interactive($cfg(['stripe_api_base'=>$in['base']]))->get($in['path'])),
 'bad-base'=>array_map(fn($b)=>attempt(fn()=>StripeClient::interactive($cfg(['stripe_api_base'=>$b[0],'allow_insecure_http'=>$b[1]]))),$in['bases']),
};
echo json_encode($out,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
