# 02 - Near-real-time chat updates on AfterMarket.pl shared hosting

Status: research and recommendation (no code changed). Date: 2026-10-31.
Scope: owner requirement 6 ("live display of new messages; idea: chats in an iframe that refreshes every 2 s").
Related requirements: 1 (central chat on the home page, four lobby channels), 2 (a chat per tournament), 3 (guests can read, user data hidden from them).

Legend: **[verified]** = confirmed in this repository or an official source found in this session; **[source: third party]** = found only on aggregator/blog pages; **[unverified]** = my own knowledge or an estimate that must be checked on the production server before we rely on it.

---

## 1. Summary

- **WebSockets are not possible** on this hosting, and **long polling / Server-Sent Events are a trap**: each waiting reader holds one PHP process, and AfterMarket's published limit is **16 PHP processes** on the Start and Biznes plans (32 on Pro). Ten readers would take over the whole site.
- The owner's instinct (refresh regularly) is right. What we refresh should be **a tiny piece of data, not a whole page**. An iframe that reloads every 2 s would cost about 30 full page renders per minute per open tab. It would also throw away the reader's scroll position and anything typed but not yet sent, flicker, and confuse screen readers.
- **Recommendation:** adaptive **short polling** with `fetch`:
  - a cursor (per-channel revision) and a single primary-key check per poll;
  - `204 No Content` when nothing changed;
  - no session lock (`read_and_close`), and a session-free, cacheable route for guests;
  - **one poller per browser** shared by all tabs (Web Locks + BroadcastChannel);
  - about 2.5 s while the chat is visible and in use, backing off to 5/10/30/60 s when idle and pausing when the tab is hidden;
  - backoff with jitter on errors and on 429 (honouring `Retry-After`);
  - a **server-driven kill switch and tuning block**.
- **Scale-up path, designed in now and switched on by config:** a **static "beacon"**. On every chat change PHP rewrites a tiny JSON file in a web-served folder that lives outside the release. Clients revalidate it with conditional GET, and the web server answers `304` **without starting PHP**. For guests, a static, guest-safe "tail" file removes PHP from their polling altogether.
- All of this sits behind a **transport abstraction**: `poll` → `beacon` → `push` (Pusher/Ably as signal-only, later). Switching is a config change on the server plus, for `push`, a CSP change. It needs no rewrite.
- Expected latency: about 1.3 s median, about 3 s worst case, for someone actively watching. A message the user sends shows up instantly (optimistic display plus an immediate poll).

---

## 2. What we know about the hosting

### 2.1 Facts relevant to realtime

| Item | Value | Status |
|---|---|---|
| Web server | **LiteSpeed + CloudLinux** "Webstack" (listed for the PRO package; DirectAdmin; servers in Poland) | [source: third party] whtop.com plan listing |
| PHP handler | Almost certainly LSAPI (the default for LiteSpeed), not PHP-FPM | [unverified] |
| Simultaneous processes (account) | **32** Start / **32** Biznes / **64** Pro | [verified] aftermarket.pl/Hosting/Security |
| **PHP processes** | **16** Start / **16** Biznes / **32** Pro | [verified] same page |
| CPU / RAM | 1 core, 2 GB (Start); 2 cores, 4 GB (Biznes); 2 cores, 8 GB (Pro) | [verified] same page |
| Process runtime | 120 s on all plans | [verified] same page |
| HTTP request timeout | 120 s (Start, Biznes), 300 s (Pro) | [verified] same page |
| Per-query SQL limit | 60 s (120 s on Pro) | [verified] same page |
| IOPS | 1,024 (2,048 on Pro) | [verified] same page |
| Transfer | 10 TB/month, then throttled to 10 Mbps | [verified] same page |
| Extra restrictions | The host "may impose additional restrictions" when server stability is threatened; Pro limits can be raised on request | [verified] same page |
| Which plan MEDUCASE has | **Unknown**. Check it in DirectAdmin/AfterMarket panel. All capacity numbers below assume the worst case (Start: 1 core, 16 PHP processes). | to check |
| `max_execution_time` in PHP | Not published; the 120 s process limit is the hard cap anyway | [unverified] |
| MariaDB `max_user_connections` | Not published (shared hosts often allow 15-30) | [unverified] |
| LiteSpeed per-client throttling ("Static/Dynamic requests per second" per IP, connection soft/hard limits) | LiteSpeed has these features; the values used by AfterMarket are unknown | [unverified] |
| LSCache server module (can cache PHP responses via `X-LiteSpeed-Cache-Control`) | Unknown whether it is enabled for our account | [unverified] |
| Static files and CloudLinux Entry Processes | Static requests served by LiteSpeed do not start PHP and, by all indications, do not count as Entry Processes | [source: third party] forum and blog posts, no official confirmation |
| Account-level `~/.htaccess` | A domain without its own `RewriteEngine On` answers 429 to everything | [verified] earlier sessions; comment in `backend/public/.htaccess` |
| Whether the host rate-limits frequent requests | Unknown | [unverified] |
| Inbound requests from datacenter IPs | 403 (GitHub runners are blocked) | [verified] `.github/workflows/deploy.yml` comment |
| Outbound HTTPS from PHP (needed only for a third-party push provider) | Probably allowed | [unverified] |

### 2.2 What this means

1. **The scarce resource is PHP processes, not bandwidth.** 16 PHP processes are shared by *everything*: login, tournament editing, guest previews, the chat. Any design that keeps a PHP process waiting per reader is ruled out.
2. **CPU is the second constraint** (1 core on Start). A cheap poll that costs about 3 ms of CPU still adds up at hundreds of requests per second.
3. **The request count itself is a risk** that we cannot quantify yet, from unknown host rate limits and possible LiteSpeed per-IP throttling. So polling must be **adaptive, jittered and remotely tunable**, and it must back off on 429/503.
4. **Tournament venues share one IP.** Many phones in one sports hall come out of one Wi-Fi or carrier NAT address. 150 phones polling every 2.5 s is 60 dynamic requests per second **from a single IP**. This is the most likely way to trip a per-IP throttle. Two things defend against it: the one-poller-per-browser rule and server-side tuning, and the static beacon (static requests usually have much higher limits).

