# MatBravo (MatDraw) validation

This file says what was tested, how it can be repeated, and what can only be verified on the real server. Commands are in `README.md` ("Tests and the local harness"); the owner's checklist is `HANDOFF.md`.

> **FINAL NUMBERS — PLACEHOLDER, to be filled by the orchestrator after the final review:** commit `<SHA>`, date `<YYYY-MM-DD>`; unit `<pass>/<total>` (`<skipped>` skipped); PHP bridges `<pass>/<total>`; HTTP on local MariaDB 10.11 `<pass>/<total>`; CI MySQL 8.0 `<pass>/<total>`; CI MariaDB 10.6 `<pass>/<total>`; back-compat `<result>`; deploy-script test `<pass>/<total>`; browser tests `<pass>/<total>`; manual QA findings `<list>`. Until then the figures below are the measurements of the documentation task at its base commit.

## 1. Test layers

| Layer | What it proves | How to run | Needs |
|---|---|---|---|
| Static checks | JavaScript and shell syntax, PHP lint of `backend` and `tests`, no inline script or handler, no HTML sink outside `setHtml` | `npm run check`; `bash -n scripts/*.sh tests/deploy/*.sh`; `php -l` on every `.php`; `tests/xss-scan.test.mjs` | Node 22, PHP 8.3 |
| Unit (Node) | Rules engine, demo workspace, i18n coverage and collisions, registry and safe template, chat client (grouping, poll schedule, back-off, leader election, identity purge), moderation and members views as plain functions, account screens (crop maths, price formatting, CTA matrix), PWA install rules and update flow, service worker in `node:vm`, release build and manifests | `PHP_BIN="$(command -v php)" node --test tests/*.test.mjs` | Node 22 |
| PHP bridges (parity and units) | PHP and JavaScript give the same answers (448 age/category boundary combinations; draws of 3 to 64 entrants; user names, countries, sports, `Text::clean`); `Access::compute` for every row of the access table with its time boundaries; `RateLimit`, `Paths`, `Config` (defaults and refused switch combinations), `ChatGuestView` (exact keys; `g` stable within a day and a channel), `tournamentState`, `StripeSignature::verify`, subscription shapes, the precedence rule, `StripeClient::norm`, `stripe-setup.php` against the Stripe stub, migration lint | same command; PHP-calling files skip without `PHP_BIN` | PHP 8.3 |
| HTTP integration | Real PHP and a real database through the public API: sessions and role isolation, member isolation and the account-takeover regression, read-only sessions (no file, no cookie), 503 for a database behind the code, `client_outdated`, session lock released before background jobs, login timing, public guest routes (no cookie, GET only, initials only), chat (guest and member projections, 204 polling, tombstones, idempotent sending, limits, moderation, retention, kill switch), sign-up, profiles, photos (formats by content, EXIF removed), Stripe flows on the stub (402, Checkout, confirm, grace, webhook signatures, events pull, precedence, deletion, headers), migrations and backups on a second database | `bash scripts/test-http.sh <port> <db>` (`tests/http.test.mjs` first, then every `tests/*.http.test.mjs`) | PHP 8.3, MariaDB or MySQL |
| Back-compat (CI) | The previous commit's code and its `tests/http.test.mjs` create data; the new migrations run twice and change no old row (per-table data hash); the old code then runs on the migrated schema (what an automatic rollback relies on) | job `http-compat` in `.github/workflows/deploy.yml` | MySQL 8.0 and MariaDB 10.6 services |
| Deploy scripts | `deploy-remote.sh` (`check`, `migrate`, `activate`, `rollback`, `cleanup`, `backup-db`, `backup-files`, `server-check`) and `deploy-verify.sh` on a fake server tree: the first migrate takes a backup and the second none, a failing migration stops before activate, a backup restores with an equal data hash, the floor guard blocks a rollback while members exist, retention keeps the newest copy, maintenance and chat-off flags, `poll-probe.sh` status counting | `bash tests/deploy/deploy-script-test.sh <port> <db>` | bash, PHP 8.3, MariaDB or MySQL |
| Browser (Playwright, Chromium) | Real DOM wiring of the chat card, the install card, the update bar and the required update, `#screen` never reloaded, focus and live regions, service worker install/offline/update-on-click/half-deployed release/kill switch/demo, the static demo | `MATDRAW_BROWSER_TESTS=1 node --test tests/pwa-build.test.mjs tests/pwa-browser.test.mjs tests/chat-client.test.mjs tests/chat-admin.test.mjs tests/account-ui.test.mjs`; `tests/home-embed.test.mjs` runs whenever Playwright resolves. Caveat: in `tests/account-ui.test.mjs` the PHP-build flow (sign-up, Checkout and return, portal, deletion, temporary password, staff banner) needs `MATDRAW_TEST_URL` and so runs only via `MATDRAW_BROWSER_TESTS=1 bash scripts/test-http.sh <port> <db> tests/account-ui.test.mjs`; with the plain `node --test` call above (and in the CI browser job) only its demo part runs and the PHP part is skipped | Playwright + Chromium (not a repository dependency) |
| Manual QA | The list of plan section 11 (home page at four widths, two tabs and two browsers, guest view, sign-up to Checkout and back, Admin flows, PWA, accessibility, demo, shared device, member preview, console without CSP violations), run in Playwright on the PHP release with the Stripe stub and on the static demo | see `docs/plan/PLAN-CZAT-PLATNOSCI-PWA.md`, section 11 | PHP release, stub |

