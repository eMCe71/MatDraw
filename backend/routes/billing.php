<?php
// Payment routes (plan §4.2, §6.2–§6.4, §6.7). Every handler that may talk to Stripe releases the session first
// ($ctx->releaseSession(): no request of the same person waits for Stripe) and never inside a transaction; Stripe
// failures become one generic 503 (Billing::guard). The client never sends amounts, currencies or price ids.
//   billing-checkout     POST session  {lang?}          → {url} on checkout.stripe.com     10/h
//   billing-confirm      POST session  {sessionId}      → {access,billing,status}          30/h
//   billing-portal       POST session  {lang?}          → {url} on billing.stripe.com      20/h
//   billing-sync         POST session  {}               → {access,billing,status}          1 per 10 s, 30/h
//   admin-billing        GET  peek admin ?list=staff | ?userId=
//   admin-billing-action POST session admin {action,…}  (exempt, require, requireFrom, currency, resync, cancelAtPeriodEnd)
//   stripe-webhook       POST webhook (signature, ≤ 1 MiB; 404 while billing is off or no secret is configured)
declare(strict_types=1);
use MatDraw\{AppError,ApiError,Billing,BillingSync,RateLimit,RouteContext,Routes,StripeClient,StripeError,StripeSignature};

/** Per-account limit; the literal message stays here for the i18n test. */
$limit=static function(RouteContext $ctx,string $scope,int $max,int $window):void{
 $s=RateLimit::hit($ctx->pdo(),$ctx->config['app_key'],$scope,$ctx->user()['id'],$max,$window);
 if($s){$s=Routes::retryAfter($s);throw new ApiError('Zbyt wiele prób płatności. Spróbuj ponownie później.',429,['retry'=>$s]);}
};
return [
 'billing-checkout'=>['method'=>'POST','auth'=>'session','max'=>1024,'handler'=>function(RouteContext $ctx)use($limit):array{
  Billing::requireEnabled($ctx->config);$limit($ctx,'billing-checkout',10,3600);$u=$ctx->user();$pdo=$ctx->pdo();$ctx->releaseSession();
  return Billing::guard(fn()=>Billing::checkout($pdo,$ctx->config,$u,$ctx->input('lang')));
 }],
 'billing-confirm'=>['method'=>'POST','auth'=>'session','max'=>1024,'handler'=>function(RouteContext $ctx)use($limit):array{
  Billing::requireEnabled($ctx->config);$limit($ctx,'billing-confirm',30,3600);$u=$ctx->user();$pdo=$ctx->pdo();$ctx->releaseSession();
  return Billing::guard(fn()=>Billing::confirm($pdo,$ctx->config,$u,$ctx->input('sessionId')));
 }],
 'billing-portal'=>['method'=>'POST','auth'=>'session','max'=>1024,'handler'=>function(RouteContext $ctx)use($limit):array{
  Billing::requireEnabled($ctx->config);$limit($ctx,'billing-portal',20,3600);$u=$ctx->user();$pdo=$ctx->pdo();$ctx->releaseSession();
  return Billing::guard(fn()=>Billing::portal($pdo,$ctx->config,$u,$ctx->input('lang')));
 }],
 'billing-sync'=>['method'=>'POST','auth'=>'session','max'=>1024,'handler'=>function(RouteContext $ctx)use($limit):array{
  Billing::requireEnabled($ctx->config);$limit($ctx,'billing-sync-10s',1,10);$limit($ctx,'billing-sync',30,3600);$u=$ctx->user();$pdo=$ctx->pdo();$ctx->releaseSession();
  return Billing::guard(fn()=>Billing::syncSelf($pdo,$ctx->config,$u));
 }],
 'admin-billing'=>['method'=>'GET','auth'=>'peek','user'=>'admin','handler'=>function(RouteContext $ctx):array{
  $pdo=$ctx->pdo();
  if($ctx->query('list')==='staff')return Billing::adminList($pdo,$ctx->config);
  if($ctx->query('userId')!==null)return Billing::adminDetail($pdo,$ctx->config,$ctx->query('userId'));
  throw new AppError('Niepoprawna operacja.',400);
 }],
 'admin-billing-action'=>['method'=>'POST','auth'=>'session','user'=>'admin','max'=>4096,'handler'=>function(RouteContext $ctx):array{
  $u=$ctx->user();$pdo=$ctx->pdo();$ctx->releaseSession();
  return Billing::guard(fn()=>Billing::adminAction($pdo,$ctx->config,$u,$ctx->body));
 }],
 // Optional accelerator (§6.4): signature over the raw body, then object/id/livemode, then the shared event handler.
 // 200 {received:true} for processed, duplicate and unknown events; 400 for a bad signature or event; 500 on a
 // processing failure (Stripe retries). StripeClient::webhook keeps the answer fast (no retries, 3 s / 8 s) and stays
 // outside the circuit breaker (a delivery shows Stripe is up; a failed re-fetch is retried by Stripe itself).
 'stripe-webhook'=>['method'=>'POST','auth'=>'webhook','max'=>1048576,'handler'=>function(RouteContext $ctx):array{
  $c=$ctx->config;$secrets=is_array($c['stripe_webhook_secrets'])?$c['stripe_webhook_secrets']:[];
  if(!Billing::enabled($c)||!$secrets)throw new AppError('Nie ma takiej operacji.',404);
  ignore_user_abort(true);
  $raw=$ctx->raw();$sig=$_SERVER['HTTP_STRIPE_SIGNATURE']??'';
  if(!is_string($sig)||strlen($sig)>4096||!StripeSignature::verify($raw,$sig,$secrets)){error_log('MatDraw stripe webhook: signature rejected');throw new AppError('Niepoprawny podpis.',400);}
  try{$event=json_decode($raw,true,64,JSON_THROW_ON_ERROR);}catch(\JsonException){throw new AppError('Niepoprawny JSON.',400);}
  if(!BillingSync::validEvent($event,$c)){error_log('MatDraw stripe webhook: event rejected (object, id or livemode)');throw new AppError('Niepoprawne zdarzenie.',400);}
  $pdo=$ctx->pdo();
  try{BillingSync::handleEvent($pdo,$c,StripeClient::webhook($c),$event,'webhook');}
  catch(\Throwable $e){
   // Stripe's own message may quote request values (e-mails): only its status, type and code are logged.
   if($e instanceof StripeError)error_log('MatDraw stripe webhook: '.$e->code());else Routes::logThrowable($e,'MatDraw stripe webhook');
   throw new AppError('Nie udało się przetworzyć zdarzenia.',500);
  }
  return ['received'=>true];
 }],
];
