# MatDraw

Responsive Polish taekwondo tournament app for MEDUCASE. Brand: MatBravo (formerly MatDraw); domain `matbravo.com`. Internal identifiers (PHP namespace, cookie, storage keys) keep the `matdraw` name.

## Two runtimes

- `dist/`: self-contained Sites preview. Clearly marked demo accounts and local browser storage. Fictional athletes, role shortcuts, no shared online authentication.
- `backend/`: PHP/PDO + MySQL implementation with real sessions, password authentication, server-side role and club authorization, transaction/revision guards, rules, bracket results, schema and first-admin CLI installer. Requires deployment on PHP hosting; not executed by Sites static hosting.

The interface has multiple tournaments and one reusable athlete directory. An entry is a per-tournament snapshot: age, grade, events, registration weight, check-in and results stay isolated. Profiles can be archived without deleting history. Club representatives see only their own club. Admins provision, edit and block accounts. Editors manage tournaments and profiles they create. Registration status and finished-tournament locks are enforced on the server.

The original MEDUCASE logo links to https://mdcse.com in the app, login, print and projection footers. Navy/blue/cyan follow the logo. A4/A3 previews, split large brackets and a separate projector window remain available. The PHP projection refreshes every 15 seconds and requires an active session.

## Run and package

Static demo: serve `dist/` with any static HTTP server. No build required.

```bash
node --test tests/*.test.mjs
node --check dist/app.js
node scripts/build-php.mjs /absolute/path/matdraw-php
```

Read [INSTALL-PL.md](INSTALL-PL.md) for PHP deployment. Set document root to the release's `public/`; keep `backend/` outside web access. Set `backend/config.php` from the example (never commit secrets), create a MySQL database and run the CLI installer. The package starts empty and contains no production demo accounts. Existing browser demo data is not imported into the server.

PHP requires 8.3+, PDO MySQL and mbstring. MySQL 8.0+ or MariaDB 10.11+ with InnoDB. No Composer, Node server, SMTP or cron needed at runtime. To test PHP, use `PHP_BIN=/path/to/php node --test tests/php.test.mjs`. HTTP integration test requires a separate disposable initialized database and test server, as documented in that test file.

## Architecture

`dist/client.js` chooses the demo or API adapter via `runtime-config.js`. The PHP package selects `mode:'api'`. `workspace.js` models demo commands; `backend/src/Domain.php` enforces production commands. `Rules.php` independently validates and resolves brackets. Tables normalize ownership and foreign keys; profile attributes, entry snapshots and draw payloads are JSON. Repository transactions hold `app_meta` via `SELECT ... FOR UPDATE`, compare a revision, then persist changed records. Reads use a consistent transaction. Optimistic revision checking prevents stale overwrites and duplicate retried writes.

Auth uses secure HttpOnly SameSite cookies, CSRF for all writes, login throttling, idle/absolute expiry and session revocation after role/club/email/password changes or blocking. No public signup, email delivery, automatic password recovery, judge role or unauthenticated projector token is implemented. The admin can reset a verified user's password. Last active admin cannot be disabled or demoted.

The initial version loads the whole authorized workspace and globally serializes writes. It is intended for small/medium tournaments; large histories need pagination and per-aggregate revisions. Tournament activity is a bounded list of 40 changes, not a full audit ledger. Rules are not versioned per tournament in this release; changes to the rule engine require explicit migration planning for historical categories.

## Rule limitations

No bronze-medal rule is silently selected. Ambiguous female Cup light-contact and younger female semi-contact weight categories remain blocked. Age 45 in split veteran groups is blocked. Date-of-birth age is calculated on tournament day and needs coach approval. Younger Dan eligibility, 200 g tolerance semantics, decimal boundaries, soft/kalaki equivalence, >16 placement and points-list format need coach confirmation. Draws support 3–64 entrants; heuristics reduce club collisions but do not guarantee an optimum. See `dist/architecture.html` and the app's rules page.

## Third-party code

`dist/vendor/noble-hashes/` contains the required modules from `@noble/hashes` 2.4.0 (MIT; license included). It supplies PBKDF2 only for the local demo on HTTP preview origins where Web Crypto is unavailable. HTTPS demo uses Web Crypto; the actual backend uses PHP password_hash. Local demo accounts are not a security boundary.

## Deployment through CI/CD

Deploy the existing application to the owner's PHP/MySQL hosting through CI/CD. The current task is deployment; see `HANDOFF.md` in the source repository and `INSTALL-PL.md` for operational steps. Existing feature descriptions and known limitations above are reference material, not additional development tasks.

Build the release with `node scripts/build-php.mjs ./build/matdraw-php`. Serve its `public/` and keep `backend/` outside web access. Configure secrets persistently outside version control and preserve them across releases. Initialize the database and first administrator only for the first installation. The PHP hosting and its CI/CD configuration are to be set up for this deployment. Sites was used for the earlier static preview and is not the deployment target of this export.
