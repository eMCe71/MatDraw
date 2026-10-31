# MatBravo (MatDraw) — instalacja PHP/MySQL

Ta paczka zawiera aplikację z rzeczywistymi kontami i wspólną bazą danych: turnieje, publiczny czat, konta członków z profilami, płatne konta (Stripe) i aplikację na telefon (PWA). Podgląd Sites używa osobnego trybu demonstracyjnego. Dane z przeglądarkowego demo nie są automatycznie przenoszone na hosting.

Na co dzień aplikację wdraża GitHub Actions na hosting AfterMarket (kroki w `DEPLOY-PL.md`). Ten dokument opisuje, czego aplikacja potrzebuje, jak wygląda pierwsza instalacja i co oznacza każde ustawienie w `config.php`. Co zrobić po kolei i w jakiej kolejności włączać funkcje, jest w `HANDOFF.md`.

## Wymagania

PHP 8.3 lub nowszy (zalecana utrzymywana wersja 8.4+). Na serwerze skryptów używaj `/usr/local/php83/bin/php` (domyślne `php` w SSH na web9 to 8.1).

| Rozszerzenie PHP | Czy konieczne | Do czego |
|---|---|---|
| `pdo_mysql`, `mbstring`, `session`, `json` | tak | podstawa aplikacji |
| `curl` i `openssl` | tak, gdy włączasz płatności | połączenie z `api.stripe.com` (HTTPS) |
| `gd` **z obsługą WebP** | zalecane | zdjęcia profilowe: przycięty obraz jest zapisywany od nowa jako WebP. Bez WebP, ale z JPEG: zapis jako JPEG. Bez `gd`: zdjęć nie ma, zostają inicjały (reszta działa) |
| `exif` | zalecane | prawidłowy obrót zdjęć z telefonu |
| `intl` | zalecane | normalizacja polskich znaków w nazwach i nazwach użytkowników (bez niej działa prostsze porównanie) |
| `zlib` | zalecane | skompresowane kopie bazy z wbudowanego `bin/dump.php` (gdy na serwerze nie ma `mysqldump`) |

Pozostałe wymagania:

- MySQL 8.0+ albo MariaDB 10.6+ (produkcja działa na MariaDB 10.6; testy przechodzą na obu), tabele InnoDB, utf8mb4.
- **Użytkownik bazy z prawami ALTER, CREATE, INDEX i REFERENCES** (oprócz SELECT, INSERT, UPDATE, DELETE). Wdrożenie samo zmienia schemat bazy, więc to konto musi mieć te prawa także po instalacji. DirectAdmin daje je domyślnie. Jeśli chcesz, aby strona działała na koncie z mniejszymi prawami, podaj w `config.php` osobne dane `db_migrate` (konto z prawami do zmiany schematu, używane tylko przez skrypty wiersza poleceń).
- HTTPS na docelowej domenie, np. `matbravo.com`.
- Możliwość ustawienia katalogu domeny na `public/` oraz uruchomienia poleceń PHP CLI (SSH lub panel hostingu). Node.js nie jest potrzebny na serwerze.
- Wychodzące połączenia HTTPS z PHP do `api.stripe.com` (tylko dla płatności). Czy hosting je przepuszcza, pokazuje sonda Stripe (`DEPLOY-PL.md`, „Kroki ręczne właściciela”, punkt 3). Bez tego płatności nie zadziałają, reszta aplikacji tak.
- Cron nie jest potrzebny (zadania porządkowe uruchamiają się przy okazji ruchu na stronie); opcjonalne wpisy opisano niżej.

## Przygotowanie wydania ze źródeł

Jeśli pracujesz na źródłach z katalogami `dist/` i `scripts/`, uruchom w CI:

```bash
node scripts/build-php.mjs ./build/matdraw-php
```

Wynikiem jest wydanie `build/matdraw-php/` z katalogami `public/` i `backend/`. Dalsze kroki dotyczą tego wydania. Jeśli paczka ma już te katalogi, nie wymaga ponownego budowania. Skrypt pakowania jest potrzebny na etapie CI; Node nie jest potrzebny na hostingu.

## Pierwsza instalacja

