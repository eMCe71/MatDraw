# MatBravo — wdrożenie przez GitHub Actions (AfterMarket.pl / DirectAdmin)

Aplikacja działa pod marką **MatBravo** na `https://matbravo.com`. Wewnętrzne nazwy techniczne (repozytorium, przestrzeń nazw PHP, ciasteczko, katalog `~/matdraw`) pozostają „matdraw”.

Workflow `.github/workflows/deploy.yml` przy każdym pushu uruchamia testy i buduje wydanie. Po scaleniu do `main` (albo przyciskiem „Run workflow” na `main`) wysyła wydanie przez SSH na `matbravo.com`, w razie potrzeby robi kopię bazy i aktualizuje jej schemat, przełącza wydanie i sprawdza stronę oraz API. Jeżeli weryfikacja się nie powiedzie, automatycznie wraca do poprzedniego wydania.

Kolejność kroków każdego wdrożenia:

1. **Testy** (JavaScript, PHP, testy HTTP na MySQL 8.0 i MariaDB 10.6, zgodność starego kodu z nowym schematem, test skryptów wdrożenia). Testy przeglądarkowe PWA (Playwright) biegną jako osobne zadanie informacyjne: ich błąd nie wstrzymuje wdrożenia.
2. **Sprawdzenie serwera** — zakłada brakujące katalogi i sprawdza `config.php`.
3. **Wysłanie wydania** do `~/matdraw/releases/<data>-<commit>`.
4. **Migracje bazy** — kopia bazy, potem zmiany schematu. Strona przez cały czas działa na poprzednim wydaniu. Błąd zatrzymuje wdrożenie w tym miejscu.
5. **Przełączenie** na nowe wydanie.
6. **Weryfikacja** z serwera (strona, pliki aplikacji na telefon, baza, API, czat).
7. **Powrót do poprzedniego wydania**, gdy weryfikacja wykryje błąd samego wydania.
8. **Sprzątanie** starych wydań i kopii starszych niż 30 dni.

Na produkcję trafia wyłącznie gałąź `main`. Inne gałęzie i pull requesty tylko się testują.

## Układ na serwerze

```
/home/meducase/
├── matdraw/                                  (poza katalogami domen i poza WWW)
│   ├── shared/                               (700; deploy nigdy go nie nadpisuje)
│   │   ├── config.php                        (600; sekrety, tworzysz raz)
│   │   ├── uploads/                          (700; zdjęcia profilowe członków)
│   │   ├── sessions/                         (700; pliki sesji logowania)
│   │   ├── jobs-tick                         (znacznik zadań porządkowych)
│   │   ├── maintenance                       (tylko podczas przywracania bazy: przerwa techniczna)
│   │   └── chat-off                          (tylko gdy czat ma być wyłączony)
│   ├── releases/<data>-<commit>/{public,backend}
│   ├── current  -> releases/<aktywne wydanie>
│   ├── backups/                              (700; kopie bazy i zdjęć, pliki 600)
│   │   ├── db-<data>-<powód>-<wydanie>.sql.gz
│   │   └── uploads-<data>.tar.gz
│   ├── logs/                                 (700; migrate-<wydanie>.log)
│   └── bin/deploy-remote.sh                  (kopia skryptu do ręcznego użycia)
└── domains/matbravo.com/
    ├── public_html/                          (prawdziwy katalog: kopia public/ aktywnego wydania)
    ├── backend/                              (kopia backend/ aktywnego wydania, poza WWW)
    └── private_html -> ./public_html         (tylko jeśli DirectAdmin go tworzy; HTTPS)
```

Deploy kopiuje aktywne wydanie do prawdziwych katalogów `public_html` i `backend` (podmiana dwoma szybkimi zmianami nazw, więc strona nigdy nie jest w połowie skopiowana). `backend/` leży obok `public_html`, poza dostępem WWW, i ma link `config.php -> ~/matdraw/shared/config.php`. Wartość `app_url` w `config.php` deploy ustawia sam na adres z workflow (`APP_URL`), bo aplikacja sprawdza ją przy każdym zapisie (ochrona CSRF).

**Dane użytkowników są poza wydaniem.** `public_html` i `backend` są przy każdym wdrożeniu zastępowane w całości, dlatego zdjęcia, sesje, kopie bazy i logi leżą w `~/matdraw`. Usunięcie i ponowne dodanie domeny w DirectAdmin ich nie kasuje. Pierwszy deploy przenosi dotychczasową zawartość domeny do `~/matdraw/backups`; nic nie jest kasowane. Zostaje 5 ostatnich wydań.

**Pierwsze wdrożenie z katalogiem `shared/sessions` wyloguje wszystkich jeden raz** (sesje przenoszą się do nowego katalogu). Dlatego wdrażaj w dzień bez zawodów.

## Konfiguracja jednorazowa

### 1. Klucz SSH tylko do wdrożeń

Na swoim komputerze (macOS/Linux: Terminal, Windows: PowerShell):

```bash
ssh-keygen -t ed25519 -C "github-actions-matdraw" -f ~/.ssh/matdraw_deploy
```

Na pytanie o hasło (passphrase) naciśnij dwa razy Enter — GitHub Actions nie może go wpisać.

W DirectAdmin otwórz **Advanced Features → SSH Keys** (po polsku „Funkcje zaawansowane → Klucze SSH”), wybierz **Paste key** i wklej zawartość pliku `~/.ssh/matdraw_deploy.pub` (klucz publiczny). Jeśli tej pozycji nie ma w menu, SSH nie jest włączone dla konta — poproś obsługę AfterMarket o włączenie SSH i podanie hosta oraz portu.

Host i port SSH znajdziesz w danych hostingu od AfterMarket (zwykle nazwa serwera lub jego IP widoczne w DirectAdmin). Sprawdź połączenie, wstawiając swoje wartości:

```bash
ssh -i ~/.ssh/matdraw_deploy -p PORT meducase@HOST 'php -v; command -v tar'
```

### 2. Sekrety w GitHub

`eMCe71/MatDraw` → **Settings → Environments → New environment** → nazwa `production`. W środowisku dodaj **Environment secrets**:

| Sekret | Wartość |
|---|---|
| `SSH_HOST` | host serwera SSH |
| `SSH_PORT` | port SSH |
| `SSH_USER` | użytkownik DirectAdmin (np. `meducase`) |
| `SSH_PRIVATE_KEY` | cała zawartość pliku `~/.ssh/matdraw_deploy` (klucz prywatny, razem z liniami BEGIN/END) |
| `SSH_KNOWN_HOSTS` | wynik polecenia `ssh-keyscan -p PORT HOST` |

Opcjonalnie w tym samym ekranie włącz **Required reviewers** — wtedy każdy deploy czeka na Twoje zatwierdzenie. Hasło bazy, `app_key` i klucze Stripe nie trafiają do GitHub; są tylko w `shared/config.php` na serwerze.

### 3. Baza MySQL

DirectAdmin → **Account Manager → MySQL Management → Create new database**. DirectAdmin doda prefiks konta, np. baza i użytkownik `meducase_matdraw`. Zapisz wygenerowane hasło. Na web9 jest MariaDB 10.6; pełny test HTTP aplikacji przechodzi na tej wersji i na MySQL 8.0 w CI.

**Prawa użytkownika bazy.** Wdrożenie samo zmienia schemat bazy (migracje), więc użytkownik bazy musi mieć prawa **ALTER, CREATE, INDEX i REFERENCES** (oprócz zwykłych SELECT, INSERT, UPDATE, DELETE). DirectAdmin domyślnie daje wszystkie prawa do własnej bazy, więc zwykle nic nie trzeba robić. Sprawdzisz to workflow „server_check” (linie „Prawo bazy …: tak”). Nie ograniczaj praw tego konta. Jeśli kiedyś zechcesz, aby strona działała na koncie z mniejszymi prawami, w `config.php` możesz podać osobne dane `db_migrate` (konto z prawami do zmiany schematu, używane tylko przez skrypty).

Gdy migracja trafi na zajętą tabelę (stara wersja akurat zapisuje dane), wdrożenie kończy się komunikatem **„Baza jest chwilowo zajęta. Ponów wdrożenie za kilka minut.”**. Strona działa dalej na poprzednim wydaniu; uruchom workflow ponownie.

