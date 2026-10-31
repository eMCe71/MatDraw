# 03 - Stripe subscription billing without an SDK

Status: research and design only. No application code was changed. Date: 2026-10-31.
Scope: owner requirement 4 (paid accounts: 8.99 PLN/month in Poland, 2.99 USD/month elsewhere; the admin can create free accounts and comp existing ones; MEDUCASE Sp. z o.o.'s existing Stripe account). This doc also touches requirements 3 and 5 (which features payment unlocks) and the hosting constraints in the project context.

Legend:
- **[verified]**: confirmed in this repository, or in an official Stripe page whose search snippet was read in this session.
- **[third party]**: found only on aggregator or blog pages.
- **[unverified]**: my own knowledge. It must be checked in the Stripe Dashboard or Workbench, or in test mode, before we rely on it.

WebFetch to docs.stripe.com was blocked in this session. Everything marked [verified] about Stripe comes from search snippets of docs.stripe.com pages (sources at the end).

---

## 1. Summary

- **Hosted Stripe Checkout + hosted Customer Portal, called with pure PHP cURL.**
  - No Stripe.js and no Composer.
  - **No CSP change** is needed. We navigate to `checkout.stripe.com` / `billing.stripe.com` with `location.assign()` after a same-origin `fetch`.
  - PCI scope stays at the minimum (SAQ A): card data never touches our server.
- **Two recurring Prices under one Product**, found by lookup key, so no price IDs are hardcoded:
  - `matbravo_monthly_pln` = 899 PLN/month;
  - `matbravo_monthly_usd` = 299 USD/month.
  - We do not use `currency_options` on one Price (reasons in section 3).
  - Currency defaults from the profile country (PL -> PLN, everything else -> USD). The user can switch manually before subscribing.
- **Billing is correct without webhooks.** The host answers 403 to datacenter IPs, so incoming webhooks are probably blocked. State comes from **pulling** Stripe:
  1. reconcile on the Checkout success return;
  2. reconcile on the return from the Portal;
  3. a lazy per-user re-sync driven by a stored `next_sync_at` (rate-limited);
  4. an admin "Resync" button;
  5. `bin/stripe-sync.php`, which a DirectAdmin cron job can run. It also **pulls `/v1/events`** ("webhooks by polling").
  - Webhooks become an optional accelerator **sharing the same handler and the same idempotency table**.
- **Every write re-fetches the Subscription from the API.** We never trust event payload order or shape. A stale-write guard (`last_synced_at <= fetch_started_at`) makes concurrent syncs safe.
- **API version pinned with a `Stripe-Version` header** (config key; proposed `2026-09-30.endive`, to be confirmed in Workbench on setup day).
  - Since `2025-03-31.basil`, `current_period_start/end` live on **subscription items**, not on the Subscription [verified].
  - Since basil, `invoice.subscription` moved to `invoice.parent.subscription_details.subscription` [verified].
  - The `endive` version removes `payment_method_types` from Checkout Session create [verified]. We never send it and rely on Dashboard ("dynamic") payment methods.
- **Payment methods for recurring PLN:**
  - cards, Apple Pay and Google Pay: yes;
  - **BLIK recurring**: exists since 2026, but needs a capability and account enablement through Stripe Support [verified]. Plan it as phase 2;
  - **Przelewy24: no recurring** [verified].
- **Data model.** Separate lean tables, never touched by `Repository::transaction()` or `snapshot()`:
  - `billing_accounts` (one row per user);
  - `stripe_events` (idempotency, no payloads stored);
  - `billing_audit`;
  - `billing_kv` (price-ID cache, events cursor).
  - A migration **grandfathers every existing user as free** (`billing_exempt=1`).
- **Two config switches for a safe rollout:**
  - `billing_enabled` shows the subscribe UI and allows checkout;
  - `billing_enforce` gates features.
  - Test mode and live mode are fully separate. Secrets live only in `~/matdraw/shared/config.php` (mode 600), never in GitHub. Runtime uses a **restricted key** (`rk_...`). A full key goes only to the one-off setup CLI, through STDIN.

---

## 2. Constraints recap (from the project context, relevant to billing)

| Constraint | Consequence for billing |
|---|---|
| PHP 8.3, no Composer, no Node on server | Own ~150-line `StripeClient` on ext-curl; own signature verifier. |
| `Repository::transaction()` locks `app_meta` and loads the whole workspace | Billing reads and writes use their own tables and single-row queries. A Stripe HTTP call must **never** happen inside a DB transaction or row lock. |
| CSP `connect-src 'self'; form-action 'self'` | Hosted pages reached by top-level navigation; no Stripe.js; no form POST that redirects to Stripe (section 5.4). |
| SameSite=Strict session cookie | The return from Stripe is a cross-site top-level navigation, so the cookie is **not** sent with the `index.html` request. The SPA's subsequent same-origin `fetch` does send it (section 5.5). |
| Host blocks datacenter IPs (403) | Webhooks are probably blocked. Billing must be correct by pulling (section 8). |
| Outbound HTTPS from the host to `api.stripe.com` | **[unverified] Must be tested first** (section 14, step 1). If outbound is blocked, the whole design (and any Stripe integration) needs a different host. |
| Docroot replaced on every deploy; auto-rollback is code-only | Billing state lives only in the DB and in `shared/config.php`; nothing in the release. Migrations must be additive (old code must survive a rollback against the new schema). |
| MySQL 8.0 and MariaDB 10.6 | Plain InnoDB types only: `BIGINT` epoch seconds (like `login_limits`), `VARCHAR`, `TINYINT(1)`. No `CHECK` reliance, no JSON column defaults, no `RETURNING`. |
| Canonical URL https without www (`.htaccess` 301) | The webhook URL must be exactly `https://matbravo.com/...`. Stripe treats a redirect as a failed delivery [unverified]. |

---

## 3. Product and Price model

### 3.1 Decision: one Product, two Prices, lookup keys

| Object | Values |
|---|---|
| Product | `id=matbravo_membership` (we choose the ID; idempotent lookup is `GET /v1/products/matbravo_membership`), `name=MatBravo`, `description="MatBravo account (monthly)"`, `metadata[matbravo_key]=membership` |
| Price PLN | `product=matbravo_membership`, `currency=pln`, `unit_amount=899`, `recurring[interval]=month`, `recurring[interval_count]=1`, `lookup_key=matbravo_monthly_pln`, `nickname="MatBravo monthly PLN"`, `metadata[matbravo_key]=monthly_pln` |
| Price USD | same with `currency=usd`, `unit_amount=299`, `lookup_key=matbravo_monthly_usd` |

- `tax_behavior` is **left unspecified** for now. It is a legal and tax decision for the later session (section 15). An unspecified `tax_behavior` can be set once later; `inclusive`/`exclusive` cannot be changed [unverified].
- Price amounts are immutable. A price change means a new Price created with `transfer_lookup_key=true`, so the key moves to it. Existing subscribers stay on the old Price until migrated. The setup CLI handles this with `--reprice` (section 4).

### 3.2 Why not one Price with `currency_options`

- `currency_options` (manual currency prices) is real and works with Checkout [verified]. Checkout then **localizes automatically by customer location**, unless the Session is created with a top-level `currency` override [verified]. However:
  1. I could **not** confirm that the `currency` override and `currency_options` behave identically in `mode=subscription` [unverified]. The owner wants a **manual** switch, so automatic localization would fight it: a Pole on holiday in Germany could be shown USD, or the reverse.
  2. With two Prices, the Price itself *is* the currency choice: deterministic, visible in the Dashboard, and trivial to report on. Each Subscription item carries a lookup key we can check.
  3. Changing one amount without touching the other is simpler with separate Prices.
- **Recommendation: two Prices** (the task's fallback rule applies). Our code resolves `lookup_key -> price id` with `GET /v1/prices?lookup_keys[]=...&active=true` and caches the result for 24 h in `billing_kv`. If Stripe answers `resource_missing` for a cached ID, the cache is invalidated and the call is retried once.
- **Adaptive Pricing** (Stripe-side currency conversion) must stay **off** for our sessions. The Adaptive Pricing page lists subscription mode and explicitly defined manual prices among the conditions that rule it out [verified snippet, ambiguous]. Check in the Dashboard that it is disabled.

### 3.3 Currency selection

- Default: `profile.country === 'PL' ? 'pln' : 'usd'`. The profile country comes from requirement 5 (another research doc). If it is missing, use the UI language: `pl` -> PLN.
- The billing page shows a two-option switch ("8,99 zł / mies." | "$2.99 / month"). The chosen currency is stored in `billing_accounts.currency` when checkout starts.
- **Locked while a subscription is active / trialing / past_due.** To switch: cancel in the Portal (at period end), then subscribe again in the other currency after it ends.
- A Stripe Customer gets a fixed currency after its first invoice [unverified: newer accounts may allow multiple currencies]. If checkout in the other currency fails with a currency error, create a **new** Customer for the user, store it, and write the old ID into `billing_audit`.
- Server-side validation: currency must be in `array_keys($config['stripe_prices'])`. The client never sends amounts or price IDs.

---

## 4. Setup automation: `backend/bin/stripe-setup.php`

Run once over SSH, per mode (first test, later live). It is idempotent: running it twice changes nothing.

```
/usr/local/php83/bin/php ~/domains/matbravo.com/backend/bin/stripe-setup.php --mode=test [--webhook | --no-webhook] [--rotate-webhook] [--reprice] [--dry-run]
# reads a FULL secret key (sk_test_... / sk_live_...) from STDIN, never from argv (argv is visible in `ps`) and never from config
```

Steps (every create sends an `Idempotency-Key`, e.g. `matbravo-setup-<step>-<mode>-v1`):

1. **Sanity checks.**
   - Key prefix matches `--mode` (`sk_test_`/`rk_test_` vs `sk_live_`/`rk_live_`).
   - `extension_loaded('curl')`.
   - `GET /v1/account` prints `settings.dashboard.display_name`, `country` (expect `PL`), `default_currency` (expect `pln`), and the `Stripe-Version` response header, which must equal the pinned version.
2. **Product.** `GET /v1/products/matbravo_membership`.
   - On 404: `POST /v1/products` with `id`, `name`, `description`, `metadata[matbravo_key]`.
   - If it exists but is inactive: `POST /v1/products/matbravo_membership active=true`.
3. **Prices**, one per configured currency. `GET /v1/prices?lookup_keys[]=<key>&active=true&limit=1`.
   - Found: verify `product`, `currency`, `unit_amount`, `recurring.interval=month`, `recurring.interval_count=1`, `type=recurring`. On a mismatch, stop with a clear message, unless `--reprice` is given. In that case create a new Price with `transfer_lookup_key=true` and print: "existing subscribers keep the old price".
   - Missing: `POST /v1/prices` with the parameters from 3.1.
4. **Customer Portal configuration.** `GET /v1/billing_portal/configurations?active=true&limit=100`, then match `metadata[matbravo_key]=portal_v1`. Update in place with `POST /v1/billing_portal/configurations/{id}`, or create:
   - `business_profile[headline]=MatBravo` (add `business_profile[privacy_policy_url]` and `[terms_of_service_url]` in the legal session);
   - `default_return_url=<app_url>/?billing=portal` [unverified: field name not confirmed in snippets; `return_url` on the session always overrides it];
   - `features[customer_update][enabled]=true`, `features[customer_update][allowed_updates][]=address`, `features[customer_update][allowed_updates][]=name`;
   - `features[invoice_history][enabled]=true`;
   - `features[payment_method_update][enabled]=true`;
   - `features[subscription_cancel][enabled]=true`, `features[subscription_cancel][mode]=at_period_end` [verified], `features[subscription_cancel][proration_behavior]=none`;
   - `features[subscription_cancel][cancellation_reason][enabled]=true`, `...[options][]=too_expensive`, `...=unused`, `...=other`;
   - `features[subscription_update][enabled]=false` (one plan only; currency switching is not a plan switch);
   - `login_page[enabled]=false`;
   - `metadata[matbravo_key]=portal_v1`.

   The script prints the `bpc_...` ID for config.
5. **Webhook endpoint** (only with `--webhook`; default **off** until AfterMarket confirms the IP whitelist, see section 9).
   - `GET /v1/webhook_endpoints?limit=100`, then match `url`.
   - Create: `POST /v1/webhook_endpoints` with:
     - `url=<app_url>/api/index.php?route=stripe-webhook`;
     - `api_version=<pinned>`;
     - `description=MatBravo billing`;
     - `metadata[matbravo_key]=webhook_v1`;
     - `enabled_events[]=` the list in 7.4.
   - **The signing secret is returned only in the create response.** The script prints it once with the line "paste into stripe_webhook_secrets".
   - If the endpoint exists: update `enabled_events` when they differ. `--rotate-webhook` deletes and recreates it. Rolling in the Dashboard is the alternative; it supports an overlap period, which is why config holds a *list* of secrets.
6. **Print a ready-to-paste config block** (no secrets except the webhook secret just created), plus a checklist of Dashboard-only settings (section 12).

**Restricted runtime key** (create in Dashboard -> Developers -> API keys -> "Create restricted key"; permission names [unverified]):

| Resource | Permission |
|---|---|
| Customers | Write |
| Checkout Sessions | Write |
| Customer portal | Write |
| Subscriptions | Write (admin "cancel at period end" when comping; read-only is enough otherwise) |
| Prices, Products | Read |
| Invoices | Read |
| Events | Read (events pull) |
| Everything else | None |

The full `sk_` key is used only for the setup run (pasted to STDIN) and is never stored on the server.

### 4.1 New config keys (`backend/config.example.php` + `matdraw_config()` validation)

```php
 'billing_enabled' => false,          // shows subscribe UI, allows checkout/portal/sync
 'billing_enforce' => false,          // gates paid features for non-exempt users (turn on after live test)
 'billing_mode' => 'test',            // 'test' | 'live'; must match the key prefix and event.livemode
 'stripe_secret_key' => 'REPLACE_WITH_rk_test_...',   // restricted key; NEVER commit, never in GitHub secrets
 'stripe_webhook_secrets' => [],      // ['whsec_new', 'whsec_old'] during rotation; [] = webhook route answers 404
 'stripe_api_base' => 'https://api.stripe.com',       // tests: 'http://127.0.0.1:12111' (only allowed with allow_insecure_http)
 'stripe_api_version' => '2026-09-30.endive',         // pin; confirm in Workbench on setup day
 'stripe_prices' => ['pln' => 'matbravo_monthly_pln', 'usd' => 'matbravo_monthly_usd'],  // currency => lookup_key
 'stripe_portal_configuration' => null,               // 'bpc_...' printed by stripe-setup.php
 'stripe_timeout_seconds' => 20,      // interactive calls; the lazy sync uses min(this, 8)
 'stripe_ca_bundle' => null,          // optional path; default = system CA store
 'billing_grace_days' => 7,           // past_due access after the renewal attempt
 'billing_stale_leeway_hours' => 72,  // keep access if Stripe is unreachable after period end
 'billing_sync_min_interval' => 600,  // per-user lazy sync rate limit (seconds)
 'billing_allow_promotion_codes' => false,
 'billing_address_collection' => 'required', // 'auto' | 'required' (see 5.2)
```

Validation, done only when `billing_enabled`:
- the key prefix matches `billing_mode`;
- every webhook secret starts with `whsec_`;
- `stripe_api_base` is `https://` unless `allow_insecure_http`;
- every lookup key matches `^[a-z0-9_]{1,200}$`;
- currencies are in `{pln, usd}`.

On failure: `RuntimeException('Invalid billing configuration.')`, the same pattern as the existing checks.

**Test vs live:** each mode has its own Products, Prices, Customers, Portal configs and webhook endpoints. The same lookup keys and Product ID are used in both, so only the key and the mode change in config. Every `billing_accounts` row stores `livemode`. A row whose `livemode` differs from the current mode is treated as "no Stripe data", so test customers are ignored after switching to live, without a destructive reset.

---

## 5. Signup -> payment (Checkout)

### 5.1 Flow

```
SPA (logged-in, unpaid)          PHP /api                                  Stripe
 click "Subscribe" (currency) -> POST route=billing {op:'checkout',currency}  (CSRF + Origin checked as today)
                                 rate-limit 10/h/user (login_limits-style bucket)
                                 refuse if access state has a live subscription -> {portal:true}
                                 reuse pending session if open, same currency, expires_at > now+5min
                                 ensure Customer ------------------------------> POST /v1/customers (Idempotency-Key)
                                 POST /v1/checkout/sessions ----------------> {id, url, expires_at}
                                 store pending_checkout_id/expires
 <- {url}
 assert url starts with https://checkout.stripe.com/  ; location.assign(url)
 ... user pays on checkout.stripe.com ...
 <- 303 to https://matbravo.com/?billing=success&session_id=cs_...
 SPA boots, reads + strips params (history.replaceState)
 POST route=billing {op:'confirm',sessionId} -> GET /v1/checkout/sessions/{id}?expand[]=subscription&expand[]=subscription.latest_invoice
                                 verify ownership, upsert state (section 8.2)
 <- {billing state}  -> UI "Thanks! Active until ..."  (if status=incomplete: poll confirm every 3 s up to 30 s)
```

### 5.2 Customer create (first checkout only)

`POST /v1/customers` with:
- `email=<account email>`;
- `preferred_locales[]=pl|en`;
- `metadata[matbravo_user_id]=<users.id>`;
- `metadata[matbravo_env]=test|live`;
- header `Idempotency-Key: matbravo-customer-<userId>-<mode>-<n>`, where `<n>` is a counter in `billing_accounts` that is incremented only when we deliberately create a replacement Customer.

Privacy by design:
- nothing is sent to Stripe before the user clicks "Subscribe";
- metadata holds only our opaque ID, never names;
- the name and address are collected by Checkout itself.

### 5.3 Checkout Session parameters

`POST /v1/checkout/sessions`:

| Parameter | Value | Notes |
|---|---|---|
| `mode` | `subscription` | |
| `line_items[0][price]` | resolved price ID for the chosen currency | never from the client |
| `line_items[0][quantity]` | `1` | |
| `customer` | `cus_...` | always pass ours; avoids duplicate Customers |
| `customer_update[address]` | `auto` | saves the collected address onto the Customer (needed with `customer` + address collection) |
| `customer_update[name]` | `auto` | |
| `client_reference_id` | `<users.id>` | <= 200 chars; checked on return |
| `metadata[matbravo_user_id]`, `metadata[matbravo_env]` | ids only | |
| `subscription_data[metadata][matbravo_user_id]` | `<users.id>` | so every Subscription maps back to a user even without our DB |
| `subscription_data[description]` | `MatBravo` | optional |
| `success_url` | `<app_url>/?billing=success&session_id={CHECKOUT_SESSION_ID}` | literal placeholder, filled in by Stripe |
| `cancel_url` | `<app_url>/?billing=cancel` | |
| `locale` | `pl` or `en` (UI language) | |
| `billing_address_collection` | `required` (config) | the country evidence will be needed for VAT/OSS (section 15); costs one form block. `auto` if the owner prefers less friction |
| `allow_promotion_codes` | `false` (config) | can be switched on later for campaigns |
| `expires_at` | `now + 3600` | minimum is 30 min [unverified]; short-lived pending state |
| `automatic_tax[enabled]` | omitted (= false) | tax is for the legal session |
| `payment_method_types` | **never sent** | removed in `endive` [verified]; use Dashboard payment methods (5.6) |
| `consent_collection[terms_of_service]` | not yet | legal session (needs the ToS URL in Dashboard settings) |
| `subscription_data[trial_period_days]` | not used | possible later marketing lever |

Response: we use `id`, `url`, `expires_at`. The client receives only `{url}`.

**Double-subscription guards** (layered):
1. Server refusal when our cached state shows a live subscription.
2. Reuse of an open pending session.
3. Enable the Dashboard setting **"Limit customers to one subscription"** (Settings -> Checkout and Payment Links). With a `customer` passed, Stripe redirects such customers to the Portal instead [verified].
4. On confirm, if the customer has more than one non-canceled subscription, write a `billing_audit` warning shown in the admin view.

### 5.4 CSP check: redirect to `checkout.stripe.com`

- `connect-src 'self'` limits `fetch`/XHR/WebSocket/EventSource targets. Our `fetch` goes to `/api` (same origin), so it is fine.
- Top-level navigation (`location.assign`, link clicks) is **not governed by any CSP directive**. `navigate-to` was proposed and dropped from CSP Level 3 [unverified, well established]. `location.assign('https://checkout.stripe.com/c/pay/cs_...')` and `location.assign('https://billing.stripe.com/p/session/...')` therefore work with the current policy.
- `form-action 'self'` **would** block `<form action="https://checkout.stripe.com">`. Chromium also enforces `form-action` on **redirects that follow a form submission** [unverified, known behaviour]. So the pattern "HTML form POST to our PHP, PHP answers 303 to Stripe" must **not** be used. Use `fetch` + `location.assign`.
- Hosted Checkout requires no `script-src`, `frame-src` or `img-src` changes. Embedded Checkout or Elements would require `js.stripe.com`, frames and `connect-src` exceptions, and is rejected for that reason.
- Client hardening: before navigating, check `new URL(url).origin === 'https://checkout.stripe.com'` (Portal: `https://billing.stripe.com`). Otherwise show a generic error.

### 5.5 Return to the SPA and the SameSite=Strict cookie

- The redirect from `checkout.stripe.com` is a cross-site navigation, so the browser omits the Strict `matdraw_session` cookie on that document request. That is harmless: `index.html` is static.
- The SPA's subsequent `fetch('/api/index.php?route=...')` is a same-site request from a matbravo.com document, so Strict cookies **are** sent [unverified in our stack; standard behaviour]. **Add an end-to-end manual test** in test mode: pay with `4242 4242 4242 4242` and confirm that the confirm call is authenticated.
- If the session expired while the user was paying (idle 30 min), the confirm call gets 401. The SPA keeps `session_id` in `sessionStorage`, shows the login screen, and replays `confirm` after login. Even if this is lost, the lazy sync (section 8.3) finds the paid subscription through `pending_checkout_id`.

### 5.6 Payment methods for recurring billing

| Method | Recurring in Checkout `mode=subscription`? | Recommendation |
|---|---|---|
| Cards (Visa/Mastercard, incl. Polish cards) | Yes | Launch |
| Apple Pay / Google Pay | Yes. They tokenize a card. No domain verification needed on hosted Checkout [unverified] | Launch (enable in Dashboard) |
| Link (Stripe wallet) | Yes [unverified] | Owner's choice; can confuse first-time users, consider disabling |
| **BLIK** | **Yes, since 2026** (BLIK "Model O" recurring, off-session, PLN only, max 2,000 PLN per charge). Requires the `blik_payments` + `blik_recurring_payments` capabilities and account-level enablement via Stripe Support. Not every bank supports it (decline code `recurring_not_supported_by_bank`) [verified, Stripe docs + changelog 2026-04-22] | **Phase 2:** email Stripe Support from the MEDUCASE account. High value for Polish users. Older pages saying "BLIK: no recurring" are outdated |
| **Przelewy24** | **No.** "Recurring payments: not supported"; Checkout supports only one-time line items for P24 [verified] | Not usable; Checkout will not offer it in subscription mode |
| SEPA Direct Debit | EUR only | Not relevant |

- With dynamic payment methods, Checkout shows only the enabled methods that are compatible with the mode and currency [verified for the general mechanism; per-method filtering unverified]. No code change is needed when BLIK is enabled later.
- Async methods can leave the Subscription `incomplete` for a while. The confirm UI handles that ("Payment is being processed").

---

## 6. Customer Portal (manage, cancel, invoices, card change)

- `POST route=billing {op:'portal'}`:
  - requires a stored `stripe_customer_id` for the current mode;
  - rate limit 20/h/user;
  - calls `POST /v1/billing_portal/sessions` with `customer=cus_...`, `return_url=<app_url>/?billing=portal`, `configuration=<stripe_portal_configuration>` and `locale=pl|en`;
  - returns `{url}`; the client checks the origin `https://billing.stripe.com`, then calls `location.assign`.
- Portal session URLs are short-lived and single-use [unverified], so a session is created only on click, never pre-generated.
- On return (`?billing=portal`), the SPA calls `{op:'sync'}`. This forced per-user sync is rate-limited to 1 per 10 s. It picks up a cancellation (`cancel_at_period_end=true`), a resumed subscription, or a new card. Webhooks are not needed for this.
- Optional deep links later: `flow_data[type]=subscription_cancel` / `payment_method_update` with `flow_data[subscription_cancel][subscription]=sub_...` [unverified parameter names].

---

## 7. Webhooks (optional accelerator)

### 7.1 Route

In `backend/public/api/index.php`, dispatch `route=stripe-webhook` **before `Auth::start()`**, like `respond_public`:
- no session, no cookie, no CSRF;
- method must be POST (else 405);
- `Cache-Control: no-store`;
- if `stripe_webhook_secrets` is empty or `billing_enabled` is false, answer 404;
- `ignore_user_abort(true)`;
- read the raw body: `file_get_contents('php://input', false, null, 0, 1048577)`. Reject anything over 1 MiB with 413. **Do not** `json_decode` before verifying;
- header: `$_SERVER['HTTP_STRIPE_SIGNATURE']`.

### 7.2 Signature verification (manual, as the Stripe libraries do it)

- The header looks like `t=1730380000,v1=<hex>,v1=<hex>,v0=<hex>`.
- Signed payload: `"{$t}.{$rawBody}"`. Expected value: `hash_hmac('sha256', $signedPayload, $secret)`, using the **whole** `whsec_...` string as the key.
- Accept if **any** `v1` equals the expected value for **any** configured secret (`hash_equals`).
- Tolerance: 300 s (the Stripe SDK default [unverified in this session; stripe-php `DEFAULT_TOLERANCE = 300`]).
- Ignore `v0` (test-only scheme).

```php
final class StripeSignature {
 /** @param list<string> $secrets */
 public static function verify(string $payload,string $header,array $secrets,int $tolerance=300,?int $now=null):bool{
  $t=null;$sigs=[];
  foreach(explode(',',$header) as $part){[$k,$v]=array_pad(explode('=',trim($part),2),2,'');
   if($k==='t'&&ctype_digit($v))$t=(int)$v;elseif($k==='v1'&&preg_match('/^[0-9a-f]{64}$/D',$v))$sigs[]=$v;}
  if($t===null||!$sigs||!$secrets)return false;
  if(abs(($now??time())-$t)>$tolerance)return false;           // replay window
  foreach($secrets as $s){$exp=hash_hmac('sha256',$t.'.'.$payload,$s);
   foreach($sigs as $sig)if(hash_equals($exp,$sig))return true;}// constant-time, multiple v1 + rotation
  return false;
 }
}
```

After `verify()`:
- `json_decode($raw, true, 64, JSON_THROW_ON_ERROR)`;
- require `object==='event'`, `id` matching `^evt_[A-Za-z0-9]+$`, and `livemode === ($mode==='live')`. On a mismatch answer 400 and log it;
- then `BillingSync::handleEvent($event, 'webhook')`.

### 7.3 Idempotency and response codes

- `INSERT IGNORE INTO stripe_events (event_id,type,livemode,source,received_at) VALUES (...)`.
  - If the row already exists and `processed_at IS NOT NULL`, answer **200** immediately (duplicate).
  - Otherwise process, then `UPDATE stripe_events SET processed_at=?, error=NULL`.
- On a processing failure (for example Stripe API unreachable during the re-fetch):
  - store `error` (short code, no PII);
  - `attempts=attempts+1`;
  - answer **500** so Stripe retries. Live mode retries with backoff for up to about 3 days [unverified].
- Reprocessing is safe because processing = re-fetch + idempotent upsert.
- Unknown event types: answer 200 and record them (so they are not retried).
- Responses are tiny JSON (`{"received":true}`). Stripe only needs a 2xx quickly.
- `stripe_events` stores **no payload**: events contain e-mails and addresses (privacy by design). Prune rows older than 90 days in `stripe-sync.php`.

### 7.4 Events to subscribe to (same list used by the events pull)

| Event | Action |
|---|---|
| `checkout.session.completed` | retrieve session (expand subscription), same as `confirm` (ownership via `client_reference_id` + customer) |
| `checkout.session.async_payment_succeeded` / `..._failed` | same |
| `checkout.session.expired` | clear `pending_checkout_id` if it matches |
| `customer.subscription.created` / `updated` / `deleted` / `paused` / `resumed` / `trial_will_end` | re-fetch the subscription by `data.object.id` |
| `invoice.paid` / `invoice.payment_failed` / `invoice.payment_action_required` / `invoice.finalized` | subscription ID = `data.object.parent.subscription_details.subscription` (basil+, check `parent.type==='subscription_details'`) [verified] `?? data.object.subscription` (older payloads), then re-fetch; if neither exists, list by customer |
| `customer.deleted` | null the customer and subscription IDs for that row, set status `none`, audit |
| `charge.dispute.created`, `charge.refunded` | audit only (owner handles these in the Dashboard) |

That is 15 types, within the 20-type limit of `types[]` on `/v1/events` [unverified limit].

### 7.5 Out-of-order safety

- Events are not guaranteed to arrive in order. Event payloads are rendered in the endpoint's (webhook) or the account's (Events API) version, not necessarily ours.
- The handler therefore uses an event **only to learn which object changed** (`data.object.id`, `customer`, subscription ID). It then calls `GET /v1/subscriptions/{id}?expand[]=latest_invoice` with our pinned version.
- The write is guarded (section 8.4). Whatever order events arrive in, the stored state equals the latest state Stripe returned.

---

## 8. Correct without webhooks (pull-based reconciliation)

### 8.1 Sources of truth, in order of latency

| Trigger | When | Cost |
|---|---|---|
| `confirm` on the success return | seconds after payment | 1 API call |
| `sync` on the Portal return | seconds after a Portal change | 1 call |
| Lazy sync on `session`/`bootstrap` | when `next_sync_at <= now`, at most every `billing_sync_min_interval` per user | 1 call, rare |
| Admin "Resync" | on demand | 1 call |
| `stripe-sync.php --events` (cron, every 15-30 min) | Stripe's own event stream, `GET /v1/events` | 1 call per page |
| `stripe-sync.php --due` (cron) | rows whose `next_sync_at` passed | 1 call per row, max 50 per run |
| `stripe-sync.php --reconcile` (cron, nightly) | full list `GET /v1/subscriptions?status=all&limit=100` (paginate `starting_after`) matched by `metadata.matbravo_user_id`/customer | finds anything missed |
| Webhook (if the host lets it through) | real time | 0 outbound calls for the notice + 1 re-fetch |

### 8.2 Upsert from a Subscription object (shared by every path)

```php
// $sub = GET /v1/subscriptions/{id}?expand[]=latest_invoice   (pinned Stripe-Version)
function billing_state_from_subscription(array $sub,array $priceKeys):array{
 $items=$sub['items']['data']??[];$ours=null;
 foreach($items as $i)if(in_array($i['price']['lookup_key']??'',$priceKeys,true))$ours=$i;
 // basil+: periods live on items; fall back to the pre-basil top-level fields so the code survives a version change
 $end=$ours['current_period_end']??($sub['current_period_end']??null);
 $start=$ours['current_period_start']??($sub['current_period_start']??null);
 $inv=is_array($sub['latest_invoice']??null)?$sub['latest_invoice']:null;
 return ['stripe_subscription_id'=>$sub['id'],'sub_status'=>$ours?$sub['status']:'foreign',
  'price_lookup_key'=>$ours['price']['lookup_key']??null,'currency'=>$sub['currency']??null,
  'current_period_start'=>$start,'current_period_end'=>$end,'cancel_at_period_end'=>(int)!empty($sub['cancel_at_period_end']),
  'cancel_at'=>$sub['cancel_at']??null,'canceled_at'=>$sub['canceled_at']??null,'ended_at'=>$sub['ended_at']??null,
  'latest_invoice_status'=>$inv['status']??null,'livemode'=>(int)!empty($sub['livemode'])];
}
```

Mapping a Subscription to a user, in order:
1. our row with the same `stripe_subscription_id`;
2. our row with the same `stripe_customer_id`;
3. `metadata.matbravo_user_id`, accepted **only** if that row's customer ID is null or equal.

Otherwise: audit "orphan subscription" and change nothing.

**`confirm` ownership checks:**
- `session_id` matches `^cs_(test|live)_[A-Za-z0-9]{10,250}$`;
- `session.client_reference_id === currentUser.id`;
- `session.customer === stored customer`;
- `session.mode === 'subscription'`;
- `session.status === 'complete'`;
- then upsert from `session.subscription` (expanded).

A foreign session ID gets a 403 and no information about it.

### 8.3 `next_sync_at`: when to look again

After every upsert compute:

| State after sync | `next_sync_at` |
|---|---|
| `active`/`trialing`, latest invoice `paid` | `current_period_end + 2 h` (renewal invoice drafted about 1 h after period end [unverified], then charged) |
| `active`, latest invoice `draft`/`open` (renewal pending) | `now + 2 h` |
| `cancel_at_period_end=1` | `current_period_end + 5 min` |
| `past_due` | `now + 6 h` |
| `incomplete` | `now + 10 min` (expires after about 23 h -> `incomplete_expired`) |
| `pending_checkout_id` set, no subscription | `pending_checkout_expires + 5 min` (then retrieve the session once) |
| `canceled`/`incomplete_expired`/`unpaid`/`none` | `NULL` (no polling; a new checkout sets it again) |
| any, cap | `min(computed, now + 7 days)` so Dashboard-side changes are noticed within a week |

Why the "renewal pending" row matters:
- At period end Stripe starts the new period immediately and the status stays `active` while the invoice is drafted and charged.
- A naive "re-check at period end" would see `active` with a new `current_period_end` and wait a whole month, missing a failed renewal.
- Expanding `latest_invoice` closes that gap.

**Lazy sync on `session`/`bootstrap`:**
- one indexed single-row `SELECT` on `billing_accounts`;
- if `next_sync_at <= now` and the claim succeeds, call Stripe with a short timeout (8 s), *outside* any transaction;
- on failure keep the cached state, record `sync_error`, and set `next_sync_at = now + 15 min`;
- the user is never blocked by a Stripe outage; the leeway rules (section 10) decide access.

### 8.4 Concurrency: claim + stale-write guard

```php
// claim (no lock held during HTTP):
$q=$pdo->prepare('UPDATE billing_accounts SET sync_claimed_at=? WHERE user_id=? AND sync_claimed_at<?');
$q->execute([$now,$uid,$now-30]); if($q->rowCount()!==1) return; // someone else is syncing (30 s claim lease)
$started=time(); $sub=$stripe->get('/v1/subscriptions/'.rawurlencode($sid),['expand'=>['latest_invoice']]);
$s=billing_state_from_subscription($sub,array_values($cfg['stripe_prices']));
// write only if no newer fetch has been stored meanwhile (webhook, cron, other tab):
$pdo->prepare('UPDATE billing_accounts SET sub_status=?,current_period_end=?,...,last_synced_at=?,next_sync_at=?,sync_claimed_at=0,sync_error=NULL,updated_at=?
 WHERE user_id=? AND last_synced_at<=?')->execute([...,$started,$next,$now,$uid,$started]);
// if the status changed: INSERT INTO billing_audit (...)
```

- `rowCount()` with PDO MySQL returns *affected* rows. An `UPDATE` that sets identical values reports 0 unless `PDO::MYSQL_ATTR_FOUND_ROWS` is set. The claim always changes `sync_claimed_at`, so it is safe [unverified detail, cover with a test].
- The webhook and events paths call the same function. The `sync_claimed_at` lease avoids duplicate concurrent calls; `last_synced_at <= started` discards a slower, older fetch.

### 8.5 `backend/bin/stripe-sync.php` (cron-friendly CLI)

```
/usr/local/php83/bin/php ~/domains/matbravo.com/backend/bin/stripe-sync.php [--events] [--due] [--reconcile] [--user=<id>] [--limit=50] [--dry-run]
```

- **Single-run lock:** `SELECT GET_LOCK('matbravo_stripe_sync', 0)` (works on MySQL 8 and MariaDB 10.6). Exit quietly if it is taken.
- **`--events`:** reads the cursor `{created, id}` from `billing_kv`, then `GET /v1/events?created[gte]=<cursor-120>&types[]=...&limit=100`.
  - Stripe lists newest first: paginate with `starting_after`, then process oldest first through `BillingSync::handleEvent($event, 'pull')`.
  - The shared `stripe_events` idempotency removes overlap with webhooks and earlier runs.
  - Events are retained for 30 days [unverified], so a cron outage shorter than that loses nothing.
- **`--due`:** `SELECT user_id FROM billing_accounts WHERE next_sync_at<=? AND livemode=? ORDER BY next_sync_at LIMIT ?`, then sync each, with 100 ms between calls.
- **`--reconcile`:** a nightly full scan, as in 8.1.
- **Housekeeping:** prune `stripe_events` older than 90 days and `billing_audit` per the retention to be decided in the legal session.
- **Output:** counts only (no e-mails), printed to stdout for the cron log. Exit code ≠ 0 on API errors.

DirectAdmin cron (cron availability **unverified**: check DirectAdmin -> Advanced Features -> Cron Jobs):
```
*/20 * * * *  /usr/local/php83/bin/php /home/<user>/domains/matbravo.com/backend/bin/stripe-sync.php --events --due >> /home/<user>/matdraw/shared/logs/stripe-sync.log 2>&1
37 3 * * *    /usr/local/php83/bin/php /home/<user>/domains/matbravo.com/backend/bin/stripe-sync.php --reconcile >> /home/<user>/matdraw/shared/logs/stripe-sync.log 2>&1
```
The release's `backend/config.php` is a symlink to `shared/config.php`, so no `MATDRAW_CONFIG` is needed.

**If cron is not available:** the confirm, Portal-return and lazy paths alone keep every *active user's* own state correct. Only dashboards of users who never log in go stale, which does not matter for access. Optional piggyback: on any API request, at most once per 10 min across the site (claimed through a `billing_kv` row update), run `--events` with a 1-page limit **after** the response is sent (`litespeed_finish_request()` / `fastcgi_finish_request()` if available [unverified on this host]).

---

## 9. Asking AfterMarket to let Stripe webhooks through

Stripe publishes its webhook source IPs at:
- https://stripe.com/files/ips/ips_webhooks.json
- https://stripe.com/files/ips/ips_webhooks.txt

They are linked from https://stripe.com/docs/ips; the list changes occasionally and Stripe announces it [verified that the list exists; contents not fetched].

The block is most likely a WAF or Imunify360-style rule on the LiteSpeed/CloudLinux stack [unverified]. Suggested support ticket (Polish, from the DirectAdmin account owner):

> Dzień dobry, na koncie <login> (serwer web9) dla domeny matbravo.com obsługujemy płatności Stripe. Stripe wysyła powiadomienia (webhooki, żądania POST) na adres `https://matbravo.com/api/index.php?route=stripe-webhook` z adresów IP opublikowanych pod https://stripe.com/files/ips/ips_webhooks.txt. Obecnie serwer odpowiada 403 na żądania z sieci centrów danych. Prosimy o dodanie tych adresów IP do białej listy (WAF/Imunify/blokada sieci centrów danych) dla tej domeny lub przynajmniej dla tej ścieżki. Lista może się zmieniać - czy możliwe jest automatyczne pobieranie jej z tego adresu? Uwierzytelnianie zapewniamy podpisem HMAC każdego żądania. Dziękujemy.

Verification after they confirm:
1. Run `stripe-setup.php --mode=test --webhook` and paste the printed `whsec_...` into config.
2. Stripe Dashboard (Workbench) -> Webhooks -> the endpoint -> **Send test event**, or resend a real event. The **Event deliveries** list shows each attempt's HTTP status and our response body. We expect 200 `{"received":true}`; 403 with a host error page means still blocked.
3. Our side: `SELECT event_id,type,source,processed_at FROM stripe_events ORDER BY received_at DESC LIMIT 10;` should show `source='webhook'`.
4. Repeat in live mode with a fresh endpoint and secret.

- If the host refuses, **do not create the endpoint**, or delete it. Stripe e-mails warnings about a failing endpoint and may disable it after repeated failures [unverified]. Billing remains correct through the pull paths.
- GitHub Actions `deploy-verify.sh` cannot test the webhook (runners are blocked too). A manual Dashboard test is the only check.

---

## 10. Access state machine

Computed **server-side only** by `Billing::access(array $row, array $user, array $cfg, int $now): array` and returned in the `session`/`bootstrap` payload. The client only displays it.

| # | Condition (checked in order) | `paid` | `state` shown | `until` |
|---|---|---|---|---|
| 1 | `billing_enforce` false | yes | (no badge) | - |
| 2 | `role === 'admin'` | yes | `staff` | - |
| 3 | `billing_exempt=1` and (`exempt_until` null or > now) | yes | `free` ("Free account, granted by the Admin") | `exempt_until` |
| 4 | row `livemode` ≠ current mode, or no subscription | no | `none` | - |
| 5 | `active`/`trialing`, `cancel_at_period_end=0` | yes, while `now < period_end + leeway` | `active` | `period_end` |
| 6 | `active`/`trialing`, `cancel_at_period_end=1` | yes, until `period_end` | `ending` ("ends on ...") | `period_end` |
| 7 | `past_due` | yes, until `current_period_start + grace_days` | `past_due` ("Payment failed, update your card") | that date |
| 8 | `incomplete` | no | `processing` / "complete payment" | - |
| 9 | `canceled`, `unpaid`, `incomplete_expired`, `paused`, `foreign` | no | `ended` | - |

Leeway rule (stale cache when Stripe is unreachable or a sync is pending):
- if a row in state 5 has `period_end` in the past, keep `paid` for `billing_stale_leeway_hours` (72 h);
- meanwhile the lazy and cron syncs try to refresh it;
- after that, access is denied until a sync succeeds;
- `sync_error` is shown to the admin.

Dashboard setting to keep states finite (section 12): after all retries fail, set the subscription to **canceled**.

### 10.1 What payment unlocks (when `billing_enforce` is true)

| Capability | Guest | Logged-in unpaid | Paid / free / admin |
|---|---|---|---|
| Read chats (lobby + tournament) | yes, identities blurred (server sends initials only) | yes, **same blurred view as a guest** | yes, full names, usernames, avatars |
| Post in chat | no (CTA "create an account") | no (CTA "subscribe for 8,99 zł") | yes |
| Own profile (edit) | - | yes (kept **private**) | yes |
| Profile visible to others (name, avatar, club, sport) | - | **no** (shown as initials) | yes |
| Public tournament previews (existing guest views) | yes | yes | yes |
| Club workspace (athletes, registrations, draws, etc.) | - | **no** for non-exempt accounts | yes (existing accounts are grandfathered free) |
| Billing page, Portal, log out, (later) account deletion | - | yes | yes |

Enforcement points (all server-side):
- **Chat post** and **chat read**: the chat endpoints call `Billing::access()` and choose the identity projection (full or initials), the same principle as `GuestView`.
- **Profile visibility**: the profile/directory queries filter by the owner's access.
- **Club workspace**: in `index.php`, *before* `Domain::execute`, a short allow-list. For a non-exempt unpaid user `command` answers 402 `T('Ta funkcja wymaga aktywnej subskrypcji.')` (needs an English entry in `i18n-en.js`; PHP messages are covered by `tests/i18n.test.mjs`).
  - `Domain` stays billing-agnostic, so the PHP/JS parity tests are untouched.
  - The demo adapter (`client.js`) reports `billing: {enabled: false}`.

### 10.2 Admin: free accounts and comping

- **Grandfathering migration** (schema step in the future `bin/migrate.php`; `install.php` is not a migrator):
  ```sql
  INSERT IGNORE INTO billing_accounts (user_id,billing_exempt,exempt_reason,exempt_at,updated_at)
  SELECT id,1,'grandfathered',UNIX_TIMESTAMP(),UNIX_TIMESTAMP() FROM users;
  ```
  Bump `app_meta.schema_version`. The tables are additive, so old code ignores them on a rollback.
- **Account form** (`accountForm`): new checkbox "Free account (no payment)".
  - Recommended default: **checked** for accounts the admin creates, since today these are club and staff accounts. **Open question for the owner.**
  - Saved by a separate `billing` op after `account.save` succeeds, outside `Repository::transaction()`.
  - A missing `billing_accounts` row means "not exempt, no subscription".
- **Accounts list** (`accountsPage`): a badge per user (Free / Active until ... / Ending ... / Past due / Unpaid), loaded with one lean query `SELECT user_id, billing_exempt, exempt_until, sub_status, current_period_end, cancel_at_period_end FROM billing_accounts`.
- **Admin actions** (`POST route=billing {op:'admin', action, userId, ...}`, `role==='admin'` only, each one audit-logged with actor and reason):
  - `exempt` (reason required, optional `until` date);
  - `unexempt`;
  - `resync`;
  - `cancelAtPeriodEnd`: when comping a paying user, offer "Also stop their Stripe subscription at period end" (`POST /v1/subscriptions/{id}` with `cancel_at_period_end=true`). Otherwise Stripe keeps charging a user we made free;
  - "Open in Stripe" link: `https://dashboard.stripe.com/{test/}customers/cus_...` (plain navigation).
- **Deactivating** an account (`active=0`) with a live subscription: the admin is warned and offered the same cancel action. Do not keep charging a blocked user.

---

## 11. Data model (new tables, no changes to `users`)

```sql
CREATE TABLE IF NOT EXISTS billing_accounts (
 user_id VARCHAR(40) PRIMARY KEY,
 billing_exempt TINYINT(1) NOT NULL DEFAULT 0,
 exempt_reason VARCHAR(200) NULL,
 exempt_by VARCHAR(40) NULL,
 exempt_at BIGINT NULL,
 exempt_until BIGINT NULL,
 currency CHAR(3) CHARACTER SET ascii NULL,                  -- 'pln' | 'usd'
 livemode TINYINT(1) NOT NULL DEFAULT 0,
 stripe_customer_id VARCHAR(255) CHARACTER SET ascii NULL,
 customer_seq INT NOT NULL DEFAULT 0,                         -- part of the customer Idempotency-Key
 stripe_subscription_id VARCHAR(255) CHARACTER SET ascii NULL,
 sub_status VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'none',
 price_lookup_key VARCHAR(200) CHARACTER SET ascii NULL,
 current_period_start BIGINT NULL,
 current_period_end BIGINT NULL,
 cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0,
 cancel_at BIGINT NULL, canceled_at BIGINT NULL, ended_at BIGINT NULL,
 latest_invoice_status VARCHAR(32) CHARACTER SET ascii NULL,
 pending_checkout_id VARCHAR(255) CHARACTER SET ascii NULL,
 pending_checkout_expires BIGINT NULL,
 last_synced_at BIGINT NOT NULL DEFAULT 0,
 next_sync_at BIGINT NULL,
 sync_claimed_at BIGINT NOT NULL DEFAULT 0,
 sync_error VARCHAR(200) NULL,
 updated_at BIGINT NOT NULL,
 UNIQUE KEY billing_customer (stripe_customer_id),
 UNIQUE KEY billing_subscription (stripe_subscription_id),
 KEY billing_due (next_sync_at),
 FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stripe_events (
 event_id VARCHAR(255) CHARACTER SET ascii PRIMARY KEY,
 type VARCHAR(100) CHARACTER SET ascii NOT NULL,
 livemode TINYINT(1) NOT NULL,
 source VARCHAR(10) CHARACTER SET ascii NOT NULL,            -- 'webhook' | 'pull'
 received_at BIGINT NOT NULL,
 processed_at BIGINT NULL,
 attempts INT NOT NULL DEFAULT 1,
 error VARCHAR(200) NULL,
 KEY events_received (received_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS billing_audit (
 id BIGINT AUTO_INCREMENT PRIMARY KEY,
 user_id VARCHAR(40) NULL,
 actor VARCHAR(40) NOT NULL,                                  -- users.id | 'stripe' | 'cron' | 'cli' | 'system'
 action VARCHAR(50) CHARACTER SET ascii NOT NULL,             -- exempt.grant, exempt.revoke, checkout.create, status.change, customer.replace, orphan, ...
 old_status VARCHAR(32) NULL, new_status VARCHAR(32) NULL,
 detail VARCHAR(500) NULL,                                    -- ids and short codes only, no e-mails/addresses
 created_at BIGINT NOT NULL,
 KEY audit_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_kv (
 k VARCHAR(100) CHARACTER SET ascii PRIMARY KEY,              -- 'price:test:matbravo_monthly_pln', 'events_cursor:live', 'piggyback_claim'
 v VARCHAR(1000) NOT NULL,
 updated_at BIGINT NOT NULL
) ENGINE=InnoDB;
```

- Multiple `NULL`s in a `UNIQUE` key are allowed on both MySQL and MariaDB.
- Stripe IDs can be up to 255 chars [unverified, Stripe's stated guidance], hence `VARCHAR(255)` ascii.
- No `ON DELETE CASCADE`: users are deactivated, not deleted. Account deletion is designed in the legal/GDPR session.
- Stored from Stripe: **only** IDs, status, dates, currency and lookup key. No names, addresses or card data; invoices stay in Stripe and are reachable through the Portal.

---

## 12. Stripe Dashboard settings (manual checklist, test and live separately)

- **Settings -> Business -> Public details:** name "MatBravo", support e-mail, statement descriptor e.g. `MATBRAVO` (5-22 chars [unverified]).
- **Branding:** logo plus navy/blue/cyan colours from `brand.css`. This applies to Checkout, the Portal and Stripe e-mails.
- **Payment methods:** Cards on; Apple Pay and Google Pay on; Link (decide); BLIK on, with recurring requested via Support (phase 2).
- **Billing -> Subscriptions and e-mails** (we have **no SMTP**, so let Stripe send e-mails) [setting names unverified]:
  - Smart Retries on; after the final failed retry: **cancel the subscription**.
  - E-mail customers about failed payments, with a link to update the card.
  - E-mail when a card payment requires authentication (3DS on renewal; `invoice.payment_action_required`).
  - Send receipts for successful payments (Settings -> Customer e-mails).
  - Optional: upcoming renewal reminders (consumer-friendly).
- **Checkout and Payment Links -> Subscriptions:** "Limit customers to one subscription" on [verified exists].
- **Adaptive Pricing:** off.
- **Tax:** off until the legal session.
- **Radar:** defaults.
- **Payouts:** the MEDUCASE account settles in PLN. USD charges are converted at Stripe's FX rate plus a conversion fee unless a USD bank account is added [unverified]. Business note for the owner: on 8.99 PLN a fixed per-transaction fee is a large share. Check the current PL pricing (card %, fixed fee, Billing fee) in the Dashboard [unverified].

---

## 13. HTTP client (`backend/src/StripeClient.php`)

Requirements:
- `ext-curl`; HTTPS only (`CURLOPT_PROTOCOLS = CURLPROTO_HTTPS` unless the test base URL is http and `allow_insecure_http`);
- `CURLOPT_SSL_VERIFYPEER=true`, `VERIFYHOST=2`; optional `CURLOPT_CAINFO` from config, otherwise the system store (verify on the host: `curl -sS https://api.stripe.com/v1/charges` should give a 401 JSON, not a TLS error);
- `CURLOPT_FOLLOWLOCATION=false`; connect timeout 5 s; total timeout 20 s (lazy sync: 8 s);
- headers:
  - `Authorization: Bearer <key>`
  - `Stripe-Version: <pinned>`
  - `Content-Type: application/x-www-form-urlencoded`
  - `Accept: application/json`
  - `User-Agent: MatBravo/1.0 (+https://matbravo.com)`
  - `Idempotency-Key` on every POST.

Retries:
- up to 2 retries on cURL network errors, HTTP 409 (idempotency in-flight lock), 429 and 5xx, with backoff `0.5 s * 2^n + jitter`;
- honour the `Stripe-Should-Retry` response header (`false` = never retry, `true` = retry);
- the **same Idempotency-Key** is reused on retry;
- no retry on other 4xx.

Logging:
- `error_log('MatDraw stripe: <method> <path> <status> <error.type>/<error.code> req=<Request-Id>')`;
- never the key, never request or response bodies (they carry e-mails);
- verify that the response `Stripe-Version` header equals the pinned value. Log a warning once if not.

Form encoding: Stripe's bracket syntax. PHP's `http_build_query` encodes nested arrays correctly but turns booleans into `1`/`0`, so booleans are converted to `'true'`/`'false'` first, and nulls are dropped.

```php
final class StripeError extends \RuntimeException{
 public function __construct(string $m,public readonly int $status,public readonly ?string $type=null,public readonly ?string $stripeCode=null,public readonly ?string $requestId=null){parent::__construct($m,$status);}
}
final class StripeClient {
 public function __construct(private string $key,private string $version,private string $base='https://api.stripe.com',private int $timeout=20,private ?string $ca=null,private bool $allowHttp=false){}
 public function get(string $path,array $q=[],?int $timeout=null):array{return $this->req('GET',$path,$q,null,$timeout);}
 public function post(string $path,array $p=[],?string $idem=null):array{return $this->req('POST',$path,$p,$idem??bin2hex(random_bytes(16)));}
 public function delete(string $path):array{return $this->req('DELETE',$path,[],null);}
 private static function norm(array $a):array{$o=[];foreach($a as $k=>$v){if($v===null)continue;$o[$k]=is_bool($v)?($v?'true':'false'):(is_array($v)?self::norm($v):(string)$v);}return $o;}
 private function req(string $m,string $path,array $params,?string $idem,?int $timeout=null):array{
  if(!preg_match('#^/v1/[A-Za-z0-9_/\-]+$#D',$path))throw new \InvalidArgumentException('bad path');
  $body=http_build_query(self::norm($params),'','&',PHP_QUERY_RFC1738);
  $url=rtrim($this->base,'/').$path.($m==='GET'&&$body!==''?'?'.$body:'');
  $h=['Authorization: Bearer '.$this->key,'Stripe-Version: '.$this->version,'Accept: application/json','User-Agent: MatBravo/1.0 (+https://matbravo.com)'];
  if($m==='POST'){$h[]='Content-Type: application/x-www-form-urlencoded';$h[]='Idempotency-Key: '.$idem;}
  for($try=0;;$try++){
   $c=curl_init($url);$rh=[];
   curl_setopt_array($c,[CURLOPT_CUSTOMREQUEST=>$m,CURLOPT_RETURNTRANSFER=>true,CURLOPT_HTTPHEADER=>$h,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>$timeout??$this->timeout,
    CURLOPT_FOLLOWLOCATION=>false,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,
    CURLOPT_PROTOCOLS=>$this->allowHttp?(CURLPROTO_HTTPS|CURLPROTO_HTTP):CURLPROTO_HTTPS,
    CURLOPT_HEADERFUNCTION=>function($c,$line)use(&$rh){$p=explode(':',$line,2);if(count($p)===2)$rh[strtolower(trim($p[0]))]=trim($p[1]);return strlen($line);}]);
   if($this->ca)curl_setopt($c,CURLOPT_CAINFO,$this->ca);
   if($m==='POST')curl_setopt($c,CURLOPT_POSTFIELDS,$body);
   $raw=curl_exec($c);$errno=curl_errno($c);$status=(int)curl_getinfo($c,CURLINFO_RESPONSE_CODE);curl_close($c);
   $should=$rh['stripe-should-retry']??null;
   $retryable=$errno!==0||$status===409||$status===429||$status>=500;
   if($should==='false')$retryable=false;elseif($should==='true')$retryable=true;
   if(($errno!==0||$status>=400)&&$retryable&&$try<2){usleep((int)(500000*(2**$try))+random_int(0,250000));continue;}
   if($errno!==0){error_log("MatDraw stripe: $m $path curl=$errno");throw new StripeError('network',0);}
   $json=json_decode((string)$raw,true);
   if($status>=400||!is_array($json)){$e=is_array($json)?($json['error']??[]):[];
    error_log("MatDraw stripe: $m $path $status ".($e['type']??'-').'/'.($e['code']??'-').' req='.($rh['request-id']??'-'));
    throw new StripeError($e['message']??'stripe error',$status,$e['type']??null,$e['code']??null,$rh['request-id']??null);}
   if(($rh['stripe-version']??$this->version)!==$this->version)error_log('MatDraw stripe: version mismatch '.$rh['stripe-version']);
   return $json;
  }
 }
}
```

User-facing errors map to translated generic messages, e.g. `T('Płatności są chwilowo niedostępne. Spróbuj ponownie później.')`. Never show Stripe's raw message, except card errors, which Checkout itself displays anyway.

---

## 14. Testability without network access to Stripe

1. **Unit (PHP via the existing bridge pattern, `tests/php-bridge.php`):**
   - `StripeSignature::verify` with a fixed secret `whsec_test_secret`, `$now` injected. Cases:
     - valid;
     - tampered body;
     - wrong secret;
     - second of two secrets (rotation);
     - two `v1` values, one valid;
     - timestamp 301 s old and 301 s in the future;
     - missing `t`;
     - non-hex `v1`;
     - an empty secrets list.
   - The Node side computes the expected signature with `crypto.createHmac('sha256', secret).update(t + '.' + body).digest('hex')`.
   - `Billing::access()` state table: every row of section 10 plus the leeway boundaries, `exempt_until` expiry and a `livemode` mismatch.
   - `billing_state_from_subscription` with basil-shaped (item periods) and pre-basil-shaped fixtures, a foreign lookup key, and a `latest_invoice` that is an ID string instead of an object.
   - `next_sync_at` table.
   - `StripeClient::norm` (booleans and nested arrays).
2. **HTTP integration (`tests/billing.http.test.mjs`, passed as an extra file to the existing `run-http-test.sh`).** The config must gain:
   - `billing_enabled => true`;
   - `billing_enforce => true`;
   - `stripe_api_base => 'http://127.0.0.1:<stubPort>'`;
   - `stripe_secret_key => 'rk_test_stub'`;
   - `stripe_webhook_secrets => ['whsec_test_secret']`.

   That means a small extension of the harness or a config overlay; the harness is outside the repo.

   A **Stripe stub** `tests/stripe-stub.php` runs with `php -S 127.0.0.1:<stubPort> tests/stripe-stub.php`. It is a router that:
   - implements the handful of endpoints we call (`/v1/prices`, `/v1/customers`, `/v1/checkout/sessions[/{id}]`, `/v1/subscriptions[/{id}]`, `/v1/billing_portal/sessions`, `/v1/events`);
   - keeps state in a JSON file;
   - exposes `POST /__control` so the test can mark a session complete, set a subscription to `past_due`, return 500 once (retry test) or return 429 with `Stripe-Should-Retry`;
   - records every request (method, path, form body, `Stripe-Version`, `Idempotency-Key`, `Authorization`) for assertions.

   Scenarios:
   - unpaid user gets 402 on a gated command;
   - checkout returns a URL with `checkout.stripe.com` (the stub returns that string);
   - double click reuses the session;
   - confirm with another user's session ID gives 403;
   - confirm gives `active`, and the gated command now passes;
   - stub flips to `past_due`, the lazy sync after `next_sync_at` gives a `past_due` badge with grace;
   - grace expiry denies access;
   - webhook: valid gives 200, duplicate is not double-processed, bad signature gives 400, livemode mismatch gives 400;
   - `--events` pull processes the same event ID only once across webhook + pull;
   - admin exempt grants access and is audit-logged;
   - grandfathering migration exempts existing users;
   - concurrency: two parallel syncs make exactly one stub call (claim lease).
3. **Manual test-mode run on production** (before `billing_mode=live`):
   - outbound check;
   - `stripe-setup.php --mode=test`;
   - pay with `4242 4242 4242 4242`;
   - a 3DS card (`4000 0025 0000 3155`);
   - a card declined on renewal (`4000 0000 0000 0341`: attaches, then fails) combined with **Test clocks** (Dashboard -> Billing -> Test clocks) to advance a month and watch `past_due` -> canceled through the sync paths only;
   - cancel in the Portal and return; resume.
   - [Card numbers from memory, unverified.]

Rollout order:
1. Deploy with both flags false.
2. Run the migration, which grandfathers everyone.
3. Test mode with `billing_enabled=true` (only the owner tries it).
4. Live setup + live keys.
5. One real payment by the owner, refunded in the Dashboard.
6. `billing_enforce=true`.

---

## 15. Flagged for the later legal/tax session (not designed here)

- **VAT:**
  - domestic B2C: 23% VAT included in 8.99 PLN [rate unverified for this service category];
  - EU consumers paying USD: OSS registration and the buyer-country VAT rate; two non-contradictory pieces of location evidence (billing address + card country, which is why `billing_address_collection=required` is proposed);
  - non-EU buyers: local digital-services VAT/GST/sales-tax rules (e.g. UK, Norway, Switzerland, some US states);
  - whether to enable Stripe Tax (`automatic_tax`) and which `tax_behavior` to set on the Prices.
- **Invoices vs receipts:**
  - Polish documentary requirements for B2C electronic services (cash-register exemption conditions);
  - B2B buyers (clubs) asking for a VAT invoice with NIP, and the **KSeF** mandatory e-invoicing in 2026. Stripe invoices are not KSeF documents [unverified], so an accounting-system bridge may be needed;
  - collecting tax IDs in Checkout (`tax_id_collection`).
- **Consumer withdrawal right** (14 days, digital services): express consent to start immediately and acknowledgement of losing the right (Polish Consumer Rights Act, art. 38). Possibly `consent_collection` / `custom_text` in Checkout. Also check EU "withdrawal button" rules for distance contracts [unverified timing].
- Terms of Service and Privacy Policy URLs in Checkout and the Portal; Stripe's role (independent controller vs processor) in the privacy notice; data retention for accounting (`billing_audit`, Stripe records).
- **Minors:** many athletes are children. Who may hold a paid account, and parental consent.
- Price display rules (gross prices, Omnibus), renewal reminders, cancellation information.

---

## 16. Open questions for the owner

1. Should admin-created accounts default to "free"? (Recommended: yes.)
2. Should non-exempt unpaid accounts keep *any* club-workspace access, or only chat reading?
3. Grace period after a failed renewal: 7 days? Stripe retry schedule and final action "cancel"?
4. Enable Link? Request BLIK recurring now or after launch?
5. Is a DirectAdmin cron job available on the AfterMarket plan? (It strongly improves freshness; not required for correctness.)
6. Will AfterMarket whitelist Stripe webhook IPs? (Optional.)

---

## Sources

- Stripe changelog: basil removes subscription-level periods, now on items: https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
- Stripe changelog: invoice `parent` field (subscription ID path): https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects ; https://docs.stripe.com/billing/invoices/subscription
- DEV write-up on the basil period move [third party]: https://dev.to/flarecanary/stripe-basil-quietly-moved-currentperiodend-off-subscription-and-a-lot-of-code-broke-3eo7
- Stripe changelog: endive removes `payment_method_types` from Checkout Sessions: https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions ; versioning: https://docs.stripe.com/api-versions ; dahlia: https://docs.stripe.com/changelog/dahlia
- Manual currency prices / Adaptive Pricing: https://docs.stripe.com/payments/checkout/manual-currency-prices ; https://docs.stripe.com/payments/checkout/multi-currency-prices ; https://docs.stripe.com/payments/custom/localize-prices/adaptive-pricing
- BLIK recurring: https://docs.stripe.com/payments/blik/recurring-payments ; https://docs.stripe.com/changelog/dahlia/2026-04-22/stripe-billing-blik-recurring-payments ; https://docs.stripe.com/changelog/endive/2026-09-30/blik-recurring-off-session-payments
- Przelewy24 (no recurring): https://docs.stripe.com/payments/p24.md ; https://stripe.com/docs/payments/p24/accept-a-payment
- Customer Portal configuration API: https://docs.stripe.com/api/customer_portal/configurations/create
- Limit customers to one subscription: https://docs.stripe.com/payments/checkout/limit-subscriptions
- Stripe IP lists: https://stripe.com/docs/ips ; https://stripe.com/files/ips/ips_webhooks.json
- Webhook signature scheme explanations [third party]: https://webhookrelay.com/verify-stripe-webhook-signature/ ; https://blog.openreplay.com/verify-webhook-signature/
- Repository: `backend/public/api/index.php`, `backend/src/Auth.php`, `backend/bootstrap.php`, `backend/config.example.php`, `backend/database/schema.sql`, `backend/public/.htaccess`, `scripts/deploy-remote.sh`, `tests/http.test.mjs` (read in this session).
