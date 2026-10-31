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

## Languages (PL / EN)

- The interface is available in Polish and English. On the first visit the browser's preferred language decides (`navigator.languages[0]`, else `navigator.language`): Polish (`pl`, `pl-PL`, …) gives PL, anything else EN. The PL | EN switcher in the top bar and on the login screen re-renders the current view (filters, search, typed login data are kept) and remembers the choice in `localStorage` (`matdraw.language`), which then wins over detection. Other open windows, such as the hall screen, follow the change. `dist/lang-boot.js` sets `<html lang>` before the first paint (a classic script, so the CSP needs no inline code).
- Gettext style: the Polish text in the code is both the key and the Polish output, e.g. `T('{n} klubów',{n})` in `dist/app.js`. English lives in `dist/i18n-en.js`; a value is a string with the same `{placeholders}`, or `{one,other}` for counts. A missing entry falls back to Polish, so the Polish interface does not depend on the dictionary.
- Data and the API stay Polish. Rule-engine labels (events, age groups, sex, weight/height classes, grade bands), server (PHP) error messages, demo-adapter messages and stored activity entries are translated only when displayed (`ruleLabel`, `ruleText`, `translateMessage` in `dist/i18n.js`); an unknown message is shown unchanged. PHP, `engine.js` and category ids are unchanged, so JS/PHP parity is unaffected.
- Dates and decimal numbers use `pl-PL` / `en-GB`; times stay in Europe/Warsaw. User data (names, clubs, tournament names, mat names) is not translated. Category codes (UF-01, LC-02, …) are identifiers and are the same in both languages.
- English taekwondo terms follow ITF usage: Patterns (układy formalne), sparring (walki), Special techniques, Power test, Gup (Polish "Cup") and Dan.
- To add or change text: write it as `T('Polski tekst')`, add `'Polski tekst':'English text'` to `dist/i18n-en.js`, then run `node --test tests/i18n.test.mjs`. The test fails for a key without an English entry, mismatched placeholders, Polish letters in English text, Polish text in `app.js` outside `T()`, and any PHP, demo-adapter or rules-engine message without a translation, so a new server message needs an English entry too.
- `dist/architecture.html` contains both languages (`.only-pl` / `.only-en` blocks) and has its own switcher.

## Public schedule and guest preview

The login screen lists **upcoming tournaments** (nearest first). Picking one opens a sponsor pop-up (an advertisement); only closing it opens a **read-only guest preview** of that tournament. Guests cannot write anything: the preview has no forms, the browser accepts only navigation actions without a session, and the server has no public write route. The list sits beside the headline on desktop, below the hero on tablets and below the login form on phones; if it cannot be loaded, the login still works and the box shows a quiet note.

Two unauthenticated, read-only, GET-only routes serve it. They run before the session is started, so they set no cookie and need no CSRF token; other methods get `405`, unknown, draft or past tournaments `404`. Successful responses are `Cache-Control: public, max-age=60`. Every public field is defined in `backend/src/GuestView.php` (mirrored for the demo by `dist/guest-view.js`), and `Repository::guestTournaments()` reads only tournaments that may be public (never accounts or the athlete database):

- `api/index.php?route=public` returns `{tournaments:[{id,name,date,city,status}]}`: tournaments that are not drafts (`open`, `closed`, `finished`) dated today or later in Europe/Warsaw, sorted by date, at most 6.
- `api/index.php?route=public-tournament&id=…` returns, for such a tournament only: the same five fields; `summary` `{entries,clubs,categories,brackets}` (counts); `categories` `[{code,event,type,title,subtitle,gradeType,athletes,state,bracket}]`, where `athletes` is a count and `state` is `pending`, `drawn`, `progress`, `finished`, `underfilled` or `list`; and for a saved draw `bracket` `{size,slots:[{initials,club}|null],results:{matchId:slotIndex}}`.
- Athletes appear only inside saved brackets and only as **initials and club name**. Initials are made on the server (the API never sends a full name): the first letter of the first word and of the last word of the name, each followed by a dot (`Jan Kowalski` → `J. K.`, `Anna Maria Kowalska` → `A. K.`); a hyphenated surname keeps each part (`Kowalska-Nowak` → `K.-N.`); a one-word name gives one letter; diacritics are kept (`Łukasz Żak` → `Ł. Ż.`); leading punctuation is skipped.
- Never public: full names, birth dates, ages, weights, heights, athletes' grades, check-in or presence, champion flags, e-mail addresses, accounts, password hashes, entry/profile/club/user ids, tournament creators and mats, activity, revisions, draft or past tournaments, start lists of points events.

`tests/workspace.test.mjs` and `tests/php.test.mjs` check the allow-list, the initials, the exclusion of drafts and past dates, and that PHP and the demo produce identical output; `tests/http.test.mjs` checks the real API (headers, no cookie, 404/405, no full names, no writes).