1. Rozpakuj paczkę poza publicznym katalogiem serwera. Ustaw katalog dokumentów domeny na `matdraw-php/public`. Katalog `backend` musi pozostać poza dostępem WWW. Nie ustawiaj katalogu całej paczki jako katalogu domeny. (Przy wdrożeniu przez GitHub Actions robi to deploy: układ katalogów opisuje `DEPLOY-PL.md`.)
2. Utwórz pustą bazę i użytkownika MySQL z prawami z listy wyżej.
3. Skopiuj `backend/config.example.php` do `backend/config.php` (przy wdrożeniu przez GitHub Actions: `~/matdraw/shared/config.php`; plik może też leżeć gdzie indziej i być wskazany zmienną środowiskową `MATDRAW_CONFIG`). Uzupełnij dokładny adres aplikacji, DSN, użytkownika i hasło bazy. Wygeneruj `app_key`: `php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'`. `app_key` zostaje taki sam między wydaniami (bez niego nikt nie zaloguje się po aktualizacji). Ustaw uprawnienia pliku tak, aby mógł go czytać tylko właściciel i proces PHP (np. 600 lub 640, zależnie od hostingu). Nie przesyłaj tego pliku do repozytorium. Wszystkie pozostałe klucze są opcjonalne i mają bezpieczne wartości domyślne (Załącznik A).
4. Obok `config.php` utwórz katalogi `sessions` i `uploads` (uprawnienia 700, poza `public/`). Aplikacja zapisuje w nich pliki sesji i zdjęcia profilowe; deploy przez GitHub Actions zakłada je sam.
5. Utwórz tabele i pierwszego Administratora. **Instalator zakłada tabele bazowe oraz wszystkie tabele z migracji** (konta członków, czat, płatności), więc nie trzeba osobno uruchamiać `migrate.php`. Hasło nie trafia do argumentów procesu ani historii powłoki. Przykład dla Bash:

```bash
read -rsp 'Hasło Administratora (12–72 bajty): ' MATDRAW_ADMIN_PASSWORD
echo
printf '%s\n' "$MATDRAW_ADMIN_PASSWORD" | php backend/bin/install.php --email=administrator@example.com --club='Nazwa klubu' --password-stdin
unset MATDRAW_ADMIN_PASSWORD
```

Zastąp adres i nazwę klubu własnymi wartościami. Nie ma domyślnego konta produkcyjnego. Ponowne uruchomienie instalatora nie zmienia istniejących kont („Already initialized”). Używaj haseł z minimum 12 znakami; dla znaków spoza ASCII limit 72 bajtów może oznaczać mniej niż 72 znaki.

6. Otwórz domenę przez HTTPS, zaloguj się i dodaj konta personelu w „Konta i role”. Każde konto ma klub, e-mail, hasło i jedną z trzech ról. Hasła przekazuj klubom bezpiecznym kanałem. Użytkownik zmienia hasło w „Moje konto”. Administrator może ustawić nowe hasło po weryfikacji właściciela; nie wdrożono wysyłki e-mail ani automatycznego odzyskiwania hasła.
7. Utwórz turniej i ustaw „Zapisy otwarte”. Klub wybiera osoby ze swojej bazy lub tworzy zawodnika wraz ze zgłoszeniem. „Zapisy zamknięte” blokują edycję klubom; organizator nadal prowadzi kontrolę i wyniki. „Zakończony” blokuje dane startowe i wyniki do czasu świadomego ponownego otwarcia przez uprawnionego organizatora.
8. Przed pierwszym turniejem sprawdź logowanie z dwóch urządzeń, prawa reprezentanta, zapis wyniku, A4/A3, ekran hali, czat na stronie głównej i przełącznik języka PL | EN. Zatwierdź z trenerem kwestie wymienione w „Zasady turnieju”, w tym sposób obliczania wieku. Drabinka powyżej 64 osób i sporne kategorie pozostają zablokowane.

### Aktualizacja istniejącej instalacji

Przy wdrożeniu przez GitHub Actions wszystko dzieje się samo: kopia bazy, migracje, przełączenie wydania, weryfikacja (`DEPLOY-PL.md`). Przy ręcznej aktualizacji:

