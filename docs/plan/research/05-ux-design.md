# 05 - UX/UI design: central chat, tournament chats, paid accounts and profiles, PWA

Status: design spec (no product code changed). Date: 2026-10-31. Author role: senior product/interaction/visual designer.
Mockup: **`docs/plan/mockups/home-chat.html`** (static, self-contained; open it from inside the repo so the brand files in `dist/` load). Verified with Playwright at 1440 px: no failed requests, no horizontal overflow.
Inputs: `01-code-map.md` (code), `02-realtime.md` (adaptive polling), `03-stripe.md` (billing, access states). Where this spec depends on them, it says so.

Legend: **[decision]** = what I recommend we build; **[owner]** = needs the owner's choice; **[dep]** = depends on a backend or research decision outside UX; **[unverified]** = platform behaviour I could not confirm in this session.

---

## 0. Summary of decisions

1. **Home page, desktop (≥1200 px): concept A, "Live centre".** The visitor home keeps its three columns, but the middle column becomes a **live, read-only chat card**. Column 1 holds the brand story and *Upcoming tournaments* with the waving Matbravo. Column 3 keeps the login form exactly where returning club representatives expect it, plus a "New account, 8.99 PLN/month" card.
2. **Tablet (651-1199 px):** two columns. Story, chat card (fixed height) and tournaments sit on the left; login and signup sit on the right.
3. **Phone (≤650 px):** a **chat preview card** (latest 3 messages, channel chips, "Open chat") sits under a compact hero. The full chat is a **full-screen route** (`#chat?c=taekwondo-pl`). It is not a bottom sheet, because a route keeps the back button, deep links, iOS standalone mode and the keyboard reliable. A returning device (one that has logged in before) shows the login panel *above* the chat card.
4. **Logged-in users:** a **"Czat" item in the sidebar** with an unread badge, a "Czat turnieju" item under the active tournament, and a dismissible one-line chat strip on *Tournaments*. No sounds, no pop-ups. Club representatives on tournament day see only badges.
5. **Channels:** stored without emoji (`name` + `scope: world|pl`). They are drawn with **inline SVG** (a globe for World, a PL flag for Poland), because flag emoji show up as the letters "PL" on Windows. The order is fixed, as the owner listed them. The default channel comes from the profile (sport + country) or, for guests, from the UI language.
6. **Tournament chats:** opened from the upcoming list ("czat · 12"), as a **Chat tab in the guest preview**, and through "Czat turnieju" in the shell. Lifecycle: *open* from publication until the end of the day after the tournament; then a *read-only archive*.
7. **Guests and logged-in unpaid users** read everything, but the server sends **no identity at all**: no name, initials, country, sport, avatar or stable id. The UI draws an **intentional placeholder**: an abstract gradient avatar and a soft blurred name bar (decorative, `aria-hidden`), plus screen-reader text "Uczestnik ukryty dla gości". The composer is replaced by an **honest CTA** that shows the price.
8. **Message list:** Slack-style, left-aligned, grouped by author within 5 minutes, with day separators. Own messages get an ice tint and a cyan edge. Deleted messages become tombstones. A "New messages: N" pill replaces auto-jumping. History loads on scroll-up. Enter sends and Shift+Enter adds a new line (desktop only). A counter appears at 800 of 1000 characters.
9. **Avatars:** initials stay the default and the fallback (brand rule). An uploaded photo appears **only** in chat, the profile card and the user's own sidebar block, never in workspace tables, brackets, prints or the hall screen. The mascot is never a user avatar.
10. **Signup** is a 3-step flow on its own route (`#signup`): Account → Profile → Plan. The account exists after step 2. Leaving at step 3 gives an honest *unpaid* account, not a lost signup.
11. **Payment:** hosted Stripe Checkout and Portal (`03-stripe.md`). The currency follows the country (PLN for PL, USD elsewhere) and can be switched before paying. Return pages cover success, processing, cancelled and failed. There is no hidden price, no pre-ticked box and no confirm-shaming.
12. **PWA:** our own install card on Chromium (`beforeinstallprompt`) and an instruction sheet on iOS. Shown **never on a first visit**, only after real use (2nd day after login, after the first sent message, or on tournament day). "Not now" means 30 days of silence. A "New version" toast replaces silent reloads.
13. **Accessibility:** WCAG 2.2 AA. A feed pattern for messages; a single throttled polite live region (at most every 15 s, summary only); skip links to chat and login; and a corrected grey for timestamps (the current `#7b8fa8` is 3.3:1 and fails).

---

## 1. What exists today (grounding)

Screens checked with Playwright on the static demo at 1440 and 390 px:

- **Visitor home = login screen** (`renderLogin`, `dist/app.js` l.164). At ≥1200 px it has three grid areas: `story | upcoming | form`. Story and upcoming are navy (`#102447`), the form is white. The waving Matbravo peeks over the *Upcoming tournaments* card (breathing loop, pause button). At ≤650 px the order is: navy bar with logo and PL/EN, the login form, then the navy upcoming section, then the footer.
- **Guest preview** (`#guest?t=…`): navy guest bar, stats, the `accessCard()` upsell slot (guide pose), and categories with brackets. Initials only.
- **Shell:** navy sidebar (global nav, active tournament select, event nav, demo note, rules/about, profile with initials, *My account*, *Log out*); white topbar; light content `#f5f8fc`.
- **Tokens:** `brand.css` (`--mb-navy #00448a`, `--mb-blue #0072bc`, `--mb-cyan #00aeef`, `--mb-ink #102e4b`, `--mb-ice #eff8ff`) and `styles.css :root` (`--ink #19324f`, `--navy #102447`, `--muted #617188`, `--line #dfe7f0`, `--bg #f5f8fc`, `--red #c95d63`, `--amber #996415`). Breakpoints in use: 440, 650/651, 760, 800, 1000, 1080, 1180, 1199/1200, 1250, 1600/1650.
- **Constraints:** CSP is `'self'` only (no inline scripts; `img-src 'self' data:`, so **`blob:` URLs are blocked**). There is no public signup and no e-mail sending. Every write goes through the global workspace transaction (chat must not). Hosting allows no websockets and PHP processes are scarce (`02-realtime.md`).

---

## 2. Home page with the central chat

### 2.1 Goals and the people in them

| Person | Arrives wanting to... | Must not be hurt by the chat |
|---|---|---|
| Club representative (existing, grandfathered free) | log in fast, often on a phone, on tournament morning | the login form must stay one glance/one tap away |
| Coach/athlete/parent (new) | see what the community is talking about, then decide to join | sees the price before investing effort |
| Casual visitor from a shared tournament link | check the date and the bracket | the chat must not bury *Upcoming tournaments* |

Success metrics (for later analytics, privacy-friendly server counts only): login success time unchanged; signup starts per 100 home visits; chat-card → full-chat opens.

### 2.2 Concepts

**Concept A - "Live centre" (three columns, the chat is the middle column)**
```
┌──────────────────────────┬──────────────────────────────────────────┬──────────────────────────┐
│ [MatBravo logo]          │ ┌ (bubble) Czat MatBravo   ● Na żywo [⤢]┐│                 [PL|EN]  │
│                          │ │[🌐 Taekwondo][PL Taekwondo][🌐 Karate]  ││ WITAJ W MATBRAVO        │
│ TWÓJ TURNIEJ. TWOJA EKIPA│ │[🌐 Ogólny]       (tabs, icons in SVG)  ││ Zaloguj się              │
│ Od zgłoszenia            │ ├────────────────────────────────────────┤│ E-mail  [             ]  │
│ do finału.               │ │ ───── Dziś ─────                        ││ Hasło   [             ]  │
│ Turnieje, drabinki       │ │ (◍) ▒▒▒▒▒▒  08:12                       ││ [Zaloguj się        →]   │
│ i rozmowy…               │ │     Czy ktoś wie, o której ważenie…     ││ Nie pamiętasz hasła?     │
│            (Matbravo     │ │     Pytam, bo jedziemy z Krakowa…       ││ ┌ NOWE KONTO   8,99 zł ┐ │
│             waves)       │ │ (◍) ▒▒▒▒  08:15                         ││ │ ✓ Pisz w czatach     │ │
│ ┌ Najbliższe turnieje ─┐ │ │     Ważenie od 7:30…                    ││ │ ✓ Profil, sport, kraj│ │
│ │ 14 LIS Puchar Jesieni│ │ ├────────────────────────────────────────┤│ │ [Załóż konto →]      │ │
│ │  Warszawa · czat·12 >│ │ │🔒 Dołącz do rozmowy [Załóż konto][Zaloguj]││ │ Poza PL: $2.99/mies. │ │
│ │ 5 GRU Grand Prix…   >│ │ │   8,99 zł / mies. · anulujesz w dowolnym…││ └──────────────────────┘ │
│ └──────────────────────┘ │ └────────────────────────────────────────┘│     Wykonano przez MEDUCASE│
└──────────────────────────┴──────────────────────────────────────────┴──────────────────────────┘
  navy                         navy, chat card = white, sticky             white
```

**Concept B - "Chat-first landing" (a top bar, the chat as the hero, login in a dialog)**
```
┌ [logo]   Czat · Turnieje · O MatBravo                  [PL|EN] [Zaloguj] [Załóż konto] ┐
├─────────────────────────────────────────────────────────┬──────────────────────────────┤
│  Od zgłoszenia do finału — i wszystkie rozmowy po drodze │  Najbliższe turnieje          │
│ ┌ Czat (full width, 70 vh) ───────────────────────────┐ │  14 LIS Puchar Jesieni        │
│ │ tabs │ messages …                                    │ │  5 GRU Grand Prix             │
│ │ 🔒 Dołącz do rozmowy …                              │ │  (Matbravo)                   │
│ └─────────────────────────────────────────────────────┘ │                              │
└─────────────────────────────────────────────────────────┴──────────────────────────────┘
```

