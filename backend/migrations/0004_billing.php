<?php
// Billing side tables (plan §2.5; billing_accounts itself is created by 0002). No payloads and no personal data:
//   stripe_events  idempotency of webhooks and of the /v1/events pull (ids, type, mode, source 'webhook'|'pull'),
//                  never the event body (it carries e-mails and addresses); pruned after 90 days;
//   billing_audit  who changed what (actor: users.id | 'stripe' | 'cron' | 'cli' | 'system'), short ascii action codes
//                  such as exempt.grant, exempt.revoke, checkout.create, status.change, customer.replace, orphan,
//                  cancel.request, and ids only in detail;
//   billing_kv     price id cache, events cursor, circuit breaker (stripe_down_until), per-account admin overrides.
// Additive only: an older release ignores these tables, so no floor is needed.
declare(strict_types=1);
use MatDraw\Migrator;
return ['id'=>4,'name'=>'billing','destructive'=>false,
 'up'=>function(Migrator $m):void{
  $m->exec("CREATE TABLE IF NOT EXISTS stripe_events (
 event_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 type VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 livemode TINYINT(1) NOT NULL,
 source VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 received_at BIGINT NOT NULL,
 processed_at BIGINT NULL,
 attempts INT NOT NULL DEFAULT 1,
 error VARCHAR(200) NULL,
 KEY stripe_events_received (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  $m->exec("CREATE TABLE IF NOT EXISTS billing_audit (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 user_id VARCHAR(40) NULL,
 actor VARCHAR(40) NOT NULL,
 action VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 old_status VARCHAR(32) NULL,
 new_status VARCHAR(32) NULL,
 detail VARCHAR(500) NULL,
 created_at BIGINT NOT NULL,
 KEY billing_audit_user (user_id,created_at),
 KEY billing_audit_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  $m->exec("CREATE TABLE IF NOT EXISTS billing_kv (
 k VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 v VARCHAR(1000) NOT NULL,
 updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
 }];
