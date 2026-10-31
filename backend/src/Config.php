<?php
declare(strict_types=1);
namespace MatDraw;

/**
 * Server configuration (plan §6.8, Załącznik A). matdraw_config() returns array_replace(Config::DEFAULTS,$config):
 * every key below exists in the array the code reads, so a production config.php written before a release never
 * yields warnings or different defaults in different files. Code reads new keys only through that merged array.
 * validate() rejects the switch combinations of §6.8/§6.10 and an inconsistent Stripe setup (03 §4.1); its messages
 * are generic on purpose (no key, secret or value ever reaches a log).
 */
final class Config {
 public const DEFAULTS=[
  // Existing keys (unchanged behaviour).
  'allow_insecure_http'=>false,'session_idle_seconds'=>1800,'session_max_seconds'=>43200,
  // Accounts, sign-up and sessions (§3).
  'signup_enabled'=>false,'signup_invite_token'=>null,'signup_free_beta'=>false,'support_email'=>null,
  'signup_limit_ip_hour'=>30,'signup_limit_ip_day'=>100,'signup_limit_global_hour'=>200,
  'username_check_limit_session'=>30,'username_check_limit_ip'=>300,'login_limit_ip'=>100,
  'member_session_idle_seconds'=>1209600,'member_session_max_seconds'=>2592000,'anon_session_seconds'=>10800,
  'session_dir'=>null,'uploads_dir'=>null,'avatars_enabled'=>true,'abandoned_member_days'=>30,
  // Chat switch, client contract, client IP behind a proxy, migration credentials.
  'chat_force_off'=>false,'min_client_api'=>Routes::MIN_CLIENT_API,'trusted_proxy_header'=>null,'trusted_proxies'=>[],'db_migrate'=>null,
  // Billing (§6, report 03 §4.1).
  'billing_enabled'=>false,'billing_enforce'=>false,'billing_mode'=>'test','stripe_secret_key'=>'REPLACE_WITH_rk_test_key',
  'stripe_webhook_secrets'=>[],'stripe_api_base'=>'https://api.stripe.com','stripe_api_version'=>'2026-09-30.endive',
  'stripe_prices'=>['pln'=>'matbravo_monthly_pln','usd'=>'matbravo_monthly_usd'],'billing_amounts'=>['pln'=>899,'usd'=>299],
  'stripe_portal_configuration'=>null,'stripe_timeout_seconds'=>20,'stripe_background_connect_timeout'=>3,'stripe_background_timeout'=>8,
  'stripe_down_seconds'=>600,'stripe_ca_bundle'=>null,'billing_grace_days'=>7,'billing_stale_leeway_hours'=>72,'billing_sync_min_interval'=>600,
  'billing_allow_promotion_codes'=>false,'billing_address_collection'=>'required',
  // Tests only: slows a background job down so a test can prove that the session lock is released first (§3.7).
  'job_test_sleep_ms'=>0,
 ];
 private const CURRENCIES=['pln','usd'];
 /** Path of config.php: MATDRAW_CONFIG, else backend/config.php (in production a symlink to ~/matdraw/shared/config.php). */
 public static function path():string{return getenv('MATDRAW_CONFIG')?:dirname(__DIR__).'/config.php';}
 /** Throws RuntimeException('Invalid billing configuration.'|'Invalid signup configuration.') for a merged config $c. */
 public static function validate(array $c):void {
  $bad=fn()=>throw new \RuntimeException('Invalid billing configuration.');
  if(!empty($c['billing_enforce'])&&empty($c['billing_enabled']))$bad();// members would lose access without a way to pay
  if(!empty($c['billing_enabled'])){
   $mode=$c['billing_mode'];if(!in_array($mode,['test','live'],true))$bad();
   if(!is_string($c['stripe_secret_key'])||!preg_match('/^(sk|rk)_'.$mode.'_[A-Za-z0-9]+$/D',$c['stripe_secret_key']))$bad();
   if(!is_array($c['stripe_webhook_secrets'])||!array_is_list($c['stripe_webhook_secrets']))$bad();
   foreach($c['stripe_webhook_secrets'] as $s)if(!is_string($s)||!preg_match('/^whsec_[A-Za-z0-9+\/=_-]+$/D',$s))$bad();
   if(!self::apiBaseAllowed($c['stripe_api_base'],!empty($c['allow_insecure_http'])))$bad();
   if(!is_array($c['stripe_prices'])||!$c['stripe_prices'])$bad();
   foreach($c['stripe_prices'] as $cur=>$key)if(!in_array($cur,self::CURRENCIES,true)||!is_string($key)||!preg_match('/^[a-z0-9_]{1,200}$/D',$key))$bad();
   if(!is_array($c['billing_amounts']))$bad();
   foreach($c['billing_amounts'] as $cur=>$n)if(!in_array($cur,self::CURRENCIES,true)||!is_int($n)||$n<1)$bad();
   if(!in_array($c['billing_address_collection'],['auto','required'],true))$bad();
  }
  $signup=fn()=>throw new \RuntimeException('Invalid signup configuration.');
  $token=$c['signup_invite_token'];if($token!==null&&$token!==''&&(!is_string($token)||strlen($token)<24))$signup();
  // Self-service sign-up only together with enforced payments, unless the owner explicitly runs a free beta (P16).
  if(!empty($c['signup_enabled'])&&empty($c['billing_enforce'])&&empty($c['signup_free_beta']))$signup();
  // Without e-mail the support address is the only way back into an account (§3.10): a start gate for sign-up and invites.
  if((!empty($c['signup_enabled'])||($token!==null&&$token!==''))&&(!is_string($c['support_email'])||!filter_var($c['support_email'],FILTER_VALIDATE_EMAIL)))$signup();
 }
 /** https:// always; http:// only with allow_insecure_http and a loopback host (the Stripe stub in tests). */
 public static function apiBaseAllowed(mixed $base,bool $insecure):bool {
  if(!is_string($base))return false;$u=parse_url($base);if(!$u||empty($u['host'])||isset($u['user'])||isset($u['pass']))return false;
  if(($u['scheme']??'')==='https')return true;
  return ($u['scheme']??'')==='http'&&$insecure&&in_array(strtolower(trim($u['host'],'[]')),['127.0.0.1','localhost','::1'],true);
 }
}