### 4. Plik konfiguracyjny

Przez SSH:

```bash
mkdir -p ~/matdraw/shared && chmod 700 ~/matdraw/shared
```

```bash
/usr/local/php83/bin/php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'
```

```bash
nano ~/matdraw/shared/config.php
```

Wklej i uzupełnij (nazwę bazy, użytkownika, hasło z kroku 3 i `app_key` z polecenia powyżej):

```php
<?php
return [
 'app_url' => 'https://matbravo.com',
 'db' => [
  'dsn' => 'mysql:host=localhost;dbname=meducase_matdraw;charset=utf8mb4',
  'user' => 'meducase_matdraw',
  'password' => 'HASŁO_BAZY',
 ],
 'app_key' => 'WYNIK_POLECENIA_PHP_64_ZNAKI',
 'allow_insecure_http' => false,
 'session_idle_seconds' => 1800,
 'session_max_seconds' => 43200,
];
```

```bash
chmod 600 ~/matdraw/shared/config.php
```

`app_key` nie zmieniaj między wydaniami. Rób kopię tego pliku poza serwerem w bezpiecznym miejscu. Pozostałe klucze są opcjonalne i mają bezpieczne wartości domyślne — opis w sekcji „Nowe klucze config i dozwolone przełączniki”.

### 5. PHP dla domeny

W DirectAdmin ustaw dla `matbravo.com` PHP 8.3 (wybór wersji PHP domeny) i upewnij się, że włączone są `pdo_mysql`, `mbstring`, `curl`, `openssl`, `gd` (z WebP), `exif`, `intl` i `sodium`. Wymuś HTTPS w ustawieniach SSL domeny. Niezależnie od tego `.htaccess` aplikacji przekierowuje `http://` i `www.` na jeden adres `https://matbravo.com` (bezpieczne ciasteczko sesji i sprawdzanie Origin działają tylko pod adresem z `app_url`).

### 6. Pierwszy deploy i Administrator

Scal zmiany do `main` lub uruchom **Actions → Test, build i deploy → Run workflow** na `main`. Przy pierwszym wdrożeniu baza jest pusta, więc workflow kończy się ostrzeżeniem „uruchom instalator”. Wtedy przez SSH, jednorazowo:

```bash
cd ~/domains/matbravo.com
read -rsp 'Hasło Administratora (12–72 bajty): ' MATDRAW_ADMIN_PASSWORD; echo
printf '%s\n' "$MATDRAW_ADMIN_PASSWORD" | /usr/local/php83/bin/php backend/bin/install.php --email=TWOJ@EMAIL --club='Nazwa klubu' --password-stdin
unset MATDRAW_ADMIN_PASSWORD
```

Domyślne `php` w SSH na web9 to 8.1, dlatego instalator i wszystkie skrypty uruchamiamy przez `/usr/local/php83/bin/php`. Instalator tworzy tabele bazowe, **także wszystkie tabele z migracji** (konta członków, czat, płatności), i pierwsze konto. Przy kolejnych wdrożeniach go nie uruchamiaj: nowe tabele dodaje samo wdrożenie. Następnie uruchom workflow ponownie — weryfikacja powinna przejść bez ostrzeżeń. Dalej postępuj według `INSTALL-PL.md`, kroki 6–8 („Pierwsza instalacja”).

## Ponowny deploy

- Automatycznie: każdy push/scalenie do `main`.
- Ręcznie: **Actions → Test, build i deploy → Run workflow**, gałąź `main`, bez zaznaczania „Przywróć poprzednie wydanie”.
- Konkretna starsza wersja: `git revert` niechcianych zmian na `main` (pipeline zbuduje i wdroży wynik).
- **Nigdy nie usuwaj `dist/sw.js`** (także przy `git revert` do kodu sprzed PWA): przeglądarki, które raz otworzyły nową stronę, trzymają jej service worker i jego kopię aplikacji, dopóki serwer nie poda nowego `sw.js`. Gołe `dist/sw.js` z pustą listą plików (szablon) jest wspieranym wyłącznikiem dla złego wydania frontendu: usuwa pamięć podręczną `matbravo-*`.

## Kiedy wdrażać

**Tylko w dni bez zawodów.** Przed scaleniem do `main` sprawdź listę najbliższych turniejów na stronie startowej (albo w panelu „Turnieje”). Wdrożenie trwa kilka minut, może wylogować osoby w trakcie pracy (pierwsze wdrożenie wylogowuje wszystkich), a nowa wersja aplikacji na telefonie pokaże pasek „Dostępna jest nowa wersja”. Weryfikacja ostrzega sama, gdy dziś odbywa się turniej („Dziś trwa turniej … Wdrażaj w dni bez zawodów.”), ale wdrożenia nie zatrzymuje.

W dniu zawodów nie podnoś też `min_client_api` w `config.php`: wymusza ono aktualizację u wszystkich naraz.

## Migracje bazy i kopie zapasowe

**Deploy sam aktualizuje schemat bazy.** Przed przełączeniem wydania uruchamia `migrate.php` nowego wydania. Jeśli są zmiany schematu, najpierw robi kopię bazy do `~/matdraw/backups`. Jeżeli kopia albo migracja się nie powiedzie, deploy zatrzymuje się, a strona nadal działa na poprzednim wydaniu. Po poprawce wystarczy uruchomić deploy ponownie: migracje można bezpiecznie powtarzać, zaczynają od pierwszego niewykonanego kroku. Przebieg każdej migracji zapisuje się w `~/matdraw/logs/migrate-<wydanie>.log`.

Migracje tylko **dodają** tabele i kolumny, więc poprzednie wydanie dalej działa na nowym schemacie (to sprawdza zadanie CI „Zgodność wstecz”). Migracji, które coś usuwają, wdrożenie nie uruchamia: zatrzymuje się z komunikatem „Czeka migracja niszcząca”, a taką migrację uruchamia się ręcznie po kopii.

**Kopie automatyczne przy wdrożeniu:**

- **kopia bazy** — gdy czekają migracje (nazwa `db-<data>-pre-vX-to-vY-<wydanie>.sql.gz`) albo gdy najnowsza kopia jest starsza niż 24 godziny (`…-daily-…`). Przy zwykłym wdrożeniu bez zmian schematu i ze świeżą kopią nic się nie kopiuje, więc wdrożenie zostaje szybkie;
- **kopia zdjęć** (`shared/uploads`) — gdy najnowsza jest starsza niż 7 dni (`uploads-<data>.tar.gz`);
- kopia jest przyjęta dopiero po sprawdzeniu (poprawny plik gzip, rozmiar ponad 1 KiB, znacznik „Dump completed” na końcu). Pliki mają uprawnienia 600, katalog 700, poza WWW. Hasło bazy nigdy nie trafia do linii poleceń (narzędzie dostaje je w pliku tymczasowym o uprawnieniach 600);
- kopię robi `mysqldump` albo `mariadb-dump`, a gdy ich nie ma albo zawiodą — wbudowany `backend/bin/dump.php`.

**Bez kopii nie ma migracji.** Gdy kopia bazy nie powstanie, wdrożenie zatrzymuje się przed migracją. Jedyny wyjątek, tylko świadomie i na krótko: w GitHub **Settings → Environments → production → Environment variables** dodaj `ALLOW_NO_BACKUP` = `1`, uruchom wdrożenie, a potem usuń tę zmienną. Gdy nie czeka żadna migracja, nieudana codzienna kopia daje tylko ostrzeżenie.

**Retencja.** Krok „Usunięcie starych wydań” kasuje kopie bazy i zdjęć starsze niż 30 dni, ale **zawsze zostawia najnowszą kopię każdego rodzaju**. Dzięki temu dane usuniętych kont znikają z kopii najpóźniej po około 30 dniach. Gdy katalog `backups` przekroczy 1 GB, pojawi się ostrzeżenie.

**Cron (zalecany) — codzienna kopia także bez wdrożeń.** DirectAdmin → **Advanced Features → Cron Jobs**, raz na dobę (np. 3:17):

```
/usr/local/php83/bin/php /home/meducase/domains/matbravo.com/backend/bin/dump.php --auto
```

