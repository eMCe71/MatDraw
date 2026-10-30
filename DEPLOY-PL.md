# MatDraw — wdrożenie przez GitHub Actions (AfterMarket.pl / DirectAdmin)

Workflow `.github/workflows/deploy.yml` przy każdym pushu uruchamia testy i buduje wydanie. Po scaleniu do `main` (albo przyciskiem „Run workflow” na `main`) wysyła wydanie przez SSH na `matdraw.mdcse.com`, przełącza je i sprawdza stronę oraz API. Jeżeli weryfikacja się nie powiedzie, automatycznie wraca do poprzedniego wydania.

## Układ na serwerze

```
/home/meducase/domains/matdraw.mdcse.com/
├── public_html  -> matdraw/current/public   (link tworzony przez pierwszy deploy)
├── private_html -> ./public_html            (HTTPS w DirectAdmin)
└── matdraw/
    ├── shared/config.php                    (sekrety; tworzysz raz, deploy go nie nadpisuje)
    ├── releases/<data>-<commit>/{public,backend}
    └── current  -> releases/<aktywne wydanie>
```

`backend/` jest poza katalogiem WWW. Każde wydanie dostaje link `backend/config.php -> shared/config.php`. Pierwszy deploy przenosi istniejące `public_html` (i `private_html`, jeśli to osobny katalog) do kopii `*.before-matdraw-<data>`; nic nie jest kasowane. Zostaje 5 ostatnich wydań.

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

DirectAdmin → **Account Manager → MySQL Management → Create new database**. DirectAdmin doda prefiks konta, np. baza i użytkownik `meducase_matdraw`. Zapisz wygenerowane hasło. W phpMyAdmin sprawdź wersję serwera: wymagany MySQL 8.0+ albo MariaDB 10.11+.

### 4. Plik konfiguracyjny

Przez SSH:

```bash
mkdir -p ~/domains/matdraw.mdcse.com/matdraw/shared && chmod 700 ~/domains/matdraw.mdcse.com/matdraw/shared
```

```bash
php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'
```

```bash
nano ~/domains/matdraw.mdcse.com/matdraw/shared/config.php
```

Wklej i uzupełnij (nazwę bazy, użytkownika, hasło z kroku 3 i `app_key` z polecenia powyżej):

```php
<?php
return [
 'app_url' => 'https://matdraw.mdcse.com',
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
chmod 600 ~/domains/matdraw.mdcse.com/matdraw/shared/config.php
```

`app_key` nie zmieniaj między wydaniami. Rób kopię tego pliku poza serwerem w bezpiecznym miejscu.

### 5. PHP dla domeny

W DirectAdmin ustaw dla `matdraw.mdcse.com` PHP 8.3 (wybór wersji PHP domeny) i upewnij się, że włączone są `pdo_mysql` i `mbstring`. Wymuś HTTPS w ustawieniach SSL domeny.

### 6. Pierwszy deploy i Administrator

Scal zmiany do `main` lub uruchom **Actions → Test, build i deploy → Run workflow** na `main`. Przy pierwszym wdrożeniu baza jest pusta, więc workflow kończy się ostrzeżeniem „uruchom instalator”. Wtedy przez SSH, jednorazowo:

```bash
cd ~/domains/matdraw.mdcse.com/matdraw/current
read -rsp 'Hasło Administratora (12–72 bajty): ' MATDRAW_ADMIN_PASSWORD; echo
printf '%s\n' "$MATDRAW_ADMIN_PASSWORD" | php backend/bin/install.php --email=TWOJ@EMAIL --club='Nazwa klubu' --password-stdin
unset MATDRAW_ADMIN_PASSWORD
```

Jeżeli `php -v` w SSH pokazuje inną wersję niż 8.3, użyj pełnej ścieżki, np. `/usr/local/php83/bin/php`. Instalator tylko tworzy tabele i pierwsze konto; przy kolejnych wdrożeniach go nie uruchamiaj. Następnie uruchom workflow ponownie — weryfikacja API powinna przejść bez ostrzeżeń. Dalej postępuj według `INSTALL-PL.md`, krok 5–7.

## Ponowny deploy

- Automatycznie: każdy push/scalenie do `main`.
- Ręcznie: **Actions → Test, build i deploy → Run workflow**, gałąź `main`, bez zaznaczania „Przywróć poprzednie wydanie”.
- Konkretna starsza wersja: `git revert` niechcianych zmian na `main` (pipeline zbuduje i wdroży wynik).

## Powrót do poprzedniego wydania

- Automatycznie: gdy po przełączeniu strona lub API nie odpowiada poprawnie.
- Ręcznie w GitHub: **Run workflow** na `main` z zaznaczonym „Przywróć poprzednie wydanie” — przełącza `current` na wydanie sprzed ostatniego deployu, bez testów i budowania.
- Ręcznie przez SSH (wybór dowolnego z zachowanych wydań):

```bash
ls ~/domains/matdraw.mdcse.com/matdraw/releases
```

```bash
cd ~/domains/matdraw.mdcse.com/matdraw && ln -sfn "$PWD/releases/NAZWA_WYDANIA" current.tmp && mv -Tf current.tmp current
```

Rollback zmienia tylko kod. Baza danych pozostaje bez zmian, więc przed aktualizacją, która zmienia schemat, wykonaj kopię bazy (phpMyAdmin → Eksport lub DirectAdmin → MySQL Management → Backup).