1. Zrób kopię bazy i `backend/config.php`.
2. Wgraj nowe wydanie, zachowując `config.php`, `sessions` i `uploads`.
3. Uruchom `php backend/bin/migrate.php` (dodaje brakujące tabele i kolumny; można powtarzać). `--status` pokazuje stan bez zmian, `--dry-run` pokazuje, co by się wykonało. Migracje tylko dodają; migrację, która coś usuwa, trzeba uruchomić świadomie z `--allow-destructive`, po kopii.
4. Nie uruchamiaj ponownie instalatora: nie jest migratorem.

Gdy kod jest nowszy od bazy (zapomniana migracja), aplikacja odpowiada „Trwa przerwa techniczna” zamiast błędu 500, a `migrate.php` to naprawia.

## Konta, płatności i konta darmowe

### Rodzaje kont

| Rola | Skąd się bierze | Dostęp |
|---|---|---|
| Administrator | instalator | Wszystkie turnieje, profile, zgłoszenia, wyniki, konta i role; moderacja czatu; panel „Członkowie”; ustawienia czatu i płatności kont. Nigdy nie płaci. |
| Edytor | Administrator („Konta i role”) | Tworzenie i prowadzenie własnych turniejów, dodawanie i edycja utworzonych przez siebie zawodników; podgląd pozostałych turniejów poza roboczymi |
| Reprezentant klubu | Administrator („Konta i role”) | Kartoteka własnego klubu; dodawanie, zmiana i wycofanie zgłoszeń własnego klubu w turniejach z otwartymi zapisami |
| Członek | samodzielna rejestracja (`#signup`) albo Administrator („Członkowie” → „Nowe darmowe konto”) | Czat (czytanie zawsze; pisanie z pełnym dostępem i kompletnym profilem), własny profil i zdjęcie. **Nigdy nie widzi danych turniejowych** (zawodników, klubów, zgłoszeń). |

### Płatne i darmowe konta

- Cena: **8,99 zł miesięcznie** w Polsce (kraj w profilu = Polska), **2,99 USD miesięcznie** gdzie indziej. Walutę wybiera aplikacja z kraju w profilu; Administrator może ją zmienić na koncie bez trwającej subskrypcji. Płatność idzie przez stronę Stripe (Checkout), zarządzanie subskrypcją przez portal Stripe; aplikacja nie widzi numeru karty.
- **Konto członka jest płatne**, chyba że Administrator utworzył je jako darmowe („Członkowie” → „Nowe darmowe konto”, z powodem i opcjonalną datą końca).
- **Nowe konto personelu** (edytor, reprezentant klubu) założone w „Konta i role” jest **domyślnie płatne**; przełącznik „Darmowe konto” robi wyjątek. Administrator nigdy nie płaci.
- **Konta, które istniały przed płatnościami**, instalacja oznacza jako darmowe „przejściowo” (`grandfathered`), więc włączenie płatności nie odetnie żadnego klubu w dniu zawodów. Gdy właściciel zdecyduje, że kluby płacą: „Członkowie” → „Wymagaj płatności od…” (data co najmniej 14 dni w przód; od 14 dni przed datą osoba widzi baner, od daty ma 7 dni karencji, potem tylko podgląd).
- Dopóki płatności nie są wymuszane (`billing_enforce=false`), każde konto ma pełny dostęp; nikt niczego nie traci.
- Osoba bez pełnego dostępu (niezapłacona, skończony okres) może się zalogować, zmienić hasło, wybrać plan, ale nie pisze na czacie, a personel ma tylko podgląd turniejów (zapis zwraca „wymagana płatność”).
- Kolejność włączania funkcji (rejestracja, płatności, tryb testowy Stripe, start) opisują `HANDOFF.md` i tabela kombinacji w `DEPLOY-PL.md`. Żadna funkcja nie włącza się sama: w pustym `config.php` nie ma rejestracji ani płatności.

### Narzędzia Stripe (przez SSH)