Polecenie robi kopię do `~/matdraw/backups` z tą samą kontrolą i retencją 30 dni i nic nie robi, gdy kopia ma mniej niż 20 godzin. Weryfikacja po wdrożeniu ostrzega, gdy najnowsza kopia bazy jest starsza niż 7 dni.

**Kopia ręczna przez SSH:**

```bash
bash ~/matdraw/bin/deploy-remote.sh backup-db ~/matdraw ~/domains/matbravo.com/public_html
bash ~/matdraw/bin/deploy-remote.sh backup-files ~/matdraw ~/domains/matbravo.com/public_html
```

**Kopia na własnym dysku (raz w miesiącu).** Kopie na serwerze leżą na tym samym koncie co strona. Pobierz je co miesiąc na swój komputer (z Terminala, wstawiając swoje wartości):

```bash
scp -P PORT -r meducase@HOST:matdraw/backups ./matbravo-kopie-$(date +%Y-%m)
```

Zapytaj też AfterMarket, jak często i jak długo przechowuje własne kopie konta i jak je przywrócić **[do weryfikacji]**.

## Powrót do poprzedniego wydania

**Rollback zmienia tylko kod.** Schemat bazy zmienia się wyłącznie przez dodawanie (nowe tabele i kolumny), więc poprzednie wydanie działa na nowym schemacie. Kopia bazy sprzed ostatniej migracji jest w `~/matdraw/backups`.

**Service worker przy powrocie.** Gdy przywracane wydanie nie ma własnego `sw.js` (kod sprzed PWA), `deploy-remote.sh` zapisuje na stronie `sw.js`-wyłącznik (komunikat „Wydanie bez sw.js: … zapisano sw.js wyłączający service worker”) i dopisuje do `.htaccess` regułę `no-cache` dla niego. Przeglądarki, które otworzyły nowszą wersję, przy najbliższym sprawdzeniu aktualizacji usuwają jej pamięć podręczną, wyrejestrowują service worker i przeładowują otwarte karty z serwera. Bez tego zostałyby na nowszej aplikacji, która rozmawiałaby ze starym API. Następne wdrożenie wydania z własnym `sw.js` zastępuje oba pliki.

- Automatycznie: gdy po przełączeniu strona lub API nie odpowiada poprawnie z winy wydania. Problemy hostingu (429, 503, brak połączenia z bazą) nie cofają wydania, bo poprzednie wydanie by nie pomogło.
- Ręcznie w GitHub: **Run workflow** na `main` z zaznaczonym „Przywróć poprzednie wydanie” — przywraca na stronę wydanie sprzed ostatniego deployu, bez testów i budowania.
- Ręcznie przez SSH, poprzednie wydanie:

```bash
bash ~/matdraw/bin/deploy-remote.sh rollback ~/matdraw ~/domains/matbravo.com/public_html
```

- Ręcznie przez SSH, dowolne z zachowanych wydań:

```bash
ls ~/matdraw/releases
```

```bash
bash ~/matdraw/bin/deploy-remote.sh activate ~/matdraw ~/domains/matbravo.com/public_html NAZWA_WYDANIA
```

**Strażnik „floor”.** Niektórych danych stary kod nie rozumie. Przykład: gdy istnieją konta członków, wydanie sprzed kont członków potraktowałoby je jak personel i pokazałoby im dane wszystkich zawodników. Dlatego rollback i ręczne `activate` starszego wydania **odmawiają** z komunikatem „Powrót zablokowany: dane w bazie wymagają kodu co najmniej w wersji …” i powodem (wersja 2: konta członków; wersja 7: dane społeczności). Wtedy popraw błąd nowym wdrożeniem z poprawką (np. `git revert` ostatniej zmiany na `main`, **o ile nie usuwa migracji** z `backend/migrations` ani kodu, który je czyta). Cofnięcie całego wydania, które dodało te migracje, daje stare drzewo i zostaje odrzucone tak samo.

Wymuszenie jest możliwe tylko przez SSH i **tylko na własną odpowiedzialność** (np. gdy wiesz, że konta członków są testowe i zaraz je usuniesz):

```bash
FORCE_ROLLBACK=1 bash ~/matdraw/bin/deploy-remote.sh rollback ~/matdraw ~/domains/matbravo.com/public_html
```

## Przywracanie bazy (ręczne, rzadkie)

Wdrożenie nigdy nie przywraca bazy samo: ludzie cały czas zapisują dane na stronie, więc przywrócenie kopii po cichu skasowałoby ich pracę. **Wszystko, co zapisano po wykonaniu kopii, przepada** (zgłoszenia, wyniki, wiadomości czatu, nowe konta i płatności zapisane w aplikacji). Płatności w Stripe zostają w Stripe; aplikacja zsynchronizuje je przy następnym logowaniu członka.

1. **Przerwa techniczna** — API odpowiada „Trwa przerwa techniczna”, nikt nic nie zapisze:

   ```bash
   touch ~/matdraw/shared/maintenance
   ```

2. **Usuń wszystkie tabele MatDraw** (albo przywracaj do nowej, pustej bazy). To konieczne: kopia sprzed nowszej migracji nie zawiera nowszych tabel (np. `user_profiles`, `billing_accounts`, `chat_*`). Gdyby zostały, miałyby wiersze bez właścicieli, a wersja schematu cofnęłaby się. Najprościej w phpMyAdmin: wybierz bazę, **Zaznacz wszystkie** tabele, **Usuń** (odznacz „Włącz sprawdzanie kluczy obcych”). Albo przez SSH (dwa razy zapyta o hasło bazy):

   ```bash
   mysql -u meducase_matdraw -p meducase_matdraw -N -B -e "SELECT CONCAT('DROP TABLE IF EXISTS \`', table_name, '\`;') FROM information_schema.tables WHERE table_schema = DATABASE()" > ~/matdraw/drop-tables.sql
   ( echo 'SET FOREIGN_KEY_CHECKS=0;'; cat ~/matdraw/drop-tables.sql ) | mysql -u meducase_matdraw -p meducase_matdraw && rm ~/matdraw/drop-tables.sql
   ```

3. **Zaimportuj kopię**, a potem uzupełnij schemat migracjami:

   ```bash
   ls -lt ~/matdraw/backups | head
   gunzip -c ~/matdraw/backups/PLIK.sql.gz | mysql -u meducase_matdraw -p meducase_matdraw
   /usr/local/php83/bin/php ~/domains/matbravo.com/backend/bin/migrate.php
   ```

   Zamiast `gunzip | mysql` możesz użyć phpMyAdmin → Import (plik `.sql.gz`).

4. **Usuń plik przerwy technicznej przed kolejnym wdrożeniem** (z tym plikiem weryfikacja tylko ostrzega „Trwa przerwa techniczna (plik maintenance). Usuń go i ponów weryfikację.” i nie cofa wydania):

   ```bash
   rm ~/matdraw/shared/maintenance
   ```

5. Sprawdź stronę i uruchom workflow „server_check”.

## Nowe klucze config i dozwolone przełączniki

Wszystkie poniższe klucze są **opcjonalne**: bez nich aplikacja używa bezpiecznych wartości domyślnych (pełna lista z opisem: `backend/config.example.php`). Klucze dopisujesz w `~/matdraw/shared/config.php` przed końcowym `];`. Po każdej zmianie sprawdź stronę: niedozwolona kombinacja przełączników kończy każde żądanie błędem 500 („Invalid billing configuration” albo „Invalid signup configuration” w logu), a usunięcie dopisanych linii przywraca działanie.