To change the advertisement or the encouragement to log in shown in the preview, edit the `AD` and `ACCESS` objects in `dist/promo.js` (Polish text; English goes to `dist/i18n-en.js`, and `tests/i18n.test.mjs` fails until it is there). The brand in the sample ad, KYORUVO, is invented and labelled as fictional. Only the app's own files may be used (CSP): draw visuals in CSS or inline SVG, no external images, links or tracking. `ACCESS.kind` (`'login'` today) is the hook for a later paid-access offer, which would also need a handler for the `access-cta` action in `dist/app.js`.

## Brand (MatBravo brand kit 1.0)

- Files: `dist/brand/` (logo SVGs, Matbravo WebP images, app icons, `og-image.jpg`), `dist/favicon.svg` + `favicon.ico`, `dist/manifest.webmanifest`; styles in `dist/brand.css`. They are web exports of the brand kit, which is not stored in the repository. The SVGs are plain paths (no scripts, links or embedded images) with the viewBox cropped to the drawing; the character images are cropped and sized at 2× their display size. All files are self-hosted, as the CSP requires.
- Typography: Manrope (variable, weights 400–800), self-hosted as WOFF2 subsets in `dist/fonts/` (Latin incl. Polish; the Cyrillic file loads only when such letters appear). Licence: SIL Open Font License 1.1, `dist/fonts/OFL-Manrope.txt`.
- Logo: white on navy (sidebar, login, guest bar, hall screen), colour on white (print sheets, `architecture.html`); the belt mark for the smallest surfaces (favicon, app icons, guest bar on phones). The MEDUCASE logo and link in the footers are unchanged.
- Matbravo, the character, only welcomes, guides, invites and celebrates: the login screen (waving behind "Upcoming tournaments", the kit's 6.4 s breathing loop with a pause button, static under `prefers-reduced-motion`), the guest "more after login" card (guide pose), empty states (round avatar), the category champion banner (success pose) and the About page (master pose). He never appears in lists, tables, brackets, prints or on the hall screen, and users keep their initials avatars. The images are decorative (`alt=""`, `aria-hidden`).

## Architecture

`dist/client.js` chooses the demo or API adapter via `runtime-config.js`. The PHP package selects `mode:'api'`. `workspace.js` models demo commands; `backend/src/Domain.php` enforces production commands. `Rules.php` independently validates and resolves brackets. Tables normalize ownership and foreign keys; profile attributes, entry snapshots and draw payloads are JSON. Repository transactions hold `app_meta` via `SELECT ... FOR UPDATE`, compare a revision, then persist changed records. Reads use a consistent transaction. Optimistic revision checking prevents stale overwrites and duplicate retried writes.

Auth uses secure HttpOnly SameSite cookies, CSRF for all writes, login throttling, idle/absolute expiry and session revocation after role/club/email/password changes or blocking. Apart from the public schedule and guest preview described above, every read requires a session. No public signup, email delivery, automatic password recovery, judge role or unauthenticated projector token is implemented. The admin can reset a verified user's password. Last active admin cannot be disabled or demoted.

The initial version loads the whole authorized workspace and globally serializes writes. It is intended for small/medium tournaments; large histories need pagination and per-aggregate revisions. Tournament activity is a bounded list of 40 changes, not a full audit ledger. Rules are not versioned per tournament in this release; changes to the rule engine require explicit migration planning for historical categories.

## Rule limitations

No bronze-medal rule is silently selected. Ambiguous female Cup light-contact and younger female semi-contact weight categories remain blocked. Age 45 in split veteran groups is blocked. Date-of-birth age is calculated on tournament day and needs coach approval. Younger Dan eligibility, 200 g tolerance semantics, decimal boundaries, soft/kalaki equivalence, >16 placement and points-list format need coach confirmation. Draws support 3–64 entrants; heuristics reduce club collisions but do not guarantee an optimum. See `dist/architecture.html` and the app's rules page.

## Third-party code

`dist/vendor/noble-hashes/` contains the required modules from `@noble/hashes` 2.4.0 (MIT; license included). It supplies PBKDF2 only for the local demo on HTTP preview origins where Web Crypto is unavailable. HTTPS demo uses Web Crypto; the actual backend uses PHP password_hash. Local demo accounts are not a security boundary.

## Deployment through CI/CD

Deploy the existing application to the owner's PHP/MySQL hosting through CI/CD. The current task is deployment; see `HANDOFF.md` in the source repository and `INSTALL-PL.md` for operational steps. Existing feature descriptions and known limitations above are reference material, not additional development tasks.

Build the release with `node scripts/build-php.mjs ./build/matdraw-php`. Serve its `public/` and keep `backend/` outside web access. Configure secrets persistently outside version control and preserve them across releases. Initialize the database and first administrator only for the first installation. The PHP hosting and its CI/CD configuration are to be set up for this deployment. Sites was used for the earlier static preview and is not the deployment target of this export.
