# Plan wdrożenia: otwarta rejestracja, role „Zawodnik” i „Organizator turnieju”, samodzielne zgłoszenia — MatBravo

**Status:** plan docelowy do realizacji przez subagentów (fale 1–4), **wersja 2 po przeglądzie** (bezpieczeństwo i prywatność, regresje domeny, UX i produkt; 55 ustaleń). Werdykt dla każdego ustalenia jest w §16. **Data:** 2026-11-01. **Rola autora:** główny architekt.
**Gałąź:** `claude/quirky-einstein-sgelzm` (= `main` `a67ad42` na produkcji + 2 commity dokumentacji).
**Źródła:** wymagania i decyzje właściciela (D1–D4) przekazane przez orkiestratora; poprzedni plan `docs/plan/PLAN-CZAT-PLATNOSCI-PWA.md` (obowiązuje dla tego, co już istnieje: §3, §6, §6.10, §7, §10, §14); **przegląd kodu**: `backend/src/{Domain,Repository,Rules,GuestView,Accounts,Access,Auth,Config,Members,Profiles,Billing,Chat,ChatSettings,People,RouteContext,Routes,Jobs,Migrator,Text}.php`, `backend/routes/*.php`, `backend/public/api/index.php`, `backend/jobs/accounts.php`, `backend/bin/{install,seed-athletes}.php`, `backend/database/schema.sql`, migracje 0002–0006, `dist/{app,workspace,engine,guest-view,client,registry,me,account-boot,account-flow,admin-members,members-boot,profile-data,promo,chat,chat-boot}.js`, `tests/{php,workspace,http,i18n,xss-scan,migrations}.test.mjs`, mosty PHP, `scripts/test-http.sh`, `.github/workflows/deploy.yml`.

**Który dokument rozstrzyga.** Dla rejestracji, ról członków, organizatorów, zawodników i trybów rejestracji rozstrzyga ten plan. W pozostałych sprawach obowiązuje poprzedni plan. Miejsca, które go zmieniają, są oznaczone **[zmienia PLAN-CZAT §x]**.

**Kod a dokumentacja.** Identyfikatory, trasy, SQL i kod są po angielsku. Komunikaty interfejsu i serwera są polskimi literałami (klucze `T()`), angielskie wersje leżą w słownikach `dist/i18n/*-en.js`.

**Legenda:** **[zweryfikowane]** — sprawdzone w kodzie tego repozytorium; **[do weryfikacji]** — do potwierdzenia na serwerze, w Stripe albo na urządzeniu.

---

## 0. Podsumowanie decyzji

| # | Decyzja | Uzasadnienie |
|---|---|---|
| R1 | **Tryb rejestracji i płatności trzymamy w bazie** (tabela `app_settings`, jeden wersjonowany wiersz jak `chat_settings`). Admin przełącza go w panelu **Ustawienia** bez SSH. Właściciel widzi trzy tryby: **Wyłączona / Otwarta, bezpłatna / Otwarta, płatna**. W bazie zapisujemy pola `signup` (`off`/`on`), `payments` (`free`/`paid`), `organizers` (`on`/`paused`) i `supportEmail`. `config.php` zostaje źródłem **wartości startowych** (dopóki Admin nic nie zapisze) i **sufitu awaryjnego** (`signup_force_off`, brak kluczy Stripe). | D1. Właściciel nie jest programistą i nie edytuje `config.php`. Nakładkę liczy **jedno miejsce** (`Routes::dispatch` i `index.php`, §3.2), więc `$ctx->config` zawsze zawiera obowiązujące wartości i nie da się o niej zapomnieć w nowej trasie. |
| R2 | **„Płatna” wymaga skonfigurowanego i osiągalnego Stripe** w chwili przełączenia: `billing_enabled=true` w `config.php` i udane rozpoznanie cen obu walut (`Billing::resolvePrice`, uwierzytelnione wywołanie). Tryb testowy Stripe tylko z jawnym potwierdzeniem. Gdy później zniknie konfiguracja Stripe, rejestracja się **zamyka**, a dostęp się **otwiera**. | D1. Rejestracja zawodzi bezpiecznie, dostęp zawodzi otwarcie. |
| R3 | **Przełączenie na „Płatna” wymaga decyzji o każdym koncie, które w trybie płatnym nie miałoby pełnego dostępu albo ma zwolnienie z okresu bezpłatnego.** Zbiór liczymy funkcją `Access::compute` (z `billing_enforce=true`) po wszystkich żywych kontach członków, nie tylko po znaczniku `free-signup`. Do zbioru należą konta założone w trybie bezpłatnym (rejestracja i Admin), konta sprzed tego wydania i konta, którym okres bezpłatny wygasł w poprzednim okresie płatnym. Admin wybiera **zostaw darmowe** albo **wymagaj płatności od daty** (co najmniej 14 dni; baner 14 dni wcześniej, potem 7 dni karencji). | D1. Bez tego przełączenie odcięłoby od razu konta założone przez Admina i konta po cyklu płatna → bezpłatna → płatna. |
| R4 | **Role to uprawnienia konta członka, nie nowe wartości `users.role`.** Osoba zarejestrowana sama pozostaje `member`. Uprawnienie organizatora to `users.organizer` (plus `organizer_blocked_at` i `organizer_trusted_at` ustawiane przez Admina). Uprawnienie zawodnika to **co najmniej jeden niezarchiwizowany profil z `profiles.owner_user_id` = id konta**. | Najmniej inwazyjne: `admin`/`editor`/`club`, ENUM ról, `Access`, czat i `Members` zostają bez zmian. Osoba może mieć obie role naraz. |
| R5 | **Organizator wchodzi do workspace wyłącznie jako aktor własnego żądania.** `Repository::transaction($fn,$actor)` dokłada go do `$db['users']` na czas wykonania i usuwa przed zapisem; `rows()` pomija każde konto `member`. **`persist()` przestaje używać `INSERT … ON DUPLICATE KEY UPDATE` dla nowych wierszy** (wstawia zwykłym `INSERT`, zmienione aktualizuje `UPDATE … WHERE` klucz) i usuwa profile nieobecne w wyniku. **[zmienia PLAN-CZAT §0 D3]**: „członek nigdy nie jest zapisywany ani wymieniany przez workspace; organizator jest w nim tylko jako aktor własnego żądania”. | Upsert na `clubs` przy kolizji unikalnej nazwy nadpisałby inny klub (§2.4). Usuwanie profili jest potrzebne do usuwania danych (§6.6). |
| R6 | **Zakres organizatora (ograniczenie prywatności od orkiestratora):** widzi i prowadzi **tylko własne turnieje**, zgłoszenia w nich i **zawodników, których sam dodał** (plus własne profile zawodnika). W cudzych otwartych turniejach z samodzielnymi zgłoszeniami widzi **wyłącznie własne zgłoszenia** (O19). Nie widzi bazy zawodników, innych turniejów roboczych ani cudzych zgłoszeń. **Dane społeczności** widzi tylko właściciel i Admin. Edytor i przedstawiciel klubu zachowują dzisiejszy dostęp do danych personelu; w turniejach społeczności widzą tylko własne zgłoszenia i tylko u potwierdzonych organizatorów (O1). | D2 bez globalnej widoczności edytora [zweryfikowane: `Domain::publicData`, filtr `$own` tylko dla `club`]. |
| R7 | **Zawodnik:** do `ATHLETES_PER_ACCOUNT=5` profili na konto, w tym najwyżej jeden z relacją `self`; pozostałe z relacją `guardian` (rodzic lub opiekun zgłasza dziecko lub podopiecznego; O17). **Próg 16 lat**: profil `self` osoby młodszej jest odrzucany z komunikatem, który nie podpowiada obejścia. Klub: **z listy**, **nowy** (`clubs.verified=0`) albo **„Niezrzeszony”** (`unaffiliated`, **nigdy nie rozdzielany w losowaniu**). | D3; privacy-by-design; rodzeństwo na jednym koncie rodzica (UX-2). |
| R8 | **Samodzielne zgłoszenie przechodzi przez `Domain` pod globalną blokadą**, osobnymi trasami `athlete-*` bez rewizji od klienta. Migawka powstaje tą samą funkcją co zgłoszenie klubowe; `champion=false`, `self:true`. **Zgłoszenie i jego zmiana są odrzucane, gdy kategoria docelowa ma już zapisane losowanie**; wycofanie tylko przy statusie `open` i poza losowaniem. | Bez tego dowolne konto kasowałoby drabinki (`reconcile`) albo dostawało niezrozumiałe 409. |
| R9 | **Odczyt zawodnika przez `AthleteView`** (lista dozwolonych pól jak `GuestView`): własne profile i zgłoszenia, kategoria, kontrola startowa, pozycja w drabince, wycofania przez organizatora; inni zawodnicy wyłącznie jako inicjały i klub. Lustro JS `dist/athlete-view.js`, zgodność sprawdza test PHP↔JS. | Bez ładowania workspace i bez ujawniania danych innych dzieci. |
| R10 | **Turnieje organizatora publikują się od razu pod własnym adresem i na liście zawodnika** (D2), z plakietką „Turniej społeczności”. Ochrona: limity (3 nowe na dobę, 10 opublikowanych nadchodzących, globalnie 50 nowych na dobę od niepotwierdzonych), status „Zakończony” dopiero w dniu turnieju, zakaz adresów stron, e-maili i długich numerów w tekstach, wstrzymanie publikacji przez Admina (`organizers: paused`), ukrywanie z powodem i odbieranie roli. | D2: pełna automatyzacja, kontrola po fakcie, bez ścieżki do zbierania danych dzieci (PS-3, PS-4). |
| R11 | **Samodzielne zgłoszenia są ustawieniem turnieju** (`tournaments.self_entry`): nowe turnieje **organizatorów domyślnie tak**, nowe turnieje **personelu domyślnie nie** (brak pola przy tworzeniu = nie), istniejące turnieje po migracji **nie**. | Wymaganie 3 bez zaskoczenia Admina; starsze klienty z pamięci podręcznej nie włączą tego po cichu. |
| R12 | **W trybie płatnym** zgłoszenie do turnieju i narzędzia organizatora wymagają pełnego dostępu (402). **Wycofanie zgłoszenia, poprawa i usunięcie własnych danych oraz podgląd działają zawsze.** | Prawo do sprostowania, wycofania i usunięcia danych nie zależy od płatności. |
| R13 | **Dwie migracje addytywne:** `0007_roles` (kolumny ról i zaufania, właściciel profilu, kluby, ukrywanie, samodzielne zgłoszenia, **znaczniki rewizji**, tabela `entry_withdrawals`, klub `unaffiliated`, z **floor**) i `0008_settings` (`app_settings`, bez floor). | Różne fale; ciągłość numerów. |
| R14 | **Bez wysyłki e-maili.** Status zgłoszenia, kontroli, losowania, wyniku **i wycofania przez organizatora albo Admina** pokazuje strona **Moje starty**. Adres pomocy domyślnie `hello@matbravo.com` (D4). | Brak SMTP (PLAN-CZAT D17). |
| R15 | **Rewizje zakresowe zamiast jednej globalnej kontroli nieaktualności.** Globalna `app_meta.revision` zostaje blokadą i numerem wersji, ale komenda jest odrzucana jako nieaktualna tylko wtedy, gdy zmieniły się obiekty, których dotyczy (turniej, profil, konta personelu), od rewizji widzianej przez klienta (§5.8). Kontrakt klienta (`expectedRevision`) się nie zmienia. Wszystkie transakcje członków mają wspólny globalny limit (120 na minutę), personel nigdy na niego nie czeka. | Bez tego każde zgłoszenie zawodnika i każda komenda organizatora unieważniałaby otwarte formularze personelu przy stole kontroli (PS-1, DR-4). |
| R16 | **Potwierdzony organizator** (`users.organizer_trusted_at`, ustawia Admin jednym przyciskiem): dopiero jego turnieje trafiają na stronę główną i do lobby czatu, przyjmują samodzielne zgłoszenia osób niepełnoletnich (`ADULT_AGE=18`) i zgłoszenia personelu, są zwolnione z globalnego limitu i z wstrzymania publikacji. Admin ma kolejkę „Organizatorzy do potwierdzenia” z licznikiem. | D2 bez zatwierdzania publikacji, a jednocześnie bez drogi do zbierania danych dzieci przez fałszywe turnieje (PS-3). |
| R17 | **Narzędzia organizatora wymagają potwierdzenia hasła po 30 minutach bezczynności i najpóźniej co 12 godzin** (jak sesja personelu), a sesja członka dla czatu i własnych danych zostaje długa. | Organizator widzi dane dzieci, często na wspólnym laptopie w hali (PS-6, DR-18). |
| R18 | **Usuwanie i retencja danych:** komenda `profile.forget` (Admin, twórca profilu, właściciel przez `athlete-forget`), usuwanie kont z regułą na poziomie kategorii, która zawsze się kończy, anonimizacja profili organizatora przy usunięciu konta i zadanie retencji anonimizujące dane społeczności po `RETENTION_MONTHS=24` od ostatniego turnieju. | Dane dzieci nie mogą zostawać bez końca (PS-7, DR-2, DR-3). |
| R19 | **Rejestracja z rolą zawodnika nie bierze blokady workspace.** Dane zawodnika są w pełni walidowane przed transakcją, a profil (i ewentualny nowy klub) powstaje w zwykłej transakcji konta (`Members::tx`). | Anonimowe żądanie nie może trzymać globalnej blokady ani ładować całego workspace (PS-2). |

---

## 1. Śledzenie wymagań

| Wym. | Treść | Sekcje | Plasterki |
|---|---|---|---|
| 1 | Odwiedzający sam zakłada konto | §3, §4.5, §10.1 | `settings-backend`, `accounts-backend`, `account-frontend`, `admin-frontend` |
| 2a | Na początku rejestracji opcjonalne pola „Zawodnik” i „Organizator turnieju” | §4.5, §10.1 | `accounts-backend`, `account-frontend` |
| 2b | Tylko „Zawodnik” pokazuje pytania zawodnika (waga itd.) | §6.1, §10.1 | `data-domain`, `account-frontend` |
| 2c | „Organizator turnieju” automatycznie pozwala dodawać turnieje i zawodników oraz weryfikować ich przed turniejem | §5, §10.4 | `data-domain`, `accounts-backend`, `organizer-frontend` |
| 3 | Zawodnik sam zgłasza się do turnieju | §7, §10.3 | `data-domain`, `athlete-backend`, `athlete-frontend` |
| D1 | Rejestracja bezpłatna do czasu Stripe; Admin przełącza w panelu; konta z okresu bezpłatnego: darmowe albo płatne z 14-dniowym wyprzedzeniem | §3.1–§3.5 | `settings-backend`, `admin-frontend` |
| D2 | Organizator bez zatwierdzania, publikacja od razu; Admin blokuje konta i ukrywa turnieje | §5.4–§5.6, R16 | `data-domain`, `accounts-backend`, `admin-frontend` |
| D2+ | (orkiestrator) Organizator bez globalnej widoczności edytora | §5.1–§5.2, §11 | `data-domain`, `accounts-backend`, `integration-qa` |
| D3 | Klub: z listy, nowy albo „Niezrzeszony”; organizator weryfikuje przy kontroli startowej (i może poprawić klub w zgłoszeniu) | §6.3, §7.5 | `data-domain`, `athlete-backend`, `account-frontend`, `organizer-frontend` |
| D4 | Adres pomocy `hello@matbravo.com` | §3.6, §13 | `settings-backend`, `admin-frontend` |
| — | Teksty prawne poza zakresem; techniczne privacy-by-design i haki dla małoletnich w zakresie | §5.3, §6.5–§6.7, §11 | wszystkie; kontrola w `integration-qa` |
| — | Najwyższa jakość (dane dzieci, właściciel nie jest programistą) | §11, §12, §14, §16 | `integration-qa` |

---

## 2. Stan obecny: co ustaliłem w kodzie i co z tego wynika

1. **Role personelu i widoczność** [zweryfikowane, `backend/src/Domain.php`]:
   - `manages($u,$t)`: admin zawsze, editor dla `createdBy===id`;
   - `managesProfile($u,$a)`: admin; **club dla każdego profilu swojego klubu**; editor dla własnych;
   - `canEnter($u,$t)`: każdy zalogowany do turnieju `open`;
   - `publicData`: filtr `$own` działa **tylko dla `club`**, więc **edytor widzi wszystkie profile i wszystkie zgłoszenia** w turniejach nie-roboczych;
   - `entry.save`: zgłoszenie edytora **nie sprawdza**, czyj to profil (linia 68 sprawdza tylko klub);
   - `entry.remove` zaczyna od `canEnter` (linia 76), więc każda nowa ścieżka wycofania musi być sprawdzana przed nim.

   Potrzebne jest pojęcie **„profil personelu”** (§5.2).
2. **Workspace** [zweryfikowane, `Repository.php`]:
   - `load()` czyta `users` tylko z rolami personelu i **wszystkie** profile, turnieje, zgłoszenia i losowania;
   - `persistUser()` aktualizuje tylko `role<>'member'`; `rows()` zapisuje każde konto z `$db['users']`;
   - `persist()` usuwa wyłącznie zgłoszenia i losowania (linia 69–70: „Accounts/profiles preserve history”).

   `index.php` daje członkowi pusty workspace (`bootstrap`) i 403 (`command`).
3. **Jedna globalna rewizja** [zweryfikowane]: `Domain::execute` odrzuca każdą komendę, gdy `expectedRevision !== $db['revision']` (linia 25), i podnosi rewizję po każdej (linia 26). `app.js:405` po 409 wczytuje workspace od nowa i pokazuje błąd; użytkownik powtarza akcję ręcznie. Każdy nowy publiczny zapis unieważniałby więc formularze personelu (§5.8).
4. **Kluby i `persist()`** [zweryfikowane, `schema.sql:13`, `Repository.php:74-76`]: `clubs.name` jest `UNIQUE` w `utf8mb4_unicode_ci` (bez rozróżniania wielkości liter, akcentów, `ß`/`ss`). `persist()` zapisuje każdy nowy lub zmieniony wiersz przez `INSERT … ON DUPLICATE KEY UPDATE` wszystkich kolumn, także `id`. Nowy klub kolidujący nazwą z istniejącym **nie kończy się błędem 1062** (jak twierdziła wersja 1), tylko `UPDATE` istniejącego wiersza: przy odwołaniach (klucze obce bez `ON UPDATE CASCADE`) błąd 1451, czyli 500, a bez odwołań (np. źródło po scaleniu) cicha podmiana klubu. Dziś dotyczy to już `account.save` („Kraków” obok „Krakow”). Naprawa w R5 i §4.3.
5. **Teksty turniejów** przechodzą tylko `Domain::txt` (bez `Text::clean`), więc znaki bidi trafiłyby na publiczną listę (§5.4).
6. **Rejestracja** [zweryfikowane, `Members::signup`, `Members::adminAction('create')`] zakłada `billing_accounts` z `billing_exempt=0` (Admin: chyba że zaznaczy „darmowe”). Przełączenie na płatne odcięłoby te konta (R3).
7. **Macierz przełączników** [zweryfikowane, `Config::validate`]: stan „Stripe skonfigurowane, rejestracja jeszcze bezpłatna” (D1) jest dziś odrzucany (§3.3).
8. **Konfiguracja w trasach** [zweryfikowane]: przełączniki czyta wiele miejsc z surowego `$config`: `routes/core.php` (`me`, `public-config`), `Billing::summary` i `Billing::state` (linia 49–51, `billing-confirm`, `billing-sync`), `Members::signupOpen`, `jobs/accounts.php`, `index.php` (`command`). Lista miejsc do ręcznej zamiany byłaby od razu niepełna, dlatego nakładka jest centralna (§3.2).
9. **Sprzątanie porzuconych kont** [zweryfikowane, `jobs/accounts.php`] nie sprawdza `profiles.created_by` ani `tournaments.created_by`; usunięcie `users` organizatora albo zawodnika skończyłoby się błędem 1451 (§6.6).
10. **Sesje** [zweryfikowane, `Auth::enter`]: członek dostaje 14 dni bezczynności i 30 dni maksimum z trwałym ciasteczkiem; personel 30 minut i 12 godzin z ciasteczkiem sesyjnym (R17).
11. **Lista gościa** [zweryfikowane, `GuestView.php`]: `LIMIT=6` najbliższych turniejów; publiczne są statusy `open`, `closed` i `finished` z datą ≥ dziś. Kilka kont mogłoby wypchnąć turnieje właściciela ze strony głównej (§5.6). Testy sprawdzają dokładne zbiory kluczy podsumowania turnieju i miejsca w drabince (`http.test.mjs:62,69`, `php.test.mjs:46-53`, `workspace.test.mjs:69-87`), więc nowe pola są **rzadkie** (tylko w turniejach społeczności).
12. **Czat** [zweryfikowane, `Chat.php:44,221-232,266-270`; `chat.js:580`]: lobby pokazuje do `UPCOMING=100` nadchodzących turniejów i leniwie zakłada dla każdego kanał; flaga `o` (twórca turnieju) jest wyświetlana jako plakietka „Organizator”.
13. **Losowanie rozdziela po nazwie klubu** [zweryfikowane]: `Rules::makeDraw` (koszt `club===club`), `engine.js` `makeDraw` i `clubConflicts`; `signature()` zawiera `id:club:champion`, więc **zmiana nazwy klubu w migawce unieważnia losowanie** (§6.3).
14. **Slug klubu** [zweryfikowane, `Profiles::slug`]: zostawia tylko `[a-z0-9]`, więc nazwy cyrylicą, greką czy koreańskim dają pusty slug (§6.3).
15. **Skrypty CLI** [zweryfikowane]: `bin/seed-athletes.php:62` i `bin/install.php:19` wstawiają kluby jako `['id','name']`; `seed-athletes --remove` usuwa zgłoszenia i profile po `club_id` klubów demo, chroniąc tylko kluby z kontami personelu (§6.3, §14).
16. **Frontend** [zweryfikowane]:
    - `app.js` traktuje `role==='member'` jako „bez workspace” (menu, `#screen`, przekierowania); `#screen` odpytuje `bootstrap` co 15 s (`app.js:528`);
    - `registry.defaultPage(role)` wysyła członka do czatu; po rejestracji `account-flow.js:448` zawsze przechodzi do czatu;
    - `tournamentForm` domyślnie tworzy turniej `draft` z opisem tylko dla klubów (`app.js:204`); nie ma „kopiuj link”;
    - `checkModal` zmienia tylko obecność i wagę (`app.js:153`);
    - `client.js` czyta zapisane demo bez aktualizacji (`client.js:13`);
    - `tests/i18n.test.mjs` wymaga tłumaczenia każdego komunikatu serwera i sprawdza **dokładną** listę słowników (linia 70) oraz `NOT_UI`; `tests/xss-scan.test.mjs` ma jawny zakres modułów.

---

## 3. Tryby rejestracji w bazie i panel Admina

### 3.1 Model (`app_settings`, migracja 0008, klasa `backend/src/Settings.php`)
Jeden wiersz `app_settings(id=1, version, data, updated_at, updated_by)`, wzorowany na `ChatSettings`:
- `get()` scala `data` z wartościami domyślnymi;
- `normalize()` zastępuje każdą błędną wartość domyślną;
- zapis z kontrolą `version` zwraca 409 przy nieaktualnej wersji;
- nieznane klucze przyszłej wersji zostają w JSON.

| Pole `data` | Wartości | Domyślnie (brak wiersza albo pola) |
|---|---|---|
| `signup` | `off` \| `on` | `on`, gdy `config.signup_enabled`, inaczej `off` |
| `payments` | `free` \| `paid` | `paid`, gdy `config.billing_enforce`, inaczej `free` |
| `organizers` | `on` \| `paused` | `on` |
| `supportEmail` | e-mail (≤ 254, `FILTER_VALIDATE_EMAIL`, małe litery) | `config.support_email` ?: `hello@matbravo.com` (D4) |
| `stripeCheck` | `{at, ok, mode, prices:{pln,usd}, error}` (tylko kody) | `null` |

**Tryb dla właściciela:** `off` gdy `signup=off`; `free` gdy `signup=on,payments=free`; `paid` gdy `signup=on,payments=paid`. Przy „Wyłączona” panel pokazuje dodatkowo przełącznik „Płatności istniejących kont”.

Migracja 0008 **nie wstawia wiersza**: dopóki Admin nic nie zapisze, obowiązuje `config.php`. Na produkcji daje to `signup_enabled=false` i brak płatności.