| Klucz | Domyślnie | Do czego |
|---|---|---|
| `signup_enabled` | `false` | **wartość początkowa** rejestracji członków (do pierwszego zapisu w panelu „Ustawienia”) |
| `signup_force_off` | `false` | awaryjne zamknięcie rejestracji przez SSH, ponad ustawieniem z panelu (sekcja „Procedura nadużyć”) |
| `signup_invite_token` | brak | rejestracja tylko z linku `#signup?invite=…` (okno testów; co najmniej 24 znaki) |
| `support_email` | brak | **wartość początkowa** adresu pomocy; po pierwszym zapisie w panelu „Ustawienia” (dowolnej sekcji, bo zapis zapisuje wszystkie pola) liczy się adres z panelu. Bez wpisu w pliku i bez zapisu w panelu obowiązuje `hello@matbravo.com` **od samego wdrożenia** (panel „Nie pamiętasz hasła?” na ekranie logowania pokazuje ten adres), więc skrzynka musi istnieć przed scaleniem |
| `billing_enabled`, `billing_enforce`, `billing_mode` | `false`, `false`, `'test'` | `billing_enabled` **udostępnia Stripe** (ceny, portal, wybór trybu „Otwarta, płatna” w panelu); `billing_enforce` to wartość początkowa wymuszania płatności; `billing_mode` to tryb Stripe (`'test'` albo `'live'`). **Checkout otwiera się tylko wtedy, gdy płatności są wymagane**: `billing_enforce` z pliku przed pierwszym zapisem w panelu, a potem tryb „płatna” z panelu. Gdy nie są wymagane, Checkout odpowiada „Płatności nie są teraz wymagane.” |
| `stripe_secret_key`, `stripe_prices`, `billing_amounts`, `stripe_portal_configuration`, `stripe_webhook_secrets` | — | wkleja je blok wypisany przez `stripe-setup.php` |
| `stripe_api_version` | `'2026-09-30.endive'` | potwierdź w panelu Stripe (Workbench) w dniu konfiguracji |
| `signup_limit_*`, `login_limit_ip`, `username_check_limit_*` | patrz „Limity w dniu zawodów” | ochrona przed nadużyciami |
| `chat_force_off` | `false` | awaryjne wyłączenie czatu |
| `min_client_api` | `1` | najstarsza wersja aplikacji, którą serwer przyjmuje |
| `member_session_idle_seconds`, `member_session_max_seconds` | 14 i 30 dni | jak długo członek zostaje zalogowany |
| `avatars_enabled` | `true` | zdjęcia profilowe |
| `db_migrate` | brak | osobne konto bazy z prawami do zmiany schematu (krok 3) |

**Dozwolone kombinacje przełączników** (kolejność włączania bez ryzyka dla klubów):

| Krok | `signup_enabled` | `signup_invite_token` | `billing_enabled` | `billing_enforce` | Co widzi gość |
|---|---|---|---|---|---|
| po wdrożeniu (domyślnie) | `false` | brak | `false` | `false` | „Zaloguj się, aby pisać”; bez rejestracji; panel „Nie pamiętasz hasła?” z adresem `hello@matbravo.com` |
| okno testów właściciela (kroki ręczne, punkt 8) | `false` | ustawiony | `true` (`billing_mode='test'`) | `true` | jak wyżej; rejestracja tylko z linku z tokenem |
| start (kroki ręczne, punkt 9) | `true` | usunięty | `true` | `true` | „Załóż konto · 8,99 zł / mies.” |
| darmowa beta (tylko świadomie) | `true` z `signup_free_beta=true` | brak | `false` | `false` | „Załóż konto” bez ceny |

Powyższa tabela dotyczy **pliku `config.php`** i jego wartości początkowych. Od wydania z rolami to, co naprawdę obowiązuje, liczy się z pliku i z ustawień zapisanych w panelu Administratora („Ustawienia”): panel wygrywa z wartościami początkowymi, a `signup_force_off` i brak konfiguracji Stripe wygrywają z panelem. Macierz panelu:

| Panel: rejestracja / płatności | `billing_enabled` w pliku | Skutek |
|---|---|---|
| Wyłączona | dowolnie | gość widzi „Zaloguj się, aby pisać”; bez karty „Nowe konto” (stan po wdrożeniu) |
| Otwarta, bezpłatna | `false` albo `true` | „Załóż konto” bez ceny, bez kroku planu; konta z tego okresu są oznaczone jako konta z okresu bezpłatnego |
| Otwarta, płatna | `true` (obowiązkowo) | „Załóż konto · 8,99 zł / mies.”; przejście płatności z „bezpłatnych” na „płatne” wymaga udanej kontroli Stripe i decyzji o kontach z okresu bezpłatnego (gdy płatności są już „płatne”, kontrola i pytanie nie powtarzają się) |
| zapisano „płatna”, ale z pliku zniknęło `billing_enabled` | `false` | rejestracja zamknięta awaryjnie, istniejące konta mają pełny dostęp, czerwony baner w panelu |

Inne kombinacje **w pliku** aplikacja odrzuca: `billing_enforce` wymaga `billing_enabled`; rejestracja (także z tokenem) wymaga `support_email`; otwarta rejestracja wymaga `billing_enforce=true` (albo jawnej darmowej bety). Istniejące konta personelu po pierwszym wdrożeniu są oznaczone jako darmowe, więc włączenie płatności nie odbierze klubom dostępu.

## To wdrożenie: migracje 0007–0009 (role organizatora i zawodnika)

Wydanie z rolami dodaje trzy migracje (schemat v6 → v9). Wszystkie tylko dodają, więc poprzednie wydanie dalej działa na nowym schemacie (zadanie CI „Zgodność wstecz” to sprawdza).

1. Scal do `main` w **dzień bez zawodów**. Pipeline robi kopię bazy przed migracją (`db-<data>-pre-v6-to-v9-<wydanie>.sql.gz` w `~/matdraw/backups`) i dopiero potem migruje. Sprawdź, czy ta kopia jest w katalogu, zanim uznasz wdrożenie za zakończone.
2. `0007_roles` oznacza wszystkie istniejące kluby jako zweryfikowane i wyłącza „Zawodnicy mogą zgłaszać się sami” w istniejących turniejach. `0008_settings` tworzy tabelę ustawień **bez wiersza**, więc rejestracja zostaje wyłączona, a płatności bez zmian: dopóki Administrator nie zapisze „Ustawień”, obowiązuje `config.php`. `0009_lobby_order` zmienia tylko kolejność kanałów czatu (Taekwondo Polska pierwszy).
3. **W `config.php` nic nie zmieniaj.** Nowy klucz `signup_force_off` jest opcjonalny.
4. Wydanie zmienia wygląd aplikacji, więc otwarte karty i aplikacja na telefonie pokażą pasek „Dostępna jest nowa wersja MatBravo. [Odśwież]”. `min_client_api` zostaje bez zmian (`1`), nikt nie jest zmuszany do odświeżenia. Zapis z karty otwartej jeszcze przed wdrożeniem dostaje jednak „Dane zmieniły się w innej sesji. Odśwież widok i ponów zapis.” (migracja 0007 zapamiętuje rewizję z chwili migracji w `app_meta.rev_floor`), więc nie nadpisze zmiany, której ta karta nie widziała; po odświeżeniu widoku zapis działa.
5. **Strażnik „floor” (0007).** Dopóki w bazie nie ma danych społeczności (profili kont zawodników, turniejów lub klubów założonych przez członków, ukrytych turniejów, scalonych klubów), rollback do wydania sprzed 0007 jest możliwy. Takie dane powstają dopiero po otwarciu rejestracji (pierwszy organizator albo zawodnik; dopóki rejestracja jest „Wyłączona”, istniejące konta członków nie mogą włączyć roli ani założyć profilu zawodnika) albo po scaleniu lub ukryciu czegoś przez Administratora. Potem `rollback` i `activate` starszego wydania **odmawiają** („Powrót zablokowany…”): stary kod pokazałby te dane personelowi. **Nie cofaj wtedy całego wydania** (`git revert` scalenia na `main` daje drzewo bez migracji 0007–0009 i zostaje odrzucone tym samym komunikatem): popraw błąd nowym commitem albo cofnij tylko błędne pliki, zachowując `backend/migrations/0007–0009` i kod, który je czyta (`Repository`, `Domain`, `GuestView`). Do czasu poprawki zamknij rejestrację w panelu lub przez `signup_force_off`, a w razie potrzeby włącz przerwę techniczną (plik `maintenance`). Dlatego przed otwarciem rejestracji sprawdź nowe wydanie na produkcji, jako gość i jako Administrator (lista w `HANDOFF.md`).
6. Po wdrożeniu jednorazowo, jeśli kiedykolwiek używałeś `seed-athletes` na produkcji: uruchom go raz (`--remove` albo zwykłe uruchomienie, `INSTALL-PL.md`, „Przykładowi zawodnicy”), bo kluby demo pozostają zweryfikowane, dopóki skrypt ich nie odznaczy.

