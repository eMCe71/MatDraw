<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * A Stripe API error: status 0 = no HTTP answer (network error, timeout, open circuit breaker), otherwise the HTTP
 * status with Stripe's error type, code, param and Request-Id. Its message is Stripe's own text and is never shown to
 * people (routes answer with a generic, translated 503) and never logged in full (it may quote request values).
 * It lives in this file, and the autoloader maps MatDraw\X only to src/X.php: `catch (StripeError)` and `instanceof`
 * are safe anywhere (they never load a class), but code that constructs one or calls its static members must have used
 * StripeClient first (class_exists(StripeClient::class) is enough). Every such site in Billing and BillingSync runs after
 * a client exists; other slices only call the class_exists contracts, which catch it.
 */
final class StripeError extends \RuntimeException {
 public function __construct(string $m,public readonly int $status,public readonly ?string $type=null,public readonly ?string $stripeCode=null,public readonly ?string $requestId=null,public readonly ?string $param=null){parent::__construct($m,$status);}
 /** Stripe could not be reached or failed itself (network, timeout, 5xx, open breaker): not a refusal of the request. */
 public function unavailable():bool{return $this->status===0||$this->status>=500;}
 /** The object does not exist (404 or code resource_missing). */
 public function missing():bool{return $this->status===404||$this->stripeCode==='resource_missing';}
 /** Short code for logs and stripe_events.error: no message text, so no request values. */
 public function code():string{return 'stripe '.$this->status.' '.($this->type??'-').'/'.($this->stripeCode??'-');}
}

/**
 * Stripe REST client on ext-curl without an SDK (plan §6.3, report 03 §13).
 *  - HTTPS only; http:// solely with allow_insecure_http and a loopback host (the stub in tests, Config::apiBaseAllowed);
 *    TLS peer and host verification always on, no redirects, optional CA bundle (stripe_ca_bundle).
 *  - Every request carries the pinned Stripe-Version (stripe_api_version, so the 'basil'+ object shapes are what the
 *    code reads), Bearer key, Accept JSON and a User-Agent; every POST carries an Idempotency-Key, reused on retries.
 *  - interactive(): checkout, confirm, portal, Admin, CLI. Connect 5 s, total stripe_timeout_seconds, up to 2 retries on
 *    network errors, 409 (idempotency lock), 429 and 5xx with backoff 0.5 s·2^n + jitter; Stripe-Should-Retry decides
 *    when present (false = never, true = always).
 *  - webhook(): the re-fetch of a webhook delivery: the background timeouts without retries and without the breaker.
 *  - background(): the lazy sync after a response and the jobs. No retries, connect 3 s, total 8 s
 *    (stripe_background_connect_timeout/_timeout; CURLOPT_TIMEOUT is wall time, unlike set_time_limit), and a circuit
 *    breaker: a network error or 5xx stores stripe_down_until=now+stripe_down_seconds in billing_kv, and until then every
 *    background request fails at once without HTTP (StripeError status 0, type circuit_open).
 *  - Logs: method, path without query, status, error type/code and Request-Id. Never the key, a query, a request or a
 *    response body (they carry e-mails). A Stripe-Version answer other than the pinned one is logged once per process.
 *  - Form encoding with Stripe's brackets (norm(): booleans as 'true'/'false', nulls dropped, lists as a[0]=…).
 * Never call it inside a database transaction or while a session or row lock is held.
 */