### 3.2 Obowiązująca konfiguracja: jedno miejsce nakładki
`Settings::effective(PDO $pdo, array $c): array` to czysta funkcja nad wierszem (jedno zapytanie po kluczu głównym, pamięć podręczna na żądanie po `spl_object_id($pdo)`). Jest **idempotentna** (`effective(effective(c)) = effective(c)`), więc podwójne wywołanie niczego nie psuje.
```
$s = normalize(row ?? [])  scalone z domyślnymi z tabeli §3.1 (z $c)
$eff = $c
$eff['signup_enabled'] = $s['signup']==='on' && empty($c['signup_force_off'])
$eff['billing_enforce'] = $s['payments']==='paid'
if ($eff['billing_enforce'] && empty($c['billing_enabled'])) {          // Stripe zniknęło z config.php
   $eff['billing_enforce']=false; $eff['signup_enabled']=false; $eff['settings_degraded']='billing-missing';
}
if (!empty($c['signup_force_off']) && $s['signup']==='on') $eff['settings_degraded']??='force-off';
$eff['signup_free_beta'] = !$eff['billing_enforce'];                      // zgodność wstecz
$eff['support_email'] = $s['supportEmail']
$eff['organizers'] = $s['organizers']
$eff['signup_mode'] = !$eff['signup_enabled'] ? 'off' : ($eff['billing_enforce'] ? 'paid' : 'free')
```
- **Brak tabeli** (SQLSTATE 42S02) zwraca wartości wyliczone z samego `$c` (te same klucze pochodne), a nie 503.
- **Zaślepka z fali 1** (`data-domain`) ma ten sam podpis i te same klucze pochodne, liczone wyłącznie z `$c` (bez bazy). Fala 2 (`settings-backend`) podmienia ją na pełną implementację.
- **Gdzie nakładka jest liczona (jedyne miejsca):**
  - `Routes::dispatch`: przed utworzeniem `RouteContext` dla tras w trybie `session`, `upload`, `peek` z ciasteczkiem sesji oraz tras z flagą `'settings'=>true` (`public-config`). Połączenie z bazą otwiera się wtedy raz i przechodzi do `RouteContext` (nowy parametr konstruktora `?PDO $pdo`). `RouteContext::$config` zawiera **obowiązującą** konfigurację; surowy plik jest w nowym polu `RouteContext::$file` (tylko dla `diagnostics`, który pokazuje źródło wartości). Trasy gościa bez ciasteczka (`public-chat*`, `public-clubs`, `chat-feed` gościa) nie otwierają przez to dodatkowego połączenia.
  - `index.php`: `$config=Settings::effective($pdo,$config)` zaraz po otwarciu połączenia (trasy `bootstrap`, `command`, `login`, `session`).
  - Zadania (`jobs/*.php`) wołają `Settings::effective($pdo,$c)` na początku `run`, bo `bin/cron.php` podaje surowy plik.
- Dzięki temu `Billing::state`, `Billing::summary`, `Billing::checkout` (odmowa 409 `Płatności nie są teraz wymagane.`, gdy `billing_enforce=false`), `Chat::viewer`, `me`, `public-config`, `Members::signupOpen` i trasy `athlete-*` czytają te same klucze co dziś, bez zmian w ich kodzie.
- **Test strażnik** (`tests/settings.test.mjs`): przeszukuje `backend/` i zgłasza każde odczytanie `['billing_enforce']`, `['signup_enabled']`, `['support_email']` albo `['organizers']` poza `Settings.php`, `Access.php`, `Config.php` i zadaniami, które najpierw wołają `effective` (zapisy w rodzaju `['billing_enforce'=>true]+$c` są dozwolone). Drugi test HTTP: po zapisaniu „Płatna” w bazie przy `billing_enforce=false` w pliku `billing-sync`, `me` i `command` zgadzają się co do dostępu.
- Koszt: +1 zapytanie po kluczu w żądaniach z sesją.

### 3.3 Macierz przełączników **[zmienia PLAN-CZAT §6.10 i §6.8]**
`Config::validate()` dalej sprawdza **plik** `config.php` według dotychczasowych reguł. Obowiązującą kombinację z bazą ustala `Settings::effective()`, a dozwolone przejścia sprawdza `Settings::save()`:

| `signup` | `payments` | `billing_enabled` (config) | Dozwolone? | Gość widzi | Krok „Plan” w rejestracji |
|---|---|---|---|---|---|
| off | free | dowolnie | tak (stan po wdrożeniu) | „Zaloguj się, aby pisać”; brak karty „Nowe konto” | — |
| off | paid | true | tak (okno testów z tokenem albo pauza rejestracji) | jak wyżej | tak (tylko token) |
| on | free | false | tak (**D1: przed Stripe**) | „Załóż konto” bez ceny | pominięty |
| on | free | true | **tak (nowe: Stripe gotowe, Admin jeszcze nie przełączył)** | „Załóż konto” bez ceny | pominięty |
| on | paid | true | tak, gdy kontrola Stripe przeszła przy przełączeniu (§3.4) | „Załóż konto · 8,99 zł / mies.” | tak |
| * | paid | false | nie: `effective` przechodzi w `off`+`free`, `settings_degraded='billing-missing'` | „Zaloguj się, aby pisać” | — |

- **Token zaproszeń** (`signup_invite_token`) zostaje wyłącznie w `config.php`. `Members::signupOpen()` przyjmuje go tylko wtedy, gdy rejestracja jest wyłączona, a `effective.billing_enforce=true`, i nigdy przy `signup_force_off` (`effective` usuwa wtedy token, §18 B6).
- **Nowy klucz config** `signup_force_off` (domyślnie `false`): awaryjny sufit (SSH).
- `signup_free_beta` zostaje w `Config::DEFAULTS` dla zgodności i jest wyprowadzany w `effective`. `support_email` z config jest tylko wartością startową.

### 3.4 Przełączenie na „Płatna”: gotowość Stripe i decyzja o kontach
`admin-settings-save {payments:'paid', …}` (POST, `session`, `admin`) wykonuje kolejno:
1. Kontrola wersji (409).
2. `config.billing_enabled` musi być `true`; inaczej 409 `{code:'stripe_not_ready'}` `Płatności nie są skonfigurowane. Najpierw skonfiguruj Stripe (DEPLOY-PL.md).`.
3. `$ctx->releaseSession()`, potem **kontrola Stripe poza transakcją**: `StripeClient::interactive($c)` i `Billing::resolvePrice($pdo,$c,$client,$cur,true)` dla każdej waluty z `stripe_prices`. Wynik trafia do `stripeCheck`. Błąd Stripe daje 503 (`Billing::guard`), brak ceny 409 `stripe_not_ready`.
4. `billing_mode==='test'` bez `confirmTestMode:true` daje 409 `{code:'test_mode'}` `Stripe działa w trybie testowym: nikt nie zapłaci prawdziwymi pieniędzmi. Potwierdź, jeśli to zamierzone.`.
5. **Zbiór decyzji** (`Billing::freePeriodSet($pdo,$c,$now)`, ten sam wzorzec co `Members::adminList`): jedno zapytanie po żywych kontach członków (`role='member'`, `deleted_at IS NULL`, `active=1`) z ich wierszem `billing_accounts`, a w PHP:
   - grupa **A** „konta z okresu bezpłatnego”: `billing_exempt=1`, `exempt_reason='free-signup'`, zwolnienie trwa;
   - grupa **B** „konta, które straciłyby dostęp od razu”: `Access::compute($row,['role'=>'member'],['billing_enforce'=>true]+$c,$now)['full']===false` (konta Admina bez „darmowe”, konta sprzed wydania, konta z wygasłym okresem bezpłatnym i po karencji).

   Gdy `|A ∪ B| > 0`, a w żądaniu nie ma `freePeriod`, odpowiedź to 409 `{code:'free_period_decision', counts:{a, b}}` `Zdecyduj, co z kontami założonymi w okresie bezpłatnym.`. Okno pokazuje obie liczby z opisem grup.
   - `freePeriod:{action:'keep'}`: konta grupy A bez zmian; konta grupy B dostają `billing_exempt=1, exempt_reason='free-signup', exempt_by=Admin, exempt_at=now, exempt_until=NULL`.
   - `freePeriod:{action:'requireFrom',date:'YYYY-MM-DD'}`: konta obu grup dostają `billing_exempt=1, exempt_reason='free-signup', exempt_until=koniec dnia daty` (co najmniej 14 dni od dziś, `Billing::grandfatheredMin`); dalej baner `soon`, karencja `grace` 7 dni i wpis `billing_audit`. Realizuje to `Billing::adminAction(['action'=>'requireFrom','scope'=>'free-signup',…])` rozszerzone o konta grupy B.
6. Zapis wiersza (`payments='paid'`, `version+1`) i `account_audit` (`actor`=Admin, `action='settings.save'`, `note='signup=on payments=paid keep|requireFrom:YYYY-MM-DD a=N b=M'`).

**Znacznik `free-signup` przy zakładaniu konta.** `Members::signup()` i `Members::adminAction('create')` bez pola „darmowe” zapisują `billing_exempt=1, exempt_reason='free-signup', exempt_at=now`, gdy `effective.billing_enforce=false`. Przy `true` zapisują `billing_exempt=0`, jak dziś. **Akcja zbiorcza** w panelu Ustawienia („Konta z okresu bezpłatnego: N · Wymagaj płatności od…”) korzysta z tej samej ścieżki.

**Przejście „Płatna” → „Bezpłatna”** jest zawsze dozwolone. Trwające subskrypcje dalej się odnawiają; panel ostrzega: „Osoby z aktywną subskrypcją dalej płacą. Zatrzymaj subskrypcje w panelu Członkowie albo w Stripe, jeśli tak zdecydujesz.”.

### 3.5 Panel „Ustawienia” (nowa strona Admina `#settings`)
Sekcje:
1. **Rejestracja nowych kont.** Trzy przyciski wyboru: Wyłączona / Otwarta, bezpłatna / Otwarta, płatna. Przy „Wyłączona” dodatkowy przełącznik „Płatności istniejących kont”. Opcja „Płatna” jest wyłączona z opisem przyczyny, gdy `stripe.enabled=false`. Po wybraniu „Płatna” pojawia się okno decyzji (§3.4 pkt 5) oraz, w trybie testowym Stripe, potwierdzenie.
2. **Stripe.** Stan (`włączone w config`, tryb test/live, ostatnia kontrola) i przycisk **„Sprawdź Stripe”** (`admin-stripe-check`, 6 na godzinę). `settings_degraded` jest czerwonym banerem z instrukcją.
3. **Adres pomocy.** Pole e-mail (domyślnie `hello@matbravo.com`) z podpowiedzią „Ten adres widzi każdy w „Nie pamiętasz hasła?”. Upewnij się, że skrzynka istnieje i ją czytasz.”.
4. **Konta z okresu bezpłatnego.** Liczby grup A i B, liczba z ustaloną datą płatności i akcja zbiorcza.
5. **Organizatorzy.** Przełącznik **„Publikowanie turniejów przez nowych organizatorów: włączone / wstrzymane”** (`organizers`; wstrzymanie nie dotyczy potwierdzonych organizatorów i już opublikowanych turniejów, §5.4), liczba „Do potwierdzenia: N” z linkiem do filtra w „Członkowie”, limity tylko do odczytu.
6. **Historia zmian.** Ostatnie 50 wpisów `account_audit` o akcjach `settings.*`, `organizer.*`, `tournament.hide`, `club.*`, `profile.forget`: data, kto (nazwa wyświetlana Admina), co, notatka. Zmiana adresu pomocy zapisuje w notatce starą i nową wartość (adres organizacyjny, nie dane osobowe; każdy skrócony do 90 znaków, bo `note` ma 200).

### 3.6 Adres pomocy (D4)
`public-config.support` zwraca `effective.support_email`, więc zawsze jest ustawiony. Kontrolę z PLAN-CZAT §3.10 przenosimy do `Settings::save()`: pusty adres daje 422 `Podaj poprawny e-mail.`. **Właściciel musi założyć skrzynkę** (§13).

### 3.7 Ochrona przed nadużyciami przy publicznej, bezpłatnej rejestracji
Istniejące zabezpieczenia zostają bez zmian: `signup-begin` (60/h na IP), pułapka `website` i czas wypełnienia 3 s–2 h, limity IP (/64) 30/h i 100/dobę, globalny hamulec 200 kont/h (liczy założone konta, nie próby), `username-check`.

Dochodzą nowe limity:

| Limit | Wartość | Gdzie | Komunikat (429) |
|---|---|---|---|
| Duplikat e-maila w rejestracji na IP /64 | 5 na godzinę; po przekroczeniu **każda** rejestracja z tej sieci dostaje 429 na godzinę (bez względu na wynik) | `Members::signup`, `RateLimit 'signup-dup-ip'` | `Zbyt wiele prób zakładania konta. Spróbuj ponownie później.` (istnieje) |
| Włączenie roli organizatora (rejestracja i `roles`) na IP /64 | 3 na dobę | `RateLimit 'organizer-enable-ip-day'` | `Zbyt wiele nowych kont organizatorów z tej sieci. Spróbuj ponownie jutro.` |
| `roles` na konto | 10/h | `RateLimit 'roles'` | `Zbyt wiele zmian ról. Spróbuj ponownie później.` |
| Komendy workspace członka-organizatora | 60/min i 1200/h na konto | `index.php` przed transakcją | `Zbyt wiele operacji. Spróbuj ponownie za chwilę.` |
| **Wszystkie transakcje workspace członków razem** (komendy organizatorów, `athlete-entry`, `-save`, `-archive`) | 120 **zapisanych** na minutę globalnie (sprawdzane przed blokadą, liczone po zatwierdzeniu: odrzucone komendy nie zużywają kubełka) i 30 transakcji na minutę na konto; personel nie jest liczony; wycofanie zgłoszenia i usunięcie danych (`entry.remove`, `profile.forget`, `athlete-withdraw`, `athlete-forget`) nigdy nie czeka (R12) | `MemberTx` (`RateLimit 'member-tx','all'` i `'member-tx-account'`) w `index.php` i trasach `athlete-*` (§18 B2) | `Serwer jest teraz mocno obciążony. Spróbuj ponownie za chwilę.` / `Zbyt wiele operacji. Spróbuj ponownie za chwilę.` (z `Retry-After`) |
| `bootstrap` członka-organizatora | 1500/h **na sesję**; odpowiedzi `unchanged` (§8.1) nie są liczone | `index.php` | `Zbyt wiele operacji. Spróbuj ponownie za chwilę.` |
| `organizer-unlock` | limity logowania (`Auth::reserveLogin`) | trasa | istniejący komunikat logowania |
| Nowe turnieje organizatora | 3 na dobę (także robocze); 10 opublikowanych nadchodzących | `Domain` (pod blokadą) | `Limit nowych turniejów: 3 na dobę.` / `Masz już 10 opublikowanych nadchodzących turniejów. Przełącz któryś na roboczy albo poczekaj, aż się odbędzie.` |
| Nowe turnieje niepotwierdzonych organizatorów razem | 50 na dobę globalnie | `Domain` (pod blokadą) | `Dziś powstało już bardzo dużo nowych turniejów. Spróbuj ponownie jutro albo napisz do nas.` |
| Profile dodane przez organizatora | 300 na dobę | `Domain` (`createdAt`) | `Limit nowych zawodników na dziś został osiągnięty.` |
| Nowe (niezweryfikowane) kluby | 3 na dobę na konto, 30 na dobę globalnie; **bez twardego błędu**: po przekroczeniu wybór zapisujemy jako „Niezrzeszony” z `pendingClubName` (§6.3) | `Clubs::pick` | — (komunikat informacyjny w odpowiedzi) |
| `athlete-entry` i `athlete-withdraw` | 30/h na konto | trasa | `Zbyt wiele zmian zgłoszeń. Spróbuj ponownie później.` |
| `athlete-save`, `athlete-archive` | 20/h na konto | trasa | `Zbyt wiele zmian danych zawodnika. Spróbuj ponownie później.` |
| `athlete-forget` | 5/h na konto | trasa | `Zbyt wiele prób. Spróbuj ponownie później.` (istnieje) |
| `admin-stripe-check` | 6/h | trasa | jak wyżej |

**Wyliczanie e-maili (świadome ryzyko).** Odpowiedź na zajęty e-mail (409 `Nie można założyć konta z tym adresem e-mail…`) różni się od sukcesu, więc rejestracja zdradza, czy adres ma konto. Pełne ukrycie wymaga potwierdzenia e-mailem (brak SMTP). Ograniczamy to limitem duplikatów na sieć; ryzyko jest wpisane w §11 i B11.

**Wyłączniki awaryjne:** „Wyłączona” (rejestracja) i „Publikowanie… wstrzymane” (organizatorzy) w panelu działają natychmiast. Gdy panel jest nieosiągalny: `signup_force_off=true` w `config.php` przez SSH. CAPTCHA i usługi zewnętrzne odrzucamy (CSP `'self'`, prywatność).

---

## 4. Model ról: konto członka z uprawnieniami

### 4.1 Decyzja
| Model | Za | Przeciw |
|---|---|---|
| Nowe wartości `users.role` (`organizer`, `athlete`) | proste sprawdzenia ról | jedna rola na konto; zmiana ENUM, `Access`, `Members` (`role='member'` w kilkunastu zapytaniach), czatu, rejestru stron, `persistUser` |
| Organizator jako konto personelu (`editor`) zakładane automatycznie | gotowy UI | globalna widoczność edytora (sprzeczne z D2+), wyprowadza osobę z czatu i płatności członków |
| **Rola `member` plus uprawnienia (wybrane)** | role personelu, czat i płatności bez zmian, obie role naraz | `Domain` i `app.js` muszą rozumieć „członka-organizatora” |

### 4.2 Dane
- `users.organizer TINYINT(1) NOT NULL DEFAULT 0`: osoba sama włącza albo wyłącza rolę.
- `users.organizer_blocked_at BIGINT NULL`: Admin odebrał uprawnienie; osoba nie może go sama przywrócić.
- `users.organizer_trusted_at BIGINT NULL`, `users.organizer_trusted_by VARCHAR(40) NULL`: Admin potwierdził organizatora (R16).
- **Uprawnienie organizatora** = `role='member' AND organizer=1 AND organizer_blocked_at IS NULL`.
- `profiles.owner_user_id VARCHAR(40) NULL` z **nieunikalnym** indeksem `profiles_owner (owner_user_id)`, bez klucza obcego. Limit liczby profili i „najwyżej jeden `self`” sprawdza `Domain` pod blokadą (R7). **Uprawnienie zawodnika** = istnieje profil z `owner_user_id=id` i `archived=0`.
- Personel (`admin`/`editor`/`club`) nie dostaje uprawnień członka w v1; `athlete-*` są tylko dla `member`.

### 4.3 Aktor w workspace (`backend/src/Actors.php`, `Repository`)
- `Actors::of(PDO $pdo, array $u): array`: dwa zapytania po kluczu (`users` po `id`; `SELECT id,archived,data FROM profiles WHERE owner_user_id=?`). Zwraca konto w kształcie workspace (`Accounts::fromRow`) z polami `organizer`, `organizerBlockedAt`, `organizerTrustedAt`, `athletes:[{id,archived,relation}]`, `caps:{organizer:bool, organizerBlocked:bool, organizerTrusted:bool, athlete:bool}`.
- `Repository::transaction(callable $fn, ?array $actor=null)`:
  - gdy `$actor` to `member`, dodaje go do `$next['users']` przed `$fn`, a po `$fn` usuwa;
  - `rows()` **zawsze pomija `role==='member'`** (obrona w głąb);
  - `$db['organizers']` (tylko odczyt, nigdy zapisywane): `{userId: {trusted:bool}}` dla twórców-członków turniejów, z jednego zapytania `SELECT id,organizer_trusted_at FROM users WHERE role='member' AND id IN (SELECT created_by FROM tournaments)`. W JS ten sam stan daje `db.users` (konta członków są w demo).
  - `$db['flags']` (tylko odczyt): `{organizers:'on'|'paused'}` wstawia wywołujący z `effective`.
- `Repository::persist()` **[zmiana zachowania, R5]**:
  - wiersze o kluczu nieobecnym w `$before` są wstawiane zwykłym `INSERT`; zmienione wiersze istniejące są aktualizowane `UPDATE … SET … WHERE <klucz główny>` (dotyczy `clubs`, `profiles`, `tournaments`, `entries`, `draws`; `users` dalej przez `persistUser`);
  - błąd 1062 z tych instrukcji: na `clubs` → `AppError('Klub o podobnej nazwie już istnieje. Wybierz go z listy.',409)`; inne → `AppError('Dane zmieniły się w innej sesji. Odśwież widok i ponów zapis.',409)` (bez treści PDO w logu);
  - po usunięciu losowań i zgłoszeń usuwa **profile nieobecne w `$after`**: `DELETE FROM profiles WHERE id=? AND NOT EXISTS (SELECT 1 FROM entries WHERE profile_id=?)`; `rowCount()===0` rzuca `RuntimeException` (wycofanie całej transakcji, nic nie „znika na niby”); usuwa też wiersze `entry_withdrawals` tego profilu;
  - zapisuje znaczniki rewizji (`tournaments.rev`, `profiles.rev`, `app_meta.staff_rev`, §5.8) i nowe wpisy `$db['withdrawals']` (`INSERT … ON DUPLICATE KEY UPDATE` po kluczu naturalnym tabeli `entry_withdrawals`); wstawienie zgłoszenia `(t,p)` kasuje nagrobek `(p,t)`.
- `rows()` uzupełnia brakujące klucze klubów (`verified ?? true`, `createdBy/createdAt/mergedInto ?? null`), turniejów (`selfEntry ?? false`, `rev ?? 0`, …) i profili (`ownerId ?? null`, `rev ?? 0`), więc `bin/install.php` działa bez zmian (CI uruchamia go w każdym przebiegu HTTP).
- `Repository::organizerSnapshot(string $userId, string $today): array` (odczyt dla `bootstrap` organizatora, B2): personel z `users`, wszystkie kluby, turnieje `WHERE created_by=?` z wszystkimi zgłoszeniami i losowaniami, turnieje cudze `status='open' AND self_entry=1 AND hidden_by IS NULL AND event_date>=?` personelu albo potwierdzonych organizatorów oraz cudze turnieje z jego zgłoszeniami — w obu przypadkach **tylko zgłoszenia jego profili**, bez losowań; profile `WHERE created_by=? OR owner_user_id=?`; `organizers` i `revision`. Test: `publicData(organizerSnapshot)` jest identyczne z `publicData(load())` dla tego organizatora na bogatym zestawie danych. Dane innych dzieci nie trafiają nawet do pamięci żądania organizatora.
- `Repository::guestTournaments()` dołącza `LEFT JOIN users` twórcy (pola `community`, `trusted`) i dla zgłoszeń `JOIN clubs` (bieżąca nazwa, `verified`, cel scalenia), §5.6.
- `Domain::publicData()` w liście `users` dla Admina zwraca **tylko personel** (także w JS).
- **Komenda `account.password` jest zabroniona dla członków** w trasie `command` (członek ma `member-password`).

### 4.4 Wpływ na istniejące części

| Część | Zmiana |
|---|---|
| `Repository::load` | nowe kolumny: `profiles.owner_user_id, rev`→`ownerId, rev`; `clubs.verified, created_by, created_at, merged_into`→`verified, createdBy, createdAt, mergedInto`; `tournaments.created_at, hidden_by, hidden_from, hide_reason, self_entry, rev`→`createdAt, hiddenBy, hiddenFrom, hideReason, selfEntry, rev`; `app_meta.staff_rev`→`staffRev`; `organizers` |
| `Repository::rows/persist` | §4.3 |
| `Domain::publicData` | macierz §5.2; organizator dostaje swój widok; członek bez roli organizatora dostaje pusty kształt z `user.caps` |
| `Access` | **bez zmian** |
| `index.php` `bootstrap` | `member` z uprawnieniem organizatora: wymaga ważnego potwierdzenia hasła (§4.6), potem `organizerSnapshot()` + `Domain::publicData($db, Actors::of(...))`; bez uprawnienia → `memberWorkspace` z `user.caps`; parametry `t`, `rev` (§8.1) |
| `index.php` `command` | `member`: uprawnienie organizatora, potwierdzenie hasła (§4.6), typ z `ORGANIZER_TYPES` (`tournament.save, profile.save, profile.archive, profile.forget, entry.save, entry.remove, checkin.save, draw.create, result.save, result.clear`), limity §3.7, 402 bez pełnego dostępu, transakcja z aktorem i `flags`. Pozostałe typy → 403 `Brak uprawnień.`. Po udanych `tournament.hide`, `club.*`, `profile.forget` (Admin) wpis `account_audit` |
| `me` | `user.caps`, `athletes:[{profileId,name,relation,archived}]`, `features.signupMode`, `features.selfEntry:true`; dla Admina `features.pendingOrganizers` (jedno `COUNT`) |
| `public-config` | `signup`, `signupMode`, `billing`, `support`, `roles:true` (wszystko z `effective`) |
| Czat | lobby pomija turnieje niepotwierdzonych organizatorów (poza własnymi); flaga `o:2` dla niepotwierdzonego organizatora (§5.6) |
| `Members` | lista z uprawnieniami, filtry, akcje `organizer`, `organizer-trust`, `organizer-bulk`, `hideTournaments` (§5.5) |
| `account-boot.bannerInfo` | baner „tylko podgląd” także dla organizatora i zawodnika („Zgłoszenia do turniejów wymagają aktywnego konta.”) |

