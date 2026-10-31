# Plan wdrożenia: czat, płatne konta z profilami i PWA — MatBravo

**Status:** plan docelowy do realizacji przez subagentów (fale 1–5), **wersja 2 po przeglądzie trzech recenzentów** (bezpieczeństwo i prywatność, hosting i operacje, regresje i kompletność; rozstrzygnięcia w §14). **Data:** 2026-10-31. **Rola autora:** główny architekt.
**Gałąź:** `claude/quirky-einstein-sgelzm`, baza `b1a8fd0`.
**Źródła:**
- raporty `docs/plan/research/01-code-map.md`, `02-realtime.md`, `03-stripe.md`, `04-pwa-infra.md` i `05-ux-design.md`;
- makieta `docs/plan/mockups/home-chat.html`;
- mój przegląd kodu: `backend/public/api/index.php`, `Auth.php`, `Repository.php`, `Domain.php`, `schema.sql`, `bootstrap.php`, `install.php`, `deploy.yml`, `deploy-remote.sh`, `build-php.mjs`, `tests/i18n.test.mjs`;
- próba wszystkich migracji SQL z tego planu na lokalnej MariaDB 10.11.

**Który dokument rozstrzyga.** Ten dokument ma pierwszeństwo przed raportami. Raporty 02–05 obowiązują w szczegółach, do których plan odsyła (np. „05 §19”: teksty interfejsu). Wyjątkiem są miejsca oznaczone **[nadpisuje NN §x]**.

**Kod a dokumentacja.** Identyfikatory, trasy, SQL i kod są po angielsku. Komunikaty interfejsu są polskie i służą jako klucze `T()`, a angielskie wersje leżą w słownikach.

**Legenda oznaczeń:**
- **[zweryfikowane]**: sprawdzone w tym repozytorium lub kontenerze;
- **[do weryfikacji]**: musi zostać potwierdzone na serwerze web9, w panelu Stripe albo na prawdziwym urządzeniu.

---

## Środowisko (prośba właściciela: przejście z „Default” na środowisko tego repozytorium)

Zmiana środowiska **nie jest problemem** dla tej pracy [zweryfikowane ponownie 2026-10-31 w nowym środowisku]:
- Node 22.23 działa.
- PHP 8.3.6 działa, z rozszerzeniami gd (z WebP), curl, fileinfo, exif, intl, sodium i pdo_mysql.
- MariaDB 10.11.14 działa jako usługa.
- Wszystkie testy przechodzą: 31 testów jednostkowych, 5 testów PHP i 2 testy HTTP. `git push --dry-run` także działa.

Cztery rzeczy, o których warto wiedzieć:
1. `gh` CLI nie działa, bo ma nieważny `GH_TOKEN` (nadal, także w nowym środowisku). Subagenci używają `git` oraz narzędzi `mcp__github__*`.
2. Remote to `eMCe71/MatDraw`, a `HANDOFF.md` i dokumenty deployu mówią o `Meducase/MatDraw`. Właściciel musi wskazać repozytorium, które ma sekrety środowiska `production` (pytanie P1 w §13). Ta niezgodność nie blokuje implementacji.
3. Na serwerze CLI trzeba wywoływać przez `/usr/local/php83/bin/php`. W kontenerze tej ścieżki nie ma; jest `/usr/bin/php`.
4. **Katalog `docs/` (ten plan, raporty 01–05 i makieta) jest nieśledzony w git** (`git status` pokazuje `?? docs/`). Kontener nowego środowiska odtwarza się z repozytorium, więc pliki nieśledzone mogą przepaść przy kolejnej sesji. **Pierwszy krok orkiestratora przed falą 1:** zatwierdzić `docs/plan/` na gałęzi roboczej (bez push do `main`). Z tego samego powodu harness testów HTTP ze scratchpada (`run-http-test.sh`) zastępuje skrypt w repozytorium `scripts/test-http.sh` (plasterek `backend-data`, fala 1).

Poza punktem 4 nic w repozytorium nie wymaga naprawy z powodu zmiany środowiska.

---

## 0. Podsumowanie decyzji

| # | Decyzja | Uzasadnienie |
|---|---|---|
| D1 | **Czas rzeczywisty: adaptacyjny short polling (`fetch`).** Każdy kanał ma licznik zmian `rev`, a klient wysyła ostatni znany `rev` jako kursor. Gdy nic się nie zmieniło (także w licznikach nieprzeczytanych kanałów w tle), serwer odpowiada `204`. Goście korzystają z trasy bez sesji, z cache 2 s. Członkowie korzystają z trasy, która tylko odczytuje sesję (`read_and_close`, bez tworzenia plików i bez blokady). Przeglądarka ma jeden poller na wszystkie karty. Interwał wynosi 2,5 s tylko przy **interakcji użytkownika** w ostatniej minucie i rośnie do 5/10/30/60 s przy bezczynności; nowa wiadomość przyspiesza odpytywanie do 2,5 s tylko wtedy, gdy była interakcja w ciągu 5 min (inaczej najwyżej o jeden poziom, nigdy poniżej 5 s). W karcie w tle polling się zatrzymuje. Błędy obsługuje wykładnicze ponawianie z losowym rozrzutem, z poszanowaniem `Retry-After`. Klient zgłasza serwerowi odpowiedzi 429/503/508 hostingu, a Admin widzi ich liczbę w panelu. Interwały i wyłącznik da się zmienić zdalnie. | Hosting ma 16 procesów PHP, nie pozwala na demony i limituje czas procesu do 120 s. Long polling, SSE i WebSocket zajmowałyby jeden proces na czytelnika, więc **odrzucamy je** (02 §3). Short polling wystarcza dla kilkuset czytelników jednocześnie (bezczynne zapytanie: 2–4 zapytania po kluczu, §5.4). Limity żądań hostingu są nieznane, więc kadencja musi maleć sama, gdy nikt nie patrzy, a Admin musi widzieć, że hosting zaczyna odmawiać. Etap 2 („statyczny beacon”) i etap 3 (zewnętrzny push tylko z sygnałem) są zaprojektowane, ale **nie wchodzą w to wdrożenie** (§5.11). |
| D2 | **Pomysł z iframe:** zachowujemy rytm „co ok. 2 s”, ale odświeżamy dane, nie stronę (§0.1). | Pełna strona przeładowywana co 2 s to ok. 30 renderów na minutę na każdą kartę i ok. 50 MB transferu na godzinę. Gubiłaby też przewinięcie, wpisany tekst i dostępność. |
| D3 | **Jedna tabela `users` dla wszystkich kont i nowa rola `member`.** Wartość dopisujemy na końcu ENUM, a `club_id` staje się NULL. Daje to jedno logowanie i jeden unikalny e-mail. **Członkowie nigdy nie trafiają do workspace turniejowego:** zapewnia to filtr w `Repository::load()`, jawne INSERT/UPDATE dla `users` w `persist()` oraz strażnik w trasach `command` i `bootstrap`. | Unikamy dwóch ścieżek logowania i ręcznego sprawdzania unikalności e-maili między tabelami. Tysiące członków nie spowolnią operacji turniejowych i nie dostaną praw z negatywnych testów ról w `Domain`. |
| D4 | **Krytyczna poprawka w `Repository::persist()`.** Wiersze `users` zapisujemy jawnym `INSERT`/`UPDATE`, nigdy przez `ON DUPLICATE KEY UPDATE`. | **[zweryfikowane na MariaDB 10.11]** Upsert nowego konta personelu z e-mailem istniejącego członka **przejmuje wiersz członka**: zmienia mu `id`, rolę i hasło. Jeśli członek ma już wiersze zależne, upsert kończy się błędem FK 1451 (500). Poprawka jest warunkiem wprowadzenia roli `member`. |
| D5 | **Czat, płatności i profile nie przechodzą przez `Repository::transaction()` ani `snapshot()`.** Mają osobne tabele, lekkie zapytania po indeksach i blokadę wiersza kanału zamiast globalnej blokady `app_meta`. | Każda wiadomość serializowałaby inaczej całą aplikację i unieważniała otwarte formularze (globalny `revision`). |
| D6 | **Goście i niepłacący nie dostają żadnej tożsamości**: ani imienia, ani inicjałów, ani id. Definiuje to `ChatGuestView`, czyli jawna lista dozwolonych pól, jak w `GuestView`. „Rozmycie” to zaprojektowany placeholder w CSS. Wariant dekoracji placeholdera (`g`) i znacznik „ten sam autor co poprzednio” (`c`) pozwalają gościowi pogrupować wypowiedzi jednej osoby **najwyżej w obrębie jednego kanału i jednego dnia** (5 wariantów); to świadomy kompromis na rzecz czytelności (§5.4). | Rozmycie samym CSS zostawiłoby dane w JSON. Inicjały w małej społeczności, gdzie wielu zawodników jest niepełnoletnich, pozwalają kogoś rozpoznać (05 §6.1). |
| D7 | **Płatności przez hostowane Stripe Checkout i Customer Portal, wołane czystym cURL** (bez SDK, Composera i Stripe.js; **bez zmiany CSP**). Są dwie ceny pod kluczami `matbravo_monthly_pln` i `matbravo_monthly_usd`. **Stan subskrypcji jest poprawny bez webhooków**, bo pobieramy go ze Stripe (§6.3). | Hosting najpewniej blokuje przychodzące webhooki, bo odpowiada 403 adresom z centrów danych. Formularz karty zostaje u Stripe (PCI SAQ A). |
| D8 | **Kto płaci (wymaganie 4: konta są płatne, darmowe tylko z decyzji Admina).** Konto zarejestrowane samodzielnie (`member`) jest płatne. Nowe konto personelu zakładane przez Admina jest **domyślnie płatne**; przełącznik „Darmowe konto” robi wyjątek. Istniejące konta (admin/editor/club) migracja oznacza jako darmowe **przejściowo** (`grandfathered`); Admin może przełączyć je na płatne od wybranej daty, z banerem 14 dni wcześniej i 7-dniową karencją (§3.2; pytanie P2 jest bramką startu). Personel bez pełnego dostępu zachowuje **podgląd** workspace i zmianę hasła, ale nie zapisze zmian. Wdrożenie sterują przełączniki `signup_enabled`, `billing_enabled`, `billing_enforce` i token zaproszeń `signup_invite_token` (macierz w §6.10). | Spełnia wymaganie 4 dosłownie. Kluby nie tracą dostępu z dnia na dzień, także w dniu zawodów. Token zaproszeń pozwala przetestować pełny przepływ na produkcji bez otwierania rejestracji dla wszystkich. |
| D9 | **Profile w tabeli bocznej `user_profiles`.** Na zewnątrz widać tylko nieprzezroczysty `public_id`. Lista krajów ISO-3166 (plus XK) jest statyczna, z nazwami PL/EN; w PHP leżą same kody. Sporty to stała lista wartości. | `Repository::load()` czyta `SELECT * FROM users`, a tabela boczna nie zmienia mapowania workspace. Statyczna lista daje identyczną walidację po obu stronach i identyczny wygląd w każdej przeglądarce. |
| D10 | **Awatary.** Przeglądarka przycina zdjęcie na `canvas` (bez `blob:`, który blokuje CSP). Serwer rozpoznaje format po zawartości i koduje obraz od nowa przez GD do WebP albo JPEG, co usuwa EXIF. Bez GD zdjęcia są wyłączone (zostają inicjały); nie ma ręcznego parsera plików. Pliki leżą w `~/matdraw/shared/uploads/avatars/<public_id>/`, więc dwie osoby nigdy nie dzielą pliku. Serwuje je PHP z kontrolą dostępu: widzą je tylko osoby z pełnym dostępem i właściciel. Inicjały pozostają domyślne; zdjęcie pojawia się tylko w czacie i profilu. | Deploy kasuje cały docroot przy każdym wdrożeniu. Reguła marki zostaje zachowana: brak zdjęć w tabelach, drabinkach i wydrukach. |
| D11 | **Strona główna: koncepcja A „Live centre”** (05 §2). Na desktopie i tablecie środkowa kolumna to czat na żywo, a logowanie zostaje tam, gdzie jest. Na telefonie jest karta podglądu i pełnoekranowa trasa `#chat`. | Czat jest dobrze osadzony na stronie, a powracający przedstawiciele klubów nie tracą formularza logowania. |
| D12 | **Frontend: rejestr `dist/registry.js` i jednorazowe haki w `app.js`.** Każdy moduł funkcji ma własny plik CSS i własny słownik EN (`dist/i18n/*-en.js`), a `i18n.js` scala słowniki. Test i18n zostaje uogólniony. | `app.js` ma 96 KB i bardzo długie linie. Bez rejestru równoległe plasterki stale by się konfliktowały. |
| D13 | **Backend: rejestr tras `backend/routes/*.php`** z trybami dostępu `public`, `peek`, `session`, `upload` i `webhook`. Dochodzi autoloader klas i rejestr zadań `backend/jobs/*.php`. Cron nie jest potrzebny: zadania uruchamiają się „przy okazji” zwykłych żądań, po wysłaniu odpowiedzi i po zwolnieniu blokady sesji. **Dane osobowe nigdy nie trafiają do adresu URL** (wyszukiwanie członków i sprawdzanie nazwy użytkownika idą w ciele POST), więc nie lądują w logach dostępu hostingu. | Pojedynczy kontroler z drabinką `if` nie skaluje się na ok. 30 tras. Dostępność crona na hostingu jest niepotwierdzona. |
| D14 | **Migracje** (`bin/migrate.php` i `backend/migrations/NNNN_*.php`) z wersją w `app_meta.schema_version`. Migracje wyłącznie dodają. Deploy najpierw robi kopię bazy, potem migruje, a dopiero na końcu przełącza wydanie. Strażnik rollbacku nie pozwala wrócić do kodu, który nie zna danych. | `install.php` nie jest migratorem. Rollback cofa tylko kod, a baza zostaje. |
| D15 | **PWA.** Manifest istnieje w wersji PL i EN. Service worker trzyma wersjonowany precache, a numer wersji nadaje build. Worker nigdy nie dotyka `api/`. Aktualizacja następuje dopiero po kliknięciu (wyjątek: wymagana aktualizacja przy zmianie kontraktu API, D19). Zachęty do instalacji pojawiają się po realnym użyciu, nigdy przy pierwszej wizycie. Web Push jest poza v1. | Zgodnie z 04 i 05 §13, przy zachowaniu CSP `'self'`. |
| D16 | **Sesje członków trwają dłużej**: 14 dni bezczynności, 30 dni maksymalnie. Mają własny katalog sesji `shared/sessions`, który sprząta `housekeeping` według rodzaju sesji (anonimowe po 3 h, personel po 12 h, członkowie po 14 dniach bez aktywności). Trasy `peek` nie tworzą plików sesji, nie wysyłają `Set-Cookie` i odświeżają aktywność najwyżej raz na 1/4 limitu bezczynności. Sesje personelu bez zmian: 30 min / 12 h. | Członek w aplikacji na telefonie wylogowywany co 30 minut zniweczyłby sens PWA (04 §4.2). Własny katalog chroni sesje przed obcym sprzątaniem plików na hostingu, a sprzątanie według rodzaju chroni limit i-węzłów konta. |
| D17 | **v1 bez wysyłki e-maili.** Hasło resetuje Administrator według procedury z §3.10: prośba musi przyjść z adresu konta, hasło tymczasowe wraca **wyłącznie na adres zapisany w MatBravo**, a po zalogowaniu interfejs wymusza zmianę hasła. Adres pomocy (`support_email`) jest warunkiem włączenia rejestracji. Paragony i powiadomienia o płatnościach wysyła Stripe. E-maile wejdą w etapie 2. | Na serwerze nie ma SMTP. Bez procedury reset „na prośbę” byłby drogą do przejęcia konta. Pytanie P8 dotyczy kanału e-mail. |
| D18 | **Jedno scalenie do `main`.** Plasterki scalamy do gałęzi integracyjnej (`claude/quirky-einstein-sgelzm`); `main` dostaje **jedno** scalenie po `integration-qa`. Aplikacja broni się też sama: brak tabeli albo kolumny (kod nowszy niż baza) daje 503 „Trwa przerwa techniczna”, a nie 500. | `deploy.yml` wdraża każdy push do `main`. Fala 1 bez kroku migracji we wdrożeniu (który dochodzi w fali 4) wywróciłaby logowanie wszystkim klubom. |
| D19 | **Minimalna wersja klienta.** Klient wysyła nagłówek `X-MatBravo-Client: <n>`. Serwer odrzuca kontrakt starszy niż `min_client_api` kodem 409 `client_outdated`, a PWA wtedy sama stosuje oczekującą aktualizację, gdy nic nie jest w trakcie edycji (inaczej pokazuje pasek blokujący). | Service worker z „najpierw cache” i aktualizacją na kliknięcie zostawiałby stare `app.js` wobec nowego API bez końca. |

### 0.1 Odpowiedź na pomysł właściciela: „czat w iframe odświeżanym co 2 sekundy”

Pomysł jest trafny w najważniejszym punkcie. Na tym hostingu „sprawdzaj co chwilę, czy jest coś nowego” to właściwa droga, a rytm ok. 2 sekund zostawiamy. Zmieniamy jedną rzecz: odświeżamy **wyłącznie nowe dane**, a nie całą stronę.

| | iframe przeładowywany co 2 s | Nasze rozwiązanie |
|---|---|---|
| Co leci przez sieć | cała strona HTML z sesją i 50 wiadomościami, plus sprawdzenie CSS, skryptów i fontów | krótkie pytanie „czy jest coś po wiadomości nr N?”; zwykle odpowiedź `204` o rozmiarze kilkuset bajtów |
| Obciążenie serwera (16 procesów PHP) | ok. 30 renderów stron na minutę na kartę; sesja zablokowana przy każdym przeładowaniu | gość: 2–3 zapytania po kluczu, bez sesji; członek: odczyt pliku sesji bez blokady i 3–4 zapytania po kluczu; razem ok. 5–10 ms |
| Telefon w hali | ok. 50 MB na godzinę na otwartą kartę; radio stale pracuje | ułamek tego; w tle zero |
| Przewinięcie, wpisywany tekst, zaznaczenie | resetowane co 2 s | nienaruszone; nowe wiadomości dochodzą na dole, a przy czytaniu starszych pojawia się przycisk „Nowe wiadomości: 3” |
| Czytniki ekranu | gubią miejsce przy każdym przeładowaniu | spokojny komunikat o nowych wiadomościach, najwyżej co 15 s |
| Opóźnienie | ok. 1 s | ok. 1,3 s przy aktywnym oglądaniu; własna wiadomość widoczna natychmiast |
| Gdy hosting zaczyna ograniczać | strona się sypie | klient sam zwalnia i zgłasza to serwerowi; Admin widzi liczbę odpowiedzi 429/503 z ostatniej godziny i może zwolnić wszystkich jednym ustawieniem albo wyłączyć czat bez wdrożenia |

Technicznie iframe nie jest zakazany, bo CSP `frame-ancestors 'self'` go dopuszcza. Wymagałby jednak drugiego, serwerowego interfejsu czatu z osobnym szablonem, osobnym zabezpieczeniem przed XSS i osobnym rozmywaniem danych dla gości. Byłby więc droższy w utrzymaniu i wygodny dla nikogo.

---

## 1. Śledzenie wymagań

| Wym. | Treść (skrót) | Sekcje planu | Plasterki |
|---|---|---|---|
| 1 | Jeden centralny czat, dobrze osadzony na stronie głównej, z 4 kanałami: Taekwondo 🌎, Taekwondo 🇵🇱 („Tarkwondo” to literówka), Karate 🌎, Ogólny 🌎 (EN „General 🌎”) | §5.1, §8.9, §2.4 (seed) | `chat-backend`, `chat-frontend`, `home-embed` |
| 2 | Czat dla każdego turnieju | §5.2 | `chat-backend`, `chat-frontend`, `home-embed` |
| 3 | Czytać może każdy, także gość; dane użytkowników rozmyte dla gości z zachętą do założenia konta | §5.2, §5.4 (`ChatGuestView`), §5.9, §6.6, §8.9 | `chat-backend`, `chat-frontend`, `account-frontend`, `home-embed` |
| 4 | Konta płatne: 8,99 zł/mies. w Polsce, 2,99 USD/mies. gdzie indziej; Admin tworzy darmowe; Stripe MEDUCASE | §3.2, §6 | `backend-api`, `billing-backend`, `account-frontend` |
| 5 | Profil: imię, nazwisko, nazwa użytkownika, kraj pochodzenia, awatar, sport, plus e-mail, klub i rola | §7, §3.1, §3.9, §2.3 | `backend-data`, `accounts-profiles-backend`, `account-frontend` |
| 6 | Wyświetlanie nowych wiadomości na żywo; ocena pomysłu z iframe | §0.1, §5.4, §5.10, §5.11 | `chat-backend`, `chat-frontend` |
| 7 | PWA oraz zachęty do dodania do ekranu głównego | §9.1–§9.4 | `pwa-core`, `pwa-frontend`, `deploy-infra` |
| 8 | Dokumenty prawne poza zakresem; techniczne privacy-by-design w zakresie | §10, §13 (sloty zgód zarezerwowane, tekst w kolejnej sesji) | wszystkie; kontrola w `integration-qa` |
| — | Najwyższa jakość i bezpieczeństwo (właściciel nie jest programistą) | §10, §11, §12 (kryteria akceptacji), §14 | `integration-qa` |

---

## 2. Model danych i migracje

### 2.1 Zasady SQL (wspólny podzbiór MariaDB 10.6 i MySQL 8.0)
- **Tabele:** każda ma `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`. Klucze techniczne i identyfikatory zewnętrzne mają `CHARACTER SET ascii COLLATE ascii_bin`.
- **Klucze obce:**
  - nazwa w postaci `fk_<tabela>_<kolumna>`, bo w MySQL nazwy FK muszą być unikalne w schemacie;
  - typ i collation kolumny dokładnie takie jak w kolumnie wskazywanej (`VARCHAR(40)` utf8mb4_unicode_ci dla `users.id` i `tournaments.id`);
  - **żadnych nowych FK na istniejących tabelach.**
- **Idempotentny DDL:** `CREATE TABLE IF NOT EXISTS` jest dozwolone. `ADD COLUMN IF NOT EXISTS` i `CREATE INDEX IF NOT EXISTS` są zakazane, bo nie działają w MySQL. Zamiast nich używamy helperów `Migrator`, które sprawdzają `information_schema` z `TABLE_SCHEMA=DATABASE()`.
- **Czas:** zapisujemy `BIGINT` jako sekundy epoki (kolumny `*_at`) albo milisekundy (`*_ms`, tylko czas wiadomości). Nigdy nie używamy `TIMESTAMP`, `NOW()` ani `CURRENT_TIMESTAMP`: wartości liczy PHP przez `time()` lub `(int)(microtime(true)*1000)`. Dzięki temu strefa czasowa połączenia nie ma znaczenia. `UNIX_TIMESTAMP()` wolno użyć tylko w jednorazowym seedzie migracji.
- **Czego nie używamy:** `RETURNING`, `->>`, `JSON_VALUE`, wartości domyślnych na kolumnach JSON, aliasów wierszy w upsercie ani funkcji okna. Upsert ma postać `ON DUPLICATE KEY UPDATE c=VALUES(c)`.
- **Zapytania:** wszystkie przez przygotowane instrukcje PDO (`EMULATE_PREPARES=false` jest już ustawione). `GROUP BY` musi być zgodny z `ONLY_FULL_GROUP_BY`.

### 2.2 Migrator (`backend/src/Migrator.php`, `backend/bin/migrate.php`)

**Plik migracji.** Każda migracja to plik `backend/migrations/NNNN_nazwa.php`. Wybieramy PHP zamiast `.sql`, bo potrzebne są warunki dla MySQL i MariaDB. Plik zwraca tablicę:
```php
<?php // backend/migrations/0002_accounts.php
declare(strict_types=1);
use MatDraw\Migrator;
return ['id'=>2,'name'=>'accounts','destructive'=>false,
 // floor: true = dane wymagają kodu co najmniej w tej wersji (strażnik rollbacku, §2.8)
 'floor'=>fn(PDO $pdo):bool=>(bool)$pdo->query("SELECT 1 FROM users WHERE role='member' LIMIT 1")->fetchColumn(),
 'up'=>function(Migrator $m):void{ /* instrukcje z §2.3, każda idempotentna */ }];
```

**API klasy `Migrator`:**
- **Odczyt stanu:**
  - `__construct(PDO,string $dir)`;
  - `current():int` zwraca `app_meta.schema_version`, a 0 dla pustej bazy;
  - `static target(string $dir):int` zwraca najwyższe id pliku i nie łączy się z bazą;
  - `pending()`;
  - `status()` zwraca `state`, `current`, `target`, `pending`, `destructive` i `floor`;
  - `rollbackFloor():int`.
- **Uruchomienie:** `run(callable $log,bool $dry=false,bool $allowDestructive=false)`.
- **Helpery:** `exec(string $sql,array $params=[])`, `tableExists`, `columnExists`, `columnNullable`, `enumHas($table,$column,$value)`, `indexExists`, `addColumn($table,$column,$definition)` i `addIndex($table,$name,$columnsSql)`. Wszystkie korzystają z `information_schema`.
- **Zabezpieczenia:** `GET_LOCK('matdraw_migrate',0)`, `SET SESSION lock_wait_timeout=30` i `innodb_lock_wait_timeout=30`. Po każdej migracji wykonuje `UPDATE app_meta SET schema_version=? WHERE id=1 AND schema_version<?`.
- Numery migracji muszą być ciągłe, a test lintujący to sprawdza.

**`bin/migrate.php`.**
- Działa tylko z CLI.
- Flagi: `--status` (wypisuje `STATE=ready|empty CURRENT=1 TARGET=4 PENDING=3 DESTRUCTIVE=0 FLOOR=1`), `--dry-run`, `--allow-destructive` i `--rollback-floor` (wypisuje samą liczbę).
- Używa danych logowania `db_migrate` z config, jeśli istnieją, a w przeciwnym razie `db`.
- Kody wyjścia:
  - 0: baza aktualna albo migracje zastosowane;
  - 10: pusta baza; to nie błąd, deploy pokazuje wskazówkę o instalatorze;
  - 2: czeka migracja niszcząca;
  - 1: błąd.
- Gdy baza jest nowsza niż kod, wypisuje ostrzeżenie i kończy kodem 0.

**`bin/install.php`.** Wykonuje bazowy `schema.sql` (wersja 1, od teraz **zamrożony**: dostaje tylko komentarz w nagłówku), uruchamia `Migrator` i dopiero potem zakłada pierwszego Administratora (jak dziś). **`bin/dump.php`** to awaryjny zrzut bazy w czystym PDO, gdy na serwerze nie ma `mysqldump` (04 §2.a.3).

Numery migracji są rozdzielone z góry, żeby plasterki się nie zderzały: **0002** `backend-data`, **0003** `chat-backend`, **0004** `billing-backend`.

**Komunikaty błędów `migrate.php`.** Błąd 1205 albo 1213 (przekroczony czas blokady, zakleszczenie: stara wersja akurat zapisuje dane) daje po polsku „Baza jest chwilowo zajęta. Ponów wdrożenie za kilka minut.” i kod 1. `ALTER TABLE users MODIFY club_id … NULL` przebudowuje tabelę i potrzebuje krótkiej blokady metadanych; `lock_wait_timeout=30` sprawia, że migracja raczej się nie uda, niż zawiśnie.

### 2.3 Migracja 0002_accounts (`backend-data`)
Kolejność instrukcji w `up` [zweryfikowane na MariaDB 10.11, także wersja po przeglądzie; MySQL 8.0 sprawdzi CI]:
```sql
-- (a) users: nowa rola na końcu ENUM (zmiana tylko metadanych) — wykonać, jeśli !enumHas('users','role','member')
ALTER TABLE users MODIFY role ENUM('admin','editor','club','member') NOT NULL;
-- (b) członkowie nie mają klubu workspace — wykonać, jeśli !columnNullable('users','club_id'); FK zostaje bez zmian
ALTER TABLE users MODIFY club_id VARCHAR(40) NULL;

-- (c) profil konta (osobna tabela; workspace jej nie czyta)
CREATE TABLE IF NOT EXISTS user_profiles (
 user_id VARCHAR(40) NOT NULL PRIMARY KEY,
 public_id CHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,      -- losowy base62, jedyny identyfikator użytkownika wysyłany innym
 username VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,         -- zapisywany małymi literami; NULL = jeszcze nie ustawiony
 first_name VARCHAR(50) NULL,
 last_name VARCHAR(50) NULL,
 country CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL,              -- ISO 3166-1 alfa-2 (+ XK)
 sports VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '', -- slug1,slug2 (1–5, pierwszy = główny)
 club_text VARCHAR(100) NULL,                                             -- dowolny tekst, nigdy nie łączy z klubem workspace
 show_club TINYINT(1) NOT NULL DEFAULT 0,
 name_display ENUM('full','initial') NOT NULL DEFAULT 'initial',  -- prywatność domyślnie: „Marta K.”; pełne nazwisko tylko z wyboru (P7)
 avatar VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,           -- '<32 hex>.webp' | '<32 hex>.jpg'
 username_changed_at BIGINT NULL,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL,
 last_login_at BIGINT NULL,
 pw_reset_at BIGINT NULL,                                                -- hasło tymczasowe od Admina; me wymusza zmianę (§3.10)
 UNIQUE KEY user_profiles_public_id (public_id),
 UNIQUE KEY user_profiles_username (username),
 KEY user_profiles_last_name (last_name),
 KEY user_profiles_last_login (last_login_at),
 CONSTRAINT fk_user_profiles_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- (d) stan płatności, jeden wiersz na konto (03 §11; tu, bo maszyna stanów dostępu §6.5 jest w fundamencie)
CREATE TABLE IF NOT EXISTS billing_accounts (
 user_id VARCHAR(40) NOT NULL PRIMARY KEY,
 billing_exempt TINYINT(1) NOT NULL DEFAULT 0,
 exempt_reason VARCHAR(200) NULL,
 exempt_by VARCHAR(40) NULL,
 exempt_at BIGINT NULL,
 exempt_until BIGINT NULL,
 currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NULL,            -- 'pln' | 'usd'
 livemode TINYINT(1) NOT NULL DEFAULT 0,
 stripe_customer_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
 customer_seq INT NOT NULL DEFAULT 0,
 stripe_subscription_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
 sub_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'none',
 price_lookup_key VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NULL,
 current_period_start BIGINT NULL,
 current_period_end BIGINT NULL,
 cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0,
 cancel_at BIGINT NULL, canceled_at BIGINT NULL, ended_at BIGINT NULL,
 latest_invoice_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
 pending_checkout_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
 pending_checkout_expires BIGINT NULL,
 last_synced_at BIGINT NOT NULL DEFAULT 0,
 next_sync_at BIGINT NULL,
 sync_claimed_at BIGINT NOT NULL DEFAULT 0,
 sync_error VARCHAR(200) NULL,
 stripe_redact_pending TINYINT(1) NOT NULL DEFAULT 0,                    -- usunięcie klienta w Stripe do ponowienia (§3.8)
 deleted_at BIGINT NULL,                                                  -- wiersz-nagrobek po usunięciu konta (bez danych osobowych)
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL,
 UNIQUE KEY billing_accounts_customer (stripe_customer_id),
 UNIQUE KEY billing_accounts_subscription (stripe_subscription_id),
 KEY billing_accounts_due (next_sync_at),
 CONSTRAINT fk_billing_accounts_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- (e) istniejące konta są darmowe PRZEJŚCIOWO (§3.2, P2) — jawny wpis do audytu i raportów
INSERT IGNORE INTO billing_accounts (user_id,billing_exempt,exempt_reason,exempt_at,created_at,updated_at)
 SELECT id,1,'grandfathered',UNIX_TIMESTAMP(),UNIX_TIMESTAMP(),UNIX_TIMESTAMP() FROM users WHERE role IN ('admin','editor','club');

-- (f) zadania „przy okazji” (bez crona), §3.7
CREATE TABLE IF NOT EXISTS job_runs (
 name VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 last_run_at BIGINT NOT NULL DEFAULT 0,
 claimed_until BIGINT NOT NULL DEFAULT 0,
 last_result VARCHAR(200) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- (g) dziennik działań na kontach (Admin i sam członek); bez e-maili, haseł i treści, §3.8–§3.10
CREATE TABLE IF NOT EXISTS account_audit (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 actor_id VARCHAR(40) NOT NULL,                                  -- users.id | 'self' | 'system'
 action VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, -- create, active, password.reset, email.change, profile.fix, delete, self.delete, self.email
 target_user_id VARCHAR(40) NULL,
 note VARCHAR(200) NULL,
 created_at BIGINT NOT NULL,
 KEY account_audit_target (target_user_id,created_at),
 KEY account_audit_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```
- **Wiersze `job_runs`.** Migracja nie seeduje nazw zadań: `Jobs` sam dodaje brakujący wiersz przez `INSERT IGNORE`.
- **Wiersze `user_profiles`.** Tworzymy je leniwie przez `INSERT IGNORE` (`Accounts::ensureProfile`) przy logowaniu, rejestracji i pierwszym `me`, więc nie ma backfillu. `public_id` to 12 znaków base62 z `random_bytes`; przy kolizji klucza próbujemy ponownie, najwyżej 3 razy.
- **Tabela `login_limits`** pozostaje bez zmian. Korzysta z niej też ogólny `RateLimit` (§3.6).

### 2.4 Migracja 0003_chat (`chat-backend`)
```sql
CREATE TABLE IF NOT EXISTS chat_channels (
 id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 kind ENUM('lobby','tournament') NOT NULL,
 slug VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,   -- lobby: 'taekwondo' | 'taekwondo-pl' | 'karate' | 'general'
 scope ENUM('world','pl') NULL,                                   -- lobby; nazwy i ikony w kodzie i słownikach, nie w bazie
 sort SMALLINT NOT NULL DEFAULT 0,
 tournament_id VARCHAR(40) NULL,
 public_key CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, -- losowy; zarezerwowany dla statycznego beacona (etap 2)
 rev BIGINT UNSIGNED NOT NULL DEFAULT 0,                          -- +1 przy każdym dodaniu/usunięciu/ukryciu/przywróceniu
 last_message_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 msg_count INT UNSIGNED NOT NULL DEFAULT 0,                       -- liczba widocznych wiadomości (licznik „czat · 12”)
 status ENUM('open','readonly','closed') NOT NULL DEFAULT 'open', -- ręczne nadpisanie przez Admina; stan efektywny w §5.2
 created_at BIGINT NOT NULL,
 UNIQUE KEY chat_channels_slug (slug),
 UNIQUE KEY chat_channels_tournament (tournament_id),
 UNIQUE KEY chat_channels_key (public_key),
 CONSTRAINT fk_chat_channels_tournament FOREIGN KEY (tournament_id) REFERENCES tournaments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- seed (PHP, przygotowane instrukcje; public_key = 16 znaków base62 z random_bytes); INSERT IGNORE = idempotentne
INSERT IGNORE INTO chat_channels (kind,slug,scope,sort,public_key,created_at) VALUES
 ('lobby','taekwondo','world',10,?,?),('lobby','taekwondo-pl','pl',20,?,?),('lobby','karate','world',30,?,?),('lobby','general','world',40,?,?);

CREATE TABLE IF NOT EXISTS chat_messages (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,               -- kolejność wyświetlania
 channel_id INT UNSIGNED NOT NULL,
 rev BIGINT UNSIGNED NOT NULL,                                -- rev kanału przy ostatniej zmianie tej wiadomości (kursor pollingu)
 user_id VARCHAR(40) NOT NULL,
 client_id CHAR(22) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, -- klucz idempotencji z przeglądarki
 body VARCHAR(1000) NOT NULL,                                  -- '' po usunięciu (oryginał w chat_mod_log na 30 dni)
 cont TINYINT(1) NOT NULL DEFAULT 0,                           -- ten sam autor co poprzednia widoczna wiadomość, < 5 min (liczone przy zapisie)
 state ENUM('visible','deleted_author','deleted_mod','hidden_review') NOT NULL DEFAULT 'visible',
 report_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
 created_ms BIGINT UNSIGNED NOT NULL,
 changed_ms BIGINT UNSIGNED NULL,
 UNIQUE KEY chat_messages_channel_rev (channel_id,rev),        -- indeks pollingu
 UNIQUE KEY chat_messages_idem (user_id,client_id),            -- ponowiona wysyłka nie dubluje (prefiks obsługuje też FK user_id)
 KEY chat_messages_channel_id (channel_id,id),                 -- historia i licznik nieprzeczytanych
 KEY chat_messages_user_time (user_id,created_ms),             -- limity wysyłki
 KEY chat_messages_created (created_ms),                       -- retencja
 CONSTRAINT fk_chat_messages_channel FOREIGN KEY (channel_id) REFERENCES chat_channels(id),
 CONSTRAINT fk_chat_messages_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_reports (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 message_id BIGINT UNSIGNED NOT NULL,
 reporter_id VARCHAR(40) NOT NULL,
 reason ENUM('spam','abuse','harassment','child_data','other') NOT NULL,
 comment VARCHAR(300) NULL,
 status ENUM('open','dismissed','actioned') NOT NULL DEFAULT 'open',
 created_at BIGINT NOT NULL,
 resolved_by VARCHAR(40) NULL,
 resolved_at BIGINT NULL,
 UNIQUE KEY chat_reports_once (message_id,reporter_id),
 KEY chat_reports_status (status,created_at),
 KEY chat_reports_reporter (reporter_id),
 CONSTRAINT fk_chat_reports_message FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
 CONSTRAINT fk_chat_reports_reporter FOREIGN KEY (reporter_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_mutes (
 user_id VARCHAR(40) NOT NULL PRIMARY KEY,
 until_at BIGINT NULL,                                          -- NULL = bezterminowo
 reason VARCHAR(300) NULL,
 created_by VARCHAR(40) NOT NULL,
 created_at BIGINT NOT NULL,
 CONSTRAINT fk_chat_mutes_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_mod_log (                      -- bez FK: dziennik przeżywa retencję
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 actor_id VARCHAR(40) NOT NULL,                                 -- users.id | 'system'
 action VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, -- delete_mod, delete_author, auto_hide, restore, dismiss, mute, unmute, settings, channel_status
 message_id BIGINT UNSIGNED NULL,
 target_user_id VARCHAR(40) NULL,
 note VARCHAR(300) NULL,
 original_body VARCHAR(1000) NULL,                              -- czyszczone po 30 dniach (chat retention)
 created_at BIGINT NOT NULL,
 KEY chat_mod_log_time (created_at),
 KEY chat_mod_log_target (target_user_id,created_at),
 KEY chat_mod_log_message (message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_settings (                     -- jeden wiersz: strojenie i wyłącznik (wersjonowane)
 id TINYINT NOT NULL PRIMARY KEY,
 version INT UNSIGNED NOT NULL,
 data TEXT NOT NULL,                                            -- JSON jako tekst (bez różnic JSON MariaDB/MySQL)
 updated_at BIGINT NOT NULL,
 updated_by VARCHAR(40) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO chat_settings (id,version,data,updated_at) VALUES (1,1,?,?);

CREATE TABLE IF NOT EXISTS chat_health (                       -- odpowiedzi hostingu zgłaszane przez klientów (§5.10); bez IP i bez użytkowników
 hour_at BIGINT NOT NULL,                                       -- początek godziny (sekundy epoki)
 status SMALLINT UNSIGNED NOT NULL,                             -- 429 | 503 | 508 | 0 (odpowiedź nie-JSON albo błąd sieci)
 n INT UNSIGNED NOT NULL DEFAULT 0,
 PRIMARY KEY (hour_at,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- zapis: INSERT INTO chat_health (hour_at,status,n) VALUES (?,?,?) ON DUPLICATE KEY UPDATE n=LEAST(n+VALUES(n),1000000)
```
Domyślne `data` (pola `on`, `t`, `ms`, `idle`, `bg`, `boost`, `safety` i `notice` trafiają do klienta; resztę zna tylko serwer):
```json
{"on":true,"t":"poll","ms":[2500,5000,10000,30000,60000],"idle":[60,180,600,1800],"bg":30000,"boost":300,"safety":60000,"notice":null,
 "send":{"gap":2,"perMin":20,"perDay":300},"autoHide":3,"retentionDays":365,"modKeepDays":30,"graceDays":1}
```

### 2.5 Migracja 0004_billing (`billing-backend`)
```sql
CREATE TABLE IF NOT EXISTS stripe_events (                     -- idempotencja webhooków i pobierania /v1/events; BEZ treści zdarzeń (zawierają e-maile)
 event_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 type VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 livemode TINYINT(1) NOT NULL,
 source VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, -- 'webhook' | 'pull'
 received_at BIGINT NOT NULL,
 processed_at BIGINT NULL,
 attempts INT NOT NULL DEFAULT 1,
 error VARCHAR(200) NULL,
 KEY stripe_events_received (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_audit (                     -- tylko id i krótkie kody, bez e-maili i adresów
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 user_id VARCHAR(40) NULL,
 actor VARCHAR(40) NOT NULL,                                    -- users.id | 'stripe' | 'cron' | 'cli' | 'system'
 action VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, -- exempt.grant, exempt.revoke, checkout.create, status.change, customer.replace, orphan, cancel.request ...
 old_status VARCHAR(32) NULL,
 new_status VARCHAR(32) NULL,
 detail VARCHAR(500) NULL,
 created_at BIGINT NOT NULL,
 KEY billing_audit_user (user_id,created_at),
 KEY billing_audit_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_kv (                        -- cache price id, kursor zdarzeń
 k VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 v VARCHAR(1000) NOT NULL,
 updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 2.6 Zmiany w istniejących tabelach i kodzie danych
| Element | Zmiana | Zgodność |
|---|---|---|
| `users.role` | dopisana wartość `'member'` na końcu ENUM | Zmiana tylko metadanych. Stary kod czyta ją poprawnie, ale dawałby członkom zbyt szerokie prawa, stąd strażnik rollbacku (§2.8). |
| `users.club_id` | `NOT NULL` zmienione na `NULL` | NULL mają wyłącznie członkowie. Personel zawsze ma klub (`Domain` tego wymaga). |
| `users` (pozostałe kolumny) | **bez zmian** | `load()` i `rows()` mapują kolumny jawnie. |
| `Repository::load()` | `SELECT * FROM users WHERE role<>'member' ORDER BY email,id` | Workspace zawiera wyłącznie personel i kluby. |
| `Repository::persist()` dla `users` | zamiast upsertu: nowe id → `INSERT INTO users (id,club_id,email,role,active,password_hash,auth_version) VALUES (...)`; zmieniony wiersz → `UPDATE users SET club_id=?,email=?,role=?,active=?,password_hash=?,auth_version=? WHERE id=? AND role<>'member'`. Pozostałe tabele zostają na upsercie. | Naprawia przejęcie wiersza z D4. Ochronę przed złą rolą daje nadal `Domain`, który przyjmuje tylko admin/editor/club. |
| Błąd 1062 (duplikat klucza) przy zapisie `users` | `persist()` łapie `PDOException` z `errorInfo[1]===1062` **na instrukcji dla `users`** i rzuca `AppError('Konto z tym adresem e-mail już istnieje.',409)` (komunikat już istnieje i ma tłumaczenie); `transaction()` wycofuje całość jak dziś | E-mail członka jest niewidoczny dla `Domain`, więc unikalność pilnuje baza. Mapowanie w `Repository` (a nie w `index.php`) pozwala `backend-data` przetestować regresję samodzielnie. |
| `Domain.php`, `workspace.js`, `GuestView.php` | **bez zmian** | Testy zgodności PHP/JS pozostają nietknięte. |

Dlaczego **tabela boczna**, a nie nowe kolumny w `users`:
1. `load()` czyta `SELECT *` z całej tabeli `users` przy każdym zapisie.
2. `persist()` przy `INSERT` nowego konta wymagałby wartości domyślnych dla każdej nowej kolumny.
3. Dane profilu i płatności mają inny cykl życia i inną częstotliwość zapisu niż workspace.

### 2.7 Konsekwencje dla wydajności
- **Dziś** `session`, `bootstrap`, `login` i każde `command` ładują cały workspace.
- **Po zmianie:**
  - `session` i `login` korzystają z jednego zapytania po kluczu w tabeli `users` (§3.3);
  - `bootstrap` pełnego workspace zostaje tylko dla personelu;
  - trasy społecznościowe nigdy nie wołają `snapshot()`.
- **Lekki odczyt bieżącego użytkownika** to jedno zapytanie:
  ```sql
  SELECT u.id,u.club_id,u.email,u.role,u.active,u.password_hash,u.auth_version FROM users u WHERE u.id=?
  ```
  Opcjonalnie dochodzi `LEFT JOIN user_profiles`, `billing_accounts` i `chat_mutes` po kluczu głównym.
- **Koszt bezczynnego odpytania czatu** (rzeczywisty, a nie „jedno zapytanie”):
  - gość (`public-chat`): `chat_channels` po kluczach (kanały na ekranie i w tle razem) i `chat_settings`, a przy kanałach turniejów jeszcze `tournaments`, czyli 2–3 zapytania;
  - członek (`chat-feed`): do tego odczyt pliku sesji bez blokady i jedno zapytanie `users ⋈ billing_accounts` (dostęp), czyli 3–4 zapytania;
  - liczniki nieprzeczytanych (`COUNT` ograniczone do 100) liczymy tylko dla kanałów, w których zmienił się `last_message_id` (§5.4).
- **Szacunek pojemności:** 300 czytelników przy średnim interwale ok. 6 s to ok. 50 zapytań HTTP na sekundę po ok. 5–10 ms, czyli średnio poniżej jednego zajętego procesu PHP z 16. Właściwy test na web9 opisuje §9.11 (krok z `poll-probe.sh`).

### 2.8 Bezpieczeństwo rollbacku (strażnik „floor”)
- **Zasada.** Migracje tylko dodają: stary kod działa na nowym schemacie. Jedyny wyjątek to **dane**. Gdy istnieją konta `member`, kod sprzed migracji 0002 załadowałby je do workspace i potraktował jak personel spoza roli club, czyli z prawem odczytu wszystkich zawodników.
- **Mechanizm.**
  - Migracja może zadeklarować `floor`, funkcję sprawdzającą, czy dane wymagają nowszego kodu.
  - `migrate.php --rollback-floor` zwraca najwyższe id zastosowanej migracji, której `floor()` zwraca `true`, a 1, gdy takiej nie ma.
  - `deploy-remote.sh rollback` porównuje tę liczbę z `Migrator::target()` wydania docelowego, ustalanym po nazwach plików w `backend/migrations` albo jako 1, gdy katalogu nie ma.
  - Gdy cel ma niższy numer, rollback odmawia z komunikatem po polsku. `FORCE_ROLLBACK=1` wyłącza tę blokadę i jest opisane w DEPLOY-PL.md jako „tylko na własną odpowiedzialność”.
- **Automatyczny rollback** przy pierwszym wdrożeniu 0002 jest bezpieczny: członkowie jeszcze nie istnieją, bo rejestracja jest wyłączona (`signup_enabled=false`, bez tokenu zaproszeń), więc floor wynosi 1.
- **Wdrożenie w dwóch krokach:**
  - krok 1: kod i migracje, z wyłączoną rejestracją;
  - krok 2: włączenie rejestracji w `shared/config.php`, gdy płatności są gotowe (§6.10).

---

## 3. Konta i role

### 3.1 Role i to, co każda z nich widzi

| Rola | Skąd się bierze | Workspace turniejowy | Społeczność (czat, profil) | Płatność |
|---|---|---|---|---|
| `admin` | `install.php` / Admin | pełny (bez zmian) | pełny dostęp + moderacja, ustawienia czatu, konta członków, płatności | zawsze `staff` (nigdy nie płaci) |
| `editor` | Admin (`account.save`, jak dziś) | jak dziś; **bez pełnego dostępu tylko podgląd** (§6.6) | pełny dostęp po uzupełnieniu profilu | nowe konta płatne, chyba że Admin zaznaczy „Darmowe konto”; istniejące darmowe przejściowo (§3.2) |
| `club` | Admin (`account.save`, jak dziś) | jak dziś; **bez pełnego dostępu tylko podgląd** | pełny dostęp po uzupełnieniu profilu | jak `editor` |
| `member` (nowa) | samodzielna rejestracja `#signup` albo Admin („Członkowie” → „Nowe konto”) | **brak**: `bootstrap` zwraca pusty workspace członka (§3.3); `command` odpowiada 403 | czyta zawsze; pisze, widzi tożsamości i ma widoczny profil tylko przy pełnym dostępie | płatne (8,99 zł / 2,99 USD) albo darmowe od Admina |

**Pełny dostęp** daje `Access::of()` (§6.5): `staff`, `free`, `active`, `ending`, `past_due` w okresie karencji, `grace` (karencja po końcu darmowego okresu) albo `open` (płatności niewymuszane).

**Możliwość pisania** ma osoba, która spełnia wszystkie warunki naraz:
- ma pełny dostęp;
- ma kompletny profil: imię, nazwisko, nazwę użytkownika, kraj i co najmniej jeden sport (jedna funkcja `Accounts::profileComplete(array $profile):bool` w `backend-api`, używana przez `me`, `Profiles` i `Chat`);
- nie musi zmienić hasła tymczasowego (§3.10);
- nie jest wyciszona;
- czat jest włączony.

Etykieta roli w interfejsie to „Członek” (EN „Member”). **Nie dopisujemy** `member` do `ROLES` w `workspace.js`, bo trafiłby do listy ról w formularzu kont personelu. `shell()` używa wtedy `ROLES[role]||T('Członek')`.

### 3.2 Konta darmowe, „dziedziczenie” i konta tworzone przez Admina
- **Istniejące konta.** Migracja 0002 zakłada wiersz `billing_accounts` z `billing_exempt=1`, `exempt_reason='grandfathered'` i `exempt_until` NULL dla wszystkich obecnych kont admin/editor/club. To **stan przejściowy**: wymaganie 4 mówi, że konta są płatne, więc właściciel decyduje (P2, bramka przed `billing_enforce=true`), czy i od kiedy obecne kluby płacą. Ten sam kod obsługuje obie odpowiedzi, więc pytanie nie wstrzymuje implementacji.
- **Przełączenie istniejących kont na płatne:** `admin-billing-action {action:'requireFrom', date, scope:'grandfathered'|'user', userId?}`.
  - Ustawia `exempt_until=date` (dla zakresu `grandfathered` data musi być co najmniej 14 dni od dziś).
  - Od `date − 14 dni` osoba widzi baner „Od {date} konto wymaga płatności. [Wybierz plan]”.
  - Po `date` działa 7-dniowa karencja (`grace`, §6.5), a dopiero potem tryb „tylko podgląd”.
  - Akcja trafia do `billing_audit` z autorem.
- **Bezpieczny domyślny stan dla personelu.** Konto admin/editor/club **bez wiersza** w `billing_accounts` traktujemy jako darmowe (`free`, powód `staff-default`). Jeśli drugi krok zapisu w formularzu się nie uda, przedstawiciel klubu nie utknie w dniu zawodów, a plakietka „Darmowe (domyślnie)” na liście kont pokazuje Adminowi, że trzeba to poprawić.
- **Formularz konta personelu (`accountForm`).** Przełącznik „Darmowe konto (bez płatności)”:
  - dla **nowego** konta domyślnie **wyłączony** (wymaganie 4); pod nim tekst „Bez darmowego konta osoba po włączeniu płatności ma tylko podgląd, dopóki nie wykupi planu.”;
  - dla edytowanego konta pokazuje stan z `admin-billing?list=staff`.
  - Zapis idzie osobnym wywołaniem po udanym `account.save` (zdarzenie `saved` z rejestru, §8.3): włączony → `exempt {reason}`; wyłączony przy nowym koncie → `require`; wyłączenie przy istniejącym darmowym koncie → `requireFrom {date: dziś}`, czyli z 7-dniową karencją, żeby nie odciąć nikogo w trakcie zawodów.
- **Konto członka tworzone przez Admina** (`admin-member {action:'create', free:true, reason}`) zapisuje `billing_exempt=1` z powodem, opcjonalnie z datą końca (`exempt_until`). Dla członka **brak wiersza** oznacza „nie zwolniony, brak subskrypcji”.
- **Uczynienie płacącego członka darmowym** (`exempt`) proponuje też zatrzymanie jego subskrypcji Stripe na koniec okresu (03 §10.2).
- **Promocja członka do roli `club`** nie wchodzi do v1 (pytanie P11). Osoba, która ma reprezentować klub, dostaje od Admina osobne konto personelu z innym adresem e-mail.

### 3.3 Izolacja workspace (zmiany w `index.php` / `Accounts.php` / `Repository.php`)
1. **`login`** (`backend-api`).
   - Szukamy konta lekko: `SELECT ... FROM users WHERE email=?`, bez `transaction()` i bez globalnej blokady.
   - Zachowujemy `Auth::reserveLogin` i ten sam komunikat `Nieprawidłowy e-mail lub hasło.` (401). Limity pochodzą z config: `login_limit_ip` (domyślnie **100** na 15 min, bo w hali wiele telefonów ma jedno IP) i bez zmian 8 na 15 min na parę IP+e-mail. Adresy IPv6 grupujemy po prefiksie /64 (`ClientIp::bucket`).
   - **Fałszywy hash dla nieznanych kont ma ten sam algorytm i parametry co `Domain::password`.** `Accounts::dummyHash()` zwraca `defined('PASSWORD_ARGON2ID')` ? stałą Argon2id (wygenerowaną raz przez `password_hash(..., PASSWORD_ARGON2ID)` z domyślnymi opcjami PHP, m=65536, t=4, p=1) : stałą bcrypt cost 10. Dzisiejsza stała bcrypt przy hasłach Argon2id dawała mierzalną różnicę czasu między istniejącym a nieznanym e-mailem.
   - Hasło weryfikujemy zawsze: dla nieznanego konta, nieaktywnego konta i istniejącego konta, a dopiero potem sprawdzamy wynik.
   - Po sukcesie: `Accounts::ensureProfile()`, `UPDATE user_profiles SET last_login_at=?`, `Auth::enter($u,$config)`.
   - Odpowiedź bez zmian: `{user,csrf}`.
2. **`session`.** Korzysta z lekkiego `Accounts::current($pdo,false)` zamiast `snapshot()`. Kształt odpowiedzi `{user|null,csrf}` się nie zmienia. Sesja z nieaktualnym `authVersion` albo zablokowanym kontem jest czyszczona, jak dziś.
3. **`bootstrap`.** Najpierw `Accounts::current($pdo,true)`.
   - Dla `member` zwraca `Accounts::memberWorkspace($u)`, czyli `{schemaVersion:2,revision:0,user:safeUser,clubs:[],users:[],profiles:[],tournaments:[]}`.
   - Dla pozostałych ról działa istniejąca ścieżka `snapshot()` i `Domain::publicData()`, bez zmian, **także dla personelu bez pełnego dostępu** (świadoma decyzja: podgląd zostaje, §6.6).
4. **`command`.** Przed transakcją wykonujemy `Accounts::current($pdo,true)`:
   - `member` → `AppError('Brak uprawnień.',403)`, komunikat już istnieje;
   - `Access::of(...)['full']===false` → `ApiError('Ta funkcja wymaga aktywnej subskrypcji.',402)`, **z wyjątkiem `account.password`** (własne hasło można zmienić zawsze).

   Dalej działa istniejąca transakcja. Duplikat e-maila (1062) zamienia na 409 już `Repository` (§2.6, `backend-data`).
5. **`Repository::load()` i `persist()`:** zmiany z §2.6 (`backend-data`). Do czasu scalenia `backend-api` członek w ogóle nie zaloguje się starą ścieżką, bo `load()` go nie widzi; to bezpieczny stan pośredni.
6. **Test regresji (obowiązkowy, `backend-data`):**
   - Admin zakłada konto personelu z e-mailem istniejącego członka i dostaje 409;
   - wiersz członka (id, rola, hash hasła) pozostaje nietknięty;
   - zmiana e-maila konta personelu na e-mail członka także daje 409.

### 3.4 Unikalność e-maila i nazwy użytkownika, bez wyliczania kont
- **Unikalność.** Pilnują jej wyłącznie klucze bazy: `user_email` (collation `utf8mb4_unicode_ci`, więc bez rozróżniania wielkości liter; dodatkowo e-maile zapisujemy małymi literami) i `user_profiles_username` (ascii_bin, zapis małymi literami). Wszystkie ścieżki, czyli `account.save`, `signup`, `admin-member` (`create`, `email`), `member-email` i `profile`, łapią 1062 i zwracają przyjazny komunikat 409.
- **Wyliczanie kont przez logowanie: ograniczone, nie „niemożliwe”.**
  - Jeden komunikat dla wszystkich błędów, limity jak wyżej.
  - Ten sam koszt weryfikacji hasła (ten sam algorytm i parametry) dla nieznanych, nieaktywnych i istniejących kont. Wyszukanie po kluczu `user_email` kosztuje tyle samo przy trafieniu i chybieniu.
  - Zostaje szum czasowy sieci i bazy. Test jednostkowy porównuje parametry hasha (`password_get_info`), a test HTTP mediany czasów w szerokim przedziale (§11).
- **Wyliczanie kont przez rejestrację.** Bez wysyłki e-maili pełna ochrona nie jest możliwa: odpowiedź „konto już istnieje” musi się różnić od sukcesu, inaczej osoba zostałaby z kontem, do którego się nie zaloguje. Ograniczamy to tak:
  - komunikat jest neutralny: `Nie można założyć konta z tym adresem e-mail. Jeśli masz już konto, zaloguj się.`;
  - obowiązują limity rejestracji (§3.6), takie jak przy logowaniu;
  - pytanie „czy e-mail jest wolny?” pada wyłącznie przy wysłaniu formularza (brak osobnego endpointu).

  Pełną ochronę da etap 2 z weryfikacją e-mailem: „wysłaliśmy link”.
- **Zajęcie cudzego adresu (bez weryfikacji e-maila w v1).** Ktoś może założyć konto na cudzy adres. Prawowity właściciel adresu pisze na adres pomocy (§3.10), a Admin w `#members` zmienia adres nieopłaconego konta (`admin-member email`) albo je usuwa (`delete`). Opłaconym kontem z cudzym adresem Admin zajmuje się indywidualnie (procedura „Konflikt adresu e-mail” w DEPLOY-PL.md). E-mail nadal trafia do klienta Stripe, bo paragony i wezwania do zapłaty muszą dojść do płacącego; ryzyko ogranicza to, że płacący za cudzy adres płaci prawdziwe pieniądze. Przyczynę usuwa etap 2.
- **Nazwy użytkowników.** `username-check` to **POST w trybie `session` z CSRF**:
  - odpowiada tylko zalogowanemu albo osobie w trakcie rejestracji (`$_SESSION['signup_at']` z `signup-begin`, ważne 2 h); inaczej 403 `Najpierw rozpocznij rejestrację.`;
  - imię i nazwisko do propozycji przychodzą w ciele żądania, nigdy w adresie;
  - limity: 30 na 10 minut na sesję i 300 na 10 minut na IP (prefiks /64); klient wysyła zapytanie po 400 ms bez pisania.
  - **Ryzyko szczątkowe:** kto rozpocznie rejestrację, może sprawdzić, czy dany pseudonim jest zajęty. Pseudonimy z założenia widzą wszyscy członkowie; odpowiedź nie ujawnia imienia, e-maila ani id konta.

### 3.5 Zmiany w `Auth`
- **`Auth::start($c)`.**
  - Bez zmian w zachowaniu personelu.
  - Nowość 1: limity bezczynności i wieku sesji czytane z `$_SESSION['idle']` i `$_SESSION['max']`, ustawianych przy logowaniu.
  - Nowość 2: **tylko gdy `ini_get('session.save_handler')==='files'`** i istnieje katalog `Paths::sessions($c)`: `session_save_path(...)`, `session.gc_probability=0` (sprzątanie przejmuje `housekeeping`) i `gc_maxlifetime=max(session_max_seconds, member_session_max_seconds)`. Przy innym magazynie sesji (np. Redis) nie dotykamy ścieżki ani GC.
- **`Auth::enter($u,$c)`** (zmieniona sygnatura; wszystkie wywołania trzeba zaktualizować).
  - Zapisuje `idle` i `max` według roli: `member` dostaje `member_session_idle_seconds` (domyślnie 1209600 s = 14 dni) i `member_session_max_seconds` (2592000 s = 30 dni); reszta ról zostaje przy obecnych 1800 s / 43200 s.
  - Dla `member` ponownie ustawia ciasteczko sesji z `expires=created+max`, z tymi samymi parametrami: `HttpOnly`, `Secure` przy https, `SameSite=Strict`, `path=/`.
  - Zawsze wywołuje `session_regenerate_id(true)`.
- **`Auth::peek($c)`** (nowa) dla tras GET czytających często. Kolejność ma znaczenie, bo `use_strict_mode` przy nieznanym id **tworzy nowy plik i wysyła `Set-Cookie`** [zweryfikowane przez recenzenta na PHP 8.3.6]:
  1. Brak ciasteczka `matdraw_session` albo niezgodność z `^[A-Za-z0-9,-]{22,256}$` → `null` bez uruchamiania sesji.
  2. Przy `save_handler==='files'`: gdy nie istnieje plik `<ścieżka sesji>/sess_<id>` (wygasła, sprzątnięta albo zmyślona wartość), zwraca `null` **bez** `session_start` (żadnego pliku, żadnego `Set-Cookie`). Ścieżkę liczymy jak w `start()`; format `N;/ścieżka` jest obsługiwany.
  3. Te same ustawienia co w `start()` (ścieżka, `gc_probability=0`, `use_strict_mode`) oraz `session_cache_limiter('')`, żeby PHP nie dopisywał `Cache-Control: no-store` i `Pragma` (trasa sama ustawia nagłówki cache).
  4. `session_start(['read_and_close'=>true])`, potem kontrola `idle` i `max` tylko do odczytu; po przekroczeniu `null`, nigdy `clear()` ani `regenerate`.
  5. `header_remove('Set-Cookie')` jako zabezpieczenie (np. przy innym magazynie sesji).
  6. **Odświeżenie aktywności:** gdy `now − last > idle/4` (i nadal mieści się w `idle`), wykonujemy jedno krótkie `session_start()` z tym samym id, ustawiamy `$_SESSION['last']=now` i od razu `session_write_close()`. Blokada trwa milisekundy, id się nie zmienia, więc PHP nie wysyła `Set-Cookie` [zweryfikowane lokalnie na PHP 8.3.6: ważne ciasteczko, brak `Set-Cookie` i nagłówków cache]. Dzięki temu przedstawiciel klubu, który tylko czyta czat, nie zostaje wylogowany po 30 minutach.
  7. Zwraca `{userId,authVersion}`. Lekki odczyt z bazy weryfikuje `active` i `auth_version`.

  **Trasy `peek` nie wysyłają `Set-Cookie`, nie tworzą plików sesji i przedłużają sesję najwyżej raz na 1/4 limitu bezczynności** (testy HTTP: nieznane, wygasłe i ważne ciasteczko).
- **Katalog sesji.** `Paths::sessions($c)` zwraca `session_dir` z config. Gdy go brak, a katalog `dirname(realpath(ścieżka config.php)).'/sessions'` istnieje i jest zapisywalny, zwraca ten katalog; w przeciwnym razie domyślną ścieżkę PHP (i wtedy niczego nie sprzątamy).
  - Na produkcji `config.php` to dowiązanie do `shared/config.php`, więc katalogiem jest `~/matdraw/shared/sessions` (tworzy go `deploy-remote.sh check`, tryb 700).
  - Pierwsze wdrożenie po zmianie wyloguje wszystkich jeden raz; DEPLOY-PL.md to opisuje (i zaleca dzień bez zawodów, §9.11).
- **Sprzątanie plików sesji (`housekeeping`, tylko we własnym `shared/sessions`).** Trasa `session` tworzy plik dla każdego odwiedzającego, także gości i botów, więc pliki trzeba usuwać według rodzaju, a nie po 30 dniach dla wszystkich:
  - plik bez `userId|` (sesja anonimowa) starszy niż `anon_session_seconds` (domyślnie 10800 s = 3 h);
  - sesja personelu (zapisane `max` ≤ `session_max_seconds` albo brak `max`) starsza niż `session_max_seconds` (12 h);
  - każdy plik starszy niż `member_session_idle_seconds` (14 dni).

  Katalog czytamy przez `DirectoryIterator` porcjami (najwyżej 5000 plików i 2 s na przebieg; następny przebieg kontynuuje). `diagnostics` i `server-check` pokazują `session.save_handler`, ścieżkę i liczbę plików.
- **`Auth::requireCsrf`** pozostaje bez zmian: sprawdza `Origin` względem `app_url` oraz `X-CSRF-Token`. Wymaga go każdy POST z sesją, także `signup-begin`, `signup`, `username-check`, `avatar-upload`, `admin-members` i trasy płatności.
- **`ClientIp::get($c)`** zwraca `REMOTE_ADDR`. Nagłówek proxy używamy tylko wtedy, gdy config ma `trusted_proxy_header` i `REMOTE_ADDR` należy do `trusted_proxies` (domyślnie wyłączone; **[do weryfikacji]**: jak hosting przekazuje IP). `ClientIp::bucket($c)` zwraca IPv4 bez zmian, a IPv6 jako prefiks /64; z tego korzystają wszystkie limity.

### 3.6 Rejestracja: ochrona przed nadużyciami
- **`RateLimit::hit(PDO,$appKey,$scope,$key,$limit,$windowSeconds):int`** zwraca 0 albo liczbę sekund do odczekania.
  - Korzysta z tabeli `login_limits`. Kubełek to `hash_hmac('sha256',"$scope|$key",app_key)`, tak że nie zapisujemy żadnych IP ani e-maili.
  - Rezerwacja jest atomowa, jak w `reserveLogin` (`INSERT … ON DUPLICATE KEY UPDATE attempts=IF(window_start<?,1,attempts+1), …`).
  - Sprzątanie wierszy starszych niż 2 doby uruchamia się w 1% wywołań.
  - **Wywołujący sam rzuca dosłowny komunikat**, np. `if($s=RateLimit::hit(...)){Routes::retryAfter($s);throw new ApiError('Zbyt wiele prób zakładania konta. Spróbuj ponownie później.',429,['retry'=>$s]);}`. Wymaga tego test i18n, który szuka literałów.
- **`signup-begin`** (POST, `session`, anonim): gdy rejestracja jest dostępna (`signup_enabled` albo poprawny `invite`), zapisuje `$_SESSION['signup_at']=time()` i zwraca `{ok:true}`; inaczej 404 `Rejestracja jest chwilowo wyłączona.`. Klient woła ją przy wejściu na krok 1.
- **Limity `signup`** (wszystkie w config, opis podnoszenia w dniu zawodów w DEPLOY-PL.md):
  - IP (prefiks /64): `signup_limit_ip_hour` = 30 na godzinę i `signup_limit_ip_day` = 100 na dobę, bo w hali i klubie wiele osób ma jedno IP;
  - globalnie: `signup_limit_global_hour` = 200 na godzinę (hamulec przed falą botów).
- **Pułapka na boty.** Pole `website` jest ukryte (`tabindex=-1`, `autocomplete=off`, `aria-hidden`), więc musi przyjść puste. **Czas wypełnienia mierzy serwer:** `now − $_SESSION['signup_at']` musi wynosić od 3 s do 7200 s (dotychczasowe pole `elapsed` od klienta znika, bo dało się je podrobić). Inaczej serwer zwraca 400 `Nie udało się założyć konta. Spróbuj ponownie.`, bez wskazania, który warunek nie przeszedł.
- **Token zaproszeń (okno testów właściciela, §6.10).** Gdy `signup_enabled=false`, a config ma `signup_invite_token` (co najmniej 24 znaki), `signup-begin` i `signup` przyjmują pole `invite` porównywane przez `hash_equals`. `public-config` nadal zgłasza `signup:false`, więc interfejs niczego nie reklamuje; właściciel otwiera `#signup?invite=<token>` ręcznie.
- **Walidacja.**
  - E-mail: `FILTER_VALIDATE_EMAIL`, najwyżej 254 znaki, zapis małymi literami.
  - Hasło: `Domain::password` (12–72 bajty, Argon2id).
  - Profil: `Profiles::validate` (§7.1), `nameDisplay` domyślnie `initial`. `Profiles` używa `Domain::txt(..., 'imię', 50)`, co daje komunikaty `Sprawdź pole: imię.` z gotowym szablonem tłumaczenia.
- **Zapis w jednej transakcji, bez `app_meta`:**
  1. `INSERT users` (role `member`, `club_id` NULL);
  2. `INSERT user_profiles`;
  3. `INSERT billing_accounts` (`exempt=0`).

  Duplikat e-maila daje 409 z komunikatem z §3.4, a duplikat nazwy 409 `Ta nazwa użytkownika jest zajęta.`. Po sukcesie: `unset($_SESSION['signup_at'])`, `Auth::enter($u,$c)`, odpowiedź `{user,csrf}`.
- Gdy rejestracja nie jest dostępna, serwer odpowiada 404 `Rejestracja jest chwilowo wyłączona.`, a interfejs ukrywa przyciski (sterowanie z `public-config`, §6.10).

### 3.7 Sprzątanie bez crona (`Jobs`)
- **Rejestr zadań.** `backend/jobs/*.php`; każdy plik zwraca `['nazwa'=>['every'=>sekundy,'needsFlush'=>bool,'run'=>callable(PDO,array $config,int $now):string]]`.
- **`Jobs::maybe(PDO,$config)`** jest wołane z `register_shutdown_function` w trasach `me` i `chat-send`.
  0. **Najpierw zawsze `session_write_close()`.** PHP zapisuje sesję i zwalnia blokadę pliku dopiero **po** funkcjach zamykających, a `fastcgi_finish_request`/`litespeed_finish_request` tej blokady nie zdejmują. Bez tego kolejne żądania tego samego użytkownika (inne karty, `chat-send`) czekałyby na zadanie, łącznie z wywołaniami Stripe.
  1. **Próbkowanie:** gdy plik `Paths::shared($c).'/jobs-tick'` zmieniono mniej niż 30 s temu, kończy pracę; w przeciwnym razie go dotyka (`touch`). To jeden `stat` zamiast zapisów w bazie przy każdej wiadomości.
  2. Jeśli istnieje `fastcgi_finish_request` albo `litespeed_finish_request`, wysyła odpowiedź.
  3. **Jedno zapytanie** `SELECT name,last_run_at,claimed_until FROM job_runs`; `INSERT IGNORE` tylko dla brakujących nazw; wybiera **jedno** najbardziej zaległe zadanie i przejmuje je: `UPDATE job_runs SET claimed_until=?+120,last_run_at=? WHERE name=? AND last_run_at<=?-every AND claimed_until<?`, a dalej działa tylko przy `rowCount()===1`.
  4. Uruchamia zadanie z limitem około 2 s pracy (`set_time_limit(20)`, porcje danych). Zadania z `needsFlush` (np. Stripe) pomija, gdy nie da się najpierw wysłać odpowiedzi.
  - Klucz testowy `job_test_sleep_ms` (domyślnie 0, tylko w testach) wydłuża zadanie, żeby test HTTP sprawdził, że drugie żądanie z tym samym ciasteczkiem odpowiada w mniej niż 1 s.
- **`bin/cron.php`** (CLI) uruchamia wszystkie zaległe zadania i jest gotowy na cron w DirectAdmin, jeśli hosting go udostępnia.
- **Zadania:**

| Plik | Zadanie | Co | Co ile |
|---|---|---|---|
| `jobs/core.php` | `housekeeping` | sprzątanie `login_limits`; pliki sesji według rodzaju (§3.5, tylko we własnym `shared/sessions`) | 1 h |
| `jobs/accounts.php` | `accounts-cleanup` | porzucone konta (niżej), osierocone katalogi i pliki awatarów starsze niż 1 doba | 24 h |
| `jobs/chat.php` | `chat-retention` | retencja (§5.8), wygasłe wyciszenia, `chat_health` starsze niż 14 dni | 1 h |
| `jobs/billing.php` | `billing-due`, `billing-events` | do 5 zaległych synchronizacji i ponowienia usunięć klientów Stripe (`stripe_redact_pending`); 1 strona `/v1/events` (§6.3) | 10 min / 15 min, `needsFlush` |

- **Porzucone rejestracje.** Zadanie **nie działa, gdy `billing_enforce=false`** (członkowie mają wtedy pełny dostęp i korzystają z czatu bez płacenia, więc nie są „porzuceni”). Usuwamy konto `member`, które spełnia wszystkie warunki:
  - `users.active=1` (konta już usunięte i zanonimizowane pomijamy);
  - `billing_exempt=0`, `stripe_customer_id IS NULL`, `sub_status='none'`;
  - `created_at` sprzed ponad `abandoned_member_days` dni (domyślnie 30);
  - `last_login_at` sprzed tylu dni albo NULL;
  - brak wiadomości w czacie i **brak zgłoszeń jako zgłaszający** (`chat_reports.reporter_id` ma klucz obcy bez kaskady).

  Usuwane są katalog awatara oraz wiersze `user_profiles`, `billing_accounts`, `chat_mutes`, `account_audit` (dotyczące tej osoby) i `users`, w porcjach po 50. **Każde konto ma własną transakcję i własne `try/catch`:** błąd jest logowany bez danych osobowych (klasa i SQLSTATE), a zadanie przechodzi do następnego konta. Przypadki brzegowe opisuje pytanie P9.

### 3.8 Usunięcie konta przez członka (privacy-by-design; tekst prawny w kolejnej sesji)
- **Trasa:** `account-delete {password, endSubscription?}`, tylko dla `member`, limit 5/h i `reserveLogin` na własny e-mail.
- **Kolejność:**
  1. Sprawdzenie hasła (zły → 422 `Nieprawidłowe obecne hasło.`).
  2. `$ctx->releaseSession()` i, gdy istnieje `stripe_customer_id`, wymuszona synchronizacja `BillingSync::sync` (przez `class_exists`, poza transakcją), bo lokalny stan bez webhooków może być nieaktualny nawet o kilka dni.
  3. Stan `active` (subskrypcja trwa i **nie** kończy się) bez `endSubscription:true` → 409 `{confirmEnd:true}` z komunikatem `Masz aktywną subskrypcję. Usunięcie konta zakończy ją od razu, bez zwrotu za bieżący okres.`. Interfejs pokazuje potwierdzenie i ponawia z `endSubscription:true`. Stany `ending`, `ended`, `none`, `free` i `processing` nie blokują usunięcia (P22: zasady zwrotów ustali sesja prawna).
  4. **Stripe:** gdy istnieje klient, `DELETE /v1/customers/{id}`. Stripe kończy wtedy od razu jego subskrypcje i usuwa dane osobowe klienta; dokumenty, które musi przechowywać, zostają u Stripe. Błąd sieci albo 5xx nie wstrzymuje usunięcia: ustawiamy `stripe_redact_pending=1`, a zadanie `billing-due` ponawia próbę.
  5. **Transakcja w bazie:**
     - wiadomości: `Chat::tombstoneUser($pdo,$userId)` (dostarcza `chat-backend`, wołane przez `class_exists`): `state='deleted_author'`, `body=''`, każda z nowym `rev` kanału i korektą `msg_count`; dzięki temu znikają u innych jak każde usunięcie;
     - profil: wiersz `user_profiles` usunięty; wyciszenia usunięte;
     - `users` **anonimizowany, nie kasowany** (trzymają go klucze obce wiadomości i zgłoszeń): e-mail `deleted+<id>@invalid.matbravo`, losowy `password_hash`, `active=0`, `auth_version+1`;
     - `billing_accounts` zostaje jako **nagrobek bez danych osobowych**: `stripe_customer_id`, `stripe_subscription_id`, `sub_status`, `livemode` i `deleted_at=now`; pola zwolnienia i `pending_checkout_*` są czyszczone. Dzięki temu późniejsze zdarzenia Stripe dla tego klienta trafiają w znany wiersz i są tylko odnotowywane w audycie, a nie traktowane jako „osierocone”;
     - `account_audit` dostaje wpis `self.delete`; `billing_audit` zostaje, bo zawiera tylko id.
  6. Po zatwierdzeniu: usunięcie katalogu awatara, `Auth::clear()`.
- **Wyświetlanie.** Nagrobki usuniętego konta nie mają pola `a` (profil i `public_id` zostały usunięte), a interfejs pokazuje „Konto usunięte”. Konto tylko zablokowane (`active=0`, profil istnieje) ma w `people` wpis `{inactive:true}`, a interfejs pokazuje „Konto nieaktywne”.

### 3.9 Zmiana adresu e-mail członka (wymaganie 5: „to, co jest dziś”)
- **Członek sam:** `member-email {currentPassword,email}` (POST, `session`, `member`; limit 5/h oraz `reserveLogin` na obecny e-mail).
  - Walidacja jak przy rejestracji, zapis małymi literami.
  - `UPDATE users SET email=?,auth_version=auth_version+1 WHERE id=? AND role='member'`; 1062 → 409 `Nie można użyć tego adresu e-mail.` (neutralnie).
  - `Auth::enter` z nową wersją (inne urządzenia zostają wylogowane), wpis `self.email` w `account_audit` (bez adresów).
  - Po zatwierdzeniu, z zwolnioną sesją: `Billing::pushCustomerEmail($pdo,$userId)` przez `class_exists` (`POST /v1/customers/{id}` z nowym e-mailem). Błąd ustawia `next_sync_at=now`, a każda synchronizacja (także „Synchronizuj teraz” u Admina) porównuje e-mail klienta Stripe z naszym i go poprawia.
- **Admin:** `admin-member {action:'email',userId,email}` z tymi samymi kontrolami, `auth_version+1` (wylogowanie) i wpisem `email.change` w `account_audit`.
- **Personel:** e-mail zmienia się jak dziś w `account.save` (Domain).

### 3.10 Odzyskiwanie dostępu bez e-maili (v1) i wymuszona zmiana hasła
- **Adres pomocy.** Klucz `support_email` w config. `public-config` zwraca go jako `support`. Panel „Nie pamiętasz hasła?” mówi: „Napisz z adresu, na który założono konto, na {support}. Odpowiemy tylko na ten adres.”. **Bramka startu:** `signup_enabled=true` i token zaproszeń wymagają ustawionego `support_email` (walidacja config, §6.8).
- **Procedura Admina** (DEPLOY-PL.md, HANDOFF.md i krótka lista kontrolna w oknie resetu w `#members`):
  1. Prośba musi przyjść **z adresu zapisanego w koncie**. Admin nie odpowiada na żaden inny adres i nie resetuje hasła na prośbę telefoniczną.
  2. Admin wybiera „Ustaw hasło tymczasowe” (`admin-member {action:'password',userId}`; serwer generuje 16-znakowe hasło i zwraca je jednorazowo w odpowiedzi).
  3. Admin wysyła hasło **na adres skopiowany z panelu `#members`**, a nie z nagłówka „Od” wiadomości (nagłówek da się podrobić, a odpowiedź na adres z konta dociera tylko do właściciela skrzynki).
  4. Przy koncie płatnym Admin może dodatkowo poprosić o numer paragonu Stripe widoczny w `admin-billing`.
- **Wymuszona zmiana hasła.** Reset ustawia `user_profiles.pw_reset_at` i podnosi `auth_version`. Po zalogowaniu `me` zwraca `mustChangePassword:true` i `access.block='password'`; interfejs prowadzi do `#profile?tab=security`, a czat nie przyjmuje wiadomości (403 `Najpierw zmień hasło tymczasowe.`) do czasu zmiany (`member-password` czyści `pw_reset_at`).
- **Dziennik.** Każdy reset, zmiana e-maila, blokada i usunięcie trafia do `account_audit` z autorem.

---

## 4. API

### 4.1 Konwencje
- **Front controller.** `backend/public/api/index.php` zachowuje istniejące trasy i ich kontrakt. Na początku, po `matdraw_config()`, dochodzą trzy elementy (wszystkie **przed** połączeniem z bazą):
  1. **przerwa techniczna**: jeśli istnieje plik `Paths::shared($c).'/maintenance'`, każde żądanie dostaje 503, `Retry-After: 120` i `{error:'Trwa przerwa techniczna. Spróbuj ponownie za kilka minut.'}`;
  2. **wersja klienta**: gdy nagłówek `X-MatBravo-Client` jest liczbą mniejszą niż `min_client_api` (config; domyślnie stała `Routes::MIN_CLIENT_API=1`), odpowiedź 409 `{error:'Dostępna jest nowa wersja MatBravo. Odśwież stronę.',code:'client_outdated'}`. Brak nagłówka jest dozwolony (klienci sprzed tej zmiany nie mają service workera, więc i tak pobierają świeży kod). Liczbę podnosimy tylko wtedy, gdy zmienia się kontrakt trasy;
  3. **`Routes::dispatch($route,$config)`** dla nazw z rejestru `backend/routes/*.php`, z niepowtarzalnymi nazwami (duplikat kończy się `RuntimeException` przy starcie). Nieznane nazwy trafiają do istniejącej ścieżki, która odpowiada 404 jak dziś.
- **Definicja trasy:** `'nazwa'=>['method'=>'GET'|'POST','auth'=>'public'|'peek'|'session'|'upload'|'webhook','user'=>'required'|'optional'|'admin'|'member'|'anon','max'=>bajty,'types'=>[...],'tag'=>'chat'|null,'handler'=>callable(RouteContext):mixed]`.
- **Tryby `auth`:**

| Tryb | Sesja | CSRF/Origin | Ciało żądania | Uwagi |
|---|---|---|---|---|
| `public` | **żadna** (nie czyta ciasteczek, nie woła funkcji sesji) | — | — (tylko GET) | Domyślny nagłówek `Cache-Control: no-store`; trasa może ustawić `public, max-age=N`. **Bez `Vary: Cookie`**, bo odpowiedź nie zależy od ciasteczek. |
| `peek` | `Auth::peek` (tylko odczyt, §3.5) | — | — (tylko GET) | `Cache-Control: private, no-store` (albo własny nagłówek trasy `avatar`); nie tworzy plików sesji; odświeża aktywność najwyżej raz na 1/4 limitu bezczynności |
| `session` | `Auth::start` (jak dziś) | POST: `requireCsrf` | JSON, `application/json`, limit `max` (domyślnie 16 KB, głębokość 32) | Błąd zwraca `{error, csrf, ...data}`. Przed wołaniem Stripe i przed każdą pracą po odpowiedzi trasa wywołuje `$ctx->releaseSession()` (`session_write_close`). |
| `upload` | `Auth::start` | `requireCsrf` | surowe bajty, `Content-Type` z listy `types`, limit `max` sprawdzany przez `CONTENT_LENGTH` i odczyt `max+1` bajtów | tylko `avatar-upload` |
| `webhook` | żadna | — (podpis HMAC) | surowe bajty ≤ 1 MiB | tylko `stripe-webhook` |

- **Trasy z `tag='chat'`** odpowiadają 503, `Retry-After: 300` i `{error:'Czat jest chwilowo wyłączony. Spróbuj później.',code:'chat_off'}` **przed połączeniem z bazą**, gdy config ma `chat_force_off` albo istnieje plik `Paths::shared($c).'/chat-off'`.
- **Dane osobowe nigdy w adresie URL.** Parametry GET to wyłącznie id, kursory, wartości wyliczeniowe i numery stron. E-maile, imiona, nazwiska, frazy wyszukiwania i nazwy użytkowników idą w ciele POST, bo adresy trafiają do logów dostępu hostingu.
- **Błędy.**
  - `ApiError extends AppError` (nowy plik) przyjmuje dodatkowe `array $data`, które trafia do JSON, np. `retry`, `until` albo `code`.
  - Komunikaty są **polskimi literałami** w `new AppError('…'` / `new ApiError('…'`, bo tylko takie znajduje test i18n.
  - **Kod nowszy niż baza:** `PDOException` z SQLSTATE `42S02` (brak tabeli) albo `42S22` (brak kolumny) daje 503, `Retry-After: 120` i `Trwa przerwa techniczna. Spróbuj ponownie za kilka minut.` zamiast 500. Do logu trafia „schema behind code”.
  - **Logowanie wyjątków bez danych osobowych** (wspólna funkcja `Routes::logThrowable`, używana też w obu blokach `catch` w `index.php`): klasa, `basename(plik):linia`, a dla `PDOException` wyłącznie `errorInfo[0]` (SQLSTATE) i `errorInfo[1]` (kod sterownika), **nigdy komunikat** (MySQL wpisuje do niego zduplikowaną wartość, np. e-mail). Dla innych wyjątków komunikat obcięty do 200 znaków. Odpowiedź: 500 `Błąd serwera. Skontaktuj się z Administratorem.`.
- **Kody statusu:**
  - 400: zły format;
  - 401: brak lub wygaśnięcie sesji;
  - 402: wymagana subskrypcja;
  - 403: brak uprawnień, wyciszenie, niekompletny profil, hasło tymczasowe, Origin lub CSRF;
  - 404: brak obiektu albo obiekt niewidoczny (te same komunikaty dla obu przypadków);
  - 405 (z `Allow`), 413, 415;
  - 409: konflikt (duplikat, kanał tylko do odczytu, potwierdzenie końca subskrypcji, `client_outdated`);
  - 422: walidacja;
  - 429: limit (z `Retry-After` i `retry`);
  - 503: wyłącznik, przerwa, schemat starszy niż kod albo Stripe niedostępny.
- **Nagłówki** stałe jak dziś: `Content-Type: application/json; charset=utf-8` i `X-Content-Type-Options: nosniff`. Wyjątkiem są trasy obrazów (`avatar`), które ustawiają własne.

### 4.2 Tabela tras
Istniejące trasy pozostają **bez zmian kontraktu**: `session`, `bootstrap`, `login`, `logout`, `command`, `public` i `public-tournament`. Ich wnętrze zmienia się według §3.3.

| Trasa | Metoda | Tryb / kto | Plik / plasterek | Cache | Limit |
|---|---|---|---|---|---|
| `me` | GET | peek / zalogowany | `routes/core.php` / backend-api | private, no-store | — |
| `public-config` | GET | public / każdy | `routes/core.php` / backend-api | public, max-age=60 | — |
| `public-chat-channels` | GET | public / każdy | `routes/chat.php` / chat-backend | public, max-age=30 | — |
| `public-chat` | GET | public / każdy | chat | public, max-age=2 | — |
| `chat-channels` | GET | peek / zalogowany | chat | private, no-store | — |
| `chat-feed` | GET | peek / zalogowany (projekcja według dostępu) | chat | private, no-store | — |
| `chat-send` | POST | session / pełny dostęp | chat | no-store | odstęp 2 s, 20/min, 300/dobę (z `chat_settings`) |
| `chat-delete` | POST | session / autor lub admin | chat | no-store | 60/h |
| `chat-report` | POST | session / pełny dostęp | chat | no-store | 20/h |
| `admin-chat-reports` | GET | peek / admin | chat | private, no-store | — |
| `admin-chat-action` | POST | session / admin | chat | no-store | — |
| `admin-chat-settings` | GET | peek / admin | chat | private, no-store | — |
| `admin-chat-settings-save` | POST | session / admin | chat | no-store | — |
| `signup-begin` | POST | session / anonim | `routes/accounts.php` / accounts-profiles-backend | no-store | 60/h na IP |
| `signup` | POST | session / anonim | accounts | no-store | §3.6 |
| `username-check` | POST | session / zalogowany albo w trakcie rejestracji | accounts | no-store | 30/10 min na sesję, 300/10 min na IP |
| `profile` | POST | session / zalogowany | accounts | no-store | 30/h |
| `member-password` | POST | session / member | accounts | no-store | 10/h + `reserveLogin` |
| `member-email` | POST | session / member | accounts | no-store | 5/h + `reserveLogin` |
| `account-delete` | POST | session / member | accounts | no-store | 5/h + `reserveLogin` |
| `avatar-upload` | POST | upload / zalogowany | accounts | no-store | 10/h, ≤ 512 KB |
| `avatar-delete` | POST | session / zalogowany | accounts | no-store | 30/h |
| `avatar` | GET | peek / pełny dostęp albo właściciel | accounts | private, max-age=31536000, immutable + ETag | — |
| `admin-members` | POST | session / admin | accounts | no-store | — |
| `admin-member` | POST | session / admin | accounts | no-store | — |
| `diagnostics` | GET | peek / admin | accounts | private, no-store | `?probe=stripe` 6/h |
| `billing-checkout` | POST | session / zalogowany | `routes/billing.php` / billing-backend | no-store | 10/h |
| `billing-confirm` | POST | session / zalogowany | billing | no-store | 30/h |
| `billing-portal` | POST | session / zalogowany | billing | no-store | 20/h |
| `billing-sync` | POST | session / zalogowany | billing | no-store | 1 / 10 s, 30/h |
| `admin-billing` | GET | peek / admin | billing | private, no-store | — |
| `admin-billing-action` | POST | session / admin | billing | no-store | — |
| `stripe-webhook` | POST | webhook / Stripe | billing | no-store | 1 MiB |

### 4.3 Kształty żądań i odpowiedzi

**`me`** (GET): 200 albo 401 `Zaloguj się ponownie.`
```json
{"user":{"id":"…","clubId":null,"email":"m@x.pl","role":"member","active":true},
 "profile":{"publicId":"Xk3P9aQ2LmZt","username":"marta.k","firstName":"Marta","lastName":"Kowalska","country":"PL",
            "sports":["taekwondo","karate"],"clubText":"KS Tygrys","showClub":true,"nameDisplay":"initial",
            "avatar":"9f2c41ab07de","complete":true,"usernameChangeAt":null,"mustChangePassword":false},
 "access":{"full":true,"state":"active","until":1764547200,"canPost":true,"block":null,"mutedUntil":null},
 "billing":{"enabled":true,"enforce":true,"mode":"test","currency":"pln","amounts":{"pln":899,"usd":299},
            "exempt":false,"hasCustomer":true,"pending":false},
 "features":{"signup":true,"avatars":"gd-webp","chat":true}}
```
- `access.state` przyjmuje wartości `open|staff|free|grace|active|ending|past_due|processing|none|ended`.
- `access.block` przyjmuje wartości `null|'payment'|'profile'|'password'|'muted'|'off'`.
- `billing.currency` wylicza serwer (§6.1): waluta trwającej subskrypcji, a bez niej `pln` dla kraju PL, `usd` dla innego kraju i `null` bez kraju.
- `profile.avatar` to 12-znakowy `v` (ostatni plik) albo `null`. Klient sam składa adres `CONFIG.apiBase+'?route=avatar&id='+publicId+'&v='+v+'&s=64|256'`.
- `access.mutedUntil` pochodzi z `ChatModeration::mutedUntil` (wywołanie przez `class_exists`, bez zgadywania, czy tabela istnieje).
- Gdy `billing.enabled` jest wyłączone, `billing` zawiera tylko `{"enabled":false}`.
- Po wysłaniu odpowiedzi wykonują się `Jobs::maybe()` i, jeśli zaległa, leniwa synchronizacja płatności `BillingSync::lazy()` (wołana przez `class_exists`, §6.3); obie najpierw zwalniają sesję.

**`public-config`** (GET, bez sesji): `{"signup":true,"billing":true,"amounts":{"pln":899,"usd":299},"avatars":true,"support":"pomoc@matbravo.com"}`. Strona dla gości (karta „Nowe konto”, link w `login-help`, CTA czatu) korzysta z niej, zanim ktokolwiek się zaloguje, i według niej wybiera teksty (macierz w §6.10). Żadnych sekretów ani trybu Stripe. `signup` jest `false` także w trybie zaproszeń.

**`signup-begin`** (POST `{invite?}`): 200 `{ok:true}` albo 404 `Rejestracja jest chwilowo wyłączona.`.

**`signup`** (POST):
- Żądanie:
  ```json
  {"email","password","firstName","lastName","username","country":"PL","sports":["taekwondo"],"clubText":null,"showClub":false,"nameDisplay":"initial","website":"","invite":null}
  ```
- Odpowiedź 200: `{"user":{…},"csrf":"…"}`.
- Błędy:
  - 400: pułapka na boty albo czas wypełnienia (mierzony przez serwer);
  - 404: rejestracja wyłączona;
  - 409: e-mail albo nazwa zajęte;
  - 422: walidacja;
  - 429: limit.

**`username-check`** (POST `{"u":"marta.k","firstName":"Marta","lastName":"Kowalska"}`): 200 `{"status":"available"|"taken"|"invalid"|"reserved","suggestions":["marta.k2","marta_kowalska"]}`. Propozycje pojawiają się tylko przy `taken`; serwer daje maksymalnie 3 i sprawdza, że są wolne. Klient sam pomija sprawdzanie własnej obecnej nazwy. 403 `Najpierw rozpocznij rejestrację.`, gdy osoba nie jest zalogowana i nie rozpoczęła rejestracji.

**`profile`** (POST): przyjmuje pola profilu jak przy `signup` (bez e-maila i hasła). Zwraca 200 `{"profile":{…}}` albo 409 dla zajętej nazwy, 422 przy błędzie walidacji i 429 `Nazwę użytkownika można zmienić raz na 30 dni.` (z `retry`).

**`member-password`** (POST `{currentPassword,password}`):
- Złe obecne hasło daje 422 `Nieprawidłowe obecne hasło.` (komunikat już istnieje).
- Sukces podnosi `auth_version`, czyści `pw_reset_at`, wykonuje `Auth::enter` z nową wersją i zwraca 200 `{csrf}`.

**`member-email`** (POST `{currentPassword,email}`): 200 `{csrf,user}`; 409 `Nie można użyć tego adresu e-mail.`; 422 (zły adres albo złe hasło). Szczegóły w §3.9.

**`account-delete`** (POST `{password,endSubscription?}`): 200 `{ok:true,csrf}`; 409 `{confirmEnd:true}` przy trwającej subskrypcji; 422 przy złym haśle. Szczegóły w §3.8.

**`avatar-upload`** (POST, surowe `image/webp|image/jpeg|image/png`, nagłówek `X-CSRF-Token`): 200 `{"avatar":"<v>"}`. Błędy:
- 413 `Plik jest za duży.`;
- 415 `To nie jest obraz JPG, PNG ani WebP.`;
- 422 `Zdjęcie ma niepoprawne wymiary.`;
- 503 `Zdjęcia profilowe są chwilowo wyłączone.`.

**`avatar`** (GET `?id=<publicId>&v=<12 hex>&s=64|256`). **Kolejność kontroli jest częścią kontraktu:**
1. `Auth::peek` i dostęp oglądającego: pełny dostęp albo właściciel; inaczej 404.
2. Cel po `public_id`: konto `active=1`, a `user_profiles.avatar` zaczyna się od `v`; inaczej 404.
3. Dopiero teraz `If-None-Match` → 304.
4. Odczyt pliku i wysyłka z nagłówkami `Content-Type: image/webp|image/jpeg`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: private, max-age=31536000, immutable` i `ETag: "<v>-<s>"`.

Gość, osoba bez pełnego dostępu albo posiadacz starego adresu dostaje więc 404 także z poprawnym `ETag` (test).

**`admin-members`** (POST `{"q":"marta","filter":"all|paid|free|none|problem|muted","page":1}`, 50 na stronę):
- `q` ma najwyżej 100 znaków. Szukamy po prefiksie e-maila, nazwy użytkownika i nazwiska przez `LIKE ? ESCAPE '!'`, z wartością `strtr($q,['!'=>'!!','%'=>'!%','_'=>'!_']).'%'`, więc `_` i `%` nie działają jak symbole wieloznaczne (ten sam zapis w MySQL i MariaDB, niezależnie od trybu `NO_BACKSLASH_ESCAPES`).
- Filtr `muted` korzysta z `ChatModeration::mutedIds` przez `class_exists`.
```json
{"total":128,"page":1,"items":[{"id":"…","email":"…","username":"marta.k","name":"Marta Kowalska","country":"PL","createdAt":…,"lastLoginAt":…,
  "active":true,"billing":{"state":"active","until":…,"exempt":false,"reason":null},"mutedUntil":null}]}
```

**`admin-member`** (POST `{action,…}`):
- Akcje:
  - `create {email,password?,firstName,lastName,username,country,sports,free:true,reason,until?}` (bez hasła serwer generuje tymczasowe, zwraca je raz i ustawia `pw_reset_at`);
  - `active {userId,active}`;
  - `password {userId}` (hasło tymczasowe według §3.10, zwracane raz jako `temporaryPassword`);
  - `email {userId,email}` (§3.9);
  - `profile {userId,firstName,lastName,username,…}` (np. usunięcie obraźliwej nazwy);
  - `delete {userId}` (jak w §3.8, łącznie ze Stripe).
- Działa tylko na kontach `member`; dla innych ról odpowiada 404 `Konto nie istnieje.`.
- Zmiana `active`, hasła i e-maila podnosi `auth_version`.
- Każda akcja trafia do `account_audit` z autorem.

**`diagnostics`** (GET, admin):
```json
{"php":"8.3.x","gd":{"webp":true,"jpeg":true,"png":true},"exif":true,"curl":true,"openssl":true,"intl":true,
 "uploadsWritable":true,"avatarMode":"gd-webp","schema":{"db":4,"code":4},
 "sessions":{"handler":"files","ownDir":true,"files":1234},"backups":{"newestAgeHours":20},
 "billing":{"enabled":false,"mode":"test"},"chat":{"on":true,"health":{"429":0,"503":0,"508":0,"0":2}},
 "stripe":null}
```
- `?probe=stripe` (limit 6/h) wykonuje z poziomu PHP strony nieuwierzytelnione `GET https://api.stripe.com/v1/charges` z limitem 5 s i zwraca `"stripe":{"reachable":true,"status":401,"ms":180,"tls":"OpenSSL/3.0.13","error":null}`. To jedyny wiarygodny test, bo PHP strony (LSAPI) ma inną konfigurację niż CLI przez SSH. Sondę dostarcza `billing-backend` (`StripeClient::probe`, przez `class_exists`).
- `backups.newestAgeHours` pochodzi z `stat` najnowszego pliku w `~/matdraw/backups` (`null`, gdy katalogu nie da się odczytać).
- Bez sekretów.

**Trasy czatu:** §5.4–§5.6. **Trasy płatności:** §6.2–§6.4.

---

## 5. Czat

### 5.1 Kanały globalne (wymaganie 1)
| slug | Nazwa (klucz PL → EN) | Zasięg | Ikona | Kolejność | Opis w nagłówku (05 §4.4) |
|---|---|---|---|---|---|
| `taekwondo` | Taekwondo | `world`: „Świat” / „World” | glob SVG (zamiast 🌎) | 10 | „Dowolny język — najlepiej angielski” |
| `taekwondo-pl` | Taekwondo | `pl`: „Polska” / „Poland” | flaga PL w SVG (zamiast 🇵🇱) | 20 | „Rozmowy po polsku” |
| `karate` | Karate | `world` | glob | 30 | „Dowolny język — najlepiej angielski” |
| `general` | Ogólny → General | `world` | glob | 40 | „Wszystko o sztukach walki i MatBravo” |

- **Gdzie żyją nazwy.** W bazie są tylko slug i zasięg. Nazwy i opisy siedzą w kodzie (`Chat::LOBBY`) i w słownikach.
- **Emoji zastępujemy SVG**, bo Windows nie ma flag emoji i pokazuje „PL” literami (05 §4.1). Nazwy właściciela odpowiadają kanałom 1:1.
- **Kolejność jest stała.** Personalizacja dotyczy wyłącznie kanału wybranego domyślnie:
  1. ostatnio używany kanał (`localStorage['matdraw.chat.channel']`);
  2. dla członka: sport główny Taekwondo i kraj PL → `taekwondo-pl`; Taekwondo i inny kraj → `taekwondo`; Karate → `karate`; inny sport → `general`;
  3. dla gościa: język PL → `taekwondo-pl`, EN → `taekwondo`.

### 5.2 Kanały turniejów i cykl życia (wymaganie 2)
- **Tworzenie leniwe.** Kanał zakładamy przez `INSERT IGNORE INTO chat_channels (kind,tournament_id,public_key,created_at)` dopiero wtedy, gdy zalogowany użytkownik otworzy listę `chat-channels` albo wyśle pierwszą wiadomość do turnieju, który nie jest szkicem. Publiczne GET-y **nie zapisują** danych czatu (jedyny wyjątek to licznik `chat_health`, §5.10); turniej bez kanału pojawia się w nich z `id:null` i licznikiem 0.
- **Stan efektywny** (`Chat::tournamentState($t,$today,$viewer)`, gdzie `$today=date('Y-m-d')` to data w Warszawie, jak w `GuestView`):

| Warunek | Stan | Kto czyta | Kto pisze |
|---|---|---|---|
| `status='draft'` | `hidden` | nikt (404) | — |
| `status∈{open,closed,finished}` i `event_date ≥ today` | `open` | każdy, również gość | pełny dostęp |
| `status∈{open,closed,finished}` i `today − graceDays ≤ event_date < today` (domyślnie 1 dzień: do 23:59 dnia po turnieju) | `open` | **tylko zalogowani** (gość dostaje `st:'gone'`, tak samo jak `GuestView` nie pokazuje już tego turnieju) | pełny dostęp |
| `status∈{open,closed,finished}` i `event_date < today − graceDays` | `archive` (tylko odczyt) | **tylko zalogowani**; niepłacący widzą wiadomości z rozmytymi autorami | nikt |
| `chat_channels.status ∈ {readonly,closed}` (Admin) | `closed` | jak wyżej | nikt |

- **Okno gościa = okno `GuestView`.** Gość widzi kanał turnieju dokładnie tak długo, jak podgląd turnieju (`event_date ≥ today`). Dzięki temu link „Kategorie i drabinki” z czatu nigdy nie prowadzi gościa do 404, a `GuestView.php` zostaje bez zmian.
- **Dlaczego archiwum nie jest dla gości.** Spójność z `GuestView`, który chowa przed gośćmi minione turnieje, i ograniczenie długotrwałej publicznej ekspozycji rozmów o zawodnikach, często niepełnoletnich. To zawęża „czytać może każdy” z wymagania 3, więc **pytanie P3 wymaga wyraźnej zgody właściciela przed startem** (nie blokuje implementacji: to jedna reguła w `tournamentState`).
- **Oznaczenia w turnieju.** Wiadomości autora turnieju (`tournaments.created_by`) dostają w tym kanale flagę `o:1` (odznaka „Organizator”). Admin ma odznakę „Moderator”.
- **Przypięta wiadomość organizatora** wchodzi w v1.1 (pytanie P5).

### 5.3 Przechowywanie
- **Kolejność.** O kolejności wyświetlania decyduje `chat_messages.id`. Kursor pollingu to `rev`: każda zmiana kanału (nowa wiadomość, usunięcie, ukrycie, przywrócenie) dostaje kolejny `rev` kanału i zapisuje go w wierszu wiadomości. Klient z kursorem N dostaje więc **wszystkie** zmiany po N, łącznie z „nagrobkami” usuniętych wiadomości.
- **`cont`** liczymy przy zapisie, pod blokadą wiersza kanału. Wynosi 1, gdy poprzednia wiadomość według `id` ma tego samego autora, jest widoczna i powstała mniej niż 300 000 ms wcześniej. Dzięki temu goście widzą grupowanie bez tożsamości (świadomie ujawnia to „ten sam autor co poprzednio”). Klient ignoruje `cont`, gdy poprzednia wiadomość na ekranie jest nagrobkiem.
- **Liczniki.** `msg_count` i `last_message_id` aktualizujemy w tej samej transakcji co zapis: wysyłka +1, usunięcie albo ukrycie −1, przywrócenie +1.
- **Tekst.** Treść zapisujemy jako czysty tekst, nigdy HTML (§5.9).

### 5.4 Protokół odczytu (polling)
**Trasy i parametry.**
- `public-chat` dla anonimowych.
- `chat-feed` dla zalogowanych. Osoba z pełnym dostępem dostaje projekcję członka; zalogowany bez pełnego dostępu dostaje projekcję gościa z `private, no-store`.
- Oddzielne trasy są celowe: wspólny cache po URL nie może podać gościowi odpowiedzi z nazwiskami.
- Parametry, walidowane ściśle (inaczej 400 `Niepoprawne zapytanie czatu.`):
  - `ch=<id>:<rev>,…`: najwyżej 6 kanałów **otwartych na ekranie**; `rev=0` oznacza „ostatnie 50”;
  - `h=<id>:<lastReadId>:<knownLast>,…`: najwyżej 30 kanałów **w tle**, tylko liczniki nieprzeczytanych; `knownLast` to ostatni znany klientowi `last_message_id` kanału;
  - `cv=<wersja ustawień>`;
  - `e=<liczba>:<status>`: opcjonalny raport odpowiedzi hostingu od ostatniego sukcesu (§5.10); liczba 1–50, status 0, 429, 503 albo 508;
  - historia: `ch=<id>:0&before=<messageId>`, czyli 30 starszych wiadomości.

**Algorytm serwera.**
1. **Jedno** `SELECT id,kind,tournament_id,rev,last_message_id,status FROM chat_channels WHERE id IN (…)` dla kanałów z `ch` **i** `h` razem. Dla kanałów turniejów dochodzi `SELECT id,event_date,status,created_by FROM tournaments WHERE id IN (…)` (stan efektywny, widoczność). Kanał niewidoczny dla danej osoby → `ch.<id>.st='gone'` (albo `heads.<id>.st='gone'`).
2. `SELECT version,data FROM chat_settings WHERE id=1`.
3. Gdy każdy `rev` z `ch` równa się kursorowi, każdy `last_message_id` z `h` równa się `knownLast` i `cv` jest aktualne → **`204 No Content`**.
4. Kanały ze zmianami: `SELECT id,rev,user_id,body,cont,state,created_ms FROM chat_messages WHERE channel_id=? AND rev>? ORDER BY rev LIMIT 101`. Przy ponad 100 zmianach ustawiamy `more:true` i klient przeładowuje kanał od zera.
5. `rev=0`: `… WHERE channel_id=? ORDER BY id DESC LIMIT 51` (51. wiersz ustawia `older:true`), odwrócone do kolejności rosnącej. Do tego `rev` kanału jako nowy kursor.
6. `h`: **tylko dla kanałów, w których `last_message_id ≠ knownLast`**: `SELECT COUNT(*) FROM (SELECT id FROM chat_messages WHERE channel_id=? AND id>? AND state='visible' LIMIT 100) x`. Odpowiedź `heads.<id> = {last, n}`.
7. Tylko osoba z pełnym dostępem dostaje `People::project($pdo,$authorIds)` dla autorów w paczce (§7.6).

**Koszt bezczynnego zapytania** (zgodnie z §2.7): gość 2–3 zapytania po kluczu; członek dodatkowo odczyt pliku sesji bez blokady (`Auth::peek`) i jedno zapytanie `Chat::viewer` (`users ⋈ billing_accounts` po kluczu). Wyciszenia nie są potrzebne przy odczycie.

**Odpowiedź 200 (członek, `chat-feed`):**
```json
{"cv":7,"cfg":{"on":true,"t":"poll","ms":[2500,5000,10000,30000,60000],"idle":[60,180,600,1800],"bg":30000,"boost":300,"safety":60000,"notice":null},
 "ch":{"12":{"rev":4513,"st":"open","more":false,"older":true,
   "m":[{"id":99812,"r":4512,"t":1761933731120,"a":"Xk3P9aQ2LmZt","c":0,"b":"Powodzenia!"},
        {"id":99640,"r":4513,"t":1761930000000,"a":"Qw8…","x":"mod"}]}},
 "heads":{"1":{"last":99812,"n":3}},
 "people":{"Xk3P9aQ2LmZt":{"n":"Marta K.","u":"marta.k","cc":"PL","sp":["taekwondo","karate"],"club":"KS Tygrys","av":"9f2c41ab07de","mod":false,"since":"2026-10"}}}
```
- `cfg` przychodzi tylko wtedy, gdy klient ma nieaktualne `cv`.
- `x` oznacza nagrobek: `author`, `mod` albo `review`. Nagrobek nie ma pola `b`.
- `o:1` to organizator turnieju.
- Konto zablokowane ma w `people` wpis `{"inactive":true}`; nagrobki konta usuniętego nie mają pola `a`.

**Odpowiedź 200 (gość albo niepłacący: `public-chat` i `chat-feed` bez pełnego dostępu):** taki sam kształt, ale:
- **nie ma `people`**;
- wiadomość zawiera **wyłącznie** pola `id,r,t,g,c,b` (nagrobek: `id,r,t,g,x`), gdzie `g` to wariant dekoracji 0–4.

Wariant liczymy tak: `hexdec(substr(hash_hmac('sha256','chatghost|'.gmdate('Y-m-d',intdiv(created_ms,1000)).'|'.$channelId.'|'.$userId,app_key),0,8)) % 5`. **Co to ujawnia (poprawione po przeglądzie):** `g` jest stały dla wszystkich wiadomości jednej osoby w jednym kanale w ciągu jednego dnia, więc razem z `c` i czasem gość może pogrupować wypowiedzi jednej osoby w tym oknie (5 wariantów na wszystkich autorów). Nie da się tego połączyć między kanałami ani dniami, a `g` nie zawiera żadnej tożsamości. To świadomy kompromis: wariant losowany dla każdej wiadomości osobno sprawiałby, że jedna rozmowa wyglądałaby jak rozmowa wielu osób. Allow-listę definiuje **`backend/src/ChatGuestView.php`** (komentarz w nagłówku wylicza wszystko, czego nigdy nie wysyłamy oraz to, co ujawniają `g` i `c`), w duchu `GuestView`.

**Błędy odczytu:**
- 400;
- 401: tylko `chat-feed`; klient czyści dane tożsamości (niżej) i przechodzi na trasę publiczną z komunikatem „Zaloguj się ponownie”;
- 409 `client_outdated`: klient zatrzymuje polling i emituje `client-outdated` (§9.4);
- 503 i 429: z `Retry-After` oraz `{error,retry}`.

**`public-chat-channels` / `chat-channels`:**
```json
{"cv":7,"cfg":{…},
 "lobby":[{"id":1,"slug":"taekwondo","scope":"world","last":99812,"count":4513,"st":"open"}],
 "tournaments":[{"id":17,"tournamentId":"t-…","title":"Puchar Jesieni","date":"2026-11-14","city":"Warszawa","st":"open","last":120,"count":12}]}
```
- Wersja publiczna pokazuje tylko turnieje widoczne dla gościa (`event_date ≥ today`, nie szkice, nie zamknięte przez Admina). `id` może tu być `null`, gdy kanał jeszcze nie istnieje.
- Wersja `chat-channels` zakłada brakujące kanały dla turniejów niebędących szkicami i zwraca także dzień karencji oraz `archive` (najwyżej 50 ostatnich, sortowanych malejąco po dacie).
- Pola `tournamentId`, `title`, `date` i `city` są już publiczne przez trasę `public`, więc nie ujawniamy niczego nowego. Interfejs i tak wstawia je wyłącznie przez `textContent` (§5.9).

**Klient** (`dist/chat-transport.js`; 02 §5.6 obowiązuje z poniższymi zmianami):
- **Jeden poller na przeglądarkę.** Karty rejestrują kanały przez `BroadcastChannel('matbravo-chat')`. Lider zajmuje `navigator.locks.request('matbravo-chat-poller',…)` i odpytuje sumę kanałów. Bez Web Locks albo BroadcastChannel każda karta odpytuje sama, z podwojonym interwałem.
- **Interwały (poprawione po przeglądzie):**
  - **bezczynność liczymy wyłącznie od interakcji użytkownika**: wskaźnik, klawiatura, przewijanie i fokus w polu wiadomości; nowa wiadomość od innych nie jest interakcją;
  - `ms[0]` = 2,5 s, gdy czat jest widoczny i była interakcja w ciągu 60 s;
  - dalej `ms[1..4]` według progów `idle` (60/180/600/1800 s bez interakcji);
  - **przyspieszenie po nowej wiadomości:** do `ms[0]` tylko wtedy, gdy była interakcja w ciągu `cfg.boost` s (domyślnie 300); w przeciwnym razie najwyżej o jeden poziom szybciej i **nigdy poniżej `ms[1]`**; dzięki temu nieobsługiwany ekran (komputer w biurze klubu, drugi monitor) w ruchliwym kanale schodzi do `ms[2]` i wolniej;
  - `bg` = 30 s, gdy czat nie jest na ekranie, ale potrzebne są liczniki nieprzeczytanych;
  - **pauza**, gdy wszystkie karty są w tle albo przeglądarka jest offline;
  - ±20% losowego rozrzutu przy każdym opóźnieniu.
- **Natychmiastowe odpytanie** po `visibilitychange`→visible, `focus`, `pageshow`, `online`, otwarciu kanału i po własnej wysyłce (oraz jeszcze raz po ok. 1 s).
- **Higiena:**
  - nigdy dwa zapytania naraz;
  - `AbortController` z limitem 10 s;
  - `cache:'no-store'` dla `chat-feed`;
  - `credentials:'omit'` dla `public-chat`, przez `Client.publicGet`.
- **Błędy:**
  - sieć albo 5xx: `min(60 s, 2 s·2^n)·rand(0,5..1)`;
  - 429, 503 albo 508: `Retry-After` (domyślnie 15 s), potem jak wyżej;
  - każda odpowiedź 429/503/508 oraz odpowiedź, która nie jest JSON ani 204, zwiększa licznik raportu `e`, wysyłany przy następnym udanym zapytaniu i wtedy zerowany;
  - 401: tryb gościa (z wyczyszczeniem tożsamości);
  - `st:'gone'`: kanał znika z widoku.
- **Czyszczenie tożsamości (wspólne dla neutralnych urządzeń, np. laptopa w hali).** Zdarzenie `logout` z rejestru, komunikat `reset` na `BroadcastChannel('matbravo-session')` i odpowiedź 401 wywołują `purgeIdentity()`: czyści mapę `people`, wszystkie magazyny wiadomości, kursory, adresy awatarów i szkice (`sessionStorage` `matdraw.chat.draft.*`), po czym startuje od nowa na trasie publicznej. Po wylogowaniu `app.js` i tak przeładowuje stronę (§8.3), ale pozostałe karty dostają tylko komunikat `reset`.
- **Awatary w czacie:** `loading="lazy"`, kolejka najwyżej 2 jednoczesnych pobrań obrazów (atrybut `src` ustawiany dopiero po zwolnieniu miejsca) i inicjały do czasu wczytania. Bez kolejki pierwsze otwarcie czatu przez HTTP/2 zajęłoby naraz kilkadziesiąt procesów PHP.
- **Ustawienia serwera.** `cfg.on=false` zatrzymuje polling i pokazuje komunikat; ponowna próba następuje po `ms[4]`. `cfg.safety` jest zarezerwowane dla etapu 2.
- **Demo** (`dist/chat-demo.js`): ten sam interfejs, dane w `localStorage['matdraw.chat.demo.v1']`, a zdarzenie `storage` zastępuje polling.

### 5.5 Wysyłanie (`chat-send`)
- **Żądanie:** `{"ch":12,"cid":"V1StGXR8_Z5jdHi6B-myT","b":"Powodzenia!"}`, albo `{"t":"<tournamentId>",…}`, gdy kanał turnieju jeszcze nie istnieje.
- **Kolejność kontroli:**
  1. czat włączony (`cfg.on`), inaczej 503;
  2. zalogowany, inaczej 401;
  3. pełny dostęp, inaczej 402 `Ta funkcja wymaga aktywnej subskrypcji.`;
  4. kompletny profil (`Accounts::profileComplete`), inaczej 403 `Uzupełnij profil, aby pisać na czacie.`;
  5. brak hasła tymczasowego, inaczej 403 `Najpierw zmień hasło tymczasowe.`;
  6. brak wyciszenia, inaczej 403 `Moderator wstrzymał Twoje pisanie.` z `until`;
  7. **kanał widoczny dla tej osoby** (`Chat::visibleFor($viewer)`, ta sama funkcja co przy odczycie), inaczej 404 `Ten czat nie istnieje.`;
  8. kanał `open`, inaczej 409 `Ten czat jest tylko do odczytu.`;
  9. walidacja treści;
  10. limity, inaczej 429 `Wysyłasz wiadomości zbyt szybko. Spróbuj za chwilę.` z `retry`.
- **Normalizacja treści:** wspólne `Text::clean($s,['multiline'=>true])` (`backend-api`), używane też dla `clubText`, komentarzy zgłoszeń, notatek moderatora, powodów wyciszeń i komunikatu `notice`:
  - musi to być string;
  - `Normalizer::normalize(…, NFC)`, jeśli dostępny jest `intl`;
  - `\t` zamieniamy na spację, a następnie usuwamy całą kategorię `\p{Cc}` poza `\n` (w polach jednowierszowych także `\n`);
  - **usuwamy całą kategorię `\p{Cf}` poza U+200D** (łącznik emoji): znaki kierunku tekstu U+202A–U+202E i U+2066–U+2069, znaczniki U+200E, U+200F i U+061C oraz znaki zerowej szerokości U+200B, U+200C, U+2060 i U+FEFF;
  - dalej reguły czatu: najwyżej 2 kolejne puste linie i najwyżej 20 linii, `trim`, długość 1–1000 znaków (`mb_strlen`); inaczej 422 `Wiadomość jest pusta.` albo `Wiadomość może mieć najwyżej 1000 znaków.`.

  Ta sama reguła istnieje w `dist/profile-data.js` (`cleanText`), a wspólne przypadki testuje `tests/community.test.mjs`.
- **`cid`** musi pasować do `^[A-Za-z0-9_-]{22}$`.
- **Limity** liczymy po indeksie `chat_messages_user_time`:
  - ostatnia wiadomość użytkownika nie wcześniej niż `send.gap` s temu;
  - najwyżej `send.perMin` w ostatnich 60 s i `send.perDay` w ostatniej dobie.
- **Transakcja (krótka, blokuje tylko wiersz kanału):**
```sql
START TRANSACTION;
SELECT rev,status FROM chat_channels WHERE id=? FOR UPDATE;
SELECT user_id,created_ms,state FROM chat_messages WHERE channel_id=? ORDER BY id DESC LIMIT 1;   -- cont
UPDATE chat_channels SET rev=rev+1,last_message_id=?,msg_count=msg_count+1 WHERE id=?;           -- last_message_id po INSERT (lastInsertId)
INSERT INTO chat_messages (channel_id,rev,user_id,client_id,body,cont,state,created_ms) VALUES (?,?,?,?,?,?,'visible',?);
COMMIT;
```
  Praktyczna kolejność: najpierw `INSERT` z `rev = stary_rev + 1`, potem `UPDATE` kanału z `last_message_id = lastInsertId()`.
- **Idempotencja.** Duplikat `(user_id,client_id)` (1062) oznacza ponowioną wysyłkę: transakcja się wycofuje i odpowiedź zwraca istniejącą wiadomość.
- **Odpowiedź 200:** `{"m":{…projekcja członka…},"rev":4512,"people":{"<mój publicId>":{…}}}`. Klient pokazuje wiadomość od razu jako „wysyłana”, potwierdza ją odpowiedzią i **nie przesuwa kursora** ponad wiadomości, których jeszcze nie dostał. Zamiast tego odpytuje natychmiast.
- **Po zatwierdzeniu** wołamy `ChatBus::published($channelId,$rev)`, które w v1 jest sterownikiem `none` (no-op; hak pod etap 2).
- **`chat-delete {id,note?}`.**
  - Najpierw ta sama kontrola widoczności co przy wysyłce: wiadomość w kanale niewidocznym dla tej osoby albo nieistniejąca → 404 `Wiadomość nie istnieje.` (ten sam komunikat w obu przypadkach, więc nie da się badać ukrytych kanałów).
  - Autor może usunąć własną widoczną wiadomość; Admin każdą.
  - Ta sama transakcja z blokadą kanału: `rev+1`, `UPDATE chat_messages SET state='deleted_author'|'deleted_mod', body='', rev=?, changed_ms=?`, `msg_count−1`.
  - **Oryginał trafia do `chat_mod_log.original_body` tylko przy usunięciu przez moderatora albo przy usunięciu przez autora wiadomości, która ma otwarte zgłoszenia.** Zwykłe usunięcie własnej wiadomości (często po to, by usunąć przypadkowo podane dane) nie zostawia kopii treści.
  - Moderator może dodać notatkę. Odpowiedź 200 `{ok:true}`.
- **`Chat::tombstoneUser(PDO,$userId)`** (dla usunięcia konta, §3.8): w porcjach po kanałach, każda zmiana z nowym `rev` i korektą `msg_count`, bez kopii treści w dzienniku.

### 5.6 Moderacja
- **Moderatorem w v1 jest tylko `admin`.** Organizator ma tylko odznakę.
- **Zgłoszenie (`chat-report {id,reason,comment?}`).**
  - Najpierw kontrola widoczności jak w `chat-delete` (404 `Wiadomość nie istnieje.` dla niewidocznych i nieistniejących).
  - Wymaga pełnego dostępu i nie dotyczy własnych wiadomości. Powody: `spam`, `abuse`, `harassment`, `child_data`, `other`; komentarz do 300 znaków po `Text::clean`.
  - Ponowne zgłoszenie tej samej osoby jest idempotentne (200).
  - `report_count+1`.
  - Gdy liczba **różnych** zgłaszających osiągnie `autoHide` (domyślnie 3, pytanie P4), wiadomość dostaje `state='hidden_review'` i `rev+1`, a do dziennika trafia `auto_hide` z kopią treści (wiadomość ma otwarte zgłoszenia).
- **`admin-chat-reports`** (GET `?status=open&page=`) zwraca listę pogrupowaną po wiadomości:
  - pełna treść, także ukryta albo usunięta (z `original_body`, jeśli dostępne);
  - autor, czyli dane członka i jego id;
  - liczby zgłoszeń według powodu;
  - kontekst pobierany osobno przez `?context=<messageId>`: 2 wiadomości przed i 2 po.

  Interfejs moderacji wstawia treści, komentarze, e-maile i nazwy wyłącznie jako tekst (§5.9).
- **`admin-chat-action`** (POST):
  - `delete {messageId,note?}`;
  - `restore {messageId}`, tylko dla `hidden_review`;
  - `dismiss {messageId}` zamyka zgłoszenia i przywraca wiadomość z `hidden_review`;
  - `mute {userId,duration:'1h'|'24h'|'7d'|'perm',reason?}` robi upsert w `chat_mutes`;
  - `unmute {userId}`;
  - `channel {channelId,status:'open'|'readonly'|'closed'}`.

  Każda akcja trafia do `chat_mod_log`.
- **`admin-chat-settings` i `admin-chat-settings-save`.**
  - Przełącznik czatu, preset tempa i komunikat (`notice`, wolny tekst ≤ 300 znaków po `Text::clean`, pokazywany bez tłumaczenia i zawsze jako tekst).
  - Presety tempa: „Normalne” 2,5 s, „Oszczędne” `[5000,10000,30000,60000,120000]` i „Awaryjne” `[15000,30000,60000,120000,300000]`.
  - Odczyt pokazuje też „Odpowiedzi hostingu w ostatniej godzinie: 429 · 503 · 508 · błędy sieci” z `chat_health` (§5.10).
  - Każdy zapis podnosi `version` o 1.
- **`ChatModeration::mutedUntil(PDO,$userId)` i `mutedIds(PDO,$ids)`** to jedyne miejsca, które czytają `chat_mutes` spoza czatu (dla `me` i `admin-members`, przez `class_exists`).
- **Ukrycie osoby „u mnie”** (05 §9.3) oraz wyciszenie kanału działają w v1 **na urządzeniu** (`localStorage`, klucze z `publicId` zalogowanej osoby, np. `matdraw.chat.u.<publicId>.hidden`) **[nadpisuje 05 §4.5/§9.3]**. Kursory przeczytania też są lokalne. Synchronizacja między urządzeniami to v1.1.

### 5.7 Limity (zestawienie)
| Działanie | Limit | Gdzie |
|---|---|---|
| wysyłka | odstęp 2 s, 20/min, 300/dobę | `chat_settings.send` (strojone) |
| usunięcie | 60/h | `RateLimit` |
| zgłoszenie | 20/h | `RateLimit` |
| odczyt | dyscyplina klienta (jeden poller, bezczynność od interakcji) + `cfg.ms` + wyłącznik | — (bez limitu po IP w v1, bo hale sportowe mają jedno IP za NAT) |
| raport `e` | najwyżej 50 na zapytanie, licznik ograniczony do 1 000 000 na godzinę i status | `chat_health` |

### 5.8 Retencja (zadanie `chat-retention`, co godzinę, porcjami po 500)
- Wiadomości starsze niż `retentionDays` (domyślnie 365) są usuwane razem ze zgłoszeniami (`ON DELETE CASCADE`). Raz na dobę liczymy od nowa `msg_count` usuniętych kanałów.
- `chat_mod_log.original_body` starsze niż `modKeepDays` (30) dostaje `NULL`.
- Usuwamy wygasłe wyciszenia, rozstrzygnięte zgłoszenia starsze niż 180 dni i wiersze `chat_health` starsze niż 14 dni.
- Kanały turniejów z pustą historią po retencji zostają (to tanie).

### 5.9 Bezpieczne renderowanie (XSS)
- **Zasada ogólna (rozszerzona po przeglądzie):** **każda wartość z API** trafia do DOM wyłącznie przez `textContent`, `document.createTextNode` albo przez szablon `h`, który ucieka każdą wstawkę. Dotyczy to wiadomości, imion, nazw użytkowników, klubów, krajów, a także: komunikatu Admina `notice`, komentarzy zgłoszeń, `original_body`, tytułów i miast turniejów (piszą je konta klubów), e-maili i nazwisk na liście członków oraz tekstów stanów z płatności.
- **Szablon `h` (`dist/registry.js`, `frontend-foundation`).** `h` to funkcja tagująca szablony: każde `${…}` jest uciekane, chyba że wartość jest obiektem `SafeHtml` utworzonym przez inne wywołanie `h` (zagnieżdżanie). Zwykły string, także wynik `T()`, jest zawsze uciekany. `setHtml(el, safe)` przyjmuje wyłącznie `SafeHtml` i rzuca wyjątek dla zwykłego stringa. Strony z rejestru zwracają `SafeHtml`.
- **Test statyczny `tests/xss-scan.test.mjs` (`frontend-foundation`)**, w duchu testu i18n: w nowych modułach (`registry.js`, `me.js`, `chat*.js` łącznie z `chat-admin.js`, `moderation-boot.js`, `account*.js`, `members-boot.js`, `admin-members.js`, `avatar-crop.js`, `pwa.js`) nie wolno użyć `innerHTML`, `outerHTML`, `insertAdjacentHTML` ani `document.write`, z wyjątkiem jednej definicji `setHtml` w `registry.js`. Nie wolno też tworzyć elementów `<script>` ani ustawiać atrybutów `on*`. Celowo dodane naruszenie musi wywołać błąd testu.
- **Linki.** Szukamy ich wyrażeniem `/\bhttps?:\/\/[^\s<>"']+/g`, obcinając końcowe `.,;:!?)`. Dla każdego trafienia:
  - `new URL()`, z dozwolonymi wyłącznie protokołami `http:` i `https:`;
  - element `<a>` utworzony przez `createElement`, z `href` przez właściwość, `rel="noopener noreferrer nofollow ugc"` i `target="_blank"`;
  - tekst bez protokołu, najwyżej 60 znaków z wielokropkiem.

  Goście zamiast linku widzą sam tekst domeny (05 §6.2). Panel moderacji pokazuje treści bez linków, jako czysty tekst.
- Brak markdown, HTML, podglądów linków i obrazków w wiadomościach.
- **Testy:** `tests/chat-client.test.mjs` przepuszcza złośliwe treści (`<img onerror>`, `javascript:`, `"><svg>`, znaki kierunku) przez funkcję tokenizującą i sprawdza, że powstają tylko węzły tekstowe i bezpieczne linki. Dochodzą przypadki komunikatu `notice` i tytułu turnieju z HTML. `tests/chat-admin.test.mjs` robi to samo dla panelu moderacji (komentarz zgłoszenia i `original_body` z HTML).

### 5.10 Wyłącznik, strojenie zdalne i wykrywanie ograniczeń hostingu
- **Awaryjnie, przez SSH:** `touch ~/matdraw/shared/chat-off` wyłącza czat (503 z `code:'chat_off'` przed bazą), a `rm` go przywraca. Alternatywnie klucz `chat_force_off`.
- **Na co dzień, z panelu Admina:** `cfg.on`, presety tempa i komunikat. Klienci dostają zmiany przy następnym zapytaniu, bez wdrożenia.
- **Wykrywanie ograniczeń hostingu.** Odpowiedzi 429/503/508 z LiteSpeed albo CloudLinux powstają **przed** PHP, więc serwer ich nie widzi. Dlatego raportuje je klient (parametr `e` w §5.4). Serwer dopisuje je do `chat_health` (godzina, status, liczba; bez IP i bez użytkowników) jednym upsertem tylko wtedy, gdy parametr jest obecny. Panel ustawień czatu i `diagnostics` pokazują sumy z ostatniej godziny.
  - **Bez automatycznej zmiany presetu w v1:** licznik zasilają anonimowi klienci, więc automat dałoby się nadużyć do spowolnienia czatu wszystkim. Decyzję podejmuje Admin; DEPLOY-PL.md podaje próg orientacyjny (np. ponad 50 zgłoszeń 429 w godzinie → preset „Oszczędne”).

### 5.11 Etapy 2 i 3 (zaprojektowane, poza tym wdrożeniem)
- **Etap 2: statyczny beacon** (02 §3e).
  - `ChatBus` z napędem `beacon` zapisuje `~/matdraw/shared/live/lobby.json` oraz pliki gości `live/c/<public_key>.json`.
  - `deploy-remote.sh` tworzy dowiązanie `public/live`.
  - Klienci wybierają transport przez `cfg.t='beacon'`.
  - Warunek: pomiary na web9 z 02 §6 (304 bez PHP, brak 429, format ETag).
- **Etap 3: push zewnętrzny**, sam sygnał bez treści (Ably/Pusher, klaster EU). Wymaga zmiany CSP `connect-src` i umowy powierzenia przetwarzania danych (DPA). Decyzja tylko przy setkach jednoczesnych czytelników.
- **Bez wskaźników pisania. Licznik obecnych jest wyłączony.**

### 5.12 Odstępstwa od raportów 02 i 05
- **[nadpisuje 02 §5.1]**:
  - slugi kanałów jak w 05;
  - czas w `created_ms BIGINT`;
  - stan wiadomości w `state` zamiast `deleted_at`;
  - nowe pola `cont`, `msg_count` i `last_message_id`;
  - ustawienia w kolumnie `TEXT`.
- **[nadpisuje 02 §5.3]**: wariant gościa `g` ma 5 wartości (05) i zależy od dnia wiadomości; dochodzą parametry `h=<id>:<lastReadId>:<knownLast>` (liczniki w tle, liczone tylko po zmianie), `e=` (raport odpowiedzi hostingu) i `before=` (historia); zalogowani bez pełnego dostępu korzystają z `chat-feed` w projekcji gościa.
- **[nadpisuje 02 §5.6]**: bezczynność liczymy wyłącznie od interakcji użytkownika, a przyspieszenie po nowej wiadomości jest ograniczone (`cfg.boost`, §5.4).
- **[nadpisuje 05 §4.1]**: kraje autorów pokazujemy jako chip z kodem (`PL`, z pełną nazwą w `title` i tekście dla czytników ekranu) zamiast fontu z flagami (pytanie P6).

---

## 6. Płatności (Stripe)

Raport 03 obowiązuje w całości z odstępstwami z §6.11. Poniżej streszczenie wiążących ustaleń.

### 6.1 Produkt i ceny
- **Produkt:** `matbravo_membership`.
- **Ceny**, obie z `recurring[interval]=month`:
  - `matbravo_monthly_pln` = 899 PLN;
  - `matbravo_monthly_usd` = 299 USD.
- **Rozstrzyganie cen.** Kod zamienia `lookup_key` na id ceny przez `GET /v1/prices?lookup_keys[]=…&active=true` i trzyma wynik 24 h w `billing_kv`. Gdy Stripe zwróci `resource_missing`, cache jest unieważniany i zapytanie ponawiane raz.
- **Kwoty do wyświetlania** są w config `billing_amounts`. `stripe-setup.php` sprawdza, czy zgadzają się z cenami w Stripe.
- **Waluta wynika z kraju (poprawione po przeglądzie; P20).** `profile.country==='PL'` → PLN, każdy inny kraj → USD. Użytkownik **nie wybiera** waluty, bo wtedy każdy spoza Polski mógłby zapłacić taniej i regionalna cena właściciela przestałaby działać. Bez kraju strona planu prosi najpierw o wybór kraju (zapisywany w profilu). Waluta trwającej subskrypcji jest zablokowana. Admin może ją zmienić dla konta bez trwającej subskrypcji (`admin-billing-action {action:'currency'}`). Ryzyko szczątkowe: kraj w profilu deklaruje sam użytkownik.
- **Wyłączone:** Adaptive Pricing i `currency_options`.

### 6.2 Przepływy
- **`billing-checkout {}`** (waluta zawsze z serwera, §6.1):
  1. limit 10/h;
  2. trwająca subskrypcja → 409 `Masz już aktywną subskrypcję.` z `{portal:true}`;
  3. brak kraju w profilu → 422 `Wybierz kraj w profilu, aby wybrać plan.`;
  4. otwarta sesja w tej samej walucie, wygasająca za więcej niż 5 min, jest używana ponownie;
  5. w razie potrzeby zakładamy Customera z e-mailem konta (`Idempotency-Key: matbravo-customer-<userId>-<mode>-<seq>`; w metadanych tylko nasze id);
  6. `POST /v1/checkout/sessions` z parametrami z 03 §5.3: `mode=subscription`, `customer`, `client_reference_id`, `subscription_data[metadata][matbravo_user_id]`, `success_url=<app_url>/?billing=success&session_id={CHECKOUT_SESSION_ID}`, `cancel_url=<app_url>/?billing=cancel`, `locale`, `billing_address_collection=required`, `expires_at=+3600`; **nie wysyłamy** `payment_method_types`;
  7. zapisujemy `pending_checkout_*`;
  8. odpowiedź 200 `{url}`.

  Przed `location.assign(url)` klient sprawdza, że `new URL(url).origin==='https://checkout.stripe.com'`.
- **Powrót z płatności.**
  - Aplikacja czyta `?billing=…` z `location.search`, zapisuje `session_id` w `sessionStorage` i usuwa parametry (`history.replaceState`). Ma to działać także wtedy, gdy stronę podał service worker.
  - Gdy brak sesji (np. wygasła w trakcie płacenia), aplikacja pokazuje logowanie z komunikatem i po zalogowaniu ponawia `confirm`.
- **`billing-confirm {sessionId}`:**
  1. `sessionId` musi pasować do `^cs_(test|live)_[A-Za-z0-9]{10,250}$`;
  2. `GET /v1/checkout/sessions/{id}?expand[]=subscription&expand[]=subscription.latest_invoice`;
  3. kontrola własności: `client_reference_id===user.id`, `customer===zapisany`, `mode==='subscription'`; inaczej 403 `Nie można potwierdzić tej płatności.`, bez szczegółów;
  4. upsert stanu (§6.3);
  5. odpowiedź 200 `{access,billing,status}`.

  Gdy `status=incomplete`, klient ponawia co 3 s, najwyżej przez 30 s (05 §11.2).
- **`billing-portal`:** `POST /v1/billing_portal/sessions` z `return_url=<app_url>/?billing=portal` i `configuration=stripe_portal_configuration`. Odpowiedź 200 `{url}`; klient sprawdza origin `https://billing.stripe.com`.
- **`billing-sync`:** wymuszona synchronizacja po powrocie z portalu, najwyżej 1 na 10 s.
- **CSP bez zmian:** `fetch` do własnego API, potem `location.assign`. **Nigdy** formularz HTML z przekierowaniem do Stripe, bo zablokowałoby go `form-action 'self'`.

### 6.3 Poprawność bez webhooków (`BillingSync`)
- **Źródła prawdy**, od najszybszego:
  1. `confirm` po powrocie z płatności;
  2. `sync` po powrocie z portalu;
  3. **leniwa synchronizacja w `me`**: gdy `next_sync_at<=now` i udało się przejąć synchronizację, w funkcji zamykającej po wysłaniu odpowiedzi i po `session_write_close()`. **Tylko gdy istnieje `fastcgi_finish_request` albo `litespeed_finish_request`**; bez nich pomijamy ją, żeby nie opóźniać `me`;
  4. „Synchronizuj teraz” u Admina;
  5. zadania `billing-due` i `billing-events` „przy okazji”;
  6. opcjonalny cron `bin/stripe-sync.php --events --due` i `--reconcile` (raz na dobę).
- **Wywołania Stripe w tle** (leniwa synchronizacja i zadania): bez ponowień, `CURLOPT_CONNECTTIMEOUT=3`, `CURLOPT_TIMEOUT=8` (limit czasu rzeczywistego, w odróżnieniu od `set_time_limit`, które na Linuksie mierzy czas procesora). **Bezpiecznik:** błąd sieci albo 5xx zapisuje w `billing_kv` `stripe_down_until=now+600`, a do tego czasu każda synchronizacja nieinteraktywna jest pomijana. Wywołania interaktywne (checkout, confirm, portal, Admin) mają limit `stripe_timeout_seconds` i do 2 ponowień jak w 03.
- **`upsert` z obiektu Subscription** działa według 03 §8.2:
  - okresy rozliczeniowe czytamy z pozycji subskrypcji (wersja API `basil`+), z zapasowym odczytem starych pól;
  - `latest_invoice` jest rozwinięte;
  - właściciela szukamy po `stripe_subscription_id`, potem po `stripe_customer_id`, potem po `metadata.matbravo_user_id`, ale tylko gdy customer pasuje.
  - **Pierwszeństwo subskrypcji (poprawione po przeglądzie).** Gdy wiersz wskazuje już **inną** subskrypcję, przychodząca zastępuje ją tylko wtedy, gdy jest „lepsza”: stan nieterminalny (`active`, `trialing`, `past_due`, `incomplete`) wygrywa z terminalnym (`canceled`, `incomplete_expired`, `unpaid`, `paused`), a przy równych klasach wygrywa nowsze `created`. W pozostałych przypadkach tylko wpis `billing_audit` (`sub.ignored`). Bez tej reguły stara, zakończona subskrypcja A przetworzona po nowej B (np. `--reconcile` przegląda listę od najnowszych) odcinałaby płacącą osobę.
  - `--reconcile` najpierw grupuje subskrypcje po kliencie i zapisuje tylko najlepszą.
  - Wiersz-nagrobek (`deleted_at` ustawione, §3.8) nigdy nie zmienia stanu; zdarzenie trafia tylko do audytu.
- **`next_sync_at`** liczymy według tabeli z 03 §8.3. Najdłuższy odstęp to 7 dni.
- **Współbieżność** (03 §8.4):
  - przejęcie `UPDATE … SET sync_claimed_at=? WHERE user_id=? AND sync_claimed_at<?-60` musi dać `rowCount()===1` (dzierżawa **60 s**, dłuższa niż najdłuższe wywołanie);
  - zapis tylko z warunkiem `WHERE last_synced_at<=<czas startu pobrania>`;
  - **nigdy** wywołanie HTTP wewnątrz transakcji ani przy założonej blokadzie.
- **E-mail klienta Stripe.** Każda synchronizacja porównuje e-mail klienta z e-mailem konta i w razie różnicy go poprawia (zmiana adresu, §3.9).
- **`/v1/events`.** Kursor trzymamy w `billing_kv`; obsługujemy 15 typów z 03 §7.4. Idempotencję zapewnia `stripe_events`, wspólne dla zdarzeń pobranych i przysłanych webhookiem.
- **Treść zdarzenia** służy tylko do ustalenia, który obiekt się zmienił. Zawsze pobieramy go od nowa w przypiętej wersji API.
- **`billing-due`** obsługuje też wiersze z `stripe_redact_pending=1` (ponowienie `DELETE /v1/customers/{id}` po usunięciu konta).

### 6.4 Webhook (opcjonalny przyspieszacz)
- `stripe-webhook` odpowiada 404, gdy `stripe_webhook_secrets` jest puste albo `billing_enabled=false`.
- **Weryfikacja podpisu** (`StripeSignature::verify`, kod w 03 §7.2): HMAC-SHA256 z `"{t}.{rawBody}"`, tolerancja 300 s, wiele wartości `v1` i wiele sekretów (rotacja), porównanie przez `hash_equals`.
- **Kontrola zdarzenia:** `object==='event'`, `id` pasujące do `^evt_[A-Za-z0-9]+$` i `livemode` zgodne z `billing_mode`; inaczej 400.
- **Odpowiedzi:**
  - zdarzenie przetworzone albo duplikat: 200 `{"received":true}`;
  - błąd przetwarzania: 500 (Stripe ponowi);
  - nieznany typ: 200 i zapis.
- **Endpoint w Stripe** zakładamy (`stripe-setup.php --webhook`) dopiero po potwierdzeniu, że AfterMarket przepuszcza adresy IP Stripe (§9.11).

### 6.5 Maszyna stanów dostępu (`backend/src/Access.php`, czysta funkcja, `backend-api`)
`Access::compute(?array $row, array $user, array $cfg, int $now): array` zwraca `{full:bool, state, until}`. Pola subskrypcji wiersza, którego `livemode` nie zgadza się z bieżącym trybem, traktujemy jak puste. Warunki sprawdzamy po kolei:

| # | Warunek | `full` | `state` | `until` |
|---|---|---|---|---|
| 1 | `billing_enforce=false` | tak | `open` | — |
| 2 | `role==='admin'` | tak | `staff` | — |
| 3 | rola editor/club i **brak wiersza** | tak | `free` (powód `staff-default`) | — |
| 4 | `billing_exempt=1` i (`exempt_until` NULL albo `> now`) | tak | `free` | `exempt_until` |
| 5 | `active`/`trialing`, `cancel_at_period_end=0` | tak, póki `now < period_end + 72 h` (zapas na zaległą synchronizację) | `active` | `period_end` |
| 6 | `active`/`trialing`, `cancel_at_period_end=1` | tak, póki `now < period_end` | `ending` | `period_end` |
| 7 | `past_due` | tak, póki `now < current_period_start + grace_days` (7) | `past_due` | ta data |
| 8 | `billing_exempt=1` i `exempt_until ≤ now < exempt_until + grace_days` (koniec darmowego okresu, także po `requireFrom`) | tak | `grace` | `exempt_until + grace_days` |
| 9 | `incomplete` | nie | `processing` | — |
| 10 | `canceled`, `unpaid`, `incomplete_expired`, `paused`, `foreign` | nie | `ended` | — |
| 11 | pozostałe (brak wiersza członka, `sub_status='none'`, niezgodny `livemode`, koniec karencji) | nie | `none` | — |

`Access::of(PDO,$user,$cfg)` czyta wiersz jednym zapytaniem po kluczu głównym. Tabelę w całości testuje `tests/core.test.mjs` przez most PHP, łącznie z granicami czasowymi (także: wygasłe zwolnienie przy trwającej subskrypcji daje `active`, a nie `grace`).

### 6.6 Co może kto (przy `billing_enforce=true`)
| Funkcja | Gość | Zalogowany bez pełnego dostępu | Pełny dostęp (płatne, darmowe, personel) |
|---|---|---|---|
| Czytanie czatów globalnych i otwartych turniejowych | tak, autorzy ukryci | tak, autorzy ukryci | tak, z tożsamościami |
| Dzień karencji i archiwa czatów turniejów | nie | tak, autorzy ukryci | tak |
| Pisanie, zgłaszanie | nie (CTA według macierzy §6.10) | nie (CTA „Aktywuj konto”) | tak, po uzupełnieniu profilu |
| Własny profil (edycja) | — | tak (prywatny) | tak |
| Widoczność profilu dla innych | — | nie (nie pisze, więc nikt go nie widzi) | tak (w czacie i na karcie profilu) |
| Publiczne podglądy turniejów (`#guest`) | tak | tak (także członek, w trybie podglądu, §8.9) | tak |
| Workspace klubowy | — | członek nigdy; **personel: podgląd (`bootstrap`) zostaje, każde `command` poza `account.password` dostaje 402**; baner „Konto wymaga płatności” z przyciskiem planu | personel jak dziś |
| Płatności, portal, zmiana hasła, wylogowanie, usunięcie konta (członek) | — | tak | tak |

### 6.7 Admin
- **Lista kont personelu (`accountsPage`).** Dostaje plakietki planu („Darmowe”, „Darmowe do …”, „Darmowe (domyślnie)”, „Płatne do …”, „Karencja do …”, „Problem z płatnością”) przez `admin-billing?list=staff` → `{users:{<id>:{state,exempt,until,reason}}}`.
- **Formularz konta personelu.** Ma przełącznik „Darmowe konto” (§3.2) oraz wiersze tylko do odczytu: stan subskrypcji, ostatnia synchronizacja, „Synchronizuj teraz” i „Otwórz w Stripe”.
- **`admin-billing?userId=`** zwraca `{account:{…stan…},audit:[ostatnie 50]}`.
- **`admin-billing-action`** obsługuje akcje:
  - `exempt {userId,reason,until?}`: przy trwającej subskrypcji odpowiedź ma `{warnLive:true}`;
  - `require {userId}`: wiersz z `billing_exempt=0` (nowe konto personelu bez zwolnienia);
  - `requireFrom {date, scope:'grandfathered'|'user', userId?}`: koniec darmowego okresu z banerem i karencją (§3.2);
  - `currency {userId,currency}`: tylko bez trwającej subskrypcji (§6.1);
  - `resync {userId}`;
  - `cancelAtPeriodEnd {userId}`, czyli `POST /v1/subscriptions/{id} cancel_at_period_end=true`.

  Każda akcja trafia do `billing_audit` razem z autorem.
- **Blokada konta z trwającą subskrypcją.** Interfejs ostrzega i proponuje `cancelAtPeriodEnd`.

### 6.8 Konfiguracja
Pełna lista kluczy jest w Załączniku A. Najważniejsze: `billing_enabled`, `billing_enforce`, `billing_mode`, `stripe_secret_key` (klucz **ograniczony** `rk_…`), `stripe_webhook_secrets`, `stripe_api_base`, `stripe_api_version` (proponowane `2026-09-30.endive`, **potwierdzić w Workbench w dniu konfiguracji**), `stripe_prices`, `billing_amounts`, `stripe_portal_configuration`, `signup_invite_token` i `support_email`.

**Wartości domyślne.** `matdraw_config()` zwraca `array_replace(Config::DEFAULTS, $c)` (`backend/src/Config.php`, `backend-api`), z wartościami z Załącznika A. Kod nigdy nie czyta nowych kluczy z pominięciem tego scalenia, więc brak klucza w produkcyjnym `shared/config.php` po pierwszym wdrożeniu nie daje ostrzeżeń ani różnych wartości domyślnych w różnych plikach.

**Walidacja w `matdraw_config()`** (`RuntimeException('Invalid billing configuration.')` albo `RuntimeException('Invalid signup configuration.')`):
- przy `billing_enabled` (03 §4.1): prefiks klucza musi odpowiadać trybowi; sekrety webhooków muszą zaczynać się od `whsec_`; `stripe_api_base` musi być `https://`, z wyjątkiem `allow_insecure_http` i hosta pętli zwrotnej (atrapa w testach);
- **kombinacje przełączników:**
  - `billing_enforce=true` wymaga `billing_enabled=true` (inaczej członkowie straciliby dostęp bez możliwości zapłaty);
  - `signup_enabled=true` wymaga `billing_enforce=true`, chyba że ustawiono jawnie `signup_free_beta=true` (P16);
  - `signup_enabled=true` albo niepusty `signup_invite_token` wymaga `support_email` (§3.10), a token musi mieć co najmniej 24 znaki.

**Sekrety trzymamy wyłącznie w `~/matdraw/shared/config.php`** (chmod 600); nigdy w GitHubie ani w repozytorium.

### 6.9 Narzędzia CLI
- **`backend/bin/stripe-setup.php --mode=test|live [--webhook] [--rotate-webhook] [--reprice] [--dry-run]`**:
  - pełny klucz `sk_…` **nigdy w argumentach ani w linii poleceń powłoki**. Gdy STDIN jest terminalem (`stream_isatty(STDIN)`), skrypt sam pyta „Wklej klucz sk_… (nie będzie widoczny):”, wyłącza echo (`stty -echo`, a po odczycie przywraca je, także przy błędzie); gdy `stty` jest niedostępne, odmawia i podaje bezpieczną alternatywę: `read -rs K; printf '%s\n' "$K" | php …; unset K` (sam klucz nie trafia wtedy do historii powłoki). Przekierowanie STDIN zostaje dla CI;
  - każdy argument w stylu `--key=` albo wartość zaczynająca się od `sk_`/`rk_` w `argv` kończy się błędem (test);
  - idempotentny;
  - zakłada lub sprawdza produkt, ceny, konfigurację portalu (`metadata[matbravo_key]=portal_v1`) i opcjonalnie webhook;
  - wypisuje gotowy blok config (03 §4) i przypomnienie: „Po konfiguracji wygeneruj nowy klucz sk_ w panelu Stripe (Roll key). Na serwerze zostaje tylko klucz ograniczony rk_.”.
- **`backend/bin/stripe-sync.php [--events] [--due] [--reconcile] [--user=] [--limit=50] [--dry-run]`**:
  - blokada `GET_LOCK('matbravo_stripe_sync',0)`;
  - wypisuje tylko liczniki, bez e-maili;
  - sprząta `stripe_events` starsze niż 90 dni.

Oba narzędzia uruchamiamy przez `/usr/local/php83/bin/php`.

### 6.10 Kolejność włączania (bez ryzyka dla klubów) i macierz przełączników
**Kroki:**
1. Wdrożenie z `signup_enabled=false`, `billing_enabled=false` i `billing_enforce=false`. Migracja 0002 oznacza istniejące konta jako darmowe (przejściowo), a czat działa dla personelu.
2. `diagnostics?probe=stripe` w panelu Admina (PHP strony) i `server-check` (PHP CLI) potwierdzają połączenie z `api.stripe.com` (oczekiwane 401 w JSON). **To warunek przejścia dalej.** Potem `stripe-setup.php --mode=test` i klucze testowe w config.
3. **Okno testów właściciela:** `billing_enabled=true`, `billing_mode='test'`, `billing_enforce=true`, `signup_enabled=false` i `signup_invite_token` ustawiony. Rejestracja działa tylko z linku `#signup?invite=…`, więc nikt obcy nie założy konta, a personel pozostaje darmowy (`grandfathered`). Testy według 03 §14.3: karta 4242…, 3DS, zegary testowe, portal, usunięcie konta. Testowe subskrypcje mają `livemode=0`, więc po przejściu na tryb na żywo dają stan `none` (wiersz 11); konta testowe Admin usuwa w `#members`.
4. Konfiguracja na żywo (`--mode=live`) i klucz `rk_live`. Jedna prawdziwa płatność właściciela, zwrócona w panelu Stripe. `support_email` ustawiony, odpowiedzi na P2, P3, P8 i P19 udzielone.
5. `signup_enabled=true` (przy `billing_enforce=true`), usunięcie `signup_invite_token`. To jest start.

**Macierz (co widzi gość i co robi interfejs):**

| `signup` | `billing_enabled` | `billing_enforce` | CTA gościa w czacie | Karta „Nowe konto” i link w `login-help` | `ACCESS.kind` w promo | Krok 3 rejestracji (plan) | Uwagi |
|---|---|---|---|---|---|---|---|
| wył. (bez tokenu) | dowolnie | dowolnie | „Zaloguj się, aby pisać” | ukryte; dotychczasowy tekst o Administratorze | `login` | — | stan po kroku 1 |
| tylko token | wł. | wł. (test) | jak wyżej | ukryte; `#signup?invite=` działa | `login` | tak (tryb testowy) | okno testów, krok 3 |
| wł. | wł. | wł. | „Załóż konto · 8,99 zł / mies.” (cena z `public-config`) | widoczne, z ceną | `paid` | tak | start, krok 5 |
| wł. | wył. | wył. | „Załóż konto” (bez ceny) | widoczne, bez ceny | `free` | pominięty | tylko z `signup_free_beta=true` (P16) |

Interfejs wybiera wiersz **w czasie działania** z `public-config` (`signup`, `billing`), a nie ze stałych w kodzie. Kombinacje spoza tabeli odrzuca walidacja config (§6.8). Zadanie sprzątania porzuconych kont działa tylko przy `billing_enforce=true` (§3.7).

### 6.11 Odstępstwa od raportu 03
- **[nadpisuje 03 §5.1/§6]**: zamiast jednej trasy `billing` z polem `op` są osobne trasy (§4.2).
- **[nadpisuje 03 §10.2/§11]**:
  - `billing_accounts` powstaje w migracji 0002 (fundament), razem z wpisami dla istniejących kont;
  - konto personelu bez wiersza jest darmowe (wiersz 3 w §6.5).
- **[nadpisuje 03 §8.3]**: leniwa synchronizacja działa w trasie `me` po wysłaniu odpowiedzi i zwolnieniu sesji, tylko gdy da się wysłać odpowiedź wcześniej, bez ponowień i z bezpiecznikiem `stripe_down_until`; nie w `session`/`bootstrap`.
- **[nadpisuje 03 §8.2]**: reguła pierwszeństwa subskrypcji przy jednym wierszu `billing_accounts` (§6.3).
- **[nadpisuje 03 §5.3]**: waluta wynika z kraju w profilu, klient jej nie wybiera (§6.1).
- **[nadpisuje 03 §4]**: `stripe-setup.php` pyta o klucz z ukrytym echem; klucz nigdy w linii poleceń (§6.9).
- **[nadpisuje 03 §14.2 / 04 §2.f]**: atrapa Stripe to `tests/stubs/stripe-stub.mjs` (Node `node:http`).
- **Brak `billing_allow_promotion_codes` w v1.** Klucz istnieje, domyślnie `false`.

---

## 7. Profile i awatary (wymaganie 5)

### 7.1 Pola i walidacja (`backend/src/Profiles.php` i `dist/profile-data.js`, te same reguły po obu stronach)
| Pole | Reguła | Komunikat (klucz PL) |
|---|---|---|
| `firstName`, `lastName` | 1–50 znaków po `trim`; litery Unicode (`\p{L}`), znaki łączące (`\p{M}`), spacja, `-`, `'`, `.`; NFC | `Sprawdź pole: imię.` / `Sprawdź pole: nazwisko.` |
| `username` | §7.2 | `Sprawdź pole: nazwa użytkownika.` / `Tej nazwy nie można użyć.` / `Ta nazwa użytkownika jest zajęta.` |
| `country` | kod z `Profiles::COUNTRIES` (ISO 3166-1 alfa-2, 249 kodów + `XK`) | `Wybierz kraj z listy.` |
| `sports` | 1–5 różnych slugów z `Profiles::SPORTS`; pierwszy to sport główny | `Wybierz co najmniej jeden sport.` |
| `clubText` | opcjonalne, ≤ 100 znaków po `Text::clean` (NFC, bez `\p{Cc}` i bez `\p{Cf}` poza U+200D, jedna linia, §5.5) | `Sprawdź pole: klub lub szkoła.` |
| `showClub` | bool | — |
| `nameDisplay` | `initial` („Marta K.”, **domyślnie**) albo `full` („Marta Kowalska”); w rejestracji i profilu to niezaznaczone pole „Pokazuj członkom moje pełne nazwisko” (privacy-by-design; pytanie P7) | — |

**E-mail, klub workspace i rola** (wymaganie 5, „to, co jest dziś”) pozostają w `users`. Widzą je właściciel konta (`me`) i Admin. Innym członkom nigdy ich nie pokazujemy.

### 7.2 Nazwa użytkownika
- **Format:** `^[a-z][a-z0-9._]{2,23}$`, bez `..`, `._`, `_.` i bez kropki na końcu. Zapisywana małymi literami, porównywana po zamianie wielkich liter na małe.
- **Lista zastrzeżona** (`Profiles::RESERVED`): `admin`, `administrator`, `root`, `matbravo`, `matdraw`, `meducase`, `moderator`, `mod`, `support`, `pomoc`, `kontakt`, `system`, `api`, `stripe`, `billing`, `null`, `undefined`, `organizator`, `sedzia`, `staff`, `team`, `official`, `info`. Dochodzą prefiksy `matbravo*` i `admin*`.
- **Zmiana nazwy** najwyżej raz na 30 dni (`username_changed_at`). Pierwsze ustawienie nie liczy się do tego limitu.
- **Propozycje** (`username-check` przy `taken`): pierwsze dwie zgłoski z imienia i nazwiska po transliteracji (ł→l, ś→s, ż/ź→z, ą→a, ę→e, ć→c, ń→n, ó→o), następnie `imie.nazwisko`, `imie_nazwisko` i `imie.n2`. Imię i nazwisko przychodzą w ciele POST (nigdy w adresie). Serwer sprawdza dostępność i zwraca najwyżej 3.

### 7.3 Kraje
- **Pliki.** `dist/profile-data.js` eksportuje `COUNTRIES=[['AD','Andora','Andorra'],…]`, czyli kod, nazwę PL i nazwę EN. Nazwy wygenerowano raz skryptem `scripts/gen-countries.mjs` (Node 22 z pełnym ICU, `Intl.DisplayNames`) i zapisano w repozytorium. PHP ma tylko listę kodów.
- **Test zgodności.** `tests/community.test.mjs` sprawdza, że kody w JS i PHP są identyczne, a nazwy EN nie zawierają polskich liter (np. „Åland Islands”, „Côte d'Ivoire” są dozwolone).
- **Wybór kraju w formularzu.** Natywny `<select>`: Polska na górze, separator, dalej alfabetycznie według języka interfejsu (`localeCompare` z `locale()`). Domyślną wartość bierzemy z pierwszego wpisu `navigator.languages` z regionem (05 §10.4).
- **Plik danych `profile-data.js` jest wyłączony z reguły „brak polskich liter poza `T()`”** w teście i18n.

### 7.4 Sporty
- **Slugi w kolejności:** `taekwondo`, `karate`, `judo`, `kickboxing`, `bjj`, `jujitsu`, `boxing`, `mma`, `wrestling`, `muaythai`, `other`.
- **Etykiety** (klucze `T()`): Taekwondo, Karate, Judo, Kickboxing, Brazylijskie jiu-jitsu, Jiu-jitsu, Boks, MMA, Zapasy, Muay Thai, Inne. Angielskie wersje według 05 §19.7.
- **Kolory plakietek:** Taekwondo `#00679d/#e8f6fc`, Karate `#6b4aa0/#f2edfb`, pozostałe `#4d6480/#edf2f7`.

### 7.5 Awatary (`backend/src/Avatars.php`, `Capabilities.php`, `dist/avatar-crop.js`)
**Przeglądarka:**
1. `<input type=file accept="image/jpeg,image/png,image/webp">`, plik do 8 MB.
2. Odczyt przez `createImageBitmap(file)`, kadrowanie na `<canvas>` w okrągłej masce 280 px.
3. Przesuwanie myszą lub palcem, strzałkami (o 4 px, z Shift o 20 px), suwakiem „Powiększenie”, przyciskami +/− i „Wyśrodkuj”.
4. Podgląd 36 i 96 px rysowany na `canvas`.
5. **Bez `URL.createObjectURL`**, bo `blob:` jest zablokowany przez CSP.
6. Wynik: `canvas.toBlob('image/webp',0.86)` w rozmiarze 256×256, a gdy brak WebP, `image/jpeg` 0.88.
7. Wysyłka `Client.request('avatar-upload',{method:'POST',body:blob,contentType:blob.type})`.

**Serwer** (`Capabilities::avatarMode()` → `gd-webp` > `gd-jpeg` > `off`; **trybu bez GD z ręcznym parserem plików nie ma**, bo własny parser niezaufanych danych to zbędne ryzyko, a bez GD wystarczą inicjały):
1. Odrzucenie, gdy `avatars_enabled=false` albo tryb `off` (503).
2. Rozmiar: `CONTENT_LENGTH ≤ 524288`; odczyt najwyżej 524289 bajtów.
3. Rozpoznanie formatu: `getimagesizefromstring`. Dopuszczalne tylko JPEG/PNG/WebP (**nigdy SVG ani GIF**); wymiary 64–2048 px; najwyżej 4,2 mln pikseli (stały limit). Dodatkowo odrzucamy obraz, gdy `w·h·5 > memory_limit/2`, przy czym `memory_limit` parsujemy z przyrostkami `K`/`M`/`G`, a `-1` oznacza brak limitu (wtedy obowiązuje tylko limit pikseli).
4. **GD:** `imagecreatefromstring`, przycięcie do kwadratu ze środka, `imagecopyresampled` do 256 i 64 px, zapis `imagewebp` (82) albo `imagejpeg` (85). Ponowne kodowanie **usuwa EXIF, GPS i dołączone na końcu dane**. Orientację z EXIF uwzględniamy, jeśli jest `ext-exif`.
5. **Zapis:**
   - nazwa to pierwsze 32 znaki szesnastkowe SHA-256 wyniku;
   - ścieżka **zawiera `public_id` właściciela**: `Paths::uploads($c).'/avatars/'.substr($pid,0,2).'/'.$pid.'/'.$h.'-256.webp'` (oraz `-64`), więc dwie osoby z identycznym zdjęciem (np. logo klubu) nigdy nie dzielą pliku i usunięcie u jednej nie psuje drugiej;
   - zapis atomowy (`tmp` + `rename`), katalogi w trybie 0700, pliki 0600;
   - `UPDATE user_profiles SET avatar=?`, a dopiero potem usunięcie starego pliku **z katalogu tej samej osoby**;
   - zadanie `accounts-cleanup` usuwa w katalogu osoby pliki inne niż bieżący awatar (starsze niż 1 doba) oraz katalogi `public_id`, których nie ma w `user_profiles`.
6. **Usunięcie konta** kasuje cały katalog `avatars/xx/<public_id>/`.
7. **`v`** to pierwsze 12 znaków nazwy pliku. Adres zawiera `v`, więc cache przeglądarki może być `immutable`.

**`Paths::uploads($c)`** zwraca `uploads_dir` z config. Gdy go brak, zwraca `dirname(realpath(config.php)).'/uploads'`, czyli na produkcji `~/matdraw/shared/uploads`. **Odmawia ścieżki leżącej wewnątrz docroot** (`RuntimeException`).

**Serwowanie:** trasa `avatar` (§4.3). Statyczne dowiązanie `/u/` istnieje tylko jako opcja na przyszłość; jest wyłączone, bo awatary nie są publiczne (pytanie P10).

### 7.6 Projekcja publiczna (`backend/src/People.php`, `backend-api`)
`People::project(PDO $pdo, array $userIds): array` jednym zapytaniem `users JOIN user_profiles` zwraca mapę `id_wewnętrzne => wpis`. Wpis ma postać `{pid,n,u,cc,sp,club,av,mod,since}`:
- `n` zależy od `name_display`: domyślnie „Marta K.”, a „Marta Kowalska” tylko przy wyborze `full`;
- `club` tylko przy `show_club=1`;
- `mod` = rola `admin`;
- `since` to `YYYY-MM` z `created_at`;
- konto zablokowane dostaje `{pid,inactive:true}`; konto usunięte nie ma już `public_id`, więc jego nagrobki nie mają pola `a` (§3.8).

Projekcja **nigdy** nie zawiera e-maila, wewnętrznego id, roli innej niż flaga `mod`, klubu workspace ani stanu płatności. Dostają ją wyłącznie osoby z pełnym dostępem; dla gości i niepłacących obowiązuje §5.4.

### 7.7 Odstępstwa od raportu 05
- **[nadpisuje 05 §10.5]**: limit pliku po stronie serwera to 512 KB, bo przeglądarka zawsze zmniejsza obraz. Limit 8 MB dotyczy tylko pliku wybieranego w przeglądarce.
- **[nadpisuje 05 §10.2]**: e-mail weryfikujemy dopiero w etapie 2. Link „Nie pamiętasz hasła?” prowadzi do panelu z adresem pomocy i procedurą z §3.10 (prośba z adresu konta, hasło tymczasowe tylko na adres z konta, wymuszona zmiana). Raport 05 uznawał reset e-mailem za warunek kont płatnych; zastępuje go ta procedura oraz bramka startu „`support_email` ustawiony” (P8, P21).
- **[nadpisuje 05 §10.3]**: domyślne pokazywanie nazwiska to inicjał (`initial`); pełne nazwisko tylko z wyboru.

---

## 8. Architektura frontendu

### 8.1 Moduły
| Plik | Rola | Ładowanie | Właściciel |
|---|---|---|---|
| `dist/registry.js` | rejestr stron, tras publicznych, akcji, pozycji menu, plakietek i zdarzeń; `provide/use` dla helperów `app.js`; bezpieczny szablon `h`, `SafeHtml` i `setHtml` (§5.9) | statycznie (`app.js`) | frontend-foundation |
| `dist/me.js` | stan społecznościowy (`me`), `loadMe()`, `getMe()`, `onMe(fn)`, `canPost()`, `access()`, adapter demo, kanał `BroadcastChannel('matbravo-session')` (komunikat `reset` po wylogowaniu) | statycznie | frontend-foundation |
| `dist/client.js` | + `request(route,{method,body,contentType,signal})`, `publicGet(params,{signal,timeout})`, `apiUrl(params)` | statycznie | frontend-foundation |
| `dist/chat-boot.js` | rejestracja strony `chat`, pozycji menu, akcji, montowanie kart czatu po zdarzeniu `painted`; **leniwy `import('./chat.js')`** | statycznie (mały) | chat-frontend (zaślepkę tworzy foundation) |
| `dist/chat.js`, `dist/chat-transport.js`, `dist/chat-demo.js` | interfejs czatu, poller, atrapa demo | leniwie | chat-frontend |
| `dist/moderation-boot.js` | rejestracja strony `moderation` (nav admin, plakietka otwartych zgłoszeń), leniwy `import('./chat-admin.js')` | statycznie (mały) | chat-moderation-frontend (zaślepka z foundation) |
| `dist/chat-admin.js`, `dist/moderation.css` | panel moderacji `#moderation` (zgłoszenia, akcje, wyciszenia, ustawienia, licznik odpowiedzi hostingu) | leniwie | chat-moderation-frontend (zaślepki z foundation) |
| `dist/account-boot.js` | rejestracja `signup`, `profile`, `billing`, akcje `access-cta`, `my-account`; obsługa `?billing=` | statycznie (mały) | account-frontend (zaślepka z foundation) |
| `dist/account-flow.js`, `dist/avatar-crop.js` | rejestracja, profil, e-mail i hasło, plan/powroty, subskrypcja, usunięcie konta | leniwie | account-frontend |
| `dist/members-boot.js` | rejestracja strony `members` (nav admin); po `painted` i `saved` dla admina leniwy `import('./admin-members.js')`, który wypełnia `data-billing-badge` i `data-account-billing` | statycznie (mały) | members-frontend (zaślepka z foundation) |
| `dist/admin-members.js`, `dist/members.css` | panel „Członkowie”, plakietki planów i pola płatności w formularzu konta personelu | leniwie | members-frontend (zaślepki z foundation) |
| `dist/profile-data.js` | kraje, sporty, walidacja nazwy, `cleanText` (lustro `Text::clean`), wspólne z testami | z modułów konta i czatu | accounts-profiles-backend |
| `dist/pwa.js` | rejestracja service workera, pasek aktualizacji, karta instalacji, arkusz iOS, baner przeglądarek wbudowanych, `setManifestLanguage` | statycznie (musi przechwycić `beforeinstallprompt` przed `await Client.init()`) | pwa-frontend (zaślepka z foundation) |
| `dist/sw.js`, `dist/offline.html` | service worker (szablon), strona offline | — | pwa-core |
| CSS: `dist/tokens.css`, `chat.css`, `moderation.css`, `account.css`, `members.css`, `pwa.css` | tokeny i style funkcji | `<link>` w `index.html` | foundation tworzy pliki i linki; zawartość mają właściciele funkcji |
| `dist/i18n/{shell,accounts,chat,moderation,members,billing,home,pwa}-en.js` | słowniki EN funkcji | statycznie w `i18n.js` | foundation tworzy puste; wypełniają właściciele |

### 8.2 API rejestru (`dist/registry.js`, bez importów)
```js
registerPage({id,icon,label,nav:'global'|'event'|'admin'|null,roles:['admin','editor','club','member'],order,title,render:(params)=>SafeHtml})
registerPublicPage({id,render:(params)=>void})       // gdy brak workspace (gość); własny zapis do #app
registerAction(name,handler,{public:false})          // fallback drabinki data-action (zalogowany) / publicAction (gość)
page(id) / publicPage(id) / navItems(user,{tournament}) / handle(action,el,id,ctx) / defaultPage(role)
setBadge(id,n)                                       // aktualizuje [data-nav-badge=id] bez render()
on(event,fn) / emit(event,detail)                    // 'ready','painted','login','logout','language','saved','payment-required','client-outdated'
h`…${x}…` -> SafeHtml / setHtml(el,safe)             // każda wstawka uciekana, chyba że jest SafeHtml z innego h; setHtml odrzuca zwykły string
provide(name,value) / use(name)                      // app.js: provide('ui',{T,esc,icon,button,badge,modal,closeModal,toast,navigate,
                                                     //  shell,mascot,emptyMascot,render,commit,handleError,getWorkspace,getState,switchTournament,clubName})
parseRoute(hash) -> {page, params:URLSearchParams}   // '#chat?c=taekwondo-pl' -> {page:'chat',params}; '#czat' -> alias 'chat'
```
Strony rejestru zwracają `SafeHtml` synchronicznie; zwykle jest to `shell(placeholder)`. Moduły dopinają treść po zdarzeniu `painted`, jak dziś robi `paintUpcoming`. **Moduły nigdy nie wywołują `commit()` dla czatu, płatności ani profilu.**

### 8.3 Haki w `app.js` (jednorazowe, wykonuje je wyłącznie `frontend-foundation`)
1. **Importy na górze:** `import {registry} from './registry.js'; import './me.js'; import './chat-boot.js'; import './moderation-boot.js'; import './account-boot.js'; import './members-boot.js'; import './pwa.js';`. Zaraz po definicjach helperów: `registry.provide('ui',{…})`; `ui.shell` przyjmuje i zwraca `SafeHtml` (opakowuje istniejące `shell()`, które samo ucieka swoje wartości).
2. **Trasy.**
   - W `hashchange` (l.414) i przy starcie (l.417): `ui.page=registry.parseRoute(location.hash).page||'tournaments'`, z zachowaniem dotychczasowych wyjątków `#screen` i `#guest`.
   - `navigate(page,params)` dopisuje `?query`, gdy podano parametry.
3. **`render()`.**
   - Dla `role==='member'`: strona z rejestru dozwolona dla `member`, a w przeciwnym razie `registry.defaultPage('member')` (`chat`).
   - Mapa `pages` najpierw sprawdza `registry.page(ui.page)` i jego `roles`, z fallbackiem do `tournamentsPage`.
   - Tytuł bierze z `reg.title()`.
   - Na końcu `registry.emit('painted',{view:'app',page:ui.page})`.
4. **`shell()`.**
   - `globalNav` i `eventNav` dostają `registry.navItems(user,{tournament:t})`.
   - Dla `member` wbudowane pozycje (Turnieje, Baza zawodników, wybór turnieju, menu zawodów) są ukryte.
   - Pozycje `nav:'admin'` są tylko dla admina.
   - `nav()` renderuje `<span class="nav-badge" data-nav-badge="${id}" hidden></span>`.
   - Etykieta roli: `ROLES[user.role]||T('Członek')`.
   - `.profile .avatar` dostaje `data-self-avatar`.
5. **Drabinka `data-action`.**
   - `my-account` → `registry.page('profile')?navigate('profile'):myAccount()`.
   - Na końcu drabinki: `else registry.handle(action,el,id,{workspace})`.
6. **`publicAction`.**
   - `access-cta` → `ACCESS.kind==='login'?leaveGuest():registry.handle(...)`.
   - Na końcu: `else registry.handle(action,el,id,{public:true})`.
7. **`renderPublic()`.**
   - Najpierw `const p=registry.publicPage(registry.parseRoute(location.hash).page); if(p){p.render(params);registry.emit('painted',{view:'public',page});return;}`.
   - Potem dotychczasowa logika.
   - `renderLogin()` i `renderGuest()` emitują `painted` z `view:'login'` lub `view:'guest'`.
8. **Formularze, logowanie i wylogowanie.**
   - Po udanym `commit` w obsłudze `submit`: `registry.emit('saved',{form:form.id,type,payload,result})`. Po zalogowaniu: `registry.emit('login',{user})`.
   - **Wylogowanie (poprawione po przeglądzie, ochrona neutralnych urządzeń):** gałąź `logout` (l.330) wykonuje `await Client.logout(); registry.emit('logout'); purgeSession(); location.replace(location.pathname);`. `purgeSession()` (w `me.js`) usuwa z `sessionStorage` klucze `matdraw.chat.*`, `matdraw.signup.*` i `matdraw.billing.*` oraz wysyła `reset` na `BroadcastChannel('matbravo-session')`; inne karty po tym komunikacie czyszczą stan modułów i przeładowują się. Pełne przeładowanie jest najprostszą gwarancją, że w pamięci nie zostaną imiona, nazwy użytkowników, kluby ani awatary poprzedniej osoby.
   - **Identyfikatory formularzy.** Nowe formularze mają prefiksy `acct-`, `chat-` i `mod-` (np. `acct-profile-form`, `acct-password-form`) i obsługują je własne moduły. Identyfikatory przechwytywane przez `app.js` (`login-form`, `tournament-form`, `profile-form`, `entry-form`, `account-form`, `password-form`, `check-form`, `print-form`) są zastrzeżone; `integration-qa` sprawdza to grepem.
9. **`handleError`.** Nowa gałąź `if(error.status===402){registry.emit('payment-required',{message:error.message});}`, a potem dotychczasowy komunikat. Odpowiedź z `code:'client_outdated'` emituje `client-outdated` (robi to już `client.js`, §8.4).
10. **`rerenderLanguage`** na końcu: `registry.emit('language',{lang})`.
11. **Start.** Po `ready=true; render();`: `registry.emit('ready',{workspace})`.
12. **Zaślepki w panelu kont personelu:**
    - `accountsPage`: w komórce statusu `<span class="acct-plan-badge" data-billing-badge="${esc(u.id)}"></span>`;
    - `accountForm`: przed `.form-error` `<div data-account-billing="${esc(id||'')}"></div>`;
    - zdarzenie `saved` dla `account-form` przekazuje `result.id`.
    - Treść wypełnia `members-frontend` (`admin-members.js`).
13. **Zmiana języka na nowych stronach publicznych.** W gałęzi `!workspace` funkcji `rerenderLanguage` (l.420–425), **przed** `renderLogin()`: `const pr=registry.parseRoute(location.hash); if(registry.publicPage(pr.page)){registry.emit('language',{lang});return;}`. Moduł sam przerysowuje swoją stronę z zachowaniem stanu (wpisane dane rejestracji, kanał i szkic czatu). Bez tego przełączenie PL/EN na `#signup` albo `#chat` gościa podmieniało stronę na logowanie i gubiło wpisane dane.
14. **Podgląd turnieju dla członka (`#guest?t=`).** Trzy miejsca, które dziś to uniemożliwiają:
    - `render()` (l.82) przekierowuje `#guest` na `#tournaments` każdego zalogowanego: dla `role==='member'` zamiast tego `guest.memberPreview=true; renderGuest(); return;`;
    - `fetchGuest` (l.222) kończy pracę, gdy istnieje workspace (`if(guest!==current||workspace)return;`): warunek staje się `if(guest!==current||(workspace&&!guest.memberPreview))return;`;
    - drabinka kliknięć (l.327–328) przy workspace nie trafia do `publicAction`: gdy `guest?.memberPreview` i akcja zaczyna się od `guest-` (także nowe `guest-tab`), wywołujemy `publicAction(action,el,id)`.

    Szablony trybu podglądu (przycisk „Wróć”, brak promo, pasek kart) dodaje `home-embed`.
15. **`#screen` dla członka.** `render()` (l.81) i 15-sekundowy interwał (l.416) traktują rolę `member` jak `club`: członek nie dostaje ekranu hali (pusty workspace), tylko przekierowanie na `#chat`, a interwał nie woła `bootstrap` dla członka.
16. **Sprzątnięcie kluczy lokalnych po zalogowaniu innej osoby.** Klucze per osoba w `localStorage` mają w nazwie `publicId` (np. `matdraw.chat.u.<publicId>.hidden`), więc ustawienia jednej osoby nie są stosowane do drugiej na tym samym urządzeniu.

**Zakazy.** Na `#screen` nie montuje się żaden czat, karta PWA ani pasek, a `painted` nie jest tam emitowane. Wydruki (`#print-root`) są nietknięte.

**Druga runda zmian w `app.js` (`home-embed`, fala 2)** obejmuje wyłącznie szablony:
- `renderLogin` (siatka, punkty montowania, przycisk „Zaloguj się” w kompaktowym hero na telefonie), `upcomingSection` i `upcomingItem` (zaślepka `data-chat-count`);
- `guestPage`: pasek kart „Kategorie i drabinki | Czat turnieju” i akcja `guest-tab`;
- szablony trybu podglądu dla członka (przycisk „Wróć”, bez promo); logikę trasowania dodaje foundation (pkt 14);
- zaślepki w `tournamentsPage` (`data-chat-mount="strip"`, `data-chat-tournament-link`);
- tekst `login-help` z `data-account-mount`.

### 8.4 `client.js`
- **`request()`** używa prywatnego `csrf` i dotychczasowego mapowania błędów.
  - `204` → `null`.
  - Błąd → `DomainError(message,status)` z dodatkowym `error.data` (np. `retry`, `until`, `portal`).
  - Błąd sieci → dotychczasowy komunikat.
  - Odpowiedź, która nie jest JSON, poza 204 → dotychczasowy komunikat.
  - W trybie demo `request()` rzuca `Error('Ta funkcja jest niedostępna w wersji demonstracyjnej.')`, a moduły mają własne adaptery demo.
- **Wersja klienta.** Stała `CLIENT_API=1`; każde żądanie do API (także `publicGet` i istniejące trasy) ma nagłówek `X-MatBravo-Client: 1`. Odpowiedź 409 z `code:'client_outdated'` emituje `registry.emit('client-outdated')` i rzuca `DomainError` z tym kodem (§9.4).
- **`publicGet()`**: `credentials:'omit'`, domyślny limit 8 s, zwraca `{status,data}`. W trybie demo `publicGet({route:'public-config'})` zwraca `{status:200,data:{signup:false,billing:false,avatars:false,support:null}}` bez sieci.
- Komunikaty nowych błędów w `client.js` muszą mieć tłumaczenia EN, bo test i18n skanuje ten plik.

### 8.5 `me.js`
- **API trybu API:** `loadMe({force})` wywołuje `GET me` po `ready` i `login`, po `visibilitychange`→visible (najwyżej co 5 min) oraz po powrocie z płatności.
- **Tryb demo:** konta demonstracyjne mają `access.state='staff'` lub `'free'`, a rejestracja i płatności są wyłączone (`features.signup=false`, `billing.enabled=false`). **Profile kont demo (`demo-admin`, `demo-editor`, `demo-club`) są od razu kompletne** (fikcyjne imię, nazwisko, nazwa, kraj PL, sport), więc konto demo pisze na czacie bez uzupełniania profilu; zmiany zapisują się w `localStorage['matdraw.profile.demo.<userId>']`.
- **Zdarzenie 402** wywołuje `loadMe({force:true})`, a moduł konta prowadzi do `#billing`.
- **Brak trasy `me`** (np. wdrożenie bez backendu nowej wersji, odpowiedź 404) traktujemy jak „funkcje społecznościowe wyłączone”, bez komunikatu błędu.
- **`purgeSession()`** i nasłuch `BroadcastChannel('matbravo-session')` (§8.3 pkt 8): po komunikacie `reset` moduł emituje `logout` lokalnie i przeładowuje kartę.

### 8.6 i18n bez konfliktów
- **`i18n.js`** (foundation) importuje statycznie `i18n-en.js` oraz `./i18n/{shell,accounts,chat,moderation,members,billing,home,pwa}-en.js`.
  - Scalenie w `export const DICTIONARY` **w czasie działania „pierwszy wygrywa”**, a kolizje (ten sam klucz z inną wartością) trafiają do eksportowanej tablicy `collisions`. Wyjątek przy ładowaniu modułu zatrzymałby całą aplikację z powodu jednego sformułowania; zamiast tego testy (`i18n.test.mjs`, `registry.test.mjs`) wymagają, żeby `collisions` było puste.
  - Pięć miejsc, które dziś używają `Object.hasOwn(EN,…)` albo `EN[key]`, przechodzi na `DICTIONARY`.
- **Słowniki według właściciela:**
  - komunikaty serwera z fundamentu: na końcu `i18n-en.js` (`backend-data`, potem `backend-api`);
  - konta: `accounts-en.js`;
  - czat: `chat-en.js`;
  - moderacja: `moderation-en.js`;
  - panel członków: `members-en.js`;
  - płatności: `billing-en.js`;
  - powłoka (np. „Członek”, „Czat”): `shell-en.js`;
  - strona główna: `home-en.js`;
  - PWA: `pwa-en.js`.
- **Zmiany w `tests/i18n.test.mjs`** (foundation):
  1. Słownik scalony: `import {DICTIONARY as EN} from '../dist/i18n.js'`.
  2. Skan `T('…')` obejmuje wszystkie `dist/*.js`, z wyjątkiem `engine.js`, `workspace.js`, `guest-view.js`, `i18n*.js`, `lang-boot.js`, `runtime-config.js`, `sw.js`, `registry.js`, `profile-data.js`, `chat-demo.js` i `vendor/`. Warunek `used.size>300` zostaje.
  3. Reguła „brak polskich liter poza `T()`/`Error()`” obejmuje wszystkie skanowane moduły UI. Dane `profile-data.js` i `chat-demo.js` są wyłączone jawnie.
  4. Komunikaty PHP: glob `backend/src/*.php`, `backend/routes/*.php`, `backend/jobs/*.php` i `backend/public/api/index.php`. Wzorce: `new (?:AppError|ApiError)\('…'\s*[,)]` i `'error'=>'…'`. Etykiety pól z `Domain::txt` także w nowych plikach.
  5. JS: komunikaty `(?:Error|DomainError)\('…'` zbieramy ze **wszystkich** skanowanych modułów `dist/` (nie tylko z `client.js` i `me.js`, jak było w wersji 1), bo pokazuje je `translateMessage`; każdy wymaga wpisu EN.
  6. `collisions` ze scalenia słowników musi być puste.
- **Polskie liczebniki.** Słownik obsługuje angielskie `{one,other}`. W polskich kluczach używamy sformułowań niezależnych od liczby, np. „Nowe wiadomości: {n}” (05 §15).
- **Teksty interfejsu:** 05 §19 obowiązuje; własne teksty z §3–§7 tego planu dochodzą do odpowiednich słowników.

### 8.7 CSS
- **Kolejność w `index.html`:** `styles.css`, `print-layout.css`, `workspace.css`, `tokens.css`, `chat.css`, `moderation.css`, `account.css`, `members.css`, `pwa.css`, `brand.css` (ten ostatni ma ostatnie słowo).
- **Tokeny w `tokens.css`** (05 §18): `--chat-meta:#5b6f89`, `--chat-own:#f0f8fe`, `--chat-edge:var(--mb-cyan)`, `--chat-danger:#b3424a`, `--chat-field-border:#8296b0`, `--ghost-1…5`, `--sport-*`.
- **Prefiksy klas:** `chat-`, `ghost-`, `acct-`, `mem-`, `mod-`, `pwa-`, `home-`. Żadnych nowych selektorów elementów globalnych. `textarea` dostaje styl tylko w `.chat-composer`.
- **Warstwy (`z-index`):** nowe warstwy poniżej 100 (modale) i 200 (toast). Pasek PWA ma 90, arkusz iOS 95.
- **Breakpointy:** wyłącznie istniejące (440/650/651/800/1000/1199/1200/1650). `env(safe-area-inset-*)` tylko w czacie pełnoekranowym, arkuszach i pasku.
- **Druk:** `@media print` ukrywa `.home-chat`, `.chat-*`, `.mod-*`, `.pwa-*` i `.acct-join`. `prefers-reduced-motion` jest przestrzegane (05 §14).

### 8.8 Tryb demo (statyczny `dist/`, musi działać)
- **Czat:** `chat-demo.js` seeduje po ok. 8 przykładowych wiadomości w każdym kanale globalnym i jednym turniejowym (fikcyjni autorzy). Wysyłka kont demo trafia do `localStorage`. Synchronizacja między kartami odbywa się przez `storage`. Gość widzi w demo te same rozmyte placeholdery.
- **Konta:** rejestracja, płatności i przesyłanie awatara na serwer pokazują „Ta funkcja jest niedostępna w wersji demonstracyjnej.”. Edycja profilu zapisuje dane w `localStorage`. Awatar w demo to `data:` URL ≤ 30 KB, dozwolony przez `img-src data:`. Karta „Nowe konto” i CTA gościa w demo idą według wiersza „rejestracja wyłączona” z macierzy §6.10 (z `public-config` demo), czyli prowadzą do logowania kontem demo.
- **PWA:** worker nie jest rejestrowany (`CONFIG.mode!=='api'`), karta instalacji jest ukryta.

### 8.9 Strona główna i miejsca wejścia (wymaganie 1, 05 §2 i makieta)
- **Desktop ≥1200 px: obszary siatki `story chat auth`.**
  - **Lewa kolumna:** logo, eyebrow, H1 44 px, intro, następnie `upcoming-stage` z machającym Matbravo (`--mascot-h:196px`).
  - **Środkowa kolumna:** `<section class="home-chat" data-chat-mount="home" aria-labelledby="home-chat-title">`, karta `sticky`, `height:calc(100dvh - 48px)`, min. 560, maks. 900 px.
  - **Prawa kolumna:** formularz logowania bez zmian oraz `<div data-account-mount="join">` (karta „Nowe konto · 8,99 zł”). Notka i konta demo zostają w trybie demo.
  - Przy ≥1650 px kolumny wynoszą `400px minmax(560px,760px) 520px`.
- **Tablet 651–1199 px:** obszary `story auth / chat auth / upcoming foot`; karta czatu ma 560 px z własnym przewijaniem i stałym przyciskiem ⤢.
- **Telefon ≤650 px:**
  - kompaktowy hero;
  - karta podglądu (3 ostatnie wiadomości, chipy kanałów, przycisk „Otwórz czat”, odpytywanie co 10 s);
  - pełny czat jako trasa `#chat?c=…`;
  - gdy urządzenie ma `localStorage['matdraw.knownDevice']`, panel logowania stoi **nad** kartą czatu;
  - **zawsze** (także przy pierwszej wizycie po wdrożeniu, gdy `knownDevice` jeszcze nie istnieje) kompaktowy hero ma stały przycisk „Zaloguj się”, który przewija do formularza i ustawia na nim fokus; powracający przedstawiciel klubu nie musi szukać logowania pod czatem.
- **Linki pominięcia (skip links):** „Przejdź do czatu” i „Przejdź do logowania”. Kolejność w DOM: story, czat, logowanie.
- **Leniwe ładowanie.** `chat.js` ładuje się, gdy karta znajdzie się w odległości 200 px od widoku (IntersectionObserver). Do tego czasu widać szkielet z 4 wierszy.
- **Zmiana języka** zachowuje kanał, przewinięcie i szkic, bo stan żyje w module czatu.
- **Lista „Najbliższe turnieje”.** `upcomingItem` dostaje nieinteraktywną zaślepkę `<span class="upcoming-chat" data-chat-count="${id}"></span>`, którą wypełnia `chat-boot` („czat · 12”).
- **Podgląd gościa (`#guest?t=`).** Pasek kart „Kategorie i drabinki | Czat turnieju (n)”. Karta czatu to `data-chat-mount="tournament" data-tournament-id`. `accessCard` według macierzy §6.10: przy `ACCESS.kind='paid'` prowadzi do `#signup`, przy `login` do logowania. `ACCESS.kind` ustawia `account-boot` w czasie działania z `public-config`.
- **Podgląd turnieju dla członka.** `render()` przy `#guest?t=` i roli `member` korzysta z istniejącego `renderGuest()` z flagą `memberPreview` (trasowanie: §8.3 pkt 14): pasek gościa ma wtedy przycisk „Wróć” zamiast „Zaloguj się”, a reklama (promo) jest pominięta. Członek otwierający `#screen` trafia na `#chat` (§8.3 pkt 15).
- **Zalogowani (powłoka):**
  - pozycja menu „Czat” (`nav:'global'`, wszystkie role) z plakietką nieprzeczytanych;
  - „Czat turnieju” (`nav:'event'`);
  - „Moderacja” i „Członkowie” (`nav:'admin'`);
  - pasek nad siatką turniejów (`data-chat-mount="strip"`, ukrywany „×”, `matdraw.chat.strip=off`);
  - link „Czat · 3 nowe” w karcie turnieju.
  - Bez dźwięków, powiadomień przeglądarki i automatycznego otwierania czatu.
- **Tekst `login-help`.** `home-embed` oznacza akapit atrybutem `data-account-mount="login-help"` i zostawia dotychczasowy tekst. `account-boot` dopisuje „Nie pamiętasz hasła?” z panelem procedury z §3.10 (adres z `public-config.support`), a gdy `public-config.signup` jest włączone, także „Nie masz konta? Załóż konto” z linkiem do `#signup`. Klubowe konta od Administratora działają jak dotąd.
- **Urządzenie znane.** `account-boot` po zdarzeniu `login` zapisuje `localStorage['matdraw.knownDevice']`. `renderLogin` (`home-embed`) dodaje wtedy klasę `known-device`, a CSS na telefonie stawia logowanie nad czatem.

### 8.10 Trasy hash (nowe)
`#chat`, `#chat?c=<slug>`, `#chat?t=<tournamentId>`, `#signup` (`?step=2|3`, `?invite=<token>` w oknie testów), `#profile` (`?tab=profile|subscription|security`), `#billing`, `#members` (admin), `#moderation` (admin), `#guest?t=<id>&tab=chat`.

Alias `#czat…` jest normalizowany przez `replaceState`. Parametry `?billing=success|cancel|portal&session_id=` w `location.search` obsługuje `account-boot.js`.

---

## 9. PWA, wdrożenie i infrastruktura

### 9.1 Manifest (pwa-core; 04 §1.3 obowiązuje)
- **Dwa pliki:** `manifest.webmanifest` (PL) i `manifest.en.webmanifest` (EN).
- **Wspólne pola:** `id:"/"`, `start_url:"./?source=pwa"`, `scope:"./"`, `display:"standalone"`, `display_override:["standalone","minimal-ui"]`, kolory jak dziś, 4 ikony (192/512 jako `any` i `maskable`; ikona została już zmierzona jako bezpieczna dla maski), `categories:["sports","social"]`.
- **Skróty:** Czat (`./?source=shortcut#chat`) i Turnieje. Nowe ikony 96 px `brand/shortcut-chat-96.png` i `brand/shortcut-tournaments-96.png` generujemy z istniejącej marki przez GD.
- **Zrzuty ekranu** (`screenshots`) dodajemy po ukończeniu interfejsu, w plasterku `integration-qa`. Do tego czasu pole jest pominięte.
- **Zmiana języka manifestu.** `lang-boot.js` (pwa-frontend) i `setManifestLanguage()` w `pwa.js` podmieniają `href` na wersję EN, gdy `lang==='en'`. Kod musi być strzeżony (`document.querySelector&&…`), żeby test parytetu `lang-boot` w środowisku `vm` dalej przechodził.
- **`index.html`** (foundation): `<meta name="mobile-web-app-capable" content="yes">`, `<meta name="apple-mobile-web-app-title" content="MatBravo">`, viewport `width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content`, `<div id="pwa-root"></div>` za `#toast`.

### 9.2 Service worker (`dist/sw.js` jako szablon; implementacja referencyjna w 04 §1.4.2)
- **Tylko same-origin GET.** Nigdy nie dotyka `api/`, `u/`, `live/`, `sw.js`, `version.json`, żądań POST ani `Range`.
- **Shell z jednej wersjonowanej pamięci podręcznej**, zasada „najpierw cache”. Nawigacja do korzenia dostaje `index.html` z precache; każda inna nawigacja idzie do sieci, a bez sieci dostaje `offline.html`. Pozostałe zasoby obsługuje zasada stale-while-revalidate (`matbravo-static-1`).
- **Instalacja** ma zasadę „wszystko albo nic” (`cache:'reload'`). `activate` usuwa obce wersje `matbravo-*`.
- **Brak automatycznego `skipWaiting`.** Aktualizacja następuje dopiero po kliknięciu „Odśwież” i przeładowuje tylko tę kartę. `#screen` nigdy nie jest przeładowywany. **Wyjątek: minimalna wersja klienta** (D19, §9.4): po zdarzeniu `client-outdated` strona sama wysyła `SKIP_WAITING`, gdy nic nie jest w trakcie edycji.
- Rejestracja tylko w trybie API, ok. 2 s po pierwszym `render()`, z `updateViaCache:'none'`. `reg.update()` przy powrocie do karty, najwyżej co godzinę.

### 9.3 Build (`scripts/build-pwa.mjs`, wołany na końcu `build-php.mjs`)
- **Wersja.** Hash treści shellu i szablonu (12 znaków szesnastkowych) zastępuje `/*@build*/'dev'` i `/*@precache*/[]` w `public/sw.js`. Powstaje też `public/version.json` `{build,commit,files}`.
- **Lista wykluczeń:** `architecture.*`, `promo/`, `vendor/`, `og-image`, `screenshots/`, `api/`, `.htaccess`, `favicon.ico`, `sw.js`, `version.json`. Manifesty są dołączane.
- **Kontrole:** build kończy się błędem, gdy precache przekracza 1,5 MB albo znaczników brak lub są zduplikowane.
- **Determinizm.** Wydanie samego backendu nie zmienia hasha, więc nie wywołuje paska „nowa wersja”.

### 9.4 Instalacja i zachęty (pwa-frontend; 05 §13 i 04 §1.5)
- **Nigdy, gdy:**
  - to pierwsza wizyta albo gość na stronie głównej;
  - trwa rejestracja, płatność albo widać ekran powrotu z płatności;
  - otwarty jest modal albo fokus jest w polu wiadomości;
  - aplikacja działa jako zainstalowana (`display-mode: standalone` albo `navigator.standalone`);
  - włączone jest demo, `#screen` albo podgląd wydruku;
  - karta była już pokazana w tej sesji.
- **Wyzwalacze**, po bezczynności strony i gdy zachodzi którykolwiek:
  1. zalogowany użytkownik w drugim dniu użycia;
  2. 3 s po pierwszej udanej wysyłce na czacie (zdarzenie `chat:sent` z rejestru);
  3. dzień turnieju, w którym klub ma zgłoszenia, albo otwarty podgląd dzisiejszego turnieju;
  4. 90 s aktywnego czatu (sygnały `chat:active` co 10 s).

  Na desktopie działa tylko wyzwalacz 1, i to dopiero przy co najmniej 3 wizytach, w postaci małego chipa.
- **Chromium:** odłożony `beforeinstallprompt` i `prompt()` po kliknięciu. **iOS:** arkusz z 3 krokami i dopiskiem iOS 26 o menu „⋯” (**[do weryfikacji na polskim iPhonie]**). **Przeglądarki wbudowane** (Instagram/FB/TikTok…): baner „Otwórz w przeglądarce” z przyciskiem „Kopiuj link”.
- **„Nie teraz”** wycisza zachęty na 30 dni, a po trzeciej odmowie znikają na zawsze. Stała pozycja „Zainstaluj aplikację” jest w `#profile`. Pamięć stanu: `localStorage['matdraw.pwa']`, każdy dostęp w `try/catch`.
- **Pasek aktualizacji** „Dostępna jest nowa wersja MatBravo. [Odśwież]” znika dopiero po kliknięciu. Zwykła aktualizacja nigdy nie przeładowuje strony automatycznie.
- **Wymagana aktualizacja (`client-outdated`, D19).** Gdy serwer odrzuci kontrakt klienta (409 `client_outdated`):
  - polling czatu i inne odpytywania stoją (`chat-transport` reaguje na to samo zdarzenie);
  - jeśli nie ma niezapisanych formularzy (`form[data-dirty]`; szkic czatu i tak leży w `sessionStorage`) i nie trwa płatność ani rejestracja, `pwa.js` wysyła `SKIP_WAITING` do czekającego workera i przeładowuje kartę po `controllerchange` (bez workera: zwykłe przeładowanie);
  - w przeciwnym razie pokazuje pasek blokujący „Wymagana aktualizacja MatBravo. [Odśwież teraz]”, który nie znika;
  - **`#screen` (ekran hali) przeładowuje się w tym przypadku od razu:** nie ma tam pól do wypełnienia, a ze starym kodem i tak przestałby dostawać dane (`bootstrap` odpowiada 409). To jedyny wyjątek od zasady „`#screen` nigdy nie jest przeładowywany”; podnoszenie `min_client_api` w dniu zawodów i tak odradzamy (§9.11).
- **Bez liczników instalacji wysyłanych na serwer** w v1 (pytanie P12) i bez Web Push.

### 9.5 `.htaccess` (deploy-infra; 04 §2.c)
- **Bez zmian:** blok `mod_rewrite` (obejście 429), nagłówki bezpieczeństwa i CSP.
- **Dochodzą:**
  - typy MIME: `.webmanifest` → `application/manifest+json`, `.js`/`.mjs`, `.woff2` i `.webp`;
  - kompresja `DEFLATE`;
  - `Cache-Control: no-cache` dla `html|js|css|webmanifest|json` (naprawia też dzisiejsze ryzyko przeterminowanego `app.js` po wdrożeniu);
  - `no-cache, max-age=0` dla `sw.js`;
  - `immutable` dla `.woff2`;
  - 7 dni dla obrazów.
- **Podkatalogi.** Pliki `.htaccess` w podkatalogach (przyszłe `live/`, `u/`) nie mogą mieć `RewriteEngine` (**[do weryfikacji]**).

### 9.6 Migracje i kopie zapasowe we wdrożeniu (deploy-infra; 04 §2.a.3)
- **Nowy krok w workflow:** `ssh deploy bash -s -- migrate "$DEPLOY_BASE" "$DOCROOT" "$RELEASE" < scripts/deploy-remote.sh`, uruchamiany po wysłaniu wydania, a przed przełączeniem.
- **`migrate`:**
  1. `migrate.php --status` z `MATDRAW_CONFIG=$base/shared/config.php`.
  2. `empty` → wskazówka o instalatorze i kod 0.
  3. `DESTRUCTIVE>0` → błąd.
  4. **Kopia bazy (`dbbackup`), gdy czekają migracje albo gdy najnowsza kopia jest starsza niż 24 h** (przywrócona reguła z 04 §2.a.3; bez niej po starcie nic nie kopiowałoby bazy regularnie):
     - `mysqldump` lub `mariadb-dump`, z hasłem w pliku opcji o trybie 600, nigdy w linii poleceń;
     - flagi `--single-transaction --quick --skip-lock-tables --hex-blob`, a `--no-tablespaces` i `--column-statistics=0` tylko wtedy, gdy narzędzie je zna;
     - zapasowo `bin/dump.php`;
     - wynik `~/matdraw/backups/db-<data>-<powód>-<release>.sql.gz` (600, katalog 700; powód `pre-vX-to-vY` albo `daily`), zaakceptowany dopiero po `gzip -t`, rozmiarze > 1 KiB i sprawdzeniu znacznika „Dump completed”.
  5. **Kopia plików (`backup-files`, katalog `shared/uploads`), gdy najnowsza jest starsza niż 7 dni.**
  6. `PENDING=0` → kod 0 po ewentualnych kopiach z pkt 4–5.
  7. Uruchomienie `migrate.php`, log w `~/matdraw/logs/migrate-<release>.log`.

  Błąd zatrzymuje wdrożenie **przed** przełączeniem, a stara wersja dalej działa.
- **`bin/dump.php`** (backend-data; tryby: zapis na STDOUT dla `deploy-remote.sh` albo `--auto` dla crona, z tymi samymi kontrolami i retencją): zapytania niebuforowane (`PDO::MYSQL_ATTR_USE_BUFFERED_QUERY=false`), zapis strumieniowy przez `gzopen`, całość w jednej transakcji `REPEATABLE READ` (spójny obraz), `DROP TABLE IF EXISTS` + `SHOW CREATE TABLE` + wiersze przez `quote`, wyłączone FK w nagłówku i znacznik `-- Dump completed on <data>` na końcu. Tabela `chat_messages` z rocznej retencji nie może trafić w całości do pamięci.
- **Polecenia `backup-db` i `backup-files`** do ręcznego użycia przez SSH. Dla crona służy `bin/dump.php --auto`, bo `deploy-remote.sh` nie leży na serwerze (workflow przesyła go przez `ssh … bash -s`), a ścieżka `~/domains/matbravo.com/backend/bin/` jest stała między wydaniami.
- **Retencja kopii:** `cleanup` usuwa kopie bazy i plików starsze niż `BACKUP_KEEP_DAYS` (domyślnie 30), ale zawsze zostawia najnowszą kopię każdego rodzaju. Dane usuniętych kont znikają więc z kopii najpóźniej po ok. 30 dniach; DEPLOY-PL.md to opisuje.
- **`check`** zakłada `shared/uploads`, `shared/sessions`, `backups` i `logs` (700) i wypisuje `df`.
- **`rollback`** zawiera strażnika „floor” z §2.8.
- **Bez automatycznego przywracania bazy.** Ręczną procedurę opisuje DEPLOY-PL.md:
  1. plik `shared/maintenance` (API odpowiada 503);
  2. **usunięcie wszystkich tabel MatDraw** (albo import do pustej bazy), bo import kopii sprzed 0002 na nowszą bazę zostawiłby `user_profiles`, `billing_accounts` i `chat_*` z wierszami osieroconymi, a `app_meta` cofnąłby się do wersji 1;
  3. import kopii, potem `migrate.php`;
  4. usunięcie pliku `maintenance` **przed** ponownym wdrożeniem (`deploy-verify` przy obecnym pliku tylko ostrzega i nie robi rollbacku, §9.8);
  5. jasna informacja: wszystko, co zapisano po wykonaniu kopii, przepada.

### 9.7 Katalogi współdzielone (poza wydaniem)
`~/matdraw/shared/`:
- `config.php` (600);
- `uploads/` (700; awatary w podkatalogach `public_id`);
- `sessions/` (700);
- `jobs-tick` (znacznik próbkowania zadań, §3.7);
- opcjonalnie `chat-off` i `maintenance` (pliki-flagi).

`~/matdraw/backups/` (700) i `~/matdraw/logs/` (700). Żaden z tych katalogów nie znajduje się w `public_html` ani w `backend/` strony, bo te dwa katalogi deploy zastępuje przy każdym wdrożeniu.

### 9.8 `server-check` i `deploy-verify.sh` (deploy-infra; 04 §2.d.3 i §2.e)
- **`server-check`** (tylko odczyt) wypisuje:
  - PHP 8.3 CLI;
  - rozszerzenia pdo_mysql, mbstring, openssl, curl, gd (WebP/JPEG/PNG), exif, fileinfo, intl, zlib, sodium;
  - limity `memory_limit`, `upload_max_filesize`, `post_max_size`, `disable_functions` (w tym, czy jest `shell_exec` dla `stty`);
  - `session.save_handler` i `session.save_path` dla PHP **strony** (przez `diagnostics`) oraz liczbę plików w `shared/sessions`;
  - `mysqldump`/`mariadb-dump`, `gzip`, `crontab`;
  - **sondę Stripe przez `/usr/local/php83/bin/php`** (to samo `StripeClient::probe` co w `diagnostics`: status, czas, wersja TLS, błąd);
  - **uprawnienia bazy:** `SHOW GRANTS FOR CURRENT_USER()` z kontrolą ALTER, CREATE, INDEX i REFERENCES (MySQL 8.0 wymaga REFERENCES do kluczy obcych; MariaDB nie);
  - wiek najnowszej kopii bazy i plików;
  - `df` i uprawnienia katalogów `shared`.
- **`deploy-verify.sh`.** Dotychczasowe kontrole zostają, łącznie z regułą „429 = problem środowiska, bez rollbacku”. Dochodzą:
  - **na samym początku pliki-flagi:** gdy istnieje `$DEPLOY_BASE/shared/maintenance`, skrypt wypisuje ostrzeżenie „Trwa przerwa techniczna (plik maintenance). Usuń go i ponów weryfikację.”, pomija kontrole API i kończy się z `ROLLBACK=false` (bez cofania dobrego wydania). Gdy istnieje `shared/chat-off` albo config ma `chat_force_off`, odpowiedź 503 z `code:'chat_off'` na trasach czatu jest akceptowana;
  - `version.json` zgodny z katalogiem domeny;
  - `sw.js` z kodem 200, typem JavaScript, numerem wydania i `no-cache` (gdy brak, tylko ostrzeżenie);
  - oba manifesty jako poprawny JSON z `id`, `start_url` i dostępnymi ikonami;
  - `offline.html` z kodem 200;
  - **schemat bazy ≥ `Migrator::target()`**, w przeciwnym razie błąd;
  - `?route=public-chat-channels` → 200 JSON (albo 503 `chat_off` przy wyłączonym czacie);
  - `?route=me` bez ciasteczka → 401 JSON;
  - **ostrzeżenie (bez błędu), gdy dziś odbywa się turniej** (status `open` albo `closed` i `event_date` = dziś): „Dziś trwa turniej {nazwa}. Wdrażaj w dni bez zawodów.”;
  - ostrzeżenie, gdy najnowsza kopia bazy jest starsza niż 7 dni.

### 9.9 CI (`.github/workflows/deploy.yml`, deploy-infra)
- **`test`:**
  - `node --check` dla każdego `dist/*.js`, `dist/i18n/*.js` i `scripts/*.mjs`;
  - PHP lint jak dziś (obejmuje `backend/routes`, `jobs` i `migrations`);
  - `setup-php` z dodatkiem `gd, curl, openssl, intl, exif`;
  - `PHP_BIN=$(command -v php) node --test` na wszystkich `tests/*.test.mjs` **oprócz** `http.test.mjs` i `*.http.test.mjs` (glob, więc nowe pliki testów wchodzą same).
- **`http-test`** (mysql:8.0 i mariadb:10.6):
  - konfiguracja testowa dostaje `uploads_dir`, `signup_enabled=>true`, `billing_enabled=>true`, `billing_enforce=>true`, `billing_mode=>'test'`, `support_email=>'pomoc@example.test'`, `stripe_secret_key=>'rk_test_stub'`, `stripe_api_base=>'http://127.0.0.1:12111'`, `stripe_webhook_secrets=>['whsec_test_secret']`, `stripe_prices`, `billing_amounts`, `stripe_portal_configuration=>'bpc_stub'`;
  - po `install.php` uruchamiamy `migrate.php` dwa razy (drugi raz bez zmian);
  - uruchamiamy atrapę `node tests/stubs/stripe-stub.mjs 12111 &`, **jeśli plik istnieje**;
  - testy: `node --test --test-concurrency=1 tests/http.test.mjs` **jako pierwszy**, potem glob `tests/*.http.test.mjs` w kolejności alfabetycznej;
  - `MATDRAW_TEST_SHARED_DIR` wskazuje katalog configu (pliki `chat-off` i `maintenance`).
- **`http-compat`** (oba silniki): stary kod i jego `tests/http.test.mjs` na bazie po nowych migracjach muszą przejść.
  - **Wersja bazowa:** przy `push` `github.event.before` (z tego commita zwykle pochodzi wydanie w `.previous`); gdy to same zera (nowa gałąź), `git merge-base origin/main HEAD`; przy `pull_request` baza PR. Zadanie jest pomijane tylko wtedy, gdy poprzedniego commita nie ma.
  - **Dane, a nie `CHECKSUM TABLE`:** `MODIFY club_id … NULL` zmienia format wiersza, więc suma kontrolna `users` zmienia się przy identycznych danych [zweryfikowane przez recenzenta na MariaDB 10.11]. Porównujemy więc dla każdej starej tabeli `SELECT <jawne kolumny> … ORDER BY <klucz główny>`, haszowane w skrypcie testu, przed migracją i po niej.
- **`deploy-script-test`:** sztuczne drzewo serwera w `$RUNNER_TEMP`; `check|migrate|activate|backup-db|cleanup|rollback`. Sprawdzamy, że:
  - pierwsze `migrate` robi kopię, a drugie (od razu) niczego nie zmienia i nie robi kopii, bo istnieje kopia młodsza niż 24 h;
  - kopia odtwarza się z równym haszem danych (ta sama metoda co w `http-compat`);
  - celowo błędna migracja zatrzymuje przed `activate`;
  - strażnik „floor” blokuje rollback do wydania sprzed 0002, gdy istnieje członek;
  - `cleanup` usuwa kopie starsze niż 30 dni, ale zostawia najnowszą;
  - `deploy-verify.sh` z plikiem `maintenance` kończy się `ROLLBACK=false`, a z plikiem `chat-off` akceptuje 503 `chat_off`.
- **`build`** dodatkowo sprawdza `public/sw.js` (bez znaczników `/*@`, `node --check`), `version.json`, `offline.html`, oba manifesty i `backend/bin/migrate.php`.
- **`deploy`:** krok „Migracje bazy” między „Wysłanie wydania” a „Przełączenie”. Wdrożenie wyłącznie z `main`, do którego trafia **jedno** scalenie po `integration-qa` (D18).
- **`package.json`:** `check` sprawdza wszystkie `dist/*.js`; dochodzi skrypt `test:http` (`scripts/test-http.sh`).

### 9.10 Dokumentacja wdrożeniowa
- **`DEPLOY-PL.md`** (deploy-infra), według 04 §2.d.2, prostym językiem:
  - układ katalogów;
  - „Migracje bazy i kopie zapasowe” (kopie automatyczne przy wdrożeniu, retencja 30 dni, cron zalecany, pobieranie kopii na własny dysk);
  - zmiana sekcji o rollbacku: rollback zmienia tylko kod, a „floor” go chroni;
  - „Przywracanie bazy” (§9.6, z usunięciem tabel i plikiem `maintenance`);
  - „Kiedy wdrażać”: tylko w dni bez zawodów (sprawdź listę najbliższych turniejów);
  - uprawnienia DDL użytkownika bazy (ALTER, CREATE, INDEX, REFERENCES) i komunikat „Baza jest chwilowo zajęta”;
  - nowe klucze config i dozwolone kombinacje przełączników (§6.8, §6.10);
  - „Limity w dniu zawodów” (`signup_limit_*`, `login_limit_ip`, `username_check_limit_*`) i jak je podnieść;
  - „Odpowiedzi hostingu 429/503” (gdzie je widać w panelu, kiedy przełączyć preset, `scripts/poll-probe.sh`);
  - „Odzyskiwanie dostępu do konta” (procedura §3.10) i „Konflikt adresu e-mail” (§3.4);
  - sekcje „Aplikacja na telefonie (PWA)”, „Cron (zalecany)”, „Stripe — konfiguracja krok po kroku” (z ukrytym wklejaniem klucza i wymianą klucza `sk_` po konfiguracji) i „Wyłącznik czatu”.
- **`INSTALL-PL.md`, `README.md`, `HANDOFF.md`, `VALIDATION.md`** aktualizuje `integration-qa`: wymagania gd/curl/openssl, migracje w instalatorze, płatne konta, procedura resetu hasła, sekcja marki o zdjęciach profilowych.

### 9.11 Kroki ręczne właściciela (w tej kolejności)
1. **Repozytorium:** potwierdzić, które repozytorium (`eMCe71/MatDraw` czy `Meducase/MatDraw`) ma środowisko `production` z sekretami `SSH_*` (pytanie P1).
2. **Odpowiedzi na pytania-bramki startu** (§13): P2 (czy i od kiedy obecne kluby płacą), P3 (archiwa i dzień po turnieju tylko dla zalogowanych), P7 (domyślnie inicjał nazwiska), P8/P21 (adres pomocy, np. `pomoc@matbravo.com`) i P19 (podatki). Implementacja na nie nie czeka; włączenie płatności tak.
3. **Wdrożenie (po `integration-qa`, jedno scalenie do `main`), w dzień bez zawodów** (pierwsze wdrożenie wyloguje wszystkich jeden raz). Potem uruchomić workflow „server_check” i odczytać plan AfterMarket (Start/Biznes/Pro) w panelu. Sprawdzić GD i WebP, `mysqldump`, `crontab`, uprawnienia bazy i sondę Stripe. Jeśli połączenie ze Stripe jest zablokowane, płatności na tym hostingu nie zadziałają: zgłosić to do AfterMarket.
4. **Uprawnienia bazy:** użytkownik bazy musi mieć prawa ALTER, CREATE, INDEX i REFERENCES (domyślnie w DirectAdmin je ma; `server-check` to pokazuje). Ewentualnie w config można podać osobne dane `db_migrate`.
5. **Kopie zapasowe (zalecane przed startem płatności):**
   - w DirectAdmin (Advanced Features → Cron Jobs) dodać raz na dobę `/usr/local/php83/bin/php /home/meducase/domains/matbravo.com/backend/bin/dump.php --auto` (kopia do `~/matdraw/backups` z retencją 30 dni; pomija pracę, gdy kopia ma mniej niż 20 h; dokładne polecenie w DEPLOY-PL.md);
   - zapytać AfterMarket, jak często i jak długo przechowuje własne kopie i jak je przywrócić **[do weryfikacji]**;
   - raz w miesiącu pobrać `~/matdraw/backups` na własny dysk.
6. **Stripe w trybie testowym:**
   - utworzyć **klucz ograniczony** `rk_test_…` z uprawnieniami z 03 §4;
   - przez SSH uruchomić `/usr/local/php83/bin/php ~/domains/matbravo.com/backend/bin/stripe-setup.php --mode=test` i **wkleić klucz `sk_test_…` w ukrytym polu**, o które zapyta skrypt (klucza nigdy nie wpisujemy w samym poleceniu, bo trafiłby do historii powłoki);
   - wkleić wypisany blok do `~/matdraw/shared/config.php` (chmod 600);
   - w panelu Stripe wygenerować nowy klucz `sk_test_` (Roll key), bo na serwerze potrzebny jest tylko `rk_`.
7. **Ustawienia w panelu Stripe** (osobno dla trybu testowego i na żywo; 03 §12):
   - nazwa „MatBravo”, opis na wyciągu `MATBRAVO`, logo i kolory;
   - karty, Apple Pay i Google Pay włączone; Link wyłączony (pytanie P13);
   - Smart Retries, a po ostatniej próbie anulowanie subskrypcji;
   - e-maile o nieudanej płatności i o wymaganym 3DS; paragony;
   - „Limit customers to one subscription” włączone; Adaptive Pricing wyłączone; Tax wyłączony do sesji prawnej.
8. **Okno testów** (§6.10 krok 3): w config `billing_enabled=true`, `billing_mode='test'`, `billing_enforce=true`, `signup_enabled=false`, `signup_invite_token=<losowe 32 znaki>`, `support_email`. W panelu Admina: `Diagnostyka → Sprawdź połączenie ze Stripe` musi pokazać „osiągalny”. Testy z linku `https://matbravo.com/#signup?invite=<token>` według 03 §14.3. Nowe konta personelu zakładane w tym oknie oznaczać jako darmowe.
9. **Tryb na żywo:** `stripe-setup.php --mode=live` (ukryte pole, potem Roll key `sk_live_`), klucz `rk_live`, jedna własna płatność, zwrot w panelu, usunięcie kont testowych w `#members`. Następnie `signup_enabled=true` i usunięcie `signup_invite_token`.
10. **(Opcjonalnie) zgłoszenie do AfterMarket** z treścią z 03 §9 (biała lista IP webhooków Stripe). W tym samym zgłoszeniu warto zapytać o limity żądań na IP i dostępność LSCache. Po potwierdzeniu: `stripe-setup.php --mode=… --webhook` i test „Send test event” w panelu Stripe.
11. **(Opcjonalnie) dodatkowe wpisy crona:**
    - co 5 min `/usr/local/php83/bin/php /home/meducase/domains/matbravo.com/backend/bin/cron.php`;
    - co 20 min `… stripe-sync.php --events --due`;
    - o 3:37 `… stripe-sync.php --reconcile`.

    Logi w `~/matdraw/logs/`. Bez crona wszystko działa poprawnie, tylko wolniej się odświeża.
12. **Test obciążenia z zewnątrz** (po pierwszym wdrożeniu; 02 §6 i 04 §2.c):
    - `curl -sI https://matbravo.com/sw.js` (typ i `no-cache`) oraz typ manifestu;
    - z **laptopa albo telefonu w trybie hotspotu (nie z serwera)**: `bash scripts/poll-probe.sh https://matbravo.com 5 600`, czyli 5 równoległych pętli przez 10 minut, co 2,5 s, na publicznej trasie czatu (bez ciasteczka). Kryterium: zero odpowiedzi 429/503/508;
    - w tym czasie w DirectAdmin: Resource Usage (limity LVE, błędy EP/NPROC).
13. **(Etap 2, opcjonalnie) BLIK cykliczny:** e-mail do Stripe Support z konta MEDUCASE.

---

## 10. Bezpieczeństwo techniczne i privacy-by-design (lista kontrolna)

Każdy punkt ma przypisany test albo kontrolę; `integration-qa` odhacza całość.

**Autoryzacja i izolacja**
- [ ] Członek nigdy nie trafia do `Repository::load()`. `command` odpowiada 403, a `bootstrap` zwraca pusty workspace (test HTTP).
- [ ] `persist()` nie używa upsertu dla `users`. Test regresji przejęcia wiersza: 409, a wiersz członka pozostaje nietknięty.
- [ ] Wszystkie trasy administracyjne (`admin-*`, `diagnostics`) sprawdzają `role==='admin'` po stronie serwera. Nie-admin dostaje 403, i to zanim nastąpi jakikolwiek odczyt danych.
- [ ] `admin-member` działa wyłącznie na kontach `member`; każda akcja trafia do `account_audit`.
- [ ] Pisanie wymaga pełnego dostępu, kompletnego profilu, braku hasła tymczasowego i braku wyciszenia; serwer sprawdza to przy każdym `chat-send`.
- [ ] `chat-send`, `chat-report` i `chat-delete` stosują tę samą kontrolę widoczności kanału co odczyt i odpowiadają tym samym 404 dla niewidocznych i nieistniejących (test: szkic i archiwum).
- [ ] Personel bez pełnego dostępu: `bootstrap` działa (podgląd), `command` 402 z wyjątkiem `account.password` (test).

**Sesja, CSRF, nagłówki**
- [ ] Każdy POST z sesją przechodzi `requireCsrf` (Origin i token). Atrybuty ciasteczka zostają: HttpOnly, Secure, `SameSite=Strict`.
- [ ] `session_regenerate_id(true)` przy logowaniu, rejestracji, zmianie hasła i e-maila; `use_strict_mode` włączone.
- [ ] Trasy `peek` nie tworzą plików sesji, nie wysyłają `Set-Cookie` (ważne, wygasłe i zmyślone ciasteczko) i przedłużają aktywność najwyżej raz na 1/4 limitu bezczynności.
- [ ] Praca po odpowiedzi (`Jobs::maybe`, `BillingSync::lazy`) zaczyna się od `session_write_close()`; test: drugie żądanie z tym samym ciasteczkiem w trakcie spowolnionego zadania odpowiada w < 1 s.
- [ ] Trasy `public` nie czytają ciasteczek ani nie zakładają sesji (test: brak `Set-Cookie`). Działają tylko przez GET, a POST dostaje 405 z `Allow: GET`.
- [ ] Sesje członków mają twardy limit 30 dni. Zmiana hasła, e-maila albo blokada podnosi `auth_version`, co natychmiast unieważnia wszystkie sesje danego konta.
- [ ] Pliki sesji sprząta `housekeeping` według rodzaju (anonimowe, personel, członkowie), tylko we własnym katalogu.
- [ ] CSP pozostaje bez zmian. Nie ma skryptów, fontów ani zasobów z obcych domen. Stripe otwieramy tylko przez nawigację najwyższego poziomu po sprawdzeniu `origin`.
- [ ] Logowanie: fałszywy hash ma ten sam algorytm i parametry co prawdziwe hasła (test `password_get_info`), weryfikacja zawsze się wykonuje.

**Dane wejściowe i wyjściowe**
- [ ] Wszystkie zapytania SQL są przygotowane. Nazwy tabel i kolumn pochodzą wyłącznie ze stałych w kodzie. `LIKE` z `ESCAPE '!'` i uciekaniem `!`, `%`, `_` (test z podkreślnikiem).
- [ ] Ciała JSON mają limity rozmiaru według trasy i głębokość 32. Surowe ciała (awatar, webhook) mają twarde limity.
- [ ] Wszystkie wolne teksty (wiadomości, klub, komentarze zgłoszeń, notatki, `notice`) przechodzą `Text::clean`: NFC, bez `\p{Cc}` (poza `\n` tam, gdzie dozwolone) i bez `\p{Cf}` poza U+200D; to samo `cleanText` w JS.
- [ ] Każda wartość z API trafia do DOM tylko przez `textContent` albo szablon `h`; `tests/xss-scan.test.mjs` zabrania `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write` w nowych modułach. Testy XSS w `tests/chat-client.test.mjs` i `tests/chat-admin.test.mjs` (wiadomość, `notice`, tytuł turnieju, komentarz zgłoszenia, `original_body`).
- [ ] Projekcja gościa korzysta z listy dozwolonych pól (`ChatGuestView`). Test sprawdza dokładny zbiór kluczy oraz brak e-maili, imion, nazw użytkowników, `public_id` i wewnętrznych id w surowym JSON.
- [ ] Awatary:
  - format rozpoznajemy po zawartości, nie po nazwie; bez SVG i GIF; limity wymiarów, pikseli i pamięci (z poprawnym parsowaniem `memory_limit`);
  - plik kodujemy od nowa przez GD (EXIF usunięty); bez GD zdjęcia są wyłączone;
  - nazwa pliku to hash, katalog to `public_id` właściciela, a ścieżka nigdy nie pochodzi od użytkownika;
  - pliki leżą poza docroot, z trybami 700/600;
  - odpowiedź ma `nosniff`, `CSP: default-src 'none'; sandbox` i CORP `same-origin`;
  - dostęp mają tylko osoby z pełnym dostępem i właściciel; kontrola dostępu przed `304` (test: gość z poprawnym `ETag` dostaje 404).
- [ ] Dane osobowe nie trafiają do adresów URL (wyszukiwanie członków i sprawdzanie nazwy idą w POST).
- [ ] Logi wyjątków nie zawierają komunikatów `PDOException` (tylko SQLSTATE i kod), więc ani e-maili, ani nazw.

**Nadużycia**
- [ ] Limity: logowanie (IP 100/15 min, IP+e-mail 8/15 min), rejestracja (IP /64 30/h i 100/doba, globalnie 200/h), `username-check` (sesja i IP), wysyłka, zgłoszenia, usuwanie, upload, profil, e-mail, checkout, portal, synchronizacja, sonda Stripe. Kubełki są HMAC-owane, więc nie zapisujemy żadnych IP.
- [ ] Rejestrację chronią pułapka na boty i minimalny czas wypełnienia mierzony przez serwer. Komunikaty nie wskazują, który warunek zawiódł.
- [ ] Moderacja: zgłoszenia (z powodem „Dane osobowe lub wizerunek dziecka”), automatyczne ukrywanie, wyciszenia i dziennik moderacji. Pole wiadomości ma podpowiedź „Nie publikuj danych dzieci ani numerów telefonów.”.
- [ ] Wyłącznik czatu odpowiada 503 przed połączeniem z bazą. Plik przerwy technicznej zatrzymuje całe API przed bazą, a `deploy-verify` nie robi wtedy rollbacku.

**Płatności**
- [ ] Na serwerze leży tylko klucz ograniczony `rk_…`. Pełny klucz podajemy jednorazowo w ukrytym polu `stripe-setup.php` (nigdy w linii poleceń ani w `argv`; test), a potem właściciel go wymienia. Sekrety są tylko w `shared/config.php` (600) i nigdy w logach.
- [ ] Podpis webhooka: HMAC liczony na surowym ciele, tolerancja 300 s, `hash_equals`, wiele sekretów, kontrola `livemode`, idempotencja przez `stripe_events`.
- [ ] Nie ufamy treści zdarzeń: obiekt zawsze pobieramy ponownie. `confirm` sprawdza własność sesji Checkout. Kwoty, waluta i id cen nigdy nie pochodzą od klienta.
- [ ] Reguła pierwszeństwa subskrypcji: stara zakończona subskrypcja nie nadpisuje nowej aktywnej (testy: `reconcile` i zdarzenie po fakcie).
- [ ] Wywołania Stripe w tle: bez ponowień, 3 s / 8 s, bezpiecznik `stripe_down_until`, dzierżawa 60 s.
- [ ] Dane karty nigdy nie trafiają do nas (Checkout i Portal hostowane). Do Stripe wysyłamy tylko e-mail, preferowany język i nasze nieprzezroczyste id. Nic nie wysyłamy przed kliknięciem „Przejdź do płatności”.
- [ ] Logi Stripe zawierają metodę, ścieżkę, status, kod i `Request-Id`, bez kluczy i treści.

**Privacy-by-design**
- [ ] Minimalizacja danych:
  - profil zawiera tylko pola z wymagania 5;
  - nazwisko domyślnie jako inicjał („Marta K.”), pełne tylko z wyboru;
  - klub to wolny tekst, domyślnie ukryty;
  - na zewnątrz występuje wyłącznie `public_id`;
  - nie zapisujemy IP, User-Agenta, odcisków urządzeń, analityki ani trackerów (`chat_health` to tylko godzina, status i liczba).
- [ ] Goście i niepłacący nie dostają tożsamości (ani inicjałów). `g` i `c` pozwalają pogrupować wypowiedzi jednej osoby najwyżej w obrębie jednego kanału i jednego dnia; jest to opisane w nagłówku `ChatGuestView` i w HANDOFF.md.
- [ ] Wylogowanie przeładowuje stronę i czyści dane tożsamości we wszystkich kartach (`reset` na `BroadcastChannel`); 401 w pollingu też je czyści.
- [ ] Retencja: wiadomości 365 dni; oryginały usuniętych 30 dni, i to **tylko** przy usunięciu przez moderatora albo wiadomości ze zgłoszeniami; zdarzenia Stripe 90 dni; porzucone konta 30 dni (tylko przy `billing_enforce=true`); kopie bazy i plików 30 dni (zawsze zostaje najnowsza); `chat_health` 14 dni. Wyciszenia i zgłoszenia są sprzątane.
- [ ] Usunięcie konta przez członka anonimizuje dane, wiadomości stają się nagrobkami, klient Stripe jest usuwany (z ponawianiem), a wiersz płatności zostaje jako nagrobek bez danych osobowych.
- [ ] `stripe_events`, `billing_audit` i `account_audit` nie przechowują danych osobowych.
- [ ] Service worker nigdy nie zapisuje w cache `api/` ani prywatnych odpowiedzi; jest test.
- [ ] Kopie bazy mają tryb 600 i leżą poza siecią. Hasło do bazy nigdy nie pojawia się w linii poleceń.
- [ ] Sloty na zgody w rejestracji i polityki w Checkout są zarezerwowane, ale **puste do sesji prawnej** (wymaganie 8). Nie ma żadnych pól zaznaczonych z góry (także „Pokazuj członkom moje pełne nazwisko” jest domyślnie niezaznaczone).
- [ ] Wiele osób w czacie może być niepełnoletnich: domyślny inicjał nazwiska, profil i zdjęcie tylko dla członków, brak wiadomości prywatnych i zdjęć w czacie.

---

## 11. Strategia testów

**Testy jednostkowe Node** (bez przeglądarki), każdy plik należy do jednego plasterka:

| Plik | Co sprawdza |
|---|---|
| `tests/core.test.mjs` | Przez most `tests/php-bridge-core.php`: pełna tabela `Access::compute` z granicami czasowymi (także `grace` i wygasłe zwolnienie przy trwającej subskrypcji), `RateLimit` (logika okna na atrapie), `People` (kształt, domyślny inicjał), `Paths` (odmowa ścieżek w docroot), `Text::clean` (wspólne przypadki z `community.test.mjs`), `Config` (wartości domyślne i odrzucane kombinacje przełączników), `Accounts::dummyHash` (`password_get_info` równe hashowi z `Domain::password`), `ClientIp::bucket` (IPv6 /64). |
| `tests/migrations.test.mjs` | Lint migracji (04 §2.a.2): ciągłe id; każde `CREATE TABLE` z `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`; zakaz `ADD COLUMN IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS`, `RETURNING`, `->>`, `JSON_VALUE`, `NOW()`, `CURRENT_TIMESTAMP`; `DROP/MODIFY/CHANGE/RENAME` tylko z `destructive:true` albo w jawnie dozwolonych instrukcjach 0002 (ENUM, NULL); nazwy FK z prefiksem tabeli. |
| `tests/registry.test.mjs` | `parseRoute` (aliasy, query, `#screen`/`#guest` nietknięte), filtrowanie menu według roli, `handle`, szablon `h` (uciekanie, zagnieżdżanie, `setHtml` odrzuca string), scalanie słowników (kolizja trafia do `collisions`, bez wyjątku). |
| `tests/xss-scan.test.mjs` | Statyczny skan nowych modułów (§5.9): brak `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/`on*=` poza `setHtml`. |
| `tests/community.test.mjs` | Zgodność PHP/JS: walidacja nazwy (wspólna lista przypadków), kody krajów, sporty, lista zastrzeżona, transliteracja propozycji, `cleanText`/`Text::clean` (RLO, LRI, U+200B, U+FEFF, U+200E usunięte; ZWJ w emoji zostaje). |
| `tests/chat.test.mjs` | Przez `tests/php-bridge-chat.php`: `ChatGuestView` (dokładne klucze, `g` stałe w obrębie dnia i kanału, różne między dniami i kanałami: ujawnienie opisane, a nie ukryte), `tournamentState` (draft/open/grace tylko dla zalogowanych/archive/closed), normalizacja treści, `cont`, parser `h` i `e`. |
| `tests/billing.test.mjs` | Przez `tests/php-bridge-billing.php`: `StripeSignature::verify` (03 §14.1: wszystkie przypadki z wstrzykniętym `$now`), `billing_state_from_subscription` (kształty basil i starsze), tabela `next_sync_at`, `StripeClient::norm`, **reguła pierwszeństwa subskrypcji** (wszystkie pary stanów), bezpiecznik. |
| `tests/stripe-setup.test.mjs` | `stripe-setup.php` odrzuca klucze w `argv`; przy STDIN z potoku czyta klucz bez echa; nie zapisuje klucza na dysk (atrapa Stripe). |
| `tests/chat-client.test.mjs` | Grupowanie, separatory dni, tokenizacja linków i XSS (wynik jako węzły z atrapą `document`; także `notice` i tytuł turnieju z HTML), harmonogram interwałów z granicami rozrzutu, **bezczynność tylko od interakcji i ograniczony `boost`** (nieobsługiwana widoczna karta z wiadomością co 60 s dochodzi do `ms[2]` lub wolniej w 10 min), raport `e`, wybór lidera na atrapach `navigator.locks`/`BroadcastChannel`, `purgeIdentity` po `logout`, `reset` i 401 (w stanie modułu nie zostaje `people`, wiadomości, kursory ani szkice), kolejka awatarów (≤ 2 naraz), zatrzymanie po `client-outdated`, atrapa demo (konto demo pisze od razu). |
| `tests/chat-admin.test.mjs` | Panel moderacji: komentarz zgłoszenia, `original_body`, e-mail i nazwa jako czysty tekst; akcje wysyłają poprawne ciała. |
| `tests/members-ui.test.mjs` | Panel członków: stan przełącznika „Darmowe konto” dla nowego i istniejącego konta, walidacja daty `requireFrom` (≥ 14 dni dla `grandfathered`), budowa żądań bez danych osobowych w adresie, teksty jako czysty tekst. |
| `tests/account-ui.test.mjs` | Domyślny kraj z `navigator.languages`, waluta z kraju, formatowanie cen (`Intl`), parsowanie `?billing=`, matematyka kadrowania, siła hasła, macierz CTA z `public-config` (§6.10), domyślnie niezaznaczone „pełne nazwisko”. |
| `tests/pwa-sw.test.mjs`, `tests/pwa-build.test.mjs` | 04 §1.7 (18+ asercji workera; build, manifesty, ikony, `offline.html` w dwóch językach, `#pwa-root`). |
| `tests/pwa-ui.test.mjs` | Reguły wyzwalaczy, wykrywanie iOS i przeglądarek wbudowanych, pamięć odmów, **`client-outdated`**: automatyczne `SKIP_WAITING` bez niezapisanych formularzy, pasek blokujący z nimi, natychmiastowe przeładowanie `#screen`. |
| `tests/i18n.test.mjs` | Uogólniony według §8.6 (komunikaty `Error`/`DomainError` ze wszystkich modułów, `collisions` puste). |
| Istniejące `engine`, `workspace`, `php`, `http` | **Muszą przechodzić bez zmian** (`http.test.mjs` zmienia tylko import klienta i dodaje `before(()=>fixture('reset-limits'))`). |

**Testy HTTP** (prawdziwy PHP i baza; `scripts/test-http.sh`, a w CI macierz MySQL 8.0 i MariaDB 10.6; uruchamiane kolejno, `http.test.mjs` pierwszy, dalej glob `tests/*.http.test.mjs`):

| Plik | Właściciel | Scenariusze (minimum) |
|---|---|---|
| `tests/isolation.http.test.mjs` | backend-data | Członek z fixture nie loguje się starą ścieżką i nie trafia do workspace; **przejęcie wiersza → 409**; zmiana e-maila personelu na e-mail członka → 409; `migrate.php` drugi raz bez zmian; `--rollback-floor` 1 bez członków i 2 z członkiem. |
| `tests/accounts.http.test.mjs` | backend-api | `session`/`login` lekkie (te same kształty); członek: `bootstrap` pusty, `command` 403; `me` dla każdej roli; personel z `billing_exempt=0`: `bootstrap` 200, `command` 402, `account.password` 200; `peek` bez `Set-Cookie` i bez nowego pliku dla ważnego, wygasłego i zmyślonego ciasteczka; odświeżenie aktywności po 1/4 limitu; przerwa techniczna (plik) → 503 przed bazą; tabela usunięta w bazie testowej → 503 zamiast 500; nagłówek `X-MatBravo-Client: 0` przy `min_client_api=1` → 409 `client_outdated`; **blokada sesji**: spowolnione zadanie (`job_test_sleep_ms`) i drugie żądanie z tym samym ciasteczkiem < 1 s; **czas logowania**: po 10 prób znanym i nieznanym e-mailem mediany w przedziale 0,5–2,0 (szeroko, żeby test nie był kapryśny; główną ochroną jest test parametrów hasha). |
| `tests/profiles.http.test.mjs` | accounts-profiles-backend | Rejestracja (sukces, wyłączona, token zaproszeń, pułapka na boty, za szybko według serwera, bez `signup-begin`, duplikat e-maila i nazwy, limit IP); `username-check` (POST, 403 bez rejestracji i bez logowania, stany, propozycje, limit); `profile` (walidacja, limit 30 dni, domyślne `initial`); awatar (WebP/JPEG/PNG z fixtures, SVG/GIF/poliglota/za duży/złe wymiary odrzucone, EXIF usunięty, ETag/304 tylko z dostępem, gość z poprawnym `ETag` → 404, niepłacący/obcy 404, właściciel 200, ten sam obraz u dwóch osób i usunięcie u jednej nie psuje drugiej); `admin-members` (POST, wyszukiwanie z `_` i `%` dosłownie); `admin-member` (create free, active, hasło tymczasowe → `mustChangePassword` i blokada czatu, zmiana e-maila → wylogowanie, delete anonimizuje); `member-email`; `account-delete` (zwykłe, przy `active` 409 `confirmEnd`, z `endSubscription`); sprzątanie porzuconych kont pomija osoby ze zgłoszeniami i nie działa przy `billing_enforce=false`. |
| `tests/chat.http.test.mjs` | chat-backend | Kanały publiczne (4 globalne, kolejność, cache `public`); `public-chat`: dokładne klucze, brak danych osobowych w surowym JSON, brak `Set-Cookie`, `Cache-Control: public, max-age=2`; `chat-feed` członka (`people`, `private, no-store`), niepłacący = projekcja gościa; **polling**: 204 przy braku zmian **także z `h`**, `COUNT` tylko po zmianie `knownLast`, kursor, nagrobek po usunięciu, `more`, `cv`→`cfg`; raport `e` zapisuje `chat_health`; wysyłka: idempotencja `cid`, limity (429 z `Retry-After`), profil niekompletny 403, hasło tymczasowe 403, wyciszony 403, archiwum 409; **zgłoszenie i usunięcie wiadomości w kanale szkicu albo archiwum (dla gościa) → 404**; usunięcie przez autora bez zgłoszeń nie zostawia `original_body`; cykl życia turnieju (draft 404, dzień karencji tylko dla zalogowanych, archiwum niewidoczne dla gościa); zgłoszenia → automatyczne ukrycie po 3; akcje admina; wyłącznik (plik `chat-off`) → 503 przed bazą. |
| `tests/billing.http.test.mjs` | billing-backend | Scenariusze z 03 §14.2 na atrapie Stripe: 402, checkout URL (waluta z kraju, nie z klienta), ponowne użycie sesji, obcy `session_id` 403, `confirm`→`active`, `past_due` z karencją i jej wygaśnięcie, `requireFrom` → baner → `grace` → `none`, webhook (poprawny, duplikat, zły podpis, `livemode`), `events` pull bez podwójnego przetwarzania, **subskrypcja A anulowana + B aktywna, potem `reconcile` → wiersz zostaje B/active; zdarzenie A po B → bez zmian**, `exempt` z audytem, dwie równoległe synchronizacje = jedno wywołanie Stripe, bezpiecznik po błędzie sieci, usunięcie konta z klientem Stripe (atrapa odnotowuje `DELETE /v1/customers`; błąd → `stripe_redact_pending` i ponowienie), zmiana e-maila wysłana do Stripe, nagłówki `Stripe-Version` i `Idempotency-Key` zapisane przez atrapę. |
| `tests/integration.http.test.mjs` | integration-qa | Scenariusze między plasterkami: usunięcie konta zamienia wiadomości w nagrobki z nowym `rev`; `confirm` odblokowuje `chat-send`; filtr `muted` w `admin-members`; `me.access.mutedUntil`; `diagnostics` z sondą Stripe na atrapie. |

- **Fixture HTTP.** `tests/helpers/fixture.php` (backend-data) działa tylko z CLI, korzysta z `MATDRAW_CONFIG` i jest uruchamiany przez `spawnSync` z `tests/helpers/http-client.mjs`. Ma zadania bazowe `member {email,password,profile,exempt}`, `billing {userId,…}`, `tournament {date,status}` i **`reset-limits`** (`DELETE FROM login_limits`) oraz **ładuje przez glob `tests/helpers/fixture-*.php`**, które dopisują zadania plasterków fali 3 (`fixture-chat.php`, `fixture-billing.php`, `fixture-accounts.php`), każdy z jednym właścicielem.
- **Limity w testach.** Każdy plik `*.http.test.mjs` woła `fixture('reset-limits')` w `before()` i między scenariuszami, które same testują limity. Limity produkcyjne zostają bez zmian; wszystkie testy idą z 127.0.0.1, więc bez tego `reserveLogin` (IP) i limity rejestracji zatrzymałyby późniejsze pliki.
- **Daty w testach.** Turnieje zakładane w nowych testach mają daty ≥ 2030 albo daty minione, chyba że test celowo sprawdza okno „dziś”. Nie psuje to asercji „pierwsze 6 publicznych” w `http.test.mjs`.

**Ręczna lista QA** (`integration-qa` wykonuje ją lokalnie w Playwright i/lub w przeglądarce; właściciel powtarza na produkcji):
1. Strona główna 1440/1024/390/360 px:
   - logowanie w tym samym miejscu na desktopie; na telefonie przycisk „Zaloguj się” w hero przy pierwszej wizycie;
   - czat na żywo w środkowej kolumnie; telefon: karta podglądu i trasa `#chat`;
   - zmiana języka zachowuje kanał, przewinięcie i szkic na stronie głównej, **na `#chat` gościa i na `#signup` w kroku 2 (wpisane dane zostają)**;
   - brak poziomego przewijania.
2. Dwie karty i dwie przeglądarki:
   - wiadomość pojawia się po ≤ 3 s; własna natychmiast;
   - przewinięcie w górę pokazuje przycisk „Nowe wiadomości”;
   - zakładka w tle przestaje odpytywać (DevTools → Network);
   - pięć kart daje jedno źródło zapytań;
   - nieruszana widoczna karta zwalnia mimo nowych wiadomości.
3. Gość:
   - dane w JSON bez tożsamości (DevTools → Network);
   - placeholdery wyglądają na zaprojektowane, nie na błąd;
   - CTA według macierzy §6.10 (z ceną tylko przy włączonej rejestracji).
4. Rejestracja 3 kroki → plan → Checkout (4242…) → powrót → „Gotowe!”; anulowanie płatności; portal: anulowanie na koniec okresu → „Kończy się …”; usunięcie konta z aktywną subskrypcją (potwierdzenie).
5. Admin:
   - darmowe konto personelu i członka; nowe konto personelu bez „Darmowe” → po włączeniu wymuszania podgląd i 402 przy zapisie, zmiana hasła działa;
   - `requireFrom` dla kont `grandfathered` → baner;
   - hasło tymczasowe członka → wymuszona zmiana po zalogowaniu;
   - moderacja: zgłoszenie, ukrycie, usunięcie, wyciszenie;
   - ustawienia tempa, licznik odpowiedzi hostingu i wyłącznik.
6. PWA:
   - instalacja na Androidzie (karta i menu);
   - iOS: dodanie do ekranu, logowanie w aplikacji, powrót ze Stripe;
   - wdrożenie podczas otwartej aplikacji → pasek → „Odśwież” przeładowuje tylko tę kartę;
   - podniesione `min_client_api` → automatyczna aktualizacja bez niezapisanych danych, pasek blokujący z nimi;
   - tryb samolotowy → `offline.html`;
   - `#screen` nie jest przeładowywany przy zwykłej aktualizacji.
7. Dostępność:
   - klawiatura (karty kanałów strzałkami, `feed` PageUp/PageDown);
   - czytnik ekranu ogłasza najwyżej co 15 s;
   - kontrast nowych szarości;
   - `prefers-reduced-motion`.
8. Demo (`dist/` bez serwera): czat lokalny działa, konto demo pisze bez uzupełniania profilu, rejestracja i płatności pokazują komunikat, brak service workera.
9. Wspólne urządzenie: zalogowany członek → wylogowanie → strona główna i druga karta pokazują wyłącznie projekcję gościa (DevTools: brak `people` w pamięci po przeładowaniu, brak szkiców w `sessionStorage`).
10. Członek: `#guest?t=` z wyborem kategorii i kartą czatu; `#screen` przekierowuje na `#chat`.
11. Konsola przeglądarki bez naruszeń CSP i bez błędów.

---

## 12. Plasterki implementacji

**Zasady wspólne dla wszystkich plasterków:**
- styl kodu zwarty, jak w repozytorium;
- komunikaty jako polskie literały z tłumaczeniem EN we własnym słowniku;
- żadnych zależności Composer ani npm w czasie działania;
- przed oddaniem: wszystkie dotychczasowe testy zielone, `php -l` i `node --check` nowych plików;
- commity z atrybucją z instrukcji sesji;
- **nie edytować plików spoza `ownsFiles`**, z wyjątkiem wymienionych w `touchesShared`, i to dokładnie w opisany sposób;
- nowe trasy, zadania i migracje wyłącznie przez rejestry z §4.1, §3.7 i §2.2;
- nowe klucze config wyłącznie z Załącznika A, czytane przez `Config::DEFAULTS` (§6.8);
- każdy plik `*.http.test.mjs` woła `fixture('reset-limits')` w `before()` (§11).

**Zasada scalania (D18, poprawione po przeglądzie).** Każdy plasterek pracuje na własnej gałęzi od bieżącego stanu gałęzi integracyjnej `claude/quirky-einstein-sgelzm` i jest do niej scalany po zakończeniu fali. **Do `main` nie trafia żaden plasterek osobno**: `main` dostaje jedno scalenie po zielonym `integration-qa` i po potwierdzeniu P1. Powód: `deploy.yml` wdraża każdy push do `main`, a krok migracji we wdrożeniu dochodzi dopiero w fali 4 (`deploy-infra`). Gdyby mimo to kod trafił na serwer przed migracją, aplikacja odpowie 503 „Trwa przerwa techniczna” (brak tabeli lub kolumny, §4.1), a nie 500.

**Pierwszy krok orkiestratora przed falą 1:** zatwierdzić `docs/plan/` na gałęzi integracyjnej (katalog jest dziś nieśledzony, patrz „Środowisko”).

| id | Fala | Model / wysiłek | Zależy od | Najważniejsze pliki |
|---|---|---|---|---|
| `backend-data` | 1 | opus / high | — | Migrator, `migrate.php`, `dump.php`, `install.php`, migracja 0002, poprawka `Repository` (load/persist/1062), `scripts/test-http.sh`, fixture z `reset-limits` i globem, test izolacji |
| `frontend-foundation` | 1 | opus / high | — | `registry.js` (z `h`/`setHtml`), `me.js`, `client.js` (nagłówek wersji), `i18n.js` (pierwszy wygrywa), `index.html`, haki w `app.js` (wylogowanie, język, podgląd członka, `#screen`), testy i18n/registry/xss |
| `backend-api` | 2 | opus / xhigh | backend-data | `index.php`, `Auth` (peek bez plików, odświeżanie), `Routes`, `Config`, `Text`, `Accounts` (lekkie logowanie, równy hash), `Access` (z `grace`), `People`, `RateLimit`, `ClientIp`, `Jobs` (zwolnienie sesji, próbkowanie), `me`, `public-config` |
| `pwa-core` | 2 | sonnet / medium | frontend-foundation | `sw.js`, `offline.html`, manifesty, `build-pwa.mjs`, testy PWA |
| `home-embed` | 2 | sonnet / high | frontend-foundation | `app.js` (druga runda szablonów), `workspace.css` (siatka), `home-en.js` |
| `accounts-profiles-backend` | 3 | opus / high | backend-api, frontend-foundation | rejestracja z `signup-begin` i tokenem, profil, nazwa (POST), awatary w katalogach `public_id`, członkowie (Admin, e-mail, hasło tymczasowe), usuwanie konta, `profile-data.js` |
| `chat-backend` | 3 | opus / xhigh | backend-api, frontend-foundation | 0003 (z `chat_health`), Chat (widoczność dla zapisów, `h` z `knownLast`, `tombstoneUser`), ChatGuestView, moderacja, ustawienia, retencja |
| `billing-backend` | 3 | opus / xhigh | backend-api, frontend-foundation | 0004, StripeClient (sonda, bezpiecznik), Signature, Billing, BillingSync (pierwszeństwo subskrypcji), CLI z ukrytym kluczem, atrapa Stripe |
| `pwa-frontend` | 3 | sonnet / medium | frontend-foundation, pwa-core | `pwa.js` (także `client-outdated`), `pwa.css`, `lang-boot.js` |
| `chat-frontend` | 4 | opus / high | frontend-foundation, home-embed, chat-backend, accounts-profiles-backend | `chat-boot.js`, `chat.js`, `chat-transport.js`, `chat-demo.js`, `chat.css` |
| `chat-moderation-frontend` | 4 | sonnet / high | frontend-foundation, chat-backend | `moderation-boot.js`, `chat-admin.js`, `moderation.css`, `moderation-en.js` |
| `account-frontend` | 4 | opus / high | frontend-foundation, home-embed, accounts-profiles-backend, billing-backend | `account-boot.js`, `account-flow.js`, `avatar-crop.js`, `account.css`, `promo.js` |
| `members-frontend` | 4 | sonnet / high | frontend-foundation, accounts-profiles-backend, billing-backend | `members-boot.js`, `admin-members.js`, `members.css`, `members-en.js` |
| `deploy-infra` | 4 | opus / high | backend-data, backend-api, pwa-core, accounts-profiles-backend, chat-backend, billing-backend | `deploy-remote.sh`, `deploy-verify.sh`, `deploy.yml`, `.htaccess`, `poll-probe.sh`, `DEPLOY-PL.md` |
| `integration-qa` | 5 | opus / high | wszystkie | test integracyjny, dokumentacja, zrzuty ekranu manifestu, pełne testy, przegląd bezpieczeństwa, poprawki integracyjne |

Pełne opisy, listy plików i kryteria akceptacji każdego plasterka są poniżej (te same dane są w strukturalnym wyniku zadania). Plik wymieniony w dwóch plasterkach ma właścicieli w **różnych falach**, więc nigdy nie jest edytowany równolegle. **Kontrakty między plasterkami tej samej fali** (np. `Chat::tombstoneUser` dla `Members`, `ChatModeration::mutedUntil` dla `me`, `StripeClient::probe` dla `diagnostics`) są wywoływane przez `class_exists` i sprawdzane przez `integration-qa` w `tests/integration.http.test.mjs`. Strony frontendu fali 4 nie zależą od siebie: każdy plasterek ma własny mały moduł rozruchowy (`chat-boot`, `moderation-boot`, `account-boot`, `members-boot`), który `app.js` importuje statycznie od fali 1.

### 12.1 `backend-data`: Dane i narzędzia: migrator, migracja 0002, poprawka Repository, kopie, harness testów HTTP

- **Fala:** 1 · **Model / wysiłek:** opus / high · **Zależy od:** —
- **Pliki własne:** `backend/src/Migrator.php`, `backend/bin/migrate.php`, `backend/bin/dump.php`, `backend/bin/install.php`, `backend/migrations/0002_accounts.php`, `backend/database/schema.sql`, `backend/src/Repository.php`, `scripts/test-http.sh`, `tests/helpers/http-client.mjs`, `tests/helpers/fixture.php`, `tests/http.test.mjs`, `tests/isolation.http.test.mjs`, `tests/migrations.test.mjs`
- **Pliki współdzielone:** backend/database/schema.sql: wyłącznie komentarz w nagłówku 'zamrożona baza = wersja 1; zmiany tylko przez backend/migrations'; tests/http.test.mjs: wyłącznie zastąpienie lokalnej klasy Client importem z tests/helpers/http-client.mjs i before(()=>fixture('reset-limits')); asercje bez zmian
- **Opis:** Plan: §2.1–2.3, §2.6, §2.8, §3.3 pkt 5–6, §9.6 (dump.php), §11 (fixture, limity). Nie zmieniaj Domain.php, workspace.js, GuestView.php ani index.php. (1) Migrator wg §2.2: src/Migrator.php (helpery information_schema, GET_LOCK, lock_wait_timeout=30, ciągłe id, floor, status, rollbackFloor), bin/migrate.php (--status wypisuje STATE/CURRENT/TARGET/PENDING/DESTRUCTIVE/FLOOR, --dry-run, --allow-destructive, --rollback-floor; kody 0/1/2/10; dane db_migrate jeśli są; błąd 1205/1213 → komunikat 'Baza jest chwilowo zajęta. Ponów wdrożenie za kilka minut.'), bin/install.php: schema.sql → Migrator::run → pierwszy admin jak dziś (pliki bin/ dołączają src/Migrator.php jawnie przez require_once, bo autoloader dodaje dopiero backend-api). (2) bin/dump.php wg §9.6: PDO niebuforowane, gzopen strumieniowo, jedna transakcja REPEATABLE READ, DROP TABLE IF EXISTS + SHOW CREATE TABLE + wiersze przez quote, FK off w nagłówku, '-- Dump completed on <data>'; tryb STDOUT i tryb --auto (zapis do ~/matdraw/backups wyliczanego z położenia config, pomija pracę przy kopii młodszej niż 20 h, retencja 30 dni z zachowaniem najnowszej, pliki 600, katalog 700). (3) migrations/0002_accounts.php dokładnie SQL z §2.3 (w tym name_display DEFAULT 'initial', pw_reset_at, stripe_redact_pending, deleted_at, account_audit; ALTER warunkowo przez enumHas/columnNullable; floor: istnieje users.role='member'). (4) Repository: load() z WHERE role<>'member'; persist(): users przez jawne INSERT (nowe id) i UPDATE ... WHERE id=? AND role<>'member' (zmienione); PDOException 1062 na instrukcji users → AppError('Konto z tym adresem e-mail już istnieje.',409); reszta tabel bez zmian (§2.6). (5) Narzędzia testowe: scripts/test-http.sh <port> [db] [dodatkowe pliki] (build, świeża baza MariaDB jak harness ze scratchpada, config z wartościami testowymi z §9.9 łącznie z support_email; install + migrate dwa razy; uruchamia node tests/stubs/stripe-stub.mjs <port+1> jeśli plik istnieje; eksportuje MATDRAW_CONFIG, MATDRAW_TEST_SHARED_DIR, MATDRAW_TEST_URL; node --test --test-concurrency=1 tests/http.test.mjs jako pierwszy, potem glob tests/*.http.test.mjs albo podane pliki), tests/helpers/http-client.mjs (Client z http.test.mjs z nagłówkiem X-MatBravo-Client + funkcja fixture(job,payload) przez spawnSync PHP), tests/helpers/fixture.php (tylko CLI; zadania member {email,password,profile,exempt}, billing {userId,...pola billing_accounts}, tournament {name,date,status}, reset-limits; ładuje tests/helpers/fixture-*.php przez glob). (6) tests/isolation.http.test.mjs: członek z fixture nie loguje się starą ścieżką i nie trafia do workspace; regresja przejęcia wiersza (409, wiersz członka nietknięty); zmiana e-maila personelu na e-mail członka → 409; migrate drugi raz bez zmian; --rollback-floor 1/2. (7) tests/migrations.test.mjs wg §11.
- **Kryteria akceptacji:**
  - Wszystkie istniejące testy (engine, workspace, i18n, php, http) przechodzą bez zmiany asercji.
  - scripts/test-http.sh uruchamia tests/http.test.mjs i tests/isolation.http.test.mjs zielone na lokalnej MariaDB 10.11.
  - Test regresji: account.save z e-mailem istniejącego członka → 409, a id, rola i hash hasła członka bez zmian; zmiana e-maila konta personelu na e-mail członka → 409.
  - migrate.php: drugi przebieg bez zmian (kod 0); --status poprawny; --rollback-floor = 1 bez członków i 2 z członkiem.
  - dump.php --auto tworzy plik .sql.gz z trybem 600, który przechodzi gzip -t, zawiera znacznik Dump completed i odtwarza się do bazy z równym haszem danych; drugie wywołanie w ciągu 20 h niczego nie robi.
  - tests/migrations.test.mjs zielony; php -l wszystkich nowych plików; brak zmian w Domain.php, workspace.js, GuestView.php i index.php.

### 12.2 `frontend-foundation`: Fundament frontendu: rejestr z bezpiecznym szablonem, haki w app.js, klient API, stan me, scalanie słowników i18n

- **Fala:** 1 · **Model / wysiłek:** opus / high · **Zależy od:** —
- **Pliki własne:** `dist/registry.js`, `dist/me.js`, `dist/tokens.css`, `dist/app.js`, `dist/client.js`, `dist/i18n.js`, `dist/icons.js`, `dist/index.html`, `dist/i18n/shell-en.js`, `tests/i18n.test.mjs`, `tests/registry.test.mjs`, `tests/xss-scan.test.mjs`
- **Pliki współdzielone:** Tworzy zaślepki, których pełna własność przechodzi dalej: dist/chat-boot.js i dist/chat.css (→ chat-frontend), dist/moderation-boot.js, dist/chat-admin.js i dist/moderation.css (→ chat-moderation-frontend), dist/account-boot.js i dist/account.css (→ account-frontend), dist/members-boot.js, dist/admin-members.js i dist/members.css (→ members-frontend), dist/pwa.js i dist/pwa.css (→ pwa-frontend) jako 'export {};' lub pusty komentarz; dist/i18n/accounts-en.js (→ accounts-profiles-backend, potem account-frontend), dist/i18n/chat-en.js (→ chat-backend, potem chat-frontend), dist/i18n/moderation-en.js (→ chat-moderation-frontend), dist/i18n/members-en.js (→ members-frontend), dist/i18n/billing-en.js (→ billing-backend, potem account-frontend), dist/i18n/home-en.js (→ home-embed), dist/i18n/pwa-en.js (→ pwa-frontend) jako 'export default {};'; dist/app.js: tylko haki §8.3 pkt 1–16; druga runda zmian w app.js należy do home-embed (fala 2)
- **Opis:** Plan: §8.1–8.8, §9.1 (index.html), §5.9 (zasady XSS), §9.4 (client-outdated). Zero zmian wizualnych i funkcjonalnych dla obecnych ekranów poza przeładowaniem po wylogowaniu. (1) dist/registry.js wg §8.2 (bez importów): registerPage/registerPublicPage/registerAction, page/publicPage/navItems/handle/defaultPage, setBadge, on/emit (z 'client-outdated'), provide/use, parseRoute (alias #czat→chat, query w URLSearchParams, #screen i #guest bez zmian), szablon h z SafeHtml (każda wstawka uciekana, zagnieżdżanie SafeHtml) i setHtml (jedyne miejsce z innerHTML; odrzuca zwykły string). (2) dist/app.js: wyłącznie haki §8.3 pkt 1–16 (importy i provide('ui') z ui.shell na SafeHtml, parsowanie tras, render z rejestrem i rolą member, shell z navItems/plakietkami/etykietą Członek/data-self-avatar, fallback drabinki i publicAction do registry.handle, my-account → profile, renderPublic z publicPage, emit painted/login/logout/saved/payment-required/language/ready, gałąź 402 w handleError, zaślepki data-billing-badge i data-account-billing, wylogowanie z purgeSession i location.replace, zmiana języka na stronach publicznych rejestru, trasowanie podglądu turnieju dla członka (render, fetchGuest, drabinka kliknięć), #screen dla członka, zastrzeżone id formularzy). (3) dist/client.js wg §8.4: request(route,{method,body,contentType,signal}) z prywatnym csrf, 204→null, DomainError z error.data, nagłówek X-MatBravo-Client: 1 w każdym żądaniu, 409 client_outdated → registry.emit('client-outdated'), publicGet(params,{signal,timeout}) z credentials omit (w demo public-config bez sieci), apiUrl(params); w demo request rzuca Error('Ta funkcja jest niedostępna w wersji demonstracyjnej.'). (4) dist/me.js wg §8.5: loadMe({force}), getMe, onMe, canPost, access; 404 me → funkcje wyłączone; reakcja na ready/login/logout/visibilitychange (najwyżej co 5 min)/payment-required; purgeSession() i BroadcastChannel('matbravo-session') z komunikatem reset; demo: konta demo jako staff/free z kompletnymi profilami, features.signup=false, billing.enabled=false. (5) dist/i18n.js wg §8.6: statyczne importy i18n-en.js i ./i18n/{shell,accounts,chat,moderation,members,billing,home,pwa}-en.js, export DICTIONARY (pierwszy wygrywa) i collisions, 5 miejsc przechodzi na DICTIONARY. (6) tests/i18n.test.mjs wg §8.6 pkt 1–6 (komunikaty Error/DomainError ze wszystkich modułów, collisions puste). (7) tests/xss-scan.test.mjs wg §5.9. (8) dist/icons.js: ikony chat, globe, send, flag, more, bell, bell-off, share, plus-square, archive, wifi-off, camera, zoom-in, zoom-out, card, user w istniejącym stylu. (9) dist/index.html: linki CSS w kolejności §8.7 (z moderation.css i members.css), meta mobile-web-app-capable i apple-mobile-web-app-title, viewport z viewport-fit=cover i interactive-widget=resizes-content, <div id="pwa-root"></div> za #toast. (10) dist/tokens.css: tokeny §8.7. (11) Zaślepki modułów, CSS i słowników (patrz touchesShared). dist/i18n/shell-en.js z tłumaczeniami tekstów haków. (12) tests/registry.test.mjs (parseRoute, filtrowanie menu według ról, handle, h/setHtml, collisions).
- **Kryteria akceptacji:**
  - Tryb demo (dist/) i tryb API (build PHP) działają i wyglądają identycznie jak przed zmianą: ręczna kontrola 1440 i 390 px — logowanie, turnieje, baza, konta, podgląd gościa, ekran hali, wydruk; wylogowanie wraca na stronę główną po przeładowaniu.
  - node --test tests/engine.test.mjs tests/workspace.test.mjs tests/i18n.test.mjs tests/registry.test.mjs tests/xss-scan.test.mjs zielone; php.test i http.test zielone bez zmian.
  - Uogólniony test i18n skanuje wszystkie moduły UI, globy PHP (src, routes, jobs, api), wzorce AppError|ApiError i Error|DomainError we wszystkich modułach; celowo usunięte tłumaczenie powoduje błąd testu (sprawdzone lokalnie i cofnięte).
  - Kolizja klucza słownika trafia do collisions (bez wyjątku przy ładowaniu); test wymaga pustej tablicy.
  - tests/xss-scan.test.mjs wykrywa celowo dodane innerHTML w nowym module (sprawdzone i cofnięte); h ucieka wstawki, setHtml odrzuca string.
  - Przełączenie języka na zarejestrowanej stronie publicznej (strona testowa w registry.test lub ręcznie) nie wraca do logowania.
  - Strona testowa zarejestrowana w teście pojawia się w menu tylko dla zadeklarowanych ról; nieznana akcja trafia do registry.handle; node --check wszystkich dist/*.js i dist/i18n/*.js.

### 12.3 `backend-api`: Rdzeń API: rejestr tras, sesje bez plików przy podglądzie, lekkie konta, dostęp, zadania po odpowiedzi

- **Fala:** 2 · **Model / wysiłek:** opus / xhigh · **Zależy od:** `backend-data`
- **Pliki własne:** `backend/bootstrap.php`, `backend/config.example.php`, `backend/public/api/index.php`, `backend/src/Auth.php`, `backend/src/ApiError.php`, `backend/src/Config.php`, `backend/src/Routes.php`, `backend/src/RouteContext.php`, `backend/src/Accounts.php`, `backend/src/Access.php`, `backend/src/People.php`, `backend/src/RateLimit.php`, `backend/src/ClientIp.php`, `backend/src/Text.php`, `backend/src/Jobs.php`, `backend/src/Paths.php`, `backend/routes/core.php`, `backend/jobs/core.php`, `backend/bin/cron.php`, `dist/i18n-en.js`, `tests/accounts.http.test.mjs`, `tests/core.test.mjs`, `tests/php-bridge-core.php`, `tests/helpers/fixture-core.php`
- **Pliki współdzielone:** dist/i18n-en.js: wyłącznie nowa sekcja na końcu obiektu z tłumaczeniami EN nowych komunikatów serwera z tego plasterka (przed zamykającym nawiasem, z przecinkiem po poprzednim ostatnim wpisie)
- **Opis:** Plan: §3.1, §3.3–3.5, §3.7, §4.1–4.3 (me, public-config), §5.5 (Text::clean), §6.5, §6.8, §7.6, Załącznik A. Nie zmieniaj Domain.php, workspace.js, GuestView.php ani plików backend-data. (1) bootstrap.php: autoloader MatDraw\X → src/X.php (require_once Domain.php zostaje, bo zawiera AppError); matdraw_config() zwraca array_replace(Config::DEFAULTS,$c) i waliduje płatności oraz kombinacje przełączników (§6.8). (2) ApiError z array $data. Routes + RouteContext wg §4.1: rejestr backend/routes/*.php (duplikat → RuntimeException), tryby public/peek/session/upload/webhook, user required|optional|admin|member|anon, limit body i Content-Type, tag 'chat' → 503 z code chat_off przed bazą, Routes::retryAfter, Routes::logThrowable (bez komunikatów PDOException), $ctx->releaseSession(), $ctx->pdo() leniwie, null → 204, MIN_CLIENT_API i kontrola nagłówka X-MatBravo-Client. (3) index.php: maintenance i client_outdated przed bazą; SQLSTATE 42S02/42S22 → 503; potem Routes::dispatch; istniejące trasy: login lekki (Accounts::findByEmail, Accounts::dummyHash z tym samym algorytmem i parametrami co Domain::password, weryfikacja zawsze, limity z config, IPv6 /64), session lekka, bootstrap z gałęzią member i bez blokady podglądu dla personelu, command: member → 403, Access full=false → 402 poza account.password; oba catch przez Routes::logThrowable. (4) Auth wg §3.5: start() (idle/max z sesji, save_path i gc_probability=0 tylko przy save_handler files i własnym katalogu), enter($u,$c) z polityką member, peek($c) dokładnie w kolejności 1–7 (sprawdzenie istnienia pliku sesji przed session_start, session_cache_limiter(''), read_and_close, header_remove('Set-Cookie'), odświeżenie raz na idle/4), reserveLogin z limitami login_limit_ip i ClientIp::bucket. (5) Accounts: current, currentPeek, findByEmail, dummyHash, ensureProfile (public_id base62 12 znaków, 3 próby), touchLogin, memberWorkspace, safe, profileComplete. (6) Access::compute/of dokładnie tabela §6.5 (z wierszem grace). (7) People::project wg §7.6 (domyślnie inicjał). (8) RateLimit::hit; ClientIp::get i bucket. (9) Text::clean wg §5.5. (10) Paths: shared, uploads (odmowa ścieżki w docroot), sessions, backups. (11) Jobs wg §3.7 (session_write_close na początku, próbkowanie jobs-tick 30 s, finish_request, jeden SELECT, jedno najbardziej zaległe zadanie, needsFlush, job_test_sleep_ms); jobs/core.php: housekeeping (login_limits; pliki sesji według rodzaju, porcjami DirectoryIterator, tylko własny katalog); bin/cron.php. (12) routes/core.php: me (peek, kształt §4.3 z mustChangePassword, access.block 'password', mutedUntil przez class_exists ChatModeration, billing.currency z §6.1; po odpowiedzi Jobs::maybe oraz class_exists BillingSync → BillingSync::lazy) oraz public-config (public, max-age=60, z support). (13) config.example.php: wszystkie klucze Załącznika A z komentarzami po angielsku. (14) EN nowych komunikatów na końcu dist/i18n-en.js. (15) Testy: tests/core.test.mjs + tests/php-bridge-core.php (§11), tests/accounts.http.test.mjs (§11), tests/helpers/fixture-core.php (zadania pomocnicze tego plasterka, np. wygaszenie sesji, usunięcie tabeli w bazie testowej).
- **Kryteria akceptacji:**
  - Wszystkie dotychczasowe testy i testy backend-data zielone; tests/accounts.http.test.mjs i tests/core.test.mjs zielone przez scripts/test-http.sh.
  - Członek (z fixture): bootstrap zwraca pusty workspace członka, command → 403; session i login mają identyczne kształty odpowiedzi jak przed zmianą.
  - me zwraca kształt z §4.3 dla admin, club i member; public-config zwraca {signup,billing,amounts,avatars,support} z Cache-Control public.
  - Peek: ważne, wygasłe i zmyślone ciasteczko → brak Set-Cookie i brak nowego pliku sesji; aktywność odświeżona po 1/4 limitu (sprawdzone na pliku sesji).
  - Personel z billing_exempt=0 przy billing_enforce: bootstrap 200, command 402, account.password 200.
  - Drugie żądanie z tym samym ciasteczkiem w trakcie spowolnionego zadania (job_test_sleep_ms) odpowiada w < 1 s.
  - Plik maintenance → 503 z Retry-After przed bazą; brak tabeli → 503 zamiast 500; X-MatBravo-Client poniżej minimum → 409 client_outdated.
  - core.test: Access (wszystkie wiersze z granicami), dummyHash (password_get_info zgodne z Domain::password), Text::clean, Config (odrzucone kombinacje), ClientIp /64.
  - Przegląd kodu: brak error_log z $e->getMessage() dla PDOException; php -l wszystkich nowych plików; brak zmian w Domain.php, workspace.js, GuestView.php.

### 12.4 `pwa-core`: PWA: service worker, offline, manifesty PL/EN, build z wersjonowanym precache

- **Fala:** 2 · **Model / wysiłek:** sonnet / medium · **Zależy od:** `frontend-foundation`
- **Pliki własne:** `dist/sw.js`, `dist/offline.html`, `dist/manifest.webmanifest`, `dist/manifest.en.webmanifest`, `dist/brand/shortcut-chat-96.png`, `dist/brand/shortcut-tournaments-96.png`, `scripts/build-pwa.mjs`, `scripts/build-php.mjs`, `tests/pwa-sw.test.mjs`, `tests/pwa-build.test.mjs`
- **Pliki współdzielone:** brak
- **Opis:** Plan: §9.1–9.3; raport 04 §1.3–1.4 i §1.7 (implementacja referencyjna i harness w scratchpadzie poprzedniej sesji są wzorem, przepisz do repo). (1) dist/sw.js: szablon z 04 §1.4.2 (znaczniki /*@build*/'dev' i /*@precache*/[]; bez precache tylko przepuszcza; nie przechwytuje api/, u/, live/, sw.js, version.json, nie-GET, Range, obcych originów; nawigacja do korzenia z precache, inna nawigacja przez sieć z offline.html; shell cache-first z jednej wersjonowanej pamięci; reszta stale-while-revalidate w matbravo-static-1; install z cache:'reload' wszystko-albo-nic; activate usuwa obce matbravo-*; SKIP_WAITING tylko na wiadomość; VERSION). (2) dist/offline.html: statyczny, inline style, lang-boot.js, bloki .pl/.en (teksty z 04 §1.4.4), link Spróbuj ponownie do ./. (3) Manifesty PL i EN wg §9.1 (bez screenshots — dodaje je integration-qa). (4) Ikony skrótów 96 px wygenerowane jednorazowo z dist/brand/icon-192.png (PHP GD lub skrypt w scratchpadzie; w repo tylko PNG). (5) scripts/build-pwa.mjs wg 04 §1.4.5 z listą wykluczeń §9.3, limit 1,5 MB, błąd przy braku lub duplikacie znaczników, deterministyczny hash. (6) scripts/build-php.mjs: na końcu await buildPwa(path.join(target,'public'),{commit:(process.env.GITHUB_SHA||'local').slice(0,7)}). (7) tests/pwa-sw.test.mjs (atrapy caches/fetch/zdarzeń, min. 18 asercji z 04 §1.4.2) i tests/pwa-build.test.mjs (04 §1.7).
- **Kryteria akceptacji:**
  - tests/pwa-sw.test.mjs i tests/pwa-build.test.mjs zielone.
  - Build PHP: public/sw.js bez znaczników /*@, node --check przechodzi, version.json.build równy numerowi w sw.js, precache < 1,5 MB, żaden wpis nie zaczyna się od api/, u/ ani live/.
  - Dwa buildy bez zmian treści dają ten sam hash; zmiana CSS zmienia hash.
  - Manifesty: poprawny JSON, id '/', start_url w scope, ikony istnieją z zadeklarowanymi wymiarami (IHDR), co najmniej jedna maskable.
  - Dotychczasowe testy zielone; tryb demo nie rejestruje workera (rejestracja należy do pwa-frontend); scripts/test-http.sh (backend-data) nadal buduje wydanie.

### 12.5 `home-embed`: Strona główna z czatem (koncepcja A), karta podglądu na telefonie, karta Czat turnieju w podglądzie gościa, punkty wejścia w powłoce

- **Fala:** 2 · **Model / wysiłek:** sonnet / high · **Zależy od:** `frontend-foundation`
- **Pliki własne:** `dist/app.js`, `dist/workspace.css`, `dist/i18n/home-en.js`
- **Pliki współdzielone:** dist/app.js: wyłącznie druga runda z §8.3 (szablony renderLogin, upcomingSection/upcomingItem, guestPage + akcja guest-tab w publicAction, szablony trybu memberPreview, zaślepki w tournamentsPage, akapit login-help z data-account-mount) — haki foundation pozostają nietknięte
- **Opis:** Plan: §8.3 (druga runda), §8.9, §8.7; raport 05 §2.1–2.6, §5.1, §14 i makieta docs/plan/mockups/home-chat.html (wiążąca dla proporcji). Treść kart wypełniają chat-frontend i account-frontend (fala 4) przez atrybuty data-* — tu tylko struktura, siatka, atrybuty i szkielety. (1) renderLogin: obszary story/chat/auth; lewa kolumna logo, eyebrow, H1 44 px, intro, upcoming-stage (maskotka --mascot-h:196px); środkowa <section class="home-chat" data-chat-mount="home" aria-labelledby="home-chat-title"> ze szkieletem 4 wierszy; prawa kolumna formularz logowania bez zmian + <div data-account-mount="join"></div>; akapit login-help z data-account-mount="login-help" i dotychczasowym tekstem; skip links Przejdź do czatu i Przejdź do logowania; kolejność DOM story → czat → logowanie; klasa known-device przy localStorage matdraw.knownDevice (try/catch); na ≤650 px stały przycisk Zaloguj się w kompaktowym hero (przewija do formularza i ustawia fokus). Zachowaj działanie rerenderLanguage (wpisane wartości, promo). (2) upcomingItem: nieinteraktywny <span class="upcoming-chat" data-chat-count="${id}"></span>. (3) guestPage: pasek kart Kategorie i drabinki | Czat turnieju z akcją guest-tab (stan guest.tab, parametr &tab=chat), panel czatu <div data-chat-mount="tournament" data-tournament-id="…">; szablony memberPreview: bez promo, przycisk Wróć (data-page) zamiast Zaloguj się (logika trasowania jest w hakach foundation §8.3 pkt 14). (4) tournamentsPage: <div data-chat-mount="strip"></div> nad siatką i <span data-chat-tournament-link="${id}"></span> w karcie turnieju. (5) workspace.css: siatka logowania we wszystkich zapytaniach mediów (≥1200: minmax(340px,388px) minmax(460px,1fr) clamp(400px,30vw,480px); ≥1650: 400px minmax(560px,760px) 520px; 651–1199: obszary story auth / chat auth / upcoming foot z kartą czatu 560 px; ≤650: hero z przyciskiem logowania, karta podglądu nachodząca na hero, auth, upcoming, stopka; known-device stawia auth nad czatem; ≤440 kompakt), kontener .home-chat (sticky, height calc(100dvh - 48px), min 560, max 900) — wnętrze karty należy do chat.css; brak poziomego przewijania. (6) Teksty EN w dist/i18n/home-en.js (05 §19.1).
- **Kryteria akceptacji:**
  - Uogólniony test i18n zielony (brak polskich liter w app.js poza T()); tests/xss-scan.test.mjs zielony.
  - Zrzuty Playwright (scratchpad) 1440/1024/390/360 px zgodne z makietą (karta czatu jako szkielet): formularz logowania na desktopie w tym samym miejscu co dziś, na telefonie przycisk Zaloguj się w hero, brak poziomego przewijania, kolejność DOM story → czat → logowanie.
  - Dotychczasowe przepływy działają: promo i podgląd gościa, lista Najbliższe turnieje, zmiana języka z zachowaniem wpisanych danych, demo, ekran hali, wydruk.
  - Członek (fixture w buildzie PHP albo konto demo z rolą member w teście) może otworzyć podgląd turnieju (#guest?t=), wybrać kategorię i przełączyć kartę, bez promo i z przyciskiem Wróć.

### 12.6 `accounts-profiles-backend`: Rejestracja, profile, nazwy użytkowników, awatary, konta członków (Admin), e-mail, hasło tymczasowe, usunięcie konta

- **Fala:** 3 · **Model / wysiłek:** opus / high · **Zależy od:** `backend-api`, `frontend-foundation`
- **Pliki własne:** `backend/src/Profiles.php`, `backend/src/Members.php`, `backend/src/Avatars.php`, `backend/src/Capabilities.php`, `backend/routes/accounts.php`, `backend/jobs/accounts.php`, `dist/profile-data.js`, `scripts/gen-countries.mjs`, `dist/i18n/accounts-en.js`, `tests/profiles.http.test.mjs`, `tests/community.test.mjs`, `tests/php-bridge-community.php`, `tests/fixtures/avatars/`, `tests/helpers/fixture-accounts.php`
- **Pliki współdzielone:** brak
- **Opis:** Plan: §3.4, §3.6–3.10, §4.2–4.3 (trasy kont), §7.1–7.7, §10 (awatary, nadużycia). (1) Profiles.php: walidacja §7.1 (etykiety przez Domain::txt; clubText przez Text::clean; nameDisplay domyślnie initial), nazwa §7.2 (regex, zakazane sekwencje, RESERVED + prefiksy, limit zmiany 30 dni), COUNTRIES (249 kodów + XK), SPORTS, suggestions (imię i nazwisko z ciała POST, maks. 3 wolne), projekcja własnego profilu (używa Accounts::profileComplete). (2) dist/profile-data.js: COUNTRIES [kod, PL, EN] wygenerowane raz scripts/gen-countries.mjs i zapisane w repo, SPORTS, validateUsername, suggestUsernames, cleanText (lustro Text::clean). (3) Members.php: signupBegin (signup_enabled albo invite przez hash_equals; $_SESSION['signup_at']), signup wg §3.6 (limity z config na ClientIp::bucket, honeypot, czas 3–7200 s mierzony przez serwer, walidacja, transakcja users+user_profiles+billing_accounts, 1062 → 409, Auth::enter); usernameCheck (zalogowany albo signup_at ≤ 2 h, limity sesja/IP); memberPassword (reserveLogin, czyści pw_reset_at); memberEmail wg §3.9 (po zatwierdzeniu class_exists Billing → pushCustomerEmail); deleteAccount wg §3.8 (hasło, releaseSession, class_exists BillingSync → sync, 409 confirmEnd, class_exists Billing → deleteCustomer z stripe_redact_pending przy błędzie, class_exists Chat → tombstoneUser, anonimizacja users, nagrobek billing_accounts, account_audit); adminList (POST, filtry, LIKE ESCAPE '!', q ≤ 100, muted przez class_exists ChatModeration::mutedIds, stan przez Access) i adminAction (create z hasłem tymczasowym i pw_reset_at, active, password tymczasowe, email, profile, delete; tylko member, inaczej 404; auth_version+1; account_audit). (4) Avatars.php + Capabilities.php wg §7.5 (tryby gd-webp/gd-jpeg/off — bez trybu strict; memory_limit z przyrostkami i -1; ścieżki avatars/xx/<public_id>/<hash>-256|64.webp; zapis atomowy 0700/0600; serve dokładnie w kolejności §4.3: dostęp → cel i v → If-None-Match → plik). (5) routes/accounts.php: signup-begin, signup, username-check (POST), profile, member-password, member-email, account-delete, avatar-upload, avatar-delete, avatar, admin-members (POST), admin-member, diagnostics (sesje, kopie, health przez class_exists, sonda przez class_exists StripeClient::probe z limitem 6/h) — tryby, limity i kształty wg §4.2–4.3. (6) jobs/accounts.php: accounts-cleanup wg §3.7 (tylko przy billing_enforce; active=1; bez wiadomości i zgłoszeń; transakcja i try/catch na konto; osierocone pliki i katalogi awatarów). (7) Tłumaczenia EN w dist/i18n/accounts-en.js. (8) Testy: tests/profiles.http.test.mjs (§11), tests/community.test.mjs + tests/php-bridge-community.php (zgodność PHP/JS łącznie z cleanText), tests/fixtures/avatars/ (WebP/JPEG/PNG, JPEG z EXIF GPS, SVG, GIF, poliglota, za duży, za mały), tests/helpers/fixture-accounts.php.
- **Kryteria akceptacji:**
  - tests/profiles.http.test.mjs zielony przez scripts/test-http.sh: wszystkie scenariusze z §11 (rejestracja z signup-begin, tokenem i limitami; username-check jako POST z 403 bez rejestracji; awatar gościa z poprawnym ETag → 404; wspólny obraz dwóch osób; LIKE z _ i %; hasło tymczasowe → mustChangePassword; e-mail; usunięcie konta z confirmEnd; sprzątanie pomija zgłaszających i nie działa bez billing_enforce).
  - tests/community.test.mjs zielony: identyczne kody krajów i sportów w PHP i JS, wspólne przypadki walidacji nazwy i cleanText, nazwy EN bez polskich liter.
  - Uogólniony test i18n zielony (wszystkie nowe komunikaty mają EN).
  - Przegląd: pliki awatarów wyłącznie w Paths::uploads w katalogu public_id z trybami 0700/0600; żadna ścieżka nie pochodzi od użytkownika; żadne dane osobowe w parametrach GET; brak trybu strict i ręcznego parsera plików.

### 12.7 `chat-backend`: Backend czatu: migracja 0003, kanały, polling z kursorem, wysyłka, ChatGuestView, moderacja, retencja, raporty hostingu

- **Fala:** 3 · **Model / wysiłek:** opus / xhigh · **Zależy od:** `backend-api`, `frontend-foundation`
- **Pliki własne:** `backend/migrations/0003_chat.php`, `backend/src/Chat.php`, `backend/src/ChatGuestView.php`, `backend/src/ChatModeration.php`, `backend/src/ChatSettings.php`, `backend/src/ChatBus.php`, `backend/routes/chat.php`, `backend/jobs/chat.php`, `dist/i18n/chat-en.js`, `tests/chat.http.test.mjs`, `tests/chat.test.mjs`, `tests/php-bridge-chat.php`, `tests/helpers/fixture-chat.php`
- **Pliki współdzielone:** brak
- **Opis:** Plan: §2.4, §5.1–5.12, §4.2 (trasy czatu), §10. Raport 02 obowiązuje z odstępstwami §5.12. (1) 0003_chat.php: dokładnie SQL z §2.4 (z chat_health); seed 4 kanałów z public_key; chat_settings z domyślnym JSON (z boost). (2) Chat.php: LOBBY, tournamentState($t,$today,$viewer) wg §5.2 (gość tylko event_date ≥ today; dzień karencji i archiwum tylko dla zalogowanych), visibleFor($viewer) wspólne dla odczytu i zapisu, viewer (jedno zapytanie users ⋈ billing_accounts), channelsPublic (bez zapisów), channelsMember (leniwy INSERT IGNORE, archiwum ≤50), feed wg §5.4 (ch ≤6, h ≤30 z knownLast, cv, e, before; jeden SELECT kanałów dla ch i h; 204 gdy nic się nie zmieniło także w h; COUNT tylko po zmianie last_message_id; LIMIT 101 → more; rev=0 → 50 + older; historia 30; st 'gone'; people tylko przy pełnym dostępie; flagi o i mod; zapis e do chat_health jednym upsertem), send wg §5.5 (kolejność kontroli 1–10 dosłownie, Text::clean multiline, cid, limity, transakcja z FOR UPDATE na kanale, cont, rev, msg_count, last_message_id, 1062 → istniejąca wiadomość, ChatBus::published), delete (widoczność → 404 'Wiadomość nie istnieje.'; original_body tylko dla moderatora albo wiadomości z otwartymi zgłoszeniami), tombstoneUser($pdo,$userId) dla §3.8. Czasy w ms z PHP, nigdy NOW(). (3) ChatGuestView.php: pola id,r,t,g,c,b lub id,r,t,g,x; formuła g z §5.4; komentarz w nagłówku z listą danych nigdy nie wysyłanych i z opisem tego, co ujawniają g i c. (4) ChatModeration.php: report (widoczność → 404, pełny dostęp, nie własne, Text::clean komentarza, idempotentne, autoHide), adminReports, adminAction (delete, restore, dismiss, mute, unmute, channel), mutedUntil($pdo,$userId) i mutedIds($pdo,$ids) dla me i admin-members, wpisy chat_mod_log. (5) ChatSettings.php: get/save z wersjonowaniem, presety §5.6, notice przez Text::clean, filtr pól klienta (on, t, ms, idle, bg, boost, safety, notice), health() z chat_health dla panelu i diagnostics. (6) ChatBus.php: published z napędem none. (7) routes/chat.php: wszystkie trasy czatu z tag 'chat'; limity §5.7. (8) jobs/chat.php: chat-retention wg §5.8 (z chat_health > 14 dni). (9) Tłumaczenia EN w dist/i18n/chat-en.js. (10) Testy: tests/chat.http.test.mjs (§11), tests/chat.test.mjs + tests/php-bridge-chat.php, tests/helpers/fixture-chat.php (wiadomości, wyciszenia, zgłoszenia).
- **Kryteria akceptacji:**
  - tests/chat.http.test.mjs zielony przez scripts/test-http.sh: 4 kanały globalne w stałej kolejności; public-chat z dokładnym zbiorem kluczy, bez Set-Cookie, z Cache-Control public, max-age=2, a surowy JSON nie zawiera e-maili, imion, nazwisk, nazw użytkowników, public_id ani wewnętrznych id; chat-feed członka z people i private, no-store; zalogowany bez pełnego dostępu dostaje projekcję gościa.
  - Polling: 204 przy braku zmian także z parametrem h; COUNT tylko po zmianie knownLast; kursor zwraca tylko nowsze zmiany; usunięcie dociera jako nagrobek; more przy >100 zmianach; zmiana cv zwraca cfg; raport e zapisuje chat_health.
  - Wysyłka: ponowione cid nie dubluje; 429 z Retry-After i retry; niekompletny profil 403; hasło tymczasowe 403; wyciszony 403; archiwum 409; wyłącznik (plik chat-off) → 503 przed bazą.
  - Zgłoszenie i usunięcie wiadomości w kanale niewidocznym → 404 z tym samym komunikatem co dla nieistniejącej; usunięcie przez autora bez zgłoszeń nie zapisuje original_body.
  - Cykl życia turnieju: draft 404; dzień po turnieju open tylko dla zalogowanych (gość: gone); później archiwum niewidoczne dla gościa i widoczne dla zalogowanych; 3 zgłoszenia różnych osób → hidden_review.
  - tests/chat.test.mjs zielony; uogólniony test i18n zielony; przegląd kodu: brak Repository::transaction/snapshot w czacie; jedyna blokada to wiersz kanału.

### 12.8 `billing-backend`: Płatności Stripe bez SDK: migracja 0004, Checkout, Portal, synchronizacja bez webhooków, webhook, CLI, atrapa Stripe

- **Fala:** 3 · **Model / wysiłek:** opus / xhigh · **Zależy od:** `backend-api`, `frontend-foundation`
- **Pliki własne:** `backend/migrations/0004_billing.php`, `backend/src/StripeClient.php`, `backend/src/StripeSignature.php`, `backend/src/Billing.php`, `backend/src/BillingSync.php`, `backend/routes/billing.php`, `backend/jobs/billing.php`, `backend/bin/stripe-setup.php`, `backend/bin/stripe-sync.php`, `dist/i18n/billing-en.js`, `tests/stubs/stripe-stub.mjs`, `tests/billing.http.test.mjs`, `tests/billing.test.mjs`, `tests/php-bridge-billing.php`, `tests/stripe-setup.test.mjs`, `tests/helpers/fixture-billing.php`
- **Pliki współdzielone:** backend/src/Access.php (backend-api): zmiana tylko przy wykazanym błędzie maszyny stanów, z testem w tests/core.test.mjs i notatką w commicie
- **Opis:** Plan: §2.5, §6.1–6.11, §3.8–3.9 (części Stripe), §4.2 (trasy płatności), §10 (płatności). Raport docs/plan/research/03-stripe.md obowiązuje z odstępstwami §6.11. (1) 0004_billing.php: dokładnie SQL z §2.5. (2) StripeClient.php wg 03 §13 z §6.3: tryb interaktywny (stripe_timeout_seconds, do 2 ponowień przy błędach sieci, 409, 429 i 5xx z poszanowaniem Stripe-Should-Retry) i tryb tła (bez ponowień, connect 3 s, total 8 s, bezpiecznik stripe_down_until w billing_kv na 600 s); HTTPS, a HTTP tylko z allow_insecure_http i pętlą zwrotną; Stripe-Version; Idempotency-Key; norm(); log bez kluczy i treści; probe($c) dla diagnostics i server-check (GET /v1/charges bez klucza, 5 s, status, czas, wersja TLS, błąd). (3) StripeSignature::verify wg 03 §7.2. (4) Billing.php: checkout wg §6.2 (waluta z kraju, 422 bez kraju, ponowne użycie sesji, Customer z Idempotency-Key, parametry 03 §5.3), confirm, portal, sync, resolvePrice, pushCustomerEmail, deleteCustomer (dla usunięcia konta), admin (list staff z plakietkami, detail z audytem, exempt/require/requireFrom/currency/resync/cancelAtPeriodEnd z billing_audit i warnLive). Przed każdym HTTP do Stripe: $ctx->releaseSession(); nigdy HTTP w transakcji. Błędy Stripe → ApiError 503 'Płatności są chwilowo niedostępne. Spróbuj ponownie później.'. (5) BillingSync.php: stateFromSubscription, mapowanie właściciela z regułą pierwszeństwa subskrypcji (§6.3), nagrobki tylko do audytu, nextSyncAt, dzierżawa 60 s + strażnik last_synced_at, handleEvent (15 typów, stripe_events), lazy (tylko z finish_request, po session_write_close, tryb tła), sync (wymuszona, dla usunięcia konta), pullEvents, reconcile (najlepsza subskrypcja na klienta), porównanie e-maila klienta, sprzątanie stripe_events > 90 dni. (6) routes/billing.php: billing-checkout, billing-confirm, billing-portal, billing-sync, admin-billing, admin-billing-action, stripe-webhook (§6.4). (7) jobs/billing.php: billing-due (5 kont, także stripe_redact_pending) i billing-events, oba needsFlush i z bezpiecznikiem. (8) bin/stripe-setup.php wg §6.9 (ukryte pole przy TTY ze stty -echo i przywróceniem echa w finally, odmowa z instrukcją read -rs bez stty, odrzucenie kluczy w argv, przypomnienie o wymianie klucza) i bin/stripe-sync.php (GET_LOCK, liczniki bez e-maili). (9) Tłumaczenia EN w dist/i18n/billing-en.js. (10) tests/stubs/stripe-stub.mjs (endpointy z wersji 1 planu + DELETE /v1/customers/{id}, POST /v1/customers/{id}, GET /v1/charges bez klucza → 401, subskrypcje z polem created i wieloma subskrypcjami na klienta; POST /__control: opłacenie sesji, status subskrypcji, jednorazowe 500, 429 ze Stripe-Should-Retry, zerwanie połączenia), tests/billing.http.test.mjs (§11), tests/billing.test.mjs + tests/php-bridge-billing.php, tests/stripe-setup.test.mjs, tests/helpers/fixture-billing.php.
- **Kryteria akceptacji:**
  - tests/billing.http.test.mjs zielony z atrapą przez scripts/test-http.sh: wszystkie scenariusze z §11, w tym pierwszeństwo subskrypcji (A anulowana + B aktywna → reconcile zostawia B/active; zdarzenie A po B → bez zmian), requireFrom → grace → none, bezpiecznik, usunięcie klienta z ponowieniem, waluta z kraju.
  - tests/billing.test.mjs i tests/stripe-setup.test.mjs zielone: podpisy (z rotacją i tolerancją ±301 s), kształty subskrypcji, next_sync_at, norm(), pierwszeństwo; stripe-setup odrzuca klucz w argv.
  - Atrapa potwierdza Stripe-Version, Idempotency-Key i Bearer rk_test_stub w każdym żądaniu.
  - matdraw_config odrzuca klucz z prefiksem niezgodnym z billing_mode i sekret webhooka bez whsec_ (test w core albo billing).
  - Przegląd kodu: brak HTTP do Stripe w transakcji i przy blokadzie sesji; logi bez klucza i treści; kwoty, waluta i id cen nigdy z klienta.

### 12.9 `pwa-frontend`: PWA w interfejsie: rejestracja workera, pasek aktualizacji, wymagana aktualizacja, karta instalacji, arkusz iOS, baner przeglądarek wbudowanych

- **Fala:** 3 · **Model / wysiłek:** sonnet / medium · **Zależy od:** `frontend-foundation`, `pwa-core`
- **Pliki własne:** `dist/pwa.js`, `dist/pwa.css`, `dist/i18n/pwa-en.js`, `dist/lang-boot.js`, `tests/pwa-ui.test.mjs`
- **Pliki współdzielone:** brak
- **Opis:** Plan: §9.1 (zamiana manifestu), §9.2, §9.4; raport 04 §1.4.3, §1.5 i 05 §13, §19.11. (1) pwa.js (statyczny, przechwytuje beforeinstallprompt od razu przy imporcie): rejestracja ./sw.js tylko w trybie API po ok. 2 s od pierwszego render (zdarzenie ready), updateViaCache:'none', reg.update() przy powrocie do karty najwyżej co godzinę; pasek aktualizacji w #pwa-root (role=status, Odśwież → SKIP_WAITING i przeładowanie tylko tej karty po controllerchange; inne karty pasywny komunikat; nigdy na #screen ani w podglądzie wydruku); obsługa zdarzenia client-outdated wg §9.4 (automatyczne SKIP_WAITING i przeładowanie bez niezapisanych formularzy, pasek blokujący z nimi, natychmiastowe przeładowanie #screen); wykrywanie standalone (html[data-standalone], appinstalled); karta instalacji z regułami i wykluczeniami §9.4 (sygnały z rejestru: login, chat:sent, chat:active; dzień turnieju z workspace), pamięć w localStorage matdraw.pwa z try/catch (30 dni, po 3 odmowach na zawsze); arkusz iOS (3 kroki, dopisek ⋯, maskotka guide dozwolona, pułapka fokusu, Esc); baner przeglądarek wbudowanych z Kopiuj link; registry.provide('pwa',{canInstall,install}); setManifestLanguage(lang) i nasłuch zdarzenia language. Szablony przez h/setHtml (§5.9). (2) lang-boot.js: strzeżona podmiana href manifestu na ./manifest.en.webmanifest dla en, bez łamania testu parytetu w vm. (3) pwa.css (prefiks pwa-, z-index 90/95, safe-area, reduced motion, print). (4) Teksty EN w dist/i18n/pwa-en.js. (5) tests/pwa-ui.test.mjs (§11).
- **Kryteria akceptacji:**
  - tests/pwa-ui.test.mjs zielony; test parytetu lang-boot w tests/i18n.test.mjs zielony; uogólniony test i18n i tests/xss-scan.test.mjs zielone.
  - Ręczna QA §11 pkt 6 lokalnie (Chrome: instalacja, aktualizacja po zmianie buildu, wymagana aktualizacja po podniesieniu min_client_api w configu testowym, offline); demo nie rejestruje workera i nie pokazuje karty.
  - Karta nigdy nie pojawia się przy pierwszej wizycie, w trakcie rejestracji/płatności, na #screen ani przy otwartym modalu (testy jednostkowe reguł).

### 12.10 `chat-frontend`: Interfejs czatu: karty, pełny ekran, polling z liderem, kompozytor, nieprzeczytane, czyszczenie tożsamości, demo

- **Fala:** 4 · **Model / wysiłek:** opus / high · **Zależy od:** `frontend-foundation`, `home-embed`, `chat-backend`, `accounts-profiles-backend`
- **Pliki własne:** `dist/chat-boot.js`, `dist/chat.js`, `dist/chat-transport.js`, `dist/chat-demo.js`, `dist/chat.css`, `dist/i18n/chat-en.js`, `tests/chat-client.test.mjs`
- **Pliki współdzielone:** brak
- **Opis:** Plan: §5.1–5.6, §5.9, §8.1–8.3, §8.8–8.10, §11; raport 05 §2.5–2.6, §3–§8, §12.3, §14, §16–§17, §19.1–19.6, §19.12 i makieta docs/plan/mockups/home-chat.html. Nie edytuj app.js. (1) chat-boot.js (statyczny, mały): registerPage chat (wszystkie role, nav global, plakietka nieprzeczytanych), strona czatu turnieju (#chat?t=), registerPublicPage chat dla gości (strona moderacji należy do chat-moderation-frontend); po zdarzeniu painted montuje [data-chat-mount=home|tournament|strip], wypełnia [data-chat-count] i [data-chat-tournament-link]; leniwy import('./chat.js'). (2) chat-transport.js wg §5.4 (lider, interwały z bezczynnością liczoną wyłącznie od interakcji, boost ograniczony cfg.boost, pauza w tle i offline, natychmiastowe odpytania, ±20%, jedno zapytanie naraz, AbortController 10 s, backoff i Retry-After, raport e, h z knownLast, 401 → purgeIdentity i tryb gościa, client-outdated → stop, cfg.on=false → zatrzymanie). Funkcje harmonogramu i lidera jako czyste eksporty do testów. (3) chat.js: magazyn (kanały, kursory, ≤300 wiadomości w DOM, szkice w sessionStorage matdraw.chat.draft.*, lokalne kursory i wyciszenia w localStorage z kluczami per publicId), purgeIdentity na logout/reset/401, render wyłącznie przez DOM API, textContent i h (§5.9), warianty (karta strony głównej, podgląd telefonu, pełny ekran, karta turnieju), grupowanie, separatory dni, dzielnik Nowe, pigułka Nowe wiadomości: n, historia, kompozytor (1–6 linii, Enter/Shift+Enter tylko przy pointer: fine, isComposing, licznik od 800, limit 1000, kolejka 1 wiadomości offline, odliczanie przy 429), stany wiadomości, CTA gościa według macierzy §6.10 z public-config, CTA niepłacącego (→ #billing), Uzupełnij profil, Zmień hasło tymczasowe (→ #profile?tab=security), baner wyciszenia, banery połączenia i wyłącznika, karta profilu (popover), zgłoszenie przez ui.modal, live region najwyżej co 15 s, PageUp/PageDown, kolejka awatarów (≤2 naraz, loading lazy, inicjały do czasu wczytania), emit chat:sent i chat:active. (4) chat-demo.js: adapter demo z tym samym interfejsem co transport (seed ok. 8 fikcyjnych wiadomości na kanał, localStorage matdraw.chat.demo.v1, zdarzenia storage; konto demo pisze od razu dzięki kompletnym profilom z me.js). (5) chat.css: prefiksy chat-/ghost-, tokeny z tokens.css, kontrasty z 05 §14, safe-area w pełnym ekranie, reduced motion, print. (6) Teksty EN w dist/i18n/chat-en.js (dopisane do wpisów z chat-backend). (7) tests/chat-client.test.mjs wg §11.
- **Kryteria akceptacji:**
  - tests/chat-client.test.mjs zielony: tokenizacja i XSS (wiadomość, notice, tytuł turnieju), grupowanie, separatory, harmonogram z bezczynnością od interakcji i ograniczonym boost (nieobsługiwana karta z wiadomością co 60 s dochodzi do ms[2] lub wolniej w 10 min), backoff, raport e, lider, purgeIdentity (po logout/reset/401 w stanie modułu nie ma people, wiadomości, kursorów ani szkiców), kolejka awatarów, stop po client-outdated, demo.
  - Uogólniony test i18n i tests/xss-scan.test.mjs zielone.
  - Przegląd: brak innerHTML poza setHtml; brak blob:; brak wywołań commit(); dane osobowe nigdy w adresie zapytania.
  - Ręczna QA (Playwright lub przeglądarka): punkty 1–3, 7–9 i 11 z §11 na buildzie PHP i w demo; pięć kart = jedno źródło zapytań; karta w tle przestaje odpytywać; wylogowanie na wspólnym urządzeniu nie zostawia tożsamości w drugiej karcie.
  - Konsola bez naruszeń CSP.

### 12.11 `chat-moderation-frontend`: Panel moderacji czatu dla Admina

- **Fala:** 4 · **Model / wysiłek:** sonnet / high · **Zależy od:** `frontend-foundation`, `chat-backend`
- **Pliki własne:** `dist/moderation-boot.js`, `dist/chat-admin.js`, `dist/moderation.css`, `dist/i18n/moderation-en.js`, `tests/chat-admin.test.mjs`
- **Pliki współdzielone:** brak
- **Opis:** Plan: §5.6, §5.9, §5.10, §8.1, §11; raport 05 §9 i §19.6. Nie edytuj chat-boot.js ani app.js. (0) moderation-boot.js (statyczny, mały; app.js importuje go od fali 1): registerPage moderation (nav admin, tylko rola admin, plakietka otwartych zgłoszeń odświeżana po ready i co 5 min, gdy admin ma otwartą kartę), render przez leniwy import('./chat-admin.js'). (1) chat-admin.js: kolejka zgłoszeń z admin-chat-reports (grupowanie po wiadomości, liczby powodów, kontekst ?context=), akcje admin-chat-action (usuń z notatką, przywróć, odrzuć zgłoszenia, wycisz 1h/24h/7d/na stałe z podglądem komunikatu, cofnij wyciszenie, status kanału), lista wyciszonych, ustawienia (przełącznik czatu, preset tempa, komunikat notice ≤300) oraz licznik „Odpowiedzi hostingu w ostatniej godzinie” z progiem orientacyjnym z DEPLOY-PL.md. Wszystkie treści (wiadomość, original_body, komentarze, e-maile, nazwy) wyłącznie jako czysty tekst, bez linków; szablony przez h/setHtml. (2) moderation.css (prefiks mod-, tokeny, print ukrywa). (3) Teksty EN w dist/i18n/moderation-en.js. (4) tests/chat-admin.test.mjs (§11).
- **Kryteria akceptacji:**
  - tests/chat-admin.test.mjs, uogólniony test i18n i tests/xss-scan.test.mjs zielone.
  - Ręczna QA §11 pkt 5 (część moderacji) na buildzie PHP: zgłoszenie, ukrycie, usunięcie, wyciszenie, ustawienia tempa i licznik odpowiedzi hostingu; komentarz z HTML wyświetla się jako tekst.

### 12.12 `account-frontend`: Interfejs kont: rejestracja 3-krokowa, profil i awatar, e-mail i hasło, plan i powroty Stripe, subskrypcja, usunięcie konta

- **Fala:** 4 · **Model / wysiłek:** opus / high · **Zależy od:** `frontend-foundation`, `home-embed`, `accounts-profiles-backend`, `billing-backend`
- **Pliki własne:** `dist/account-boot.js`, `dist/account-flow.js`, `dist/avatar-crop.js`, `dist/account.css`, `dist/promo.js`, `dist/i18n/accounts-en.js`, `dist/i18n/billing-en.js`, `tests/account-ui.test.mjs`
- **Pliki współdzielone:** brak
- **Opis:** Plan: §3.1–3.2, §3.6, §3.8–3.10, §6.1–6.2, §6.5–6.6, §6.10, §7.1–7.5, §8.3 (pkt 12), §8.8–8.10; raport 05 §9–§12, §19.7–§19.10 i makieta. Nie edytuj app.js. (1) account-boot.js (statyczny, mały): registerPublicPage signup i registerPage signup/profile (zakładki Profil | Subskrypcja | Bezpieczeństwo; Bezpieczeństwo: personel przez ui.commit('account.password',…), członek przez member-password i member-email; Zainstaluj aplikację przez registry.use('pwa'); Usuń konto dla członka)/billing (role admin, editor, club, member) — strona members należy do members-frontend; ustawienie ACCESS.kind w czasie działania z public-config wg macierzy §6.10; akcje access-cta i my-account; obsługa ?billing= (sessionStorage, replaceState, confirm po zalogowaniu, ponawianie przy processing); wypełnia [data-account-mount=join] i [data-account-mount=login-help] (panel Nie pamiętasz hasła? z adresem support i procedurą §3.10); knownDevice po login; payment-required → #billing; mustChangePassword → #profile?tab=security i blokada innych stron do czasu zmiany; baner personelu „Od {date} konto wymaga płatności” (state free z until w ciągu 14 dni) i „Karencja do {date}” (grace). (2) account-flow.js: rejestracja w 3 krokach wg 05 §10 (krok 1 woła signup-begin z invite z adresu; krok 2 profil z username-check POST po 400 ms bez pisania, propozycjami z imienia i nazwiska w ciele, domyślnym krajem, sportami, opcjonalnym awatarem, niezaznaczonym „Pokazuj członkom moje pełne nazwisko”; krok 3 plan pomijany przy wyłączonych płatnościach; puste sloty zgód), profil, zmiana e-maila (§3.9) i hasła, plan (waluta z kraju, prośba o kraj, gdy go brak; billing-checkout bez waluty; kontrola origin https://checkout.stripe.com; location.assign), ekrany powrotu (05 §11.2), zakładka Subskrypcja (stany Access z grace, portal z kontrolą origin https://billing.stripe.com, billing-sync po powrocie), usunięcie konta z potwierdzeniem hasłem i drugim potwierdzeniem przy confirmEnd. Formularze z prefiksem acct- (§8.3 pkt 8). (3) avatar-crop.js wg §7.5 (bez URL.createObjectURL). (4) promo.js: ACCESS kind login/paid/free z tekstami 05, ustawiany w czasie działania; tłumaczenia EN. (5) account.css (prefiksy acct-). (6) Teksty EN w dist/i18n/accounts-en.js i billing-en.js. (7) Demo wg §8.8. (8) tests/account-ui.test.mjs (§11).
- **Kryteria akceptacji:**
  - tests/account-ui.test.mjs, uogólniony test i18n (promo, wszystkie T()) i tests/xss-scan.test.mjs zielone.
  - Ręczna QA §11 pkt 1 (zmiana języka na #signup w kroku 2), 3, 4 i 5 (hasło tymczasowe, baner personelu) na buildzie PHP z atrapą Stripe oraz w demo.
  - Przegląd: nawigacja do Stripe tylko po sprawdzeniu origin; brak blob: i URL.createObjectURL; żadne kwoty, waluty ani id cen nie są wysyłane przez klienta; nazwa i nazwisko do propozycji tylko w ciele POST.

### 12.13 `members-frontend`: Panel Admina „Członkowie” i plakietki planów w kontach personelu

- **Fala:** 4 · **Model / wysiłek:** sonnet / high · **Zależy od:** `frontend-foundation`, `accounts-profiles-backend`, `billing-backend`
- **Pliki własne:** `dist/members-boot.js`, `dist/admin-members.js`, `dist/members.css`, `dist/i18n/members-en.js`, `tests/members-ui.test.mjs`
- **Pliki współdzielone:** brak
- **Opis:** Plan: §3.2, §3.4 (konflikt e-maila), §3.9–3.10, §4.3 (admin-members, admin-member), §6.7, §8.3 pkt 12. Nie edytuj app.js ani account-boot.js. (0) members-boot.js (statyczny, mały; app.js importuje go od fali 1): registerPage members (nav admin, tylko rola admin), render przez leniwy import('./admin-members.js'); dla admina po zdarzeniach painted i saved ładuje leniwie ten sam moduł do zaślepek w panelu kont personelu. (1) admin-members.js: lista z admin-members (POST: filtry, wyszukiwanie, paginacja), akcje admin-member: nowe darmowe konto (hasło tymczasowe pokazane raz z przyciskiem kopiowania), blokada, hasło tymczasowe z listą kontrolną §3.10 (adres do odpowiedzi kopiowany z panelu), zmiana e-maila, poprawa profilu, usunięcie; plakietka i link do moderacji przy wyciszeniu. (2) Po painted wypełnia [data-billing-badge] (admin-billing?list=staff) i [data-account-billing] (przełącznik Darmowe konto domyślnie wyłączony dla nowego konta, powód, do kiedy, ostrzeżenie warnLive z opcją zatrzymania subskrypcji, requireFrom z datą i informacją o karencji, waluta, stan, ostatnia synchronizacja, Synchronizuj teraz, Otwórz w Stripe), zapisywane przez admin-billing-action po zdarzeniu saved z result.id. (3) Akcja zbiorcza „Wymagaj płatności od…” dla kont grandfathered (data ≥ dziś + 14 dni, podsumowanie liczby kont). (4) Wszystkie e-maile i nazwy jako tekst, szablony przez h/setHtml. (5) members.css, dist/i18n/members-en.js. (6) tests/members-ui.test.mjs (stan przełącznika dla nowego i istniejącego konta, walidacja daty requireFrom, budowa żądań bez danych osobowych w adresie).
- **Kryteria akceptacji:**
  - tests/members-ui.test.mjs, uogólniony test i18n i tests/xss-scan.test.mjs zielone.
  - Ręczna QA §11 pkt 5 (konta i płatności) na buildzie PHP z atrapą Stripe: nowe konto personelu bez Darmowe → podgląd i 402 po włączeniu wymuszania; requireFrom → baner; hasło tymczasowe członka → wymuszona zmiana.

### 12.14 `deploy-infra`: Wdrożenie i CI: migracje z kopiami, strażnik rollbacku, weryfikacja odporna na pliki-flagi, .htaccess, sonda obciążenia, DEPLOY-PL.md

- **Fala:** 4 · **Model / wysiłek:** opus / high · **Zależy od:** `backend-data`, `backend-api`, `pwa-core`, `accounts-profiles-backend`, `chat-backend`, `billing-backend`
- **Pliki własne:** `scripts/deploy-remote.sh`, `scripts/deploy-verify.sh`, `scripts/poll-probe.sh`, `.github/workflows/deploy.yml`, `backend/public/.htaccess`, `package.json`, `DEPLOY-PL.md`, `tests/deploy/deploy-script-test.sh`
- **Pliki współdzielone:** brak
- **Opis:** Plan: §2.8, §9.5–9.11, raport 04 PART 2. (1) scripts/deploy-remote.sh: check (dotychczasowe kontrole + mkdir shared/uploads, shared/sessions, backups, logs z trybem 700, df); migrate <release> wg §9.6 (status przez MATDRAW_CONFIG i /usr/local/php83/bin/php z fallbackiem; empty → wskazówka; DESTRUCTIVE>0 → błąd; dbbackup przy oczekujących migracjach albo braku kopii młodszej niż 24 h, plik opcji 600, wykrywanie flag, fallback bin/dump.php, akceptacja po gzip -t, rozmiarze i znaczniku; backup-files przy braku kopii młodszej niż 7 dni; ALLOW_NO_BACKUP=1 jako jedyny wyjątek; log; komunikaty po polsku); backup-db; backup-files; cleanup z retencją 30 dni i zachowaniem najnowszej kopii; rollback ze strażnikiem floor (§2.8, FORCE_ROLLBACK=1). (2) scripts/deploy-verify.sh: dotychczasowe kontrole i semantyka ROLLBACK oraz 429 jako env_error, plus kontrole z §9.8 (pliki-flagi maintenance → ostrzeżenie i ROLLBACK=false; chat-off → akceptacja 503 chat_off; ostrzeżenie o turnieju dziś; ostrzeżenie o kopii starszej niż 7 dni). (3) .github/workflows/deploy.yml wg §9.9 (globy testów, atrapa Stripe gdy istnieje, http-compat z wersją bazową event.before/merge-base/baza PR i porównaniem haszy danych zamiast CHECKSUM TABLE, deploy-script-test, build, krok Migracje bazy, server-check z sondą Stripe przez php83, uprawnieniami SHOW GRANTS i wiekiem kopii). (4) backend/public/.htaccess wg §9.5; blok mod_rewrite i nagłówki bezpieczeństwa oraz CSP bez zmian. (5) scripts/poll-probe.sh <url> <równoległość> <sekundy>: pętle curl co 2,5 s na ?route=public-chat-channels i ?route=public-chat, zliczanie kodów, podsumowanie i kod wyjścia 1 przy jakimkolwiek 429/503/508; bez ciasteczek. (6) package.json: check wszystkich dist/*.js; skrypt test:http → scripts/test-http.sh. (7) DEPLOY-PL.md wg §9.10 prostym językiem dla nieprogramisty. (8) tests/deploy/deploy-script-test.sh: sztuczne drzewo serwera i scenariusze z §9.9.
- **Kryteria akceptacji:**
  - bash -n wszystkich skryptów; tests/deploy/deploy-script-test.sh zielony lokalnie na MariaDB: pierwsze migrate tworzy kopię, drugie nic nie zmienia, kopia odtwarza się z równym haszem danych, błędna migracja zatrzymuje przed activate, floor blokuje rollback przy istniejącym członku, cleanup zostawia najnowszą kopię, deploy-verify z maintenance → ROLLBACK=false, z chat-off akceptuje 503.
  - deploy.yml parsuje się poprawnie; testy wybierane globami; http-compat używa event.before/merge-base/bazy PR i porównania danych.
  - Diff .htaccess pokazuje wyłącznie dopisane bloki; blok RewriteEngine i nagłówki bezpieczeństwa bez zmian.
  - poll-probe.sh działa lokalnie przeciw php -S (scratchpad) i zgłasza kody statusu.
  - DEPLOY-PL.md po polsku opisuje wszystkie kroki §9.11, przywracanie bazy, kiedy wdrażać, limity w dniu zawodów, odzyskiwanie dostępu do konta i konflikt adresu e-mail.

### 12.15 `integration-qa`: Integracja, test między plasterkami, pełne testy, przegląd bezpieczeństwa, ręczna QA, zrzuty manifestu i dokumentacja

- **Fala:** 5 · **Model / wysiłek:** opus / high · **Zależy od:** wszystkie pozostałe plasterki
- **Pliki własne:** `README.md`, `INSTALL-PL.md`, `HANDOFF.md`, `VALIDATION.md`, `dist/screenshots/`, `tests/integration.http.test.mjs`
- **Pliki współdzielone:** dist/manifest.webmanifest i dist/manifest.en.webmanifest: wyłącznie dopisanie pola screenshots; Dowolny plik: minimalne poprawki integracyjne wykryte testami lub przeglądem, każda z testem lub uzasadnieniem w commicie; bez zmian architektury
- **Opis:** Plan: §10, §11, §9.10, §13, §14, Załącznik B. (1) Scalenie wszystkich gałęzi plasterków do gałęzi integracyjnej; rozwiązanie konfliktów zgodnie z własnością plików; uruchomienie: node --check wszystkich dist/*.js i scripts/*.mjs, php -l backend i tests, node --test wszystkich testów jednostkowych, PHP_BIN=… tests/php.test.mjs, scripts/test-http.sh ze wszystkimi plikami HTTP (http.test.mjs pierwszy) na MariaDB, build PHP i kontrole jak w jobie build. (2) tests/integration.http.test.mjs (§11): kontrakty między plasterkami (tombstoneUser, confirm → chat-send, mutedIds/mutedUntil, sonda Stripe w diagnostics). (3) Lista kontrolna §10 punkt po punkcie z przeglądem kodu (grep: innerHTML poza setHtml, POST bez CSRF, HTTP do Stripe w transakcji, trasy admin bez kontroli roli, SQL bez przygotowanych instrukcji, ścieżki plików od użytkownika, dane osobowe w parametrach GET, error_log z komunikatem PDOException, id formularzy profile-form/password-form poza app.js); poprawki. (4) Ręczna QA §11 pkt 1–11 w Playwright lub przeglądarce na buildzie PHP z atrapą Stripe i w demo; zrzuty do scratchpada; poprawki. (5) Zrzuty manifestu: dist/screenshots/wide-chat.webp, wide-bracket.webp (1280×800), narrow-chat.webp, narrow-tournaments.webp (1080×1920), fikcyjne dane, ≤250 KB każdy; screenshots w obu manifestach; tests/pwa-build.test.mjs dalej zielony. (6) Dokumentacja: README.md, INSTALL-PL.md (wymagania gd/curl/openssl/intl/exif, migracje w instalatorze, nowe klucze config, płatne konta i darmowe konta Admina), HANDOFF.md (stan, kroki właściciela §9.11, pytania §13 z przyjętymi odpowiedziami i bramkami startu, procedura resetu hasła, co ujawniają g i c, etapy 2/3), VALIDATION.md. (7) Końcowe podsumowanie dla właściciela po polsku w odpowiedzi (nie jako plik). (8) Dopiero po zielonym wyniku i potwierdzeniu P1: przygotowanie jednego scalenia do main (decyzję o pushu podejmuje właściciel).
- **Kryteria akceptacji:**
  - Wszystkie testy zielone: jednostkowe, PHP, wszystkie HTTP przez scripts/test-http.sh (łącznie z tests/integration.http.test.mjs), build z kontrolami.
  - Każdy punkt §10 odhaczony z dowodem (test lub miejsce w kodzie).
  - Ręczna QA §11 przeprowadzona; znalezione błędy poprawione lub opisane jako znane ograniczenia w HANDOFF.md.
  - Manifesty ze zrzutami przechodzą tests/pwa-build.test.mjs; dokumentacja zaktualizowana po polsku.

---

## 13. Pytania otwarte do właściciela

**Żadne z pytań nie blokuje implementacji**: plan przyjmuje rekomendowaną odpowiedź domyślną, a kod obsługuje obie możliwości. Pytania oznaczone **bramka startu** muszą mieć odpowiedź właściciela przed `billing_enforce=true` i `signup_enabled=true` (§6.10, krok 4).

| # | Pytanie | Przyjęte domyślnie |
|---|---|---|
| P1 | Które repozytorium GitHub ma środowisko `production` z sekretami SSH: `eMCe71/MatDraw` (obecny remote) czy `Meducase/MatDraw` (dokumentacja)? | Prace w `eMCe71/MatDraw` na gałęzi integracyjnej; jedno scalenie do `main` dopiero po `integration-qa` i potwierdzeniu (D18). |
| P2 | **Bramka startu.** Czy obecne konta klubów i sędziów (admin/editor/club) mają płacić, a jeśli tak, od kiedy? Czy nowe konta personelu mają być domyślnie płatne (dosłownie według wymagania 4)? | Obecne konta darmowe przejściowo, do decyzji właściciela; przełączenie narzędziem „Wymagaj płatności od…” z banerem 14 dni wcześniej i 7-dniową karencją. Nowe konta personelu płatne, chyba że Admin zaznaczy „Darmowe konto”. |
| P3 | **Bramka startu.** Jak długo czat turnieju przyjmuje wiadomości i kto czyta dzień po turnieju oraz archiwum? (To zawęża „czytać może każdy” z wymagania 3.) | Do 23:59 dnia po turnieju; gość widzi czat turnieju tak długo jak podgląd turnieju (do dnia zawodów włącznie); dzień po i archiwum tylko dla zalogowanych. |
| P4 | Progi moderacji? | Automatyczne ukrycie po 3 zgłoszeniach różnych osób; oryginały usuniętych przez moderatora albo zgłoszonych 30 dni; retencja wiadomości 365 dni. |
| P5 | Przypięta wiadomość organizatora? | v1.1. |
| P6 | Kraj autora: font z flagami (ok. 80 KB, wymóg uznania autorstwa CC-BY) czy chip z kodem? | Chip z kodem (`PL`). |
| P7 | Domyślny sposób pokazywania nazwiska członkom? | **Imię i inicjał nazwiska** („Marta K.”); pełne nazwisko tylko po zaznaczeniu przez członka (privacy-by-design, wielu niepełnoletnich). |
| P8 | **Bramka startu.** Wysyłka e-maili (weryfikacja, reset hasła)? | v1 bez e-maili; reset przez Administratora według procedury §3.10; etap 2: dostawca SMTP z SPF/DKIM. |
| P9 | Usuwać nieopłacone, porzucone konta? | Tak, po 30 dniach bez logowania, bez historii płatności, bez wiadomości i zgłoszeń; tylko przy `billing_enforce=true`. |
| P10 | Czy goście mogą widzieć zdjęcia profilowe? | Nie. |
| P11 | Promocja członka do roli przedstawiciela klubu? | Nie w v1; osobne konto od Admina. |
| P12 | Anonimowe liczniki instalacji PWA na serwerze? | Nie w v1. |
| P13 | Stripe Link i BLIK cykliczny? | Link wyłączony; o BLIK cykliczny prosimy Stripe po starcie. |
| P14 | Karencja po nieudanym odnowieniu i po końcu darmowego okresu? | 7 dni w obu przypadkach; Smart Retries, po ostatniej próbie anulowanie. |
| P15 | Długość sesji członka? | 14 dni bezczynności, 30 dni maksymalnie; personel bez zmian. |
| P16 | Czy rejestracja może ruszyć przed wymuszeniem płatności (darmowa beta)? | Nie: `signup_enabled` razem z `billing_enforce` po testach na żywo; testy właściciela przez token zaproszeń (`signup_invite_token`). |
| P17 | Czy niepłacący zalogowani czytają archiwa turniejów (z ukrytymi autorami)? | Tak. |
| P18 | Kolejne kanały globalne (np. Judo)? | Tylko 4 kanały właściciela; nowe dodaje migracja. |
| P19 | **Bramka startu.** Prezentacja ceny (brutto, VAT, OSS, KSeF)? | Pokazujemy „8,99 zł / mies.” i „$2.99 / month” jako cenę końcową; podatki i dokumenty ustali sesja prawna **przed** `billing_enforce=true`. |
| P20 | Czy waluta ma wynikać z kraju w profilu (PL → 8,99 zł, inne → 2,99 USD), bez wyboru przez użytkownika? | Tak; Admin może zmienić walutę konta bez trwającej subskrypcji. |
| P21 | **Bramka startu.** Jaki adres pomocy pokazujemy przy „Nie pamiętasz hasła?” i kto go obsługuje? | Adres w domenie MatBravo (np. `pomoc@matbravo.com`) obsługiwany przez Administratora; bez niego rejestracja się nie włączy. |
| P22 | Usunięcie konta przy trwającej subskrypcji: natychmiastowe zakończenie bez zwrotu za bieżący okres? | Tak, po wyraźnym potwierdzeniu; zasady zwrotów ustali sesja prawna. |

---

## 14. Rozstrzygnięcia po przeglądzie

Plan wersji 1 przejrzało trzech recenzentów: **bezpieczeństwo i prywatność** (S), **hosting i operacje** (H) oraz **regresje i kompletność** (R). Zgłosili 30 uwag poważnych (major) i 35 drobnych (minor); blokujących nie było. Każdą uwagę sprawdziłem w kodzie przed przyjęciem:
- stała bcrypt w logowaniu wobec Argon2id w `Domain::password`;
- `await Client.logout();workspace=null;closeModal();renderLogin();` w `app.js`;
- `rerenderLanguage` (l.420–425), przekierowanie `#guest` (l.82), strażnik `fetchGuest` (l.222) i `publicAction` (l.328) w `app.js`;
- limity `reserveLogin` (40/8 na 15 min) i `error_log` z komunikatem wyjątku w `index.php`;
- gałąź `error` (rollback) w `deploy-verify.sh` przy 503;
- zbieranie komunikatów `Error` tylko z `client.js` w teście i18n;
- `matdraw_config()` bez wartości domyślnych;
- zachowanie `session_start` z ważnym ciasteczkiem (lokalnie, PHP 8.3.6);
- poprawiony SQL 0002/0003 i `LIKE … ESCAPE '!'` (lokalnie, MariaDB 10.11).

Wszystkie uwagi okazały się trafne. Żadnej nie odrzuciłem w całości, cztery przyjąłem częściowo (z uzasadnieniem w tabeli).

### 14.1 Uwagi poważne

| # | Uwaga | Decyzja | Co się zmieniło | Gdzie |
|---|---|---|---|---|
| S1 | Wyliczanie kont przez czas logowania (bcrypt kontra Argon2id) | przyjęta | `Accounts::dummyHash()` z tym samym algorytmem i parametrami co `Domain::password`; weryfikacja zawsze; poprawione twierdzenie „niemożliwe” na „ograniczone”. Test HTTP median ma szerszy przedział (0,5–2,0), bo 30% byłoby kapryśne w CI; główną ochroną jest deterministyczny test `password_get_info`. | §3.3 pkt 1, §3.4, §10, §11 |
| S2 | `username-check` publiczny i z nazwiskami w GET | przyjęta | POST w trybie `session` z CSRF, tylko dla zalogowanych albo po `signup-begin` (2 h); imię i nazwisko w ciele; limity 30/10 min na sesję i 300/10 min na IP; opisane ryzyko szczątkowe (pseudonimy są i tak widoczne dla członków). | §3.4, §3.6, §4.2, §4.3, §7.2 |
| S3 | Stan klienta po wylogowaniu na wspólnym urządzeniu | przyjęta | Wylogowanie: `emit('logout')`, `purgeSession()` (szkice i klucze sesji), `reset` na `BroadcastChannel('matbravo-session')` i `location.replace`; `purgeIdentity()` w czacie także przy 401; klucze lokalne per `publicId`; test w `chat-client.test.mjs` i punkt QA 9. | §8.3 pkt 8 i 16, §8.5, §5.4, §11, §12.2, §12.10 |
| S4, H11 | Klucz `sk_` w linii poleceń (historia powłoki) | przyjęta | `stripe-setup.php` pyta o klucz z ukrytym echem (`stty -echo`), bez `stty` podaje bezpieczną formę `read -rs`, odrzuca klucze w `argv` (test); właściciel wymienia klucz `sk_` po konfiguracji. | §6.9, §9.11 kroki 6 i 9, §10, §12.8 |
| S5 | Stara subskrypcja nadpisuje nową w jedynym wierszu `billing_accounts` | przyjęta | Reguła pierwszeństwa (nieterminalna wygrywa z terminalną, potem nowsze `created`), `reconcile` wybiera najlepszą na klienta, testy A/B. | §6.3, §11, §12.8 |
| S6 | Pełne nazwisko domyślnie | przyjęta | `name_display DEFAULT 'initial'`; niezaznaczone pole „Pokazuj członkom moje pełne nazwisko”; P7 zmienione. | §2.3, §7.1, §7.6, §7.7, §13 |
| H1 | `Jobs::maybe` trzyma blokadę sesji podczas zadań | przyjęta | `session_write_close()` jako pierwszy krok `Jobs::maybe` i `BillingSync::lazy`; test z `job_test_sleep_ms` (< 1 s). | §3.7, §4.1, §6.3, §10, §11 |
| H2 | `Auth::peek` z `use_strict_mode` tworzy pliki i wysyła `Set-Cookie` | przyjęta | Sprawdzenie istnienia pliku przed `session_start`, `gc_probability=0`, `session_cache_limiter('')`, `header_remove('Set-Cookie')`; testy z ważnym, wygasłym i zmyślonym ciasteczkiem. | §3.5, §4.1, §10, §11, §12.3 |
| H3 | Pliki sesji anonimowych przez 30 dni (i-węzły) | przyjęta | `housekeeping` według rodzaju: anonimowe 3 h, personel 12 h, wszystkie 14 dni; porcje `DirectoryIterator`; `session_save_path` i GC tylko przy `save_handler=files`; `diagnostics`/`server-check` pokazują magazyn i liczbę plików. | §3.5, §3.7, §4.3, §9.8 |
| H4 | Parametr `h` wyklucza 204 i mnoży `COUNT` | przyjęta | `h=<id>:<lastReadId>:<knownLast>`, jeden `SELECT` kanałów dla `ch` i `h`, `COUNT` tylko po zmianie, 204 także z `h`; poprawione szacunki kosztu (2–4 zapytania). | §5.4, §2.7, §0 (D1), §0.1 |
| H5 | Nieobsługiwana karta odpytuje co 2,5 s w ruchliwym kanale | przyjęta | Bezczynność tylko od interakcji; przyspieszenie po wiadomości ograniczone `cfg.boost` (300 s) i nigdy poniżej `ms[1]` bez interakcji; test 10-minutowy. | §5.4, §2.4, §11 |
| H6 | Brak wykrywania ograniczeń hostingu | przyjęta częściowo | Raport `e` od klienta, tabela `chat_health` bez IP, licznik w panelu i `diagnostics`, `poll-probe.sh` z zewnątrz. **Odrzucona** automatyczna zmiana presetu: licznik zasilają anonimowi klienci, więc dałoby się nim spowolnić czat wszystkim; decyduje Admin z progiem w DEPLOY-PL.md. | §5.10, §2.4, §5.4, §9.11 krok 12, §12.14 |
| H7 | Pliki-flagi powodują rollback dobrego wydania | przyjęta | `deploy-verify` na początku sprawdza `maintenance` (ostrzeżenie, `ROLLBACK=false`) i `chat-off` (akceptuje 503 `chat_off`); procedura przywracania usuwa plik przed wdrożeniem; testy w `deploy-script-test`. | §9.8, §9.6, §9.9, §4.1 |
| H8 | Brak regularnych kopii po starcie | przyjęta | Kopia bazy przy każdym wdrożeniu, gdy najnowsza jest starsza niż 24 h, kopia plików co 7 dni; `dump.php --auto` do crona; wiek kopii w `diagnostics`, `server-check` i `deploy-verify`; pytanie o kopie AfterMarket; ryzyko w Załączniku B. | §9.6, §9.8, §9.11 krok 5, Zał. B |
| H9 | `http-compat`: `CHECKSUM TABLE` i zła wersja bazowa | przyjęta | Porównanie haszy danych (`SELECT` z jawnymi kolumnami po kluczu); baza `github.event.before`, przy nowej gałęzi `merge-base`, przy PR baza PR. | §9.9, §12.14 |
| H10 | Fala 1 w `main` wdrożyłaby kod bez migracji | przyjęta | Zasada jednego scalenia do `main` po `integration-qa` (D18, §12); SQLSTATE 42S02/42S22 → 503 zamiast 500. Zamiast zapytania o `schema_version` w każdym żądaniu (koszt przy każdym odpytaniu czatu) mapujemy sam błąd. Krok migracji zostaje w `deploy-infra`. | §0 (D18), §4.1, §12 |
| H12 | Limity po IP wobec NAT w hali | przyjęta | Rejestracja 30/h i 100/dobę na IP (/64), globalnie 200/h; logowanie 100/15 min na IP (para IP+e-mail bez zmian: 8); `username-check` 300/10 min na IP i 30 na sesję; wszystko w config i w DEPLOY-PL.md. | §3.3, §3.4, §3.6, Zał. A |
| R1 | Brak zmiany e-maila członka | przyjęta | `member-email` i `admin-member email`, `auth_version+1`, aktualizacja klienta Stripe po zatwierdzeniu i przy każdej synchronizacji. | §3.9, §4.2, §4.3, §6.3 |
| R2 | Reset hasła „na prośbę” bez procedury | przyjęta | `support_email` jako bramka startu, procedura (prośba z adresu konta, odpowiedź tylko na adres z panelu), hasło tymczasowe z wymuszoną zmianą (`pw_reset_at`), `account_audit`; P21. | §3.10, §2.3, §4.3, §6.8, §13 |
| R3 | Usunięcie konta a subskrypcja i Stripe | przyjęta | Wymuszona synchronizacja, potwierdzenie `confirmEnd` zamiast twardego 409, usunięcie klienta Stripe z ponawianiem, wiersz-nagrobek bez danych osobowych; P22. | §3.8, §2.3, §6.3, §11 |
| R4 | Wymaganie 4 („konta są płatne”) rozstrzygnięte po cichu | przyjęta częściowo | Nowe konta personelu domyślnie płatne; narzędzie `requireFrom` z banerem i karencją `grace`; P2 jako **bramka startu**. Nie jako bramka przed napisaniem 0002, bo migracja i kod obsługują obie odpowiedzi (wpis `grandfathered` można przełączyć narzędziem). | §0 (D8), §3.1, §3.2, §6.5, §6.7, §13 |
| R5 | Brak macierzy stanów wdrożenia | przyjęta | Macierz przełączników w §6.10, CTA i `ACCESS.kind` z `public-config` w czasie działania, walidacja kombinacji w config, sprzątanie porzuconych kont tylko przy `billing_enforce=true`, okno testów przez token zaproszeń. | §6.10, §6.8, §3.6, §3.7, §8.9 |
| R6 | Zmiana języka na nowych stronach publicznych | przyjęta | Hak 13 w `rerenderLanguage`; punkt QA 1 dla `#signup` i `#chat` gościa. | §8.3, §11, §12.2 |
| R7 | Podgląd turnieju dla członka i `#screen` | przyjęta | Haki 14–15 (render, `fetchGuest`, drabinka kliknięć, `#screen` → `#chat`); szablony w `home-embed`. | §8.3, §8.9, §11 (QA 10), §12.2, §12.5 |
| R8 | Rozjazd wersji przez service worker | przyjęta | Nagłówek `X-MatBravo-Client`, `min_client_api`, 409 `client_outdated`, automatyczne zastosowanie aktualizacji bez niezapisanych danych, natychmiast na `#screen`. | §0 (D19), §4.1, §8.4, §9.2, §9.4, §12.9 |
| R9 | Testy HTTP zablokują się na limitach logowania | przyjęta | Zadanie fixture `reset-limits` w `before()` każdego pliku. | §11, §12 (zasady), §12.1 |
| R10 | Zależności plasterków i testowalność w fali | przyjęta | `home-embed` w fali 2 (przed czatem i kontami), `deploy-infra` w fali 4 z globami testów, własne pliki `fixture-*.php` na plasterek; strony fali 4 mają własne moduły rozruchowe (`moderation-boot.js`, `members-boot.js`), więc żaden plasterek tej fali nie czeka na inny. | §12, §8.1, §9.9, §11 |
| R11 | Logika powielona między plasterkami | przyjęta | `Accounts::profileComplete` w `backend-api`; `Chat::tombstoneUser`, `ChatModeration::mutedUntil`/`mutedIds`, `StripeClient::probe` przez `class_exists`; test między plasterkami w `integration-qa`. | §3.1, §3.8, §4.3, §5.5, §5.6, §12 |
| R12 | Za duże plasterki na ścieżce krytycznej | przyjęta częściowo | `backend-foundation` podzielony na `backend-data` (fala 1) i `backend-api` (fala 2) **kolejno, nie równolegle**, bo oba dotykałyby `index.php` i `Auth.php`; `backend-data` sam przechodzi swoje testy (mapowanie 1062 w `Repository`). Z czatu wydzielony `chat-moderation-frontend`, a z kont `members-frontend`. Ścieżka krytyczna: backend-data → backend-api → chat-backend → chat-frontend → integration-qa. | §12 |

### 14.2 Uwagi drobne

| Uwaga | Decyzja | Gdzie |
|---|---|---|
| Rejestracja w oknie testów przy `billing_enforce=false` | przyjęta: token zaproszeń, testy przy `billing_enforce=true` w trybie testowym | §3.6, §6.10, §9.11 |
| Wariant `g` a powiązywanie wypowiedzi (S i R) | przyjęta: wzór bez zmian, poprawione twierdzenia, opis w nagłówku `ChatGuestView` | §0 (D6), §5.4, §10 |
| Kolejność kontroli w trasie `avatar` | przyjęta: dostęp i cel przed `304`, test z poprawnym `ETag` | §4.3, §11 |
| Tryb `strict` bez GD i `memory_limit` | przyjęta: tryb usunięty, parsowanie przyrostków i `-1` | §7.5, Zał. B |
| Wspólne pliki awatarów dwóch osób | przyjęta: katalog `public_id` w ścieżce | §7.5, §11 |
| Znaki `\p{Cf}` w klubie i innych tekstach | przyjęta: wspólne `Text::clean` i `cleanText` | §5.5, §7.1, §11 |
| XSS w nowych napisach (notice, zgłoszenia, tytuły) | przyjęta: szablon `h`, `setHtml`, `tests/xss-scan.test.mjs` | §5.9, §8.2, §11 |
| Dane osobowe w logach i adresach | przyjęta: `Routes::logThrowable` bez komunikatów PDO, `admin-members` i `username-check` jako POST | §4.1, §4.3 |
| `LIKE` bez uciekania | przyjęta: `ESCAPE '!'`, limit 100 znaków, test | §4.3, §10 |
| Sondowanie ukrytych treści przez zapisy | przyjęta: `visibleFor` w `chat-send`, `chat-report`, `chat-delete`, wspólne 404 | §5.5, §5.6, §11 |
| Kopia treści przy usunięciu przez autora, Stripe po usunięciu konta, wiek kopii | przyjęta: kopia tylko przy moderacji albo zgłoszeniach; usunięcie klienta Stripe i nagrobek; retencja kopii 30 dni | §5.5, §3.8, §9.6 |
| `peek` i pliki sesji (S) | przyjęta razem z H2 i H3 | §3.5 |
| Personel bez zwolnienia a `bootstrap` | przyjęta: świadomie podgląd zostaje, 402 tylko przy zmianach (poza `account.password`), test | §3.3, §6.6 |
| Zajęcie cudzego adresu e-mail | przyjęta częściowo: procedura Admina i narzędzia (`email`, `delete`). **Odrzucone** niewysyłanie e-maila do Stripe: płacący musi dostawać paragony i wezwania, a zbieranie adresu przez Checkout przy istniejącym kliencie jest niezweryfikowane | §3.4, §9.10 |
| Wywołania Stripe po odpowiedzi | przyjęta: bez ponowień, 3 s / 8 s, bezpiecznik, dzierżawa 60 s, pomijanie bez `finish_request` | §6.3 |
| Sonda Stripe z PHP strony | przyjęta: `diagnostics?probe=stripe` i `server-check`, warunek kroku 2 | §4.3, §6.10, §9.8 |
| Wylogowanie personelu przy samym czytaniu | przyjęta: odświeżenie aktywności przez `peek` raz na 1/4 limitu | §3.5 |
| Awatary a limit procesów | przyjęta: `loading=lazy` i kolejka 2 pobrań. Opcja `X-LiteSpeed-Location` pozostaje **[do weryfikacji]** na web9 i nie wchodzi do v1 | §5.4 |
| Zapisy `job_runs` przy każdej wiadomości | przyjęta: znacznik `jobs-tick`, jeden `SELECT`, jedno przejęcie | §3.7 |
| Sprzątanie porzuconych kont a FK zgłoszeń (H i R) | przyjęta: warunek „bez zgłoszeń”, transakcja i `try/catch` na konto | §3.7 |
| `dump.php` i przywracanie | przyjęta: strumieniowo, niebuforowane, `REPEATABLE READ`; przywracanie po usunięciu tabel | §9.6 |
| Wdrażanie w dzień zawodów | przyjęta: zasada w DEPLOY-PL.md i ostrzeżenie w `deploy-verify` | §9.8, §9.11 |
| Uprawnienia MySQL 8.0 i blokady migracji | przyjęta: `SHOW GRANTS` w `server-check`, komunikat dla 1205/1213 | §2.2, §9.8 |
| Test obciążenia z serwera | przyjęta: `scripts/poll-probe.sh` z laptopa lub telefonu | §9.11, §12.14 |
| Wyjątek przy kolizji słowników | przyjęta: „pierwszy wygrywa” i `collisions` sprawdzane w testach | §8.6 |
| Komunikaty `Error` w nowych modułach | przyjęta: zbierane ze wszystkich modułów | §8.6 |
| Kolizje identyfikatorów formularzy | przyjęta: prefiksy `acct-`/`chat-`/`mod-`, kontrola w QA | §8.3 pkt 8 |
| Logowanie na telefonie przy pierwszej wizycie | przyjęta: przycisk „Zaloguj się” w hero | §8.9, §12.5 |
| Personel bez pełnego dostępu a zmiana hasła i strona planu | przyjęta: `account.password` bez 402, role stron, baner | §3.3, §6.6, §12.12 |
| Swobodny wybór waluty | przyjęta: waluta z kraju, P20 | §6.1, §6.2 |
| Archiwa dla gości i dzień karencji | przyjęta: okno gościa = okno `GuestView`; P3 jako bramka startu | §5.2, §13 |
| Wartości domyślne config | przyjęta: `Config::DEFAULTS` i `array_replace` | §6.8 |
| Tryb demo | przyjęta: kompletne profile demo, `public-config` w demo | §8.4, §8.5, §8.8 |

---

## Załącznik A. Nowe klucze `config.php` (wszystkie opcjonalne; wartości domyślne w `Config::DEFAULTS`)

| Klucz | Domyślnie | Opis |
|---|---|---|
| `signup_enabled` | `false` | samodzielna rejestracja (wymaga `billing_enforce=true` i `support_email`, §6.8) |
| `signup_invite_token` | `null` | rejestracja tylko z linku `#signup?invite=…` (okno testów, ≥ 24 znaki) |
| `signup_free_beta` | `false` | jawna zgoda na rejestrację bez wymuszania płatności (P16) |
| `support_email` | `null` | adres pomocy (§3.10); bramka startu rejestracji |
| `signup_limit_ip_hour`, `signup_limit_ip_day`, `signup_limit_global_hour` | `30`, `100`, `200` | limity rejestracji (IP z prefiksem /64) |
| `username_check_limit_session`, `username_check_limit_ip` | `30`, `300` | na 10 minut |
| `login_limit_ip` | `100` | prób logowania na IP na 15 min (para IP+e-mail bez zmian: 8) |
| `member_session_idle_seconds` | `1209600` | bezczynność sesji członka |
| `member_session_max_seconds` | `2592000` | maksymalny wiek sesji członka |
| `anon_session_seconds` | `10800` | po ilu sekundach `housekeeping` usuwa plik sesji anonimowej |
| `session_dir` | `null` (auto `shared/sessions`, jeśli istnieje) | katalog plików sesji (tylko przy `save_handler=files`) |
| `uploads_dir` | `null` (auto `shared/uploads`) | awatary; nigdy w docroot |
| `avatars_enabled` | `true` | wyłącznik zdjęć |
| `abandoned_member_days` | `30` | sprzątanie porzuconych kont (tylko przy `billing_enforce=true`) |
| `chat_force_off` | `false` | awaryjne wyłączenie czatu (alternatywnie plik `shared/chat-off`) |
| `min_client_api` | `1` | najstarszy akceptowany kontrakt klienta (D19) |
| `trusted_proxy_header`, `trusted_proxies` | `null`, `[]` | IP klienta za proxy hostingu |
| `db_migrate` | `null` (używa `db`) | osobne dane z prawami DDL dla CLI |
| `billing_enabled` | `false` | interfejs i trasy płatności |
| `billing_enforce` | `false` | wymuszanie płatności (wymaga `billing_enabled=true`) |
| `billing_mode` | `'test'` | `'test'` albo `'live'`; musi odpowiadać kluczowi |
| `stripe_secret_key` | `'REPLACE_WITH_rk_test_…'` | klucz ograniczony |
| `stripe_webhook_secrets` | `[]` | puste = trasa webhooka zwraca 404 |
| `stripe_api_base` | `'https://api.stripe.com'` | http tylko z `allow_insecure_http` i pętlą zwrotną (testy) |
| `stripe_api_version` | `'2026-09-30.endive'` | potwierdzić w Workbench |
| `stripe_prices` | `['pln'=>'matbravo_monthly_pln','usd'=>'matbravo_monthly_usd']` | lookup keys |
| `billing_amounts` | `['pln'=>899,'usd'=>299]` | do wyświetlania; sprawdzane przez setup |
| `stripe_portal_configuration` | `null` | `bpc_…` z `stripe-setup.php` |
| `stripe_timeout_seconds` | `20` | połączenia interaktywne |
| `stripe_background_connect_timeout`, `stripe_background_timeout` | `3`, `8` | wywołania w tle (leniwa synchronizacja, zadania), bez ponowień |
| `stripe_down_seconds` | `600` | czas bezpiecznika po błędzie sieci |
| `stripe_ca_bundle` | `null` | opcjonalna ścieżka CA |
| `billing_grace_days` | `7` | karencja `past_due` i po końcu darmowego okresu (`grace`) |
| `billing_stale_leeway_hours` | `72` | zapas przy niedostępnym Stripe |
| `billing_sync_min_interval` | `600` | leniwa synchronizacja na konto |
| `billing_allow_promotion_codes` | `false` | kody rabatowe |
| `billing_address_collection` | `'required'` | `auto` albo `required` |
| `job_test_sleep_ms` | `0` | **tylko testy**: spowalnia zadanie, żeby sprawdzić zwolnienie sesji |

## Załącznik B. Ryzyka i sposób ograniczenia

| Ryzyko | Skutek | Ograniczenie |
|---|---|---|
| Hosting blokuje wychodzące HTTPS do `api.stripe.com` z PHP strony [do weryfikacji] | płatności niemożliwe | sonda Stripe w `diagnostics` (PHP strony) i `server-check` (CLI) jako warunek kroku 2 §6.10; w razie blokady zgłoszenie do AfterMarket albo zmiana hostingu |
| Limity żądań hostingu, wiele telefonów za jednym IP w hali | 429, wolny czat, blokada rejestracji | bezczynność od interakcji, ograniczony `boost`, jeden poller na przeglądarkę, `Retry-After`, raport `e` i licznik w panelu, presety tempa, wyłącznik, podniesione limity po IP; `poll-probe.sh` przed startem; etap 2 (beacon) przygotowany |
| Pliki sesji gości i botów (limit i-węzłów konta) | błędy zapisu sesji, wolne sprzątanie | sprzątanie według rodzaju (3 h / 12 h / 14 dni), `peek` nie tworzy plików, liczba plików w `diagnostics` |
| Blokada pliku sesji podczas pracy po odpowiedzi | „zawieszone” karty jednego użytkownika | `session_write_close()` przed zadaniami i synchronizacją, test < 1 s |
| Sprzątanie sesji przez hosting | wylogowania | własny `shared/sessions`, sprzątanie w `housekeeping` |
| Brak regularnych kopii po starcie | utrata danych członków i płatności | kopia przy wdrożeniu, gdy najnowsza > 24 h; `dump.php --auto` w cronie; ostrzeżenia o wieku kopii; pytanie o kopie AfterMarket |
| Różnice MySQL 8.0 vs MariaDB 10.6 | błąd migracji | wspólny podzbiór (§2.1), lint, CI na obu, kopia przed migracją, kontrola uprawnień |
| Kod w `main` przed migracją | 500 dla wszystkich | jedno scalenie do `main` po `integration-qa` (D18); brak tabeli/kolumny → 503 |
| Rollback do wersji sprzed 0002 przy istniejących członkach | ujawnienie danych zawodników | strażnik „floor” (§2.8), dwuetapowe włączenie rejestracji |
| Pliki-flagi podczas wdrożenia | rollback dobrego wydania | `deploy-verify` rozpoznaje `maintenance` i `chat-off` |
| Rozjazd wersji przez service worker | stare `app.js` wobec nowego API | `X-MatBravo-Client`, `min_client_api`, automatyczna aktualizacja (D19) |
| Brak e-maili (reset, weryfikacja) | obciążenie Admina, przejęcie konta przez fałszywą prośbę, wyliczanie e-maili przy rejestracji, zajęcie cudzego adresu | procedura §3.10 z odpowiedzią tylko na adres z konta, hasło tymczasowe z wymuszoną zmianą, `account_audit`, limity, neutralne komunikaty, narzędzia Admina; etap 2 e-mail (P8) |
| Wspólne urządzenia w hali | tożsamości poprzedniej osoby na ekranie | przeładowanie po wylogowaniu, `reset` do innych kart, czyszczenie przy 401 |
| Sprawy podatkowe i prawne (VAT/OSS/KSeF, prawo odstąpienia, małoletni, zwroty przy usunięciu konta) | nie można legalnie sprzedawać | `billing_enforce=false` do sesji prawnej (P19, P22); sloty zgód zarezerwowane |
| iOS: osobne ciasteczka aplikacji, powrót ze Stripe w arkuszu Safari | ponowne logowanie, „zgubiony” powrót | `confirm` po zalogowaniu z `sessionStorage`, leniwa synchronizacja, notka w arkuszu iOS |
| Brak GD na web9 | brak zdjęć profilowych | tryb `off`, inicjały zawsze działają; `diagnostics` i `server-check` pokazują stan |
| Webhooki zablokowane | dłuższe opóźnienie stanu | poprawność z samych pobrań (§6.3), reguła pierwszeństwa subskrypcji, opcjonalny cron |
| Konflikty w `app.js` | regresje | rejestr i jednorazowe haki (foundation, fala 1), jedna druga runda (home-embed, fala 2) |
| Dorośli i dzieci w jednym czacie | ryzyko dla małoletnich | moderacja, powód zgłoszenia „dane dziecka”, podpowiedź w polu wiadomości, domyślny inicjał nazwiska, brak wiadomości prywatnych i zdjęć w czacie, tożsamość tylko dla członków |
| Nieśledzony katalog `docs/` w nowym środowisku | utrata planu i raportów | zatwierdzenie `docs/plan/` na gałęzi integracyjnej przed falą 1 |
