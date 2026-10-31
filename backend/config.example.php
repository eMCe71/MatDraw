<?php
// Copy to config.php, outside the public document root. Never commit real secrets.
// In production the deploy links backend/config.php to ~/matdraw/shared/config.php (chmod 600).
// Every key after app_key is optional: missing keys take the defaults of backend/src/Config.php (MatDraw\Config::DEFAULTS),
// which are the values shown here. matdraw_config() refuses unsafe combinations (see "Switches" below).
return [
 'app_url' => 'https://matbravo.com',
 'db' => [
  'dsn' => 'mysql:host=localhost;dbname=matdraw;charset=utf8mb4',
  'user' => 'matdraw',
  'password' => 'REPLACE_WITH_DATABASE_PASSWORD',
 ],
 // Generate with: php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'
 'app_key' => 'REPLACE_WITH_RANDOM_64_HEX_CHARACTERS',
 'allow_insecure_http' => false,
 // Optional separate credentials with DDL rights (ALTER, CREATE, INDEX, REFERENCES), used only by bin/migrate.php.
 // null = use 'db'. Same shape as 'db'.
 'db_migrate' => null,

 // --- Sessions -------------------------------------------------------------------------------------------------
 // Staff (admin, editor, club): idle and absolute limits, browser-session cookie.
 'session_idle_seconds' => 1800,
 'session_max_seconds' => 43200,
 // Members: 14 days idle, 30 days at most; their cookie expires with the session.
 'member_session_idle_seconds' => 1209600,
 'member_session_max_seconds' => 2592000,
 // Housekeeping deletes anonymous session files after this many seconds (staff after session_max_seconds,
 // every file after member_session_idle_seconds). Only in the app's own session directory.
 'anon_session_seconds' => 10800,
 // Own session directory (files handler only). null = <directory of the real config.php>/sessions when it exists
 // and is writable (in production ~/matdraw/shared/sessions), else PHP's default path (then nothing is cleaned up).
 'session_dir' => null,

 // --- Accounts and sign-up -------------------------------------------------------------------------------------
 // Self-service sign-up. Requires billing_enforce=true (or signup_free_beta with billing_enabled=false) and support_email.
 'signup_enabled' => false,
 // Owner's test window: sign-up only through #signup?invite=<token> (at least 24 characters; with signup_enabled=false
 // it needs billing_enforce=true, so invitees do not get free full access; needs support_email).
 'signup_invite_token' => null,
 // Explicit permission to open sign-up without enforced payments (a free beta; only with billing_enabled=false).
 'signup_free_beta' => false,
 // Help address shown at "Forgot your password?"; the Admin answers password requests only to the account's address.
 'support_email' => null,
 // Sign-up limits: per IP (IPv6 grouped by /64) per hour and per day, and for all sign-ups per hour.
 'signup_limit_ip_hour' => 30,
 'signup_limit_ip_day' => 100,
 'signup_limit_global_hour' => 200,
 // Username availability checks per 10 minutes: per session and per IP.
 'username_check_limit_session' => 30,
 'username_check_limit_ip' => 300,
 // Login attempts per IP per 15 minutes (many phones share one IP in a sports hall); IP + e-mail stays at 8.
 'login_limit_ip' => 100,
 // Unpaid member accounts without activity are deleted after this many days (only while billing_enforce=true).
 'abandoned_member_days' => 30,
 // Profile photos. Stored outside the release; null = <directory of the real config.php>/uploads
 // (in production ~/matdraw/shared/uploads). A directory inside the document root is refused.
 'uploads_dir' => null,
 'avatars_enabled' => true,

 // --- Chat and clients -----------------------------------------------------------------------------------------
 // Emergency switch for every chat route (503 before the database). The file ~/matdraw/shared/chat-off does the same.
 'chat_force_off' => false,
 // Oldest client contract the API accepts (X-MatBravo-Client header); raise only when a route contract changes.
 'min_client_api' => 1,
 // Client IP behind the host's proxy: header name (e.g. 'X-Forwarded-For') trusted only when REMOTE_ADDR is one of
 // trusted_proxies (IPs or CIDR ranges). Off by default.
 'trusted_proxy_header' => null,
 'trusted_proxies' => [],

 // --- Payments (Stripe) ----------------------------------------------------------------------------------------
 // Switches (enable in this order, see DEPLOY-PL.md): billing_enabled shows plans and allows checkout;
 // billing_enforce requires payment for full access and needs billing_enabled=true.
 'billing_enabled' => false,
 'billing_enforce' => false,
 // 'test' or 'live'; must match the key prefix (rk_test_/rk_live_) and the mode of Stripe events.
 'billing_mode' => 'test',
 // Restricted key (rk_...) printed by bin/stripe-setup.php. Never commit it, never put it into GitHub secrets.
 'stripe_secret_key' => 'REPLACE_WITH_rk_test_key',
 // Webhook signing secrets (whsec_...); two during a rotation. [] = the webhook route answers 404.
 'stripe_webhook_secrets' => [],
 // https only; http is accepted only with allow_insecure_http and a loopback host (the local Stripe stub in tests).
 'stripe_api_base' => 'https://api.stripe.com',
 // Pinned API version; confirm it in the Stripe Workbench on the setup day.
 'stripe_api_version' => '2026-09-30.endive',
 // Price lookup keys per currency (lower-case letters, digits and _).
 'stripe_prices' => ['pln' => 'matbravo_monthly_pln', 'usd' => 'matbravo_monthly_usd'],
 // Amounts shown in the interface, in the smallest unit (8.99 PLN, 2.99 USD); stripe-setup.php checks them.
 'billing_amounts' => ['pln' => 899, 'usd' => 299],
 // Customer Portal configuration (bpc_...) printed by stripe-setup.php.
 'stripe_portal_configuration' => null,
 // Interactive calls (checkout, confirm, portal, Admin): timeout in seconds, up to 2 retries.
 'stripe_timeout_seconds' => 20,
 // Background calls (lazy sync, jobs): connect and total timeout in seconds, no retries.
 'stripe_background_connect_timeout' => 3,
 'stripe_background_timeout' => 8,
 // After a network error or 5xx, background syncs pause for this many seconds (circuit breaker).
 'stripe_down_seconds' => 600,
 // Optional path to a CA bundle; null = the system store.
 'stripe_ca_bundle' => null,
 // Days of access after a failed renewal (past_due) and after the end of a free period (grace).
 'billing_grace_days' => 7,
 // Hours of access kept after period_end while Stripe cannot be reached or a sync is pending.
 'billing_stale_leeway_hours' => 72,
 // Seconds between lazy syncs of one account.
 'billing_sync_min_interval' => 600,
 'billing_allow_promotion_codes' => false,
 // 'auto' or 'required'.
 'billing_address_collection' => 'required',

 // --- Tests only -----------------------------------------------------------------------------------------------
 // Milliseconds added to each background job, so a test can prove the session lock is released first. Keep 0.
 'job_test_sleep_ms' => 0,
];