### 4.5 Wybór ról przy rejestracji i zmiana później
- **Krok 1** (przed e-mailem): fieldset „Kim jesteś? (opcjonalnie, możesz to zmienić później)” z dwoma niezaznaczonymi polami:
  - „Zawodnik” z podpisem „Zgłaszasz do turniejów siebie albo swoje dziecko lub podopiecznego. Zapytamy o datę urodzenia, wagę i klub.”;
  - „Organizator turnieju” z podpisem „Tworzysz własne turnieje, dodajesz zawodników i prowadzisz kontrolę startową. Widzisz tylko swoje turnieje.”.

  Adres `#signup?as=athlete|organizer[&t=<tournamentId>]` zaznacza pole; `as` i `t` przechowujemy w `sessionStorage` obok znacznika przepływu (lądowanie po rejestracji, §10.1).
- **Kroki:** 1 Konto (+ role) → 2 Profil → **3 Zawodnik (tylko gdy zaznaczono)** → Plan (tylko przy „Płatna”). Konto powstaje przy wysłaniu ostatniego kroku z danymi. Etykieta „Krok n z total” liczy się z ról (przed kontem) i z `me.caps` (po przeładowaniu), nigdy na stałe.
- **`signup` (serwer):** body jak dziś plus `roles:{organizer:bool, athlete:bool}` i przy `athlete` obiekt `athlete:{…}` (§6.1). Przyjmujemy wyłącznie te dwa klucze boolowskie; każde inne pole jest ignorowane.
  - **Bez blokady workspace (R19).** Kolejność:
    1. dotychczasowe kontrole (otwarta rejestracja, limity, pułapka, czas), limit duplikatów (§3.7) i `organizer-enable-ip-day` przy `roles.organizer`;
    2. **pełna walidacja zawodnika przed jakąkolwiek transakcją**: `Domain::athleteFields($athlete,$today)` (czysta funkcja współdzielona z komendą `athlete.save`) i odczyt klubów `SELECT id,name,verified,merged_into FROM clubs` z wyborem przez `Clubs::pick` (czysta, wspólna z `Domain`), §6.3;
    3. jedna transakcja `Members::tx`: `users` (z `organizer`), `user_profiles`, `billing_accounts` (§3.4), ewentualnie nowy klub (zwykły `INSERT`; 1062 → ponowny odczyt i użycie istniejącego klubu) i wiersz `profiles` zbudowany wspólną funkcją `Repository::profileRow()` (ten sam kształt co `rows()`); kolizja `public_id` powtarza transakcję (do 3 razy), duplikat e-maila daje 409 jak dziś.
  - Profil bez zgłoszeń nie dotyka inwariantów kategorii ani losowań, a nikt inny nie może jeszcze edytować nowego konta, więc blokada nie jest potrzebna. Rewizja globalna się nie zmienia (znacznik nowego profilu = 0).
- **Później (profil → zakładka „Role”):**
  - „Organizator turnieju” wywołuje `roles {organizer}`. Wyłączenie przy turnieju `open` albo `closed` daje 409 `Masz turnieje z otwartymi lub zamkniętymi zapisami. Zakończ je albo przełącz na roboczy, zanim wyłączysz rolę organizatora.`; włączenie przy `organizer_blocked_at` daje 403 `Administrator wyłączył Ci rolę organizatora.`;
  - „Zawodnicy”: lista profili konta z przyciskami „Zmień dane”, „Dodaj zawodnika” (do limitu), „Archiwizuj” (`athlete-archive {profileId}`; 409 `Najpierw wycofaj zgłoszenia do turniejów, które jeszcze się nie odbyły.`) i „Usuń dane zawodnika” (`athlete-forget`, potwierdzenie hasłem, §6.6).
- Etykieta roli (`roleName`): „Organizator”, gdy `caps.organizer`; „Opiekun zawodnika”, gdy profile konta to wyłącznie `guardian`; „Zawodnik”, gdy jest profil `self`; inaczej „Członek”.

### 4.6 Sesja organizatora: potwierdzenie hasła dla narzędzi (R17)
- Sesja zawiera `ws:{at,last}`: `at` = chwila ostatniego podania hasła, `last` = ostatnie żądanie narzędzi. `Auth::enter` po logowaniu, rejestracji i zmianie hasła ustawia `ws.at=ws.last=now`.
- `bootstrap` i `command` członka-organizatora wymagają `now-ws.at ≤ session_max_seconds` (12 h) i `now-ws.last ≤ session_idle_seconds` (30 min); inaczej 401 `{code:'reauth'}` `Potwierdź hasło, aby otworzyć narzędzia organizatora.`. Udane żądanie odświeża `ws.last` (odpytywanie `#screen` co 15 s utrzymuje je do 12 h, jak u personelu).
- `organizer-unlock {password}` (POST `session`, `member`): `Auth::reserveLogin` na e-mailu konta, `password_verify`, `ws.at=ws.last=now`, nowy token CSRF.
- Czat, profil konta, „Moje starty” i trasy `athlete-*` nie wymagają potwierdzenia (własne dane).
- Klient (`app.js` `handleError`): 401 z `code:'reauth'` otwiera okno z polem hasła (`ui.modal`), po sukcesie ponawia żądanie raz.

---

## 5. Organizator turnieju: zakres uprawnień

### 5.1 Co organizator może

| Funkcja | Organizator (członek) | Uwagi |
|---|---|---|
| Tworzenie turnieju | tak (`tournament.save`), w limitach §3.7 | `createdBy`=on, `createdAt`=now, `selfEntry` domyślnie `true`, status domyślny w formularzu „Zapisy otwarte” (§10.4) |
| Edycja i status własnego turnieju | tak; „Zakończony” dopiero od dnia turnieju (`date ≤ dziś`); po ukryciu przez Admina tylko `draft` | `tournament.save` |
| Dodawanie zawodników do bazy | tak; profil należy do organizatora (`createdBy`), `ownerId=null`; poniżej 16 lat wymagane oświadczenie o zgodzie opiekuna (§5.3) | `profile.save` |
| Zgłaszanie do **własnych** turniejów | tak: własne profile i profile własnego konta (`ownerId=id`) | `entry.save` |
| Zgłaszanie do **cudzych** turniejów (O19) | tak, gdy turniej jest `open`, ma `selfEntry=true` i należy do personelu albo potwierdzonego organizatora; tylko własne profile; widzi tam wyłącznie własne zgłoszenia, bez drabinek i dziennika | `entry.save`, `entry.remove` |
| Kontrola startowa, waga, losowania, wyniki, wydruki, ekran hali `#screen` | tak, we własnych turniejach | `checkin.save`, `draw.create`, `result.*` |
| Poprawa zgłoszeń we własnym turnieju, wycofanie | tak, także zgłoszeń własnych zawodników (`self`); w zgłoszeniu własnym może zmienić **klub** (weryfikacja D3), ale nie imię, wiek i płeć | §5.7 `entry.save` |
| Edycja profilu z konta zawodnika | **nie** (tylko zawodnik i Admin) | |
| Usunięcie danych własnego zawodnika | tak (`profile.forget`), gdy profil nie ma zgłoszeń w turniejach zakończonych | §6.6 |
| Widok bazy zawodników | tylko własne profile | |
| Konta, role, kluby, ukrywanie | nie | Admin |

### 5.2 Macierz widoczności (Domain::publicData i lustro JS) **[zmienia zachowanie tylko dla danych społeczności]**
Pojęcia (liczone w `Domain`, identycznie w JS):
- `staff(db)`: zbiór id kont personelu w `$db['users']`;
- **profil personelu**: `ownerId===null` i `createdBy ∈ staff`;
- **turniej społeczności**: `createdBy ∉ staff`; **potwierdzony**: `trustedOrganizer(db, createdBy)` (PHP: `$db['organizers'][$id]['trusted']`; JS: `users.find(id)?.organizerTrustedAt != null`);
- **zgłoszenie własne**: `entry.self===true`.

| Dane | admin | editor | club | organizer (członek) | członek bez roli |
|---|---|---|---|---|---|
| Profile | wszystkie | **profile personelu** (dla istniejących danych bez zmian) | profile personelu swojego klubu | swoje (`createdBy=id`, `ownerId=null`) + profile własnego konta | — |
| Turnieje personelu | wszystkie | jak dziś (wszystkie poza roboczymi; pełne zgłoszenia, drabinki, dziennik) | jak dziś; zgłoszenia: swój klub **i profil personelu** | `open`+`selfEntry` albo z jego zgłoszeniami: tylko jego zgłoszenia, `draws=[]`, `activity=[]` | — |
| Turnieje społeczności | wszystkie | tylko **potwierdzone** i (`open` albo z jego zgłoszeniami); zgłoszenia tylko jego profili; `draws=[]`, `activity=[]` | tylko **potwierdzone**, pomijane jak dziś dla klubu; zgłoszenia: swój klub i profil personelu; `draws=[]`, `activity=[]` | **własne**: wszystkie statusy, pełne dane, **bez zgłoszeń własnych zawodników, gdy turniej ukrył Admin**; cudze: jak wiersz wyżej (tylko potwierdzone) | — |
| Kluby | wszystkie (z `verified`, `mergedInto`, `createdBy`) | zweryfikowane i niescalone + kluby z widocznych profili i zgłoszeń | tylko swój (jak dziś) | zweryfikowane i niescalone + `unaffiliated` + kluby jego profili i zgłoszeń w jego turniejach | — |
| Konta (`users`) | personel | [] | [] | [] | [] |

Pola w widoku:
- **turniej**: `community:bool`, `trusted:bool` (dla społeczności), `selfEntry`, `rev` dla wszystkich; `hidden:bool` i `hideReason` dla Admina i menedżera (Admin dostaje też `hiddenBy`, `hiddenFrom`); `createdAt` tylko dla menedżera;
- **profil**: `staff:bool`; `ownerId` tylko u Admina i właściciela; `relation`, `guardianDeclaredAt`, `guardianConsentAt` tylko u Admina, właściciela i twórcy;
- **zgłoszenie**: `self` dla wszystkich, którzy widzą zgłoszenie.

**Uzasadnienie dla przedstawiciela klubu:** nie widzi zgłoszeń własnych zawodników, którzy wybrali jego klub (O10). **Edytor w turniejach personelu nadal widzi wszystkie zgłoszenia** (O2), co mówi informacja o prywatności przy zgłoszeniu (§10.3).

### 5.3 Zawodnicy dodani przez organizatora
- Profil ma `createdBy`=organizator i `ownerId=null`: widzi go tylko organizator i Admin.
- Klub: z listy, nowy albo „Niezrzeszony” (`Clubs::pick`, §6.3).
- **Hak dla małoletnich:** `profile.save` przez członka-organizatora dla osoby z `ageAt(birthDate, dziś) < MINOR_SELF_AGE` (16) wymaga `guardianConsent:true` (pole „Mam zgodę rodzica lub opiekuna na podanie tych danych w celu zgłoszenia do turnieju.”). Brak daje 422 `Zaznacz, że masz zgodę rodzica lub opiekuna na podanie danych zawodnika.`. Zapis: `guardianConsentAt=now`, `consentBy=u.id` w danych profilu; formularz ma pusty slot zgody (`data-acct-consents`) dla sesji prawnej. Ta sama walidacja w `workspace.js` i w teście zgodności. Personel bez zmian (decyzja sesji prawnej).
- Dziecko, które później założy własne konto, ma osobny profil; przejęcie profilu nie wchodzi do v1 (O13).
- Usuwanie i retencja: §6.6–§6.7.

### 5.4 Limity, status i treść
- Stałe w `Domain` i `workspace.js` (te same wartości; O5): `ORGANIZER_DAY=3`, `ORGANIZER_ACTIVE=10`, `COMMUNITY_DAY_GLOBAL=50`, `ORGANIZER_PROFILES_DAY=300`, `CLUBS_DAY_PER_USER=3`, `CLUBS_DAY_GLOBAL=30`, `MINOR_SELF_AGE=16`, `ADULT_AGE=18`, `ATHLETES_PER_ACCOUNT=5`, `RETENTION_MONTHS=24`. Liczone na wczytanym `$db` pod globalną blokadą. Status 429 bez `Retry-After`; przy limicie dobowym `{retry}` w danych.
- **`ORGANIZER_ACTIVE`** liczy turnieje organizatora **opublikowane** (status ≠ `draft`), **nadchodzące** (`date ≥ dziś`) i **nieukryte**, w każdym statusie (także `finished`). Sprawdzany przy zapisie turnieju, który po zapisie ma status ≠ `draft`. Robocze nie liczą się wcale, więc organizator zwalnia miejsce, przełączając pusty lub testowy turniej na roboczy.
- **`ORGANIZER_DAY`** liczy wszystkie turnieje utworzone przez organizatora w ostatnich 24 h (także robocze).
- **`COMMUNITY_DAY_GLOBAL`** liczy turnieje niepotwierdzonych organizatorów utworzone w ostatnich 24 h; potwierdzeni są zwolnieni.
- **Status „Zakończony”** organizator może ustawić tylko, gdy `date ≤ dziś`: 422 `Turniej można zakończyć najwcześniej w dniu zawodów.`. Zamyka obejście limitu i „wieczne” turnieje na stronie głównej.
- **Wstrzymanie publikacji** (`flags.organizers==='paused'`): niepotwierdzony organizator nie może nadać statusu ≠ `draft` turniejowi nowemu ani roboczemu (409 `Publikowanie nowych turniejów społeczności jest chwilowo wstrzymane przez Administratora.`); edycja już opublikowanych działa.
- **Treść:** `tournament.save` (wszyscy): `name`, `city`, `mat` przechodzą `Text::clean` (JS `cleanText`) przed `Domain::txt`. Dla członków dodatkowo `Domain::CONTACT` (to samo wyrażenie w JS) odrzuca adresy stron, e-maile i długie numery w nazwie, mieście, macie i w nazwie nowego klubu: 422 `Nazwa nie może zawierać adresu strony, e-maila ani długiego numeru.`. Wyrażenie: `(?:https?://|www\.|@|\b[\p{L}\d-]+\.(?:pl|com|eu|net|org|info|io|me|app|link|ly|gg|online|site|shop|xyz)\b|\d(?:[\s./-]?\d){8,})` z flagami `iu` (9 i więcej cyfr: telefony i konta bankowe; daty „12.11.2026” mają 8 cyfr i przechodzą). Przypadki testowe (dozwolone i odrzucane) są wspólne dla PHP i JS.
- Porównania czasu: `time()` (JS `Date.now()`), daty `date('Y-m-d')` (Europe/Warsaw).

### 5.5 Narzędzia Admina
| Narzędzie | Gdzie | Mechanizm |
|---|---|---|
| **Potwierdź organizatora / cofnij potwierdzenie** (R16) | `#members` (filtr „Do potwierdzenia” z licznikiem), szczegóły członka, karta turnieju społeczności | `admin-member {action:'organizer-trust', userId, trusted:bool}`: `organizer_trusted_at=now\|NULL`, `organizer_trusted_by`, `account_audit` (`organizer.trust`/`organizer.untrust`) |
| **Ukryj / przywróć turniej** | karta turnieju (`#tournaments`, przycisk Admina) i szczegóły członka | `tournament.hide {tournamentId, hidden, reason?, withdrawSelf?}`: przy ukryciu `hiddenFrom=status`, `status='draft'`, `hiddenBy=adminId`, `hideReason` (≤ 200 znaków, `Text::clean`), dziennik „Administrator ukrył turniej.”. Organizator widzi baner „Turniej ukrył Administrator: {powód}. Napisz na {support}.” i nie może zmienić statusu (409 `Turniej ukrył Administrator. Status może zmienić tylko Administrator.`). **Organizator traci podgląd zgłoszeń własnych zawodników** w ukrytym turnieju (także w wydrukach). `withdrawSelf:true` usuwa zgłoszenia własne (reguła §6.6, nagrobek `admin`). Przywrócenie czyści `hiddenBy`/`hideReason` i przywraca `status=hiddenFrom` (także `finished`). Ukryty turniej nie liczy się do `ORGANIZER_ACTIVE` |
| **Odbierz / przywróć rolę organizatora** | `#members` | `admin-member {action:'organizer', userId, blocked:bool, hideTournaments?:bool}`: `organizer_blocked_at=now\|NULL`, `account_audit`; przy `hideTournaments` druga transakcja z `tournament.hide` (z `withdrawSelf`) dla wszystkich nadchodzących turniejów tej osoby |
| **Akcja zbiorcza** | `#members`, zaznaczone wiersze (do 50) | `admin-member {action:'organizer-bulk', userIds:[…], block:true, hideTournaments:true, deactivate?:bool}`: dla każdego jak wyżej, w osobnych transakcjach; wynik `{done:[…], failed:[{id,error}]}` |
| **Zablokuj konto** | `#members` (istniejące `active`) | jak dziś (`auth_version+1`); pole `hideTournaments` jak wyżej |
| **Kluby** | strona Admina `#clubs` | `club.save {id, name?, verified?}` (nazwa sprawdzana kluczem `Clubs::key` → 409 `Klub o takiej nazwie już istnieje. Użyj scalania.`); `club.merge {id, into}` (przepina `profiles.clubId` i `users.clubId` personelu, z `authVersion+1`; źródło dostaje `mergedInto`; `unaffiliated` nie może być źródłem). **Migawki zgłoszeń się nie zmieniają** (zmiana nazwy w migawce unieważniłaby losowania, §2.13): widoki publiczne i `AthleteView` pokazują bieżącą nazwę i stan weryfikacji przez złączenie z `clubs` (§5.6). Lista „Oczekujące nazwy klubów” (`pendingClubName` z §6.3) z akcją „Utwórz klub i przypisz” (`club.adopt {name, profileIds}`) |
| **Organizator turnieju** | karta turnieju społeczności: „Pokaż organizatora” | `admin-members {ownerOf:<tournamentId>}` |

### 5.6 Co widzą goście
- `GuestView` dla turnieju społeczności dodaje **rzadkie** pola `community:true` i `trusted:bool` (turnieje personelu mają dokładnie 5 kluczy jak dziś). Interfejs pokazuje plakietkę „Turniej społeczności · organizator niepotwierdzony przez MatBravo” albo „Turniej społeczności · organizator potwierdzony przez MatBravo”.
- **Strona główna (`GuestView::upcoming`) i lobby czatu** pokazują turnieje personelu i potwierdzonych organizatorów. Turnieje niepotwierdzonych są publiczne pod własnym adresem (`#guest?t=`), na liście „Otwarte turnieje” zawodnika (z plakietką) i dla ich organizatora w lobby czatu. **[zmienia O4]**
- **Kluby w drabinkach:** miejsce w drabince ma nadal dokładnie dwa klucze `{initials, club}`; `club` to bieżąca nazwa zweryfikowanego klubu (po scaleniu: celu), `null` dla niezweryfikowanego (interfejs: „Klub niezweryfikowany”) i `''` dla `unaffiliated` (interfejs: „Niezrzeszony”/„Niezrzeszona” według płci kategorii, „Unaffiliated” po angielsku). `summary.clubs` nie liczy `unaffiliated`. To samo w `guest-view.js` (test zgodności).
- Ukryty turniej ma status `draft`, więc gość go nie widzi.

### 5.7 Zmiany w `Domain.php` i lustrze `dist/workspace.js` (obowiązkowa zgodność)
Pomocnicze (eksportowane w JS, publiczne statyczne w PHP):
```
organizer(u)          = u.role==='member' && !!u.organizer && !u.organizerBlockedAt
staffIds(db)          = {id: true} dla db.users z rolą admin|editor|club
staffProfile(db,a)    = a.ownerId==null && staffIds(db)[a.createdBy]      // w JS na widoku: a.staff===true
community(db,t)       = !staffIds(db)[t.createdBy]
trusted(db,t)         = !community(db,t) || trustedOrganizer(db,t.createdBy)
manages(u,t)          = u.role==='admin' || (u.role==='editor' || organizer(u)) && t.createdBy===u.id
managesProfile(u,a,db?) =
   admin → true
   a.ownerId!=null → a.ownerId===u.id
   club → staffProfile(db,a) && a.clubId===u.clubId
   editor|organizer(u) → a.createdBy===u.id
outsideEntry(u,t,db)  = t.status==='open' && trusted(db,t)                       // zgłoszenie do cudzego turnieju
                        && (u.role==='club' || u.role==='editor'                 // O1 w turniejach społeczności
                            || organizer(u) && t.selfEntry===true)               // O19
canEnter(u,t,db)      = t.status!=='finished' && (manages(u,t) || outsideEntry(u,t,db))
canCreateTournament(u)= u.role==='admin'||u.role==='editor'||organizer(u)
```
Tablica prawdy `outsideEntry` (test `roles.test.mjs`): turniej personelu `open` → club i editor jak dziś, organizer tylko przy `selfEntry`; turniej społeczności `open` → wyłącznie potwierdzony, a wtedy club i editor (O1) oraz organizer przy `selfEntry`; turniej niepotwierdzonego organizatora → tylko on sam (`manages`). Organizator we własnym turnieju zgłasza także dzieci (dane wpisuje sam, B8); blokada osób niepełnoletnich dotyczy wyłącznie samodzielnych zgłoszeń (§7.1).

`managesProfile(u,a,db?)` i `canEnter(u,t,db?)` zachowują kolejność argumentów (`app.js` sprzed fali 2 działa dalej); bez `db` funkcje czytają pola widoku: `a.staff`, `t.community`, `t.trusted`.

**Nieaktualność:** `execute` woła `Domain::stale($db,$type,$p,$expected)` (§5.8) zamiast porównania z globalną rewizją, a po `apply` ustawia znaczniki.