## Otwarcie rejestracji i procedura nadużyć

Rejestracją steruje się z panelu Administratora, bez wdrożenia i bez SSH (**Ustawienia**). `config.php` zostaje tylko wartością początkową i awaryjnym sufitem.

**Otwarcie.** Skrzynka `hello@matbravo.com` musi istnieć już od wdrożenia (adres pomocy widzi każdy przy „Nie pamiętasz hasła?” od pierwszego wdrożenia tego wydania, nie dopiero po otwarciu rejestracji; sprawdź ją jeszcze raz) i odbierz sesję prawną (dane dzieci; `HANDOFF.md`). Potem **Ustawienia → Rejestracja nowych kont → „Otwarta, bezpłatna”**. Wyloguj się i sprawdź jako gość kartę „Załóż konto”. Płatna rejestracja: najpierw Stripe (sekcja „Stripe — konfiguracja krok po kroku”, w pliku `billing_enabled=true`), potem **„Otwarta, płatna”** (zapis sam sprawdza Stripe) z decyzją o kontach z okresu bezpłatnego (zostaw darmowe albo płatne od daty co najmniej 14 dni w przód).

**Procedura nadużyć** (od najlżejszego do najcięższego kroku):

1. **Obejrzyj kolejkę**: Ustawienia → „Historia zmian” (ostatnie 50 wpisów: ustawienia, organizatorzy, kluby, ukrycia turniejów, zapomnienia profili) i Członkowie → filtr „Organizatorzy do potwierdzenia”. Kluby: **Kluby** → niezweryfikowane i oczekujące nazwy.
2. **Pojedynczy turniej**: karta turnieju (Administrator) → **„Ukryj turniej”** z powodem (organizator go zobaczy). Turniej znika z list publicznych i staje się roboczym; opcja „Wycofaj też zgłoszenia samych zawodników” usuwa ich zgłoszenia.
3. **Pojedynczy organizator**: Członkowie → **„Odbierz rolę organizatora”** (z ukryciem nadchodzących turniejów) albo **„Zablokuj konto”**.
4. **Fala fałszywych organizatorów**: zaznacz wiersze w Członkowie i użyj akcji zbiorczej **„Zablokuj i ukryj turnieje”** (do 50 naraz). Gdy przyjdzie więcej, włącz w Ustawienia → Organizatorzy **„Wymagaj potwierdzenia organizatorów”** (od tej chwili turnieje niepotwierdzonych nie trafiają na stronę główną ani do lobby czatu i nie przyjmują zgłoszeń osób niepełnoletnich) i ewentualnie ustaw **„Publikowanie turniejów przez nowych organizatorów” na „Wstrzymane”**. Wstrzymanie działa tylko na niepotwierdzonych, więc bez „Wymagaj potwierdzenia organizatorów” nikogo nie zatrzyma.
5. **Zamknij rejestrację**: Ustawienia → **„Wyłączona”**. Działa od razu; zalogowani dalej korzystają z serwisu i istniejących ról, ale nikt nie włączy sobie nowej roli ani nie założy profilu zawodnika. „Wyłączona” **nie zamyka** linku z tokenem zaproszeń okna testów płatności: usuń wtedy `signup_invite_token` z `config.php` albo użyj kroku 6.
6. **Panel nie działa**: przez SSH dopisz w `~/matdraw/shared/config.php` linię `'signup_force_off' => true,` (działa od razu, bez wdrożenia; zamyka każdą samodzielną rejestrację, także przez token zaproszeń; panel pokaże czerwony baner). Aby ją cofnąć, usuń linię. Pełne wyłączenie czatu: sekcja „Wyłącznik czatu”; przerwa techniczna: plik `maintenance`.
7. **Usunięcie danych osoby** (prośba rodzica, retencja): konto kasuje się w Członkowie (to usuwa profile, klienta Stripe i zgłoszenia, o ile turniej się nie zakończył; zgłoszenia w turniejach zakończonych lub z zapisanym losowaniem zostają jako wynik **z pełnym imieniem i nazwiskiem**: usunięcie konta zamienia sam profil w „Dane usunięte”, a nazwisko w zachowanym wyniku widzą personel i organizator turnieju, gość tylko inicjały). Żeby nazwisko zniknęło z takich wyników, użyj „Usuń dane zawodnika”: albo zawodnik **przed usunięciem konta** (Moje konto, z hasłem), albo Administrator **po usunięciu konta**, w **Baza zawodników → „Pokaż archiwum”** na zanonimizowanej kartotece „Dane usunięte” (kilka takich kartotek rozróżnisz po klubie i liczbie turniejów; zapisz je przed usunięciem konta). W kartotece profilu, który należy do działającego konta zawodnika, Administrator przycisku nie widzi. W zachowanych zgłoszeniach zostają wtedy inicjały. Dane dodane przez organizatora usuwa on sam albo Administrator (`profile.forget`), a bez interwencji zadanie `community-retention` anonimizuje je po 24 miesiącach od ostatniego turnieju.

Przy rosnącym obciążeniu: limity w dniu zawodów i odpowiedzi 429/503 (sekcje niżej). Limity nowych turniejów i klubów są stałymi w kodzie (3 nowe turnieje na dobę na organizatora, 10 opublikowanych nadchodzących, 50 na dobę od niepotwierdzonych razem).

## Kroki ręczne właściciela (w tej kolejności)