**Concept C - "Preview card" (today's layout plus a small card under Upcoming tournaments)**
```
┌ story ────────────────┬ Najbliższe turnieje ─────┬ Zaloguj się ─────────┐
│ Od zgłoszenia…        │ 14 LIS Puchar Jesieni    │ E-mail / Hasło        │
│                       │ 5 GRU Grand Prix         │ [Zaloguj się]         │
│                       │ ┌ Na czacie ───────────┐ │                       │
│                       │ │ ▒▒▒ Czy ktoś wie…    │ │                       │
│                       │ │ [Otwórz czat →]      │ │                       │
│                       │ └──────────────────────┘ │                       │
└───────────────────────┴──────────────────────────┴───────────────────────┘
```

### 2.3 Evaluation (1 = poor, 5 = best)

| Criterion | A Live centre | B Chat-first | C Preview card |
|---|---|---|---|
| Discoverability of the chat ("well embedded") | **5** live, readable, central | 5 | 2 (a card among cards; one more click) |
| Login conversion for returning club reps | **5** unchanged position | 2 (login moves into a dialog/header) | 5 |
| Signup conversion (desire + honest price) | **4** live proof plus an adjacent offer | 4 | 2 |
| Tournament use case not overwhelmed | **4** Upcoming stays visible above the fold | 3 (pushed to a rail) | 5 |
| Brand fidelity (approved login composition, mascot role) | **4** same structure, mascot still waves at Upcoming | 2 (new landing, mascot loses its stage) | 5 |
| Performance (polling only while visible) | 4 (polls while on screen) | 3 (always on screen, larger) | 5 (light, lazy) |
| Phone adaptation | needs a different pattern (preview + route) | same issue | natural |
| Build effort | medium | high (new landing and header) | low |

**[decision] A on desktop and tablet; C's preview-card pattern on phones.** It is the only option that is both "well embedded" and keeps the login exactly where it is. On phones a live scroll area inside the scrolling page would trap scrolling and fight the keyboard, so phones get the preview card plus the full-screen route.

### 2.4 Chosen layout, per breakpoint

**Desktop ≥1200 px** (grid areas `story chat auth`):
- Columns `minmax(340px,388px) minmax(460px,1fr) clamp(400px,30vw,480px)`; at ≥1650 px `400px minmax(560px,760px) 520px`, centred.
- The chat card is `position: sticky; top: 24px; height: calc(100dvh - 48px)`, with min 560 px and max 900 px. The list scrolls *inside* the card; the page scrolls only if the left column is taller.
- Left column: logo, eyebrow, H1 (44 px; down from 64 px to free height), one-line intro, then the existing `upcoming-stage` (mascot `--mascot-h: 196px`). The three feature bullets move into the signup card as benefits.
- Right column: unchanged login, plus a signup card (`acct-join`) below. The demo note and demo accounts stay in demo mode.

**Tablet 651-1199 px** (areas `story auth / chat auth / upcoming foot`):
```
┌ navy: logo, eyebrow, H1, intro ──────────────┬ white ─────────────┐
├ chat card (height 560px, inner scroll, [⤢])  │ Zaloguj się        │
├ Najbliższe turnieje + Matbravo               │ Nowe konto card    │
└──────────────────────────────────────────────┴ footer ────────────┘
```
The left column is `1.15fr` and the right is `minmax(360px,1fr)`, like today. The chat card has its own scroll area; on touch tablets an "Open full chat" button (`⤢`) is always visible.

**Phone ≤650 px** (single column; tested down to 360 px):
```
┌ navy ───────────────────────────────────┐
│ [logo]            [PL|EN] [Zaloguj]      │  "Zaloguj" scrolls to #login and focuses e-mail
│ TWÓJ TURNIEJ. TWOJA EKIPA.               │
│ Od zgłoszenia do finału.                 │
│ Turnieje, drabinki i rozmowy…            │
│ ┌ white card (overlaps hero by 60px) ──┐ │
│ │ (bubble) Czat MatBravo   ● Na żywo   │ │
│ │ [PL Taekwondo PL][🌐 Taekwondo Świat]→│ │  chips scroll sideways, fade on the right
│ │ (◍) ▒▒▒▒  08:17  Dzięki! A czy…      │ │  last 3 messages, 3 lines max each
│ │ (◍) ▒▒▒   08:21  Tak, mała sala…     │ │
│ │ (◍) ▒▒    teraz  Do zobaczenia…      │ │
│ │ [        Otwórz czat  →          ]   │ │
│ │ Pisanie po założeniu konta · 8,99 zł │ │
│ └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
  white: WITAJ W MATBRAVO / Zaloguj się (form) / Nowe konto card
  navy:  Najbliższe turnieje + Matbravo
  footer
```
- **Returning device:** if `localStorage['matdraw.knownDevice']` (set after any successful login; a per-device convenience) is present, the login panel renders *before* the chat card. First-time visitors see the chat first.
- At 360 px: hero H1 at 28 px; chips show the scope as a code ("PL") instead of the word; buttons are full width.

### 2.5 Behaviour of the embedded chat

- **Lazy:** the chat module (`chat.js`, a dynamic `import()`, allowed by `script-src 'self'`) loads after first paint, when the card is within 200 px of the viewport (IntersectionObserver). Until then the card shows a 4-row skeleton.
- **Polling:** only while the card is visible *and* the tab is visible. Guests use the session-free cacheable route (`chat-public`, `02-realtime.md` §5.3). On the phone preview, poll at the "idle" rate (10 s): it is a preview. The full route uses the active rate (2.5 s).
- **Language switch** (`rerenderLanguage` re-runs `renderLogin`): the chat state lives in a module object. Re-render repaints from the state and keeps the channel, scroll offset and any draft.
- **Tabs on the home page** use the ARIA tab pattern (arrow keys move between tabs and switch the panel; the panel is the message list). The selected channel is remembered in `localStorage['matdraw.chat.channel']`.
- **Expand `⤢`** goes to `#chat?c=<slug>`. For guests this is a public full-page chat with the guest bar from the guest preview, so no shell is needed.

### 2.6 How logged-in users reach the chat

- **Sidebar, global nav:** `Turnieje · Czat · Baza zawodników · Konta i role`. "Czat" shows the **total unread across non-muted global channels plus tournament chats the user's club has entries in**: a pill, cyan on navy, `1-99` then `99+`.
- **Sidebar, event nav:** "Czat turnieju" for the active tournament, with its own unread badge.
- **Tournaments page widget:** a one-line strip above the tournament grid: `(bubble) Na czacie · Taekwondo · Polska — „Tak, mała sala obok…” · 3 nowe [Otwórz czat] [×]`. "×" hides it on this device (`matdraw.chat.strip=off`). The sidebar item remains.
- **Member-only accounts** (new self-signup role, see §10.6): the sidebar shows `Czat · Najbliższe turnieje · Moje konto` and no workspace items.
- **Never:** sound, browser notifications, auto-opening chat, or badges in the hall screen or prints.

---

## 3. Routes and deep links

The existing convention is English hash ids with query parameters (`#guest?t=`, `#screen?tournament=`). New routes follow it:

| Route | Who | View |
|---|---|---|
| `#chat` | everyone | last channel used, otherwise the default channel (§4.3) |
| `#chat?c=taekwondo` · `taekwondo-pl` · `karate` · `general` | everyone | that global channel |
| `#chat?t=<tournamentId>` | everyone | that tournament's chat (guests: inside the guest page frame) |
| `#guest?t=<id>&tab=chat` | guests | guest preview with the Chat tab selected |
| `#signup` / `#signup?step=2|3` | visitors and unpaid users | signup flow |
| `#billing` / `?billing=success|cancel&session_id=…` | logged-in users | plan, return states (`03-stripe.md` §5) |
| `#profile` | logged-in users | edit own profile |
| `#moderation` | admin | reports and mutes |

`#czat…` is accepted as an alias and normalised with `history.replaceState`, so Polish links shared in posters work. Slugs never change; display names are translated.

---

## 4. Channel UI

### 4.1 Data and rendering

- **Stored:** `{slug:'taekwondo-pl', name:'Taekwondo', scope:'pl'}`, `{slug:'taekwondo', name:'Taekwondo', scope:'world'}`, `{slug:'karate', name:'Karate', scope:'world'}`, `{slug:'general', name:'Ogólny', scope:'world'}`. No emoji in the data. The owner's "Tarkwondo" is treated as a typo.
- **Drawn:** a 22 px round chip holding either a stroke **globe icon** (new `globe` path in `icons.js`) or a **PL flag SVG** (two rects, `#fff` / `#dc143c`, with a 1 px hairline so the white half shows on white). The label is `Taekwondo` with a smaller line `Świat` / `Polska` (EN `World` / `Poland`). The accessible name is "Taekwondo · Polska".
- **Why not emoji:** Windows has no flag glyphs and renders 🇵🇱 as "PL" letters. Inline SVG also removes font and OS variance.
- **User country flags in messages** (about 250 countries): **[decision]** self-host a flag-only colour font (the open-source "Twemoji Country Flags" subset used by the `country-flag-emoji-polyfill` package, about 80 KB WOFF2). It is loaded through `@font-face` with `unicode-range: U+1F1E6-1F1FF`, so it downloads only when a flag is drawn and only matters on Windows. The text stays a real emoji (copyable and searchable), and the ISO code goes in `title` and in screen-reader text ("Polska"). **[unverified]** licence terms (Twemoji graphics are CC-BY 4.0, which requires attribution on the About page) and file size; check them before adding. **Fallback if it is rejected:** a 2-letter code chip (`PL`) styled like a badge. Never a mixture of both.

### 4.2 Ordering

The order is fixed, as the owner listed it: **Taekwondo · World, Taekwondo · Poland, Karate · World, General · World**. A stable order builds muscle memory; personalisation is done by the *default selection*, not by reordering. Tournament chats come in a separate group below, sorted by date (upcoming first; past ones go into a collapsed "Archive (n)").

### 4.3 Default channel

1. The last channel the viewer used (localStorage).
2. Members: primary sport Taekwondo and country PL → `taekwondo-pl`; Taekwondo and another country → `taekwondo`; primary sport Karate → `karate`; anything else → `general`.
3. Guests: UI language PL → `taekwondo-pl`; EN → `taekwondo`.

### 4.4 Channel descriptions (header subtitle)

| Channel | PL | EN |
|---|---|---|
| Taekwondo · Poland | Rozmowy po polsku | Conversation in Polish |
| Taekwondo · World | Dowolny język — najlepiej angielski | Any language — English works best |
| Karate · World | Dowolny język — najlepiej angielski | Any language — English works best |
| General · World | Wszystko o sztukach walki i MatBravo | Everything about martial arts and MatBravo |

"Zasady kanału" / "Channel rules" opens a short modal with the community rules (the text itself comes with the legal session; reserve the slot).

### 4.5 Unread counts

- **Members:** server-side read cursor per channel. The badge shows the number (`1-99`, `99+`), primary navy on white surfaces and cyan on navy. Muted channels show a grey dot and no number, and are excluded from the sidebar total.
- **Guests:** no accounts, so only a **cyan "new since your last visit" dot**, computed from the last seen message id in localStorage. No numbers, no pressure.
- **Marking as read:** when the newest message of a channel has been on screen for 1 s while the tab is visible. Opening a channel scrolls to the **"Nowe" divider** (the first unread message), not to the bottom.
- **Mute channel:** the bell button in the channel header has two states, "Powiadomienia: włączone / wyciszone". It only affects badges.

---

## 5. Tournament chats

### 5.1 Placement

| Surface | What appears |
|---|---|
| Home "Upcoming tournaments" | non-interactive meta inside each item button: `(bubble) czat · 12` (message count, only if > 0). It is one button, so no nested controls; the screen-reader text is "Czat turnieju: 12 wiadomości". |
| Guest preview (`#guest?t=`) | a **tab bar** under the heading: `Kategorie i drabinki | Czat turnieju (12)`. The chat tab is the same component in the guest projection, with the CTA composer. |
| Shell, any role | "Czat turnieju" in the event nav (active tournament), and the "Tournament chats" group in the `#chat` rail. |
| Tournament card in *Tournaments* (shell) | a secondary link `(bubble) Czat · 3 nowe` beside "Open tournament". |
| Hall screen, prints | never. |

### 5.2 Lifecycle

| State | When | UI |
|---|---|---|
| Not created | tournament is `draft` | nothing is shown |
| **Open** | from status `open` until 23:59 Europe/Warsaw on the **day after** the tournament date (allows thanks and results talk) **[owner: 1 day, configurable]** | normal chat; on tournament day a "Dziś zawody" chip appears in the header |
| **Archive** | after that | banner "Turniej zakończył się {date}. Czat jest tylko do odczytu."; composer removed; still readable by everyone; listed under "Archiwum" |
| Hidden | the tournament is removed from public views | the chat is hidden as well; links show "Ten czat nie jest już dostępny." |

Who can write: any paid/free/staff member (the same rule as global channels). The organiser (admin/editor who manages the tournament) gets the "Organizator" badge in that chat and can pin **one** message (for example "Ważenie 7:30, sala B"). The pinned message shows as a slim bar under the header. **[owner]** pinning is small but valuable on tournament day; it can wait for v1.1.

---

## 6. Guest (and unpaid) experience

### 6.1 What the server sends

Guests and logged-in unpaid users (`03-stripe.md` §10.1) get, per message: `id, ts, text (or tombstone flag), cont (same author as the previous message in this response, within 5 min), g (0-4 decoration variant)`.
- `g` = `HMAC(daily_salt, channel_id ‖ user_id) mod 5`. It gives only 5 buckets, rotates daily and never repeats across channels. It cannot identify anyone and exists only so the page does not look like one person talking to themselves.
- **No** name, initials, username, avatar, country, sport, club or a stable id. Initials are deliberately *not* used, unlike the tournament guest view. In a small community, initials plus channel plus time re-identify people, and athletes are often minors.

### 6.2 The placeholder (designed, not "blurred data")

- **Avatar** (`ghost-ava g0-g4`): a 36 px circle in one of five brand-blue gradient compositions (soft disc + rounded square, blurred 2-3 px). It is abstract, calm, on-brand and does not look like a broken image.
- **Name** (`ghost-name w1-w3`): a 10-11 px rounded bar, gradient `#c8d7e7 → #dbe5f0`, `filter: blur(1.6px)`, in 74/96/118 px widths derived from `g`. The time stays visible.
- **Message text is visible** (the owner wants everyone to read). Links in guest view are shown as text with the domain only, not clickable. This prevents the guest chat being used as an anonymous link farm, and members still get links.
- **Screen readers:** the placeholder elements are `aria-hidden="true"`. Each message group carries one `<span class="sr-only">Uczestnik ukryty dla gości</span>` (EN "Participant hidden from guests"). The feed has a description once: "Imiona uczestników widzą tylko członkowie MatBravo."
- **Profile card:** clicking a ghost avatar opens no card. It shows a small popover "Kto pisze? Zobaczysz po założeniu konta." with the same two buttons as the CTA.

### 6.3 The composer replacement (CTA)

```
┌──────────────────────────────────────────────────────────────────────┐
│ [🔒] Dołącz do rozmowy                          [Załóż konto] [Zaloguj się] │
│      Załóż konto, aby pisać i widzieć, kto rozmawia.                     │
│      8,99 zł / mies. · anulujesz w dowolnym momencie                     │
└──────────────────────────────────────────────────────────────────────┘
```
- Logged in but unpaid: `[✦] Aktywuj konto, aby pisać / Zobaczysz też, kto rozmawia. [Aktywuj]` → `#billing`.
- Logged in, free/paid, but muted: a lilac banner "Moderator wstrzymał Twoje pisanie do {time}." No CTA.
- Price by UI language (PL → "8,99 zł / mies.", EN → "$2.99 / month"). The paywall page lets the user switch.

### 6.4 No dark patterns (checklist for review)

- The price is visible wherever we ask for an account; there are no "free" claims.
- No countdowns, fake scarcity, fake "X people online" or nagging modals. The CTA is a static footer and is never a modal over the chat.
- No confirm-shaming ("Nie, nie chcę rozmawiać" is banned). The secondary choice is neutral: "Nie teraz", "Zaloguj się".
- Cancelling is described up front: "anulujesz w dowolnym momencie" (access lasts until the end of the paid period).
- No pre-ticked consent boxes; consent slots stay empty until the legal texts exist.
- No blurred *real* data that could be un-blurred in DevTools: the server never sends it.

---

## 7. Message list

### 7.1 Anatomy (member view)

```
 (avatar 36)  Marta Kowalska  [PL]  [Taekwondo]  08:12            ← meta line (name 13/750, flag, sport, time)
              Czy ktoś wie, o której zaczyna się ważenie…         ← text 13.5/1.55, overflow-wrap:anywhere
              Pytam, bo jedziemy z Krakowa…                       ← continuation (same author, <5 min): no meta
                                                  [⚑][⋯]          ← hover/focus toolbar (report, more)
```
- **Grouping:** consecutive messages by the same author within 5 minutes are grouped; a day change or a "Nowe" divider breaks the group.
- **Day separators:** "Dziś", "Wczoraj", then `pt 14 lis` for this year and `14 lis 2025` otherwise (`Intl.DateTimeFormat`, UI locale).
- **Timestamps:** "teraz" (<1 min), "{n} min" (<60 min), `HH:mm` today; inside older days only `HH:mm` (the separator carries the date). Each uses `<time datetime="ISO">` with the full date and time in `title`. Relative labels refresh once a minute (text only, no re-render).
- **Name:** the display name (§9.2). Click or Enter opens the profile card. Truncated with an ellipsis; the full name is in the card.
- **Country:** a flag (§4.1) with `title` and screen-reader text set to the country name.
- **Sport badge:** the primary sport (`chat-sport`); a second sport on wide screens only. Sport colours: Taekwondo `#00679d/#e8f6fc`, Karate `#6b4aa0/#f2edfb`, others neutral `#4d6480/#edf2f7`.
- **Role badges:** "Moderator" (admin acting in chat, navy) and "Organizator" (tournament chats only). The admin-granted *free account* status is **never** shown publicly; payment status is private.
- **Own messages:** an ice tint `#f0f8fe` with a 3 px cyan inner left edge and a "Ty" chip. They stay left-aligned, like every other message: in a multi-person channel, left alignment keeps names, flags and badges in one scan line.
- **Avatar:** a photo (members who uploaded one) or initials on `#eaf3fb/#36658c` (as today's `.avatar`). It loads lazily as 64 px WebP.

### 7.2 Message states

| State | Visual | Behaviour |
|---|---|---|
| Sending | text at full opacity, small `(clock) Wysyłanie…` under it | optimistic; replaced by the server copy |
| Failed | red `(!) Nie wysłano. Ponów · Usuń` (`#b3424a`, 5.5:1) | draft kept; Retry re-posts with the same client id (idempotent) |
| Deleted by moderator | italic grey "(shield) Wiadomość usunięta przez moderatora"; avatar and name stay | content is never sent to clients |
| Deleted by author | "Wiadomość usunięta" | the author can delete their own message at any time (menu `⋯`) |
| Hidden pending review | "Wiadomość ukryta do czasu sprawdzenia" | auto-hidden after ≥3 distinct reports **[owner: threshold]** |
| Reported by me | small "Zgłoszono" label for the reporter only | the reporter can also "Ukryj u mnie" |
| Long text | clamp at 12 lines with a fade and "Pokaż więcej / Pokaż mniej" | max 1000 characters enforced server-side |
| Link | `http(s)` only, auto-linked, `rel="noopener noreferrer nofollow ugc" target="_blank"`, external-link icon, text shows the URL without the protocol, max 60 characters with an ellipsis | no previews (privacy, CSP); other schemes stay plain text; guest view: domain text, not clickable |
| Editing | **not in v1** (a revision stream under polling adds cost); delete and re-post instead | |

### 7.3 List-level states

- **Scrolled up and new messages arrive:** the pill "↓ Nowe wiadomości: {n}" floats 12 px above the composer and does not jump. Click scrolls to the first new one. Shown when more than 120 px from the bottom.
- **At the bottom:** new messages append and the view stays pinned (no animation under reduced motion).
- **Older history:** a sentinel at the top auto-loads 30 more (IntersectionObserver), with a "Wczytaj wcześniejsze" button as the fallback. Scroll position is preserved (measure `scrollHeight` before and after). `aria-busy="true"` on the feed while loading. At the start: "To początek kanału {name}."
- **Empty channel:** the round Matbravo avatar (allowed: he welcomes) with "Zacznij rozmowę" / "W kanale {name} nikt jeszcze nie napisał. Przywitaj się!" Guests see "…Załóż konto i napisz pierwszy." The mascot is never placed inside the list itself.
- **Loading:** 4 skeleton rows (static under reduced motion).
- **Connection** (from the poller in `02-realtime.md` §5.6):
  - live: the header pill "● Na żywo" (cyan dot);
  - two failed polls: a grey banner "(↻) Łączenie ponownie…";
  - `navigator.onLine === false`: an amber banner "Brak połączenia. Nowe wiadomości pojawią się po powrocie sieci."; the composer still accepts text and queues one message ("Wyślemy po odzyskaniu połączenia");
  - server kill switch: "Czat jest chwilowo wyłączony. Spróbuj później." with the list frozen;
  - 429/back-off: no banner unless it lasts more than 30 s (then "Łączenie ponownie…").
- **Profile card** (click on avatar or name): see §9.3.
- **Moderation menu** (`⋯`, admin only, on any message): `Usuń wiadomość`, `Wycisz autora…`, `Pokaż profil w panelu kont`, `Kopiuj link do wiadomości`. For everyone: `Zgłoś`, `Kopiuj tekst`, own messages `Usuń`.

### 7.4 Report flow (member)

The `⚑` button opens a modal titled "Zgłoś wiadomość". Reasons are radio buttons: *Spam lub reklama* · *Obraźliwe lub nienawistne treści* · *Nękanie* · *Dane osobowe lub wizerunek dziecka* · *Inne*. There is an optional comment of up to 300 characters. Buttons: `[Anuluj] [Wyślij zgłoszenie]`. Afterwards a toast: "Dziękujemy. Moderator sprawdzi zgłoszenie." One report per user per message.

---

## 8. Composer

- An auto-growing `<textarea>` of 1-6 lines (then it scrolls). The placeholder is "Napisz w kanale {channel}…". It has a visible label for screen readers ("Wiadomość do kanału {channel}"), visually hidden.
- **Keys (desktop, `pointer: fine`):** Enter sends; Shift+Enter adds a new line; Enter while `event.isComposing` (IME) is ignored; Esc clears the focus ring only. **Touch (`pointer: coarse`):** Enter adds a new line and the button sends. The hint row shows the keys on desktop only.
- **Send button:** 38 px, disabled-looking but focusable while empty, with `aria-disabled` and a tooltip. Messages are trimmed before sending; whitespace-only input is rejected locally.
- **Counter:** hidden until 800; then "{n} / 1000" in the meta grey; from 950 amber `#8a5a12`; at 1000 input stops (`maxlength`). Screen-reader announcements at 900 and 1000 only ("Zostało 100 znaków", "Osiągnięto limit 1000 znaków").
- **Rate limit** (server 429 or the client rule, for example 1 message per 3 s and 20 per minute): an inline note "Zwolnij trochę — kolejna wiadomość za {s} s." and the send button shows the countdown. The draft is never lost.
- **Draft:** kept per channel in `sessionStorage` (survives language switch, reload and the update toast).
- **Hint line** (desktop, right): "Nie publikuj danych dzieci ani numerów telefonów." This is privacy by design for a sport with many minors.
- **Phone keyboard handling:**
  - `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">`. Chrome/Android resizes the layout; iOS ignores it. **[unverified]** iOS 26 behaviour.
  - iOS: listen to `visualViewport` `resize`/`scroll` and set `--kb` = `innerHeight - visualViewport.height - visualViewport.offsetTop`. The full-screen chat uses `height: 100dvh`, and the composer gets `padding-bottom: max(env(safe-area-inset-bottom), 8px)` and `transform: translateY(calc(-1 * var(--kb)))`.
  - After a send, the focus stays in the textarea so the keyboard does not close.
  - `scroll-padding-bottom` equals the composer height, so the focused message is never hidden (WCAG 2.4.11).
  - Font size 16 px in the textarea on phones (prevents iOS zoom).
- **Not in v1:** emoji picker (the OS keyboards have one), attachments/images (moderation and storage cost), mentions, typing indicators (`02-realtime.md` §4), reactions. Mentions and reactions can come in v1.1.

---

## 9. Profiles

### 9.1 Fields

| Field | Rules | Visibility |
|---|---|---|
| First name, last name | 1-50 characters each; letters (incl. diacritics), space, `-`, `'` | members (per the display setting) |
| Username | 3-24, `a-z 0-9 . _`, starts with a letter, case-insensitive unique, reserved list (`admin`, `matbravo`, `moderator`, `meducase`, `support`, …) | members |
| Country | ISO 3166-1 alpha-2, names via `Intl.DisplayNames` in the UI language | members |
| Sports | 1-5 from the list: Taekwondo, Karate, Judo, Kickboxing, Brazylijskie jiu-jitsu, Jiu-jitsu, Boks, MMA, Zapasy, Muay Thai, Inne; the first is primary (reorder with "Ustaw jako główny") | members |
| Avatar | optional photo; initials fallback | members |
| Club / school | **free text, optional**, display only; never links the user to a workspace club | members (toggle "Pokaż w profilu") |
| E-mail | existing | private (owner and admin) |
| Role, workspace club | existing, set by the admin | private; the "Moderator"/"Organizator" badge is derived |
| Display as | "Imię i nazwisko" or "Imię i inicjał nazwiska" **[owner: default]**. Recommendation: full name, because members are a closed paying group and the owner asked for names. Privacy by default would argue for the initial. | - |

### 9.2 Avatar rules (reconciling the brand rule)

The brand rule says users keep their initials avatars. **[decision]** Keep initials as the default everywhere. Allow an *optional* photo **only** in community surfaces: chat messages, the profile card, the own-profile page and the user's own sidebar block. Workspace tables, athlete lists, brackets, prints, the hall screen and the admin accounts table stay initials-only. Matbravo is never a user avatar. Update the README brand section accordingly when this ships.

### 9.3 Public profile card (popover; a full-screen sheet on phones)

```
┌──────────────────────────────┐
│ (photo 56)  Marta Kowalska    │
│             @marta.k          │
│ [PL] Polska                   │
│ (cup) Taekwondo · Karate      │
│ (users) KS Tygrys Kraków      │
│ (cal) W MatBravo od paź 2026  │
│ ───────────────────────────── │
│ [⚑ Zgłoś]  [Wycisz u mnie]    │
└──────────────────────────────┘
```
- It is a non-modal dialog: focus moves into it and Esc returns focus to the name. No DMs in v1. "Wycisz u mnie" hides that user's messages for me (server-side list; collapsed rows read "Ukryta wiadomość od wyciszonej osoby · Pokaż").
- Admins see an extra row: `Konto: aktywne / zablokowane · [Otwórz w panelu kont]`.

### 9.4 Edit profile (`#profile`, tabs `Profil | Subskrypcja | Bezpieczeństwo`)

This replaces today's *My account* modal (`myAccount`), which becomes the *Bezpieczeństwo* tab (password change).
```
Profil
 (avatar 96) [Zmień zdjęcie] [Usuń zdjęcie]
 Imię [        ]   Nazwisko [          ]
 Nazwa użytkownika [@marta.k     ] ✓ dostępna
 Kraj [Polska ▾]
 Sporty [Taekwondo ★][Karate][+ Judo][+ Kickboxing]…
 Klub lub szkoła (opcjonalnie) [KS Tygrys Kraków] [x] Pokaż w profilu
 Pokazuj mnie jako (•) Imię i nazwisko ( ) Imię i inicjał nazwiska
 [Anuluj] [Zapisz zmiany]
```
Username changes are limited to once per 30 days (shown as a note).

---

## 10. Signup

### 10.1 Entry points

The home signup card, the chat CTA, the guest preview access card (`ACCESS.kind = 'paid'`), the profile popover on a ghost and `#signup` links. The flow is a focused page with the guest-bar header (logo, PL/EN, "Masz konto? Zaloguj się"), no sidebar and no chat polling.

### 10.2 Steps (a progress indicator "Krok 1 z 3")

```
Desktop: single centered column 520px on #f5f8fc, card on white; phone: full width.

Krok 1 z 3 · Konto                      Krok 2 z 3 · Profil                     Krok 3 z 3 · Plan
┌───────────────────────────────┐       ┌───────────────────────────────┐      ┌───────────────────────────────┐
│ Załóż konto MatBravo          │       │ Twój profil                    │      │ Wybierz walutę                 │
│ E-mail      [              ]  │       │ (avatar) [Dodaj zdjęcie]       │      │ [PLN · Polska][USD · inne kraje]│
│ Hasło       [              ]👁 │       │ Imię [     ] Nazwisko [      ] │      │ 8,99 zł / miesiąc              │
│  min. 12 znaków ▓▓▓▓░ dobre   │       │ Nazwa użytk. [@      ] ✓       │      │ ✓ Pisanie we wszystkich czatach│
│ [consent slot — legal later]  │       │ Kraj [Polska ▾]                │      │ ✓ Pełne profile uczestników    │
│ [Dalej →]                     │       │ Sporty [chips…]                │      │ ✓ Czaty turniejów              │
│ Masz konto? Zaloguj się       │       │ Klub (opcjonalnie) [        ]  │      │ Odnawia się co miesiąc. Anulu- │
└───────────────────────────────┘       │ [← Wstecz] [Utwórz konto →]    │      │ jesz w każdej chwili.          │
                                        └───────────────────────────────┘      │ [Przejdź do płatności →]       │
                                                                               │ Płatność obsługuje Stripe.     │
                                                                               │ Później · wróć do czatu        │
                                                                               └───────────────────────────────┘
```
- **Step 1:** e-mail (`autocomplete=email`) and password (`new-password`, 12-72 characters as today, a show/hide toggle, a strength hint without arbitrary composition rules; pasting and password managers allowed, WCAG 3.3.8). Consent area: reserved empty slot(s) `acct-consents`; the legal session fills them (never pre-ticked).
- **Step 2:** the account is **created** on "Utwórz konto" (state `none`, can read blurred and edit its own profile). Avatar upload is optional here and can be skipped.
- **Step 3:** the plan. "Później" is a real choice that leads to the chat in the unpaid state, with "Aktywuj" visible in the composer.
- **E-mail verification [dep]:** there is no SMTP today. Paid self-service accounts need at least password reset by e-mail, so this is a backend prerequisite (PHP `mail()` on AfterMarket or SMTP, **[unverified]**). The UI reserves: a "Potwierdź e-mail" banner ("Wysłaliśmy link na {email}. [Wyślij ponownie]") and "Nie pamiętasz hasła?" → `#reset`. Until then, the link on the home page reads "Skontaktuj się z nami" and goes to the contact page.

### 10.3 Username live availability

- Debounce 400 ms after typing stops; GET `username-check?u=` (rate-limited, no session needed, returns only `available|taken|invalid|reserved`).
- States under the field (`aria-live="polite"` on that line only):
  - `(spinner) Sprawdzanie…`;
  - `✓ Nazwa jest dostępna` (blue `#0072bc` plus the icon, never colour only);
  - `✗ Ta nazwa jest zajęta. Propozycje: marta.k2, marta_kowalska` (buttons that fill the field);
  - `✗ 3–24 znaki: małe litery, cyfry, kropka i podkreślnik; zacznij od litery.`;
  - `✗ Tej nazwy nie można użyć.`.
- Prefill a suggestion from first and last name (`marta.kowalska`, transliterated: ł→l, ś→s…).

### 10.4 Country default

Take the first entry of `navigator.languages` that has a region (`pl-PL` → PL, `en-US` → US, `de-AT` → AT). A bare `pl` → PL. Otherwise leave it empty with the placeholder "Wybierz kraj". Use a native `<select>` (accessible, typeahead, no library): Poland pinned first, a separator, then countries alphabetically by localised name. The currency default in step 3 follows this field (`03-stripe.md` §3.3).

### 10.5 Avatar upload, crop and preview (CSP-safe)

- `<input type=file accept="image/jpeg,image/png,image/webp">`, at most 8 MB in. Read with `createImageBitmap(file)` and draw on a `<canvas>`. **No `URL.createObjectURL`**, because `blob:` is blocked by `img-src 'self' data:` and adding it to the CSP is not worth it.
- Crop dialog: a circular mask over a 280 px canvas.
  - Drag to pan (pointer events), with **keyboard and button alternatives** (WCAG 2.5.7): arrow keys pan 4 px (Shift = 20 px); `+`/`−` and a range slider "Powiększenie" zoom; a "Wyśrodkuj" button.
  - Live 36 px and 96 px previews (canvas).
  - `[Anuluj] [Zapisz zdjęcie]`.
- Output: `canvas.toBlob('image/webp', 0.86)` at 256×256 (JPEG fallback), uploaded by `fetch` POST with CSRF.
- Server **[dep]**: verify with `finfo`; re-encode with GD (this strips EXIF/GPS); store at 256 px and 64 px under `~/matdraw/shared/uploads/avatars/<random>.webp` (outside the release); serve same-origin.
- Errors: "To nie jest obraz JPG, PNG ani WebP." / "Plik jest za duży (maks. 8 MB)." / "Nie udało się wysłać zdjęcia. Spróbuj ponownie."

### 10.6 Role for self-signup [dep]

A new role `member`, with no workspace access. Free-text club only. **A self-registered user can never join a workspace club**: club representation stays an admin action, as today. Existing `users.club_id NOT NULL` needs a nullable path or a sentinel; the backend plan decides.

---

## 11. Paywall, checkout, return states, subscription

### 11.1 Plan page (`#billing`, also step 3)

- Segmented radio group "Waluta": `PLN · Polska` | `USD · inne kraje`, defaulting from the country. Locked (disabled, with an explanation) while a subscription is live.
- Price block: "8,99 zł / miesiąc" or "$2.99 / month". Under it: "Odnawia się co miesiąc. Anulujesz w panelu Stripe jednym kliknięciem; dostęp zostaje do końca opłaconego okresu." **[dep: legal]** gross price and VAT wording.
- Button "Przejdź do płatności" → `location.assign(stripeUrl)`, with a busy state "Otwieranie bezpiecznej płatności…". Below it: "Płatność obsługuje Stripe. Nie zapisujemy danych karty."

### 11.2 Return states (`?billing=…`, read and stripped by the SPA)

| State | Visual | Copy (PL) |
|---|---|---|
| Success, active | Matbravo **success pose** (allowed: celebrates) + green-free brand check | "Gotowe! Twoje konto jest aktywne." / "Następne odnowienie: {date}." [Przejdź do czatu] |
| Processing (`incomplete`; poll confirm every 3 s up to 30 s) | spinner, no mascot | "Potwierdzamy płatność…" / "To zwykle trwa kilka sekund. Możesz zamknąć tę stronę — konto aktywuje się samo." |
| Still processing after 30 s | info | "Płatność jest jeszcze przetwarzana. Sprawdzimy ją ponownie przy następnym wejściu." [Odśwież status] |
| Cancelled | neutral | "Płatność przerwana. Nic nie zostało pobrane." [Spróbuj ponownie] [Wróć do czatu] |
| Failed | red notice | "Płatność nie powiodła się. Spróbuj innej karty lub metody." [Spróbuj ponownie] |
| Session expired while paying | the login screen with a notice | "Zaloguj się ponownie, aby dokończyć aktywację konta." (confirm replays after login) |

### 11.3 Subscription tab (`#profile` → Subskrypcja)

The status badge comes from the server access state (`03-stripe.md` §10):
- `active` "Aktywna do {date}";
- `ending` "Kończy się {date}";
- `past_due` "Problem z płatnością — zaktualizuj kartę" (amber);
- `free` **"Konto darmowe (przyznane przez Administratora)"**, optionally "do {date}";
- `staff` "Konto zespołu MatBravo";
- `none` / `ended` "Brak aktywnej subskrypcji" + [Aktywuj].

The button "Zarządzaj subskrypcją" opens the Stripe Portal ("Otworzy się bezpieczna strona Stripe."). After returning: "Zaktualizowano informacje o subskrypcji." There is no in-app cancel button that hides the Portal's own flow.

---

## 12. Admin

### 12.1 Accounts list (`accountsPage` additions)

```
[Wszystkie 128][Płatne 61][Darmowe 52][Bez subskrypcji 11][Problem z płatnością 4]   [Szukaj e-mail lub nazwy…]
┌ Użytkownik ───────────────┬ Klub ─────────┬ Rola ──────┬ Plan ───────────┬ Subskrypcja ─────┬ Status ──┬──────────┐
│ (MK) Marta Kowalska        │ —             │ Członek    │ [Płatne]        │ Aktywna do 30.11 │ Aktywne  │[Zarządzaj]│
│      marta@… · @marta.k    │               │            │                 │                  │          │          │
│ (TW) TKD Warszawa          │ TKD Warszawa  │ Reprezent. │ [Darmowe]       │ —                │ Aktywne  │[Zarządzaj]│
│ (JL) Jan Lis               │ —             │ Członek    │ [Brak]          │ Zakończona 02.10 │ Aktywne  │[Zarządzaj]│
│ (AN) Anna Nowak            │ —             │ Członek    │ [Oczekuje]      │ Płatność w toku  │ Aktywne  │[Zarządzaj]│
└───────────────────────────┴───────────────┴────────────┴─────────────────┴──────────────────┴──────────┴──────────┘
```
Avatars stay initials here (brand rule). Plan badges: Płatne (teal), Darmowe (navy outline), Brak (neutral), Oczekuje (amber), Problem z płatnością (amber + icon). On phones the existing `roster-table` card layout applies.

### 12.2 Account form additions (`accountForm`)

- A switch `[x] Darmowe konto (bez płatności)` with the hint "Konto ma pełny dostęp bez subskrypcji." Default **on** for admin-created accounts **[owner]** (`03-stripe.md` §10.2).
- When on: "Powód (widoczny tylko dla administratorów)" (required) and "Darmowe do (opcjonalnie)" as a date.
- If the user has a live Stripe subscription: an amber notice "Ten użytkownik ma aktywną subskrypcję." with a checkbox `[ ] Zatrzymaj też subskrypcję Stripe na koniec okresu`.
- Read-only rows: "Subskrypcja: …", "Ostatnia synchronizacja: …", [Synchronizuj teraz], [Otwórz w Stripe ↗].
- Moderation rows: "Pisanie na czacie: dozwolone / wstrzymane do …" with [Wycisz…] / [Przywróć pisanie].

### 12.3 Moderation (`#moderation`, admin nav "Moderacja" with a badge for open reports)

```
Moderacja                              [Zgłoszenia 3] [Wyciszeni 1] [Historia]
┌───────────────────────────────────────────────────────────────────────────┐
│ Taekwondo · Polska · dziś 08:16 · 3 zgłoszenia (Spam ×2, Nękanie ×1)        │
│ (PL) Piotr Lis @piotr.lis                                                   │
│ "Tanie doboki tylko dziś, pisz na…"                                         │
│ Kontekst: [pokaż 2 wiadomości przed i po]                                   │
│ [Usuń wiadomość] [Wycisz autora…] [Odrzuć zgłoszenie] [Otwórz w czacie ↗]   │
└───────────────────────────────────────────────────────────────────────────┘
```
- Every action asks for an internal note (optional) and is audit-logged. "Usuń wiadomość" leaves the tombstone. The original stays readable for admins for 30 days **[owner]**.
- **Mute dialog** "Wycisz {name}":
  - duration radio: 1 godzina / 24 godziny / 7 dni / Na stałe;
  - internal reason;
  - a preview of what the user sees: "Moderator wstrzymał Twoje pisanie do {time}." (or "…bezterminowo");
  - buttons `[Anuluj] [Wycisz]`.
- The "Wyciszeni" tab lists the user, until, by whom and why, with [Przywróć pisanie].
- Empty state: the Matbravo avatar with "Brak zgłoszeń. Społeczność jest w formie!" (allowed: celebrates).

---

## 13. PWA install and updates

### 13.1 Technology [dep: implementation]

- **Manifest** (exists): add
  - `id: "./"`;
  - `start_url: "./?source=pwa"`;
  - `shortcuts` (Czat → `./#chat`, Turnieje → `./#tournaments`);
  - `screenshots` (one narrow 1080×1920 and one wide 1920×1080; required for Android's richer install sheet);
  - a dedicated maskable icon with ≥10% safe padding (the current `maskable` reuses `icon-512`; check the mark is not cropped).
  - The language stays PL; there is no per-language manifest.
- **Service worker** `sw.js` at the docroot (registered from `app.js`, not inline; CSP `worker-src` falls back to `script-src 'self'`).
  - Network-first for `index.html`; cache-first for versioned static assets with a build hash written by `build-php.mjs`; **never cache `/api/*`**; an offline fallback page.
  - `.htaccess`: `Cache-Control: no-cache` for `sw.js` and the manifest.
- **Standalone detection:** `matchMedia('(display-mode: standalone)').matches || navigator.standalone === true` → `html.is-standalone`, which hides all install UI. In standalone mode there is no browser back button, so every full-screen view has its own back button (already in the chat design).

### 13.2 Surfaces

| Platform | Signal | UI |
|---|---|---|
| Chrome/Edge/Samsung (Android, desktop) | `beforeinstallprompt` (stash it, `preventDefault`) | **Install card** `pwa-card` → `prompt()`; on `appinstalled`: toast "MatBravo jest na ekranie głównym." |
| iOS/iPadOS (Safari, and other browsers since iOS 16.4) | UA (iPhone/iPad, or Mac with touch) and not standalone | **Instruction sheet** `pwa-ios` with a 3-step illustration: Udostępnij (share icon) → "Do ekranu początkowego" (plus-square) → "Dodaj". **[unverified]** iOS 26 moved Share into a "⋯" menu in compact Safari; add the line "Nie widzisz przycisku? Stuknij ⋯, potem Udostępnij." |
| macOS Safari 17+ | UA | small card: "W Safari wybierz Plik → Dodaj do Docka." |
| Firefox desktop, unsupported | none | nothing |

### 13.3 Placement

- **Desktop shell:** bottom of the chat channel rail (mockup) or above the sidebar's bottom block on other pages. Never over the composer or content.
- **Phone:** an inline card in the `#chat` channel list or under the Tournaments grid. The iOS sheet opens only from that card's "Jak zainstalować?" button, or once for trigger 3 below.
- **Copy and art:** the app icon tile; Matbravo in the *guide* pose is allowed in the iOS sheet (he guides), never in the compact card.

### 13.4 Timing rules (all stored in localStorage `matdraw.pwa`)

- **Never:**
  - on the first visit or for guests on the home page;
  - during signup, checkout or return pages;
  - while a modal is open or the composer has focus;
  - more than once per session;
  - in standalone mode.
- **Triggers** (whichever comes first, evaluated after the page is idle):
  1. a logged-in user on their **2nd distinct day** of use;
  2. **3 s after the user's first successfully sent chat message**;
  3. **tournament day**: the user's club has entries in a tournament dated today, or the user opened today's tournament preview. Variant copy: "Dziś zawody — miej drabinki pod ręką."
- "Nie teraz" means 30 days of silence. After the 3rd dismissal, never again (a "Zainstaluj aplikację" item stays in *Moje konto*).

### 13.5 Update available

When a new SW is installed and waiting, or the API header `X-App-Version` differs from the loaded build, show the toast **"Dostępna jest nowa wersja MatBravo. [Odśwież]"**:
- bottom-left on desktop; above the composer or bottom nav on phones;
- `role="status"`; it stays until acted on (no auto-dismiss).

Click posts `SKIP_WAITING` and reloads on `controllerchange`. **Never auto-reload**: drafts survive anyway (sessionStorage), but a club rep mid-form must not lose input.

Push notifications are out of scope (they need server sending and VAPID; reconsider after launch).

---

## 14. Accessibility (WCAG 2.2 AA), specific to this work

- **Landmarks:** home `main` > sections `aria-labelledby` (story, "Czat MatBravo", login). Skip links at the top: "Przejdź do treści" (exists), plus **"Przejdź do czatu"** and **"Przejdź do logowania"**. The DOM order follows the visual order (story → chat → auth).
- **Tabs vs links:** on the home card, channel switching uses the ARIA tab pattern (roving `tabindex`, ←/→, Home/End). In the shell, channels are **links** (`aria-current="page"`) because they are routes.
- **Messages:** `role="feed"` with each group as an `<article aria-labelledby="author time" aria-describedby="text">`. The feed keys PageUp/PageDown move between articles. `aria-busy` while loading older messages. The hover toolbar also appears on `:focus-within`, and its buttons are in the tab order of the focused article only.
- **Announcements:** one visually hidden `aria-live="polite" aria-atomic="true"` region per page. It is updated **at most every 15 s** with a summary ("Nowe wiadomości w kanale Taekwondo · Polska: 3"), only when focus is inside the chat or the full chat page is open, and never for one's own messages. On the home page it is silent unless focus is in the chat. A switch in the channel `⋯` menu: "Odczytuj nowe wiadomości" (default on). Errors use `role="alert"` (send failure, form errors).
- **Focus:**
  - visible 2 px `#0072bc` outline, or `#4ac1ed` on navy;
  - not obscured by the sticky composer or pill (`scroll-padding`);
  - the profile popover returns focus;
  - modals trap focus (existing `modal()`).
- **Targets** ≥ 24×24 px (2.5.8); the mockup's smallest are 30 px.
- **Dragging** (2.5.7): crop pan and sheet drag have button and keyboard alternatives.
- **Auth** (3.3.8): paste allowed, autocomplete on every field, no CAPTCHA. **Redundant entry** (3.3.7): the e-mail is prefilled for Stripe.
- **Contrast** (computed in this session):

| Pair | Ratio | Verdict |
|---|---|---|
| `#617188` muted on white | 4.97 | pass |
| `#7b8fa8` (current timestamp/meta grey) on white | **3.31** | **fail → use `#5b6f89` (5.15 white, 4.83 on `#f5f8fc`)** |
| `#0072bc` link on white | 5.08 | pass |
| `#00aeef` cyan on white | 2.53 | decoration only, never text |
| `#00aeef` on navy `#102447` | 6.08 | pass |
| `#c95d63` current red on white | **4.02** | **fail for small text → `#b3424a` (5.53)** |
| `#8a9db3`-like placeholders | 2.78 | fail → `#627690` (4.65) |
| input border `#c9d8e8` | 1.45 | fails 1.4.11 → composer border `#8296b0` (3.03) |
| sport badge `#00679d` on `#e8f6fc` | 5.55 | pass |
| "Nowe" divider `#c2410c` on white | 5.18 | pass |
| text `#06243f` on cyan button | 6.23 | pass |

- **Reduced motion:** no slide-in for the full-screen chat, no smooth scroll, the live dot does not pulse, skeletons are static, and Matbravo's breathing is already static.
- **Language:** `lang` on user content is unknown, so leave it unset. UI strings follow `documentElement.lang` (existing).

---

## 15. i18n

- Every string below goes through `T('Polish key')` with an English entry in `dist/i18n-en.js` (enforced by `tests/i18n.test.mjs`). Server error messages (rate limit, muted, 402) need English entries too.
- **Polish plurals:** the dictionary only does English `{one,other}`. In Polish, use count-neutral phrasing ("Nowe wiadomości: {n}", "czat · {n}"), as the code already does ("{n} os.").
- **Not translated:** channel names "Taekwondo", "Karate" (sport names); data stays Polish ("Ogólny" is translated at display). Taekwondo terms follow the existing ITF usage in the dictionary (patterns, sparring, Gup/Dan); no new ITF terms are introduced here.
- **Formatting:** dates, times and relative time via `Intl` with `locale()`; currency via `Intl.NumberFormat(locale(), {style:'currency', currency})`, which gives "8,99 zł" in PL and "PLN 8.99" in EN. The USD price shows "$2.99" in EN and "2,99 USD" in PL.

---

## 16. Performance budget

| Item | Budget |
|---|---|
| New JS: `chat.js` (+ `account.js`, `pwa.js`) | ≤ 30 KB min+gz total; lazy (`import()`), nothing added to the first paint of the login screen |
| New CSS: `chat.css`, `account.css` | ≤ 12 KB gz; static `<link>` files (the CSP's `style-src 'unsafe-inline'` would allow inline styles, but files cache better and match the codebase) |
| Flag font | ≈ 80 KB, only if a flag is drawn (unicode-range), cached long-term |
| Avatars | 64 px WebP ≈ 2-4 KB, `loading="lazy"`, `decoding="async"` |
| Home poll payload | 204/304 when unchanged; ≤ 3 KB for 30 messages gz |
| Libraries | none (no React, no emoji picker, no cropper library) |
| Rendering | append-only DOM; ≤ 300 messages kept in DOM (older ones trimmed and reloadable) |

---

## 17. Component inventory

| Component (class) | Where | States |
|---|---|---|
| `chat-card` | home desktop/tablet; phone preview | loading (skeleton), live, reconnecting, offline, disabled (kill switch), error (retry) |
| `chat-head` | card, full view | live pill on/off; muted bell; tournament-day chip; archive |
| `chat-tabs` / `chat-tab` | home card | selected, unselected, new-dot (guest), unread count (member), focus |
| `chat-chips` / `chip` | phone preview, compact widths | selected, overflow fade |
| `chat-rail`, `rail-item` | shell `#chat` | active, unread n, muted dot, tournament (next/past), archive group collapsed/expanded |
| `chat-log` (feed) | everywhere | empty (mascot), loading older, at start, pinned bottom, scrolled up |
| `chat-day`, `chat-new-div` | log | - |
| `chat-msg` | log | member / guest projection; group start / continuation; own; hover/focus toolbar; sending; failed; deleted by moderator; deleted by author; hidden pending review; reported by me; long (clamped / expanded); with link |
| `ghost-ava g0-g4`, `ghost-name w1-w3` | guest/unpaid view | decorative only |
| `chat-ava` | member view | initials, photo, broken photo → initials |
| `chat-sport`, `chat-mod`, `chat-you`, flag | meta line | - |
| `chat-actions` | message toolbar | report, more (member); moderation items (admin) |
| `chat-pill` | log | hidden, "Nowe wiadomości: n" |
| `chat-banner` | top of log | offline (amber), reconnecting (grey), archive (grey), muted (lilac), disabled |
| `chat-composer` | full view, shell | empty, typing, counter ≥800, ≥950 warning, limit, rate-limited countdown, sending, offline-queued |
| `chat-gate` | composer slot | guest CTA, unpaid CTA |
| `chat-pinned` (v1.1) | tournament chats | collapsed, expanded |
| `chat-report` modal | report flow | form, sending, done |
| `acct-profile-card` | popover / phone sheet | member, admin extra row, ghost popover (guest) |
| `acct-join` | home auth column, guest access card | PLN, USD |
| `acct-steps` | signup | step 1/2/3, errors |
| `acct-username` | signup, profile | idle, checking, available, taken (+ suggestions), invalid, reserved |
| `acct-crop` | avatar dialog | empty, loaded, error |
| `acct-plan` | billing | currency PLN/USD, locked, busy |
| `acct-return` | billing return | success, processing, still processing, cancelled, failed, expired |
| `acct-sub` | profile tab | active, ending, past_due, free, staff, none/ended |
| `acct-plan-badge` | admin list | paid, free, none, pending, problem |
| `mod-queue`, `mod-item`, `mod-mute` | `#moderation` | open, resolved, empty |
| `pwa-card` | rail / sidebar / phone list | default, tournament-day variant, installing, installed (toast) |
| `pwa-ios` sheet | phones | default, iOS 26 hint line |
| `pwa-update` toast | global | shown until clicked |
| `chat-strip` | Tournaments page | with unread, without, hidden |

---

## 18. CSS approach

- **New files:** `dist/chat.css` (chat + moderation), `dist/account.css` (signup, profile, billing, PWA), linked in `index.html` after `workspace.css` and before `brand.css`, so brand rules keep the last word. Prefixes: `chat-`, `ghost-`, `acct-`, `mod-`, `pwa-`. No new global element selectors.
- **Reuse:** `.btn` (+ `.primary`, `.secondary`, `.small-btn`), `.badge` (`teal`, `success`, `warning`), `.avatar`, `.panel`, `.notice`, `.eyebrow`, `.field-label`, `.lang-switch`, `.modal`, `.toast`, `.upcoming-*`, `.empty-mascot`, `.sr-only`, `icon()`.
- **New tokens** (add to `brand.css :root`):
  - `--chat-meta:#5b6f89`;
  - `--chat-own:#f0f8fe`;
  - `--chat-edge:var(--mb-cyan)`;
  - `--chat-danger:#b3424a`;
  - `--chat-field-border:#8296b0`;
  - `--ghost-1…5` (gradient pairs);
  - `--sport-tkd:#00679d/#e8f6fc`, `--sport-karate:#6b4aa0/#f2edfb`.
- **New icons** (`icons.js`, same 24-grid stroke style): `chat`, `globe`, `send`, `flag`, `more`, `bell`, `bell-off`, `share`, `plus-square`, `archive`, `wifi-off`, `pin-msg`, `camera`, `zoom-in`, `zoom-out`. Flags for channels come from a tiny `flags.js` (PL only, inline SVG string).
- **Breakpoints:** use the existing ones only. `≥1200` three columns; `≥1650` widened; `651-1199` two columns; `≤650` phone; `≤440` the compact chip label. Container units are not needed.
- **Safe areas:** `env(safe-area-inset-*)` with `viewport-fit=cover`, applied only to the full-screen chat, the bottom sheets and the toast.
- **Print:** `@media print { .chat-card, .chat-strip, .pwa-card, .pwa-update { display:none !important } }`.
- The mockup's CSS is a faithful starting point (same tokens and measurements). It is not production code: it uses `<use>` sprites and static states.

---

## 19. Copy deck (PL key → EN)

Polish is the `T()` key. English entries must not contain Polish letters and must keep `{placeholders}`.

### 19.1 Home and chat card
| PL | EN |
|---|---|
| TWÓJ TURNIEJ. TWOJA EKIPA. | YOUR TOURNAMENT. YOUR TEAM. |
| Turnieje, drabinki i rozmowy środowiska sztuk walki — w jednym miejscu. | Tournaments, brackets and the martial arts community's conversations — all in one place. |
| Przejdź do czatu | Skip to chat |
| Przejdź do logowania | Skip to log in |
| Czat MatBravo | MatBravo chat |
| Rozmowy środowiska — czytać może każdy | Community conversations — anyone can read |
| Na żywo | Live |
| Otwórz pełny czat | Open full chat |
| Otwórz czat | Open chat |
| Kanały | Channels |
| Świat | World |
| Polska | Poland |
| Ogólny | General |
| Nowe od ostatniej wizyty | New since your last visit |
| czat · {n} | chat · {n} |
| Czat turnieju: {n} wiadomości | Tournament chat: {n} messages |
| Pisanie po założeniu konta · {price} / mies. | Posting with an account · {price} / month |
| Konta klubów od Administratora działają jak dotąd. | Club accounts from the Administrator work as before. |
| NOWE KONTO | NEW ACCOUNT |
| Dołącz do społeczności | Join the community |
| miesięcznie | per month |
| Pisz w czatach i czatach turniejów | Post in the chats and tournament chats |
| Profil z Twoim sportem, krajem i klubem | A profile with your sport, country and club |
| Widzisz, kto rozmawia | See who is talking |
| Poza Polską: {price} / miesiąc · płatność przez Stripe | Outside Poland: {price} / month · payment by Stripe |
| Załóż konto | Create account |
| Masz konto? Zaloguj się | Have an account? Log in |
| Nie pamiętasz hasła? | Forgot your password? |
| Odzyskaj dostęp | Recover access |
| Skontaktuj się z nami | Contact us |

### 19.2 Channels and headers
| PL | EN |
|---|---|
| Rozmowy po polsku | Conversation in Polish |
| Dowolny język — najlepiej angielski | Any language — English works best |
| Wszystko o sztukach walki i MatBravo | Everything about martial arts and MatBravo |
| Zasady kanału | Channel rules |
| Czaty turniejów | Tournament chats |
| Archiwum · {n} zakończone | Archive · {n} finished |
| Dziś zawody | Tournament today |
| Powiadomienia: włączone | Notifications: on |
| Powiadomienia: wyciszone | Notifications: muted |
| Wyciszony | Muted |
| Zmień kanał | Change channel |
| Czat turnieju | Tournament chat |
| Kategorie i drabinki | Categories & brackets |
| Na czacie | On the chat |
| Ukryj na tej stronie | Hide on this page |
| Ten czat nie jest już dostępny. | This chat is no longer available. |

### 19.3 Messages and list
| PL | EN |
|---|---|
| Wiadomości: {channel} | Messages: {channel} |
| Dziś | Today |
| Wczoraj | Yesterday |
| teraz | now |
| {n} min | {n} min |
| Nowe | New |
| Nowe wiadomości: {n} | New messages: {n} |
| Nowe wiadomości w kanale {channel}: {n} | New messages in {channel}: {n} |
| Ty | You |
| Moderator | Moderator |
| Organizator | Organiser |
| Wiadomość usunięta przez moderatora | Message removed by a moderator |
| Wiadomość usunięta | Message deleted |
| Wiadomość ukryta do czasu sprawdzenia | Message hidden pending review |
| Zgłoszono | Reported |
| Pokaż więcej | Show more |
| Pokaż mniej | Show less |
| Wczytaj wcześniejsze | Load earlier messages |
| Wczytywanie wiadomości… | Loading messages… |
| To początek kanału {channel}. | This is the start of {channel}. |
| Zacznij rozmowę | Start the conversation |
| W kanale {channel} nikt jeszcze nie napisał. Przywitaj się! | Nobody has posted in {channel} yet. Say hello! |
| W kanale {channel} nikt jeszcze nie napisał. Załóż konto i napisz pierwszy. | Nobody has posted in {channel} yet. Create an account and be the first. |
| Ukryta wiadomość od wyciszonej osoby | Hidden message from a muted person |
| Pokaż | Show |
| Zgłoś | Report |
| Zgłoś wiadomość | Report message |
| Więcej działań | More actions |
| Kopiuj tekst | Copy text |
| Kopiuj link do wiadomości | Copy link to message |
| Usuń | Delete |
| Usuń wiadomość | Delete message |
| Usunąć tę wiadomość? Tej operacji nie można cofnąć. | Delete this message? This cannot be undone. |
| Wycisz autora… | Mute author… |
| Pokaż profil w panelu kont | Show profile in accounts |
| Odczytuj nowe wiadomości | Announce new messages |
| Imiona uczestników widzą tylko członkowie MatBravo. | Only MatBravo members can see participants' names. |
| Uczestnik ukryty dla gości | Participant hidden from guests |
| Kto pisze? Zobaczysz po założeniu konta. | Who is posting? You will see after creating an account. |

### 19.4 Connection and errors
| PL | EN |
|---|---|
| Łączenie ponownie… | Reconnecting… |
| Brak połączenia. Nowe wiadomości pojawią się po powrocie sieci. | You are offline. New messages will appear when the connection is back. |
| Wyślemy po odzyskaniu połączenia | We will send it when you are back online |
| Czat jest chwilowo wyłączony. Spróbuj później. | Chat is temporarily unavailable. Please try again later. |
| Nie udało się wczytać czatu. | Could not load the chat. |
| Spróbuj ponownie | Try again |
| Wysyłanie… | Sending… |
| Nie wysłano. | Not sent. |
| Ponów | Retry |
| Zwolnij trochę — kolejna wiadomość za {s} s. | Slow down a little — you can send again in {s} s. |
| Wiadomość jest pusta. | The message is empty. |
| Wiadomość może mieć najwyżej 1000 znaków. | A message can have at most 1000 characters. |
| Zostało {n} znaków | {n} characters left |
| Osiągnięto limit 1000 znaków | 1000 character limit reached |
| Moderator wstrzymał Twoje pisanie do {time}. | A moderator has paused your posting until {time}. |
| Moderator wstrzymał Twoje pisanie bezterminowo. | A moderator has paused your posting indefinitely. |
| Turniej zakończył się {date}. Czat jest tylko do odczytu. | The tournament ended on {date}. The chat is read-only. |
| Ta funkcja wymaga aktywnej subskrypcji. | This feature requires an active subscription. |

### 19.5 Composer and CTA
| PL | EN |
|---|---|
| Napisz w kanale {channel}… | Write in {channel}… |
| Wiadomość do kanału {channel} | Message to {channel} |
| Wyślij | Send |
| Enter — wyślij · Shift+Enter — nowa linia | Enter — send · Shift+Enter — new line |
| Nie publikuj danych dzieci ani numerów telefonów. | Do not post children's personal data or phone numbers. |
| Dołącz do rozmowy | Join the conversation |
| Załóż konto, aby pisać i widzieć, kto rozmawia. | Create an account to post and see who is talking. |
| {price} / mies. · anulujesz w dowolnym momencie | {price} / month · cancel at any time |
| Aktywuj konto, aby pisać | Activate your account to post |
| Zobaczysz też, kto rozmawia. | You will also see who is talking. |
| Aktywuj | Activate |

### 19.6 Report and moderation
| PL | EN |
|---|---|
| Powód zgłoszenia | Reason for the report |
| Spam lub reklama | Spam or advertising |
| Obraźliwe lub nienawistne treści | Offensive or hateful content |
| Nękanie | Harassment |
| Dane osobowe lub wizerunek dziecka | Personal data or images of a child |
| Inne | Other |
| Komentarz (opcjonalnie) | Comment (optional) |
| Wyślij zgłoszenie | Send report |
| Dziękujemy. Moderator sprawdzi zgłoszenie. | Thank you. A moderator will review the report. |
| Ukryj u mnie | Hide for me |
| Moderacja | Moderation |
| Zgłoszenia | Reports |
| Wyciszeni | Muted users |
| Historia | History |
| {n} zgłoszenia | {n} reports |
| Pokaż kontekst | Show context |
| Odrzuć zgłoszenie | Dismiss report |
| Otwórz w czacie | Open in chat |
| Notatka wewnętrzna (opcjonalnie) | Internal note (optional) |
| Wycisz {name} | Mute {name} |
| Czas wyciszenia | Mute duration |
| 1 godzina | 1 hour |
| 24 godziny | 24 hours |
| 7 dni | 7 days |
| Na stałe | Permanently |
| Powód (widoczny tylko dla administratorów) | Reason (visible to administrators only) |
| Użytkownik zobaczy: | The user will see: |
| Wycisz | Mute |
| Przywróć pisanie | Restore posting |
| Brak zgłoszeń. Społeczność jest w formie! | No reports. The community is in great shape! |

### 19.7 Profile
| PL | EN |
|---|---|
| Profil | Profile |
| Subskrypcja | Subscription |
| Bezpieczeństwo | Security |
| Imię | First name |
| Nazwisko | Last name |
| Nazwa użytkownika | Username |
| Kraj | Country |
| Wybierz kraj | Choose a country |
| Sporty | Sports |
| Ustaw jako główny | Set as main |
| Główny sport | Main sport |
| Taekwondo | Taekwondo |
| Karate | Karate |
| Judo | Judo |
| Kickboxing | Kickboxing |
| Brazylijskie jiu-jitsu | Brazilian jiu-jitsu |
| Jiu-jitsu | Jiu-jitsu |
| Boks | Boxing |
| MMA | MMA |
| Zapasy | Wrestling |
| Muay Thai | Muay Thai |
| Klub lub szkoła (opcjonalnie) | Club or school (optional) |
| Pokaż w profilu | Show on profile |
| Pokazuj mnie jako | Show me as |
| Imię i nazwisko | First and last name |
| Imię i inicjał nazwiska | First name and last initial |
| W MatBravo od {date} | On MatBravo since {date} |
| Wycisz u mnie | Mute for me |
| Otwórz w panelu kont | Open in accounts |
| Nazwę użytkownika można zmienić raz na 30 dni. | You can change your username once every 30 days. |
| Zapisz zmiany | Save changes |
| Zapisano profil. | Profile saved. |
| Zmień zdjęcie | Change photo |
| Dodaj zdjęcie | Add photo |
| Usuń zdjęcie | Remove photo |
| Kadrowanie zdjęcia | Crop photo |
| Powiększenie | Zoom |
| Wyśrodkuj | Centre |
| Zapisz zdjęcie | Save photo |
| To nie jest obraz JPG, PNG ani WebP. | This is not a JPG, PNG or WebP image. |
| Plik jest za duży (maks. 8 MB). | The file is too large (max 8 MB). |
| Nie udało się wysłać zdjęcia. Spróbuj ponownie. | Could not upload the photo. Please try again. |

### 19.8 Signup
| PL | EN |
|---|---|
| Krok {n} z 3 | Step {n} of 3 |
| Konto | Account |
| Plan | Plan |
| Załóż konto MatBravo | Create a MatBravo account |
| Twój profil | Your profile |
| Dalej | Next |
| Wstecz | Back |
| Utwórz konto | Create account |
| Pokaż hasło | Show password |
| Ukryj hasło | Hide password |
| Hasło: słabe | Password: weak |
| Hasło: dobre | Password: good |
| Hasło: bardzo dobre | Password: very good |
| Sprawdzanie… | Checking… |
| Nazwa jest dostępna | This name is available |
| Ta nazwa jest zajęta. | This name is taken. |
| Propozycje: | Suggestions: |
| 3–24 znaki: małe litery, cyfry, kropka i podkreślnik; zacznij od litery. | 3–24 characters: lowercase letters, digits, dot and underscore; start with a letter. |
| Tej nazwy nie można użyć. | This name cannot be used. |
| Ten e-mail ma już konto. Zaloguj się albo odzyskaj dostęp. | This e-mail already has an account. Log in or recover access. |
| Wybierz co najmniej jeden sport. | Choose at least one sport. |
| Potwierdź e-mail | Confirm your e-mail |
| Wysłaliśmy link na {email}. | We have sent a link to {email}. |
| Wyślij ponownie | Send again |
| Później | Later |
| Konto utworzone. Możesz czytać czaty; pisanie włączy aktywacja konta. | Account created. You can read the chats; activating your account lets you post. |

### 19.9 Billing
| PL | EN |
|---|---|
| Waluta | Currency |
| PLN · Polska | PLN · Poland |
| USD · inne kraje | USD · other countries |
| {price} / miesiąc | {price} / month |
| Pisanie we wszystkich czatach | Posting in every chat |
| Pełne profile uczestników | Full participant profiles |
| Czaty turniejów | Tournament chats |
| Odnawia się co miesiąc. Anulujesz w panelu Stripe jednym kliknięciem; dostęp zostaje do końca opłaconego okresu. | Renews monthly. Cancel in the Stripe portal with one click; access stays until the end of the paid period. |
| Walutę zmienisz po zakończeniu obecnej subskrypcji. | You can change the currency after the current subscription ends. |
| Przejdź do płatności | Continue to payment |
| Otwieranie bezpiecznej płatności… | Opening secure payment… |
| Płatność obsługuje Stripe. Nie zapisujemy danych karty. | Payments are handled by Stripe. We do not store card details. |
| Gotowe! Twoje konto jest aktywne. | Done! Your account is active. |
| Następne odnowienie: {date}. | Next renewal: {date}. |
| Przejdź do czatu | Go to the chat |
| Potwierdzamy płatność… | Confirming your payment… |
| To zwykle trwa kilka sekund. Możesz zamknąć tę stronę — konto aktywuje się samo. | This usually takes a few seconds. You can close this page — your account will activate on its own. |
| Płatność jest jeszcze przetwarzana. Sprawdzimy ją ponownie przy następnym wejściu. | The payment is still processing. We will check again on your next visit. |
| Odśwież status | Refresh status |
| Płatność przerwana. Nic nie zostało pobrane. | Payment cancelled. You have not been charged. |
| Wróć do czatu | Back to the chat |
| Płatność nie powiodła się. Spróbuj innej karty lub metody. | The payment failed. Try another card or method. |
| Zaloguj się ponownie, aby dokończyć aktywację konta. | Log in again to finish activating your account. |
| Aktywna do {date} | Active until {date} |
| Kończy się {date} | Ends on {date} |
| Problem z płatnością — zaktualizuj kartę | Payment problem — update your card |
| Konto darmowe (przyznane przez Administratora) | Free account (granted by the Administrator) |
| Konto darmowe do {date} | Free account until {date} |
| Konto zespołu MatBravo | MatBravo team account |
| Brak aktywnej subskrypcji | No active subscription |
| Zarządzaj subskrypcją | Manage subscription |
| Otworzy się bezpieczna strona Stripe. | A secure Stripe page will open. |
| Zaktualizowano informacje o subskrypcji. | Subscription details updated. |

### 19.10 Admin accounts
| PL | EN |
|---|---|
| Użytkownik | User |
| Plan | Plan |
| Płatne | Paid |
| Darmowe | Free |
| Brak | None |
| Oczekuje | Pending |
| Problem z płatnością | Payment problem |
| Bez subskrypcji | Without subscription |
| Wszystkie | All |
| Szukaj e-mail lub nazwy… | Search e-mail or name… |
| Członek | Member |
| Płatność w toku | Payment in progress |
| Zakończona {date} | Ended {date} |
| Darmowe konto (bez płatności) | Free account (no payment) |
| Konto ma pełny dostęp bez subskrypcji. | The account has full access without a subscription. |
| Darmowe do (opcjonalnie) | Free until (optional) |
| Ten użytkownik ma aktywną subskrypcję. | This user has an active subscription. |
| Zatrzymaj też subskrypcję Stripe na koniec okresu | Also stop the Stripe subscription at the end of the period |
| Ostatnia synchronizacja: {date} | Last sync: {date} |
| Synchronizuj teraz | Sync now |
| Otwórz w Stripe | Open in Stripe |
| Pisanie na czacie: dozwolone | Chat posting: allowed |
| Pisanie na czacie: wstrzymane do {date} | Chat posting: paused until {date} |

### 19.11 PWA
| PL | EN |
|---|---|
| Zainstaluj MatBravo | Install MatBravo |
| Otwieraj z pulpitu jak aplikację. Bez sklepu, zajmuje mniej niż 1 MB. | Open it from your desktop like an app. No app store, under 1 MB. |
| Zainstaluj | Install |
| Nie teraz | Not now |
| Jak zainstalować? | How to install? |
| Dziś zawody — miej drabinki pod ręką. | Tournament today — keep the brackets at hand. |
| Dodaj MatBravo do ekranu początkowego | Add MatBravo to your Home Screen |
| Drabinki i czat jednym stuknięciem — także w hali, bez szukania karty w przeglądarce. | Brackets and chat in one tap — even in the sports hall, without hunting for a browser tab. |
| Stuknij Udostępnij | Tap Share |
| Wybierz „Do ekranu początkowego” | Choose "Add to Home Screen" |
| Potwierdź przyciskiem Dodaj | Confirm with Add |
| Nie widzisz przycisku? Stuknij ⋯, potem Udostępnij. | Cannot see the button? Tap ⋯, then Share. |
| W Safari wybierz Plik → Dodaj do Docka. | In Safari choose File → Add to Dock. |
| Gotowe | Done |
| MatBravo jest na ekranie głównym. | MatBravo is on your Home Screen. |
| Dostępna jest nowa wersja MatBravo. | A new version of MatBravo is available. |
| Odśwież | Refresh |
| Zainstaluj aplikację | Install the app |

### 19.12 Navigation and shell
| PL | EN |
|---|---|
| Czat | Chat |
| {n} nieprzeczytanych | {n} unread |
| Najbliższe turnieje | Upcoming tournaments (exists) |
| Moje konto | My account (exists) |
| Wstecz | Back |
| Kanały czatu | Chat channels |

---

## 20. Open questions for the owner

1. Tournament chat stays writable until the end of **the day after** the tournament. OK, or close at the end of the tournament day?
2. Default display of names to members: full name (recommended by this spec) or "first name + initial"?
3. Auto-hide threshold for reported messages (proposed: 3 distinct reports) and how long moderators keep removed text (proposed: 30 days).
4. Should admin-created accounts default to *free* (recommended: yes, they are club and staff accounts)?
5. Pinned organiser message in tournament chats: v1 or v1.1?
6. The flag font for user countries (≈80 KB, CC-BY attribution on the About page) or plain country-code chips?
7. Is a self-registered member allowed to see the full tournament guest preview with names (today only logged-in workspace users do)? This spec assumes **no**: names in tournament data stay a workspace permission.
8. E-mail sending (verification and password reset) is a prerequisite for self-service paid accounts. Which channel: hosting mail or an SMTP provider?

---

## 21. Mockup

`docs/plan/mockups/home-chat.html` contains:
1. the chosen desktop home (guest projection, CTA, signup card, upcoming tournaments with chat counts, waving Matbravo);
2. three phones: guest home with the chat preview card; member full-screen chat with grouping, flags, sport and moderator badges, own message, moderator tombstone, the "Nowe" divider and the new-messages pill; the iOS install sheet;
3. the logged-in shell `#chat` page with unread badges, channel rail, tournament chats, archive, the desktop install card and an open profile card;
4. a state gallery: sending/failed, rate limit, counter, offline/reconnecting, archive/muted, unpaid CTA, empty channel with the mascot avatar, currency switch, update toast, channel/country icons.

It uses inline CSS only, an inline SVG sprite, no scripts and no external requests. Fonts and brand images are loaded relative to `dist/`. Its colours already use the corrected accessible greys from §14.