## 2. Environments

- **Local:** PHP 8.3.6 (gd with WebP, curl, openssl, intl, exif, pdo_mysql, mbstring, zlib, sodium), MariaDB 10.11.14, Node 22. The HTTP harness uses a throw-away database and a Stripe stub on `<port+1>`; nothing leaves 127.0.0.1.
- **CI (GitHub Actions):** `ubuntu-24.04`, PHP 8.3 with `pdo_mysql, mbstring, gd, curl, openssl, intl, exif`; the HTTP job and the back-compat job run on **MySQL 8.0 and MariaDB 10.6** (the production engine is MariaDB 10.6; only MySQL 8.0 catches some regressions, for example strict `GROUP BY` and the chat message counter); the deploy-script test runs on MariaDB 10.6 with the runner's MySQL 8 `mysqldump` (this also exercises the `--column-statistics=0` branch); the browser job is informational and does not block a deploy.
- **Migrations:** `backend/migrations` (0002 accounts, 0003 chat, 0004 billing, 0005 staff index) are linted (`tests/migrations.test.mjs`) to the SQL subset common to MariaDB 10.6 and MySQL 8.0, only add, and run twice in every HTTP job (the second run changes nothing).

## 3. Measured at the base of the documentation task (commit `aa5598b`, MariaDB 10.11.14)

| Run | Result |
|---|---|
| `PHP_BIN=… node --test tests/*.test.mjs` (27 files) | 345 tests: 265 pass, 0 fail, 80 skipped (the HTTP files, which need `MATDRAW_TEST_URL`, and the Playwright runs) |
| `bash scripts/test-http.sh 8280 matdraw_qa_docs_http` (installer, `migrate.php` twice, Stripe stub) | `tests/http.test.mjs` 2/2 and the five `*.http.test.mjs` files together 72/72 pass (`accounts`, `billing`, `chat`, `isolation`, `profiles`); exit code 0 |
| `tests/pwa-build.test.mjs`, `tests/pwa-sw.test.mjs` after adding the manifest screenshots | 24 pass, 1 skipped (the browser run) |

`tests/integration.http.test.mjs` (contracts across slices) is added with the final review and counted in the placeholder above.

## 4. Earlier baseline (2026-10-29, version 3 of the app, unchanged facts)

Passed 20 automated tests: 11 existing JavaScript rule tests, 5 multi-tournament/role tests, 3 PHP domain/parity tests, and one real HTTP/PHP/MariaDB integration scenario with multiple assertions. PHP 8.3.6 / MariaDB 10.11.14 were run locally with an isolated disposable test database. The installed release package was exercised through its public API, not only through domain mocks. Confirmed anonymous denial, CSRF rejection, account creation, club-derived ownership, cross-club denial, editor ownership, same-athlete registration in two tournaments, age on each event date, isolated weigh-in and snapshots, duplicate entry denial, rollback of combined creation/registration, date lock, closed/finished guards, last-admin protection, password change, blocked-account session revocation, logout, no private hashes in API responses, and two concurrent writes yielding one success and one 409.

PHP and JavaScript classification agree on 448 boundary combinations. PHP and JavaScript draws cover 3–64 entrants, preserving all entrants and producing n−1 played matches. PHP syntax checks and application JavaScript syntax checks pass.