1. **Repozytorium:** `eMCe71/MatDraw` ma środowisko `production` z sekretami `SSH_*` (kroki 1–2 wyżej).
2. **Odpowiedzi na pytania przed startem:** czy i od kiedy obecne kluby płacą; czy archiwa i dzień po turnieju są tylko dla zalogowanych; domyślny sposób pokazywania nazwiska (inicjał); adres pomocy (domyślnie `hello@matbravo.com`, skrzynka musi istnieć przed wdrożeniem); podatki. Wdrożenie na nie nie czeka, włączenie płatności tak.
3. **Wdrożenie w dzień bez zawodów** (skrzynka `hello@matbravo.com` ma już istnieć; wdrożenie z 2026-10-31 wylogowało członków jeden raz, to wydanie już nie). Potem uruchom **Actions → Test, build i deploy → Run workflow** z zaznaczonym „Tylko sprawdź połączenie SSH i serwer” (`server_check`) i odczytaj w panelu AfterMarket swój plan (Start/Biznes/Pro). W wyniku `server_check` sprawdź: GD i WebP, `mysqldump`, `crontab`, „Prawo bazy …: tak” i linię „Stripe:”. Jeśli Stripe jest „NIEOSIĄGALNY”, płatności na tym hostingu nie zadziałają: zgłoś to do AfterMarket.
4. **Uprawnienia bazy:** ALTER, CREATE, INDEX i REFERENCES (krok 3 wyżej; `server_check` je pokazuje).
5. **Kopie zapasowe (przed startem płatności):** cron z `dump.php --auto` (sekcja „Migracje bazy i kopie zapasowe”), pytanie do AfterMarket o ich własne kopie, comiesięczne pobieranie `~/matdraw/backups` na własny dysk.
6. **Stripe w trybie testowym** — sekcja „Stripe — konfiguracja krok po kroku”, punkty 1–4.
7. **Ustawienia w panelu Stripe** — tamże, punkt 5 (osobno dla trybu testowego i na żywo).
8. **Okno testów.** Najprościej zrobić je **przed pierwszym zapisem w panelu „Ustawienia”**, bo od pierwszego zapisu o płatnościach i rejestracji decyduje panel, a `billing_enforce` z pliku jest ignorowane (Checkout odpowiada wtedy „Płatności nie są teraz wymagane.”). Jeśli panel był już zapisany (np. „Otwarta, bezpłatna”), ustaw w nim dodatkowo **„Wyłączona”** z włączonym **„Płatności istniejących kont”** (zapis sam sprawdza Stripe; potwierdź „Potwierdzam tryb testowy”; konta z okresu bezpłatnego: wybierz od razu decyzję docelową, bo jest ostateczna — „Zostaw im bezpłatny dostęp” daje grupie B dostęp bez daty końca, a gdy płatności są już wymagane, kolejny zapis o to nie pyta; jeśli wolisz zdecydować po testach, wróć wtedy do „Otwarta, bezpłatna” przed krokiem 9), a token i pozostałe klucze zostaw w pliku. W `config.php` `billing_enabled=true`, `billing_mode='test'`, `billing_enforce=true`, `signup_enabled=false`, `signup_invite_token` (losowe 32 znaki, np. z `/usr/local/php83/bin/php -r 'echo bin2hex(random_bytes(16)), PHP_EOL;'`) i `support_email`. Zalogowany jako Administrator otwórz w przeglądarce `https://matbravo.com/api/index.php?route=diagnostics&probe=stripe` (dla tej diagnostyki nie ma ekranu w panelu): w odpowiedzi musi być `"stripe":{"reachable":true,…}` (limit 6 sprawdzeń na godzinę). Sprawdź też `"server":{…,"afterResponse":true}`: przy `false` hosting nie umie wysłać odpowiedzi przed dokończeniem pracy, więc synchronizacja płatności i zadania w tle nie działają przy okazji ruchu i wpis crona `stripe-sync.php --events --due` (sekcja „Cron”) jest **obowiązkowy**. Testy z linku `https://matbravo.com/#signup?invite=TOKEN`: karta testowa 4242 4242 4242 4242, płatność z 3DS, portal klienta, anulowanie, usunięcie konta. Nowe konta personelu zakładane w tym oknie oznaczaj jako darmowe.
9. **Tryb na żywo:** najpierw, jeszcze przy `billing_mode='test'`, usuń konta testowe w panelu **Członkowie**: usunięcie konta kasuje w Stripe wszystkich klientów tego konta (także zastąpionych przy zmianie waluty), ale tylko w bieżącym trybie, bo `config.php` ma jeden klucz. Konto testowe usunięte dopiero w trybie na żywo zostaje oznaczone jako problem, a jego klienta testowego usuwasz ręcznie w panelu Stripe (identyfikator jest w historii płatności konta). Potem `stripe-setup.php --mode=live` (ukryte pole, potem Roll key klucza `sk_live_…`), klucz `rk_live_…` w config i `billing_mode='live'`, jedna własna płatność i zwrot w panelu Stripe. Następnie usuń `signup_invite_token` z `config.php` i w panelu wybierz **„Otwarta, płatna”** — to jest start. Po zmianie kluczy na live panel pokazuje, że konfiguracja Stripe zmieniła się od ostatniego sprawdzenia, a płatna rejestracja i wymaganie płatności są wstrzymane (wszyscy mają dostęp), dopóki zapis w panelu nie zatwierdzi nowej konfiguracji; samo udane „Sprawdź Stripe” ich nie wznawia. „Otwarta, płatna” sama sprawdza Stripe (każde otwarcie płatnej rejestracji, każde włączenie płatności i każde wznowienie to robi, a w trybie testowym prosi o potwierdzenie) i pyta o konta, które straciłyby dostęp: przy włączeniu płatności, po zmianie trybu Stripe (test → live) albo gdy płatności nigdy nie były zatwierdzone w panelu (płatności wprost z pliku). Gdyby „Otwarta, płatna” była już wybrana w chwili zmiany trybu, panel napisze, że kontrola przeszła, ale płatności wznowi zapis trybu rejestracji: kliknij wtedy „Zapisz tryb rejestracji” bez zmian (ten zapis przechodzi tę samą kontrolę i te same pytania). To samo wstrzymanie następuje po każdej późniejszej zmianie klucza, cen lub kwot w `config.php` i po nieudanym „Sprawdź Stripe”; gdy tryb Stripe się nie zmienił, wznawia je udane „Sprawdź Stripe”, bez pytań o konta (kto nie miał subskrypcji, był za paywallem już przed wstrzymaniem). Chwilowa niedostępność Stripe (sieć, błąd 5xx) przy kontroli ani przy zapisie niczego nie wstrzymuje. Przy płatnościach wprost z pliku (`billing_enforce=true`, nic nie zapisano w panelu) kliknij „Sprawdź Stripe” jeszcze w oknie testów, z kluczami testowymi: wtedy zmiana kluczy na live wstrzyma płatności do „Otwarta, płatna”. `signup_enabled=true` w pliku nie jest już potrzebne: od pierwszego zapisu liczy się panel. Jeśli rejestracja ma być po prostu bezpłatna (bez Stripe), wybierz „Otwarta, bezpłatna”; kroki 5–9 dotyczą tylko płatności.
10. **(Opcjonalnie) zgłoszenie do AfterMarket** w sprawie webhooków Stripe (treść w sekcji Stripe, punkt 6). W tym samym zgłoszeniu zapytaj o limity żądań na IP i o LSCache.
11. **(Opcjonalnie) dodatkowe wpisy crona** — sekcja „Cron (zalecany)”.
12. **Test obciążenia z zewnątrz** po pierwszym wdrożeniu — sekcja „Odpowiedzi hostingu 429/503”.
13. **(Etap 2, opcjonalnie) BLIK cykliczny:** e-mail do Stripe Support z konta MEDUCASE.

## Stripe — konfiguracja krok po kroku

Płatności działają bez webhooków (aplikacja sama pyta Stripe o stan subskrypcji), dlatego blokada adresów centrów danych przez hosting ich nie psuje. Bez crona działają tylko wtedy, gdy diagnostyka pokazuje `"afterResponse":true` (PHP wysyła odpowiedź przed synchronizacją po niej); przy `false` cron `stripe-sync.php --events --due` jest obowiązkowy, bo inaczej odnowienia subskrypcji nie zostaną zapisane (dostęp zniknie ok. 3 dni po każdym odnowieniu), a nieudane usunięcia klientów Stripe nie będą ponawiane.

1. **Klucz ograniczony.** W panelu Stripe (tryb testowy): **Developers → API keys → Create restricted key**, nazwa „MatBravo serwer”. Uprawnienia: Customers — Write; Checkout Sessions — Write; Customer portal — Write; Subscriptions — Write; Prices i Products — Read; Invoices — Read; Events — Read; wszystko inne — None. Powstaje klucz `rk_test_…`.
2. **Konfiguracja produktu, cen i portalu.** Przez SSH uruchom:

   ```bash
   /usr/local/php83/bin/php ~/domains/matbravo.com/backend/bin/stripe-setup.php --mode=test
   ```

   Skrypt poprosi o pełny klucz `sk_test_…` i **pole będzie ukryte** — wklej klucz i naciśnij Enter. Nigdy nie wpisuj klucza w samym poleceniu (trafiłby do historii powłoki); skrypt odmówi takiego użycia. Skrypt można uruchamiać wielokrotnie, niczego nie dubluje.
3. **Blok config.** Skrypt wypisze gotowy blok. Wklej go do `~/matdraw/shared/config.php`, a jako `stripe_secret_key` wpisz klucz ograniczony `rk_test_…` z punktu 1 (nie `sk_`). Potem `chmod 600 ~/matdraw/shared/config.php`.
4. **Wymiana klucza `sk_`.** W panelu Stripe przy kluczu tajnym wybierz **Roll key**: klucz wklejony do skryptu przestaje działać. Na serwerze zostaje tylko klucz ograniczony `rk_`.
5. **Ustawienia w panelu Stripe** (osobno dla trybu testowego i na żywo):
   - nazwa „MatBravo”, opis na wyciągu `MATBRAVO`, logo i kolory marki;
   - karty, Apple Pay i Google Pay włączone; Link wyłączony;
   - Smart Retries, a po ostatniej nieudanej próbie anulowanie subskrypcji;
   - e-maile o nieudanej płatności i o wymaganym 3DS; paragony za udane płatności;
   - „Limit customers to one subscription” włączone; Adaptive Pricing wyłączone; Tax wyłączony do sesji prawnej.
