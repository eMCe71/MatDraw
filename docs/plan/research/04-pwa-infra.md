# 04 - PWA and deployment/infrastructure changes

Status: research and design (no repository file changed except this report). Date: 2026-10-31. Author: PWA + infra subtask.
Scope: owner requirement 7 (PWA and "add to home screen" incentives) plus every deploy/infrastructure consequence of requirements 1-5 (migrations, uploads, headers, config, CI).
Related reports: `01-code-map.md` (code map), `02-realtime.md` (chat transport; its `/live` beacon and `chat-off` file are reused here).

Legend: **[verified here]** = executed in this container (PHP 8.3.6, Node 22, MariaDB 10.11 - production is MariaDB 10.6 and CI also tests MySQL 8.0, so DB results are "10.11 only"); **[source]** = taken from a search result or a page found in this session (links at the end); **[memory]** = my own knowledge, not re-checked (WebFetch to MDN/web.dev/Stripe docs is blocked in this session); **[unverified]** = must be checked on web9 or on a real device.

---

## 0. Summary and decisions

### PWA
1. **Installable web app, no "app store" machinery.** Manifest (PL + EN variants), one root-scope service worker, an offline page, an update toast and a gentle install card. No Workbox, no framework, no new dependency.
2. **The worker never touches private data.** It only answers same-origin GET for the app shell (a versioned precache, about 480 KB, 32 files) and the offline page. `api/`, `u/` (uploads) and `live/` (beacon) are not intercepted at all, so the browser goes straight to the network. POST is never touched. Nothing a user logs in with, writes in chat or pays for is ever stored by the worker.
3. **A new release = a new worker.** `scripts/build-pwa.mjs` (called last by `build-php.mjs`) hashes the shell and writes `public/sw.js` (build id and file list substituted into two markers) and `public/version.json`. Identical content gives an identical hash, so backend-only deploys do not produce "update available" noise. I ran this step on the real `dist/` in the scratchpad **[verified here]**.
4. **Updates are user-driven.** The new worker installs in the background and waits; the page shows "A new version is available - Refresh"; only that click calls `skipWaiting()` and reloads **only that tab**. The hall projection window (`#screen`) is never reloaded or covered automatically.
5. **Install incentives are earned, not shown on first paint.** A deferred `beforeinstallprompt` (Chromium), a custom bottom card after real engagement (logged in, or 2nd visit on another day, or 90 s active in chat), 30-day dismissal memory, an iOS "Share -> Add to Home Screen" sheet, a banner that asks Instagram/Facebook in-app browsers to open the real browser, and a permanent passive "Install the app" entry in the account menu.
6. **Web Push is feasible in pure PHP** (VAPID + RFC 8291 encryption with only `ext-openssl`; I round-tripped an encrypted payload from PHP into an independent Node decryptor and validated an ES256 VAPID JWT **[verified here]**) but it is **not** part of launch. The hook (a `Notifier` interface with a null driver, a reserved table, config block, worker handlers spec) is designed so it can be switched on later without touching chat or billing code.
7. **Chrome still wants a real `fetch` handler for the automatic install prompt** [source: Chrome blog via search snippet], so the worker has a substantive one (it is not a no-op).