Browser QA at that time: desktop admin login via demo shortcut; creation of a third tournament; accounts/roles view; club login; filtering to 8 own-club profiles; registering an existing athlete in the newly created tournament. Mobile login and tournament collection checked at 390 px iframe width (375 px content); no horizontal body overflow. MEDUCASE logo and link preserved. All browser data were fictional demo data.

## 5. Security checklist

The checklist of plan section 10 is checked by tests and by code review; each point has a test or a place in the code (the orchestrator records the evidence per point in the final report). Examples of what the tests pin down: members never reach `Repository::load()` (`command` 403, empty `bootstrap`); `persist()` never upserts `users` (account-takeover regression gives 409 and leaves the member row alone); every session POST route checks Origin and CSRF; guest chat JSON has exactly the keys `id r t g c b` (or `id r t g x`) and no personal data; user data never travels in a URL; HTML sinks only in `setHtml`; the Stripe key is refused in `argv` by `stripe-setup.php` and never printed or written; Stripe calls never run inside a database transaction or while the session lock is held; webhook signatures are verified with a ±300 s window; photos are re-encoded by GD (no EXIF, no polyglot) and never served to guests; rate-limit buckets are HMACs of the address.

## 6. What can only be verified on the real server or phone

These need `matbravo.com`, the AfterMarket account (web9, DirectAdmin, PHP 8.3, MariaDB 10.6), the owner's Stripe account or a real device. Where to look is in `HANDOFF.md` (steps 3 to 14) and `DEPLOY-PL.md`.

- **GD with WebP** on the hosting's PHP 8.3 (`server_check`, line about GD; the Admin's `route=diagnostics` shows `avatarMode`). Without it profile photos are off and initials stay; everything else works.
- **Outbound HTTPS from PHP to `api.stripe.com`** (`server_check` line "Stripe:", and `route=diagnostics&probe=stripe` from the site's own PHP). If blocked, payments cannot work on this host.
- **Webhooks:** the host answers 403 to data-centre addresses, so Stripe probably cannot deliver; payment state is correct without them (tested on the stub with no webhooks). Whether AfterMarket allows Stripe's IP list is open.
- **Cron:** whether DirectAdmin offers cron jobs on this plan (`server_check` shows `crontab`). Everything runs without it.
- **Request limits of the host** (429, 503 and 508 answered before PHP) with many phones behind one address: `bash scripts/poll-probe.sh https://matbravo.com 5 600` from a laptop or phone hotspot (never from the server or GitHub); criterion zero 429/503/508; also DirectAdmin "Resource Usage" while it runs.
- **Headers and types** served by LiteSpeed from `.htaccess`: `sw.js` with `no-cache`, manifest as `application/manifest+json`, compression, `.webp` type (`curl -sI`, and the checks of `deploy-verify.sh`).
- **Database rights** (ALTER, CREATE, INDEX, REFERENCES; MySQL 8.0 needs REFERENCES, MariaDB does not), `mysqldump`/`mariadb-dump`, and the host's own backups (frequency, retention, restore).
- **Sessions in the app's own directory** on the real file system (cleanup by kind, inode count) and `fastcgi_finish_request` / `litespeed_finish_request` behaviour (jobs after the response).
- **Real Stripe:** live-mode keys, the restricted key's permissions, the Customer Portal configuration, Smart Retries, 3DS, Apple Pay and Google Pay, receipts, a real payment and its refund, Stripe's own e-mails.
- **Devices:** installation on Android and on a Polish iPhone (the iOS 26 hint is unverified), login inside the installed app, the return from Stripe (iOS opens it in a Safari sheet with separate cookies), airplane mode, the hall screen on a real projector, A4/A3 prints on a real printer.
- **Legal texts** (terms, privacy policy, VAT/OSS/KSeF, withdrawal, minors) are out of scope and a launch gate (`HANDOFF.md`, P19 and P22).

## 7. Limits of this validation

- The Stripe stub follows the documented API shapes (`basil` and later; subscription periods on items) and is strict about the client contract, but it is not Stripe: the first test-mode run on the real account is part of the owner's steps.
- Browser tests run in Chromium only; Safari and Firefox were not driven by automation.
- Load was tested through `poll-probe.sh` logic and the deploy-script test, not against the production host.
- Rule ambiguities remain documented in the app (see `README.md`, "Rule limitations"). Existing print/projector features are retained; physical printer/projector and the owner's PHP hosting remain to be checked at installation.