6. **(Opcjonalnie) webhooki.** Hosting odpowiada 403 na adresy centrów danych, więc Stripe zwykle nie dostarczy powiadomień. Treść zgłoszenia do AfterMarket:

   > Dzień dobry, na koncie meducase (serwer web9) dla domeny matbravo.com obsługujemy płatności Stripe. Stripe wysyła powiadomienia (webhooki, żądania POST) na adres `https://matbravo.com/api/index.php?route=stripe-webhook` z adresów IP opublikowanych pod https://stripe.com/files/ips/ips_webhooks.txt. Obecnie serwer odpowiada 403 na żądania z sieci centrów danych. Prosimy o dodanie tych adresów IP do białej listy dla tej domeny lub przynajmniej dla tej ścieżki. Lista może się zmieniać — czy możliwe jest automatyczne pobieranie jej z tego adresu? Uwierzytelnianie zapewniamy podpisem HMAC każdego żądania. Przy okazji: czy na koncie obowiązują limity żądań na IP i czy dostępny jest LSCache? Dziękujemy.

   Dopiero po potwierdzeniu: `stripe-setup.php --mode=test --webhook`, wypisany sekret `whsec_…` do `stripe_webhook_secrets`, a w panelu Stripe **Webhooks → endpoint → Send test event** (oczekiwane 200). Bez potwierdzenia nie zakładaj endpointu.
7. **Tryb na żywo** — jak punkty 1–5 z `--mode=live`, kluczami `sk_live_…` / `rk_live_…` i `billing_mode='live'` (patrz „Kroki ręczne właściciela”, punkt 9).

## Limity w dniu zawodów

W hali wiele telefonów ma ten sam adres IP (wspólne Wi-Fi), więc limity liczone na IP mogą zatrzymać prawdziwych ludzi. Domyślne wartości są już podniesione z myślą o hali:

| Klucz | Domyślnie | Co liczy |
|---|---|---|
| `signup_limit_ip_hour` / `signup_limit_ip_day` | 30 / 100 | nowe konta z jednego IP na godzinę / dobę |
| `signup_limit_global_hour` | 200 | wszystkie nowe konta na godzinę (hamulec przed botami); liczą się tylko konta faktycznie założone, nie nieudane próby; `0` wyłącza hamulec |
| `login_limit_ip` | 100 | próby logowania z jednego IP na 15 minut (para IP + e-mail: 8) |
| `username_check_limit_session` / `username_check_limit_ip` | 30 / 300 | sprawdzenia nazwy użytkownika na 10 minut |

Jeśli w dniu zawodów ludzie zgłaszają „Zbyt wiele prób…”, dopisz w `config.php` wyższe wartości, np. `'signup_limit_ip_hour' => 100,` i `'login_limit_ip' => 300,`. Zmiana działa od razu, bez wdrożenia. Po zawodach przywróć wartości domyślne (usuń linie).

## Wyłącznik czatu

- **Awaryjnie, przez SSH** (działa natychmiast, przed bazą; czat odpowiada „Czat jest chwilowo wyłączony”):

  ```bash
  touch ~/matdraw/shared/chat-off
  ```

  Włączenie z powrotem: `rm ~/matdraw/shared/chat-off`. To samo robi klucz `'chat_force_off' => true,` w `config.php`.
- **Na co dzień, w panelu Admina** (**Moderacja → Ustawienia czatu**): włączenie i wyłączenie czatu, tempo odświeżania (presety „Normalne”, „Oszczędne”, „Awaryjne”) i komunikat dla wszystkich. Zmiany docierają do ludzi przy następnym odświeżeniu, bez wdrożenia.
- Weryfikacja po wdrożeniu przy wyłączonym czacie akceptuje odpowiedź „czat wyłączony” i nie cofa wydania.

## Odpowiedzi hostingu 429/503

Hosting (LiteSpeed/CloudLinux) może odrzucać żądania, zanim dotrą do PHP: **429** (za dużo żądań), **503** lub **508** (wyczerpane limity konta). Aplikacja tego nie widzi bezpośrednio, dlatego zgłaszają to przeglądarki.

- **Gdzie to widać:** panel Admina → **Moderacja → Ustawienia czatu** → „Odpowiedzi hostingu w ostatniej godzinie”; DirectAdmin → **Resource Usage** (limity LVE: EP, NPROC, CPU). Liczby w panelu pochodzą z przeglądarek i może je zawyżyć każdy, kto wyśle spreparowane zapytanie; aplikacja liczy co najwyżej jedno zgłoszenie na minutę i rodzaj odpowiedzi z jednego adresu IP gościa lub jednego konta, a w nim najwyżej 10 odpowiedzi (jeden adres dodaje więc najwyżej 600 na godzinę). Goście w hali za jednym adresem IP liczą się razem, jak jedna osoba. Zanim zgłosisz problem do AfterMarket, potwierdź go w Resource Usage.
- **Kiedy przełączyć preset:** gdy w ciągu godziny jest ponad 50 odpowiedzi 429 (co najmniej sześć zgłoszeń z różnych minut albo od różnych osób; albo kilka 503/508), przełącz tempo czatu na „Oszczędne”; gdy to nie pomaga — „Awaryjne”. Po zawodach wróć do „Normalne”. Preset nie zmienia się sam.
- **Test obciążenia z zewnątrz** (po pierwszym wdrożeniu i przed startem). Najpierw z dowolnego komputera:

  ```bash
  curl -sI https://matbravo.com/sw.js
  curl -sI https://matbravo.com/manifest.webmanifest
  ```

  `sw.js` powinien mieć typ JavaScript i `Cache-Control: no-cache`, manifest typ `application/manifest+json`. Potem **z laptopa albo telefonu w trybie hotspotu (nie z serwera i nie z GitHub)**, w katalogu repozytorium:

  ```bash
  bash scripts/poll-probe.sh https://matbravo.com 5 600
  ```

  To 5 równoległych „czytelników” czatu przez 10 minut, co 2,5 sekundy, bez logowania. Skrypt wypisuje liczbę odpowiedzi z każdym kodem. **Kryterium: zero odpowiedzi 429/503/508** (wtedy kończy się kodem 0). W tym czasie obserwuj w DirectAdmin Resource Usage. Jeśli pojawią się 429/503/508, zgłoś AfterMarket wynik i zapytaj o limity żądań na IP; do czasu odpowiedzi ustaw preset „Oszczędne”.
- Weryfikacja po wdrożeniu traktuje 429/503/508 jako problem hostingu: zgłasza błąd, ale nie cofa wydania.

## Aplikacja na telefonie (PWA)

- MatBravo można zainstalować na telefonie (Android: karta „Zainstaluj aplikację” albo menu przeglądarki; iPhone: Udostępnij → „Dodaj do ekranu początkowego”). Stała pozycja „Zainstaluj aplikację” jest w profilu.
- Po wdrożeniu, które zmienia wygląd lub działanie aplikacji, otwarta aplikacja pokazuje pasek **„Dostępna jest nowa wersja MatBravo. [Odśwież]”**. Nic nie przeładowuje się samo, a ekran hali (`#screen`) nigdy nie jest przeładowywany przy zwykłej aktualizacji.
- **Wdrożenie, które zmienia tylko kod serwera, nie pokazuje paska** (numer wersji aplikacji w `version.json` się nie zmienia).
- Bez internetu aplikacja pokazuje stronę „Brak połączenia z internetem” (`offline.html`).
- Zrzuty ekranu z manifestu (`screenshots/*.webp`: czat, drabinka, lista turniejów; fikcyjne dane demo) służą tylko do karty instalacji w przeglądarce. Leżą na stronie, ale nie trafiają do pamięci offline i nie zmieniają numeru wersji aplikacji.
- Weryfikacja po wdrożeniu sprawdza `version.json`, `sw.js` (numer wydania i nagłówek `no-cache`), oba manifesty z ikonami i `offline.html`.
- Sprawdzenie w przeglądarce na komputerze: Chrome → DevTools (F12) → **Application → Manifest** (brak błędów) i **Service workers** (aktywny `sw.js`).
- Nagłówki cache dla plików aplikacji ustawia `.htaccess` (pliki HTML/JS/CSS/JSON zawsze sprawdzane na nowo, `sw.js` bez cache, czcionki na rok, obrazy na 7 dni). Nie usuwaj tych bloków.

## Cron (zalecany)

