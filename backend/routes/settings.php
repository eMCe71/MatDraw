<?php
// Settings routes of the Administrator (PLAN-REJESTRACJA-ROLE §3.4–§3.6, §8.1–§8.2): the panel "Ustawienia" reads and
// writes app_settings through MatDraw\Settings. Every route is admin only (403 before any data is read). Defaults and the
// Stripe configuration come from the raw config.php ($ctx->file); the handlers that may talk to Stripe release the session
// first and never call Stripe inside a transaction; Stripe failures become one generic 503 (Billing::guard).
//   admin-settings       GET  peek    admin                         → view §8.2
//   admin-settings-save  POST session admin, ≤ 4 KB {version, …}    → view; 409 stale|stripe_not_ready|test_mode|free_period_decision; 422; 503
//   admin-stripe-check   POST session admin {}                     → {stripeCheck}; 409 stripe_not_ready; 503; 6 per hour
declare(strict_types=1);
use MatDraw\{Billing,Members,RouteContext,Settings};

return [
 'admin-settings'=>['method'=>'GET','auth'=>'peek','user'=>'admin','handler'=>fn(RouteContext $ctx):array=>Settings::view($ctx->pdo(),$ctx->file,time())],
 'admin-settings-save'=>['method'=>'POST','auth'=>'session','user'=>'admin','max'=>4096,'handler'=>function(RouteContext $ctx):array{
  $u=$ctx->user();$pdo=$ctx->pdo();$ctx->releaseSession();
  return Billing::guard(fn()=>Settings::save($pdo,$ctx->file,$u,$ctx->body,time()));
 }],
 'admin-stripe-check'=>['method'=>'POST','auth'=>'session','user'=>'admin','max'=>1024,'handler'=>function(RouteContext $ctx):array{
  $u=$ctx->user();$pdo=$ctx->pdo();Members::limit($pdo,$ctx->config,'admin-stripe-check',$u['id'],6,3600);$ctx->releaseSession();
  return ['stripeCheck'=>Billing::guard(fn()=>Settings::stripeCheck($pdo,$ctx->file,time()))];
 }],
];