Zmiany komend:
| Komenda | Zmiana |
|---|---|
| `tournament.save` | `canCreateTournament`; organizer: limity §5.4, `finished` tylko od dnia turnieju, wstrzymanie publikacji, `CONTACT`; `hiddenBy` blokuje status ≠ `draft`; `selfEntry`: przy tworzeniu brak pola = `true` dla organizatora i `false` dla personelu, przy edycji brak pola = bez zmian; `createdAt` dla nowego; `Text::clean` |
| `profile.save` | `managesProfile(u,a,db)`; klub: club → swój; pozostali przez `Clubs::pick` (`clubId` istniejący i niescalony, `unaffiliated`, albo `clubName` → nowy niezweryfikowany klub; personel też może wybrać `unaffiliated`); profil z `ownerId` może zmienić tylko Admin; organizer: limit profili, `createdAt`, zgoda opiekuna (§5.3); członek: niewidoczny profil → 404 `Zawodnik nie istnieje.` |
| `profile.archive` | `managesProfile(u,a,db)`; członek jak wyżej |
| **nowe** `profile.forget {id}` | Admin; twórca (`managesProfile`) dla profilu bez `ownerId` i bez zgłoszeń w turniejach `finished`; reguła usuwania §6.6 |
| `entry.save` | `canEnter(u,t,db)`; prawo do profilu: club → profil personelu swojego klubu; editor → w turniejach personelu **profil personelu**, w turniejach społeczności **tylko profile, które sam utworzył**; organizer → własny profil albo profil własnego konta; poprawka cudzego zgłoszenia jak dziś (menedżer albo autor profilu). **Zgłoszenie własne (`old.self`) poprawiane przez menedżera zachowuje z poprzedniej migawki `name`, `age`, `sex`, `profileId`, a `clubId`/`club` bierze z opcjonalnego `clubId` żądania** (istniejący, niescalony klub albo `unaffiliated`; tylko gdy żadne losowanie z wynikami nie zawiera zgłoszenia; dziennik „Zmieniono klub w zgłoszeniu: {imię}”); bez `clubId` zostaje klub z migawki. Migawka przez wspólne `snapshot()`, pole `self` przechodzi ze starego zgłoszenia |
| `entry.remove` | **najpierw gałąź właściciela**: `profile.ownerId===u.id` → tylko `status==='open'` i poza zapisanym losowaniem (409 `Losowanie Twojej kategorii już się odbyło. Wycofanie może zrobić organizator.`), bez `canEnter`; potem `canEnter` i dotychczasowe reguły: menedżer; club → `clubId` **i** profil personelu; editor i organizer → `profile.createdBy===id`. Usunięcie zgłoszenia własnego przez kogoś innego niż właściciel dopisuje nagrobek do `$db['withdrawals']` (`organizer` albo `admin`) |
| **nowe** `athlete.save`, `athlete.archive`, `athlete.forget` | §6.1, §4.5, §6.6 |
| **nowe** `entry.self` | §7.2 |
| **nowe** `club.save`, `club.merge`, `club.adopt` | Admin, §5.5 |
| **nowe** `tournament.hide` | Admin, §5.5 |
| `account.save` | `clubId` nie może być `unaffiliated` ani scalony (422 `Wybierz klub lub wpisz nazwę nowego klubu.`); nowy klub z `clubName` przez `Clubs::pick` (zweryfikowany, bo tworzy Admin; dzisiejsze `mb_strtolower` zastępuje `Clubs::key`) |
| `publicData` | macierz §5.2 |
| **nowe** `Domain::forgetMember`, `Domain::retain` | §6.6–§6.7 (tylko PHP) |

**Niewidoczne zasoby dla członka:** gdy aktor to `member`, każdy turniej nieistniejący albo niewidoczny dla niego daje **ten sam** 404 `Turniej nie jest dostępny.` (ten sam literał co trasy gościa), a każdy profil nieistniejący albo niedozwolony 404 `Zawodnik nie istnieje.`. Testy porównują bajt po bajcie odpowiedzi dla turnieju roboczego, ukrytego i nieistniejącego.

**Nie zmieniamy:** reguł sportowych (`Rules::eligibility/classify/categories`), `reconcile`, `checkin.save`, `draw.create`, `result.*` poza `manages`, podpisu losowania (`signature`).

### 5.8 Rewizje zakresowe (R15)
**Znaczniki** (wartość globalnej rewizji, przy której obiekt zmienił się ostatnio): `tournaments.rev` → `t.rev` (zmiana pól, zgłoszeń, losowań lub dziennika), `profiles.rev` → `a.rev`, `app_meta.staff_rev` → `db.staffRev` (zmiana kont personelu lub **istniejących** klubów; nowy klub jej nie zmienia). Migracja 0007 ustawia `staff_rev=revision`; JS `initialWorkspace` ma `staffRev: revision`. Brak znacznika = 0.

**Ustawianie** w `execute` po `apply`, centralnie (żadna komenda nie może o tym zapomnieć): `R=db.revision+1`; każdy turniej i profil różny od stanu sprzed `apply` (porównanie tablic po `id`, także nowe) dostaje `rev=R`; zmiana kont personelu (role `admin`/`editor`/`club`; wstrzyknięty aktor-członek się nie liczy) albo istniejącego klubu daje `staffRev=R`; `db.revision=R`. Usunięty profil nie ma znacznika (komenda, która go dotyczy, dostaje 404).

**Kontrola** `stale(db,type,p,expected)`:
```
expected === db.revision            → aktualne
expected  >  db.revision            → nieaktualne (np. po odtworzeniu kopii bazy)
zakres(type):
  turniej:  entry.save, entry.remove, checkin.save, draw.create, result.*, tournament.hide, tournament.save z id
            → t.rev > expected (dla entry.save także profil p.profileId: a.rev > expected)
  profil:   profile.save z id, profile.archive, profile.forget → a.rev > expected (+ turniej z registration)
  tworzenie: tournament.save bez id, profile.save bez id → db.staffRev > expected (+ turniej z registration)
  personel: account.*, club.* → db.staffRev > expected
  inny typ  → nieaktualne, gdy expected !== db.revision (jak dziś)
brak obiektu → aktualne (dalej odpowiada 404 komendy)
```
Komunikat bez zmian: 409 `Dane zmieniły się w innej sesji. Odśwież widok i ponów zapis.`. Trasy członków (`athlete-*`, rejestracja) przekazują bieżącą rewizję. Kontrakt klienta się nie zmienia; istniejące testy (`http.test.mjs:39` dwa zapisy tego samego turnieju → `[200,409]`, `workspace.test.mjs:36` i `php.test.mjs` tworzenie profilu ze starą rewizją → 409) przechodzą bez zmian asercji.

**Skutek:** zgłoszenie zawodnika albo komenda organizatora w turnieju A nie unieważnia formularza personelu w turnieju B. Zmiana w tym samym turnieju unieważnia go słusznie (kategorie mogły się zmienić). Testy: PHP↔JS dla tablicy zakresów; HTTP „pętla organizatora na limicie i zgłoszenia zawodników w turnieju A, a `checkin.save` edytora w turnieju B przechodzi za każdym razem”.

---

## 6. Profil zawodnika

### 6.1 Pola i walidacja (`athlete.save`)
Payload: `{id?, name, birthDate, sex:'M'|'F', weight, height, gradeType:'cup'|'dan', grade, club:{id}|{name}|{none:true}, relation:'self'|'guardian'}`. Lista pól jest zamknięta; inne pola (`ownerId`, `createdBy`, `champion`, `events`, `archived`) są ignorowane. Walidacja pól to czysta funkcja `Domain::athleteFields($p,$today)` (JS `athleteFields`), wspólna z rejestracją (R19).
- `id`: brak → nowy profil konta (limit `ATHLETES_PER_ACCOUNT`, 409 `Na jednym koncie może być najwyżej 5 zawodników.`); podany → profil musi należeć do konta (inaczej 404 `Zawodnik nie istnieje.`); zarchiwizowany jest przywracany.
- `relation`: `self` najwyżej raz na konto (409 `Na koncie jest już Twój własny profil zawodnika.`).
- `name`: `Text::clean` + `Domain::txt` (1–100). Interfejs wypełnia je imieniem i nazwiskiem z profilu konta **tylko przy `self`**.
- `birthDate`: `Domain::date`, od `1900-01-01` do dziś; **wymagana**.
- `sex`, `weight` (10–250), `height` (70–250), `gradeType`, `grade`: ta sama walidacja co profil (`Rules::validate` z `age:25, club:'Klub', events:['forms']`).
- `events` profilu: `['forms']`; konkurencje wybiera się przy zgłoszeniu.
- `champion=false` zawsze (O15).
- **Próg wieku:** `relation==='self'` i `ageAt(birthDate, dziś) < MINOR_SELF_AGE` → 422 `Osoby poniżej 16 lat rejestruje rodzic lub opiekun. Poproś go o założenie konta.` (bez instrukcji zaznaczenia pola). Przy `guardian` zapisujemy `guardianDeclaredAt=now` (hak dla zgody; slot zgody w formularzu pusty).
- **Dane tożsamości przy zgłoszeniach w toku:** gdy profil ma zgłoszenia w turniejach `open` albo `closed`, zmiana `club`, `birthDate` albo `sex` daje 409 `Masz zgłoszenia do turniejów, które jeszcze się nie odbyły. Klub, datę urodzenia i płeć zmienisz po turnieju albo po wycofaniu zgłoszenia.` (chroni migawki i losowania, DR-11). Imię i wymiary można zmieniać zawsze (migawki się nie zmieniają, §6.2).
- Zapis: `{id, ownerId:u.id, createdBy:u.id, createdAt, archived:false, name, clubId, pendingClubName?, birthDate, sex, weight, height, gradeType, grade, events, champion:false, relation, guardianDeclaredAt?}`.
- **Interfejs:** `dist/athlete-form.js` z czystymi walidatorami (te same zakresy i komunikaty co serwer).

### 6.2 Powiązanie konta z profilami
- `profiles.owner_user_id` = `users.id`, czytane w `Repository::load` jako `ownerId` i przez `Actors::of`.
- Zgłoszenia są migawkami (`entries.profile_id`). Zmiana profilu nie zmienia złożonych zgłoszeń. Zawodnik aktualizuje zgłoszenie osobno (`entry.self` z `update`) albo przy zgłoszeniu zaznacza „Zapisz też w profilu”.

### 6.3 Kluby: z listy, nowy, „Niezrzeszony”
- **Lista:** `public-clubs` (GET, `public`, `Cache-Control: public, max-age=300`) zwraca `{clubs:[{id,name}], unaffiliated:'unaffiliated'}`: kluby zweryfikowane i niescalone, posortowane według nazwy, najwyżej 2000.
- **„Niezrzeszony”:** wiersz `clubs(id='unaffiliated', name='Niezrzeszony', verified=1)` z migracji 0007. **Losowanie:** `Rules::sameClub($a,$b)` = `$a['club']===$b['club'] && ($a['clubId']??null)!=='unaffiliated' && ($b['clubId']??null)!=='unaffiliated'`, używane w koszcie `Rules::makeDraw`; w JS w `makeDraw`, `clubConflicts` i `fingerprintCounts`. `signature()` bez zmian.
- **Klucz porównania nazw** `Clubs::key(name)` (PHP) / `clubKey` (JS, w `profile-data.js`): `Text::clean`, małe litery, transliteracja polskich liter, NFD bez znaków łączących, potem **tylko `\p{L}\p{N}`** (litery dowolnego pisma i cyfry). Klucz musi mieć co najmniej 2 znaki. „Kraków” i „Krakow” dają `krakow`; „Тигр Київ” i „Дракон Львів” dają różne klucze (dziś oba dałyby pusty slug). Różnice z collation bazy (np. `ß`/`ss`) łapie 1062 przy wstawianiu.
- **Wybór** `Clubs::pick(array $clubs, array $u, array $choice, int $now, array $counts): array` (czysta, wspólna dla `Domain` i rejestracji; zwraca `{clubId, newClub?, pendingClubName?, notice?}`):
  1. `{id}`: istniejący klub (scalony → `mergedInto`); niezweryfikowany dozwolony;
  2. `{none:true}` albo klucz ∈ {`niezrzeszony`, `niezrzeszona`, `brak`, `bezklubu`, `none`} → `unaffiliated`;
  3. `{name}`: `Text::clean`, 2–100 znaków, co najmniej jedna litera, `CONTACT` (członkowie); istniejący klub o równym kluczu (także niezweryfikowany; scalony → cel);
  4. inaczej nowy `{id, name, verified:false, createdBy:u.id, createdAt:now}`; **gdy limit kont lub globalny jest wyczerpany**: `unaffiliated` z `pendingClubName=name` i `notice:'club-pending'` (interfejs: „Klub zapiszemy po sprawdzeniu przez Administratora. Do tego czasu jesteś „Niezrzeszony”.”). Admin zamienia oczekujące nazwy w kluby (§5.5).
- **Kolizja collation:** `persist()` mapuje 1062 na 409 `Klub o podobnej nazwie już istnieje. Wybierz go z listy.` i nie nadpisuje istniejącego wiersza (R5). Rejestracja (poza workspace) po 1062 czyta klub ponownie i używa istniejącego.
- **Kluby demo** (`bin/seed-athletes.php`): powstają z `verified=false` i `created_by`=Admin seedujący (poza listą publiczną). `--remove` usuwa wyłącznie profile `created_by ∈ personel AND owner_user_id IS NULL` w klubach demo i **odmawia** z instrukcją, gdy klub demo ma jakikolwiek inny profil albo zgłoszenie (`Demo clubs are used by community profiles; merge or rename them in the app (Kluby) first.`).
- **Weryfikacja:** organizator widzi przy kontroli znaczniki i może poprawić klub w zgłoszeniu własnym (§7.5). Admin weryfikuje, zmienia nazwę, scala.

### 6.4 Kto edytuje i kto widzi profil zawodnika z konta
| Osoba | Widzi profil | Edytuje |
|---|---|---|
| Właściciel konta | tak (zakładka „Role”, „Moje starty”) | tak (`athlete.save`; klub, data urodzenia i płeć poza zgłoszeniami w toku) |
| Admin | tak (Baza zawodników, znacznik „Konto zawodnika”) | tak (`profile.save`) |
| Organizator turnieju, do którego się zgłosił | **nie** (tylko migawka zgłoszenia) | migawkę: waga, konkurencje, obecność, **klub** (D3); nie imię, wiek, płeć |
| Przedstawiciel wybranego klubu | **nie** | nie |
| Edytor | profilu nie; zgłoszenie własne w turnieju personelu tak (O2) | nie |

### 6.5 Wielu zawodników na koncie; haki dla małoletnich
- Konto ma do 5 profili (O17): najwyżej jeden `self`, reszta `guardian`. Rodzic dwójki dzieci używa jednego konta i jednego e-maila.
- Haki dla sesji prawnej: pola `relation`, `guardianDeclaredAt`, `guardianConsentAt` (organizator), stałe `MINOR_SELF_AGE` i `ADULT_AGE`, puste sloty zgody w kroku „Zawodnik”, w formularzu zawodnika organizatora i w oknie zgłoszenia, flaga `minor` w `AthleteView` (wyliczana).
- Dane dziecka są minimalne: tylko pola potrzebne do kategorii; bez zdjęcia zawodnika; bez danych kontaktowych.

### 6.6 Usuwanie danych: konto, profil, organizator
Wspólna reguła **odłączenia zgłoszenia** `Domain::detach(&$t, $entryId): bool` (zawsze się kończy):
1. turniej `finished` → zgłoszenie zostaje (historia wyników; O7);
2. turniej `closed`, w którym którakolwiek kategoria zgłoszenia ma zapisane losowanie → zostaje;
3. inaczej usuwamy przez `reconcile`; gdy `reconcile` rzuci `AppError` (losowanie z wynikami) → zgłoszenie zostaje.

Zgłoszenie, które zostaje, wskazuje profil zanonimizowany (poniżej).

**Zapomnienie profilu** `Domain::forgetProfile(&$db, $id)` (używane przez `profile.forget`, `athlete.forget`, `forgetMember`, retencję):
- `detach` każdego zgłoszenia profilu;
- profil bez zgłoszeń → usunięty z `$db` (`persist()` kasuje wiersz z kontrolą `rowCount`, §4.3);
- profil z pozostałymi zgłoszeniami → zanonimizowany: `name='Dane usunięte'`, `birthDate=null`, `ownerId=null`, `relation=null`, `guardianDeclaredAt=null`, `guardianConsentAt=null`, `consentBy=null`, `pendingClubName=null`, `archived=true`; w pozostałych migawkach `name` zostaje (O7) z wyjątkiem `profile.forget`/`athlete.forget`, które zamieniają je na inicjały (`GuestView::initials`; podpis losowania nie zawiera imienia, więc losowania zostają ważne). Przy usunięciu konta i retencji imię zostaje tylko jako historia wyników turnieju, który się odbył (`finished` albo z datą przed dniem usunięcia); zgłoszenie, które zostaje w nadchodzącym turnieju (zapisane losowanie), dostaje inicjały (§18.2 R2.2).
- **Dziennik turnieju (`activity`).** Wiersze, które kończą się imieniem zawodnika (`Zgłoszono`, `Zmieniono zgłoszenie`, `Zgłoszenie własne`, `Zmieniono zgłoszenie własne`, `Zmieniono klub w zgłoszeniu`, `Kontrola startowa`, `Wycofano zgłoszenie`), zapisują przy sobie `profileId` zawodnika (`Domain::audit`). Zapomnienie jednego profilu (`forgetProfile`) zamienia imię na inicjały **tylko** w wierszach oznaczonych `profileId` tego profilu, więc imiennik z innego turnieju niczego nie traci. Retencja (`Domain::retain`) działa szerzej: w każdym turnieju społeczności starszym niż granica (24 miesiące) zamienia na inicjały imię w każdym wierszu dziennika, który je zawiera, oznaczonym czy nie, oraz we wszystkich migawkach zgłoszeń. Wiersze **bez znacznika** (zapisane przed tą zmianą) są dopasowywane po tekście `: <imię>` wyłącznie w turniejach, w których profil ma zgłoszenie albo w których wykonujący operację zarządza turniejem, i nigdy gdy zgłoszenie innego profilu nosi to samo imię. Widok publiczny (`publicData`) pokazuje z wiersza dziennika tylko tekst i czas, bez `profileId`.

**Usunięcie konta** `Members::erase` (członek sam albo Admin) wykonuje `Repository::transaction` z `Domain::forgetMember(&$db, $userId)` **po** kontroli `confirmEnd` i usunięciu klienta Stripe, **przed** dotychczasową transakcją członka. Funkcja tylko w PHP; idempotentna.
- **Profile konta** (`ownerId`): `forgetProfile` każdego.
- **Organizator:** nadchodzące turnieje dostają `hiddenFrom=status`, `status='draft'`, `hiddenBy='system'`, wpis „Konto organizatora zostało usunięte.” (O8); zgłoszenia własne innych zawodników w tych turniejach są odłączane (nagrobek `system`); **jego profile → `forgetProfile`** (usunięte albo zanonimizowane, nie tylko zarchiwizowane); `created_by` wskazuje dalej zanonimizowany wiersz `users`.
- Test HTTP sprawdza **wiersz `profiles`** po usunięciu: brak wiersza albo `owner_user_id IS NULL` i zanonimizowane `data`; oraz przypadek „zawodnik w drabince, w której inna walka ma wynik” → usunięcie konta się udaje, drabinka bez zmian.

**`jobs/accounts.php` (porzucone konta):** nowe warunki `NOT EXISTS` dla `profiles.created_by`, `profiles.owner_user_id`, `tournaments.created_by` i `clubs.created_by` tej osoby, w liście i w ponownej kontroli `FOR UPDATE`.

### 6.7 Retencja danych społeczności
Zadanie `community-retention` (`backend/jobs/community.php`, raz na dobę, `Settings::effective` na początku) wykonuje `Repository::transaction` z `Domain::retain(&$db, $cutoffDate, $limit=200)`, gdzie `cutoffDate = dziś − RETENTION_MONTHS` (24 miesiące, do potwierdzenia w sesji prawnej, O20):
1. profile utworzone przez organizatorów (`ownerId=null`, `createdBy ∉ staff`), których ostatni turniej (albo `createdAt`, gdy bez zgłoszeń) jest starszy niż `cutoffDate` → `forgetProfile`;
2. migawki zgłoszeń w turniejach społeczności z datą przed `cutoffDate` → `name` zamienione na inicjały;
3. `entry_withdrawals` starsze niż 30 dni po dacie turnieju → usunięte (w `persist` przez listę `$db['withdrawalsPurge']`).

Profile kont zawodników zostają, dopóki istnieje konto (usuwa je właściciel). Wynik zadania (`job_runs.last_result`) to liczby bez danych osobowych. Najwyżej 200 profili na przebieg.

---

## 7. Samodzielne zgłoszenie do turnieju

### 7.1 Warunki
Zgłoszenie jest możliwe, gdy:
- turniej istnieje, nie jest ukryty i ma `status==='open'`, `selfEntry===true`, `date >= dziś`;
- profil należy do konta i nie jest zarchiwizowany;
- **żadna kategoria docelowa nie ma zapisanego losowania** (kategorie liczone `Rules::categories` na liście zgłoszeń po zmianie): inaczej 409 `Losowanie tej kategorii już się odbyło. Zgłoszenie może dodać organizator.`;
- w turnieju społeczności **niepotwierdzonego** organizatora osoba ma w dniu turnieju co najmniej `ADULT_AGE` (18) lat i profil nie jest `guardian`: inaczej 409 `Zgłoszenia osób niepełnoletnich do tego turnieju będą możliwe, gdy MatBravo potwierdzi organizatora.`;
- w trybie płatnym konto ma pełny dostęp (402 `Zgłoszenia do turniejów wymagają aktywnego konta.`).

Turniej niewidoczny albo nieistniejący: 404 `Turniej nie jest dostępny.` (jeden literał); widoczny, ale zamknięty, zakończony, po terminie albo bez samodzielnych zgłoszeń: 403 `Zapisy do tego turnieju są zamknięte.`.

### 7.2 Przebieg (`athlete-entry` → `Domain` `entry.self`)
1. Trasa (POST `session`, `member`, CSRF, `max` 4 KB): limit 30/h, globalny limit transakcji członków (§3.7), `Actors::of`, `Access::of($pdo,$u,$ctx->config)` (402), `Repository::transaction(fn(&$db)=>Domain::execute($db,$u['id'],'entry.self',$payload,$db['revision']), $actor)`.
2. `entry.self {tournamentId, profileId, events, weight?, height?, gradeType?, grade?, saveToProfile?:bool, update?:bool}`:
   - profil = `ownerId===u.id`, niezarchiwizowany (inaczej 409 `Najpierw uzupełnij dane zawodnika.`);
   - warunki §7.1 (dla `update` także: zgłoszenie nie jest w zapisanym losowaniu, komunikat jak w §5.7);
   - istniejące zgłoszenie bez `update` → 409 `Jesteś już zgłoszony do tego turnieju.`;
   - `weight/height/gradeType/grade` domyślnie z profilu; przy `saveToProfile` najpierw ta sama aktualizacja profilu co `athlete.save` (w tej samej transakcji);
   - **migawka wspólną funkcją `snapshot($db,$a,$t,$p,$old)`**: `{id=profileId, profileId, clubId, name, club, sex, age=ageAt(birthDate,t.date), weight, height, gradeType, grade, events, champion:false, presence:old?:'pending', actualWeight:old?:null, self:true}`;
   - `Rules::validate` (422 z komunikatem reguły), `reconcile`, dziennik `Zgłoszenie własne: <imię>` (zmiana: `Zmieniono zgłoszenie własne: …`); nagrobek `(profil, turniej)` znika.
3. Odpowiedź `{ok:true, entry: <wpis AthleteView dla tego turnieju>}`.

### 7.3 Wycofanie (`athlete-withdraw {tournamentId, profileId}` → `entry.remove`, gałąź właściciela)
Tylko przy `status==='open'` i poza zapisanym losowaniem. Przy zamkniętych zapisach 403 z podpowiedzią „Zapisy są zamknięte. Jeśli nie przyjedziesz, organizator oznaczy nieobecność przy kontroli startowej.”. Wycofanie **nie wymaga pełnego dostępu**. Interfejs pyta: „Wycofać zgłoszenie z {turniej}? Po zamknięciu zapisów nie zgłosisz się ponownie.”.

### 7.4 Co widzi zawodnik (`backend/src/AthleteView.php`, trasa `athlete`; lustro `dist/athlete-view.js`)
`AthleteView::project(array $profiles, array $tournaments, array $withdrawals, string $today, array $organizers): array` to czysta funkcja testowana z JS. `build(PDO,$u,$today)` czyta:
1. profile po `owner_user_id`;
2. zgłoszenia: `SELECT … FROM entries e JOIN tournaments t … WHERE e.profile_id IN (…) ORDER BY t.event_date DESC LIMIT 100`, z bieżącą nazwą i stanem klubów (złączenie z `clubs`);
3. dla turniejów z datą ≥ dziś − 30 dni wszystkie zgłoszenia i losowania (jak `guestTournaments`), do obliczenia kategorii;
4. nagrobki `entry_withdrawals WHERE profile_id IN (…)` z nazwą i datą turnieju;
5. listę otwartych turniejów: `status='open' AND self_entry=1 AND hidden_by IS NULL AND event_date>=?`, najwyżej 50, z flagami `community`, `trusted` i nazwą organizatora społeczności przez `People::project` (O11).