- `/usr/local/php83/bin/php ~/domains/matbravo.com/backend/bin/stripe-setup.php --mode=test` (potem `--mode=live`): zakłada produkt, dwie ceny i konfigurację portalu, sprawdza kwoty i wypisuje blok do wklejenia w `config.php`. Pyta o pełny klucz `sk_…` w ukrytym polu; **nie wpisuj klucza w poleceniu** (skrypt odmówi). Opcje: `--webhook` (zakłada endpoint webhooków, tylko po zgodzie hostingu), `--rotate-webhook`, `--reprice`, `--dry-run`. Można uruchamiać wiele razy. Pełna procedura: `DEPLOY-PL.md`, „Stripe — konfiguracja krok po kroku”.
- `/usr/local/php83/bin/php ~/domains/matbravo.com/backend/bin/stripe-sync.php --events --due` (odświeża konta; opcjonalne), `--reconcile` (nocne porównanie wszystkich subskrypcji), `--user=ID` (jedno konto), `--dry-run`. Płatności są poprawne także bez niego: aplikacja sama pyta Stripe o stan konta.

### Opcjonalny cron

Wszystko działa bez crona, o ile diagnostyka Administratora (`api/index.php?route=diagnostics`) pokazuje `"afterResponse":true`; przy `false` wpis `stripe-sync.php --events --due` jest obowiązkowy (bez niego odnowienia subskrypcji nie zostaną zapisane). Wpisy crona (DirectAdmin → Advanced Features → Cron Jobs) tylko przyspieszają porządki i synchronizację; pełna lista jest w `DEPLOY-PL.md`, sekcja „Cron (zalecany)”:

- raz na dobę `…/backend/bin/dump.php --auto` (kopia bazy; **zalecane**),
- co 5 minut `…/backend/bin/cron.php` (zadania porządkowe),
- co 20 minut `…/backend/bin/stripe-sync.php --events --due` i raz na dobę `… --reconcile` (płatności).

## Przykładowi zawodnicy (dane testowe)

`backend/bin/seed-athletes.php` dodaje 90 fikcyjnych zawodników w sześciu klubach z dopiskiem „(demo)”. Rozkład: 18 kategorii po 5 osób (wszystkie grupy wieku, obie płcie, Cup i Dan, układy, soft, Hogo, semi i light contact) oraz 3 listy startowe z drugiej konkurencji, razem 21 kategorii. Nikt nie trafia do kategorii zablokowanych, żadna kategoria nie ma mniej niż 3 osób, a w każdej drabince każdy zawodnik jest z innego klubu. Zapis przechodzi przez tę samą walidację co aplikacja i jest wykonywany jako Administrator. Skrypt działa tylko z wiersza poleceń. Na serwerze z CI/CD uruchamiaj go z aktywnego wydania, np. `cd /home/meducase/matdraw/current`.

```bash
php backend/bin/seed-athletes.php --dry-run --date=2026-11-14
```

```bash
php backend/bin/seed-athletes.php --list
```

```bash
php backend/bin/seed-athletes.php --tournament="Puchar Jesieni 2026"
```

```bash
php backend/bin/seed-athletes.php --remove
```

`--dry-run` pokazuje kategorie bez łączenia z bazą. `--list` wypisuje turnieje (id, data, status). Z `--tournament=ID` albo dokładną nazwą zawodnicy trafiają do kartoteki i od razu zostają zgłoszeni; wiek liczony jest na dzień turnieju (turniej nie może być zakończony). Bez tej opcji powstaje tylko kartoteka, a wiek jest dokładny na dzisiaj. Opcje: `--count=90`, `--seed=2026` (ten sam seed daje tych samych zawodników), `--admin=e-mail`. Drugie uruchomienie jest blokowane, dopóki dane demo istnieją. `--remove` usuwa kluby „(demo)” (tylko bez kont użytkowników), ich zawodników, zgłoszenia i losowania, w których występują. Wpisy w historii zmian turnieju zostają. Dane demo to nie to samo co członkowie czatu: zawodnicy z tego skryptu nie mają kont.

## Języki interfejsu

Interfejs działa po polsku i po angielsku. Przy pierwszej wizycie język wynika z ustawień przeglądarki: polski → PL, każdy inny → EN. Przełącznik PL | EN w nagłówku i na ekranie logowania zapamiętuje wybór w tej przeglądarce. API i baza pozostają po polsku; angielska wersja tłumaczy komunikaty serwera i nazwy kategorii dopiero przy wyświetlaniu. Wdrożenie nie wymaga żadnej dodatkowej konfiguracji. Teksty angielskie są w `dist/i18n-en.js` i `dist/i18n/*-en.js` (szczegóły w README). Wiadomości na czacie i dane użytkowników nie są tłumaczone.

