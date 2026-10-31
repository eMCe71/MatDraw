# MatBravo — wdrożenie przez GitHub Actions (AfterMarket.pl / DirectAdmin)

Aplikacja działa pod marką **MatBravo** na `https://matbravo.com`. Wewnętrzne nazwy techniczne (repozytorium, przestrzeń nazw PHP, ciasteczko, katalog `~/matdraw`) pozostają „matdraw”.

Workflow `.github/workflows/deploy.yml` przy każdym pushu uruchamia testy i buduje wydanie. Po scaleniu do `main` (albo przyciskiem „Run workflow” na `main`) wysyła wydanie przez SSH na `matbravo.com`, przełącza je i sprawdza stronę oraz API. Jeżeli weryfikacja się nie powiedzie, automatycznie wraca do poprzedniego wydania.

## Układ na serwerze

```
/home/meducase/
├── matdraw/                                  (poza katalogami domen i poza WWW)
│   ├── shared/config.php                     (sekrety; tworzysz raz, deploy go nie nadpisuje)
│   ├── releases/<data>-<commit>/{public,backend}
│   ├── current  -> releases/<aktywne wydanie>
│   ├── backups/                              (to, co było w domenie przed pierwszym deployem)
│   └── bin/deploy-remote.sh                  (kopia skryptu do ręcznego rollbacku)
└── domains/matbravo.com/
    ├── public_html/                          (prawdziwy katalog: kopia public/ aktywnego wydania)
    ├── backend/                              (kopia backend/ aktywnego wydania, poza WWW)
    └── private_html -> ./public_html         (tylko jeśli DirectAdmin go tworzy; HTTPS)
```

Deploy kopiuje aktywne wydanie do prawdziwych katalogów `public_html` i `backend` (podmiana dwoma szybkimi zmianami nazw, więc strona nigdy nie jest w połowie skopiowana). `backend/` leży obok `public_html`, poza dostępem WWW, i ma link `config.php -> ~/matdraw/shared/config.php`. Wartość `app_url` w `config.php` deploy ustawia sam na adres z workflow (`APP_URL`), bo aplikacja sprawdza ją przy każdym zapisie (ochrona CSRF). Wydania i konfiguracja są w `~/matdraw`, więc nawet usunięcie i ponowne dodanie domeny w DirectAdmin ich nie kasuje. Pierwszy deploy przenosi dotychczasową zawartość domeny do `~/matdraw/backups`; nic nie jest kasowane. Zostaje 5 ostatnich wydań.

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

Opcjonalnie w tym samym ekranie włącz **Required reviewers** — wtedy każdy deploy czeka na Twoje zatwierdzenie. Hasło bazy i `app_key` nie trafiają do GitHub; są tylko w `shared/config.php` na serwerze.

### 3. Baza MySQL

DirectAdmin → **Account Manager → MySQL Management → Create new database**. DirectAdmin doda prefiks konta, np. baza i użytkownik `meducase_matdraw`. Zapisz wygenerowane hasło. W phpMyAdmin sprawdź wersję serwera: dokumentacja aplikacji wymaga MySQL 8.0+ albo MariaDB 10.11+. Na web9 jest MariaDB 10.6.28; pełny test HTTP aplikacji przechodzi na tej wersji w CI (zadanie „Test HTTP na jednorazowej bazie (mariadb:10.6)”).

### 4. Plik konfiguracyjny

Przez SSH:

```bash
mkdir -p ~/matdraw/shared && chmod 700 ~/matdraw/shared
```

```bash
php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'
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

`app_key` nie zmieniaj między wydaniami. Rób kopię tego pliku poza serwerem w bezpiecznym miejscu.

### 5. PHP dla domeny

W DirectAdmin ustaw dla `matbravo.com` PHP 8.3 (wybór wersji PHP domeny) i upewnij się, że włączone są `pdo_mysql` i `mbstring`. Wymuś HTTPS w ustawieniach SSL domeny. Niezależnie od tego `.htaccess` aplikacji przekierowuje `http://` i `www.` na jeden adres `https://matbravo.com` (bezpieczne ciasteczko sesji i sprawdzanie Origin działają tylko pod adresem z `app_url`).

### 6. Pierwszy deploy i Administrator

Scal zmiany do `main` lub uruchom **Actions → Test, build i deploy → Run workflow** na `main`. Przy pierwszym wdrożeniu baza jest pusta, więc workflow kończy się ostrzeżeniem „uruchom instalator”. Wtedy przez SSH, jednorazowo:

```bash
cd ~/domains/matbravo.com
read -rsp 'Hasło Administratora (12–72 bajty): ' MATDRAW_ADMIN_PASSWORD; echo
printf '%s\n' "$MATDRAW_ADMIN_PASSWORD" | /usr/local/php83/bin/php backend/bin/install.php --email=TWOJ@EMAIL --club='Nazwa klubu' --password-stdin
unset MATDRAW_ADMIN_PASSWORD
```

Domyślne `php` w SSH na web9 to 8.1, dlatego instalator uruchamiamy przez `/usr/local/php83/bin/php`. Instalator tylko tworzy tabele i pierwsze konto; przy kolejnych wdrożeniach go nie uruchamiaj. Następnie uruchom workflow ponownie — weryfikacja API powinna przejść bez ostrzeżeń. Dalej postępuj według `INSTALL-PL.md`, krok 5–7.

## Ponowny deploy

- Automatycznie: każdy push/scalenie do `main`.
- Ręcznie: **Actions → Test, build i deploy → Run workflow**, gałąź `main`, bez zaznaczania „Przywróć poprzednie wydanie”.
- Konkretna starsza wersja: `git revert` niechcianych zmian na `main` (pipeline zbuduje i wdroży wynik).

## Powrót do poprzedniego wydania

- Automatycznie: gdy po przełączeniu strona lub API nie odpowiada poprawnie.
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

Rollback zmienia tylko kod. Baza danych pozostaje bez zmian, więc przed aktualizacją, która zmienia schemat, wykonaj kopię bazy (phpMyAdmin → Eksport lub DirectAdmin → MySQL Management → Backup).

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

- **HTTP 429 bez własnych reguł `RewriteEngine`.** W katalogu domowym konta jest plik hostingu `~/.htaccess` (właściciel `root`, tylko do odczytu), którego reguły obejmują wszystkie domeny konta. Domena, której `public_html/.htaccess` nie włącza własnych reguł `RewriteEngine On`, odpowiada na każde żądanie `429 Too Many Requests` (pusta treść), także ze stroną domyślną DirectAdmin. Tak było 30–31.10.2026 z `matdraw.mdcse.com`, `test429.mdcse.com` i `matbravo.com`. `.htaccess` aplikacji ma własne reguły (przekierowanie `http` i `www` na `https://matbravo.com`), więc strona działa, tak jak `mdcse.com`. Nie usuwaj tych reguł z `backend/public/.htaccess`.
- **403 dla adresów GitHub Actions.** Hosting odpowiada 403 na żądania z serwerów GitHub (adresy centrów danych) dla wszystkich stron konta, także `mdcse.com`. Dlatego weryfikacja po deployu (`scripts/deploy-verify.sh`) działa na serwerze przez SSH: sprawdza certyfikat, stronę startową, tryb API, stan bazy (bezpośrednio przez backend) i sesję API. Rollback następuje tylko przy błędzie samego wydania, nie przy problemach hostingu.
- Domeny `matdraw.mdcse.com` i `test429.mdcse.com` nie są już używane i można je usunąć w DirectAdmin.
