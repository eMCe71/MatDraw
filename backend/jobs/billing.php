<?php
// Payment jobs (plan §3.7, §6.3), run by MatDraw\Jobs after a response has been sent (needsFlush: never on a SAPI that
// cannot send early) or by bin/cron.php. Both do nothing while billing_enabled is false or the Stripe circuit breaker is
// open (stripe_down_until in billing_kv), use the background client (no retries, 3 s / 8 s) and start no further
// account or event after about 2 s of work (BillingSync::JOB_BUDGET; at least one per run).
//   billing-due    (10 min) up to 5 accounts: retries of Stripe customer deletions (stripe_redact_pending, at most 2
//                  slots) first, then accounts whose next_sync_at passed;
//   billing-events (15 min) /v1/events forward from the cursor in pages of 20, then stripe_events older than 90 days
//                  are pruned.
declare(strict_types=1);
use MatDraw\BillingSync;
return [
 'billing-due'=>['every'=>600,'needsFlush'=>true,'run'=>fn(PDO $pdo,array $c,int $now):string=>BillingSync::dueJob($pdo,$c,$now)],
 'billing-events'=>['every'=>900,'needsFlush'=>true,'run'=>fn(PDO $pdo,array $c,int $now):string=>BillingSync::eventsJob($pdo,$c,$now)],
];