### Infrastructure
1. **Migrations:** `backend/bin/migrate.php` + `backend/src/Migrator.php` + `backend/migrations/NNNN_name.php`, versioned by `app_meta.schema_version` (already exists, value 1 = today's `schema.sql`). Idempotent, **additive-first (expand/contract)**, run by the deploy **before** activation with `/usr/local/php83/bin/php`, after an automatic gzip'd `mysqldump` into `~/matdraw/backups` (pure-PHP dump as fallback). A failed migration stops the deploy while the previous release keeps serving. A CI job proves that the **previous release's code still passes its own HTTP tests on the new schema** (that is what makes code rollback safe).
2. **`install.php` = frozen baseline `schema.sql` + the same Migrator + first admin.** `schema.sql` is never edited again.
3. **Uploads (avatars)** live in `~/matdraw/shared/uploads` (config key `uploads_dir`, default derived from the real path of `config.php`, so zero extra configuration). Served by a PHP route with ETag and immutable versioned URLs (works with mode 700 and enforces who may see an avatar); a static symlink variant is prepared but off by default. GD/WebP are probed in `server-check`; without GD the client resizes and the server validates strictly.
4. **`.htaccess`:** add MIME types (`.webmanifest`!), `Cache-Control: no-cache` for the un-fingerprinted app files (today browsers may serve stale `app.js` for hours after a deploy - see 2.c), long cache for fonts and images, compression. **No CSP change.** The `RewriteEngine` block (429 quirk) is untouched.
5. **Config:** new optional keys `uploads_dir`, `stripe{...}`, `push{...}`, `chat_force_off`, `pwa_stats`, `db_migrate`. Deploy `check` and `verify` get the new probes; the 429/403 handling is unchanged.
6. **CI:** new unit tests (service worker, manifest, migrations lint), HTTP tests with migrations, a fake Stripe stub, a "previous code on new schema" job, and a job that runs `deploy-remote.sh` against a local fake server directory so the new deploy logic is tested without SSH.

### Decisions I need from the owner / other workstreams (details in section 4)
- Are avatars visible to guests? (Default proposed: members only; guests get the mascot placeholder. Static serving is only valid if avatars are public.)
- Run the `server_check` workflow once after the new probes land; it answers GD/WebP, mysqldump, crontab, outbound HTTPS.
- Whether anonymous install counters (`pwa_stats`) are wanted (default proposed: yes, aggregate only, flagged for the later legal session).
- Session length vs installed app (30 min idle logout, session cookie): see 4.2, this affects the PWA experience more than any manifest field.

---

# PART 1 - PWA

## 1.1 What exists today (read in this session)

| Item | Finding |
|---|---|
| `dist/manifest.webmanifest` | name/short_name MatBravo, `lang: pl`, `start_url: ./`, `scope: ./`, `display: standalone`, `background_color #EFF8FF`, `theme_color #00448A`, icons 192/512 `any` and **the same 512 file as `maskable`**. No `id`, no `screenshots`, no `shortcuts`, no `display_override`. |
| `dist/index.html` | Links manifest, `apple-touch-icon` (180), `theme-color`, favicon svg/ico. No service worker. No `apple-mobile-web-app-title`. Viewport has no `viewport-fit` (keep it that way, see 1.3.3). Body has `#app`, `#modal-root`, `#toast` (auto-hides after 4.8 s, so it cannot carry an action button), `#print-root`. |
| Service worker | None. Nothing in `app.js` mentions `serviceWorker`, `beforeinstallprompt` or `matchMedia('(display-mode...)')`. |
| `dist/brand/icon-512.png` | 512x512, 8-bit RGBA but fully opaque, **full-bleed navy `#00448A`** with the white belt mark centred. **[verified here]** I measured the farthest non-background pixel from the centre: **195.7 px = 38.2 % of the width**; the maskable "safe zone" is a circle of radius 40 % (204.8 px). **The icon already respects the maskable safe zone**, so declaring it `maskable` is legitimate (the existing manifest is correct on this point). Vertical centring is off by about 4 px (top margin 25.6 %, bottom 26.4 %): invisible, not worth a re-export. |
| `icon-192.png`, `apple-touch-icon.png` (180) | Same artwork, same margins (17-26 %). Full-bleed square, which is what iOS wants (it applies its own rounding). |
| Consequence for the `any` purpose | On desktop (Windows/macOS/ChromeOS) the `any` icon is shown as is: a flat navy square, whereas other apps show rounded or transparent-padded icons. Optional polish (asset list in 1.3.4): a rounded, padded `icon-any-512.png`. Not a blocker. |
| Static caching | `backend/public/.htaccess` sets no `Cache-Control` for static files and the app does not fingerprint file names (`./app.js`, `./styles.css`). After a deploy, browsers can reuse a heuristically cached `app.js` (freshness = a fraction of the age since `Last-Modified`). The files are copied with `cp -a` from a tar made in CI, so `Last-Modified` is "build time"; a user could run mixed or stale code for hours. This is an existing weakness; the PWA work fixes it (section 2.c) because a stale worker + stale files is the classic way PWAs break. |
| CSP | `default-src 'self'; script-src 'self'; ...; connect-src 'self'`. Workers fall back `worker-src -> child-src -> script-src`, manifests use `manifest-src -> default-src`: **a same-origin `sw.js` and manifest are allowed without any change** (reasoning from CSP3 fallback rules **[memory]**; test on a real browser: 3.2 checklist). |
| Hash routing | The app is hash-routed (`#tournaments`, `#screen?...`) and ignores the query string, so `start_url` can carry `?source=pwa` freely. The hall screen opens with `window.open(pathname+'#screen?...')`, printing is in-page (`#print-root`, `window.print()`): no extra windows to break. |
| Session cookie | `matdraw_session`, `SameSite=Strict`, session cookie (`lifetime 0`), idle 1800 s, max 43200 s. HTML is static and the SPA calls the API with `fetch` from its own origin, so **Strict does not hurt installed-app launches or returns from Stripe** (the first navigation carries no cookie, but nothing on that navigation needs one). The *lifetime* does hurt, see 4.2. |

## 1.2 Installability criteria (as of 2026) and the `fetch` handler question

What I could confirm by search (primary pages not fetchable here):

- Chrome's own post "Revisiting Chrome's installability criteria" (developer.chrome.com/blog/update-install-criteria) **[source: search snippet]**: the requirement for a service worker with a `fetch()` handler was **removed for installation from the browser menu** (Chrome 108 on Android, 112 on desktop) but **the algorithm that shows the install prompt (and fires `beforeinstallprompt`) still requires a `fetch()` handler**. A manifest-only app can be installed from the menu but never gets the automatic prompt. The same post says Chrome will later experiment with relaxing some manifest-field requirements (nothing shipped that I could confirm).
- MDN's "Making PWAs installable" still lists a service worker with a fetch handler as required **[source]**; several 2026 checklists repeat it; one project reports that an *empty* handler was ignored by newer Chrome and another that a no-op one worked **[source, conflicting, unverified]**.
- Common criteria **[source + memory]**: HTTPS (or localhost); manifest linked with `name` or `short_name`, `start_url`, `display` one of standalone/fullscreen/minimal-ui/window-controls-overlay, icons 192 px and 512 px (PNG/SVG/WebP); `prefer_related_applications` not true; not already installed; (for Android WebAPK minting) the same manifest rules. Lighthouse 12+ dropped its PWA category **[memory]**: use DevTools -> Application -> Manifest/"Installability" and, in automation, CDP `Page.getInstallabilityErrors` **[memory, unverified]**.
- Richer install UI **[source: web.dev/MDN snippets]**: `screenshots` with `form_factor: "wide"` (desktop, Chrome 109+; 1-8 images) and `"narrow"` (Android; 1-5 images). Screenshots of one form factor must share an aspect ratio. Untagged screenshots are still shown for backward compatibility. Chrome's pixel bounds (about 320-3840 px, long side at most 2.3x the short side) are **[memory, unverified]**.
- Firefox (desktop) does not install PWAs; Firefox for Android installs to the home screen; Safari macOS 17+ has "Add to Dock" without any event; Safari/iOS has no `beforeinstallprompt` **[memory]**.

**Decision:** ship a worker whose `fetch` handler does real work (shell cache, offline fallback). That satisfies both readings of the criteria. Do not rely on the menu-install exception.

## 1.3 Manifest

### 1.3.1 Two files, one identity

- `dist/manifest.webmanifest` (Polish) and `dist/manifest.en.webmanifest` (English). Same `id`, `start_url`, `scope`, icons; different `description`, `shortcuts[].name`, `screenshots[].label`. The manifest format has no per-language members, and installing in the "wrong" language is a visible defect for a bilingual product.
- `dist/lang-boot.js` (runs before first paint, already decides `pl|en`) gets two lines: when `lang==='en'`, set `document.querySelector('link[rel=manifest]').href='./manifest.en.webmanifest'`; `rerenderLanguage` in `app.js` does the same on a language switch (via a tiny `setManifestLanguage(lang)` exported from `pwa.js`). Browsers read the manifest lazily, so an early swap works **[memory, unverified; check in DevTools on Chrome Android and desktop]**. Without JavaScript the Polish file is used.
- Both files are precached by the worker (so "install" works offline from the cache).
- `tests/i18n.test.mjs` compares `lang-boot.js` with `resolveLanguage()` (test around line 33); update it so the added lines are allowed.

### 1.3.2 Polish manifest (the English one differs only in the commented fields)

```json
{
 "id": "/",
 "name": "MatBravo",
 "short_name": "MatBravo",
 "description": "Czat i drabinki turniejowe taekwondo, judo i karate: zgłoszenia, kontrola startowa, wyniki.",   // EN: "Chat and tournament brackets for taekwondo, judo and karate: entries, check-in, results."
 "lang": "pl",                                                                                                  // EN file: "en"
 "dir": "ltr",
 "start_url": "./?source=pwa",
 "scope": "./",
 "display": "standalone",
 "display_override": ["standalone", "minimal-ui"],
 "background_color": "#EFF8FF",
 "theme_color": "#00448A",
 "categories": ["sports", "social"],
 "prefer_related_applications": false,
 "icons": [
  {"src": "brand/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
  {"src": "brand/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
  {"src": "brand/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable"},
  {"src": "brand/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}
 ],
 "shortcuts": [
  {"name": "Czat", "short_name": "Czat", "url": "./?source=shortcut#chat", "icons": [{"src": "brand/shortcut-chat-96.png", "sizes": "96x96", "type": "image/png"}]},
  {"name": "Turnieje", "short_name": "Turnieje", "url": "./?source=shortcut#tournaments", "icons": [{"src": "brand/shortcut-tournaments-96.png", "sizes": "96x96", "type": "image/png"}]}
 ],
 "screenshots": [
  {"src": "screenshots/wide-chat.webp", "sizes": "1280x800", "type": "image/webp", "form_factor": "wide", "label": "Czat na stronie głównej"},
  {"src": "screenshots/wide-bracket.webp", "sizes": "1280x800", "type": "image/webp", "form_factor": "wide", "label": "Drabinka turniejowa"},
  {"src": "screenshots/narrow-chat.webp", "sizes": "1080x1920", "type": "image/webp", "form_factor": "narrow", "label": "Czat w telefonie"},
  {"src": "screenshots/narrow-tournaments.webp", "sizes": "1080x1920", "type": "image/webp", "form_factor": "narrow", "label": "Lista turniejów"}
 ]
}
```
(JSON has no comments; the `//` notes are for this document only.)

Field decisions:

| Field | Value and reason |
|---|---|
| `id` | `"/"`. Explicit, so the app identity never changes if `start_url` is edited later (without `id` Chrome derives identity from `start_url`). Same for both language files. |
| `start_url` | `./?source=pwa`. The query is ignored by the hash router, but `pwa.js` reads it to mark "launched as app" and to feed the local counters. The worker matches navigations with the search string ignored (1.4). The server access log will not show these launches because the worker answers from cache: measurement needs the explicit beacon (1.5.7). |
| `scope` | `./` = `/` (production is at the domain root). |
| `display` / `display_override` | Standalone with `minimal-ui` as the fallback. **Rejected for v1:** `window-controls-overlay` and `tabbed` (need layout work, desktop-only). |
| Icons | Four entries (`any` and `maskable` for each size) pointing at files that exist; Chrome wants 192 and 512. Maskable verified safe (1.1). |
| Colours | Kept (`#EFF8FF` background = splash, `#00448A` theme). |
| `shortcuts` | Chat and Tournaments (long-press the app icon on Android, right-click on desktop). `#tournaments` exists today; **`#chat` is an assumption** - it must match the route name chosen by the chat UI workstream. Two new 96x96 PNGs (1.3.4). |
| `screenshots` | Needed for the richer install dialog. Produced **after** the chat/home UI exists, from a headless browser with fictional data (clearly demo content, no real athletes). v1: Polish images in both manifests; English images are a later polish item. Screenshots are **not** precached (installer fetches them over the network). |
| **Rejected** | `launch_handler` (`navigate-existing` could navigate an open **hall projection window** away when someone launches the app; `focus-existing` would be confusing), `share_target`, `protocol_handlers`, `orientation` (do not lock: the hall screen wants landscape, phones portrait), `related_applications`, `iarc_rating_id`. |

### 1.3.3 `dist/index.html` changes

```html
<meta name="theme-color" content="#00448a">                          <!-- already there -->
<meta name="mobile-web-app-capable" content="yes">                   <!-- new: Chrome's current spelling -->
<meta name="apple-mobile-web-app-title" content="MatBravo">          <!-- new: the name under the iOS icon -->
...
<div id="toast" role="status" aria-live="polite"></div>
<div id="pwa-root"></div>                                            <!-- new: update bar, install card, iOS sheet; outside #app so render() cannot wipe it -->
```
- Do **not** add `viewport-fit=cover` or `apple-mobile-web-app-status-bar-style=black-translucent` in v1: without them the page never draws under the notch/home indicator, so no `env(safe-area-inset-*)` work is needed.
- Do not add `apple-touch-startup-image` splash images: iOS builds a splash from the icon and background colour; the per-device image matrix is not worth maintaining **[memory]**.
- The `<script type="module" src="./app.js">` stays; `pwa.js` is imported by `app.js` (1.4.6).

### 1.3.4 New assets (design/asset subtask)

| File | Purpose | Status |
|---|---|---|
| `dist/brand/shortcut-chat-96.png`, `shortcut-tournaments-96.png` | Shortcut icons (white glyph on navy, same family as `icons.js`) | needed for the shortcuts; shortcuts work without icons if skipped |
| `dist/screenshots/*.webp` | 2 wide 1280x800 + 3-4 narrow 1080x1920 (aspect < 2.3) | after the UI is built; each under about 250 KB |
| `dist/brand/icon-any-512.png` (+192) | Optional rounded-corner, transparent, 8 % padded variant for the desktop `any` purpose | optional polish |
| `dist/brand/badge-72.png` | Monochrome notification badge (white on transparent) | only when Push ships (1.6) |
| `dist/offline.html` | Offline page (1.4.4) | required |

## 1.4 Service worker

### 1.4.1 Behaviour specification

| Request | Handling | Why |
|---|---|---|
| Non-GET (login, `command`, chat send, billing) | **Not intercepted** | Writes must always reach the server and never be replayed. |
| Cross-origin, `Range` requests | Not intercepted | Not ours. |
| `api/*`, `u/*` (uploads), `live/*` (chat beacon, 02-realtime) | **Not intercepted** (no `respondWith`): the browser uses the network and its normal HTTP cache rules from the server's `Cache-Control` | "Network-only" in its safest form: the worker cannot cache by accident because it never sees the response. |
| `sw.js`, `version.json` | Not intercepted | The browser's update check and version probe must see the server. |
| Navigation to the app root (`/`, `/index.html`, any query) | From the **current precache**, `index.html` (search ignored) | Instant start, works offline, no mixed releases. The app then calls the API, which reports its own errors. |
| Any other navigation | Network; on failure `offline.html` from the precache | A mistyped URL or an expired link while offline. |
| Shell asset (in the precache) | Cache-first from the current versioned cache | One release = one consistent set of `app.js` + modules + CSS. |
| Other same-origin GET (e.g. `promo/` image, screenshots) | Stale-while-revalidate in `matbravo-static-1` | Not critical, not versioned. |
| `install` | Precache the list with `cache:'reload'`; **any failure fails the install** and the old worker keeps running | Never a half-updated shell. |
| New worker | **Does not** call `skipWaiting` on its own | User-driven update (1.4.3). First ever install has no old worker, so it activates immediately and `clients.claim()` takes over the open page. |
| `activate` | Delete every `matbravo-*` cache that is not the current shell or the static cache | Old releases disappear. |

**Not done on purpose:** no caching of API/public JSON (`route=public`) in v1 - a stale schedule shown as if fresh is worse than an error; no background sync / periodic sync (no iOS support, no need); no navigation preload (cache-first navigation does not need it).

### 1.4.2 Reference implementation (`dist/sw.js`, the template)

Tested **[verified here]** with a Node harness that mocks `caches`, `fetch` and the events (18 assertions: root navigation served from cache with zero network calls; API, uploads, beacon, POST, cross-origin and Range not intercepted; shell asset from cache; static asset stale-while-revalidate and served while offline; offline fallback page; `activate` deletes old versions and leaves foreign caches; `SKIP_WAITING` only on message; a 404 in the precache list rejects `install`). The harness becomes `tests/pwa-sw.test.mjs` (1.7).

```js
/* MatBravo service worker (dist/sw.js is the template; scripts/build-pwa.mjs fills the two markers in the release).
 * Without a precache list (dist/ preview, local development) the worker only passes requests through.
 * Rules: only same-origin GET is ever touched; api/ and uploads are never answered or stored by this worker (the browser
 * goes straight to the network); the app shell comes from one versioned cache, so files of two releases are never mixed. */
const BUILD=/*@build*/'dev',PRECACHE=/*@precache*/[];
const SHELL='matbravo-shell-'+BUILD,STATIC='matbravo-static-1',KEEP=[SHELL,STATIC];
const live=PRECACHE.length>0,scope=new URL('./',self.location).pathname;
const isApp=u=>u.pathname===scope||u.pathname===scope+'index.html';
const isPrivate=u=>u.pathname.startsWith(scope+'api/')||u.pathname.startsWith(scope+'u/')||u.pathname.startsWith(scope+'live/');
self.addEventListener('install',e=>{if(!live)return;e.waitUntil((async()=>{
 const c=await caches.open(SHELL);
 // cache:'reload' bypasses the HTTP cache, so a half-stale copy can never be precached; one failure fails the install (the old worker stays).
 await Promise.all(PRECACHE.map(async u=>{const r=await fetch(new Request(u,{cache:'reload'}));if(!r.ok)throw Error(u+' '+r.status);await c.put(u,r);}));
})());});
self.addEventListener('activate',e=>e.waitUntil((async()=>{
 for(const k of await caches.keys())if(k.startsWith('matbravo-')&&!KEEP.includes(k))await caches.delete(k);
 await self.clients.claim();
})()));
self.addEventListener('message',e=>{if(e.data==='SKIP_WAITING')self.skipWaiting();else if(e.data==='VERSION'&&e.source)e.source.postMessage({build:BUILD});});
self.addEventListener('fetch',e=>{
 const r=e.request;if(!live||r.method!=='GET'||r.headers.has('range'))return;
 const u=new URL(r.url);if(u.origin!==self.location.origin||isPrivate(u)||u.pathname===scope+'sw.js'||u.pathname===scope+'version.json')return;
 e.respondWith(r.mode==='navigate'?navigation(r,u):asset(e,r));
});
async function navigation(r,u){
 const shell=await caches.open(SHELL);
 if(isApp(u)){const page=await shell.match('./index.html');if(page)return page;}
 try{return await fetch(r);}catch{return await shell.match('./offline.html')||Response.error();}
}
async function asset(e,r){
 const hit=await (await caches.open(SHELL)).match(r);if(hit)return hit;
 const c=await caches.open(STATIC),old=await c.match(r);
 const refresh=fetch(r).then(res=>{if(res.ok&&res.type==='basic')c.put(r,res.clone());return res;});
 if(old){e.waitUntil(refresh.catch(()=>{}));return old;}
 return refresh;
}
```
Notes: (a) `STATIC` has no size cap in this sketch; add a trim to 60 entries when the first non-shell cacheable asset type appears. (b) The `push` and `notificationclick` handlers are added with Phase C (1.6), not now. (c) No `Service-Worker-Allowed` header is needed: the worker is at the root and its default scope is the root.

### 1.4.3 Registration, update flow, multi-tab rules (`dist/pwa.js`)

```js
// registerWorker(): only in API mode, only on https or localhost, after the first render, never throws.
if(!('serviceWorker' in navigator)||CONFIG.mode!=='api')return;
const reg=await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});
const offer=w=>showUpdateBar(()=>{refreshing=true;w.postMessage('SKIP_WAITING');});
if(reg.waiting&&navigator.serviceWorker.controller)offer(reg.waiting);
reg.addEventListener('updatefound',()=>{const w=reg.installing;w?.addEventListener('statechange',()=>{if(w.state==='installed'&&navigator.serviceWorker.controller)offer(w);});});
navigator.serviceWorker.addEventListener('controllerchange',()=>{if(refreshing)location.reload();else showUpdateBar(null /* "Updated. Refresh when convenient" */);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-lastCheck>36e5){lastCheck=Date.now();reg.update().catch(()=>{});}});
```

Rules:
- **Only the tab whose user clicked "Refresh" reloads.** Other tabs get a passive notice. `refreshing` is a per-tab flag.
- **The hall screen (`location.hash.startsWith('#screen')`) never shows the bar and never reloads.** A projection window can stay open for a whole tournament day; its already-loaded modules keep running. (After activation, any lazy `import()` from that tab - only the demo-only noble-hashes - would fetch the new release; harmless in API mode, which never loads them.)
- **Printing** (`#print-root`, `window.print()`) is in-page; the worker is not involved. Do not reload while `document.body.classList.contains('print-preview')`; `showUpdateBar` defers until it is removed.
- The bar lives in `#pwa-root` (not `#app`), is an `aria-live="polite"` region, has two buttons ("Refresh", "Later"), and does not steal focus.
- Update checks: browsers check `sw.js` on navigation (about once a day at least) and `updateViaCache:'none'` makes it bypass the HTTP cache; the extra `visibilitychange` check (at most hourly) covers a phone app that stays in memory for days.
- Registration timing: `requestIdleCallback`/`setTimeout(…,2000)` after the first `render()`, so it never competes with first paint or the chat's first poll.
- **Rollback of the code (`deploy-remote.sh rollback`) re-activates an older release whose `sw.js` has an older BUILD.** Browsers treat any byte difference in `sw.js` as an update, so clients receive "new version = the old one" through the normal flow. Correct and safe.
- In the **demo** (`CONFIG.mode==='demo'`, the Sites preview and plain `dist/`) the worker is never registered and the install card is hidden: there is no stable build id there and its data is browser-local.
- If an old tab talks to a newer API: the API stays backward compatible for one release (additive rule, 2.a); the update bar plus a reload fixes the rest.

### 1.4.4 Offline page

`dist/offline.html` is static, self-contained (inline `<style>` is allowed by the CSP `style-src 'unsafe-inline'`; no inline scripts), carries **both languages** (`<p class="pl">`/`<p class="en">`, shown by `html[lang=...]`; it loads `lang-boot.js` to set `lang`), shows the logo (`brand/matbravo-logo-color.svg`), and a "Try again" link to `./`. Copy:
- PL: "Brak połączenia z internetem" / "MatBravo potrzebuje internetu, aby pobrać turnieje i czat. Sprawdź połączenie i spróbuj ponownie." / "Spróbuj ponownie"
- EN: "You are offline" / "MatBravo needs the internet to load tournaments and chat. Check your connection and try again." / "Try again"
The mascot may appear here (it "welcomes/guides"); decorative `alt=""`. Because the page is not rendered by `T()`, a test asserts both language blocks exist.
The app itself (loaded from the cache while offline) must show its own state when `fetch` fails: a banner "Brak połączenia" with automatic retry. That belongs to the chat/home workstream; `pwa.js` exposes `html[data-offline]` from `online`/`offline` events for it.

### 1.4.5 Build integration

`scripts/build-pwa.mjs` (written and run in the scratchpad on a real build **[verified here]**: 33 files, deterministic hash, hash changes when a file changes):

```js
// scripts/build-pwa.mjs - called by build-php.mjs as the LAST step on <target>/public (after runtime-config.js is final).
import {readFile,writeFile,readdir} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';
const DENY=[/^architecture\./,/^promo\//,/^vendor\//,/^brand\/og-image\./,/^fonts\/OFL/,/^screenshots\//,/^api\//,/^\.htaccess$/,/^favicon\.ico$/,/^sw\.js$/,/^version\.json$/,/^manifest(\..*)?\.webmanifest$/];
const walk=async d=>(await Promise.all((await readdir(d,{withFileTypes:true})).map(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]))).flat();
export async function buildPwa(pub,{commit='local'}={}){
 const rel=(await walk(pub)).map(f=>path.relative(pub,f).split(path.sep).join('/')).sort();
 const shell=rel.filter(f=>!DENY.some(r=>r.test(f)));
 const manifests=rel.filter(f=>/^manifest(\..*)?\.webmanifest$/.test(f));
 const urls=[...shell,...manifests].map(f=>'./'+f);
 const tpl=await readFile(path.join(pub,'sw.js'),'utf8');
 if((tpl.match(/\/\*@build\*\/'dev'/g)||[]).length!==1||(tpl.match(/\/\*@precache\*\/\[\]/g)||[]).length!==1)throw Error('sw.js template markers missing or duplicated');
 const h=createHash('sha256').update(tpl);
 for(const f of [...shell,...manifests])h.update(f+'\0'+createHash('sha256').update(await readFile(path.join(pub,f))).digest('hex')+'\n');
 const build=h.digest('hex').slice(0,12);
 await writeFile(path.join(pub,'sw.js'),tpl.replace("/*@build*/'dev'",JSON.stringify(build)).replace('/*@precache*/[]',JSON.stringify(urls)));
 await writeFile(path.join(pub,'version.json'),JSON.stringify({build,commit,files:urls.length})+'\n');
 return {build,urls};
}
```
- `build-php.mjs`: after the `runtime-config.js` write add `await buildPwa(path.join(target,'public'),{commit:(process.env.GITHUB_SHA||'local').slice(0,7)})`.
- The hash covers file **content** and the worker template only (not commit, not time), so a deploy that changes only `backend/` does not change `sw.js` -> no spurious update prompts. `version.json` carries the commit for humans and for `deploy-verify.sh` (2.e).
- Precache today: **32 files, 476 KB** before `offline.html` and the new chat/pwa modules (`app.js` 96 KB, `i18n-en.js` 45 KB, CSS 85 KB, fonts 51 KB, brand images, `assets/meducase.png`). Budget guard in the build: fail above 1.5 MB.
- `dist/sw.js` (the template) exists in `dist/` so `node --check` and tests can use it; in `dist/` it is inert (no list = pass-through, and `pwa.js` does not register it in demo mode).

### 1.4.6 Code changes in the app (kept minimal because `app.js` is a conflict hotspot)

- New `dist/pwa.js` (self-contained module, imports `t as T`, `CONFIG`, `icon`): `registerWorker()`, `setManifestLanguage()`, install state machine, bars/cards/sheets, local counters. Exports `initPwa({isLoggedIn})` and `pwaSignal(name)` (`'login'`, `'chat-active-tick'`).
- `app.js`: **three small edits** - `import {initPwa,pwaSignal} from './pwa.js'` at the top (module imports evaluate before the top-level `await Client.init()`, so the `beforeinstallprompt` listener is registered early enough); one call `initPwa(...)` after the first `render()`; `pwaSignal('login')` where login succeeds. The chat module calls `pwaSignal('chat-active-tick')` once per 10 s of visible + interacted chat time.
- `pwa.js` attaches its own click listeners inside `#pwa-root` instead of using the global `data-action` delegation in `app.js`.
- i18n: per 01-code-map section 3.3, a new module is not scanned by `tests/i18n.test.mjs`. Add `dist/pwa.js` to the scanned file list (test line 48) and to the "no Polish outside T()" rule (line 61), and register its English strings through the per-module dictionary (or, until that exists, append them to `i18n-en.js`). Strings are listed in 1.5.8.

## 1.5 Install incentives

### 1.5.1 Platform matrix

| Platform / browser | Mechanism | What the app does |
|---|---|---|
| Android Chrome, Edge, Samsung Internet, Opera (Chromium) | `beforeinstallprompt` (needs the real fetch handler) | Defer the event, show the in-app card, call `prompt()` from the user's click. |
| Desktop Chrome/Edge | same; also an omnibox install icon | Passive entry in the account menu + small chip; no bottom card before the 3rd visit. |
| iOS Safari (and, since iOS 16.4, other iOS browsers via Share) | No event. Manual: Share -> Add to Home Screen. iOS 26: added sites open as web apps by default ("Open as Web App" switch) [source: OneSignal, M. J. Tsai] | iOS sheet with the steps (1.5.4). |
| macOS Safari 17+ | "Add to Dock" in the File menu, no event [memory] | Nothing proactive. |
| Firefox desktop | No PWA install | Nothing. |
| Firefox Android | "Install" in the menu, no event | Nothing proactive (generic "browser menu" hint only on the About/account entry). |
| In-app browsers (Instagram, Facebook/Messenger, TikTok, Snapchat, LINE, LinkedIn) | Cannot install, session cookies often lost | "Open in your browser" banner (1.5.5). |
| Already installed (standalone) | - | Never show anything. |

### 1.5.2 Standalone / installed detection

```js
const standalone=()=>matchMedia('(display-mode: standalone)').matches||matchMedia('(display-mode: minimal-ui)').matches||navigator.standalone===true||new URLSearchParams(location.search).get('source')==='pwa';
```
Set `document.documentElement.dataset.standalone` (CSS can hide the "download the app" bits), listen to `matchMedia(...).addEventListener('change')` and to `appinstalled` (store `installed` and hide everything). On Android, a user who installed and later opens the site in Chrome still sees the install card unless `getInstalledRelatedApps` says otherwise; keep the local `installed` flag as the guard and accept the rare repeat.

### 1.5.3 When to show the card (rules, in priority order)

Never: on first paint or within the first 15 s of a page load; in the demo; in standalone; when `installed` is set; while dismissed (below); in an in-app browser (show the 1.5.5 banner instead); on `#screen` (projection) or during print preview; while a modal is open; while an input/textarea has focus; more than once per page session.

Show (mobile; a non-modal bottom card, `role="region"`, not a dialog, no focus trap) when **any** of:
1. the user has just **logged in** successfully (first login in this browser; show after the login transition has settled, about 10 s);
2. it is the **second visit on a different calendar day** (`matdraw.pwa.visits`: counter incremented once per local day);
3. **90 s of active chat time** (chat visible, page visible, at least one scroll/keypress/tap per 20 s) accumulated across the session (`pwaSignal('chat-active-tick')`).
Desktop: only rule 2 with a minimum of 3 visits, and rendered as a small chip in the header/account menu, never a card over content.
Permanent passive entry: "Zainstaluj aplikację" in **Moje konto / About** (always available when an install path exists: deferred prompt, iOS, or generic instructions), with no dismissal logic.

Dismissal memory (all in `localStorage`, every access in `try/catch`, page works without it; keys under the existing `matdraw.` prefix):

| Key | Content | Rule |
|---|---|---|
| `matdraw.pwa.dismissed` | epoch ms | "Później" -> hide for **30 days** |
| `matdraw.pwa.never` | epoch ms | "Nie pokazuj więcej" -> hide for **365 days** |
| `matdraw.pwa.installed` | epoch ms | set on `appinstalled` or detected standalone; hide forever |
| `matdraw.pwa.visits` | `{n,last:'YYYY-MM-DD'}` | visit counter |
| `matdraw.pwa.stats` | `{shown,accepted,dismissed,installedAt,source}` | local counters (1.5.7) |

Chromium flow: on `beforeinstallprompt` call `preventDefault()` and keep the event; the card's "Zainstaluj" button calls `deferred.prompt()` (user gesture), reads `userChoice`, clears the event, stores the outcome. If the event never fires (already installed, unsupported) the card is not shown on Chromium; on iOS the card is shown from the same rules and opens the sheet.

### 1.5.4 iOS sheet

Detection: `/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)` (iPadOS reports a Mac UA), and not standalone. Content (a modal-style bottom sheet, focus trapped, `Escape`/button closes; uses the guide mascot, which is allowed to "guide"):
1. "Dotknij **Udostępnij** (kwadrat ze strzałką) albo menu **⋯** w Safari." / "Tap **Share** (square with an arrow) or the **⋯** menu in Safari."
2. "Wybierz **Dodaj do ekranu początkowego**." / "Choose **Add to Home Screen**." (**[unverified]** verify the exact Polish wording on a Polish-language iPhone; Polish iOS uses "ekran początkowy".)
3. "Zostaw włączone **Otwórz jako aplikację** i dotknij **Dodaj**." / "Keep **Open as Web App** on and tap **Add**." (iOS 26 wording **[source]**.)
4. Honest note: "Po dodaniu zaloguj się ponownie w aplikacji: iPhone przechowuje dane aplikacji osobno od Safari." / "After adding, log in again inside the app: iPhone keeps app data separate from Safari." (installed iOS web apps have their own storage partition **[memory]**).
Needs one new icon `share` in `icons.js`.

### 1.5.5 In-app browsers

Detect with a conservative regex on the UA: `/Instagram|FBAN|FBAV|FB_IAB|FBIOS|Messenger|musical_ly|BytedanceWebview|TikTok|Snapchat|Line\/|LinkedInApp/i` (check Instagram before the generic Facebook tokens; UA sniffing is best-effort and can be changed by those apps **[source]**). Action: a dismissible banner at the top: "Otwórz w przeglądarce, aby zainstalować MatBravo i pozostać zalogowanym" with platform-specific steps (iOS: ⋯ -> "Otwórz w Safari"; Android: ⋮ -> "Otwórz w Chrome") and a "Kopiuj link" button (`navigator.clipboard` with a select-the-text fallback, since clipboard can be blocked in webviews). **No automatic breakout and no `intent://` redirect**: unreliable and surprising. Dismissal: 7 days.

### 1.5.6 Benefit copy (shown on the card and on the About entry)

Three short benefits, truthful at launch: "Otwiera się jednym dotknięciem, jak zwykła aplikacja", "Czat i drabinki na pełnym ekranie", "Szybszy start i mniej przesyłanych danych". A fourth ("Powiadomienia o turnieju i odpowiedziach w czacie") is added **only when Push ships**.

### 1.5.7 Measurement without trackers

- **Level 0 (always, device-local):** `matdraw.pwa.stats` counters. Nothing leaves the device. Useful for the developer on a test phone and for the account-page entry, not for the owner's overview.
- **Level 1 (recommended, optional, `config['pwa_stats']=true`):** anonymous daily aggregate. `POST api/index.php?route=pwa-event` with `{"e":"prompt_shown|accepted|dismissed|installed|launch_standalone","p":"android|ios|desktop|other"}`. Server: no session, no cookie, no stored IP or user agent; checks `Origin` equals `app_url` (when present) and `Sec-Fetch-Site: same-origin`; allow-listed enums only; body at most 100 bytes; rate limit per hashed IP bucket (HMAC with `app_key`, same table pattern as `login_limits`, 20 per hour); `INSERT INTO pwa_stats (day,event,platform,n) VALUES (UTC_DATE(),?,?,1) ON DUPLICATE KEY UPDATE n=n+1`. Admin sees a small table. **Why a beacon at all:** the worker answers launches from cache, so the web-server access log never sees `?source=pwa`. This is a first-party aggregate counter, not a tracker, but whether it needs a mention in the privacy policy is for the later legal session (flagged). Default off in `config.example.php` until the owner decides.

### 1.5.8 Strings (Polish key -> English)

| Polish (key) | English |
|---|---|
| Zainstaluj MatBravo | Install MatBravo |
| Ikona na ekranie głównym, pełny ekran i szybszy start. | An icon on your home screen, full screen and a faster start. |
| Zainstaluj | Install |
| Później | Not now |
| Nie pokazuj więcej | Don't show again |
| Zainstaluj aplikację | Install the app |
| Dodaj MatBravo do ekranu głównego | Add MatBravo to your Home Screen |
| Otwiera się jednym dotknięciem, jak zwykła aplikacja | Opens with one tap, like a regular app |
| Czat i drabinki na pełnym ekranie | Chat and brackets in full screen |
| Szybszy start i mniej przesyłanych danych | Faster start and less data used |
| Otwórz w przeglądarce, aby zainstalować MatBravo i pozostać zalogowanym | Open in your browser to install MatBravo and stay logged in |
| Kopiuj link | Copy link |
| Dostępna jest nowa wersja MatBravo. | A new version of MatBravo is available. |
| Odśwież | Refresh |
| Wersja została zaktualizowana. Odśwież stronę, gdy będzie wygodnie. | The app was updated. Refresh the page when convenient. |
| Brak połączenia z internetem | You are offline |
(Plus the iOS step texts from 1.5.4.) English strings must pass the existing placeholder and "no Polish letters" rules.

## 1.6 Web Push (later phase; hook designed now)

### 1.6.1 Feasibility in pure PHP - spike result **[verified here]**

`webpush.php` (scratchpad, ~45 lines, `ext-openssl` only) did: P-256 key generation (`openssl_pkey_new` curve `prime256v1`), ECDH with the subscriber's `p256dh` key (`openssl_pkey_derive`, peer key wrapped in a fixed SPKI prefix), HKDF (`hash_hkdf`), AES-128-GCM (`openssl_encrypt('aes-128-gcm', ..., $tag)`), the RFC 8291 `aes128gcm` record layout (salt 16, record size 4096, key id length 65 + ephemeral public key, ciphertext, tag, padding delimiter `\x02`), and a VAPID ES256 JWT (`openssl_sign` DER -> raw r||s). An **independent Node implementation decrypted the payload correctly** (Polish text with emoji intact) and **validated the JWT signature**. So the cryptography needs no Composer package. What is not verified: actual delivery to FCM/Mozilla/Apple, egress from web9, CPU cost on the host.

```php
function encrypt_push(string $plaintext,string $uaPublic65,string $authSecret16):string{            // RFC 8291
 $as=openssl_pkey_new(['curve_name'=>'prime256v1','private_key_type'=>OPENSSL_KEYTYPE_EC]);$asPub=ec_point($as);
 $ecdh=openssl_pkey_derive(openssl_pkey_get_public(pem_from_point($uaPublic65)),$as,32);
 $prk=hash_hkdf('sha256',$ecdh,32,"WebPush: info\0".$uaPublic65.$asPub,$authSecret16);$salt=random_bytes(16);
 $cek=hash_hkdf('sha256',$prk,16,"Content-Encoding: aes128gcm\0",$salt);$nonce=hash_hkdf('sha256',$prk,12,"Content-Encoding: nonce\0",$salt);
 $ct=openssl_encrypt($plaintext."\x02",'aes-128-gcm',$cek,OPENSSL_RAW_DATA,$nonce,$tag,'',16);
 return $salt.pack('N',4096).chr(65).$asPub.$ct.$tag;}
// VAPID: Authorization: vapid t=<ES256 JWT {aud: push-service origin, exp <= 24h, sub: mailto:...}>, k=<VAPID public key, base64url>
// Request: POST <endpoint> with headers TTL, Urgency, Content-Encoding: aes128gcm, Content-Type: application/octet-stream
```

### 1.6.2 Platform facts and limits

- iOS/iPadOS 16.4+: Web Push only for web apps **added to the Home Screen** and opened from there; asking in a normal Safari tab fails silently; permission must be requested from a user gesture [source: OneSignal, Netmera, Braze, M. J. Tsai]. Declarative Web Push exists from iOS 18.4 [source: MobiLoud, unverified]. Apple's 2024 plan to drop home-screen web apps in the EU was reversed before release [memory, unverified]; keep this in the risk list because Poland is in the EU.
- Chrome requires every push to show a notification (`userVisibleOnly`): no silent background work.
- Sending cost: one HTTPS POST per subscription (about 100-300 ms each, **[unverified]**). PHP processes are scarce (16, see 02-realtime) and process runtime is capped at 120 s. Fan-out of one chat message to hundreds of subscribers from the posting request is not acceptable.

### 1.6.3 Recommendation and design hook

Phase C (after the launch has settled), **not per chat message**. Candidates: billing events (payment failed, renewal), tournament status changes for entered clubs, replies/mentions (if chat gets them), admin broadcast.

Hook (all dormant at launch):
- `backend/src/Notifier.php`: `interface Notifier { public function notify(array $userIds, string $kind, array $payload): void; }` with `NullNotifier` (default). Domain code (billing, tournaments, chat) calls `Notifier::notify(...)` **after** its DB commit; today that is a no-op.
- Reserved migration (written when Push is built, listed here so other migrations leave room): `push_subscriptions (id BIGINT UNSIGNED AI, user_id VARCHAR(40) NOT NULL, endpoint_hash CHAR(64) NOT NULL UNIQUE, endpoint VARCHAR(1024) NOT NULL, p256dh VARCHAR(128) NOT NULL, auth VARCHAR(48) NOT NULL, created_at DATETIME, last_success_at DATETIME NULL, failures TINYINT NOT NULL DEFAULT 0, prefs VARCHAR(255) NULL)` and `push_outbox` (queued sends). Endpoints are personal data: delete on logout of that device, on `404/410` from the push service, on account closure.
- Config (reserved, `enabled=false`): `'push'=>['enabled'=>false,'subject'=>'mailto:kontakt@matbravo.com','public_key'=>'...','private_key_file'=>'/home/meducase/matdraw/shared/vapid-private.pem']` (generated once by `bin/vapid-generate.php`; **never rotate**: it invalidates every subscription).
- Delivery: after the response is flushed (`litespeed_finish_request()`/`fastcgi_finish_request()` when available), `curl_multi` with a per-request cap (about 50) and 5 s timeouts; the rest goes to `push_outbox`, drained by `bin/cron.php` (2.g) or opportunistically by a request holding `GET_LOCK('matdraw_push',0)`.
- Payload privacy by design: generic text ("New message in Taekwondo 🌎", never message bodies or names); the page fetches details after the click.
- Worker handlers (added in Phase C): `push` -> `showNotification(title,{body,icon:'./brand/icon-192.png',badge:'./brand/badge-72.png',tag,data:{url}})`; `notificationclick` -> focus an existing window and set its hash, else `clients.openWindow('./?source=push#chat')`; `pushsubscriptionchange` -> re-subscribe and POST the new subscription.
- Client: permission is requested only from a button in "Moje konto -> Powiadomienia", only when standalone on iOS (otherwise the button explains "install first", which doubles as an install incentive).
- CSP: no change (push delivery is not a page fetch; notification icons are same-origin).

## 1.7 PWA tests (no browser required in CI)

`tests/pwa-sw.test.mjs` - the harness above (loads `dist/sw.js` into `node:vm` with mocked `caches`/`fetch`): the assertions listed in 1.4.2.
`tests/pwa-build.test.mjs` - runs `build-php.mjs` into a temp dir and asserts: `sw.js` has no markers left and parses (`node --check`); `version.json` build equals the string in `sw.js`; every precache URL exists; no precache URL starts with `api/`, `u/`, `live/`; total precache < 1.5 MB; hash is stable across two builds and changes when a CSS file changes; `manifest*.webmanifest` parse, `id`, `start_url` inside `scope`, `lang` matches the file, each icon file exists with the declared PNG dimensions (read the IHDR), at least one `maskable`, shortcuts and screenshots (if declared) exist; `offline.html` contains both language blocks; `index.html` links the manifest and has `#pwa-root`.
`tests/i18n.test.mjs` - extended for `pwa.js` (1.4.6).
**Device checklist (manual, once before launch, and after any SW change):** Android Chrome install via the card and via the menu; a deploy while installed -> update bar appears -> Refresh reloads only that tab; airplane mode -> app shell opens, API errors shown, offline page for an unknown URL; iOS Safari add-to-home, login inside the installed app, Stripe return (see 4.3); Instagram in-app browser banner; hall `#screen` window open during an update (nothing happens); DevTools -> Application -> Manifest shows no installability errors; CSP console is clean (worker + manifest). Optional later: a Playwright job (headless Chromium against `php -S`) asserting `navigator.serviceWorker.ready`, offline navigation and CDP installability errors **[unverified, ~150 MB download in CI]**.

## 1.8 PWA risks

| Risk | Mitigation |
|---|---|
| A broken worker locks users on a bad release | Install is all-or-nothing; the worker is replaced by the next deploy; `updateViaCache:'none'` + `no-cache` on `sw.js`; emergency: deploy a worker with `PRECACHE=[]` (pass-through) and, if needed, `Clear-Site-Data` is **not** used (it would also drop session cookies). The harness test guards the main paths. |
| Mixed releases | One versioned cache for the shell; no per-file runtime caching of app code. |
| Private data in caches | Worker never intercepts `api/`, `u/`, `live/`, POST. Test asserts it. Avatars rely on the browser HTTP cache with `private` (4.b). |
| iOS storage partition, cookies cleared | Login prompt note in the iOS sheet; see 4.2 for session lifetime. |
| UA sniffing for in-app browsers | Best-effort banner only; never blocks anything. |
| Apple policy for web apps in the EU | Keep the site fully usable in the browser; PWA is an enhancement. |

---

# PART 2 - Deployment and infrastructure

## 2.0 New release sequence

Today: `check` -> upload -> `activate` -> verify (server-side) -> auto-rollback on release error -> `cleanup`.
New:

```
test + http-test (+ compat) -> build -> deploy job:
  1. check      (existing; + new probes, creates shared/uploads, backups, logs)
  2. upload     (existing: tar over ssh into releases/<id>)
  3. migrate    NEW: status -> (pending?) backup -> migrate.php   [old release still live; failure stops here]
  4. activate   (existing; swaps docroot + backend; unchanged semantics)
  5. verify     (existing 429/403 handling kept; + sw.js, manifest, version.json, schema probes)
  6. rollback   (existing; code only)  7. cleanup (existing; + backup retention)
```
Step 3 runs the **new release's** `migrate.php` with `MATDRAW_CONFIG=~/matdraw/shared/config.php` (bootstrap already honours that variable), so the config symlink inside the release is not needed yet.

## 2.a Database migrations

### 2.a.1 Files

| File | Role |
|---|---|
| `backend/database/schema.sql` | **Frozen baseline = version 1.** Add a header comment "frozen: new tables and columns go to `backend/migrations/`". Its `INSERT IGNORE INTO app_meta ... schema_version 1` stays. |
| `backend/migrations/0002_<name>.php`, `0003_...` | One file per change, numbered contiguously. Each returns `['id'=>2,'name'=>'chat','destructive'=>false,'up'=>function(Migrator $m):void{...}]`. PHP, not `.sql`, because `IF NOT EXISTS` differs between MariaDB and MySQL (2.a.4). |
| `backend/src/Migrator.php` | `MatDraw\Migrator`: `__construct(PDO,string $dir)`, `current()`, static `target()` (the highest id among the files in `backend/migrations/`, no DB needed), `pending()`, `status()`, `run(callable $log,bool $dry=false,bool $allowDestructive=false)`; helpers `tableExists`, `columnExists`, `indexExists`, `addColumn`, `addIndex`, `createTable` (all via `information_schema` with `TABLE_SCHEMA=DATABASE()`), and `exec()` that runs one statement. Locking via `SELECT GET_LOCK('matdraw_migrate',0)` (works on both servers). Sets `SET SESSION lock_wait_timeout=30` (default is **one year**: a metadata lock held by a long reader would otherwise hang the deploy) and `innodb_lock_wait_timeout=30`. After each migration: `UPDATE app_meta SET schema_version=? WHERE id=1 AND schema_version<?`. |
| `backend/bin/migrate.php` | CLI only (`PHP_SAPI` check like `install.php`). Options `--status`, `--dry-run`, `--allow-destructive`, `--db=migrate` (use `config['db_migrate']`). |
| `backend/bin/dump.php` | Pure-PDO fallback dump (2.a.3). |
| `backend/bin/install.php` | After the baseline `exec(schema.sql)` call `(new Migrator(...))->run(...)`, **then** create the first admin (the admin insert goes through `Repository`, which needs the final schema). |

**Exit codes of `migrate.php`:** `0` up to date or applied; `10` database empty / not installed (not an error: the deploy continues and `verify` reports "run the installer" exactly as today); `2` pending destructive migration without `--allow-destructive`; `1` any error. `--status` prints one machine-readable line: `STATE=ready|empty CURRENT=1 TARGET=4 PENDING=3 DESTRUCTIVE=0`.
**DB newer than code** (e.g. deploying an older commit after a revert): print a warning and exit `0`. Old code on a newer additive schema is the designed-for case. Verification therefore checks `db >= code`, not equality.
`migrate.php` never creates the baseline: installing stays a deliberate human step (INSTALL step 4 / DEPLOY step 6).

### 2.a.2 Expand/contract rules (this is what keeps rollback safe)

The database is **not** rolled back by `rollback`; the old code must work on the new schema. `Repository::load()` does `SELECT * FROM users` and hydrates a fixed field list, and `persist()` upserts only the columns it knows, so extra columns are ignored by old code, but:

| Change | Rule in release N | Later release |
|---|---|---|
| New table | Allowed. Old code ignores it. | Drop only after two releases without references, as `destructive`. |
| New column on an existing table | **Must be NULLable or have a DEFAULT** (old `INSERT`s do not name it). Keep columns small (the workspace loads whole tables). Prefer a new side table (e.g. member profile) over widening `users`/`profiles`. | |
| New index / unique key on existing data | Allowed if it cannot fail on existing rows. | |
| New FK **on an existing table** | Not allowed (old code could violate it). Enforce in PHP. FKs on new tables are fine. | |
| ENUM extension | Avoid. If unavoidable: append at the end only, and only if old code tolerates unknown values. **Do not add a new `users.role` value**: old code reads every user row on every request. | |
| Rename / drop / type change / NOT NULL on existing columns | Never in the same release. Add new, backfill, switch code, drop later (`destructive: true`, run by hand with `--allow-destructive`; the pipeline never passes it and `status` reports `DESTRUCTIVE=1` so the deploy stops). | |
| Backfill `UPDATE` of existing rows | Idempotent, batches of at most 1000 rows, under 60 s total (shared-host process cap is 120 s). | |
| **New-style rows that old code cannot read** (e.g. a user without a club: `users.club_id` is NOT NULL and `Repository` assumes it) | Treat as a rollback blocker: once such rows exist, "rollback" is no longer safe. Design so that every row is old-code-compatible (e.g. a personal club per independent member), or accept forward-fix-only after the first such row and document it. Flagged to the accounts/billing design (4.2). | |

`tests/migrations.test.mjs` lints the migration files: contiguous ids with no duplicates; every `CREATE TABLE` has `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`; no raw `ADD COLUMN IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS` (use helpers); no `DROP`/`MODIFY`/`CHANGE`/`RENAME` unless `destructive:true`; no `RETURNING`, `->>`, `JSON_VALUE`, `VALUES ... AS alias`; no `DEFAULT` on JSON columns; FK names prefixed with the table name.

### 2.a.3 Backup before migrating, failure handling

In `deploy-remote.sh` (new command `migrate <release>`; code sketch, the escaping logic of the option file and the flag detection were exercised against MariaDB 10.11 **[verified here]**):

```bash
php=/usr/local/php83/bin/php; [[ -x $php ]] || php=$(command -v php); cfg=$base/shared/config.php
# Client option file (mode 600) built from config.php: the password never appears in a process list or on a command line.
dbcnf(){ local f; f=$(mktemp "$base/shared/.my.XXXXXX"); chmod 600 "$f"
 MATDRAW_CONFIG=$cfg "$php" -r '$c=(require getenv("MATDRAW_CONFIG"))["db"];parse_str(str_replace(";","&",preg_replace("/^mysql:/","",$c["dsn"])),$d);
  $q=fn($v)=>"\"".str_replace(["\\","\""],["\\\\","\\\""],(string)$v)."\"";
  echo "[client]\nuser=".$q($c["user"])."\npassword=".$q($c["password"])."\n".(isset($d["unix_socket"])?"socket=".$q($d["unix_socket"]):"host=".$q($d["host"]??"localhost")."\nport=".(int)($d["port"]??3306))."\n#DB=".$d["dbname"]."\n";' > "$f"; echo "$f"; }
dbbackup(){ # $1 = label, e.g. pre-v1-to-v4-<release>
 local bin cnf out dbn help flags=(--single-transaction --quick --skip-lock-tables --hex-blob --default-character-set=utf8mb4)
 bin=$(command -v mysqldump || command -v mariadb-dump || true)
 mkdir -p "$base/backups"; chmod 700 "$base/backups"; out="$base/backups/db-$(date +%Y%m%d%H%M%S)-$1.sql.gz"
 cnf=$(dbcnf); trap 'rm -f "$cnf"' RETURN; dbn=$(sed -n 's/^#DB=//p' "$cnf")
 if [[ -n $bin ]]; then
  help=$("$bin" --help 2>&1)
  grep -q -- '--no-tablespaces' <<<"$help" && flags+=(--no-tablespaces)               # MySQL 8 client without PROCESS privilege
  grep -q -- '--column-statistics' <<<"$help" && flags+=(--column-statistics=0)       # MySQL 8 client talking to MariaDB
  ( set -o pipefail; "$bin" --defaults-extra-file="$cnf" "${flags[@]}" "$dbn" | gzip -9 > "$out.tmp" ) || rm -f "$out.tmp"
 else   # no dump tool: pure-PHP dump from the release being deployed
  ( set -o pipefail; MATDRAW_CONFIG=$cfg "$php" "$dir/backend/bin/dump.php" | gzip -9 > "$out.tmp" ) || rm -f "$out.tmp"
 fi
 # accept only a complete dump: valid gzip, more than 1 KiB, ends with the dump-completed marker
 [[ -f $out.tmp ]] && gzip -t "$out.tmp" && [[ $(stat -c %s "$out.tmp") -gt 1024 ]] && zcat "$out.tmp" | tail -c 400 | grep -q 'Dump completed' || { rm -f "$out.tmp"; return 1; }
 mv "$out.tmp" "$out"; chmod 600 "$out"; echo "Kopia bazy: $out ($(du -h "$out" | cut -f1))"; }
```
- `--defaults-extra-file` must be the first option; the dump file is written as `*.tmp` then renamed, so a partial file is never mistaken for a backup; backups are mode 600 in a mode 700 directory outside the web root.
- `dump.php` (fallback, about 60 lines): iterate `SHOW FULL TABLES`, emit `DROP TABLE IF EXISTS` + `SHOW CREATE TABLE`, stream rows with an unbuffered query and `$pdo->quote`, end with `-- Dump completed on ...` so the same acceptance check applies; foreign-key checks disabled in the header. Only used if `mysqldump`/`mariadb-dump` is missing (server-check tells which).
- **Flow of `migrate <release>`:** `migrate.php --status` -> `empty` => print the installer hint and exit 0; `PENDING=0` => "schema up to date", exit 0 (no backup, so an ordinary deploy stays fast); `DESTRUCTIVE>0` => fail with an explanation; else `dbbackup pre-v$CURRENT-to-v$TARGET-$release` (**failure to back up blocks the migration**, unless the operator sets `ALLOW_NO_BACKUP=1` in the workflow environment) -> run `migrate.php` with output tee'd to `~/matdraw/logs/migrate-<release>.log` -> on exit 0 print `Schema: vX -> vY`.
- **Failure handling:** a failing migration fails the workflow step **before `activate`**: the previous release keeps serving, the database may be partly migrated, which is safe because every step is additive and idempotent. The message names the backup file and the log. Fix the migration and push again: the run resumes at the first unapplied step (DDL auto-commits in MySQL and MariaDB, so there is no transactional rollback; idempotence is the protection). **No automatic restore**: users keep writing to the live site, so restoring a dump would silently delete their data. A manual restore (maintenance file, restore, redeploy) is documented in DEPLOY-PL.md; the dump contains `DROP TABLE IF EXISTS`, so restoring replaces the old tables, leaves newer extra tables in place, and the idempotent migrations then re-run cleanly.
- **Other backup triggers:** `deploy-remote.sh backup-db` (manual and for cron, if available); if a deploy finds no dump younger than 24 h it takes one (so deploys act as a weak backup schedule even without cron). **Retention** in `cleanup`: keep the 20 newest `db-*.sql.gz`; warn if `backups/` exceeds 1 GB. These dumps are still on the same account: the owner should also use DirectAdmin's own backups and download copies; this is documented, not automated.

### 2.a.4 MariaDB 10.6 / MySQL 8.0 compatibility notes

| Topic | Rule |
|---|---|
| Idempotent DDL | `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` are MariaDB-only (I confirmed MariaDB 10.11 accepts them **[verified here]**; MySQL 8.0 rejects them **[memory]**). Use `information_schema` checks in `Migrator` helpers. `CREATE TABLE IF NOT EXISTS` is fine on both. |
| Transactions | DDL implicitly commits on both. A migration is a list of independently idempotent steps. |
| `JSON` | MySQL: native binary type, normalises key order and whitespace, validates; no literal `DEFAULT` (needs an expression default in 8.0.13+). MariaDB: alias for `LONGTEXT` with `CHECK(json_valid)` (10.4+), preserves text. So: never compare JSON as strings, never rely on key order, no defaults on JSON columns, use only `JSON_EXTRACT`/`JSON_UNQUOTE` (the `->>` operator is MySQL-only, `JSON_VALUE` differs), no generated-column indexes on JSON. The existing code decodes JSON in PHP, which is fine. |
| Charset/collation | Always `DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci` explicitly (MySQL 8 defaults to `utf8mb4_0900_ai_ci`, MariaDB to `utf8mb4_general_ci`): mixed collations cause "Illegal mix of collations" in joins and FK errors. Use `COLLATE utf8mb4_bin` where case-sensitive keys are meant (as `draws.category_key` does). |
| Index length | InnoDB DYNAMIC rows on both: key limit 3072 bytes = 768 utf8mb4 characters. Keep keyed strings at 255 characters or fewer; the legacy 191-character rule does not apply. |
| Foreign keys | Column type, charset and collation must match the referenced column exactly (`VARCHAR(40)` utf8mb4_unicode_ci for `users.id`). MySQL requires constraint names unique per schema, MariaDB per table: name them `fk_<table>_<column>`. `ON DELETE` is RESTRICT today; deletion policy for GDPR erasure is for the later legal/design session. |
| ENUM | Appending a value at the end is metadata-only on both; reordering, renaming or removing rewrites the table. Avoid (2.a.2). |
| `ALGORITHM=` hints | Omit. `ADD COLUMN` at the end is instant or in-place on both; a wrong hint makes the statement fail instead of falling back. |
| Upserts | `ON DUPLICATE KEY UPDATE col=VALUES(col)` works on both (deprecated warning in MySQL 8.0.20+). Do not use the MySQL-only row-alias form; do not use MariaDB-only `RETURNING`. |
| SQL mode | MySQL 8 default includes `ONLY_FULL_GROUP_BY`; MariaDB does not: new `GROUP BY` queries must be full-group-by clean. |
| Locks | `SELECT ... FOR UPDATE SKIP LOCKED` exists in MySQL 8.0 and MariaDB 10.6+ **[memory]**; avoid unless needed. Chat tables must stay out of `Repository::transaction()` (see 01/02). |
| Time | Store `DATETIME(3)` in UTC (`UTC_TIMESTAMP(3)`); avoid `TIMESTAMP` (zone conversion, 2038). `bootstrap.php` sets PHP's zone to Europe/Warsaw, so convert explicitly. |
| Privileges | **Conflict with INSTALL-PL.md step 2** ("after installation the app account may have only SELECT, INSERT, UPDATE, DELETE"): auto-migration needs DDL rights. DirectAdmin gives the database user all privileges on its database and does not make narrowing easy. Document that the DDL-capable account is expected; optional `config['db_migrate']` (same shape as `db`) is used only by CLI scripts if the owner wants a split. |
| Dump tools | MySQL 8's `mysqldump` against a MariaDB server fails without `--column-statistics=0`; MariaDB's client does not know that flag (the script probes `--help`). `--no-tablespaces` avoids the PROCESS privilege error on MySQL 8. |

### 2.a.5 Tests (CI, section 2.f)

1. Fresh DB: `install.php` (baseline + all migrations) succeeds on `mysql:8.0` and `mariadb:10.6`; `migrate.php` again is a no-op (exit 0, no changes).
2. **Upgrade with data and rollback proof** (`http-compat` job, 2.f): install with the **previous release's code** (`origin/main`), run its HTTP tests (creates data), `CHECKSUM TABLE` the old tables, run the **new** `migrate.php`, `CHECKSUM TABLE` again (must be equal: an additive migration must not alter existing rows), then start a server with the **old** code on the migrated schema and run the old HTTP tests on a second fresh migrated DB. If any step fails, the change is not rollback-safe.
3. Lint test for migration files (2.a.2).

## 2.b Persistent uploads (avatars)

### 2.b.1 Location and permissions

- `~/matdraw/shared/uploads/` (mode 700, owner = account user) holds `avatars/<aa>/<hash>.webp|jpg`, plus an optional `public/` tree if static serving is ever enabled. It sits next to `config.php`, so it survives every deploy (the docroot and `backend/` are fully replaced each time) and is not reachable by URL unless a route or symlink says so.
- Config key `uploads_dir` (absolute path). **Default if absent:** `dirname(realpath(<config.php>)).'/uploads'` (config.php is a symlink into `shared/`), so production needs no new config line; CI sets it explicitly. Helper `matdraw_uploads_dir(array $c)` in `bootstrap.php`; it refuses a path inside the document root.
- `deploy-remote.sh check` creates `shared/uploads` (mode 700) and `backups`, `logs`, then proves PHP-user writability with `touch`/`rm` of a probe file, and prints `df` and the directory size.

### 2.b.2 Serving: PHP route first, static symlink as an optional later optimisation

| | PHP route (default) | Static symlink (optional) |
|---|---|---|
| URL | `api/index.php?route=avatar&u=<opaque public id>&v=<first 12 chars of file hash>` | `/u/<hash>.webp` |
| Access control | Yes: members only if the owner decides so (guests get a placeholder or a server-made low-resolution blurred variant) | None: whoever has the URL can fetch it; only valid if avatars are public |
| Works with mode 700 | Yes | Needs LiteSpeed to read the files (permissions of `~` and `shared` unknown) **[unverified]** |
| PHP cost | One short request per distinct avatar per browser, then the browser cache (immutable) | Zero PHP |
| Headers | `Content-Type` fixed by extension (never from the upload), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `ETag: "<hash>"` + 304 on `If-None-Match` **before** touching the file, `Cache-Control: private, max-age=31536000, immutable` (URL changes when the file changes), `Content-Length`, `readfile()` | Same via `/u/.htaccess` |
| Session | `session_start(['read_and_close'=>true])`, read-only (same pattern as `chat-feed` in 02-realtime 5.4) | none |

Static variant, prepared but **off** (`config['uploads_static']=false`): `deploy-remote.sh migrate` creates the link **inside the release** (`ln -s $base/shared/uploads/public $dir/public/u`) - `cp -a` copies symlinks as symlinks, so there is no window where `/u` is missing during the docroot swap. `public/u/.htaccess`: `Options -Indexes -ExecCGI`, `RemoveHandler .php .phtml .php3 .php4 .php5 .phps`, `Header set X-Content-Type-Options nosniff`, the sandbox CSP, `Cache-Control: public, max-age=31536000, immutable`, deny everything except `*.webp|*.jpg|*.png`, **no `RewriteEngine` line** (the parent rules and the 429 workaround stay in force). `verify` fetches a canary `/u/.canary.txt` and reports whether static serving works; only then may the owner flip the flag. Same mechanism and caveats as the `/live` beacon in 02-realtime (one symlink mechanism for both).

### 2.b.3 Upload processing and the GD fallback

Server-side pipeline (all in memory, before anything touches disk): size limit 2 MB (also `post_max_size`/`upload_max_filesize` check in diagnostics); sniff with `getimagesizefromstring` (core function, no GD): allow JPEG/PNG/WebP only, **never SVG or GIF**; reject above 24 megapixels or when `w*h*5 > memory_limit/2` (GD holds roughly 4-5 bytes per pixel); apply EXIF orientation when `ext-exif` exists; centre-crop to a square, resize to 256x256 (plus a 64x64 thumbnail); **re-encode** (this strips EXIF/GPS and any appended payload: privacy by design and defence against polyglot files); WebP if `imagewebp` exists, else JPEG; file name = first 32 hex of the SHA-256 of the output; atomic write (`rename` from a temp file); delete the previous file after the DB update; an hourly/daily janitor removes orphans older than a day.
Capability probe (`Capabilities::avatarMode()`): `gd-webp` > `gd-jpeg` > `client-resize`.
- **No GD at all (`client-resize`):** the browser always crops/resizes with a canvas and uploads a 256x256 WebP/JPEG (this also removes EXIF); the server accepts only an exact-looking result (magic bytes JPEG/WebP/PNG, dimensions 64-512, at most 150 KB) and stores it unchanged; it is still served with the fixed Content-Type, `nosniff` and the sandbox CSP, so a crafted polyglot is inert. A user who bypasses the client can only embed metadata in their own avatar.
- No usable path (e.g. `getimagesizefromstring` disabled) -> avatars feature off (`avatars_enabled=false` in the Admin diagnostics), initials avatars remain. Never fatal.
- `server-check` prints GD, WebP, JPEG, PNG, EXIF, `memory_limit`, `upload_max_filesize`, `post_max_size`. Because the web SAPI can differ from the CLI, an **admin-only** `route=diagnostics` (GET, read-only) returns the same list as seen by the web PHP and is shown in an Admin card "Diagnostyka serwera".

### 2.b.4 Backups of uploads

Avatars are small (about 10-40 KB each) but not reproducible. `deploy-remote.sh backup-files`: `tar -C ~/matdraw/shared -czf ~/matdraw/backups/uploads-<date>.tar.gz uploads` (skip if the directory is empty), at most weekly (opportunistically on deploy if the newest archive is older than 7 days, or by cron), keep the 4 newest. Documented the same way as DB dumps.

## 2.c `.htaccess` additions (`backend/public/.htaccess`)

Keep the existing `Options`, `DirectoryIndex`, the whole `mod_rewrite` block (the account-level 429 workaround) and the four security headers exactly as they are. Add:

```apache
<IfModule mod_mime.c>
 AddType application/manifest+json .webmanifest
 AddType text/javascript .js .mjs
 AddType font/woff2 .woff2
 AddType image/webp .webp
 AddType image/svg+xml .svg
</IfModule>
<IfModule mod_deflate.c>
 AddOutputFilterByType DEFLATE text/html text/css text/javascript application/javascript application/json application/manifest+json image/svg+xml
</IfModule>
<IfModule mod_headers.c>
 # (existing four "Header always set" lines stay here)
 # App files are not fingerprinted: browsers must revalidate (ETag -> 304). The service worker serves repeat visits.
 <FilesMatch "\.(html|js|css|webmanifest|json)$">
  Header set Cache-Control "no-cache"
 </FilesMatch>
 <FilesMatch "^sw\.js$">
  Header set Cache-Control "no-cache, max-age=0"
 </FilesMatch>
 <FilesMatch "\.woff2$">
  Header set Cache-Control "public, max-age=31536000, immutable"
 </FilesMatch>
 <FilesMatch "\.(png|webp|svg|jpg|ico)$">
  Header set Cache-Control "public, max-age=604800"
 </FilesMatch>
</IfModule>
```
- **Manifest MIME:** many Apache/LiteSpeed installs do not know `.webmanifest` and send `application/octet-stream` or `text/plain`; Chrome tolerates it, validators warn. `AddType` fixes it; `deploy-verify.sh` checks the header.
- **`no-cache`, not `no-store`:** the browser keeps a copy but revalidates every time (cheap 304 on static files, no PHP). This also fixes the stale-`app.js` risk described in 1.1 for visitors without a worker.
- **Fonts immutable:** `manrope-*.woff2` never change under the same name (rename if they ever do). **Images 7 days:** brand art can be replaced; the worker has its own fresh copy via `cache:'reload'`.
- **`Service-Worker-Allowed`:** not needed (worker at `/sw.js`, scope `/`). **No CSP change:** `script-src 'self'` covers the worker (`worker-src` falls back), `manifest-src` falls back to `default-src 'self'`, icons/screenshots are same-origin images, Stripe uses a top-level redirect (see below). The CSP header is also sent with `sw.js`, which governs the worker's own fetches (same-origin only: sufficient, since push handlers fetch nothing).
- **Stripe note for the billing workstream:** CSP `form-action 'self'` blocks an HTML form POST that answers with a redirect to `checkout.stripe.com` (Chrome applies `form-action` to the redirect chain **[memory, unverified]**). Use `fetch` to get the Checkout URL and `location.assign(url)`; that is a navigation, not a form submission, and needs no CSP change.
- **429 quirk:** `/.htaccess` in a subfolder (`u/`, `live/`) must not contain its own `RewriteEngine` line; the parent rules keep the account-level rule away **[unverified for subfolders: test, as 02-realtime already asks]**.
- Verify after deploy over SSH (GitHub runners are blocked): `curl -sI https://matbravo.com/sw.js | grep -i -E 'content-type|cache-control'`, `curl -sI https://matbravo.com/manifest.webmanifest | grep -i content-type`, `curl -sI -H 'Accept-Encoding: gzip' https://matbravo.com/app.js | grep -i content-encoding`. If LiteSpeed ignores `FilesMatch`-scoped `Header set` (unlikely), `deploy-verify` warns and the worker's `cache:'reload'` still protects the shell.

## 2.d Config, DEPLOY-PL.md, server-check

### 2.d.1 New `config.php` keys (all optional unless stated; extend `config.example.php` and the test config)

| Key | Purpose | Default / note |
|---|---|---|
| `uploads_dir` | Avatar storage | derived from `realpath(config.php)` (2.b.1) |
| `uploads_static` | Serve `/u/` statically | `false` |
| `db_migrate` | DDL-capable credentials for CLI scripts only | falls back to `db` |
| `stripe` | `['secret_key'=>'sk_live_...' (or a restricted `rk_` key),'webhook_secret'=>'whsec_...' (optional: webhooks may be blocked by the host),'price_pln'=>'price_...','price_usd'=>'price_...','api_base'=>'https://api.stripe.com']` | Key names are indicative: the billing workstream owns them. `api_base` is honoured **only** when `allow_insecure_http` is true or the host is loopback (CI stub); in production it is ignored so a typo cannot redirect payment traffic. |
| `chat_force_off` | Emergency brake for `chat-*` routes (02-realtime 5.5) | `false`; the file `~/matdraw/shared/chat-off` does the same without editing config |
| `pwa_stats` | Anonymous install counters (1.5.7) | `false` until the owner decides |
| `push` | Reserved (1.6.3) | `['enabled'=>false,...]` |
| `maintenance_file` | Convention rather than a key: if `~/matdraw/shared/maintenance` exists, the API answers `503` + `Retry-After: 120` before any DB work (used during a manual restore) | |
`matdraw_config()` keeps its current validation and gains typed accessors for the new keys; unknown keys are ignored.

### 2.d.2 `DEPLOY-PL.md` changes (Polish; outline with the key paragraphs)

- **Układ na serwerze:** add `shared/uploads/`, `backups/db-*.sql.gz`, `backups/uploads-*.tar.gz`, `logs/migrate-*.log`; "kopie bazy i awatary są poza wydaniem, deploy ich nie nadpisuje".
- **Nowa sekcja "Migracje bazy i kopie zapasowe":** "Deploy sam uruchamia `migrate.php` przed przełączeniem wydania. Jeśli są zmiany schematu, najpierw robi kopię bazy do `~/matdraw/backups`. Jeżeli migracja się nie powiedzie, deploy zatrzymuje się, a strona nadal działa na poprzednim wydaniu. Po poprawce wystarczy uruchomić deploy ponownie (migracje można powtarzać)."
- **Zmiana w "Powrót do poprzedniego wydania":** replace "Rollback zmienia tylko kod... wykonaj kopię bazy" with: "Rollback zmienia tylko kod. Schemat bazy zmienia się wyłącznie przez dodawanie (nowe tabele i kolumny), więc poprzednie wydanie działa na nowym schemacie. Kopia bazy z poprzedzającej migracji jest w `~/matdraw/backups`."
- **Przywracanie bazy (ręczne, rzadkie):** `touch ~/matdraw/shared/maintenance`; `gunzip -c ~/matdraw/backups/PLIK.sql.gz | mysql --defaults-extra-file=... NAZWA_BAZY` (or phpMyAdmin Import); `rm ~/matdraw/shared/maintenance`; "Przywracanie usuwa dane zapisane po utworzeniu kopii."
- **Krok 4 (config):** list the new optional keys; **Krok 3:** the database user needs the right to change the schema (DirectAdmin gives it by default); remove the advice about narrowing the account (INSTALL-PL.md step 2 too).
- **Krok 6:** "Instalator tworzy teraz także wszystkie tabele z migracji."
- **Nowa sekcja "Aplikacja na telefonie (PWA)":** what the owner will see (update bar, install card), that a deploy that only changes server code does not trigger the update bar, and the DevTools check.
- **Nowa sekcja "Cron (opcjonalnie)":** DirectAdmin -> Advanced Features -> Cron Jobs (**[unverified]** that it exists on web9); command `/usr/local/php83/bin/php /home/meducase/domains/matbravo.com/backend/bin/cron.php` every 5 minutes; "bez crona wszystko działa, tylko zadania porządkowe uruchamiają się przy okazji ruchu".
- **Sekcja o hostingu:** add "nagłówki cache w `.htaccess` (nie usuwaj)"; add the outbound-HTTPS fact once checked.
- `INSTALL-PL.md`: requirements add `curl`, `openssl`, `gd` with WebP (optional, with the fallback), `exif` (optional); step 4 mentions migrations; remove the "SELECT, INSERT, UPDATE, DELETE only" sentence; "Utrzymanie i kopie" points to the new backup section. `README.md`: "no cron needed at runtime" stays true (cron is optional).

### 2.d.3 `server-check` additions (workflow step "Stan serwera", read-only)

```bash
php83=/usr/local/php83/bin/php; [ -x "$php83" ] || php83=$(command -v php)
echo "PHP 8.3 CLI: $("$php83" -r 'echo PHP_VERSION;')"
"$php83" -r 'foreach(["pdo_mysql","mbstring","openssl","curl","gd","exif","fileinfo","zlib","sodium"] as $e)echo str_pad($e,10),extension_loaded($e)?"OK":"BRAK","\n";
 if(function_exists("gd_info")){$g=gd_info();foreach(["WebP Support","JPEG Support","PNG Support"] as $k)echo "GD $k: ",!empty($g[$k])?"tak":"NIE","\n";}
 foreach(["memory_limit","max_execution_time","upload_max_filesize","post_max_size","disable_functions","allow_url_fopen"] as $k)echo "$k=",ini_get($k),"\n";
 echo "openssl_pkey_derive: ",function_exists("openssl_pkey_derive")?"tak":"NIE","\n";'
for b in mysqldump mariadb-dump; do command -v $b >/dev/null && echo "$b: $($b --version | head -1)"; done; command -v gzip >/dev/null || echo "gzip: BRAK"
echo "crontab: $(command -v crontab || echo BRAK)"; crontab -l 2>&1 | head -3 || true      # "not allowed" = no cron for this account
for u in https://api.stripe.com/v1/ https://fcm.googleapis.com/ https://web.push.apple.com/; do echo "HTTPS $u -> $(curl -sS -m 10 -o /dev/null -w '%{http_code}' $u 2>&1 | tail -1)"; done   # any code but 000 = egress works
echo "curl: $(curl --version | head -1)"
echo "limity: nproc=$(ulimit -u) nofile=$(ulimit -n) procesy_konta=$(ps -u "$(whoami)" -o pid= | wc -l)"; grep -E 'processes|open files' /proc/self/limits
df -h ~ | tail -1; du -sh ~/matdraw 2>/dev/null; ls -ld ~ ~/matdraw/shared ~/matdraw/shared/uploads 2>/dev/null
```
Also create-and-remove probes in `check` (not in the read-only server-check): write test in `shared/uploads`, create a symlink in the docroot parent and fetch it from the server itself only in `verify`.
Expected reads: **PHP processes and LVE limits cannot be seen from SSH** (CloudLinux hides them); the Start/Biznes/Pro plan must be read from the AfterMarket panel (02-realtime table: 16/16/32 PHP processes).

## 2.e `deploy-verify.sh` additions

Keep everything that is there: the certificate check, the 429 early exit (`env_error`, no rollback), `ROLLBACK=` semantics, the DB probe, the API/session check. Add after the existing API check (each new `curl` reuses `"${k[@]}"`; a 429 on any of them is an `env_error`, never a rollback):

```bash
# --- PWA files and release identity (static, no PHP) ---
want=$(cat "$DOCROOT/version.json" 2>/dev/null); got=$(curl -sS "${k[@]}" "$APP_URL/version.json")
[[ -n $want && $got == "$want" ]] && echo "version.json: zgodny z wydaniem." || error "version.json z serwera ($got) różni się od katalogu domeny ($want): zły katalog albo pamięć podręczna."
build=$(sed -n 's/.*"build":"\([0-9a-f]*\)".*/\1/p' <<<"$want")
code=$(curl -sS "${k[@]}" -D "$tmp/sw.h" -o "$tmp/sw.js" -w '%{http_code}' "$APP_URL/sw.js")
[[ $code == 200 ]] && grep -qi '^content-type:.*javascript' "$tmp/sw.h" || error "sw.js: kod $code albo zły Content-Type."
grep -q "\"$build\"" "$tmp/sw.js" || error "sw.js nie zawiera numeru wydania $build."
grep -qi '^cache-control:.*no-cache' "$tmp/sw.h" || warn "sw.js bez Cache-Control: no-cache (sprawdź .htaccess)."
for m in manifest.webmanifest manifest.en.webmanifest; do
 curl -sS "${k[@]}" -D "$tmp/m.h" -o "$tmp/m.json" "$APP_URL/$m"
 grep -qi '^content-type:.*manifest+json' "$tmp/m.h" || warn "$m: Content-Type to nie application/manifest+json."
 "$php" -r '$m=json_decode(file_get_contents($argv[1]),true);exit(is_array($m)&&!empty($m["id"])&&!empty($m["start_url"])&&count($m["icons"]??[])>=2?0:1);' "$tmp/m.json" || error "$m: niepoprawny JSON lub brak id/start_url/icons."
 for src in $("$php" -r 'foreach((json_decode(file_get_contents($argv[1]),true)["icons"]??[]) as $i)echo $i["src"],"\n";' "$tmp/m.json"|sort -u); do
  [[ $(curl -sS "${k[@]}" -o /dev/null -w '%{http_code}' "$APP_URL/$src") == 200 ]] || error "$m: ikona $src nie jest dostępna."; done
done
[[ $(curl -sS "${k[@]}" -o /dev/null -w '%{http_code}' "$APP_URL/offline.html") == 200 ]] || error "offline.html niedostępny."
# --- schema: database version must be >= the code in the docroot ---
sc=$(cd "$site" && "$php" 2>/dev/null <<'PHP' | sed -n 's/^.*SCHEMA://p' | tail -1
<?php
require 'backend/bootstrap.php';
$p = matdraw_database(matdraw_config());
echo 'SCHEMA:' . (int)$p->query('SELECT schema_version FROM app_meta WHERE id=1')->fetchColumn() . ':' . MatDraw\Migrator::target();
PHP
)
db=${sc%%:*}; code=${sc##*:}
[[ -n $sc && $db -ge $code ]] && echo "Schemat bazy: v$db (kod oczekuje v$code)." || error "Schemat bazy (v${db:-?}) jest starszy niż kod (v${code:-?}): migracja nie została wykonana."
```
Interpretation: `v >= t` -> "Schemat bazy: v (kod oczekuje t)"; `v < t` -> `error` (rollback=true is acceptable: the previous code works on the older schema). Info only (no failure): compression (`Content-Encoding` on `app.js`), `Content-Type` of `.woff2`. The post-activation `sleep 5` in the workflow stays.

## 2.f CI changes (`.github/workflows/deploy.yml`)

1. **`test` job:** syntax step adds `node --check dist/sw.js dist/pwa.js scripts/build-pwa.mjs`; PHP lint already covers `backend` (includes `backend/migrations`); test step becomes `node --test tests/engine.test.mjs tests/workspace.test.mjs tests/i18n.test.mjs tests/pwa-sw.test.mjs tests/pwa-build.test.mjs tests/migrations.test.mjs` (plus the PHP/JS parity step unchanged). Add `gd, openssl, curl` to `setup-php` extensions so avatar code is exercised.
2. **`http-test` job (both DBs):**
   - test config adds `'uploads_dir'=>"$RUNNER_TEMP/uploads"`, `'stripe'=>['secret_key'=>'sk_test_ci','webhook_secret'=>'whsec_ci','price_pln'=>'price_pln_ci','price_usd'=>'price_usd_ci','api_base'=>'http://127.0.0.1:8099']`;
   - after `install.php`: `php build/matdraw-php/backend/bin/migrate.php` must exit 0 and a second run must print "up to date";
   - start the **Stripe stub** before the PHP server: `node tests/stubs/stripe-stub.mjs 8099 &` - a tiny `node:http` server implementing exactly the endpoints the billing code calls (create Checkout Session, retrieve session, retrieve subscription, billing-portal session), checking `Authorization: Bearer sk_test_ci` and the `Idempotency-Key` header, recording requests, and a `POST /__control` endpoint so tests can set the session/subscription state (paid, unpaid, past_due, canceled) and mint signed webhook payloads (`Stripe-Signature: t=...,v1=HMAC_SHA256(whsec, t.body)`); the endpoint list is owned by the billing workstream, this section fixes only the mechanism and the rule that `api_base` works only with `allow_insecure_http`;
   - run `MATDRAW_TEST_URL=... node --test --test-concurrency=1 tests/http.test.mjs tests/chat.http.test.mjs tests/billing.http.test.mjs ...` (per 01-code-map section 6: one shared DB, so no parallel HTTP files);
   - `run-http-test.sh` in the scratchpad already runs `migrate.php` when present and sets `uploads_dir`; extend it with the stub and the file list.
3. **New job `http-compat`** (rollback-safety proof; matrix `mysql:8.0`, `mariadb:10.6`):
```yaml
  http-compat:
    needs: []            # runs in parallel with http-test
    steps:
      - uses: actions/checkout@v4
        with: {fetch-depth: 0}
      - name: Poprzednie wydanie (origin/main) obok nowego
        run: |
          git worktree add "$RUNNER_TEMP/prev" "${{ github.event.pull_request.base.sha || 'origin/main' }}"
          (cd "$RUNNER_TEMP/prev" && node scripts/build-php.mjs "$RUNNER_TEMP/prev-build/matdraw-php")
          node scripts/build-php.mjs ./build/matdraw-php
      - name: Stare wydanie -> dane -> migracja nowym kodem -> sumy kontrolne bez zmian
        run: |
          # DB A: install + old HTTP tests with the OLD code (creates real data), then CHECKSUM TABLE of the baseline tables
          # NEW migrate.php on DB A, CHECKSUM TABLE again: must be identical (additive migrations do not touch existing rows)
          # DB B: install with OLD code, run NEW migrate.php, start OLD code on it, run the OLD tests/http.test.mjs (taken from the base worktree): must pass
          # DB C: install with NEW code (baseline + migrations), run the NEW tests
```
   If `origin/main` has no `migrate.php` yet (the very first migration release) the base build simply has none: the job still works because only the *new* migrate is run.
4. **New job `deploy-script-test`** (no SSH): builds the release, creates a fake server tree under `$RUNNER_TEMP/srv` (`matdraw/shared/config.php` pointing at a service DB at baseline v1 via `schema.sql`, `domains/matbravo.test/public_html`), then runs `bash scripts/deploy-remote.sh check|migrate|activate|backup-db|cleanup` against it: asserts a `db-*pre*` dump appears on the first `migrate`, a second `migrate` is a no-op without a new dump, the dump restores into a second database with equal `CHECKSUM TABLE` (the runner's MySQL 8 `mysqldump` against `mariadb:10.6` exercises the `--column-statistics=0` branch), `cleanup` honours the retention, and a deliberately failing migration (a fixture file in a temp copy) makes `migrate` exit non-zero **without** `activate` having run. This tests the deploy logic that today is only exercised in production.
5. **`build` job:** extend "Kontrola wydania": `test -f build/matdraw-php/public/sw.js`, `! grep -q '/\*@' build/matdraw-php/public/sw.js`, `node --check build/matdraw-php/public/sw.js`, `test -f public/version.json`, `test -f public/offline.html`, `test -f public/manifest.webmanifest`, `test -f backend/bin/migrate.php`, `test ! -e backend/migrations/*.sql`.
6. **`deploy` job:** new step "Migracje bazy" between "Wysłanie wydania" and "Przełączenie na nowe wydanie": `ssh deploy bash -s -- migrate "$DEPLOY_BASE" "$DOCROOT" "$RELEASE" < scripts/deploy-remote.sh`. `server-check` job gains the probes of 2.d.3. `rollback` job unchanged.
7. **Optional later:** a Playwright/Chromium job against `php -S` for SW update/offline and CDP installability errors (1.7).

## 2.g Background jobs (cron optional)

`backend/bin/cron.php` is the single entry point, CLI only, guarded by `GET_LOCK('matdraw_cron',0)`: chat retention/purge (rules from the chat design), upload orphan sweep, billing reconciliation (refresh subscriptions that are near their period end or flagged "unknown"; **billing must be correct without webhooks and without cron**, so cron only reduces latency), `push_outbox` drain (Phase C), occasional `backup-db` is done by `deploy-remote.sh`, not PHP. If `crontab` is unavailable (server-check says), an opportunistic tick runs inside about 1 % of `session` requests, guarded by a `job_runs(name PK, last_run DATETIME)` row and `GET_LOCK` so only one request runs it, limited to 1-2 s. All jobs are idempotent and time-boxed.

---

# PART 3 - File-level change list

| File | Change | Phase |
|---|---|---|
| `dist/manifest.webmanifest` | New fields (1.3.2) | A |
| `dist/manifest.en.webmanifest` | New | A |
| `dist/index.html` | `mobile-web-app-capable`, `apple-mobile-web-app-title`, `#pwa-root` | A |
| `dist/lang-boot.js` | Swap manifest link for `en` (keep rule parity test) | A |
| `dist/sw.js` | New template (1.4.2) | A |
| `dist/offline.html` | New, bilingual | A |
| `dist/pwa.js` | New: worker registration, update bar, install state machine, iOS sheet, in-app banner, local stats, offline flag | A |
| `dist/app.js` | 3 small edits (import, `initPwa`, `pwaSignal('login')`); language re-render calls `setManifestLanguage` | A |
| `dist/icons.js` | `share` icon | A |
| `dist/styles.css` or `dist/brand.css` | Styles for `#pwa-root` (bar, card, sheet), respecting brand tokens | A |
| `dist/brand/shortcut-*.png`, `dist/screenshots/*`, `icon-any-*.png` | New assets (1.3.4) | A/B |
| `dist/i18n-en.js` (or per-module dictionary) | Strings of 1.5.8 | A |
| `scripts/build-pwa.mjs` | New (1.4.5) | A |
| `scripts/build-php.mjs` | Call `buildPwa` last; copy nothing else | A |
| `backend/public/.htaccess` | Additions of 2.c | A |
| `backend/src/Migrator.php`, `backend/bin/migrate.php`, `backend/bin/dump.php`, `backend/migrations/` | New (2.a) | A (needed by every DB feature) |
| `backend/bin/install.php` | Run Migrator after the baseline | A |
| `backend/database/schema.sql` | Header comment only: frozen baseline | A |
| `backend/bootstrap.php` | `matdraw_uploads_dir()`, typed config accessors | A |
| `backend/config.example.php` | New optional keys (2.d.1) | A |
| `backend/public/api/index.php` | Routes `avatar`, `diagnostics` (admin), maintenance-file check, `pwa-event` (optional) | B (with profile feature) |
| `backend/src/Notifier.php` (+ `NullNotifier`) | Hook (1.6.3) | B |
| `backend/bin/cron.php` | Optional job runner (2.g) | B |
| `scripts/deploy-remote.sh` | `migrate`, `backup-db`, `backup-files`, retention in `cleanup`, probes and dir creation in `check` | A |
| `scripts/deploy-verify.sh` | Additions of 2.e | A |
| `.github/workflows/deploy.yml` | Changes of 2.f | A |
| `tests/pwa-sw.test.mjs`, `tests/pwa-build.test.mjs`, `tests/migrations.test.mjs`, `tests/stubs/stripe-stub.mjs` | New | A |
| `tests/i18n.test.mjs` | Scan `pwa.js`; allow `lang-boot.js` manifest lines | A |
| `tests/http.test.mjs` (+ shared client helper) | Use `--test-concurrency=1`; helper extraction per 01-code-map | A |
| `DEPLOY-PL.md`, `INSTALL-PL.md`, `README.md`, `HANDOFF.md` | Per 2.d.2 | A |
| `scripts/build-php.mjs` copy step | No change to the `backend` filter: keep `backend/migrations/` and `backend/bin/` (the filter drops only `config.php` and paths containing `/public`; do not name any backend folder `public*`) | - |

Suggested order: (1) Migrator + deploy `migrate` + CI jobs + `.htaccess` (everything else depends on them), (2) worker + manifest + build step + tests, (3) `pwa.js` UI and install incentives, (4) uploads/avatars route with the profile feature, (5) screenshots after the final UI, (6) Push only after launch.

---

# 4 - Open questions, cross-cutting flags and verification still needed

## 4.1 For the owner (plain language)
1. Should guests ever see real avatars? (Affects whether static serving is allowed.)
2. Please run the **server_check** workflow once after the new probes are merged; it tells us if GD/WebP, a backup tool, cron and outbound HTTPS exist on web9, and which AfterMarket plan limits apply (read the plan name in the panel: Start/Biznes/Pro).
3. Anonymous install counters (`pwa_stats`): yes/no. (Default off; a mention in the privacy policy is for the later legal session.)
4. Screenshots and shortcut icons are produced after the home/chat UI is final.

## 4.2 Cross-cutting flags for other workstreams
- **Session lifetime vs installed app.** `session_idle_seconds=1800`, session cookie (no `Expires`), 12 h absolute, and (02-realtime) polling does not extend the session. Paying members on phones will be logged out constantly, and iOS may drop session cookies when an installed app is closed **[memory]**. Consider an opt-in "remember this device" (rotating random token, hash stored server-side, 30-60 days, members only; keep the short lifetime for admin/editor). This matters more for PWA retention than any manifest tweak.
- **Rollback-safe account model.** `users.club_id NOT NULL` and `Repository::load()` reading all users: independent paid members must not break old code (2.a.2). Prefer a personal club per member or a side table; do not add a role ENUM value.
- **Session-less routes and POST.** `pwa-event` is the only proposed session-less POST; the "public routes are GET only" rule is deliberately bent for it (aggregate counter, Origin/Fetch-Metadata checks, rate limit). Drop it if the owner declines counters.
- **Billing in an installed app.** Stripe Checkout is a cross-origin navigation. On iOS an installed web app may open it in an in-app Safari sheet whose cookies are separate from the app; therefore the success page must work **without a session cookie** (confirm by Checkout Session id server-side) and the app must **re-check billing status on resume** (`visibilitychange`/`pageshow`) and on load with `?billing=success`. The worker serves `./?billing=success&session_id=...` from the cached shell (search ignored); the app must read `location.search` itself. Billing must stay correct without webhooks (the host blocks datacenter IPs).
- **`#chat` route name** (manifest shortcut) and the `chat-active-tick` signal come from the chat UI workstream.
- **`/live` beacon and `u/` symlink** share one deploy mechanism (symlink inside the release); the beacon's `.htaccess` rules in 02-realtime match 2.b.2.

## 4.3 Not verified (do these before relying on the design)
- Manifest `link` swap by `lang-boot.js` is honoured by Chrome/Edge/Samsung before the manifest is fetched (DevTools -> Application -> Manifest).
- `FilesMatch`-scoped `Header set` works under the host's LiteSpeed; `.webmanifest` type is applied; subfolder `.htaccess` without `RewriteEngine` does not trigger the 429 rule.
- Whether Chrome counts our handler as a "real" fetch handler for the prompt (it should: it does work) and exact screenshot constraints.
- Polish iOS menu wording ("Dodaj do ekranu początkowego") and iOS 26 "Open as Web App" copy on a real device.
- GD/WebP, `mysqldump`/`mariadb-dump`, `crontab`, outbound HTTPS to `api.stripe.com` and push services from web9; web SAPI vs CLI PHP differences (`route=diagnostics`).
- Migration SQL on MySQL 8.0 and MariaDB 10.6 specifically (my SQL experiments ran on MariaDB 10.11): the CI matrix will confirm.
- Real delivery of a Web Push message and its cost per send.

## 4.4 What I executed (scratchpad only, not in the repository)
`/tmp/claude-0/-home-user-MatDraw/129ceb01-fa39-5ede-85a8-cbad6e86bc10/scratchpad/sw/{sw.js,harness.mjs,build-pwa.mjs}` (worker, its mock-based test, the build step run against a real `build-php.mjs` output) and `.../scratchpad/push/{webpush.php,verify.mjs}` (Web Push crypto round trip). The icon safe-zone measurement used PIL on `dist/brand/icon-512.png`. Repository working tree: unchanged apart from `docs/`.

## Sources
- Chrome for Developers, "Revisiting Chrome's installability criteria" (fetch handler for the install prompt vs menu install): https://developer.chrome.com/blog/update-install-criteria (via search snippet)
- MDN, "Making PWAs installable": https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable
- "PWA in 2026: what an installable web app actually requires": https://mslogic.gr/en/blog/pwa-pote-axizei/ ; "Chrome PWA install prompt: the 2026 requirements": https://instantpwa.com/answers/chrome-install-prompt-requirements
- web.dev, "Add a web app manifest" (screenshots, form_factor): https://web.dev/articles/add-manifest ; MDN `screenshots`: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/screenshots
- iOS 26 web apps and push: OneSignal https://documentation.onesignal.com/docs/en/web-push-for-ios ; Michael Tsai https://mjtsai.com/blog/2025/10/03/web-apps-in-ios-26/ ; Braze https://braze.com/docs/developer_guide/platforms/web/push_notifications/safari_push ; MobiLoud https://www.mobiloud.com/blog/progressive-web-apps-ios/
- In-app browser detection: https://github.com/muddassirhq/open-in-native-browser ; https://www.corbado.com/blog/passkeys-in-app-browsers
- Hosting facts reused from `02-realtime.md` (AfterMarket limits: https://www.aftermarket.pl/Hosting/Security/).