Lista dozwolonych pól odpowiedzi:
```
{ profiles: [ {id,name,birthDate,sex,weight,height,gradeType,grade,club:{id,name,verified,unaffiliated,pending},relation,archived,minor,locked} ],
  entries: [ { profileId, tournament:{id,name,city,date,status,available,community,trusted},
               entry:{events,weight,height,gradeType,grade,age,club,presence,actualWeight},
               canWithdraw, canEdit,
               categories:[ {event,code,title,subtitle,type,state,athletes,drawn,
                             position:null|{slot,round,match,status:'waiting'|'next'|'won'|'lost'|'bye'|'champion',opponent:null|{initials,club}},
                             bracket:null|<jak GuestView: size, slots {initials,club}, results>} ] } ],
  withdrawn: [ {profileId, tournament:{id,name,date}, by:'organizer'|'admin'|'system', at} ],
  open: [ {id,name,city,date,community,trusted,organizer:null|{n},
           profiles:[{id,entered:bool,blocked:null|'minor-untrusted'}]} ] }
```
- **Nigdy:** dane innych zawodników poza inicjałami i klubem w drabince; id innych zgłoszeń i profili; e-maile; twórcy turniejów personelu.
- `available=false` dla turnieju roboczego albo ukrytego: tylko nazwa, data i „Organizator lub Administrator wstrzymał ten turniej. Twoje zgłoszenie zostaje zapisane.”.
- `locked` = profil ma zgłoszenia w toku (interfejs blokuje pola klubu, daty urodzenia i płci z wyjaśnieniem, §6.1).
- `categories[].drawn` = kategoria ma zapisane losowanie (okno zgłoszenia pokazuje konkurencję jako niedostępną z tym powodem).
- Kod kategorii i kolejność są identyczne z `GuestView`: `data-domain` wydziela w `GuestView` publiczne `categoryList(array $entries,array $draws)` i `bracket()` bez zmiany wyniku `tournament()`; JS tak samo.
- Turnieje sprzed ponad 30 dni dostają tylko podsumowanie.

### 7.5 Weryfikacja przez organizatora
Kontrola startowa (`checkin.save`) działa jak dziś. W liście zgłoszeń i w oknie kontroli `app.js` pokazuje znaczniki **„Zgłoszenie własne”**, **„Klub niezweryfikowany”** i **„Niezrzeszony”** oraz podpowiedź „Sprawdź legitymację klubową lub dokument przy wadze.”. Dla zgłoszeń własnych okno kontroli ma pole **„Klub”** (wspólny komponent wyboru klubu, §10.4), które zapisuje `entry.save {update:true, clubId}` (§5.7) przed zapisem obecności. Gdy zmiana unieważni zapisane losowanie bez wyników, okno ostrzega: „Losowanie kategorii {kategoria} zostanie usunięte. Wylosujesz je ponownie.”. Organizator może też oznaczyć nieobecność albo wycofać zgłoszenie (nagrobek dla zawodnika).

### 7.6 Statusy zamiast powiadomień
„Moje starty” odświeża dane przy wejściu, po każdej akcji i co 60 s, gdy strona jest widoczna. Statusy:
- „Zgłoszenie przyjęte”;
- „Zapisy zamknięte — czekaj na kontrolę startową”;
- „Obecność potwierdzona · waga {kg}”;
- „Nieobecny”;
- „Losowanie: walka {n}, runda {r}, przeciwnik {inicjały} ({klub})”;
- „Wygrana” / „Porażka” / „Zwycięzca kategorii”;
- „Turniej zakończony”;
- **„Zgłoszenie wycofane przez organizatora”**, **„Zgłoszenie wycofane przez Administratora”**, **„Turniej wstrzymany przez Administratora”**.

Liczba startów w najbliższych 7 dniach trafia jako plakietka przy pozycji menu (`registry.setBadge`).

---

## 8. API

### 8.1 Trasy
Konwencje jak w PLAN-CZAT §4.1.

| Trasa | Metoda | Tryb / użytkownik | Ciało / zapytanie | Odpowiedź | Błędy | Limit |
|---|---|---|---|---|---|---|
| `public-config` (zm.) | GET | public, `settings:true` | — | `{signup, signupMode, billing, amounts, avatars, support, roles:true}` | — | cache 60 s |
| `public-clubs` (nowa) | GET | public | — | `{clubs:[{id,name}], unaffiliated}` | — | cache 300 s |
| `signup-begin` (zm.) | POST | session / anon | `{invite?}` | `{ok}` | 404 wyłączona | 60/h IP |
| `signup` (zm.) | POST | session / anon | dotychczasowe pola + `roles{organizer,athlete}` + `athlete{…}` | `{user, csrf, caps, notice?}` | 400; 404; 409 e-mail/nazwa/klub; 422 pole; 429 | §3.7 |
| `roles` (nowa) | POST | session / member | `{organizer:bool}` | `{caps}` | 403; 409; 429 | 10/h + IP/doba |
| `organizer-unlock` (nowa) | POST | session / member | `{password}` | `{ok, csrf}` | 401/422 hasło; 429 | limity logowania |
| `athlete` (nowa) | GET | peek / member | — | `AthleteView` | 401 | — |
| `athlete-save` (nowa) | POST | session / member | §6.1 | `{profile, caps, notice?}` | 404; 409; 422; 429 | 20/h |
| `athlete-archive` (nowa) | POST | session / member | `{profileId, archived:bool}` | `{caps}` | 404; 409 | 20/h (wspólny) |
| `athlete-forget` (nowa) | POST | session / member | `{profileId, password}` | `{caps}` | 404; 422 hasło; 429 | 5/h |
| `athlete-entry` (nowa) | POST | session / member | §7.2 | `{ok, entry}` | 402; 403; 404; 409; 422; 429 | 30/h |
| `athlete-withdraw` (nowa) | POST | session / member | `{tournamentId, profileId}` | `{ok}` | 403; 404; 409; 429 | 30/h (wspólny) |
| `me` (zm.) | GET | peek | — | + `user.caps`, `athletes`, `features.signupMode`, `features.selfEntry`, `features.pendingOrganizers` (Admin) | — | — |
| `bootstrap` (zm., legacy) | GET | session | `?t=<id>&rev=<n>` opcjonalnie | gdy `tournaments.rev` turnieju `t` równa się `n`: `{unchanged:true}` (jedno zapytanie po kluczu; id turniejów są losowe, 128 bitów, więc to nie jest wyrocznia); inaczej organizer: workspace §5.2, członek: pusty + `user.caps` | 401 (`code:'reauth'`); 429 | organizer 1500/h na sesję |
| `command` (zm., legacy) | POST | session | jak dziś | jak dziś | 401 (`reauth`); 402; 403; 404; 409; 422; 429 | członek: 60/min, 1200/h; globalnie §3.7 |
| `admin-settings` (nowa) | GET | peek / admin | — | widok §8.2 | 403 | — |
| `admin-settings-save` (nowa) | POST | session / admin, `max` 4 KB | `{version, signup?, payments?, organizers?, supportEmail?, freePeriod?, confirmTestMode?}` | widok | 409 `stale`/`stripe_not_ready`/`test_mode`/`free_period_decision`; 422; 503 | — |
| `admin-stripe-check` (nowa) | POST | session / admin | `{}` | `{stripeCheck}` | 409; 503 | 6/h |
| `admin-members` (zm.) | POST | session / admin | + `filter:'organizers'\|'organizers-pending'\|'athletes'\|'free-signup'`, `ownerOf?` | + `items[].caps`, `tournaments`, `freeSignup`, `trusted` | 422 | — |
| `admin-member` (zm.) | POST | session / admin | + `action:'organizer'\|'organizer-trust'\|'organizer-bulk'`; `active` z `hideTournaments?`; `create` z `organizer?` | `{id, caps, hidden?}` / `{done, failed}` | 404; 422 | — |
| `admin-billing-action` (zm.) | POST | session / admin | `requireFrom` + `scope:'free-signup'` | jak dziś | 422 | — |
| `diagnostics` (zm.) | GET | peek / admin | — | + `settings:{mode,degraded,version,source}`, czas `load()` | — | — |

Pliki tras: trasy zawodnika i `public-clubs` w `backend/routes/athletes.php`, ustawienia w `backend/routes/settings.php`, `roles` i `organizer-unlock` w `backend/routes/accounts.php`.

### 8.2 Kształty
- **`signup` → `athlete`:** `{name, birthDate:'YYYY-MM-DD', sex, weight:number, height:number, gradeType, grade:int, club:{id}|{name}|{none:true}, relation:'self'|'guardian'}`.
- **`caps`:** `{organizer:bool, organizerBlocked:bool, organizerTrusted:bool, athlete:bool}`.
- **`admin-settings` (widok):**
  ```
  {version, signup:'off'|'on', payments:'free'|'paid', organizers:'on'|'paused', mode:'off'|'free'|'paid',
   effective:{mode, degraded:null|'billing-missing'|'force-off'},
   support:{email, source:'db'|'config'|'default'},
   stripe:{enabled, mode:'test'|'live', check:null|{at,ok,mode,prices:{pln:bool,usd:bool},error:null|string}},
   freeSignups:{a, b, scheduled:{count, from:null|epoch}},
   organizersPending:n,
   limits:{organizerDay:3, organizerActive:10, communityDayGlobal:50, organizerProfilesDay:300, clubsDayPerUser:3, clubsDayGlobal:30, minorSelfAge:16, adultAge:18, athletesPerAccount:5, retentionMonths:24},
   history:[{at, actor, action, note}],
   updatedAt, updatedBy}
  ```
- **`command`/`bootstrap` dla organizatora:** kształt workspace jak dziś (`schemaVersion:2`), z `user.caps` i polami z §5.2.

### 8.3 Nowe komunikaty serwera (polskie literały; EN w słownikach `dist/i18n/server-*-en.js`, pilnuje `tests/i18n.test.mjs`)
- Ustawienia: `Płatności nie są skonfigurowane. Najpierw skonfiguruj Stripe (DEPLOY-PL.md).`; `Stripe działa w trybie testowym: nikt nie zapłaci prawdziwymi pieniędzmi. Potwierdź, jeśli to zamierzone.`; `Zdecyduj, co z kontami założonymi w okresie bezpłatnym.`; `Ustawienia zmienił w międzyczasie ktoś inny. Odśwież stronę.`; `Płatności nie są teraz wymagane.`.
- Role i sesja: `Administrator wyłączył Ci rolę organizatora.`; `Masz turnieje z otwartymi lub zamkniętymi zapisami. Zakończ je albo przełącz na roboczy, zanim wyłączysz rolę organizatora.`; `Zbyt wiele nowych kont organizatorów z tej sieci. Spróbuj ponownie jutro.`; `Zbyt wiele zmian ról. Spróbuj ponownie później.`; `Potwierdź hasło, aby otworzyć narzędzia organizatora.`; `Serwer jest teraz mocno obciążony. Spróbuj ponownie za chwilę.`.
- Organizator: `Limit nowych turniejów: 3 na dobę.`; `Masz już 10 opublikowanych nadchodzących turniejów. Przełącz któryś na roboczy albo poczekaj, aż się odbędzie.`; `Dziś powstało już bardzo dużo nowych turniejów. Spróbuj ponownie jutro albo napisz do nas.`; `Limit nowych zawodników na dziś został osiągnięty.`; `Turniej ukrył Administrator. Status może zmienić tylko Administrator.`; `Turniej można zakończyć najwcześniej w dniu zawodów.`; `Publikowanie nowych turniejów społeczności jest chwilowo wstrzymane przez Administratora.`; `Nazwa nie może zawierać adresu strony, e-maila ani długiego numeru.`; `Zaznacz, że masz zgodę rodzica lub opiekuna na podanie danych zawodnika.`; `Zbyt wiele operacji. Spróbuj ponownie za chwilę.`.
- Kluby: `Klub o podobnej nazwie już istnieje. Wybierz go z listy.`; `Klub o takiej nazwie już istnieje. Użyj scalania.`; `Tego klubu nie można zmienić.`.
- Zawodnik: `Osoby poniżej 16 lat rejestruje rodzic lub opiekun. Poproś go o założenie konta.`; `Na jednym koncie może być najwyżej 5 zawodników.`; `Na koncie jest już Twój własny profil zawodnika.`; `Masz zgłoszenia do turniejów, które jeszcze się nie odbyły. Klub, datę urodzenia i płeć zmienisz po turnieju albo po wycofaniu zgłoszenia.`; `Najpierw uzupełnij dane zawodnika.`; `Jesteś już zgłoszony do tego turnieju.`; `Losowanie tej kategorii już się odbyło. Zgłoszenie może dodać organizator.`; `Losowanie Twojej kategorii już się odbyło. Wycofanie może zrobić organizator.`; `Zgłoszenia osób niepełnoletnich do tego turnieju będą możliwe, gdy MatBravo potwierdzi organizatora.`; `Zgłoszenia do turniejów wymagają aktywnego konta.`; `Turniej nie jest dostępny.` (istnieje); `Zawodnik nie istnieje.` (istnieje); `Najpierw wycofaj zgłoszenia do turniejów, które jeszcze się nie odbyły.`; `Zbyt wiele zmian zgłoszeń. Spróbuj ponownie później.`; `Zbyt wiele zmian danych zawodnika. Spróbuj ponownie później.`.
- Dziennik turnieju: `Zgłoszenie własne: `, `Zmieniono zgłoszenie własne: `, `Zmieniono klub w zgłoszeniu: `, `Administrator ukrył turniej.`, `Administrator przywrócił turniej.`, `Konto organizatora zostało usunięte.`.

---

## 9. Migracje (MariaDB 10.6 i MySQL 8.0, wyłącznie addytywne)

### 9.1 `0007_roles.php` (plasterek `data-domain`)
```
users:       addColumn organizer TINYINT(1) NOT NULL DEFAULT 0
             addColumn organizer_blocked_at BIGINT NULL
             addColumn organizer_trusted_at BIGINT NULL
             addColumn organizer_trusted_by VARCHAR(40) NULL
profiles:    addColumn owner_user_id VARCHAR(40) NULL
             addColumn rev BIGINT NOT NULL DEFAULT 0
             addIndex profiles_owner (owner_user_id)                  -- nieunikalny (R7)
clubs:       addColumn verified TINYINT(1) NOT NULL DEFAULT 1         -- istniejące kluby: zweryfikowane
             addColumn created_by VARCHAR(40) NULL
             addColumn created_at BIGINT NULL
             addColumn merged_into VARCHAR(40) NULL
             INSERT IGNORE INTO clubs (id,name,verified) VALUES ('unaffiliated','Niezrzeszony',1)
             -- gdy nazwa zajęta przez inny klub: ponów z 'Niezrzeszony (bez klubu)'; gdy wiersza nadal brak: RuntimeException z instrukcją
tournaments: addColumn created_at BIGINT NULL
             addColumn hidden_by VARCHAR(40) NULL
             addColumn hidden_from VARCHAR(10) CHARACTER SET ascii NULL
             addColumn hide_reason VARCHAR(200) NULL
             addColumn self_entry TINYINT(1) NOT NULL DEFAULT 0       -- istniejące turnieje: bez samodzielnych zgłoszeń (R11)
             addColumn rev BIGINT NOT NULL DEFAULT 0
app_meta:    addColumn staff_rev BIGINT NOT NULL DEFAULT 0
             UPDATE app_meta SET staff_rev=revision WHERE id=1 AND staff_rev=0
CREATE TABLE IF NOT EXISTS entry_withdrawals (
 profile_id VARCHAR(40) NOT NULL, tournament_id VARCHAR(40) NOT NULL,
 by_kind VARCHAR(12) CHARACTER SET ascii NOT NULL, created_at BIGINT NOT NULL,
 PRIMARY KEY (profile_id, tournament_id), KEY entry_withdrawals_tournament (tournament_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
```
- Bez nowych kluczy obcych (zasada 0002; nagrobki sprząta `persist` i retencja). Kolumny na końcu tabel z `DEFAULT`, więc `ADD COLUMN` jest natychmiastowe [do weryfikacji na web9: czas migracji w logu wdrożenia].
- Każdy krok idempotentny (`Migrator::addColumn/addIndex/columnExists`).
- **`floor`** (powrót do kodu sprzed 0007 jest odmawiany, gdy istnieją dane, które stary kod pokazałby personelowi):
  ```sql
  SELECT 1 FROM profiles WHERE owner_user_id IS NOT NULL
  UNION ALL SELECT 1 FROM profiles p JOIN users u ON u.id=p.created_by WHERE u.role='member'
  UNION ALL SELECT 1 FROM tournaments t JOIN users u ON u.id=t.created_by WHERE u.role='member'
  UNION ALL SELECT 1 FROM tournaments WHERE hidden_by IS NOT NULL
  UNION ALL SELECT 1 FROM clubs c JOIN users u ON u.id=c.created_by WHERE u.role='member'
  UNION ALL SELECT 1 FROM clubs WHERE merged_into IS NOT NULL
  LIMIT 1
  ```
  (Kluby demo mają `created_by` Admina, więc nie blokują powrotu.)
- Stary kod przy nowej bazie (deploy przed przełączeniem) aktualizuje tylko swoje kolumny przez upsert; nowe kolumny zachowują wartości.

### 9.2 `0008_settings.php` (plasterek `settings-backend`)
```sql
CREATE TABLE IF NOT EXISTS app_settings (
 id TINYINT NOT NULL PRIMARY KEY,
 version INT UNSIGNED NOT NULL,
 data TEXT NOT NULL,
 updated_at BIGINT NOT NULL,
 updated_by VARCHAR(40) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
```
Bez wiersza startowego i bez `floor`.

### 9.3 Kontrole
- `tests/migrations.test.mjs`: ciągłość 2–8, InnoDB/utf8mb4, brak TIMESTAMP, brak `MODIFY` istniejących kolumn.
- Test HTTP na obu bazach: idempotencja (drugi `migrate.php` daje kod 0), `--rollback-floor` bez danych społeczności jak dotąd, a 7 po utworzeniu profilu z `owner_user_id`, turnieju członka albo klubu członka.

---

## 10. Frontend

### 10.1 Rejestracja (`dist/account-flow.js`, `dist/athlete-form.js`, `dist/account-boot.js`, `dist/promo.js`)
- **Krok 1:**
  - nagłówek bez zmian, nowy lead: „Konto MatBravo: czaty, zgłoszenia do turniejów i własne turnieje. Wybierz, kim jesteś — możesz to zmienić później.” (zamiast „Konta klubów zakłada Administrator turnieju.”);
  - fieldset ról z podpisami z §4.5; potem e-mail, hasło, pusty slot zgód i pułapka (bez zmian);
  - `#signup?as=…&t=…` zaznacza pole i zapisuje cel w `sessionStorage`.
- **Krok 2** (profil konta): bez zmian. Przycisk „Dalej” zamiast „Utwórz konto”, gdy zaznaczono „Zawodnik”.
- **Krok „Zawodnik”** (`athlete-form.js`, wspólny z zakładką „Role”):
  - **pierwsza kontrolka, wymagana:** „Kogo zgłaszasz?” — „Siebie” / „Moje dziecko lub podopiecznego” (`relation`);
  - imię i nazwisko zawodnika (wypełnione z kroku 2 **tylko przy „Siebie”**);
  - data urodzenia, płeć, waga, wzrost, rodzaj stopnia i stopień (zakresy jak `measureFields`);
  - **klub**: komponent `club-picker.js` (§10.4): jedna grupa radio „Z listy” / „Mojego klubu nie ma na liście” / „Niezrzeszony (bez klubu)” z polem odsłanianym dla wybranej opcji;
  - slot zgód (pusty);
  - przy „Siebie” i wieku < 16: komunikat „Osoby poniżej 16 lat rejestruje rodzic lub opiekun. Poproś go o założenie konta.” (ten sam co serwer; bez podpowiedzi zmiany odpowiedzi).
- **Wysłanie:** `signup` z `roles` i `athlete`; odpowiedź `notice:'club-pending'` pokazujemy po przeładowaniu.
- **Lądowanie po rejestracji** (zamiast `goChat()` na stałe): przeładowanie do `#signup?step=3` jak dziś (sesja potrzebuje nowego `me`), potem `mount('signup')`:
  - tryb płatny bez pełnego dostępu: krok „Plan” z etykietą liczoną z `me.caps`;
  - inaczej: zawodnik, który zaczął od turnieju (`t` w `sessionStorage`) → `#guest?t=<id>` z otwartym oknem zgłoszenia; zawodnik → `#starts`; organizator → `#tournaments` z kartą pierwszego uruchomienia (§10.4); pozostali → czat. Wspólna funkcja `landing(me, stored)`; przycisk „Później” w kroku „Plan” korzysta z niej zamiast `goChat()`.
- **Pomocnicze czyste funkcje** (`tests/account-ui.test.mjs`): `signupSteps(roles, paid)`, `athleteBody(f)`, `athleteError(f, today)`, `landing(me, stored)`, `roleName(me)`.
- **Karta „Dołącz” (`account-boot.js` `joinCard`)** dodaje korzyści „Zgłaszaj się do turniejów” i „Organizuj własne turnieje”. **`promo.js` `ACCESS`** (podgląd turnieju gościa): gdy turniej jest `open` i ma `selfEntry`, główny przycisk to „Załóż konto zawodnika i zgłoś się” (`#signup?as=athlete&t=<id>`), a tekst nie mówi „Konta klubów nadal zakłada Administrator turnieju”. Asercje promocji w `tests/i18n.test.mjs` (i `home-embed.test.mjs`, jeśli je obejmują) aktualizuje ten plasterek (wyjątek wymieniony wprost).

### 10.2 Profil → zakładka „Role” (`account-flow.js`)
Zakładki: Profil | **Role** | Subskrypcja | Bezpieczeństwo (`#profile?tab=roles`). Zawartość:
- pole „Organizator turnieju” (`roles`); przy blokadzie Admina wyłączone z tekstem „Administrator wyłączył tę rolę. Napisz na {support}.”;
- sekcja „Zawodnicy”: lista profili konta, „Dodaj zawodnika” (`#profile?tab=roles&add=1`), „Zmień dane”, „Archiwizuj”, „Usuń dane zawodnika” (okno z hasłem i opisem skutków §6.6);
- link „Moje starty”.

Po zmianie `loadMe({force:true})`; po włączeniu organizatora `Client.bootstrap()` (workspace dochodzi; może poprosić o hasło, §4.6).

### 10.3 Zawodnik: „Moje starty” i „Zgłoś się” (`dist/athlete-boot.js`, `dist/athlete-flow.js`, `dist/athlete-data.js`)
- **Strona `#starts`** (`registerPage` z `roles:['member']` i `visible:u=>!!u?.caps?.athlete`, `nav:'global'`, `order:15`):
  - przełącznik profili (gdy jest ich więcej niż jeden) i karta profilu (link „Zmień dane”);
  - **„Moje zgłoszenia”**: karty ze statusem §7.6, konkurencjami, kategorią, przyciskami „Zmień zgłoszenie” i „Wycofaj” (`canEdit`/`canWithdraw`; wycofanie z potwierdzeniem §7.3) oraz drabinką tylko do odczytu z wyróżnionym własnym miejscem (`ui.bracket`, §10.4);
  - **„Wycofane”**: nagrobki z `withdrawn`;
  - **„Otwarte turnieje”** z przyciskiem „Zgłoś się”, plakietką turnieju społeczności i wyjaśnieniem `minor-untrusted`.
- **Okno zgłoszenia:**
  - wybór profilu (gdy kilka);
  - konkurencje jako pola wyboru; niedozwolone dla wieku w dniu turnieju i konkurencje z już wylosowaną kategorią **są widocznym tekstem z powodem** (nie wyłączonymi polami pomijanymi przez czytniki ekranu), powiązanym przez `aria-describedby`;
  - podgląd kategorii („Kadeci · mężczyźni · do 45 kg”);
  - waga, wzrost i stopień z profilu, z polem „Zapisz też w profilu” (domyślnie zaznaczone);
  - **informacja o prywatności przy każdym turnieju**: „Dane zgłoszenia (imię i nazwisko, wiek, płeć, waga, wzrost, stopień, klub) zobaczą organizatorzy turnieju i Administrator MatBravo. W publicznej drabince widać tylko inicjały i klub.”; w turnieju społeczności dodatkowo „Organizator: {n}. Turniej społeczności — {organizator niepotwierdzony / potwierdzony} przez MatBravo.”;
  - pusty slot zgód; przycisk „Zgłoś się”.
- **Podgląd turnieju (`#guest?t=`) dla zalogowanego członka:** po `painted {view:'guest', memberPreview:true}` moduł montuje w `[data-athlete-cta]`: „Zgłoś się” (turniej na liście `open`), „Jesteś zgłoszony · Moje starty”, a dla członka bez profilu zawodnika „Dodaj dane zawodnika, aby się zgłosić” → `#profile?tab=roles&add=1&then=<t>`. Dla gościa CTA daje `promo.js` (§10.1).
- **402** prowadzi przez istniejące `payment-required` do `#billing`.

