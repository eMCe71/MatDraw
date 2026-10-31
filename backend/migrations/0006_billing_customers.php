<?php
// Every Stripe Customer an account ever had (plan §3.8 step 4, §10): a customer is replaced when its fixed currency
// differs from the plan currency, when Stripe refuses that currency or when payments switch mode, and the old one keeps
// the account e-mail and the billing address Checkout collected. Account deletion deletes every customer listed here
// (billing-due retries a failure), not only billing_accounts.stripe_customer_id. Ids and the mode only, no personal
// data; redacted_at is set once Stripe confirms the deletion. The current customers of existing rows are copied in.
// No floor: the release before this migration ignores the table, and a repeated run changes nothing (IF NOT EXISTS,
// INSERT IGNORE on the primary key).
declare(strict_types=1);
use MatDraw\Migrator;
return ['id'=>6,'name'=>'billing_customers','destructive'=>false,
 'up'=>function(Migrator $m):void{
  $m->exec("CREATE TABLE IF NOT EXISTS billing_customers (
 customer_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 user_id VARCHAR(40) NOT NULL,
 livemode TINYINT(1) NOT NULL,
 created_at BIGINT NOT NULL,
 redacted_at BIGINT NULL,
 KEY billing_customers_user (user_id),
 CONSTRAINT fk_billing_customers_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  $m->exec("INSERT IGNORE INTO billing_customers (customer_id,user_id,livemode,created_at,redacted_at)
 SELECT stripe_customer_id,user_id,livemode,created_at,IF(deleted_at IS NOT NULL AND stripe_redact_pending=0,updated_at,NULL) FROM billing_accounts WHERE stripe_customer_id IS NOT NULL");
 }];