## Dane i uprawnienia

Kartoteka zawodnika jest wspólna. Zgłoszenie ma osobną kopię nazwiska, klubu, wieku, stopnia, konkurencji, wagi i obecności. Zmiana kartoteki nie przepisuje historii. Daty turnieju ze zgłoszeniami nie można zmienić. Nowe kartoteki wymagają daty urodzenia; wiek liczony jest na dzień turnieju, co wymaga zatwierdzenia przez trenera.

Sesje PHP mają HttpOnly, Secure, SameSite=Strict; token CSRF chroni wszystkie operacje zapisu, także logowanie. Sesja personelu wygasa po 30 minutach bezczynności i najpóźniej po 12 godzinach. Przedłuża ją praca w aplikacji; odpytywanie czatu w tle i licznik zgłoszeń moderacji jej nie przedłużają. Wyjątek dotyczy przedstawiciela klubu, który tylko czyta otwarty czat: sesję przedłuża odpytywanie czatu widocznego na ekranie, dopóki użytkownik w ciągu ostatnich 30 minut (ostatni próg bezczynności w ustawieniach czatu) sam poruszył myszą, nacisnął klawisz, przewinął stronę lub kliknął pole wiadomości (aplikacja dopisuje wtedy do zapytania czatu `a=1`). Kto zostawi otwarty czat bez żadnego ruchu, przestaje być traktowany jako czytający i po kolejnych 30 minutach bezczynności sesji musi zalogować się ponownie. Sesja członka wygasa po 14 dniach bezczynności i najpóźniej po 30 dniach (żeby aplikacja na telefonie nie wylogowywała co pół godziny). Hasła są haszowane przez `password_hash` (Argon2id, jeśli dostępny, w przeciwnym razie PASSWORD_DEFAULT). Zmiana hasła, e-maila, klubu lub roli i blokada konta unieważniają poprzednie sesje. Obecna sesja Administratora, który edytuje własne aktywne konto, pozostaje dostępna. Limity logowania: 8 prób dla adresu e-mail + IP i 100 dla samego IP w 15 minut (wiele telefonów w hali ma jeden adres IP; wartość `login_limit_ip`). Nie blokuj ostatniego aktywnego Administratora.

Każdy zapis turniejowy sprawdza globalny numer wersji i blokuje rekord `app_meta` w transakcji InnoDB. Przy konflikcie aplikacja pobiera świeże dane i prosi o ponowny zapis. Dane turniejowe są pobierane w pełnym, spójnym zbiorze; rozwiązanie przeznaczone jest na początek dla małych i średnich turniejów. Bardzo duża historia może wymagać późniejszej optymalizacji; nie jest to część obecnego wdrożenia. Czat, płatności i profile nie korzystają z tej blokady (mają osobne tabele), więc rozmowa nie spowalnia prowadzenia turnieju. Ekran hali pobiera wyniki co 15 sekund i wymaga aktywnej sesji uprawnionego użytkownika — nie udostępnia publicznego adresu z danymi zawodników. Po upływie sesji zaloguj się ponownie.

**Co widzi osoba niezalogowana.** Tylko: terminarz najbliższych turniejów na ekranie logowania, podgląd turnieju tylko do odczytu (zawodnicy jako inicjały i nazwa klubu) oraz czat do czytania. Na czacie gość nie widzi imion, inicjałów, nazw użytkowników ani zdjęć; to samo dotyczy zalogowanych bez pełnego dostępu. Szczegóły: `README.md` (sekcja „What guests and unpaid people never see”) i `HANDOFF.md`.

## Utrzymanie i kopie