---

## 3. Options evaluated

Assumptions for the numbers:
- "Active reader" = a browser with the chat visible.
- PHP poll cost about **5 ms wall / 3 ms CPU** with OPcache: bootstrap, a PDO connect to localhost, one primary-key query, and a `204` reply. **[unverified estimate, must be measured on web9]**
- Static `304` cost about **0.1 ms** and no PHP. **[unverified estimate]**
- "Busy PHP processes" = requests per second × wall time per request (Little's law).

### (a) Owner's idea: an iframe that reloads itself every 2 seconds

The idea is close to what we will build: "check again every couple of seconds" is the heart of every solution that works on shared hosting. What makes the difference is **what** gets reloaded. Reloading a whole page in an iframe has real costs:

- **A full page and a full session per reload.** Every reload is a complete HTML page rendered by PHP. For a member it means a `session_start()`, which locks the session file, so the iframe's reload and the main app's own requests block each other. It also means a full message query and rendering 50 messages to HTML, plus revalidating the CSS/JS/fonts the page references. That is about **30 PHP page renders and 60-150 HTTP requests per minute per open tab**, even when nobody writes anything. Ten readers would keep several of our 16 PHP processes permanently busy.
- **Flicker and lost state.** A reload repaints the frame from scratch:
  - a reader who scrolled up to read older messages is thrown back to the bottom (or top) every 2 s;
  - a half-typed message in a composer inside the iframe is lost;
  - text selection, an open emoji picker and focus are reset.
- **Accessibility.** Screen readers re-announce or lose their place on every reload, and keyboard focus inside the frame is dropped. Users with motion sensitivity see constant repainting. A proper live region (`aria-live="polite"` announcing only *new* messages) is impossible when the whole document is replaced.
- **Bandwidth and battery on phones.** About 30 KB × 30 reloads ≈ 0.9 MB per minute, roughly **50 MB per hour per open tab**, with the radio never resting. On a tournament day at a venue, that matters.
- **Architecture.** MatBravo is a client-rendered app (static `dist/` plus a JSON API). A chat iframe would need a second, server-rendered HTML UI with its own templating and escaping (a new XSS surface), its own styling, and its own i18n. Blurring for guests would have to be done in two places.
- **CSP is not a blocker.** `frame-ancestors 'self'` *allows* a same-origin iframe, so this is not "forbidden". It is simply much more expensive and gives a worse experience than refreshing data.
- **Wasted work.** About 99% of the reloads would return exactly the same messages.

Verdict: **not recommended.** We keep the owner's 2-second rhythm, but use it for a ~100-byte "anything new?" check instead of a page. The browser keeps the page, scroll position and composer untouched and only appends new messages.

| Metric | Value |
|---|---|
| Latency | 0-2 s (avg 1 s) |
| Requests / reader / min | 30 page renders (60-150 HTTP requests) |
| PHP occupancy | very high (full render plus a session lock per reload) |
| DB load | full message query per reload |
| 429 risk | highest of all options |
| Complexity | low to start, high to make good |
| Capacity | 50 readers: ~25 req/s of full renders, already heavy on 1 core; 200/1000: not feasible |

### (b) Short polling with `fetch` (cursor, 204/304, adaptive, shared across tabs)

The browser asks "anything after revision N in channels X, Y?" and gets either `204 No Content` (a few hundred bytes of headers) or only the new messages.

What makes it cheap:
- **Cursor:** each channel has a monotonically increasing `rev`. The client sends the last `rev` it has, and the server answers only with what is newer. No duplicates, no diffing.
- **One primary-key check per poll:** `SELECT id, rev, status FROM chat_channels WHERE id IN (...)`. If every `rev` equals the client's cursor, reply `204` and stop. The `chat_messages` table is touched only when something is new.
- **No session lock.** `session_start(['read_and_close' => true])` reads the session and releases the file lock immediately, so polls never block (or get blocked by) the user's other requests. Polls must **not** call `Repository::snapshot()` (which loads the whole workspace). One indexed lookup on `users` checks `active`/`auth_version` instead (§5.4).
- **Guests: a separate route with no session and caching allowed** (`Cache-Control: public, max-age=2`). Guests at the same cursor make byte-identical requests, so any cache (the browser's, or LSCache if the host enables it) can answer.
- **Adaptive interval:** fast only when someone is actually looking and active, then backing off when idle. **Page Visibility API:** no polling in hidden tabs, and an immediate poll when the tab becomes visible again.
- **One poller per browser:** a Web Lock (`navigator.locks`, already used in `dist/client.js`) elects a leader tab that polls for the union of channels all tabs need. Results reach the other tabs over `BroadcastChannel`. Five open tabs cost the same as one.
- **Jitter:** ±20% on every interval, so a hall full of phones does not poll in lock-step after a network blip.
- **ETag/If-None-Match vs 204:** because the cursor is in the URL, the URL already describes the client's state. A plain `204` is simpler and does not depend on browser cache rules. ETag/304 is used where it really helps: on static files (option e), where the *web server* produces it for free.

| Metric | Value |
|---|---|
| Latency | about interval/2 + RTT: ~1.3 s median at 2.5 s while active; immediate after own send |
| Requests / reader / min | 24 when active and visible; ~6 on a realistic mix (idle back-off, hidden tabs paused); 0 when hidden |
| PHP occupancy | ~5 ms per poll; no long holds |
| DB load | 1 PK lookup on `chat_channels` + 1 PK lookup on `users` per member poll; a range scan only when there is news |
| 429 risk | moderate, kept down by adaptivity, jitter, 429 back-off and remote tuning; venue NAT is the main risk |
| Complexity | moderate (well understood) |
| Failure modes | host throttling (mitigated by back-off and the kill switch); CPU saturation at very high counts |
| Cost | none |

Capacity (one poller per browser):

| Concurrent readers | Realistic mix (~6 req/min) | Worst case, everyone active (24 req/min) |
|---|---|---|
| 50 | 5 req/s, ~0.03 busy PHP processes, ~1.5% of a core | 20 req/s, 0.1 processes, ~6% |
| 200 | 20 req/s, 0.1 processes, ~6% | 80 req/s, 0.4 processes, ~24% |
| 1000 | 100 req/s, 0.5 processes, ~30% | 400 req/s, 2 processes, **~120% of a core: exceeds Start** |

Short polling alone is comfortable up to a few hundred readers. Beyond that, raise `chat_poll_ms` from the server (instant relief, slightly higher latency), or switch on the beacon (option e).

### (c) PHP long polling

The server holds the request open (sleep / re-check loop) until a message arrives or about 25 s pass.

- Every waiting reader occupies **one PHP process for the whole wait**. With 16 PHP processes, about **10 concurrent readers** would starve the rest of the site: login, editing, guest pages and the chat's own sends.
- A sleep loop also re-queries the DB (or stats a file) every 0.5-1 s per reader, so the DB load is *higher* than short polling.
- The 120 s process runtime and the HTTP request timeouts force reconnects. CloudLinux counts these processes against Entry Processes, so the site starts answering 508/503 once the limit is reached.
- Any session lock held during the wait would freeze the user's other requests.

| Metric | Value |
|---|---|
| Latency | ~0.5-1 s |
| Requests / reader / min | ~2-3 |
| PHP occupancy | **1 PHP process per reader, permanently** |
| Capacity | 50 / 200 / 1000: **not possible** (cap ~10) |

Verdict: **rejected.**

### (d) Server-Sent Events from PHP

One streaming response per reader (`text/event-stream`), with the browser's `EventSource` reconnecting automatically.

- **Same occupancy problem as long polling:** one PHP process per connected reader for the life of the stream. It is capped by 16 PHP processes and killed at 120 s.
- **Buffering:** PHP output buffering, `zlib.output_compression`, and LiteSpeed/LSAPI's own response buffering all have to be defeated (`X-Accel-Buffering: no`, `ob_end_flush()`, compression off). Reports say LiteSpeed buffers unless this is done [source: third party, dev.to posts]. Any intermediate proxy (corporate, mobile carrier) may still buffer.
- The PHP side still has to loop and check the DB or a file, so there is no saving in DB load.
- A standard `EventSource` cannot set custom headers, which matters less here because it is same-origin.

Verdict: **rejected** for the same reason as (c). (SSE is good technology; it needs an event-driven server, which we do not have.)

### (e) Static "beacon" (and static guest tail)

**Idea:** on every chat change (send, delete, hide, channel open or closed) PHP **atomically rewrites a tiny file** in a web-served directory, for example `/live/lobby.json`:

```json
{"v":1,"cv":7,"h":{"1":4513,"2":880,"3":121,"4":3020}}
```

Clients poll that file with a conditional GET. LiteSpeed answers **`304 Not Modified` from the filesystem, without starting PHP**. Only when the beacon shows a newer `rev` than the client has does the client call the PHP feed (b) once to fetch the new messages.

**Guest tail (stage 2b):** for guests, PHP also writes `/live/c/<channelKey>.json` with the last 50 **guest-safe** messages (no names, no user ids, decorative blur variant only, §5.6). Guests poll that file directly, so **guest polling never touches PHP or the DB at all**. This file must be written only for channels guests are allowed to see (lobby, and tournaments that `GuestView` publishes). It must be deleted when a tournament stops being public, and `channelKey` should be random, not a sequential id.

Placement and deploy:
- The docroot is **replaced on every deploy**, so the files live in `~/matdraw/shared/live/`.
- `scripts/deploy-remote.sh activate` (and `rollback`) creates the symlink `public_html/live -> ~/matdraw/shared/live` before the copy is swapped in. Alternatively, a symlink inside `release/public/` survives because `cp -a` copies symlinks as symlinks.
- LiteSpeed must follow the symlink. Shared hosts usually allow this when the owner matches (`SymLinksIfOwnerMatch`), and PHP runs as our user, so the files have the right owner. **[unverified: test]**
- `live/.htaccess`:
  - `Header set Cache-Control "no-cache"`, so the browser always revalidates;
  - `Options -Indexes`;
  - deny everything except `*.json`;
  - **no** own `RewriteEngine` line, so the parent's rules (which keep the account-level 429 rule away) still apply. **[unverified: test that `/live/*.json` does not return 429]**

Correctness details:
- **Atomic write:** `file_put_contents($tmp, $json, LOCK_EX); rename($tmp, $file);`. Readers never see half a file.
- **ETag uniqueness:** LiteSpeed/Apache-style ETags are usually built from mtime (1-second resolution) and size, sometimes the inode. Two writes in the same second with the same length (`4512` → `4513`) could produce the **same ETag**, and a client would miss the update. Fix: keep the file's mtime strictly increasing (`touch($file, max(time(), filemtime($file) + 1))` after the rename). The rename also changes the inode. A **safety-net PHP poll every 60 s** catches anything missed. **[unverified: inspect the ETag format on web9]**
- **The beacon is only a hint.** The DB stays the source of truth. If the file is missing, stale or blocked, clients fall back to plain short polling (b) automatically.
- **Write cost** is one small file write per chat change (well within 1,024 IOPS). Writes happen after the DB commit and preferably after the response is sent (`litespeed_finish_request()` / `fastcgi_finish_request()` when available).

| Metric | Value |
|---|---|
| Latency | same as (b) for the beacon interval, plus one PHP round-trip when there is news |
| Requests / reader / min | same count as (b), but **static** |
| PHP occupancy | ~0 for idle polling; members call PHP once per change; guests (tail file) never |
| DB load | zero while idle |
| 429 risk | lower for PHP limits (static requests do not use PHP processes or Entry Processes); the request *count* is the same, so per-IP static throttles and the unknown account rule still apply |
| Complexity | moderate: deploy symlink, file writer, ETag check, fallback |
| Failure modes | symlink not followed; the host caches static files too aggressively; same-second ETag collisions; disk full. All degrade to (b). |
| Cost | none |

Capacity:

| Concurrent readers | Static req/s (worst case 2.5 s) | PHP req/s |
|---|---|---|
| 50 | 20 | ≈ members × message rate (e.g. 0.1 msg/s × 50 = 5) |
| 200 | 80 | e.g. 40 members × 0.2 msg/s = 8 (guests: 0 with the tail file) |
| 1000 | 400 static (LiteSpeed handles this easily in CPU terms) | e.g. 200 members × 0.2 msg/s = 40; guests 0 |

The remaining PHP cost grows with *members × message rate*. A member who receives several messages within one interval fetches them in one call, so this is naturally bounded by `members / interval`.

### (f) Third-party realtime (Pusher Channels, Ably, Supabase Realtime, Firebase)

PHP publishes over HTTPS (outbound) after each change, and browsers hold a WebSocket to the provider. No inbound webhooks are needed, which matters because the host blocks datacenter IPs.

Free-tier and price indications (all **[source: third party / unverified]**; check the official pages before deciding):

| Provider | Free tier | Paid indications |
|---|---|---|
| Pusher Channels | Sandbox: 100 concurrent connections, 200k messages/day | Startup $49/mo (500 connections, 1M msg/day); Pro ~$99/mo (2,000 connections, 4M msg/day; sources disagree) |
| Ably | 200 concurrent connections, 6M messages/month, 500 msg/s | Standard $29/mo + usage (~$2.50/M messages, ~$1/M connection-minutes) |
| Supabase Realtime | ~200 concurrent connections; free projects pause after 7 days of inactivity | Pro: 500 included, then ~$10 per 1,000 |
| Firebase Realtime DB | Spark: 100 simultaneous connections | Blaze: pay as you go |

Notes:
- **Message fan-out is billed:** one chat message delivered to 1000 subscribers counts as about 1000 messages. 2,000 chat messages/day × 1000 readers is 2M deliveries/day (60M/month). Depending on the plan that ranges from fitting a tier to about $150/month (Ably usage). Connection-minutes: 1000 always-on readers ≈ 43M connection-minutes/month (~$43 at Ably rates).
- **CSP must change:** `connect-src 'self' wss://ws-eu.pusher.com https://sockjs-eu.pusher.com` (or `wss://*.ably.io`, `wss://*.ably-realtime.com`). The SDK can and should be **self-hosted** (a copy in `dist/`) so `script-src 'self'` stays. The CSP lives in `.htaccess`, so this needs a deploy.
- **Privacy:**
  - the provider becomes a processor: a DPA is needed, the data may leave the EEA (US companies; EU clusters exist), and it adds a privacy-policy item;
  - every client's IP address is exposed to the provider;
  - private channels for member-only data need an auth endpoint (`/api/?route=chat-auth`).
  - **Best practice for us: signal-only.** Publish `{"c":12,"r":4513}` with no message text and no personal data, then clients fetch the content from our PHP feed exactly as with the beacon. That way the provider never sees chat content or names, and it can be swapped for another provider or removed at any time.
- **Failure modes:**
  - the provider has an outage → fall back to polling;
  - outbound HTTPS from the host is blocked or slow → publish after the response is sent, with a 2 s timeout;
  - free-tier caps are hit on a tournament day and connections are refused → fall back to polling.

| Metric | Value |
|---|---|
| Latency | ~100-300 ms |
| Requests / reader / min | ~0 (one WebSocket) plus one PHP fetch per change |
| PHP occupancy | 1 outbound HTTP call per change (~100-300 ms, after the response) |
| DB load | only fetches on change |
| 429 risk | lowest on our host |
| Complexity | moderate (CSP, SDK, auth endpoint for private data, DPA) |
| Capacity | 50: free tiers; 200: Ably free (at the cap) or Pusher $49; 1000: Pusher Pro / Ably Standard + usage (~$50-200/month) |

Verdict: **not needed at launch**. It is the right step if MatBravo regularly has many hundreds of simultaneous readers, or needs sub-second latency. The transport abstraction (§6) makes it a drop-in.

### (g) WebSockets on this hosting

**Not possible.** A WebSocket needs a long-running server process that holds thousands of connections (Ratchet/Swoole/Node). Shared hosting offers no daemons, kills processes after 120 s, and limits PHP processes to 16/32. LiteSpeed can *proxy* WebSockets to a backend, but there is no backend we are allowed to run. A VPS or a third-party service (f) would be needed.

### Side-by-side

| | Latency | Req/reader/min | PHP held | DB per idle poll | Max readers on Start plan | Cost |
|---|---|---|---|---|---|---|
| (a) iframe 2 s | ~1 s | 30 renders | high | full query | < 50 | 0 |
| (b) adaptive short poll | ~1.3 s | 24 / ~6 avg | ~5 ms | 2 PK lookups | several hundred | 0 |
| (c) long poll | ~0.5 s | ~2.5 | **whole wait** | repeated | ~10 | 0 |
| (d) SSE | ~0.5 s | ~0.5 | **whole stream** | repeated | ~10 | 0 |
| (e) beacon + tail | ~1.3 s | 24 / ~6 static | 0 idle | 0 | 1000+ | 0 |
| (f) third party | ~0.2 s | 0 | 1 publish per change | 0 | plan-dependent | $0-200/mo |
| (g) WebSockets | - | - | - | - | impossible | - |

---

## 4. Why no typing indicators (and why the online count is optional and coarse)

- **Typing indicators** need a write on every few keystrokes from every typist, and a fast read path for everyone else. That is exactly the realtime load this hosting cannot carry. They also leak behaviour ("X is typing to the tournament chat"). **Not built.**
- **Online count:** if wanted, keep it cheap and anonymous:
  - minute-bucket counters `chat_presence(channel_id, minute, n)`, where each *member's* poller adds `p=1` to its first poll of each new minute and the server runs `INSERT ... ON DUPLICATE KEY UPDATE n = n + 1`;
  - shown value = the last *complete* minute, rounded ("10+");
  - it counts tabs or browsers, not people, and stores **no user ids and no IPs** (privacy by design);
  - guests are not counted, because a session-less increment endpoint could be abused;
  - write cost ≈ members/60 per second (1000 members → ~17/s, tiny rows).
  - Off by default (`chat_online: false`); the UI copy says "members online".

---

## 5. Recommended protocol

### 5.1 Tables (separate from the workspace; lean queries; MySQL 8.0 and MariaDB 10.6 compatible)

```sql
CREATE TABLE IF NOT EXISTS chat_channels (
 id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 kind ENUM('lobby','tournament') NOT NULL,
 slug VARCHAR(40) NULL,                -- 'tkd-world','tkd-pl','karate-world','general' (labels/emoji live in i18n, not here)
 tournament_id VARCHAR(40) NULL,
 public_key CHAR(16) NOT NULL,         -- random; used in static file names, never sequential
 rev BIGINT UNSIGNED NOT NULL DEFAULT 0,   -- bumped on every insert/delete/hide in this channel
 status ENUM('open','readonly','closed') NOT NULL DEFAULT 'open',
 UNIQUE KEY chat_channel_slug (slug),
 UNIQUE KEY chat_channel_tournament (tournament_id),
 UNIQUE KEY chat_channel_key (public_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_messages (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 channel_id INT UNSIGNED NOT NULL,
 rev BIGINT UNSIGNED NOT NULL,         -- channel revision at insert, re-stamped on delete/hide
 user_id VARCHAR(40) NOT NULL,
 client_id CHAR(22) NOT NULL,          -- idempotency key from the browser (retries do not duplicate)
 body VARCHAR(1000) NOT NULL,
 created_at DATETIME(3) NOT NULL,
 deleted_at DATETIME(3) NULL,
 UNIQUE KEY chat_msg_channel_rev (channel_id, rev),  -- the poll index
 UNIQUE KEY chat_msg_idempotency (user_id, client_id),
 KEY chat_msg_user_time (user_id, created_at),        -- send rate limiting
 FOREIGN KEY (channel_id) REFERENCES chat_channels(id),
 FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_settings (   -- one row; admin-editable kill switch and tuning
 id TINYINT PRIMARY KEY,
 version INT UNSIGNED NOT NULL DEFAULT 1,     -- bump on every change; clients compare it
 data JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

`install.php` is not a migrator. These tables arrive with the planned `backend/bin/migrate.php`, bumping `app_meta.schema_version`; that is out of scope for this report.

### 5.2 Server queries

**Poll head check (every member poll; guest poll when not cached):**
```sql
SELECT id, rev, status FROM chat_channels WHERE id IN (?,?,?,?);   -- PK, <= 6 ids
SELECT version, data FROM chat_settings WHERE id = 1;              -- PK (can be merged into one round-trip)
```
If every `rev` equals the client's cursor and the settings version equals `cv`, reply **`204`**. That is the whole cost of an idle poll.

**Fetch news for a changed channel:**
```sql
SELECT id, rev, user_id, body, created_at, deleted_at
FROM chat_messages
WHERE channel_id = ? AND rev > ?
ORDER BY rev
LIMIT 101;                       -- 100 + 1 to set "more"
```
This is a range scan on the unique index `(channel_id, rev)`.

**Initial load / history:**
`WHERE channel_id = ? [AND rev < ?] ORDER BY rev DESC LIMIT 50` uses the same index backwards.

**Author mini-profiles (members only):** one `SELECT ... FROM users JOIN <profile table> WHERE users.id IN (...)` for the distinct authors in the batch (PK lookups). The client caches profiles, so the response carries only authors the client has not seen (`known=` is not needed: the server simply includes the authors of the returned messages, which is cheap).

**Send (one short transaction, per-channel row lock only, never `app_meta`):**
```sql
START TRANSACTION;
SELECT rev, status FROM chat_channels WHERE id = ? FOR UPDATE;    -- must be 'open'
UPDATE chat_channels SET rev = rev + 1 WHERE id = ?;
INSERT INTO chat_messages (channel_id, rev, user_id, client_id, body, created_at)
VALUES (?, ?, ?, ?, ?, NOW(3));                                   -- rev = old rev + 1
COMMIT;
```
A duplicate `(user_id, client_id)` means a retried send: roll back and return the existing message.

Rate limit before the transaction:
`SELECT COUNT(*) FROM chat_messages WHERE user_id = ? AND created_at > NOW(3) - INTERVAL 60 SECOND` (index `chat_msg_user_time`), plus a minimum gap of about 2 s.

**Delete/hide (moderator or author):** in the same kind of transaction, bump the channel `rev` and run `UPDATE chat_messages SET deleted_at = NOW(3), body = '', rev = ? WHERE id = ?`. The next poll delivers a tombstone, so deletions propagate like new messages.

If we ever drop `chat_channels.rev`, the fallback head check is
`SELECT channel_id, MAX(id) FROM chat_messages WHERE channel_id IN (...) GROUP BY channel_id`
with an index on `(channel_id, id)`, which uses a loose index scan. It does **not** see deletions, which is why the per-channel `rev` is preferred.

### 5.3 Endpoints (existing `?route=` style in `backend/public/api/index.php`)

| Route | Method | Who | Session | Caching |
|---|---|---|---|---|
| `chat-public` | GET | guests (and the logged-out home page) | **none**: handled next to `public`/`public-tournament`, before `Auth::start()` | `Cache-Control: public, max-age=2` |
| `chat-feed` | GET | members | `read_and_close` (no lock, no write) | `Cache-Control: private, no-store` |
| `chat-send` | POST | members | normal session + CSRF + Origin (existing rules) | `no-store` |
| `chat-mod` | POST | moderators/admin | normal session + CSRF | `no-store` |

Guests and members use **separate routes on purpose**. If they shared a URL, a shared cache keyed by URL (for example LSCache) could hand a member's response, with names, to a guest. `chat-public` must not read cookies at all, so it needs **no `Vary: Cookie`**. Both GET routes send `Vary: Accept-Encoding` only.

**Request (both feeds):**
```
GET /api/?route=chat-feed&ch=12:4511,13:880&cv=7[&p=1]
GET /api/?route=chat-feed&ch=12:0&before=4400        (history page)
```
- `ch`: up to 6 `channelId:cursor` pairs (cursor 0 = "give me the latest 50");
- `cv`: the settings version the client has;
- `p=1`: optional online-count tick (members only).

Validate strictly: integers only, and 6 channels at most. Otherwise return `400`.

**Response `204 No Content`:** nothing new and the settings are unchanged. Headers:
```
Cache-Control: private, no-store            (chat-public: public, max-age=2)
X-Content-Type-Options: nosniff
```

**Response `200` (member):**
```json
{
  "cv": 7,
  "cfg": { "on": true, "t": "poll", "ms": [2500, 5000, 10000, 30000, 60000],
           "idle": [60, 180, 600, 1800], "hidden": 0, "safety": 60000,
           "beacon": null, "online": false, "notice": null },
  "ch": {
    "12": { "rev": 4513, "st": "open", "more": false,
            "m": [ { "id": 99812, "r": 4512, "t": 1761933731120, "a": "u_7Hc2", "b": "Powodzenia!" },
                   { "id": 99640, "r": 4513, "del": true } ] }
  },
  "people": { "u_7Hc2": { "n": "Jan Kowalski", "u": "jankow", "cc": "PL", "sp": "taekwondo",
                          "av": "/media/av/u_7Hc2-3.webp", "ini": "JK" } },
  "online": { "12": 14 }
}
```
- `cfg` is present only when the client's `cv` is out of date.
- `t` is the time in epoch ms.
- `del` is a tombstone.
- `people` lists only the authors in this batch.

**Response `200` (guest, `chat-public`):** the same shape, but there is **no `people` block** and each message has `"g": 3` in place of `"a"`. `g` is a decorative blur variant 0-7 derived server-side from `HMAC(secret, user_id|channel|day) mod 8`. It lets the UI draw consistent blurred bubbles without giving guests a linkable identifier. No names, initials, avatars, countries or user ids reach a guest; blurring real text in CSS would leak it. Message bodies are public by product decision (requirement 3).

**Errors:**
- `400` invalid request;
- `401` (member feed: session expired, or account blocked or changed) → the client switches to guest mode and shows "sign in again";
- `404` channel not visible;
- `429` / `503` with **`Retry-After: <seconds>`** and body `{"error": "...", "retry": 30}`;
- error bodies follow the existing `{"error": ...}` convention, with Polish keys translated by the client (i18n test rules apply).

**Send:**
```
POST /api/?route=chat-send   X-CSRF-Token: …   Content-Type: application/json
{"ch":12,"cid":"V1StGXR8_Z5jdHi6B-myT","b":"Powodzenia!"}
→ 200 {"m":{"id":99812,"r":4512,"t":…,"a":"u_7Hc2","b":"Powodzenia!"},"rev":4512}
```
The client shows the message at once (optimistic, marked "sending"), then confirms it from the response. It does **not** move the cursor past messages it has not received; it triggers an immediate poll instead.

### 5.4 Session handling for `chat-feed`

- Add a lean `Auth::peek($config, $pdo)`:
  1. `session_start(['read_and_close' => true])` with the same cookie parameters as `Auth::start`;
  2. read `userId`, `authVersion`, `last` and `created`;
  3. apply the idle/max checks **read-only** (if they fail, answer `401`; never `clear()`/`session_regenerate_id()`, which would need a writable session);
  4. run `SELECT active, auth_version, role FROM users WHERE id = ?` (PK).
- No CSRF on GET, and no rotation of `csrf`.
- **Polling does not extend the session.** `Auth::start` updates `$_SESSION['last']` and `session_idle_seconds` is 1800. Keeping that rule means an unattended open tab still logs out after 30 minutes idle, which is the safer behaviour. Real activity (navigation, commands, sending) still extends the session. Optionally, the client calls the existing `session` route at most every 5 minutes **only when the user has interacted** (scroll, typing or a click in the chat).
- `gc_maxlifetime` = `session_max_seconds` (12 h), so file-session GC is not an issue for idle readers.

### 5.5 Server-driven tuning and kill switch

- `chat_settings.data` (admin-editable in the Accounts/Admin area) holds the `cfg` object above. `version` is bumped on every save, so clients pick up changes on their next poll without a deploy.
- **Hard override with no DB cost:** if the file `~/matdraw/shared/chat-off` exists (or the `config.php` key `chat_force_off` is set), all `chat-*` routes return `503` + `Retry-After: 300` + `{"error":"Czat jest chwilowo wyłączony."}` **before connecting to the database**. This is the emergency brake, operated over SSH with `touch`/`rm`.
- `cfg.on = false` → clients stop polling, show the notice (`cfg.notice`, translated) and recheck after `ms[last]`. Sending is refused server-side too.
- `cfg.ms` / `cfg.idle` let us slow everybody down instantly if the host complains (for example `[5000, 10000, 30000, 60000, 120000]`).
- `cfg.t` selects the transport (`poll` | `beacon` | `push`). `cfg.beacon` carries the beacon URLs, for example `{"lobby": "/live/lobby.json"}`.
- Optional self-protection: if one IP or session polls far faster than `cfg.ms[0]` allows, answer `429` with `Retry-After`. Do not store IPs for this beyond memory or the existing `login_limits`-style table with short expiry; preferably skip it until it is needed.

### 5.6 Client algorithm

**Who polls:**
- Every tab registers the channels it is showing over `BroadcastChannel('matbravo-chat')`.
- One tab wins the lock: `navigator.locks.request('matbravo-chat-poller', () => new Promise(...))`, held for the life of the tab. The leader polls the **union** of all registered channels and broadcasts the results.
- When the leader closes, the lock passes to the next tab automatically.
- Fallback when Web Locks or BroadcastChannel is missing (very old browsers): each tab polls by itself with the interval doubled.
- In demo mode (`dist/client.js` demo adapter) the same API is backed by localStorage. The `storage` event plays the role of "new message".

**When to poll (aggregated over all tabs, with ±20% jitter on every delay):**

| State | Delay |
|---|---|
| A tab is visible, the chat is on screen, and the user interacted in the last 60 s, **or** a new message arrived in the last 2 min | `ms[0]` = 2.5 s |
| Visible, idle 1-3 min | `ms[1]` = 5 s |
| Idle 3-10 min | `ms[2]` = 10 s |
| Idle 10-30 min | `ms[3]` = 30 s |
| Idle > 30 min | `ms[4]` = 60 s |
| Chat not on screen (another page), only unread badges needed | 30 s |
| All tabs hidden | **paused** (`cfg.hidden = 0`) |
| `navigator.onLine === false` | paused until the `online` event |

**Poll immediately on:** `visibilitychange` → visible, `focus`, `pageshow` (bfcache), `online`, opening a channel, and right after the user's own send (once more after ~1 s).

**Request hygiene:**
- never two polls in flight;
- `AbortController` timeout of 10 s;
- `fetch(url, {cache: 'no-store', credentials: 'same-origin'})` for `chat-feed`;
- `chat-public` may use the default cache mode.

**Errors:**
- network error or `5xx`: delay = `min(60 s, 2 s × 2^n)` × random(0.5..1) (exponential back-off with jitter);
- `429`/`503`: wait `Retry-After` (or 15 s if missing), then continue with the back-off;
- reset `n` after the first success;
- `401` → guest mode;
- `404` → drop the channel.

**Beacon mode (`cfg.t = 'beacon'`):**
- The leader polls `/live/lobby.json` (and `/live/t-<key>.json` for an open tournament chat) with the same timings, sending `If-None-Match: <last ETag>` and `cache: 'no-store'`, so JS sees the `304` itself.
- When a head `rev` exceeds the cursor, it calls `chat-feed` once.
- Guests read `/live/c/<key>.json` directly.
- A `chat-feed` / `chat-public` safety poll every `cfg.safety` (60 s).
- Any beacon error (404, 403, parse failure) switches that client back to `poll` for 10 minutes.

**UI behaviour that the protocol enables:**
- Messages are appended without re-rendering the list.
- Scroll position is kept; if the reader is scrolled up, a "N new messages" pill appears instead of jumping.
- The composer is never touched.
- New messages are announced through a polite live region (batch summary, not every message).

### 5.7 Abstraction for switching to a third-party provider

**Client** (new module, for example `dist/chat-transport.js`; the chat store never knows which transport is active):
```js
// transport contract
// watch(channelIds) / unwatch(id)  -> which channels matter
// on('hint', fn(channelId, rev?))  -> "this channel may have changed"
// poke()                           -> poll now (after send, on focus)
// stop()
// implementations: pollTransport (chat-feed), beaconTransport (static heads), pushTransport (Pusher/Ably signal)
```
Every transport only produces **hints**. The content always comes from `chat-feed` / `chat-public` with cursors. Ordering, deduplication, tombstones and privacy therefore stay in one place regardless of transport.

**Server:** `ChatBus::published(int $channelId, int $rev)` is called after every committed chat change. Drivers:
- `none` (pure polling);
- `beacon` (rewrite the static head file and the guest tail);
- `push` (HTTPS publish of `{"c":…,"r":…}` to the provider with a 2 s timeout, after the response is sent).

Several drivers can be active together during a migration.

---

## 6. Rollout and verification on production

1. **Stage 1 (launch):**
   - adaptive short polling (`cfg.t = 'poll'`);
   - `chat-public` session-less and cacheable;
   - `chat-feed` with `read_and_close`;
   - one poller per browser;
   - kill switch and tuning;
   - `ChatBus` with the `none` driver.
2. **Stage 2 (prepared in the same release, off by default):**
   - beacon driver and guest tail;
   - deploy symlink `public_html/live -> ~/matdraw/shared/live`, created in `activate` and `rollback`.

   Switch it on by setting `cfg.t = 'beacon'` after the checks below pass.
3. **Stage 3 (only if needed):** push driver (Ably or Pusher, EU cluster, signal-only), plus a CSP `connect-src` change, a DPA, and a privacy-policy entry.

**Checks to run from the server over SSH** (GitHub runners are blocked by the host):
- `curl -sI https://matbravo.com/live/lobby.json` twice, the second time with `If-None-Match` → expect `304`. There must be no PHP-specific headers, and the file must not return 429.
- Inspect the `ETag` format (does it include the inode or only mtime and size?).
- Time 200 sequential idle `chat-feed` polls with `curl -w '%{time_total}'` → confirms the ~5 ms estimate.
- During a test burst, watch DirectAdmin's Resource Usage (LVE: EP, NPROC, CPU faults).
- Check `max_user_connections` (`SHOW VARIABLES LIKE 'max_user_connections'`) and the actual plan (Start/Biznes/Pro).
- Ask AfterMarket support (one short ticket): are there per-IP request limits (static/dynamic) or account-level request limits, and what are the numbers? Is LSCache available for the account? Mention the expected pattern: up to ~1 request per 2.5 s per active visitor, small JSON, and possibly 100+ visitors behind one venue IP.

---

## 7. Recommendation

1. **Do not use the self-reloading iframe.** Keep its good idea, a regular short check, but reload **data, not pages**. That avoids flicker and lost scroll or typed text, saves the phone's data and battery, and stays accessible.
2. **Do not use long polling, SSE or WebSockets.** On this hosting each waiting reader would hold one of only 16 PHP processes (WebSockets are impossible outright).
3. **Build adaptive short polling now:**
   - per-channel `rev` cursors and a single primary-key head check;
   - `204` when nothing changed;
   - separate session-less, cacheable `chat-public` for guests (no personal data, only a decorative blur variant), and `chat-feed` for members with `read_and_close`;
   - one poller per browser (Web Locks + BroadcastChannel);
   - 2.5 s while watched and active, 5/10/30/60 s when idle, paused when hidden, immediate on focus and after the user's own send;
   - exponential back-off with jitter and `Retry-After` on errors, 429 and 503;
   - chat tables kept **completely separate** from `Repository::transaction()/snapshot()`, with only per-channel row locks.
4. **Make it remotely controllable:**
   - `chat_settings` (versioned `cfg`: on/off, intervals, transport, notice) is returned to clients whenever the version changes;
   - a file-based emergency brake answers `503` before any DB work.
5. **Prepare the static beacon and guest tail** (a `ChatBus` driver plus a deploy symlink to `~/matdraw/shared/live`). Switch it on with `cfg.t = 'beacon'` once the production checks confirm LiteSpeed serves `304` without PHP and without 429. This takes idle polling (and all guest polling) off PHP and the DB, and moves comfortable capacity from "a few hundred" to "1000+" readers.
6. **Keep a third-party push provider (Ably/Pusher, signal-only) as stage 3.** Choose it only if real usage shows many hundreds of simultaneous readers or a need for sub-second latency. The transport abstraction makes this a configuration and CSP change, not a rewrite.
7. **No typing indicators.** The online count is optional, anonymous minute buckets (members only), off by default.

Expected result: about 1.3 s median delivery while someone watches the chat, instant display of one's own messages, and near-zero cost when nobody is writing. The design degrades gracefully: it slows down instead of breaking, and it can be throttled or switched off from the server without a deploy.

---

## Sources

- AfterMarket.pl hosting security parameters (official; processes, PHP processes, CPU/RAM, runtime, timeouts, IOPS, SQL limits): https://www.aftermarket.pl/Hosting/Security/ (also https://www.aftermarket.eu/Hosting/Security/)
- AfterMarket.pl plan listings mentioning "LiteSpeed + CloudLinux Webstack", DirectAdmin (third party): https://www.whtop.com/plans/aftermarket.pl/85405 , https://www.whtop.com/plans/aftermarket.pl/85403
- LiteSpeed and CloudLinux EP limits (suEXEC Max Conn below the LVE EP limit): https://docs.litespeedtech.com/lsws/cp/cpanel/ts-cloudlinux/
- CloudLinux LVE limits overview (third party): https://my.iwebfusion.net/knowledgebase/58/What-are-the-CloudLinux-LVE-Limits.html
- Entry Processes = parallel web scripts (third party): https://docs.nexcess.com/hosting/server-administration/linux/what-is-cloudlinux.md
- LiteSpeed cache hits do not trigger PHP (forum, third party): https://wordpress.org/support/?p=9058188
- CloudLinux + LiteSpeed EP tracking discussion: https://forum.directadmin.com/threads/cloudlinux-litespeed-ep-tracking.64080
- SSE buffering on LiteSpeed (`X-Accel-Buffering: no`, compression; third party): https://dev.to/ahmet_gedik778845/streaming-live-video-view-counts-with-server-sent-events-on-php-and-litespeed-52ip
- PHP-generated responses must handle If-None-Match themselves; static files get 304 from the server: https://bugs.php.net/bug.php?id=49106
- LiteSpeed cache control via .htaccess / ETag handling notes: https://docs.litespeedtech.com/lscache/devguide/controls/ , https://wordpress.org/support/?p=7694193
- Pusher Channels pricing: https://www.pusher.com/channels/pricing (figures via https://ably.com/topic/pusher-pricing and https://www.budgetforge.dev/tools/pusher-pricing-2026; third party, partly conflicting)
- Ably free package and pricing: https://ably.com/docs/platform/pricing/free , https://ably.com/docs/pricing
- Supabase pricing: https://supabase.com/pricing
- Firebase Realtime Database limits: https://firebase.google.com/docs/database/usage/limits

Not fetched (blocked in this session): docs.stripe.com, developer.mozilla.org, web.dev. Browser API statements (Page Visibility, Web Locks, BroadcastChannel, Fetch cache modes and author-set `If-None-Match` making the request bypass the HTTP cache so JS sees `304`) come from my own knowledge **[unverified in this session]**, and they should get a quick test in Safari/iOS before release.