### 10.4 Organizator w istniejącym interfejsie (`dist/app.js`, `dist/registry.js`, `dist/me.js`, `dist/client.js`, `dist/club-picker.js`, `dist/chat.js`, `dist/chat-boot.js`, `dist/index.html`)
- Pomocnik `communityOnly(user)=user.role==='member'&&!user.caps?.organizer` zastępuje `member` w `shell`, `render`, odświeżaniu `#screen` i `rerenderLanguage`. Organizator dostaje „Turnieje” (nagłówek „Moje turnieje”), „Moi zawodnicy” (`database`), wydarzenie: przegląd, zgłoszenia, kontrola, drabinki, czat turnieju.
- **Potwierdzenie hasła:** `handleError` dla 401 z `code:'reauth'` otwiera okno hasła i po `organizer-unlock` ponawia żądanie raz (§4.6).
- **Odpytywanie `#screen`:** `Client.bootstrap({t, rev})`; odpowiedź `unchanged` nie przerysowuje ekranu.
- `registry`: `defaultPage(role,user)` (organizer → `tournaments`, pozostali członkowie → `chat`); `allows(def,role,user)` i `navItems(user)` respektują opcjonalne `visible(user)`.
- `chat-boot.js`: `event-chat` dostaje rolę `member` (pojawia się tylko z turniejem w workspace). `chat.js`: `o===2` wyświetla „Organizator (społeczność)”, `o===1` jak dziś „Organizator”.
- `tournamentsPage`:
  - przycisk „Nowy turniej” przez `canCreateTournament(user)`; teksty pustego stanu dla organizatora;
  - **karta pierwszego uruchomienia** organizatora (lista kroków: „Utwórz turniej → Udostępnij link do zapisów → Kontrola startowa w dniu zawodów”);
  - **filtr dla Admina i edytora**: „Wszystkie / Personelu / Społeczności / Ukryte” (edytor domyślnie „Personelu”); wybór „AKTYWNY TURNIEJ” grupuje turnieje (`optgroup`) według typu;
  - plakietki „Turniej społeczności”, „Organizator potwierdzony”, „Ukryty przez Administratora”;
  - przycisk **„Kopiuj link do zapisów”** (menedżer; `navigator.clipboard` z `location.origin + '/#guest?t=' + id`, komunikat „Link skopiowany.”, rezerwowo pole tekstowe do zaznaczenia);
  - punkt montażu `<span data-tournament-admin="${id}">` (wypełnia moduł Admina).
- `tournamentForm`:
  - organizator: nowy turniej domyślnie „Zapisy otwarte” i „Zawodnicy mogą zgłaszać się sami” zaznaczone; personel: domyślnie jak dziś (`draft`, pole niezaznaczone);
  - nowy opis: „„Zapisy otwarte” pozwalają dodawać zawodników klubom i, gdy zaznaczysz pole poniżej, samym zawodnikom.”;
  - przy `hidden` status zablokowany i baner z powodem; komunikaty limitów z serwera.
- `profileForm` dla organizatora (i personelu poza klubem): **`club-picker.js`** z listą `workspace.clubs` (bez scalonych; `unaffiliated` na górze); pole zgody opiekuna (§5.3) dla członka przy wieku < 16; `clubId` organizatora nigdy z `user.clubId`.
- **`club-picker.js`** (nowy, wspólny z `athlete-form.js`): grupa radio „Z listy” / „Mojego klubu nie ma na liście” / „Niezrzeszony (bez klubu)”. „Z listy” to combobox ARIA 1.2 (pole tekstowe z `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`; lista `role="listbox"` z opcjami niosącymi `data-id`; filtrowanie kluczem `clubKey`; strzałki, Enter, Escape, Home/End); poniżej 300 klubów natywny `<select>`. „Nie ma na liście” pokazuje podczas pisania dopasowanie po kluczu: „Czy chodzi o: {nazwa}?” z przyciskiem wyboru. Wynik: `{id}`, `{name}` albo `{none:true}`.
- `rosterPage`, `checkModal`: znaczniki §7.5; w `checkModal` dla zgłoszeń własnych pole „Klub” (§7.5). `entryForm` i `canEditEntry`: gdy profilu nie ma w `workspace.profiles` (zgłoszenie własne), dane z migawki. Wyświetlana nazwa klubu w zgłoszeniu: `clubName(a.clubId) || a.club`.
- `entryForm` dla editora i klubu w turnieju społeczności: ta sama informacja o prywatności co u zawodnika (§10.3).
- `ui` (`registry.provide('ui')`) zyskuje **`bracket(publicCategory, {highlight})`** zwracające `SafeHtml` (przez `trustedHtml` w `app.js`), używane przez „Moje starty”.
- `guestPage`: punkt montażu `<div data-athlete-cta></div>` w podglądzie gościa i członka.
- `index.html`: linki do `athlete.css` i `settings.css`; `app.js` importuje `athlete-boot.js` i `settings-boot.js` (tworzone puste w tym plasterku, wypełniane w fali 3).
- Logowanie demo: przyciski „Organizator (demo)” i „Zawodnik (demo)”; `navigate(registry.defaultPage(role, user))`. `me.js`: `demoMe` z `caps` i `athletes`.
- `client.js` (demo): **idempotentna aktualizacja zapisanego demo** w `read()`: dodaje klub `unaffiliated`, `verified:true` tam, gdzie brak, `selfEntry:false` i `rev:0` turniejom, `staffRev:revision`, konta `demo-organizer` i `demo-athlete` z profilem zawodnika (hasła liczy `init()` jak dla nowych kont). Filtry JS traktują `verified!==false` jako zweryfikowany.

### 10.5 Panel Admina (`dist/settings-boot.js`, `dist/admin-settings.js`, `dist/admin-clubs.js`, `dist/admin-members.js`)
- **`#settings` „Ustawienia”** (nav `admin`): sekcje §3.5 z historią zmian. Wartości z API do DOM przez `h`/`setHtml`. Okna decyzji (konta bezpłatne z grupami A i B, tryb testowy) przez `ui.modal`.
- **`#clubs` „Kluby”** (nav `admin`): tabela klubów z filtrami „Niezweryfikowane”, „Wszystkie”, „Scalone”, liczbą profili i twórcą (personel/członek); akcje „Zweryfikuj”, „Zmień nazwę”, „Scal z…” (także „Niezrzeszony”) przez `ui.commit('club.save'|'club.merge')`; sekcja „Oczekujące nazwy klubów” (`club.adopt`); uwaga: „Zgłoszenia zachowują dane z chwili zgłoszenia; publiczne drabinki pokazują bieżącą nazwę klubu.”.
- **Karty turniejów** (`[data-tournament-admin]` po `painted`): „Ukryj” z polem powodu i opcją „Wycofaj też zgłoszenia samych zawodników”, „Przywróć”, „Pokaż organizatora”, „Potwierdź organizatora” (społeczność).
- **`#members`**: plakietki „Organizator”, „Organizator — potwierdzony”, „Organizator — zablokowany”, „Zawodnik”, „Konto z okresu bezpłatnego”; filtry `organizers`, `organizers-pending` (z licznikiem `features.pendingOrganizers` jako plakietka pozycji menu), `athletes`, `free-signup`; akcje „Potwierdź organizatora”, „Odbierz / przywróć rolę organizatora” z polem „Ukryj też jego turnieje ({n})”; zaznaczanie wierszy i akcja zbiorcza „Zablokuj i ukryj turnieje”.

### 10.6 i18n PL/EN
Każdy nowy tekst to polski klucz `T()` z jednym wpisem EN w słowniku funkcji. **Wszystkie nowe słowniki rejestruje `data-domain` w fali 1** (w `dist/i18n.js` i w dokładnej liście `DICTIONARY_SOURCES` w `tests/i18n.test.mjs`), tworząc je puste, żeby plasterki tej samej fali nie kolidowały w jednym pliku:
- `dist/i18n/server-domain-en.js` (wypełnia `data-domain`), `server-settings-en.js` (`settings-backend`), `server-accounts-en.js` (`accounts-backend`), `server-athletes-en.js` (`athlete-backend`);
- `dist/i18n/organizer-en.js` (`organizer-frontend`), `athlete-en.js` (`athlete-frontend`), `settings-en.js` (`admin-frontend`);
- teksty kont w istniejącym `accounts-en.js` (`account-frontend`), członków w `members-en.js` (`admin-frontend`).

`data-domain` dopisuje też do `NOT_UI` moduły danych `athlete-view.js` i `athlete-data.js`, a do zakresu `tests/xss-scan.test.mjs` przyszłe moduły `athlete*`, `club-picker`, `settings-boot`, `admin-settings`, `admin-clubs` (wyrażenie, które jeszcze nic nie dopasowuje, jest poprawne). Kolizje kluczy muszą być puste.

### 10.7 Tryb demo
- `initialWorkspace()` (JS, `data-domain`): klub `unaffiliated` i `verified:true` dla klubów; `staffRev:1`; konta `demo-organizer` (`role:'member', organizer:true`) i `demo-athlete` (`role:'member'`); profil zawodnika `demo-athlete` (`ownerId`, 14 lat, `relation:'guardian'`, bez zgłoszeń); **`selfEntry:true` w `t-winter-2027`** (otwarty, przyszły; lista gościa i istniejące testy bez zmian).
- „Moje starty” i zgłoszenia w demo: `client.js` `athleteRequest(route,body)` → `athleteView()` z `athlete-view.js` i `execute(db,actor,'entry.self'|…)` (`athlete-frontend`).
- Rejestracja, Ustawienia i akcje serwerowe Admina w demo pokazują istniejący komunikat „Ta funkcja jest niedostępna w wersji demonstracyjnej.”.
- Zapisane wcześniej demo aktualizuje `client.js` (§10.4), więc komunikat o resecie danych demo nie jest potrzebny.

---

## 11. Bezpieczeństwo i privacy-by-design (lista kontrolna; każdy punkt ma test albo kontrolę)

**Zakres organizatora i dane dzieci**
- [ ] Organizator widzi w `bootstrap`/`command` wyłącznie własne turnieje, własne profile i własne zgłoszenia w cudzych turniejach. Test HTTP przeszukuje surowy JSON pod kątem imion, dat urodzenia i id zawodników z cudzych turniejów i z bazy personelu (0 trafień); `organizerSnapshot` ≡ pełne `publicData`.
- [ ] Edytor i przedstawiciel klubu nie widzą profili z `ownerId` ani profili organizatorów; w turniejach społeczności widzą tylko potwierdzone i tylko własne zgłoszenia; editor zgłasza tam tylko profile, które sam utworzył.
- [ ] Przedstawiciel klubu nie widzi zgłoszeń własnych zawodników ani zgłoszeń profili społeczności.
- [ ] `AthleteView` i `GuestView`: dokładne zbiory kluczy; w surowym JSON brak danych innych osób.
- [ ] Informacja o prywatności przy każdym zgłoszeniu (zawodnik, editor i klub w turnieju społeczności), z właściwym odbiorcą.
- [ ] Profil `self` poniżej 16 lat odrzucony bez podpowiedzi obejścia; profil dziecka od organizatora wymaga oświadczenia o zgodzie; sloty zgód puste (sesja prawna).
- [ ] Osoby poniżej 18 lat nie zgłaszają się same do turniejów niepotwierdzonych organizatorów; niepotwierdzone turnieje nie trafiają na stronę główną ani do lobby czatu.
- [ ] Ukrycie turnieju odbiera organizatorowi podgląd zgłoszeń własnych; `withdrawSelf` je usuwa.
- [ ] Usunięcie konta i `profile.forget`: wiersz `profiles` usunięty albo zanonimizowany (sprawdzane w bazie), operacja kończy się także przy drabinkach z wynikami; retencja po 24 miesiącach.
- [ ] Narzędzia organizatora wymagają hasła po 30 minutach bezczynności i co 12 godzin.
- [ ] Dane osobowe nigdy w URL.

**Przydział uprawnień i masowe przypisanie**
- [ ] `signup` przyjmuje z ról tylko `roles.organizer` i `roles.athlete`; `role`, `caps`, `organizer_*`, `ownerId`, `createdBy`, `hiddenBy`, `champion`, `self`, `createdAt`, `rev` są ignorowane (test sprawdza bazę).
- [ ] `roles` zmienia wyłącznie `users.organizer`; potwierdzenie organizatora tylko przez Admina.
- [ ] `command` dla członka: tylko `ORGANIZER_TYPES` i tylko z uprawnieniem organizatora.
- [ ] `Repository::rows()` pomija członków; komenda organizatora nie zmienia jego wiersza `users`.
- [ ] Wszystkie trasy `admin-*` sprawdzają rolę po stronie serwera (403).

**Wyliczanie i sondowanie**
- [ ] `public-clubs` zwraca tylko kluby zweryfikowane i niescalone; niezweryfikowane nazwy nie są publiczne także w drabinkach (`club:null`).
- [ ] Turniej roboczy, ukryty i nieistniejący daje bajtowo identyczny 404 dla członka; profil niedozwolony i nieistniejący też.
- [ ] Żadna trasa nie zdradza, czy konto ma profil zawodnika albo rolę organizatora (poza Adminem).
- [ ] **Świadome ryzyko:** rejestracja zdradza istnienie konta o danym e-mailu (409 ≠ sukces); limit duplikatów na sieć /64 (§3.7); pełne ukrycie wymaga potwierdzania e-mailem (B11).

**Nadużycia i dostępność**
- [ ] Limity z §3.7 i §5.4 mają testy; obejście przez `finished` przed datą jest odrzucane.
- [ ] Teksty od członków przechodzą `Text::clean` i `CONTACT`.
- [ ] Rewizje zakresowe: pętla organizatora i zgłoszenia zawodników nie powodują 409 w innych turniejach personelu (test HTTP).
- [ ] Rejestracja nie bierze blokady workspace (test: rejestracja z zawodnikiem przy trzymanej blokadzie `app_meta FOR UPDATE` z innego połączenia kończy się bez czekania).
- [ ] Wyłączniki w panelu działają natychmiast; `signup_force_off` ma pierwszeństwo.
- [ ] Ukrycie turnieju usuwa go z listy gościa, czatu i listy zawodnika.

**Integralność danych**
- [ ] `persist()` nie nadpisuje istniejącego klubu przy kolizji nazwy („Straße”/„Strasse”, „Kraków”/„Krakow”): 409, wiersz bez zmian (obie bazy).
- [ ] `seed-athletes --remove` nie usuwa profili społeczności.

**Konfiguracja i płatności**
- [ ] `Settings::effective`: test pełnej macierzy §3.3; test strażnik odczytów przełączników (§3.2).
- [ ] „Płatna” wymaga kontroli Stripe i decyzji o grupach A i B; konto założone przez Admina w trybie bezpłatnym po przełączeniu zachowuje dostęp albo jest objęte decyzją (test HTTP).
- [ ] Wycofanie zgłoszenia, `athlete-save`, `athlete-forget`, `athlete` i `me` działają bez pełnego dostępu w trybie płatnym; `athlete-entry` i komendy organizatora dają 402.

**Dane i logi**
- [ ] `account_audit`: `settings.save`, `organizer.*`, `tournament.hide`, `club.*`, `profile.forget`; czytelne w „Historii zmian”; bez e-maili osób.
- [ ] Logi wyjątków bez komunikatów PDO.
- [ ] CSP, `X-MatBravo-Client`, service worker: bez zmian.

---

## 12. Strategia testów

**Zasada zgodności PHP↔JS (doprecyzowana).** Dla każdej komendy porównujemy **status** i **znormalizowany stan** (id zastąpione tokenami w kolejności tworzenia; bez `activity[].time`, `createdAt`, czasów zgody i deklaracji; sloty losowań jako zbiory). **Komunikaty** porównujemy tylko dla nowych komend i nowych ścieżek błędów, które używają jednego wspólnego literału. Istniejące różnice komunikatów (np. `Możesz zgłaszać tylko własny klub.` vs `Możesz zgłaszać tylko zawodników swojego klubu.`, `Klub może zmienić Administrator.` vs `Klub zawodnika może zmienić Administrator.`, ostatni Administrator, duplikat zgłoszenia, archiwizacja, walidacja liczb) są listą znanych wyjątków w teście, bez zmiany tekstów w tej pracy. `account.password` jest wyłączone z porównania (JS nie ma go w `execute`). Pola tylko PHP (`organizers`, `flags`, `withdrawals`) są pomijane w normalizacji.

**Jednostkowe Node (bez bazy)**
- `tests/roles.test.mjs` (`data-domain`): pełna macierz §5.1–§5.2 dla wszystkich aktorów (admin, editor, club, organizer niepotwierdzony i potwierdzony, organizer zablokowany, właściciel profili, członek bez roli); tablica prawdy `outsideEntry`; limity i ich semantyka (`ORGANIZER_ACTIVE` bez roboczych i ukrytych, `finished` przed datą); `CONTACT` (przypadki wspólne); `entry.self` (losowanie, małoletni, trust) i gałąź właściciela `entry.remove`; `athlete.save` (próg wieku, limit profili, jeden `self`, blokada pól przy zgłoszeniach w toku); kluby (`clubKey` także cyrylica, `unaffiliated`, scalony, oczekująca nazwa przy limicie); zgłoszenie własne poprawiane przez menedżera (tożsamość z migawki, zmiana klubu); `club.*`; `tournament.hide` (powód, `hiddenFrom`, `withdrawSelf`, nagrobki); `stale` (tablica zakresów); `publicWorkspace` na aktora.
- `tests/engine.test.mjs`: `makeDraw` nie karze par `unaffiliated`; `clubConflicts`, `fingerprintCounts`.
- `tests/workspace.test.mjs`: znaczniki rewizji, `initialWorkspace` (`staffRev`, `selfEntry` w `t-winter-2027`); fala 2: aktualizacja zapisanego demo.
- `tests/athlete-ui.test.mjs`, `tests/account-ui.test.mjs` (kroki, `relation`, komunikat < 16, lądowanie, `roleName`), `tests/settings-ui.test.mjs` (tryby, grupy A/B, historia), `tests/members-ui.test.mjs` (plakietki, filtry, akcja zbiorcza), `tests/organizer-ui.test.mjs` (`communityOnly`, `defaultPage(role,user)`, `visible`, `club-picker` z klawiaturą, kopiowanie linku, okno hasła).
- `tests/registry.test.mjs`, `tests/i18n.test.mjs`, `tests/xss-scan.test.mjs`.

**Zgodność PHP↔JS (wymagana)**
- `tests/roles-parity.test.mjs` + `tests/php-bridge-roles.php`: sekwencje komend dla wszystkich aktorów w `Domain::execute` i JS `execute` (zasada wyżej); `publicData` vs `publicWorkspace` na bogatym zestawie; `Rules::makeDraw`/`sameClub`; `Domain::stale` vs JS.
- `tests/php.test.mjs`: dotychczasowe asercje bez zmian; `GuestView` ↔ `guest-view.js` z turniejem społeczności (rzadkie pola), klubem niezweryfikowanym i niezrzeszonymi.
- `tests/community.test.mjs`: `Clubs::key` ↔ `clubKey`.
- `tests/athlete-view.test.mjs` + `tests/php-bridge-athlete.php`: `AthleteView::project` ↔ `athlete-view.js`.
- `tests/settings.test.mjs` + `tests/php-bridge-settings.php`: `Settings::effective` (idempotencja, macierz), `normalize`, walidacja zapisu, test strażnik.

**HTTP** (`scripts/test-http.sh`, MariaDB 10.6 i MySQL 8.0 w CI). Każdy plik woła `fixture('reset-limits')` w `before()`.
- `tests/domain.http.test.mjs` (`data-domain`): kolizje nazw klubów przez `account.save` i `profile.save` (409, wiersz bez zmian, oba silniki); usunięcie profilu przez `persist` (zadanie fixture wołające `Domain`); znaczniki rewizji w bazie; `rollback-floor`; `install.php` z nowymi kolumnami (pośrednio: cały przebieg).
- `tests/settings.http.test.mjs`: brak wiersza; `off`→`free` (konto z `free-signup`); `free`→`paid` (atrapa Stripe; `stripe_not_ready`; `free_period_decision` z grupami A i B; konto założone przez Admina w trybie bezpłatnym; cykl płatna → bezpłatna → płatna; `requireFrom` < 14 dni → 422; `keep`); `degraded`; brak tabeli; nieaktualna wersja; nie-admin → 403; historia zmian.
- `tests/roles.http.test.mjs` (`accounts-backend`): rejestracja z rolami (atomowość, brak blokady workspace, oczekujący klub przy wyczerpanym limicie), masowe przypisanie, limit duplikatów e-maila; organizator (turniej, limity, `finished`, wstrzymanie publikacji, profil z nowym klubem i zgodą, zgłoszenie, kontrola z poprawą klubu, losowanie, wynik, `#screen` z `unchanged`); **izolacja rewizji** (pętla organizatora na limicie + `checkin.save` edytora w innym turnieju); globalny limit transakcji członków; potwierdzenie hasła (`reauth`, `organizer-unlock`); skan wycieków JSON; `roles`; Admin: potwierdzenie, odebranie roli z ukryciem, akcja zbiorcza, `ownerOf`, filtry, licznik; usunięcie konta zawodnika i organizatora (§6.6, wiersze w bazie); `accounts-cleanup` pomija konta z danymi społeczności; `community-retention`; lobby czatu bez niepotwierdzonych turniejów i `o:2`.
- `tests/athletes.http.test.mjs` (`athlete-backend`): `athlete-save` (próg wieku, limit profili, jeden `self`, blokada pól), `athlete`, `athlete-entry` (`open`; `closed` → 403; ukryty/roboczy/nieistniejący → identyczne 404; bez `selfEntry` → 403; po terminie → 403; ponownie → 409; kategoria z losowaniem → 409; małoletni u niepotwierdzonego → 409; niedozwolona konkurencja → 422); `athlete-withdraw`; nagrobki; `athlete-forget`; tryb płatny (`entry` 402, reszta 200); `public-clubs`; `seed-athletes --remove` z profilem społeczności w klubie demo → odmowa.
- `tests/migrations.test.mjs` i istniejące pliki HTTP: zielone bez zmiany asercji.

**Przeglądarka** (`tests/qa-browser.test.mjs`, Playwright; `integration-qa`): rejestracja z obiema rolami i „Moje dziecko” (390 px i desktop); organizator: nowy turniej (domyślnie otwarty), kopiowanie linku, zawodnik z nowym klubem (combobox klawiaturą), kontrola z poprawą klubu, `#screen`, okno hasła po bezczynności (zegar testowy); zawodnik: „Zgłoś się” z podglądu, „Moje starty”, wycofanie z potwierdzeniem, nagrobek; Admin: Ustawienia (wyłączona → bezpłatna, historia), Kluby (scalenie), ukrycie turnieju z powodem, potwierdzenie organizatora; PL/EN na każdej nowej stronie; brak poziomego przewijania; fokus po zmianie kroku; czytnik ekranu (role i nazwy dostępne) dla `club-picker` i okna zgłoszenia.

**Integracja** (`tests/integration.http.test.mjs`): kontrakty między plasterkami tej samej fali (`Settings::effective` w `RouteContext` i w trasach `accounts-backend`/`athlete-backend`, `Actors::of`, `Repository::transaction` z aktorem, `organizerSnapshot`, `Clubs::pick` w rejestracji).

**Budżet wydajności** (`integration-qa`): przy 5 000 profilach i 200 turniejach `load()` < 400 ms, `organizerSnapshot` < 50 ms, `bootstrap` `unchanged` < 20 ms (lokalnie, MariaDB 10.6); pomiar w `diagnostics`.

---

## 13. Wdrożenie i kroki właściciela

**Wdrożenie** idzie jednym scaleniem do `main` po `integration-qa`, w dzień bez zawodów (PLAN-CZAT D18). Pipeline robi kopię bazy, migruje 0007 i 0008, przełącza wydanie i weryfikuje. **Po wdrożeniu nic się nie zmienia** (brak wiersza `app_settings` → `config.php`: rejestracja wyłączona; istniejące konta członków nie włączą roli organizatora ani nie założą profilu zawodnika, dopóki rejestracja jest wyłączona, §18 B10). `min_client_api` zostaje `1`; zamiast tego migracja 0007 zapisuje `app_meta.rev_floor` (rewizja z chwili migracji), a `Domain::stale` uznaje każdą komendę z rewizją sprzed niej za nieaktualną, więc karta otwarta przed wdrożeniem dostaje 409 i odświeża widok, zamiast nadpisać zmianę, której nie widziała (§18 B8).