Regularnie twórz kopie bazy oraz konfiguracji poza katalogiem WWW i sprawdzaj odtworzenie kopii. Kopia JSON z wcześniejszego demo nie zastępuje kopii MySQL. Kopie robi wyłącznie wdrożenie przez GitHub Actions: kopia bazy powstaje, gdy czekają migracje albo najnowsza kopia ma ponad 24 godziny, a kopia zdjęć profilowych (`uploads`), gdy najnowsza ma ponad 7 dni (retencja 30 dni, katalog `~/matdraw/backups`). Bez wdrożeń codzienną kopię bazy daje tylko cron z `dump.php --auto` (zalecany, `HANDOFF.md` krok 5), a kopie warto też co miesiąc pobrać na własny dysk (`DEPLOY-PL.md`). Nie udostępniaj logów z danymi połączenia. Nie ustawiaj `allow_insecure_http=true` na hostingu; parametr służy wyłącznie lokalnym testom. Włącz wymuszanie HTTPS w panelu hostingu. Dołączony `.htaccess` ustawia nagłówki bezpieczeństwa, typy plików i pamięć podręczną na Apache; na nginx ustaw ich odpowiedniki w konfiguracji serwera. Nie usuwaj z niego reguł `RewriteEngine` (hosting odpowiada bez nich błędem 429).

Kod nie wykonuje automatycznego importu dawnych danych produkcyjnych. Pierwsza instalacja zaczyna się od pustej bazy, bez fikcyjnych zawodników. Przed aktualizacją istniejącego wdrożenia wykonaj kopię i zachowaj `backend/config.php`.

## Załącznik A. Klucze `config.php`

Obowiązkowe są tylko `app_url`, `db` i `app_key`. **Każdy inny klucz jest opcjonalny**: gdy go nie ma, aplikacja używa wartości z kolumny „Domyślnie” (to są bezpieczne wartości: bez rejestracji, bez płatności). Klucze dopisujesz przed końcowym `];`. Po każdej zmianie sprawdź stronę: niedozwolona kombinacja przełączników kończy każde żądanie błędem 500 („Invalid billing configuration” albo „Invalid signup configuration” w logu serwera), a usunięcie dopisanych linii przywraca działanie. Wzór z komentarzami: `backend/config.example.php`.

