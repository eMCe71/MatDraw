<?php
// Accounts foundation (plan §2.3): member role, nullable club for members, profile, billing, job and audit tables.
// Every step is idempotent. No new foreign keys on existing tables; new tables reference users(id) by
// VARCHAR(40) utf8mb4_unicode_ci exactly like users.id. Times are epoch seconds computed in PHP
// (UNIX_TIMESTAMP() only in the one-off seed below).
declare(strict_types=1);
use MatDraw\Migrator;
return ['id'=>2,'name'=>'accounts','destructive'=>false,
 // floor: once a member account exists, code older than this migration would load it into the workspace (§2.8).
 'floor'=>fn(PDO $pdo):bool=>(bool)$pdo->query("SELECT 1 FROM users WHERE role='member' LIMIT 1")->fetchColumn(),
 'up'=>function(Migrator $m):void{
  // (a) new role appended at the end of the ENUM (metadata-only change)
  if(!$m->enumHas('users','role','member'))$m->exec("ALTER TABLE users MODIFY role ENUM('admin','editor','club','member') NOT NULL");
  // (b) members have no workspace club; the existing foreign key stays as it is
  if(!$m->columnNullable('users','club_id'))$m->exec('ALTER TABLE users MODIFY club_id VARCHAR(40) NULL');
  // (c) account profile (side table; the workspace never reads it). public_id: random base62, the only user id sent
  // to others; username stored lower-case, NULL until set; country ISO 3166-1 alpha-2 (+ XK); sports 'slug1,slug2'
  // (1–5, first = main); club_text free text, never linked to a workspace club; name_display defaults to the
  // initial ("Marta K."); avatar '<32 hex>.webp|.jpg'; pw_reset_at = temporary password from the Admin (§3.10).
  $m->exec("CREATE TABLE IF NOT EXISTS user_profiles (
 user_id VARCHAR(40) NOT NULL PRIMARY KEY,
 public_id CHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 username VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
 first_name VARCHAR(50) NULL,
 last_name VARCHAR(50) NULL,
 country CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL,
 sports VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
 club_text VARCHAR(100) NULL,
 show_club TINYINT(1) NOT NULL DEFAULT 0,
 name_display ENUM('full','initial') NOT NULL DEFAULT 'initial',
 avatar VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,
 username_changed_at BIGINT NULL,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL,
 last_login_at BIGINT NULL,
 pw_reset_at BIGINT NULL,
 UNIQUE KEY user_profiles_public_id (public_id),
 UNIQUE KEY user_profiles_username (username),
 KEY user_profiles_last_name (last_name),
 KEY user_profiles_last_login (last_login_at),
 CONSTRAINT fk_user_profiles_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  // (d) billing state, one row per account (03 §11). currency 'pln'|'usd'; stripe_redact_pending = Stripe customer
  // deletion to retry (§3.8); deleted_at = tombstone row after account deletion (no personal data).
  $m->exec("CREATE TABLE IF NOT EXISTS billing_accounts (
 user_id VARCHAR(40) NOT NULL PRIMARY KEY,
 billing_exempt TINYINT(1) NOT NULL DEFAULT 0,
 exempt_reason VARCHAR(200) NULL,
 exempt_by VARCHAR(40) NULL,
 exempt_at BIGINT NULL,
 exempt_until BIGINT NULL,
 currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NULL,
 livemode TINYINT(1) NOT NULL DEFAULT 0,
 stripe_customer_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
 customer_seq INT NOT NULL DEFAULT 0,
 stripe_subscription_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
 sub_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'none',
 price_lookup_key VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NULL,
 current_period_start BIGINT NULL,
 current_period_end BIGINT NULL,
 cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0,
 cancel_at BIGINT NULL, canceled_at BIGINT NULL, ended_at BIGINT NULL,
 latest_invoice_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
 pending_checkout_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
 pending_checkout_expires BIGINT NULL,
 last_synced_at BIGINT NOT NULL DEFAULT 0,
 next_sync_at BIGINT NULL,
 sync_claimed_at BIGINT NOT NULL DEFAULT 0,
 sync_error VARCHAR(200) NULL,
 stripe_redact_pending TINYINT(1) NOT NULL DEFAULT 0,
 deleted_at BIGINT NULL,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL,
 UNIQUE KEY billing_accounts_customer (stripe_customer_id),
 UNIQUE KEY billing_accounts_subscription (stripe_subscription_id),
 KEY billing_accounts_due (next_sync_at),
 CONSTRAINT fk_billing_accounts_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  // (e) existing staff accounts are free for now (§3.2, P2): an explicit row for audit and reports
  $m->exec("INSERT IGNORE INTO billing_accounts (user_id,billing_exempt,exempt_reason,exempt_at,created_at,updated_at)
 SELECT id,1,'grandfathered',UNIX_TIMESTAMP(),UNIX_TIMESTAMP(),UNIX_TIMESTAMP() FROM users WHERE role IN ('admin','editor','club')");
  // (f) "on the side" jobs without cron (§3.7); Jobs adds missing rows itself with INSERT IGNORE
  $m->exec("CREATE TABLE IF NOT EXISTS job_runs (
 name VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 last_run_at BIGINT NOT NULL DEFAULT 0,
 claimed_until BIGINT NOT NULL DEFAULT 0,
 last_result VARCHAR(200) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  // (g) account actions log (Admin and the member); no e-mails, passwords or content (§3.8–§3.10).
  // actor_id: users.id | 'self' | 'system'; action: create, active, password.reset, email.change, profile.fix,
  // delete, self.delete, self.email
  $m->exec("CREATE TABLE IF NOT EXISTS account_audit (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 actor_id VARCHAR(40) NOT NULL,
 action VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 target_user_id VARCHAR(40) NULL,
 note VARCHAR(200) NULL,
 created_at BIGINT NOT NULL,
 KEY account_audit_target (target_user_id,created_at),
 KEY account_audit_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
 }];