Kroki właściciela (kolejność):
1. **Załóż skrzynkę `hello@matbravo.com`** w panelu AfterMarket (albo przekierowanie) i wyślij próbną wiadomość.
2. **Zdecyduj o tekstach prawnych.** Rejestracja otwiera serwis dla dzieci i rodziców. Zalecamy sesję prawną (polityka prywatności, regulamin, zgoda opiekuna, okres retencji 24 miesiące) **przed** przełączeniem na „Otwarta, bezpłatna” (B1).
3. Scal do `main` w dzień bez zawodów. Sprawdź zielony deploy (`deploy-verify`).
4. Zaloguj się jako Administrator → **Ustawienia**: sprawdź adres pomocy; wybierz **„Otwarta, bezpłatna”**; wyloguj się i sprawdź jako gość kartę „Załóż konto” oraz rejestrację z polem „Zawodnik” na telefonie. **W każdym otwartym turnieju, w którym chcesz przyjmować zgłoszenia samych zawodników:** Ustawienia turnieju → zaznacz „Zawodnicy mogą zgłaszać się sami” (po migracji to pole jest wyłączone).
5. Na bieżąco (najlepiej codziennie): **Członkowie → „Do potwierdzenia”** (licznik przy menu): obejrzyj turnieje nowego organizatora i kliknij **„Potwierdź organizatora”**, jeśli wyglądają wiarygodnie (dopiero wtedy turniej trafia na stronę główną i przyjmuje zgłoszenia dzieci), albo **„Zablokuj i ukryj turnieje”**. **Kluby** (weryfikacja, scalanie, oczekujące nazwy). **Ustawienia → Historia zmian**.
6. Później Stripe (DEPLOY-PL.md „Stripe — konfiguracja krok po kroku”). Potem **Ustawienia → „Otwarta, płatna”** (zapis sam sprawdza Stripe) z decyzją o kontach (zostaw darmowe albo płatne od daty ≥ 14 dni).
7. Awaria: **Ustawienia → „Wyłączona”** (rejestracja) albo **„Publikowanie… wstrzymane”** (fala fałszywych turniejów). Gdy panel nie działa: `'signup_force_off'=>true` w `~/matdraw/shared/config.php` przez SSH.

**Dokumentacja** (`integration-qa`): README (role, macierz widoczności, potwierdzanie organizatorów); INSTALL-PL (Załącznik A, `seed-athletes` z klubami niezweryfikowanymi i nowym `--remove`); DEPLOY-PL (macierz §3.3, procedura nadużyć, `floor` 0007); HANDOFF (stan, pytania §15); VALIDATION (wyniki testów i budżet wydajności).

---

## 14. Plasterki implementacji

**Zasady wspólne** (jak PLAN-CZAT §12): zwarty styl repozytorium; polskie literały z EN w słowniku; bez nowych zależności; wszystkie dotychczasowe testy zielone bez zmiany asercji (wyjątki wymienione wprost w plasterku); `php -l` i `node --check` nowych plików; commity z atrybucją z instrukcji sesji; **nie edytować plików spoza listy plasterka**; nowe trasy, zadania i migracje tylko przez rejestry; `fixture('reset-limits')` w `before()` każdego pliku HTTP; jedno scalenie do `main` po `integration-qa`; kontrakty tej samej fali są wołane bezpośrednio, bo dostarcza je fala wcześniejsza (`Settings::effective`-zaślepka, `Actors::of`, `Clubs::pick`, `Repository::{transaction,organizerSnapshot,profileRow}`, `Domain::athleteFields`, słowniki i18n), i sprawdzane w `integration-qa`.

| id | Fala | Model / wysiłek | Zależy od | Najważniejsze pliki |
|---|---|---|---|---|
| `data-domain` | 1 | opus / xhigh | — | 0007, `Repository`, `Domain`, `Rules`, `GuestView`, `Clubs` (nowy), `Actors` (nowy), `Settings` (zaślepka), `workspace.js`, `engine.js`, `guest-view.js`, `profile-data.js`, `i18n.js` + wszystkie nowe słowniki, testy zgodności, `domain.http`, zakres `i18n`/`xss-scan` |
| `settings-backend` | 2 | opus / high | data-domain | 0008, `Settings`, `routes/settings.php`, `Config`, `Routes`, `RouteContext`, `Billing`, `config.example.php` |
| `accounts-backend` | 2 | opus / xhigh | data-domain | `index.php`, `routes/core.php`, `routes/accounts.php`, `Members`, `Accounts`, `Auth`, `Chat`, `jobs/accounts.php`, `jobs/community.php` (nowy) |
| `athlete-backend` | 2 | opus / high | data-domain | `AthleteView` (nowy), `routes/athletes.php`, `athlete-view.js`, `bin/seed-athletes.php` |
| `organizer-frontend` | 2 | opus / high | data-domain | `app.js`, `registry.js`, `me.js`, `client.js` (demo, `bootstrap` z parametrami), `club-picker.js` (nowy), `chat.js`, `chat-boot.js`, `index.html`, `workspace.css`, puste `athlete-boot.js`/`settings-boot.js`/`athlete.css`/`settings.css` |
| `account-frontend` | 3 | opus / high | accounts-backend, athlete-backend, organizer-frontend | `account-flow.js`, `account-boot.js`, `athlete-form.js` (nowy), `account.css`, `accounts-en.js`, `promo.js` |
| `athlete-frontend` | 3 | opus / high | athlete-backend, organizer-frontend | `athlete-boot.js`, `athlete-flow.js`, `athlete-data.js`, `athlete.css`, `athlete-en.js`, `client.js` (`athleteRequest`) |
| `admin-frontend` | 3 | opus / high | settings-backend, accounts-backend, organizer-frontend | `settings-boot.js`, `admin-settings.js`, `admin-clubs.js`, `settings.css`, `settings-en.js`, `admin-members.js`, `members.css`, `members-en.js` |
| `integration-qa` | 4 | opus / xhigh | wszystkie | testy integracyjne, przeglądarkowe i wydajności, przegląd bezpieczeństwa, dokumentacja, poprawki styków |

Pełne opisy, listy plików i kryteria akceptacji są w strukturalnym wyniku zadania (te same dane). Plik należy do jednego plasterka w danej fali. Pliki w dwóch falach: `Settings.php` (zaślepka w fali 1, implementacja w fali 2), `client.js` (fala 2: demo i parametry `bootstrap`; fala 3: `athleteRequest`), `tests/i18n.test.mjs` (fala 1: rejestracja słowników; fala 3: asercje promocji), `tests/workspace.test.mjs` (fala 1; fala 2 test aktualizacji demo w `organizer-frontend`), puste moduły i słowniki tworzone wcześniej i wypełniane przez właścicieli z późniejszej fali.

---

## 15. Pytania otwarte (żadne nie blokuje; kod przyjmuje odpowiedź domyślną, wartości są stałymi)

| # | Pytanie | Przyjęte domyślnie |
|---|---|---|
| O1 | Czy przedstawiciele klubów i edytorzy mogą zgłaszać swoich zawodników do turniejów organizatorów społeczności? | Tak, ale **tylko do turniejów potwierdzonych organizatorów**; editor tylko profile, które sam utworzył; z informacją o prywatności; widzą tylko własne zgłoszenia |
| O2 | Czy edytorzy nadal widzą wszystkie zgłoszenia w turniejach personelu (także zgłoszenia własne)? | Tak, bez zmian; mówi o tym informacja przy zgłoszeniu |
| O3 | Od jakiego wieku osoba może sama założyć własny profil zawodnika? | 16 lat (RODO art. 8 w Polsce); młodszych zgłasza rodzic lub opiekun; brzmienie i zgodę ustali sesja prawna |
| O4 | Czy turnieje organizatorów trafiają od razu na stronę główną? | **Zmienione:** tylko turnieje personelu i potwierdzonych organizatorów; pozostałe od razu pod własnym adresem i na liście zawodnika |
| O5 | Wartości limitów | 3 nowe turnieje na dobę, 10 opublikowanych nadchodzących, 50 nowych od niepotwierdzonych globalnie, 300 zawodników na dobę; kluby: 3 na konto i 30 globalnie na dobę (miękko) |
| O6 | Czy w trybie płatnym zawodnik musi płacić, żeby się zgłosić? | Tak; wycofanie, poprawa i usunięcie danych oraz podgląd zawsze bez opłaty |
| O7 | Usunięcie konta zawodnika: czy wyniki z zakończonych turniejów zostają z imieniem w migawce? | Tak (historia); profil anonimizowany albo usunięty; `profile.forget` i retencja zamieniają imię na inicjały |
| O8 | Usunięcie konta organizatora: co z jego turniejami? | Ukrywane (status roboczy, `hidden_by='system'`); jego profile usuwane albo anonimizowane |
| O9 | Samodzielne zgłoszenia w istniejących turniejach | Wyłączone po migracji (krok właściciela §13.4); nowe turnieje organizatorów włączone, personelu wyłączone |
| O10 | Czy przedstawiciel klubu widzi zgłoszenia własne zawodników, którzy wybrali jego klub? | Nie |
| O11 | Czy zawodnik widzi nazwę organizatora turnieju społeczności? | Tak („Imię I.”) |
| O12 | Czy „Płatna” może działać w trybie testowym Stripe? | Tylko z jawnym potwierdzeniem |
| O13 | Czy zawodnik może przejąć profil dodany wcześniej przez organizatora? | Nie w v1 |
| O14 | Teksty prawne przed otwarciem rejestracji | Zalecane przed „Otwarta, bezpłatna”; decyzja właściciela |
| O15 | Czy zawodnik może sam zaznaczyć „Mistrz Polski lub Europy”? | Nie |
| O16 | Wycofanie zgłoszenia po zamknięciu zapisów | Nie przez zawodnika; nieobecność oznacza organizator |
| O17 | Kilku zawodników na jednym koncie rodzica | **Zmienione: tak, do 5 profili** (jeden własny + dzieci); wartość 1 wyłącza tę możliwość bez zmiany modelu |
| O18 | Czy samodzielne zgłoszenia osób niepełnoletnich do turniejów niepotwierdzonych organizatorów są zablokowane do czasu potwierdzenia przez Admina? | Tak (`ADULT_AGE=18`) |
| O19 | Czy organizator (np. trener) może zgłaszać swoich zawodników do cudzych otwartych turniejów z samodzielnymi zgłoszeniami? | Tak, do turniejów personelu i potwierdzonych organizatorów; widzi tylko własne zgłoszenia |
| O20 | Okres retencji danych społeczności | 24 miesiące od ostatniego turnieju (do potwierdzenia w sesji prawnej) |
| O21 | Sesja narzędzi organizatora | Hasło po 30 minutach bezczynności i co 12 godzin, jak u personelu |

---

## 16. Rozstrzygnięcia po przeglądzie

Przegląd z 2026-11-01 zgłosił 55 ustaleń w trzech soczewkach. Każde sprawdziłem w kodzie. **Żadne nie jest błędne co do faktów.** Część poprawek przyjąłem w innym wariancie niż proponowany albo przyjąłem częściowo; powody są w kolumnie „Werdykt”. Numeracja: PS = bezpieczeństwo i prywatność, DR = regresje domeny, UX = interfejs i produkt.

### 16.1 Bezpieczeństwo i prywatność

| # | Waga | Ustalenie | Werdykt | Gdzie |
|---|---|---|---|---|
| PS-1 | blocker | Globalna rewizja wspólna z publicznymi zapisami: 409 przy stole kontroli | **Przyjęte, wariant (a) jako znaczniki „zmieniono przy rewizji N”** na turniejach, profilach i kontach personelu; kontrakt klienta bez zmian; globalny limit transakcji członków; test izolacji | R15, §5.8, §3.7, §12 |
| PS-2 | major | Rejestracja bierze globalną blokadę bez logowania | **Przyjęte:** walidacja przed transakcją, profil i klub w `Members::tx`. **Odrzucony** globalny limit prób rejestracji zawodnika: jedna osoba blokowałaby wszystkie rejestracje (ta sama zasada co istniejący hamulec), a blokady już nie ma | R19, §4.5 |
| PS-3 | major | Zbieranie danych dzieci przez fałszywe turnieje | **Przyjęte:** `community`/`trusted` w widokach i plakietka; blokada zgłoszeń osób < 18 lat u niepotwierdzonych; kolejka „Do potwierdzenia” z licznikiem; akcja zbiorcza; wyłącznik `organizers: paused`. **Odrzucony** wariant „konto starsze niż N dni” (napastnik po prostu czeka) | R16, §5.4–§5.6, §7.1, O18 |
| PS-4 | major | Obejście limitu przez `finished`, zalewanie listy, kontakty w nazwach | **Przyjęte:** limit liczy opublikowane nadchodzące w każdym statusie; `finished` od dnia turnieju; globalny limit dobowy; strona główna i lobby tylko dla potwierdzonych; `CONTACT` | §5.4, §5.6 |
| PS-5 | major | Dane dzieci od personelu trafiają do niezweryfikowanych organizatorów (O1) | **Przyjęte:** editor tylko własne profile, klub tylko swoje; dodatkowo tylko turnieje potwierdzonych; informacja w `entryForm` | §5.2, §5.7, §10.4, O1 |
| PS-6 | major | Długa sesja członka dla organizatora z danymi dzieci | **Przyjęte w wariancie potwierdzenia hasła** dla narzędzi (30 min / 12 h), bo zmiana rodzaju całej sesji skróciłaby też sesję czatu; podnoszenie `auth_version` niepotrzebne | R17, §4.6 |
| PS-7 | major | Brak usuwania i retencji danych dzieci od organizatorów | **Przyjęte:** `profile.forget`, anonimizacja profili organizatora przy usunięciu konta, zadanie retencji (24 miesiące, stała) | R18, §6.6–§6.7 |
| PS-8 | major | Brak haka zgody dla dzieci dodawanych przez organizatorów | **Przyjęte** dla organizatorów (personel decyzją sesji prawnej) | §5.3 |
| PS-9 | minor | Globalny limit klubów blokuje rejestracje | **Przyjęte:** zapis jako „Niezrzeszony” z oczekującą nazwą zamiast błędu | §6.3, §5.5 |
| PS-10 | minor | Niezweryfikowane nazwy klubów publiczne w drabinkach | **Przyjęte** przez złączenie z `clubs` przy odczycie (`club:null`). **Odrzucona** aktualizacja migawek przy `club.save/merge`: zmiana nazwy w migawce zmienia podpis losowania i usuwa albo blokuje drabinki | §5.5, §5.6 |
| PS-11 | minor | Kolizje slugów dla nazw nie-łacińskich | **Przyjęte:** klucz `\p{L}\p{N}`, co najmniej 2 znaki, lustro JS | §6.3 |
| PS-12 | minor | Plakietka „Organizator” dla niezweryfikowanych w czacie | **Przyjęte:** `o:2` i „Organizator (społeczność)” | §4.4, §10.4 |
| PS-13 | minor | `Settings::effective` zawodzi otwarcie przy pominiętym miejscu wywołania | **Przyjęte:** nakładka centralna w `Routes::dispatch`/`index.php`, test strażnik | §3.2 |
| PS-14 | minor | Dziennik przełączników nieczytelny | **Przyjęte:** „Historia zmian” i zapis starego i nowego adresu pomocy. **Odrzucone** hasło przy zmianie trybu: sesja Admina ma już 30 minut bezczynności, a dodatkowe hasło utrudnia pracę właścicielowi | §3.5 |
| PS-15 | minor | Różne komunikaty 404 zdradzają stan | **Przyjęte:** jeden literał dla turniejów i jeden dla profili, test bajtowy | §5.7 |
| PS-16 | minor | Ukrycie zostawia zebrane dane u organizatora | **Przyjęte:** utrata podglądu zgłoszeń własnych i opcja `withdrawSelf` | §5.2, §5.5 |
| PS-17 | minor | Informacja o prywatności tylko w turniejach społeczności | **Przyjęte:** przy każdym turnieju, z właściwym odbiorcą | §10.3 |
| PS-18 | minor | Wyliczanie e-maili przez rejestrację | **Przyjęte:** ryzyko opisane, limit duplikatów 5/h na /64 dający 429 dla każdego wyniku. **Odrzucony** globalny kubełek duplikatów: blokowałby rejestracje osób, które pomyliły adres | §3.7, §11, B11 |

### 16.2 Regresje domeny

| # | Waga | Ustalenie | Werdykt | Gdzie |
|---|---|---|---|---|
| DR-1 | major | `persist()` przy kolizji nazwy klubu nadpisuje inny klub zamiast 1062 | **Przyjęte** (dotyczy już dziś `account.save`): `INSERT` dla nowych, `UPDATE … WHERE` dla istniejących, mapowanie 1062, test „Straße”/„Kraków” na obu bazach; poprawione §2.4 | R5, §2.4, §4.3 |
| DR-2 | major | `DELETE` profilu w `forgetMember` przed usunięciem zgłoszeń nic nie usuwa | **Przyjęte:** `persist()` usuwa profile nieobecne w wyniku po zgłoszeniach, z kontrolą `rowCount`; test wiersza w bazie | §4.3, §6.6 |
| DR-3 | major | Usunięcie konta blokowane przez drabinki z wynikami | **Przyjęte:** reguła `detach` na poziomie kategorii z przechwyceniem `AppError`; usunięcie zawsze się kończy | §6.6 |
| DR-4 | major | Globalna rewizja: zapisy członków unieważniają formularze personelu | **Przyjęte razem z PS-1** | R15, §5.8 |
| DR-5 | major | Samodzielne zgłoszenie kasuje zapisane losowania | **Przyjęte:** odmowa przy kategorii z losowaniem; `drawn` w `AthleteView` | R8, §7.1, §7.4 |
| DR-6 | major | `bootstrap` organizatora ładuje całą bazę; limit 600/h zamraża ekrany hali | **Przyjęte:** `organizerSnapshot` z testem równoważności; `bootstrap?t&rev` → `unchanged`; limit 1500/h na sesję bez odpowiedzi `unchanged`; budżet przy 5 000 profilach | §4.3, §8.1, §3.7, §12 |
| DR-7 | major | Przełączenie na płatne odcina konta spoza znacznika `free-signup` | **Przyjęte:** zbiór decyzji z `Access::compute` (grupy A i B); znacznik także dla kont Admina w trybie bezpłatnym | R3, §3.4 |
| DR-8 | major | `seed-athletes`/`install.php` poza plasterkami; `--remove` kasuje profile społeczności | **Przyjęte:** `rows()` uzupełnia brakujące klucze (install bez zmian, sprawdzany w każdym przebiegu CI); `seed-athletes.php` w `athlete-backend` z klubami niezweryfikowanymi i bezpiecznym `--remove` | §4.3, §6.3, §14 |
| DR-9 | major | Dopasowanie klubów po slugu dla nazw nie-łacińskich | **Przyjęte razem z PS-11** | §6.3 |
| DR-10 | major | Zgodność PHP↔JS wymaga równych komunikatów, których dziś nie ma | **Przyjęte:** komunikaty porównywane tylko dla nowych ścieżek; istniejące różnice jako lista wyjątków; bez `account.password` | §12 |
| DR-11 | major | Zawodnik zmienia klub i datę urodzenia przy zgłoszeniach w toku | **Przyjęte, wariant (a)** dla zawodnika (409 przy zgłoszeniach `open`/`closed`) oraz zachowanie tożsamości z migawki przy poprawce zgłoszenia własnego przez menedżera; dotychczasowe zachowanie personelu bez zmian | §6.1, §5.7 |
| DR-12 | minor | `canEnter` blokuje wycofanie przez właściciela | **Przyjęte:** gałąź właściciela przed `canEnter`, testy `open` 200 / `closed` 403 | §5.7 |
| DR-13 | minor | Ukryte turnieje liczą się do limitu; przywrócenie gubi `finished` | **Przyjęte:** ukryte i robocze poza limitem; `hiddenFrom` przywracany | §5.4, §5.5 |
| DR-14 | minor | Zapisane demo bez aktualizacji | **Przyjęte:** idempotentna aktualizacja w `client.js` (także konta demo, więc komunikat resetu zbędny) | §10.4, §10.7 |
| DR-15 | minor | `selfEntry` domyślnie dla turniejów personelu | **Przyjęte:** domyślnie tylko dla organizatorów | R11, §5.7 |
| DR-16 | minor | Niepełna lista miejsc wywołania `effective` | **Przyjęte razem z PS-13** | §3.2 |
| DR-17 | minor | `floor` 0007 nie obejmuje klubów członków i scalonych | **Przyjęte** (kluby członków i scalone; kluby demo nie blokują) | §9.1 |
| DR-18 | minor | Polityka sesji organizatora | **Przyjęte razem z PS-6** | §4.6 |
| DR-19 | minor | Zgłoszenia personelu do turniejów społeczności bez informacji | **Przyjęte razem z PS-5** | §10.4 |

### 16.3 Interfejs i produkt

| # | Waga | Ustalenie | Werdykt | Gdzie |
|---|---|---|---|---|
| UX-1 | major | Rejestracja zakłada, że rejestrujący to zawodnik; komunikat podpowiada dziecku obejście | **Przyjęte:** nowy podpis, wymagane „Kogo zgłaszasz?”, wypełnianie imienia tylko dla „Siebie”, komunikat bez podpowiedzi, „Opiekun zawodnika” | §4.5, §6.1, §10.1 |
| UX-2 | major | Brak ścieżki dla rodzica kilku dzieci i trenera-organizatora | **Przyjęte jako decyzje z wartościami domyślnymi** (O17: do 5 profili; O19: organizator zgłasza własnych do cudzych otwartych turniejów z samodzielnymi zgłoszeniami); model obsługuje obie odpowiedzi stałymi | R7, §5.1, §5.7, O17, O19 |
| UX-3 | major | Po rejestracji wszyscy lądują w czacie | **Przyjęte:** `landing(me, stored)`, cel z `sessionStorage`, etykieta kroku z `me.caps`; nazwa `step=3` zostaje | §10.1 |
| UX-4 | major | Organizator tworzy niewidoczny szkic i nie ma jak udostępnić turnieju | **Przyjęte:** domyślnie „Zapisy otwarte”, karta pierwszego uruchomienia, „Kopiuj link do zapisów”, nowy opis formularza | §10.4 |
| UX-5 | major | Limit liczy szkice; jedyne wyjście to publikowanie śmieci | **Przyjęte:** szkice poza limitem i nowy komunikat. **Odrzucone** `tournament.remove` w v1: klucz obcy `chat_channels` do turniejów i historia dziennika; przełączenie na roboczy rozwiązuje problem | §5.4 |
| UX-6 | major | Organizator nie może poprawić klubu przy kontroli (D3) | **Przyjęte:** `clubId` w poprawce zgłoszenia własnego i pole „Klub” w `checkModal` | §5.7, §7.5 |
| UX-7 | major | Zawodnik nie widzi wycofania przez organizatora | **Przyjęte:** tabela `entry_withdrawals` i statusy w „Moich startach” | §7.4, §7.6, §9.1 |
| UX-8 | major | Informacja o prywatności niepełna | **Przyjęte razem z PS-17** (z informacją o publicznej drabince) | §10.3 |
| UX-9 | major | Teksty wejścia reklamują tylko czat i przeczą rolom | **Przyjęte:** `promo.js` i `joinCard` w `account-frontend`, nowy lead, CTA zawodnika w podglądzie | §10.1, §14 |
| UX-10 | major | Punkty montażu fali 3 w plikach, których nikt nie ma | **Przyjęte:** `data-athlete-cta`, `ui.bracket`, role `event-chat`, puste CSS i moduły w `organizer-frontend` | §10.4, §14 |
| UX-11 | major | `tests/i18n.test.mjs` pada w falach 1–2 | **Przyjęte:** `data-domain` rejestruje w fali 1 wszystkie nowe słowniki (osobny plik serwerowy na plasterek), `NOT_UI` i zakres `xss-scan` | §10.6, §14 |
| UX-12 | major | Wybór klubu: trzy niepowiązane kontrolki, brak dostępności | **Przyjęte:** `club-picker.js` (radio + combobox ARIA 1.2 albo `<select>`, „Czy chodzi o…?”), wspólny dla rejestracji i organizatora | §10.4 |
| UX-13 | minor | Demo bez `selfEntry` | **Przyjęte:** `t-winter-2027` z `selfEntry:true` | §10.7 |
| UX-14 | minor | Krok właściciela dla istniejących turniejów | **Przyjęte** (krok 4). Akcja zbiorcza „Włącz w otwartych turniejach” nie w v1 (kilka kliknięć, rzadka czynność) | §13 |
| UX-15 | minor | „Niezrzeszony” po polsku i w rodzaju męskim | **Przyjęte:** `club:''` w drabinkach, forma według płci, EN „Unaffiliated” | §5.6 |
| UX-16 | minor | Listy Admina i edytora zalane turniejami społeczności | **Przyjęte:** filtr i grupowanie; strona główna rozwiązana przez R16 | §10.4, §5.6 |
| UX-17 | minor | CTA członka bez profilu, wycofanie bez potwierdzenia, wyłączone pola | **Przyjęte** | §10.3, §7.3 |
| UX-18 | minor | Ukrycie bez powodu i bez następnego kroku | **Przyjęte:** `reason`, adres pomocy, komunikat dla zawodnika | §5.5, §7.4 |