| Klucz | Domyślnie | Do czego |
|---|---|---|
| `app_url` | — | dokładny adres aplikacji (`https://matbravo.com`); sprawdzany przy każdym zapisie (ochrona CSRF). Deploy ustawia go sam |
| `db` | — | `dsn`, `user`, `password` bazy |
| `app_key` | — | losowe 64 znaki szesnastkowe; **nie zmieniaj** między wydaniami |
| `allow_insecure_http` | `false` | tylko testy lokalne; na hostingu zawsze `false` |
| `db_migrate` | `null` (używa `db`) | osobne dane bazy z prawami ALTER, CREATE, INDEX, REFERENCES, używane tylko przez skrypty `migrate.php` |
| `session_idle_seconds`, `session_max_seconds` | `1800`, `43200` | sesja personelu: bezczynność i maksymalny wiek |
| `member_session_idle_seconds`, `member_session_max_seconds` | `1209600`, `2592000` | sesja członka (14 i 30 dni) |
| `anon_session_seconds` | `10800` | po ilu sekundach porządki usuwają plik sesji osoby niezalogowanej (3 h) |
| `session_dir` | `null` (katalog `sessions` obok `config.php`, jeśli istnieje) | katalog plików sesji; poza `public/` |
| `uploads_dir` | `null` (katalog `uploads` obok `config.php`) | zdjęcia profilowe; **nigdy w katalogu publicznym** (aplikacja odmówi) |
| `avatars_enabled` | `true` | wyłącznik zdjęć profilowych (zostają inicjały) |
| `signup_enabled` | `false` | samodzielna rejestracja członków; wymaga `billing_enforce=true` i `support_email` (albo jawnej bety niżej) |
| `signup_invite_token` | `null` | rejestracja tylko z linku `https://matbravo.com/#signup?invite=TOKEN` (okno testów; co najmniej 24 znaki; przy `signup_enabled=false` wymaga `billing_enforce=true`) |
| `signup_free_beta` | `false` | jawna zgoda na rejestrację bez płatności (tylko z `billing_enabled=false`) |
| `support_email` | `null` | adres pomocy przy „Nie pamiętasz hasła?”, np. `pomoc@matbravo.com`; bez niego rejestracja się nie włączy |
| `signup_limit_ip_hour`, `signup_limit_ip_day`, `signup_limit_global_hour` | `30`, `100`, `200` | limity rejestracji (IP, na godzinę i dobę; wszystkie razem na godzinę) |
| `username_check_limit_session`, `username_check_limit_ip` | `30`, `300` | sprawdzenia nazwy użytkownika na 10 minut |
| `login_limit_ip` | `100` | próby logowania na IP w 15 minut (para IP + e-mail: 8) |
| `abandoned_member_days` | `30` | po ilu dniach bez logowania usuwane są porzucone, niezapłacone konta bez historii (tylko przy `billing_enforce=true`) |
| `chat_force_off` | `false` | awaryjne wyłączenie czatu (to samo robi plik `~/matdraw/shared/chat-off`) |
| `min_client_api` | `1` | najstarsza wersja aplikacji, którą serwer przyjmuje; podnoś tylko, gdy zmienia się kontrakt API, i nie w dniu zawodów |
| `trusted_proxy_header`, `trusted_proxies` | `null`, `[]` | z jakiego nagłówka brać adres IP klienta za proxy hostingu (np. `X-Forwarded-For`) i które adresy proxy są zaufane; domyślnie wyłączone |
| `billing_enabled` | `false` | plany, Checkout i portal; widoczne ceny |
| `billing_enforce` | `false` | wymuszanie płatności (wymaga `billing_enabled=true`) |
| `billing_mode` | `'test'` | `'test'` albo `'live'`; musi pasować do prefiksu klucza (`rk_test_`/`rk_live_`) |
| `stripe_secret_key` | `'REPLACE_WITH_rk_test_key'` | klucz **ograniczony** `rk_…` (nie pełny `sk_`); nigdy w repozytorium ani w sekretach GitHub |
| `stripe_webhook_secrets` | `[]` | sekrety `whsec_…` (dwa przy wymianie); puste = adres webhooka odpowiada 404 |
| `stripe_api_base` | `'https://api.stripe.com'` | tylko `https`; `http` wyłącznie z `allow_insecure_http` i adresem lokalnym (testy) |
| `stripe_api_version` | `'2026-09-30.endive'` | przypięta wersja API; potwierdź w panelu Stripe w dniu konfiguracji |
| `stripe_prices` | `['pln'=>'matbravo_monthly_pln','usd'=>'matbravo_monthly_usd']` | klucze wyszukiwania cen |
| `billing_amounts` | `['pln'=>899,'usd'=>299]` | kwoty pokazywane w aplikacji, w groszach i centach; `stripe-setup.php` sprawdza zgodność ze Stripe |
| `stripe_portal_configuration` | `null` | `bpc_…` wypisane przez `stripe-setup.php` |
| `stripe_timeout_seconds` | `20` | limit czasu połączeń wywoływanych przez użytkownika (do 2 ponowień) |
| `stripe_background_connect_timeout`, `stripe_background_timeout` | `3`, `8` | limity połączeń w tle (bez ponowień), żeby nie spowalniać strony |
| `stripe_down_seconds` | `600` | przerwa w synchronizacjach w tle po błędzie sieci Stripe |
| `stripe_ca_bundle` | `null` | opcjonalna ścieżka do certyfikatów CA; domyślnie systemowe |
| `billing_grace_days` | `7` | dni dostępu po nieudanym odnowieniu i po końcu darmowego okresu |
| `billing_stale_leeway_hours` | `72` | zapas dostępu, gdy Stripe jest nieosiągalny lub synchronizacja czeka |
| `billing_sync_min_interval` | `600` | najkrótszy odstęp (sekundy) między automatycznymi synchronizacjami jednego konta |
| `billing_allow_promotion_codes` | `false` | kody rabatowe w Checkout |
| `billing_address_collection` | `'required'` | `'auto'` albo `'required'` (adres rozliczeniowy w Checkout) |
| `job_test_sleep_ms` | `0` | **tylko testy automatyczne**; zostaw `0` |

**Niedozwolone kombinacje** (aplikacja odrzuca je błędem 500): `billing_enforce=true` bez `billing_enabled=true`; `signup_enabled=true` albo token zaproszeń bez poprawnego `support_email`; `signup_enabled=true` bez `billing_enforce=true` i bez `signup_free_beta=true` (a `signup_free_beta` przy `billing_enabled=true`); token zaproszeń przy `signup_enabled=false` bez `billing_enforce=true`; `billing_mode` niezgodny z prefiksem klucza; token krótszy niż 24 znaki.