final class StripeClient {
 public const USER_AGENT='MatBravo/1.0 (+https://matbravo.com)',DOWN_KEY='stripe_down_until';
 private static bool $versionWarned=false;
 private array $headers=[];
 private function __construct(private string $key,private string $version,private string $base,private bool $allowHttp,private ?string $ca,
  private int $connectTimeout,private int $timeout,private int $retries,private ?PDO $breaker=null,private int $downSeconds=600){
  if(!Config::apiBaseAllowed($base,$allowHttp))throw new \RuntimeException('Invalid billing configuration.');
  if(!preg_match('/^[A-Za-z0-9_]{8,255}$/D',$key)||!preg_match('/^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[a-z]+)?$/D',$version))throw new \RuntimeException('Invalid billing configuration.');
 }
 /** Requests a person waits for (checkout, confirm, portal, Admin) and the CLI tools: retries, longer timeout. */
 public static function interactive(array $c,?string $key=null):self {
  return new self($key??(string)$c['stripe_secret_key'],(string)$c['stripe_api_version'],(string)$c['stripe_api_base'],!empty($c['allow_insecure_http']),self::ca($c),5,max(1,(int)$c['stripe_timeout_seconds']),2);
 }
 /** Work nobody waits for (lazy sync, jobs, webhook re-fetch): no retries, short timeouts, circuit breaker in billing_kv. */
 public static function background(PDO $pdo,array $c):self {
  return new self((string)$c['stripe_secret_key'],(string)$c['stripe_api_version'],(string)$c['stripe_api_base'],!empty($c['allow_insecure_http']),self::ca($c),
   max(1,(int)$c['stripe_background_connect_timeout']),max(1,(int)$c['stripe_background_timeout']),0,$pdo,max(1,(int)$c['stripe_down_seconds']));
 }
 /**
  * The re-fetch of a webhook delivery: background timeouts and no retries (Stripe retries the delivery itself), but
  * outside the circuit breaker: a delivery shows Stripe is up, and one failed re-fetch must not hold back later ones.
  */
 public static function webhook(array $c):self {
  return new self((string)$c['stripe_secret_key'],(string)$c['stripe_api_version'],(string)$c['stripe_api_base'],!empty($c['allow_insecure_http']),self::ca($c),
   max(1,(int)$c['stripe_background_connect_timeout']),max(1,(int)$c['stripe_background_timeout']),0);
 }
 private static function ca(array $c):?string{$p=$c['stripe_ca_bundle']??null;return is_string($p)&&$p!==''?$p:null;}
 public function get(string $path,array $query=[]):array{return $this->req('GET',$path,$query,null);}
 public function post(string $path,array $params=[],?string $idem=null):array{return $this->req('POST',$path,$params,$idem??'matbravo-'.bin2hex(random_bytes(16)));}
 public function delete(string $path):array{return $this->req('DELETE',$path,[],null);}
 /** Lower-case response headers of the last answer (stripe-setup.php checks stripe-version). */
 public function lastHeaders():array{return $this->headers;}
 /** Stripe form values: booleans 'true'/'false', nulls dropped, nested arrays kept for http_build_query. */
 public static function norm(array $a):array {
  $o=[];foreach($a as $k=>$v){if($v===null)continue;$o[$k]=is_bool($v)?($v?'true':'false'):(is_array($v)?self::norm($v):(string)$v);}return $o;
 }
 public static function encode(array $params):string{return http_build_query(self::norm($params),'','&',PHP_QUERY_RFC1738);}
 /** Seconds until the background circuit breaker closes (0 = closed). */
 public static function downFor(PDO $pdo,?int $now=null):int {
  $now??=time();$q=$pdo->prepare('SELECT v FROM billing_kv WHERE k=?');$q->execute([self::DOWN_KEY]);$v=$q->fetchColumn();$q->closeCursor();
  return is_string($v)&&ctype_digit($v)&&(int)$v>$now?(int)$v-$now:0;
 }
 public static function trip(PDO $pdo,int $seconds,?int $now=null):void {
  $now??=time();$pdo->prepare('INSERT INTO billing_kv (k,v,updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE v=VALUES(v),updated_at=VALUES(updated_at)')->execute([self::DOWN_KEY,(string)($now+$seconds),$now]);
 }
 private function curlBase(string $url):\CurlHandle {
  $c=curl_init($url);
  curl_setopt_array($c,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_CONNECTTIMEOUT=>$this->connectTimeout,CURLOPT_TIMEOUT=>$this->timeout,CURLOPT_FOLLOWLOCATION=>false,
   CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_PROTOCOLS=>$this->allowHttp?(CURLPROTO_HTTPS|CURLPROTO_HTTP):CURLPROTO_HTTPS,CURLOPT_NOSIGNAL=>true]);
  if($this->ca)curl_setopt($c,CURLOPT_CAINFO,$this->ca);
  return $c;
 }
 private function req(string $m,string $path,array $params,?string $idem):array {
  if(!preg_match('#^/v1/[A-Za-z0-9_/\-]+$#D',$path)||str_contains($path,'//'))throw new \InvalidArgumentException('Invalid Stripe path.');
  if($this->breaker&&self::downFor($this->breaker)>0)throw new StripeError('Stripe circuit open',0,'circuit_open');
  $body=self::encode($params);$url=rtrim($this->base,'/').$path.($m==='GET'&&$body!==''?'?'.$body:'');
  $h=['Authorization: Bearer '.$this->key,'Stripe-Version: '.$this->version,'Accept: application/json','User-Agent: '.self::USER_AGENT];
  if($m==='POST'){$h[]='Content-Type: application/x-www-form-urlencoded';$h[]='Idempotency-Key: '.$idem;}
  for($try=0;;$try++){
   $c=$this->curlBase($url);$rh=[];
   curl_setopt_array($c,[CURLOPT_HTTPHEADER=>$h,CURLOPT_HEADERFUNCTION=>function($c,string $line)use(&$rh):int{$p=explode(':',$line,2);if(count($p)===2)$rh[strtolower(trim($p[0]))]=trim($p[1]);return strlen($line);}]);
   if($m==='POST')curl_setopt_array($c,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>$body]);elseif($m==='DELETE')curl_setopt($c,CURLOPT_CUSTOMREQUEST,'DELETE');else curl_setopt($c,CURLOPT_HTTPGET,true);
   $raw=curl_exec($c);$errno=curl_errno($c);$status=$errno?0:(int)curl_getinfo($c,CURLINFO_RESPONSE_CODE);curl_close($c);
   $this->headers=$rh;$should=$rh['stripe-should-retry']??null;
   $retryable=$errno!==0||$status===409||$status===429||$status>=500;
   if($should==='false')$retryable=false;elseif($should==='true'&&$status>=400)$retryable=true;
   if(($errno!==0||$status>=400)&&$retryable&&$try<$this->retries){usleep((int)(500000*(2**$try))+random_int(0,250000));continue;}
   if($errno!==0){
    error_log("MatDraw stripe: $m $path curl=$errno".($try?" tries=".($try+1):''));
    if($this->breaker)self::trip($this->breaker,$this->downSeconds);
    throw new StripeError('Stripe network error',0,'network');
   }
   $json=json_decode((string)$raw,true);
   if($status>=400||!is_array($json)){
    $e=is_array($json)&&is_array($json['error']??null)?$json['error']:[];$type=is_string($e['type']??null)?$e['type']:null;$code=is_string($e['code']??null)?$e['code']:null;$req=$rh['request-id']??null;
    error_log("MatDraw stripe: $m $path $status ".($type??'-').'/'.($code??'-').' req='.($req??'-'));
    if($this->breaker&&$status>=500)self::trip($this->breaker,$this->downSeconds);
    throw new StripeError(is_string($e['message']??null)?$e['message']:'Stripe error',$status>=400?$status:502,$type,$code,$req,is_string($e['param']??null)?$e['param']:null);
   }
   if(!self::$versionWarned&&isset($rh['stripe-version'])&&$rh['stripe-version']!==$this->version){self::$versionWarned=true;error_log('MatDraw stripe: Stripe-Version '.substr(preg_replace('/[^A-Za-z0-9._-]/','',$rh['stripe-version']),0,40).' differs from the pinned '.$this->version);}
   return $json;
  }
 }
 /**
  * Reachability of the Stripe API from this PHP (diagnostics?probe=stripe on the web SAPI, server-check on the CLI):
  * an unauthenticated GET /v1/charges with a 5 s limit. Stripe answers 401 with a JSON error, so reachable means "an
  * HTTP answer with a JSON body"; a firewall page (403 HTML) or a TLS error is not. Returns
  * {reachable, status, ms, tls (the TLS library of curl), error}; never sends a key and never throws.
  */
 public static function probe(array $c):array {
  $out=['reachable'=>false,'status'=>null,'ms'=>0,'tls'=>function_exists('curl_version')?(curl_version()['ssl_version']??null):null,'error'=>null];
  if(!function_exists('curl_init')){$out['error']='curl extension missing';return $out;}
  $base=(string)($c['stripe_api_base']??'https://api.stripe.com');
  if(!Config::apiBaseAllowed($base,!empty($c['allow_insecure_http']))){$out['error']='stripe_api_base not allowed';return $out;}
  $ch=curl_init(rtrim($base,'/').'/v1/charges');$ca=self::ca($c);
  curl_setopt_array($ch,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>5,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_NOSIGNAL=>true,
   CURLOPT_PROTOCOLS=>!empty($c['allow_insecure_http'])?(CURLPROTO_HTTPS|CURLPROTO_HTTP):CURLPROTO_HTTPS,CURLOPT_HTTPHEADER=>['Accept: application/json','User-Agent: '.self::USER_AGENT]]);
  if($ca)curl_setopt($ch,CURLOPT_CAINFO,$ca);
  $t=microtime(true);$raw=curl_exec($ch);$errno=curl_errno($ch);$err=curl_error($ch);$status=(int)curl_getinfo($ch,CURLINFO_RESPONSE_CODE);curl_close($ch);
  $out['ms']=(int)round((microtime(true)-$t)*1000);
  if($errno){$out['error']='curl '.$errno.': '.mb_substr($err,0,160);return $out;}
  $out['status']=$status;$out['reachable']=$status>0&&is_array(json_decode((string)$raw,true));
  if(!$out['reachable'])$out['error']='answer is not Stripe JSON';
  return $out;
 }
}