### 16.4 Wpływ na plasterki
- `data-domain` przejmuje rejestrację słowników i zakresy testów i18n/xss, `Clubs.php`, znaczniki rewizji, zmiany `persist()`, `organizerSnapshot`, reguły usuwania i retencji w `Domain`.
- `athlete-backend` przejmuje `bin/seed-athletes.php`; `install.php` nie wymaga zmian dzięki uzupełnianiu kluczy w `rows()`.
- `accounts-backend` przejmuje `Auth.php` (potwierdzenie hasła), `Chat.php` (lobby, `o:2`) i `jobs/community.php`.
- `settings-backend` przejmuje `Routes.php` i `RouteContext.php` (nakładka centralna); `Chat::viewer` nie wymaga zmian.
- `organizer-frontend` przejmuje `client.js` (fala 2), `club-picker.js`, `chat.js`, `chat-boot.js` i punkty montażu.
- `account-frontend` przejmuje `promo.js` i asercje promocji w `tests/i18n.test.mjs`.
- `admin-frontend` dostaje `admin-clubs.js` i model opus (decyzje płatności i potwierdzanie organizatorów).

---

## 17. Ustalenia orkiestratora (2026-11-01, wiążące dla plasterków)

- **Potwierdzanie organizatorów (R16) jest przełącznikiem w panelu Admina, a nie stałą regułą.** Właściciel wybrał w D2 „pełną automatykę”, a R16 to ochrona dodana przez przegląd bezpieczeństwa. Dlatego `app_settings.data.organizers` dostaje pole `trustRequired` (bool, domyślnie `true`). Przy `trustRequired=false` każdy niezablokowany organizator działa tak, jak potwierdzony: jego turnieje trafiają na stronę główną i do lobby czatu i przyjmują samodzielne zgłoszenia osób niepełnoletnich; to jest pełna automatyka z D2. Odczyt wyłącznie przez `Settings::effective` (centralna nakładka, §3.2), tak samo w PHP (`Domain`/`Repository`) i w lustrze JS (demo). Wymaga to:
  - `data-domain`: funkcja „potwierdzony” uwzględnia `trustRequired`, z testem zgodności PHP/JS dla obu wartości;
  - `settings-backend`: zapis, walidacja i audyt pola;
  - `admin-frontend`: przełącznik „Wymagaj potwierdzenia organizatorów” z krótkim opisem skutków na stronie `#settings`.
- **Dane plasterków** (pełne opisy, listy plików, kryteria akceptacji) są w `docs/plan/PLAN-REJESTRACJA-ROLE.slices.json`; plasterek czyta swój wpis.
- **Adres pomocy:** `hello@matbravo.com` jako wartość startowa `supportEmail` (D4).
- **Decyzje właściciela z 2026-11-01 (po planie v2):**
  - **`organizers.trustRequired` ma domyślnie `false`**, czyli pełną automatykę (D2). Przełącznik w panelu zostaje na wypadek nadużyć.
  - **Jeden profil zawodnika na konto (`ATHLETES_PER_ACCOUNT = 1`).** Rodzaj profilu to nadal „ja” albo „moje dziecko/podopieczny”, dlatego pytanie „Kogo zgłaszasz?” zostaje, a komunikat dla osób poniżej 16 lat zakładających profil „ja” także. Interfejs nie pokazuje dodawania kolejnych profili. Kod może zachować model wielu profili, ale stała i walidacja serwera pilnują limitu 1.

- **Następne wydanie (zaplanowane) — NIE wchodzi do tego wdrożenia.** Decyzja właściciela z 2026-11-01: po usunięciu konta we **wszystkich** zachowanych wynikach zostają tylko inicjały zawodnika (zmiana O7). Usunięcie konta będzie działać jak `athlete-forget` dla każdego profilu, który należy do konta (inicjały w zgłoszeniach i wynikach także turniejów, które się odbyły). W tym wydaniu obowiązuje jeszcze stan z §18.2 R2.2: pełne imię i nazwisko zostaje w wynikach turniejów, które się odbyły, a pole „Zostaw w zachowanych wynikach tylko inicjały zawodnika” w oknie usunięcia konta (zaznaczone domyślnie) daje inicjały wszędzie już teraz.

- **Ustalenia z fali 2:**
  - **Korekta własnego zgłoszenia (R12).** `athlete-entry` z `update:true` dla istniejącego zgłoszenia własnego profilu, bez nowych konkurencji, działa bez pełnego dostępu. Nowa konkurencja albo nowy turniej to zgłoszenie, które w trybie płatnym daje 402.
  - **Pola kontraktu `me` i `public-config` (§4.4, §8.1)** są dostarczane zgodnie z planem. Asercje dokładnego zestawu kluczy w `tests/accounts.http.test.mjs` zaktualizowano świadomie (opcja A).
  - **Grupa B przy przejściu na płatne (§3.4)** nie obejmuje kont z subskrypcją bieżącego trybu ani kont, które Admin sam oznaczył jako płatne. Gdy płatność jest już wymagana, grupa B jest pusta.

## 18. Poprawki po przeglądzie końcowym (2026-11-01, grupa backend)

Przegląd końcowy (bezpieczeństwo, ustawienia i płatności, domena, wdrożenie, UX) potwierdził ustalenia B1–B11; B12–B19 to drobne. Rozstrzygnięcia po stronie serwera (lustro JS w `dist/workspace.js` i `dist/engine.js`, testy zgodności PHP/JS):

| # | Ustalenie | Rozstrzygnięcie |
|---|---|---|
| B10 | Istniejące konta członków dostawały role zaraz po wdrożeniu, przy rejestracji „Wyłączona” | `Settings::rolesOpen(effective)` = `signup_mode !== 'off'` (także `signup_force_off`). Przy zamkniętej: `roles {organizer:true}` i `athlete-save` bez `id` → 403 (`Role są dostępne po otwarciu rejestracji.`, §18.1 R1.4); wyłączenie roli, poprawki, wycofania i usuwanie danych działają zawsze. `me.features.rolesOpen` i `public-config.rolesOpen` (frontend ukrywa/blokuje zakładkę Role) |
| B1 | Organizator spoza turnieju kasował zapisane losowania (`reconcile`) wpisując albo wycofując swój profil | Reguła DR-5 (`Domain::keepDraws`) dla każdej zmiany zgłoszenia przez kogoś, kto nie zarządza turniejem: członek wszędzie, personel (edytor, klub) w turniejach społeczności. Menedżer i personel w turniejach personelu bez zmian (jak w a67ad42). Ścieżki usuwania danych: §18.1 R1.1 |
| B2 | Dwa darmowe konta organizatorów wyczerpywały globalny kubełek komendami-śmieciami | `MemberTx` (§3.7): globalny kubełek liczy tylko zatwierdzone zapisy, konto ma własne 30 transakcji na minutę, usuwanie i wycofanie nigdy nie czeka |
| B7 | Po `club.merge` konto klubu nie widziało i nie wycofywało zgłoszeń dawnego klubu | Odczyt migawek przez scalenia (`Clubs::roots`) w `entryVisible`/`sees`/`removeEntry`; migawki bez zmian (PS-10) |
| B9 | Rozdzielanie klubów w losowaniu porównywało nazwy z migawek | `Domain::drawAthletes` dodaje `clubKey` (klub po scaleniach; inaczej `name:`+klucz nazwy), `Rules::sameClub`/`sameClub` porównują go; `signature()` i zapisane losowania bez zmian |
| B8 | Po 0007 obiekty mają `rev=0`, więc karty sprzed wdrożenia omijały kontrolę nieaktualności | `app_meta.rev_floor` w 0007; `stale()`: rewizja poniżej progu → nieaktualna (§13) |
| B4, B16 | Zmiana kluczy Stripe w `config.php` przy płatnościach „płatnych” omijała kontrolę; cena w Stripe ≠ kwota dla gości | `stripeCheck.fp` = HMAC (`app_key`) z trybu, skrótu klucza, kluczy cen i kwot. `effective`: przy zapisanej kontroli, która nie przeszła albo dotyczy innej konfiguracji → rejestracja zamknięta, płatności wstrzymane, `settings_degraded='stripe-check'`, do udanego „Sprawdź Stripe” tej samej konfiguracji albo innej w tym samym trybie Stripe, a po zmianie trybu (test ↔ live) do bramki zapisu (§18.1 R1.2, §18.2 R2.4). Kontrola porównuje kwotę ceny z `billing_amounts` (`amount_mismatch`). `admin-settings.stripeCheck {ok, stale, checkedAt, mode}` |
| B5 | Płatną rejestrację w trybie testowym Stripe można było otworzyć bez potwierdzenia | Bramka zapisu obejmuje też otwarcie płatnej rejestracji (`off` → `on` przy „płatnych”); 409 `test_mode` z `confirmTestMode:true`, potwierdzenie `allowTestMode` (albo `confirmTestMode`); decyzja o kontach, gdy płatności nie są w tej chwili wymagane |
| B6 | `signup_force_off` nie zamykał tokenu zaproszeń | §3.3: sufit nad każdą samodzielną rejestracją; baner także w oknie testów |
| B3 | Usunięcie konta zostawia pełne imię w wynikach | Bez zmian: decyzja właściciela O7; ostrzeżenie i ścieżka do inicjałów w oknie usunięcia konta (frontend) |
| B11, B12 | Rada „cofnij wydanie” i komunikat strażnika „floor” | Komunikat podaje powód progu (2: konta członków, 7: dane społeczności) i ostrzega przed cofnięciem całego wydania; `DEPLOY-PL.md` opisuje poprawkę z zachowaniem migracji 0007–0009 |
| B14 | Limit organizatorów na sieć omijany równoległymi rejestracjami | Rezerwacja atomowa (`RateLimit::hit`) i zwrot (`RateLimit::refund`) przy nieudanej rejestracji lub zmianie roli; powyżej limitu duplikatów e-maili odpowiedź 429 zamiast 409 |
| B18 | Kluby tworzone przez edytora były niezweryfikowane | Klub nowy tworzony przez personel jest zweryfikowany (jak w a67ad42); przez członka nie |
| B19 | Usunięcie konta organizatora ukrywało turniej zakończony tego dnia | `forgetMember` pomija turnieje `finished` |

### 18.1 Runda 1 przeglądu poprawek (grupa backend)

| # | Ustalenie | Rozstrzygnięcie |
|---|---|---|
| R1.1 | `profile.forget`, `athlete.forget` i usunięcie konta (wymazania, poza budżetem `MemberTx`) omijały regułę B1: `detach` w turnieju otwartym wołał `reconcile` i kasował cudze losowanie | `Domain::detach($keep)`: wymazanie przez kogoś, kto nie zarządza turniejem (reguła `keepDraws` dla `entry.remove`; `forgetMember` działa jako usuwany członek, `retain` jako system), nie usuwa zapisanego losowania także w turnieju otwartym: zgłoszenie zostaje (z inicjałami przy `profile.forget`/`athlete.forget`), profil jest anonimizowany. Menedżer (Administrator wszędzie) bez zmian. Lustro `dist/workspace.js` |
| R1.2 | Udane ręczne „Sprawdź Stripe” wznawiało płatności po zmianie konfiguracji bez potwierdzenia trybu testowego i bez decyzji o kontach; chwilowa awaria Stripe przy zapisie wstrzymywała płatności wszystkim | `data.armed {fp, mode, at}` zapisuje tylko bramka zapisu (kontrola, `allowTestMode`, decyzja). `effective`: płatności działają tylko dla tej konfiguracji; ręczna kontrola wznawia je tylko dla niej, przy innej (test → live) daje `stripeCheck.rearm:true`. Wznowienie: zapis bez zmian przy wstrzymanych płatnościach przechodzi bramkę. Decyzja o kontach także, gdy płatności nigdy nie były zatwierdzone w panelu (tylko z pliku). Bez `armed` kontrola innej konfiguracji niż zapisana zapisuje `armed {fp:null}`. Wyniki `unavailable`/`error` nie zastępują udanej kontroli bieżącej konfiguracji ani nie powstają bez zapisanej kontroli |
| R1.3 | B8 zostawiło `min_client_api=1` (rewizja `rev_floor` zamiast wymuszonego przeładowania kart) | **Rozstrzygnięte (orkiestrator, 2026-11-01): `rev_floor` zastępuje podniesienie `min_client_api`.** `min_client_api` zostaje `1`, `CLIENT_API`, `Routes::MIN_CLIENT_API`, `config.example.php` i DEPLOY-PL bez zmian (dokumenty już to opisują): karty sprzed wdrożenia dostają 409 (nieaktualne) przez `rev_floor`, a nie wymuszone przeładowanie |
| R1.4 | Komunikat 403 B10 `Rejestracja jest chwilowo wyłączona.` zamiast `Role są dostępne po otwarciu rejestracji.` | **Zamknięte (§18.3).** Po scaleniu frontendu (wpis słownika `Role są dostępne po otwarciu rejestracji.`): `Members.php` (rola) i `routes/athletes.php` (nowy profil) oraz stała `CLOSED` w `tests/final-review.http.test.mjs`. Przed scaleniem test i18n odrzuciłby komunikat bez wpisu |
| R1.5 | Po `club.merge` frontend nie pokazuje kontu klubu przycisków dla zgłoszeń dawnego klubu | **Zamknięte (§18.3).** Frontend: `canEditEntry` (`dist/app.js`) i `dist/pwa.js` porównują korzeń klubu (`resolveClub`/`clubRoots` z `dist/workspace.js`), jak `entryVisible` |
| R1.6 | Dzieci można było zgłaszać do turniejów konta, które Administrator zablokował jako organizatora albo dezaktywował | `Domain::closedCreator`: turniej członka zablokowanego albo nieaktywnego (`Repository::organizers` podaje `active`) nie przyjmuje nowych `entry.self` ani nowych zgłoszeń z zewnątrz (§18.2 R2.1): 403 `Zapisy do tego turnieju są zamknięte.`; wycofania i poprawki działają, zaufanie i wyniki bez zmian. Lista otwartych turniejów zawodnika (`AthleteView`, lustro `dist/athlete-view.js`) jeszcze go pokazuje: do skoordynowanej zmiany z frontendem (**zamknięte, §18.3**) |

### 18.2 Runda 2 przeglądu poprawek (grupa backend)

| # | Ustalenie | Rozstrzygnięcie |
|---|---|---|
| R2.1 | R1.6 blokowało też wycofania i poprawki: `closedCreator` w `outsideEntry` (przez `canEnter`) dawało 403 `Zapisy są zamknięte.` klubom, edytorom i innym organizatorom w turnieju dezaktywowanego organizatora | `closedCreator` tylko dla nowych zgłoszeń: `entry.save` bez istniejącego zgłoszenia (`!$manager&&!$old`) i nowe `entry.self`; `outsideEntry`/`canEnter` bez zmian względem rundy 0, więc wycofania i poprawki (także `entry.self` z `update:true`) działają jak wcześniej. Lustro `dist/workspace.js`; test zgodności (klub, edytor, inny organizator, właściciel) i test HTTP |
| R2.2 | Usunięcie konta zostawiało pełne imię zgłoszenia zostawionego przez R1.1 w nadchodzącym turnieju (także dziecka) | `Domain::forgetProfile`: zgłoszenie, które zostaje w turnieju nadchodzącym (nie `finished`, data dziś lub później, jak w `forgetMember`), dostaje inicjały także bez `$initials` (usunięcie konta, retencja); pełne imię zostaje tylko w wynikach turniejów, które się odbyły (O7). Lustro w `dist/workspace.js` |
| R2.3 | Wznowienie płatności bramką zapisu po zmianie konfiguracji w tym samym trybie zawsze pytało o konta z okresu bezpłatnego, a obie odpowiedzi dawały darmowy dostęp kontom, które przed wstrzymaniem były za paywallem | Decyzja tylko, gdy ktoś mógłby stracić dostęp, który naprawdę miał: przejście z „bezpłatnych” na „płatne”, płatności nigdy niezatwierdzone w panelu (`armed` puste albo `{fp:null}`) albo zmiana trybu Stripe względem `armed` (konta z subskrypcją testową). Wznowienie w zatwierdzonym trybie nie pyta ani o konta, ani o tryb testowy (ten tryb bramka już potwierdziła). Gdy płatności były już „płatne”, grupa B (`Billing::freePeriodSet($had)`) obejmuje tylko konta, które miały pełny dostęp przy wymaganych płatnościach w którymkolwiek trybie Stripe (np. subskrypcja testowa po przejściu na live), nigdy konta, które były za paywallem |
| R2.4 | Kontrakt (b) („wstrzymane do udanej kontroli”) przestał być prawdziwy: po zmianie konfiguracji udane „Sprawdź Stripe” nie wznawiało płatności, a frontend nie czyta `rearm` ani nie wysyła zapisu bez zmian | Udana kontrola konfiguracji w tym samym trybie Stripe co `armed` (nowy klucz, ceny, kwoty) zatwierdza ją (`armed`) i wznawia płatności, jak w a67ad42; przy płatnościach wprost z pliku kontrola w tym samym trybie co zapisana też je wznawia. `rearm:true` zostaje tylko po zmianie trybu (test ↔ live) i bez zatwierdzonej konfiguracji: wtedy wznawia je ponowny wybór „Otwarta, płatna” (gdy jest już wybrana: najpierw „Wyłączona” z płatnościami istniejących kont). Do decyzji orkiestratora i frontendu: `stripeCheck.rearm` w kontrakcie (b) i zapis bez zmian w panelu, gdy `rearm` |

### 18.3 Domknięcie po integracji (2026-11-01, gałąź `claude/matbravo-roles-integration`)

Pozostałości po scaleniu grup backend i frontend (`75b1f0a`), zamknięte przed wdrożeniem:

| # | Pozostałość | Rozwiązanie |
|---|---|---|
| R1.3 | Decyzja o `min_client_api` | Rozstrzygnięte: `rev_floor` zastępuje podniesienie, `min_client_api` zostaje `1` (§18.1) |
| R1.4 | Komunikat B10 | `Members::roles` i `athlete-save` bez `id` przy zamkniętej rejestracji: 403 `Role są dostępne po otwarciu rejestracji.` (wpis EN już był, jeden); trasy rejestracji zostają przy `Rejestracja jest chwilowo wyłączona.`; stała `ROLES_CLOSED` w `tests/final-review.http.test.mjs` |
| R1.5 | Przyciski konta klubu po `club.merge` | `canEditEntry` (`dist/app.js`) i `tournamentToday` (`dist/pwa.js`) czytają klub zgłoszenia przez scalenia (`resolveClub`), jak `removeEntry`/`entryVisible`. Żeby klient miał z czego to odczytać, `Domain::publicData` (lustro `publicWorkspace`) daje kontu klubu także kluby scalone do jego klubu (z `mergedInto`); zablokowana lista klubów w formularzu kartoteki pokazuje tylko kluby żywe. Testy: zgodność PHP/JS, `tests/pwa-ui.test.mjs`, test przeglądarkowy demo w `tests/organizer-ui.test.mjs` |
| R1.6, R2.1 | Klient proponował nowe zgłoszenia, które serwer odrzuca (turniej organizatora zablokowanego albo dezaktywowanego) | Flaga widoku `entriesClosed` (tylko ona, bez stanu konta organizatora): w `publicData` dla tych, którzy turnieju nie prowadzą, i na każdej pozycji `open` w `AthleteView` (`build()` czyta `users.active` obok blokady). `closedCreator` bez `$db` czyta flagę; nowe `canAddEntry` (lustro w `dist/workspace.js`) ukrywa „Nowy zawodnik” i „Dodaj z bazy” i pokazuje `Zapisy do tego turnieju są zamknięte.`; „Moje starty” i podgląd turnieju pokazują to samo zamiast „Zgłoś się” i nie proszą o dane zawodnika. „Edytuj”/„Wycofaj” oraz `canEdit`/`canWithdraw` własnych zgłoszeń bez zmian. Widoki gościa bez zmian |
| F2 po R2.2 | Ostrzeżenie przy usuwaniu konta | `dist/account-flow.js` i okno usuwania w Członkowie (`dist/admin-members.js`): zgłoszenia do nadchodzących turniejów są wycofywane, a po zapisanym losowaniu zostają w nich inicjały; pełne imię i nazwisko zostaje tylko w wynikach turniejów, które się odbyły (widzą je organizator turnieju i MatBravo, goście inicjały). Pole „tylko inicjały” bez zmian |

## Załącznik A. Nowe ustawienia

**`config.php` (opcjonalne, w `Config::DEFAULTS`):**
- `signup_force_off` (`false`): awaryjne zamknięcie rejestracji ponad ustawieniem w panelu.

Klucze `signup_enabled`, `signup_free_beta`, `billing_enforce` i `support_email` są od teraz **wartościami startowymi** do pierwszego zapisu w panelu. `billing_enabled`, `billing_mode` i klucze Stripe zostają wyłącznie w `config.php`.

**`app_settings.data` (panel Admina):** `signup`, `payments`, `organizers`, `supportEmail`, `stripeCheck` (§3.1). Limity są stałymi w kodzie (O5).

## Załącznik B. Ryzyka i ograniczenie

| # | Ryzyko | Ograniczenie |
|---|---|---|
| B1 | Otwarcie rejestracji dla dzieci i rodziców bez polityki prywatności i regulaminu | minimalizacja, haki zgody i relacji, retencja; zalecenie sesji prawnej przed „Otwarta, bezpłatna” (O14); wyłączniki w panelu |
| B2 | Każda komenda ładuje cały workspace pod globalną blokadą | rewizje zakresowe (brak fałszywych 409), globalny limit transakcji członków, `organizerSnapshot` i `unchanged` dla odczytów, rejestracja bez blokady; budżet przy 5 000 profilach; częściowe ładowanie dla komend jako etap 2 |
| B3 | Złożone reguły widoczności (dwie implementacje) | jedna macierz §5.2, tablica prawdy `outsideEntry`, testy zgodności, skan wycieków |
| B4 | Nadużycia: obraźliwe nazwy, spam turniejów, fałszywe kluby | limity, `Text::clean`, `CONTACT`, potwierdzanie organizatorów, wstrzymanie publikacji, ukrywanie, kluby niezweryfikowane poza listą i drabinkami |
| B5 | Przełączenie na płatne odcina członków | zbiór decyzji z `Access::compute`, 14 dni wyprzedzenia, 7 dni karencji, kontrola Stripe |
| B6 | Konfiguracja Stripe znika przy trybie płatnym | `effective`: rejestracja zamknięta, dostęp otwarty, baner |
| B7 | Powrót do starego kodu ujawniłby dane społeczności | `floor` migracji 0007 |
| B8 | Organizator wpisuje dane dzieci bez weryfikacji tożsamości | widoczne tylko dla niego i Admina; oświadczenie o zgodzie opiekuna; retencja; Admin odbiera rolę i ukrywa turnieje; sesja prawna (rola organizatora jako współadministratora) |
| B9 | Fałszywe turnieje zbierające dane dzieci przez samodzielne zgłoszenia | potwierdzanie organizatorów (R16): bez strony głównej, lobby i zgłoszeń osób < 18 lat; plakietka; utrata danych przy ukryciu |
| B10 | Kolizje nazw klubów przez collation | klucz `Clubs::key`, `INSERT` zamiast upsert, 1062 → 409 |
| B11 | Rejestracja zdradza istnienie konta o danym e-mailu | limit duplikatów na sieć; pełne ukrycie dopiero z potwierdzeniem e-mailem (po SMTP) |
| B12 | Potwierdzanie organizatorów wymaga codziennej uwagi Admina | licznik przy menu, kolejka, akcja zbiorcza; turnieje działają pod własnym adresem także bez potwierdzenia |
