<?php
declare(strict_types=1);
namespace MatDraw;
use PDO;

/**
 * Effective configuration (plan §3.1–§3.3, §17). WAVE 1 STUB (slice data-domain): effective() has the final signature and
 * derives the same keys as the full implementation, but only from config.php ($c); the database row app_settings
 * (migration 0008) and save() come with the slice settings-backend, which replaces this file. Idempotent:
 * effective(pdo, effective(pdo, c)) == effective(pdo, c).
 *  signup_enabled   signup 'on' (config signup_enabled) and no signup_force_off
 *  billing_enforce  payments 'paid' (config billing_enforce); without billing_enabled: false, signup closed,
 *                   settings_degraded 'billing-missing' (registration fails closed, access fails open, R2)
 *  settings_degraded  'billing-missing' | 'force-off' (signup on, but signup_force_off)
 *  signup_free_beta = !billing_enforce;  support_email = config support_email ?: hello@matbravo.com (D4)
 *  organizers       'on' | 'paused' (default 'on'): new community tournaments of unconfirmed organizers may be published
 *  organizers_trust_required  bool (default true, §17): false makes every organizer that is not blocked work as a
 *                   confirmed one (home page, chat lobby, self-entries of minors)
 *  signup_mode      'off' | 'free' | 'paid'
 * flags(effective) gives Domain's read-only $db['flags'] {organizers, trustRequired} (Repository::transaction($fn, $actor,
 * $flags)); the JS mirror reads db.flags the same way (dist/workspace.js).
 */
final class Settings {
 public const SUPPORT_DEFAULT='hello@matbravo.com';
 public static function effective(?PDO $pdo,array $c):array {
  $signup=!empty($c['signup_enabled'])?'on':'off';$eff=$c;
  $eff['signup_enabled']=$signup==='on'&&empty($c['signup_force_off']);
  $eff['billing_enforce']=!empty($c['billing_enforce']);
  if($eff['billing_enforce']&&empty($c['billing_enabled'])){$eff['billing_enforce']=false;$eff['signup_enabled']=false;$eff['settings_degraded']='billing-missing';}
  if(!empty($c['signup_force_off'])&&$signup==='on')$eff['settings_degraded']??='force-off';
  $eff['signup_free_beta']=!$eff['billing_enforce'];
  $eff['support_email']=is_string($c['support_email']??null)&&$c['support_email']!==''?$c['support_email']:self::SUPPORT_DEFAULT;
  $eff['organizers']=($c['organizers']??null)==='paused'?'paused':'on';
  $eff['organizers_trust_required']=($c['organizers_trust_required']??true)!==false;
  $eff['signup_mode']=!$eff['signup_enabled']?'off':($eff['billing_enforce']?'paid':'free');
  return $eff;
 }
 public static function flags(array $eff):array{return ['organizers'=>($eff['organizers']??'on')==='paused'?'paused':'on','trustRequired'=>($eff['organizers_trust_required']??true)!==false];}
}