Aplikacja działa poprawnie bez crona, o ile diagnostyka (`?route=diagnostics`) pokazuje `"afterResponse":true`: zadania porządkowe (sprzątanie sesji, retencja czatu, synchronizacja płatności) uruchamiają się wtedy przy okazji ruchu na stronie, po wysłaniu odpowiedzi. Przy `"afterResponse":false` synchronizacja płatności przy okazji ruchu nie działa i wpis `stripe-sync.php --events --due` poniżej jest obowiązkowy. Cron sprawia też, że wszystko dzieje się regularnie. DirectAdmin → **Advanced Features → Cron Jobs** (**[do weryfikacji]**, czy pozycja jest dostępna na web9; `server_check` pokazuje, czy jest `crontab`):

| Kiedy | Polecenie |
|---|---|
| raz na dobę, np. 3:17 (zalecane) | `/usr/local/php83/bin/php /home/meducase/domains/matbravo.com/backend/bin/dump.php --auto` |
| co 5 minut | `/usr/local/php83/bin/php /home/meducase/domains/matbravo.com/backend/bin/cron.php` |
| co 20 minut | `/usr/local/php83/bin/php /home/meducase/domains/matbravo.com/backend/bin/stripe-sync.php --events --due` |
| codziennie o 3:37 | `/usr/local/php83/bin/php /home/meducase/domains/matbravo.com/backend/bin/stripe-sync.php --reconcile` |

Aby zapisywać wynik, dopisz na końcu polecenia np. ` >> /home/meducase/matdraw/logs/cron.log 2>&1`. Logi są w `~/matdraw/logs/`.

## Odzyskiwanie dostępu do konta

W wersji 1 aplikacja nie wysyła e-maili, więc hasło członka resetuje Administrator. Panel „Nie pamiętasz hasła?” mówi członkowi, aby napisał na adres pomocy (`support_email`) **z adresu, na który założono konto**.

1. Prośba musi przyjść **z adresu zapisanego w koncie**. Nie odpowiadaj na żaden inny adres i nie resetuj hasła na prośbę telefoniczną.
2. W panelu **Członkowie** znajdź konto i wybierz **„Ustaw hasło tymczasowe”**. Serwer pokaże hasło jeden raz.
3. Wyślij hasło **na adres skopiowany z panelu Członkowie**, a nie z pola „Od” otrzymanej wiadomości (to pole da się podrobić; odpowiedź na adres z konta dotrze tylko do właściciela skrzynki).
4. Przy koncie płatnym możesz dodatkowo poprosić o numer paragonu Stripe widoczny w szczegółach płatności konta.

Po zalogowaniu hasłem tymczasowym członek musi ustawić własne hasło; do tego czasu nie może pisać na czacie. Każdy reset trafia do dziennika konta.

## Konflikt adresu e-mail

Bez weryfikacji e-maili ktoś może założyć konto na cudzy adres. Gdy prawowity właściciel adresu napisze na adres pomocy (z tego adresu):

- **konto nieopłacone:** w panelu **Członkowie** zmień adres e-mail konta (osoba, która je założyła, zostanie wylogowana) albo usuń konto. Potem właściciel adresu może założyć własne konto;
- **konto opłacone:** zajmij się nim indywidualnie. Napisz na adres z konta (dotrze to do prawowitego właściciela adresu) i do osoby płacącej przez numer paragonu Stripe; ustal, czyje jest konto. Jeśli płacący użył cudzego adresu: zmień adres na jego prawdziwy adres (zmiana trafia też do Stripe) albo anuluj subskrypcję i usuń konto (zwrot w panelu Stripe według uznania);
- nie podawaj nikomu, czy dany adres ma konto. Rejestracja na zajęty adres pokazuje neutralny komunikat „Nie można założyć konta z tym adresem e-mail. Jeśli masz już konto, zaloguj się.”.

## Publiczny terminarz i podgląd gościa

Ekran logowania pokazuje „Najbliższe turnieje”. Kliknięcie turnieju otwiera okno reklamy; dopiero jego zamknięcie otwiera podgląd turnieju tylko do odczytu, bez logowania. Ta funkcja nie wymaga zmian w `config.php`, w bazie ani w `.htaccess` — wdraża się jak zwykle.

- Publiczne adresy (tylko GET, bez sesji, ciasteczka i tokenu CSRF; odpowiedź może być buforowana 60 s):
  - `https://matbravo.com/api/index.php?route=public` — do 6 najbliższych turniejów: id, nazwa, data, miasto, status.
  - `https://matbravo.com/api/index.php?route=public-tournament&id=ID` — podgląd jednego turnieju.
- Gość widzi tylko turnieje o statusie innym niż „Roboczy” z datą od dziś (czas Europe/Warsaw): nazwę, datę, miasto, status, liczbę zgłoszeń, klubów, kategorii i drabinek, listę kategorii oraz zapisane drabinki, w których zawodnik jest pokazany **wyłącznie inicjałami i nazwą klubu** (np. „J. K. · TKD Warszawa”). Inicjały tworzy serwer — pełne imię i nazwisko nigdy nie trafia do przeglądarki gościa. Gość nie widzi dat urodzenia, wieku, wagi, wzrostu, stopni, obecności, e-maili, kont ani historii zmian.
- Aby ukryć turniej przed gośćmi, ustaw mu status „Roboczy”. Po dacie turnieju znika z terminarza i podglądu automatycznie.
- Sprawdzenie po wdrożeniu (z własnego komputera albo przez SSH; serwery GitHub dostają od hostingu 403): `curl -s 'https://matbravo.com/api/index.php?route=public'` powinno zwrócić JSON `{"tournaments":[…]}` bez nagłówka `Set-Cookie`.
- Treść reklamy i zachęty do zalogowania zmienia się w `dist/promo.js` (obiekty `AD` i `ACCESS`, tekst polski), a angielskie wersje w `dist/i18n-en.js`. Potem `node --test tests/i18n.test.mjs`. Marka w przykładowej reklamie (KYORUVO) jest fikcyjna. Dozwolone są tylko pliki aplikacji (CSP): bez zewnętrznych obrazków, linków i skryptów śledzących.

## Ważne cechy hostingu AfterMarket (web9)

- **HTTP 429 bez własnych reguł `RewriteEngine`.** W katalogu domowym konta jest plik hostingu `~/.htaccess` (właściciel `root`, tylko do odczytu), którego reguły obejmują wszystkie domeny konta. Domena, której `public_html/.htaccess` nie włącza własnych reguł `RewriteEngine On`, odpowiada na każde żądanie `429 Too Many Requests` (pusta treść), także ze stroną domyślną DirectAdmin. Tak było 30–31.10.2026 z `matdraw.mdcse.com`, `test429.mdcse.com` i `matbravo.com`. `.htaccess` aplikacji ma własne reguły (przekierowanie `http` i `www` na `https://matbravo.com`), więc strona działa, tak jak `mdcse.com`. Nie usuwaj tych reguł z `backend/public/.htaccess`. Plik `.htaccess` w podkatalogu (np. przyszłe `u/` albo `live/`) **nie może** mieć własnej linii `RewriteEngine` (**[do weryfikacji]**, czy to wystarczy).
- **Nagłówki cache i typy plików w `.htaccess`** (typ manifestu, kompresja, `no-cache` dla plików aplikacji i `sw.js`) — nie usuwaj ich; bez nich telefony mogą długo trzymać starą wersję aplikacji.
- **403 dla adresów GitHub Actions.** Hosting odpowiada 403 na żądania z serwerów GitHub (adresy centrów danych) dla wszystkich stron konta, także `mdcse.com`. Dlatego weryfikacja po deployu (`scripts/deploy-verify.sh`) działa na serwerze przez SSH: sprawdza certyfikat, stronę startową, tryb API, pliki aplikacji na telefon, stan i wersję schematu bazy (bezpośrednio przez backend), sesję API, czat i `me`. Rollback następuje tylko przy błędzie samego wydania, nie przy problemach hostingu. Z tego samego powodu Stripe zwykle nie dostarczy webhooków (sekcja Stripe, punkt 6).
- **PHP w SSH to 8.1** — wszystkie skrypty uruchamiaj przez `/usr/local/php83/bin/php` (skrypty wdrożenia robią to same).
- Domeny `matdraw.mdcse.com` i `test429.mdcse.com` nie są już używane i można je usunąć w DirectAdmin.
