<?php
// Test-only fixture jobs of the slice settings-backend (PLAN-REJESTRACJA-ROLE §3, §12; loaded by tests/helpers/fixture.php;
// CLI, test database only).
//   settings-row {}                         the app_settings row with data decoded, or null
//   settings-set {data, version?}           writes the row directly (no checks, no audit), as a saved panel would
//   settings-reset {}                       deletes the row (config.php decides again)
//   settings-table {drop: bool}             drops app_settings (code ahead of migration 0008) or creates it again with 0008
//   settings-config {set:{key:value|null}}  rewrites MATDRAW_CONFIG atomically (allow-listed switch keys); returns the old values
//   settings-free-set {}                    Billing::freePeriodSet with config.php (groups A and B, scheduled)
//   settings-audit {after?}                 account_audit rows of settings.* with an id above `after`, oldest first
declare(strict_types=1);
use MatDraw\{Billing,Migrator};
const FIXTURE_SETTINGS_CONFIG_KEYS=['signup_enabled','billing_enabled','billing_enforce','signup_force_off','signup_free_beta','support_email'];
return [
 'settings-row'=>function(PDO $pdo):?array{
  $r=$pdo->query('SELECT version,data,updated_at,updated_by FROM app_settings WHERE id=1')->fetch(PDO::FETCH_ASSOC);if(!$r)return null;
  $r['version']=(int)$r['version'];$r['data']=json_decode((string)$r['data'],true);return $r;
 },
 'settings-set'=>function(PDO $pdo,array $p):array{
  $data=json_encode((object)($p['data']??[]),JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);$v=(int)($p['version']??1);
  $pdo->prepare('INSERT INTO app_settings (id,version,data,updated_at,updated_by) VALUES (1,?,?,?,NULL) ON DUPLICATE KEY UPDATE version=VALUES(version),data=VALUES(data),updated_at=VALUES(updated_at)')->execute([$v,$data,time()]);
  return ['version'=>$v];
 },
 'settings-reset'=>fn(PDO $pdo):array=>['deleted'=>$pdo->exec('DELETE FROM app_settings')],
 'settings-table'=>function(PDO $pdo,array $p):array{
  if(!empty($p['drop'])){$pdo->exec('DROP TABLE IF EXISTS app_settings');return ['dropped'=>true];}
  $m=require dirname(__DIR__,2).'/backend/migrations/0008_settings.php';($m['up'])(new Migrator($pdo,dirname(__DIR__,2).'/backend/migrations'));return ['created'=>true];
 },
 'settings-config'=>fn(PDO $pdo,array $p):array=>fixture_config_set((array)($p['set']??[]),FIXTURE_SETTINGS_CONFIG_KEYS,'settings-config'),
 'settings-free-set'=>fn(PDO $pdo,array $p,array $c):array=>Billing::freePeriodSet($pdo,$c,time()),
 'settings-audit'=>function(PDO $pdo,array $p):array{
  $q=$pdo->prepare("SELECT id,actor_id,action,target_user_id,note FROM account_audit WHERE action LIKE 'settings.%' AND id>? ORDER BY id");$q->execute([(int)($p['after']??0)]);
  return array_map(fn($r)=>['id'=>(int)$r['id']]+$r,$q->fetchAll(PDO::FETCH_ASSOC));
 },
];
