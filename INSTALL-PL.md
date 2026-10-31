# MatDraw — instalacja PHP/MySQL

Ta paczka zawiera aplikację z rzeczywistymi kontami i wspólną bazą danych. Podgląd Sites używa osobnego trybu demonstracyjnego. Dane z przeglądarkowego demo nie są automatycznie przenoszone na hosting.

## Wymagania

- PHP 8.3 lub nowszy (zalecana utrzymywana wersja 8.4+), rozszerzenia PDO, pdo_mysql, mbstring, session, JSON.
- MySQL 8.0+ lub MariaDB 10.11+, tabele InnoDB, utf8mb4.
- HTTPS na docelowej domenie, np. `matbravo.com`.
- Możliwość ustawienia katalogu domeny na `public/` oraz uruchomienia jednorazowego polecenia PHP CLI (SSH lub panel hostingu). Node.js nie jest potrzebny na serwerze.

## Przygotowanie wydania ze źródeł

Jeśli pracujesz na źródłach z katalogami `dist/` i `scripts/`, uruchom w CI:

```bash
node scripts/build-php.mjs ./build/matdraw-php
```

Wynikiem jest wydanie `build/matdraw-php/` z katalogami `public/` i `backend/`. Dalsze kroki dotyczą tego wydania. Jeśli paczka ma już te katalogi, nie wymaga ponownego budowania. Skrypt pakowania jest potrzebny na etapie CI; Node nie jest potrzebny na hostingu.

## Uruchomienie

1. Rozpakuj paczkę poza publicznym katalogiem serwera. Ustaw katalog dokumentów domeny na `matdraw-php/public`. Katalog `backend` musi pozostać poza dostępem WWW. Nie ustawiaj katalogu całej paczki jako katalogu domeny.
2. Utwórz pustą bazę i użytkownika MySQL. Do instalacji potrzebuje praw CREATE, INDEX, REFERENCES i praw do danych. Po instalacji konto aplikacji może mieć tylko SELECT, INSERT, UPDATE, DELETE w tej bazie.
3. Skopiuj `backend/config.example.php` do `backend/config.php`. Uzupełnij dokładny adres aplikacji, DSN, użytkownika i hasło bazy. Wygeneruj `app_key`: `php -r 'echo bin2hex(random_bytes(32)), PHP_EOL;'`. Ustaw uprawnienia pliku tak, aby mógł go czytać tylko właściciel i proces PHP (np. 600 lub 640, zależnie od hostingu). Nie przesyłaj tego pliku do repozytorium.
4. Utwórz tabele i pierwszego Administratora. Hasło nie trafia do argumentów procesu ani historii powłoki. Przykład dla Bash:

```bash
read -rsp 'Hasło Administratora (12–72 bajty): ' MATDRAW_ADMIN_PASSWORD
echo
printf '%s\n' "$MATDRAW_ADMIN_PASSWORD" | php backend/bin/install.php --email=administrator@example.com --club='Nazwa klubu' --password-stdin
unset MATDRAW_ADMIN_PASSWORD
```

Zastąp adres i nazwę klubu własnymi wartościami. Nie ma domyślnego konta produkcyjnego. Ponowne uruchomienie instalatora nie zmienia istniejących kont. Używaj haseł z minimum 12 znakami; dla znaków spoza ASCII limit 72 bajtów może oznaczać mniej niż 72 znaki.

5. Otwórz domenę przez HTTPS, zaloguj się i dodaj konta w „Konta i role”. Każde konto ma klub, e-mail, hasło i jedną z trzech ról. Hasła przekazuj klubom bezpiecznym kanałem. Użytkownik zmienia hasło w „Moje konto”. Administrator może ustawić nowe hasło po weryfikacji właściciela; nie wdrożono wysyłki e-mail ani automatycznego odzyskiwania hasła.
6. Utwórz turniej i ustaw „Zapisy otwarte”. Klub wybiera osoby ze swojej bazy lub tworzy zawodnika wraz ze zgłoszeniem. „Zapisy zamknięte” blokują edycję klubom; organizator nadal prowadzi kontrolę i wyniki. „Zakończony” blokuje dane startowe i wyniki do czasu świadomego ponownego otwarcia przez uprawnionego organizatora.
7. Przed pierwszym turniejem sprawdź logowanie z dwóch urządzeń, prawa reprezentanta, zapis wyniku, A4/A3, ekran hali i przełącznik języka PL | EN. Zatwierdź z trenerem kwestie wymienione w „Zasady turnieju”, w tym sposób obliczania wieku. Drabinka powyżej 64 osób i sporne kategorie pozostają zablokowane.

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

`--dry-run` pokazuje kategorie bez łączenia z bazą. `--list` wypisuje turnieje (id, data, status). Z `--tournament=ID` albo dokładną nazwą zawodnicy trafiają do kartoteki i od razu zostają zgłoszeni; wiek liczony jest na dzień turnieju (turniej nie może być zakończony). Bez tej opcji powstaje tylko kartoteka, a wiek jest dokładny na dzisiaj. Opcje: `--count=90`, `--seed=2026` (ten sam seed daje tych samych zawodników), `--admin=e-mail`. Drugie uruchomienie jest blokowane, dopóki dane demo istnieją. `--remove` usuwa kluby „(demo)” (tylko bez kont użytkowników), ich zawodników, zgłoszenia i losowania, w których występują. Wpisy w historii zmian turnieju zostają.

## Języki interfejsu

Interfejs działa po polsku i po angielsku. Przy pierwszej wizycie język wynika z ustawień przeglądarki: polski → PL, każdy inny → EN. Przełącznik PL | EN w nagłówku i na ekranie logowania zapamiętuje wybór w tej przeglądarce. API i baza pozostają po polsku; angielska wersja tłumaczy komunikaty serwera i nazwy kategorii dopiero przy wyświetlaniu. Wdrożenie nie wymaga żadnej dodatkowej konfiguracji. Teksty angielskie są w `dist/i18n-en.js` (szczegóły w README).

## Dane i uprawnienia

| Rola | Dostęp |
|---|---|
| Administrator | Wszystkie turnieje, profile, zgłoszenia, wyniki, konta i role |
| Edytor | Tworzenie i prowadzenie własnych turniejów, dodawanie i edycja utworzonych przez siebie zawodników; podgląd pozostałych turniejów poza roboczymi |
| Reprezentant klubu | Kartoteka własnego klubu; dodawanie, zmiana i wycofanie zgłoszeń własnego klubu w turniejach z otwartymi zapisami |

Kartoteka zawodnika jest wspólna. Zgłoszenie ma osobną kopię nazwiska, klubu, wieku, stopnia, konkurencji, wagi i obecności. Zmiana kartoteki nie przepisuje historii. Daty turnieju ze zgłoszeniami nie można zmienić. Nowe kartoteki wymagają daty urodzenia; wiek liczony jest na dzień turnieju, co wymaga zatwierdzenia przez trenera.

Sesje PHP mają HttpOnly, Secure, SameSite=Strict; token CSRF chroni wszystkie operacje zapisu, także logowanie. Hasła są haszowane przez `password_hash` (Argon2id, jeśli dostępny, w przeciwnym razie PASSWORD_DEFAULT). Zmiana hasła, e-maila, klubu lub roli i blokada konta unieważniają poprzednie sesje. Obecna sesja Administratora, który edytuje własne aktywne konto, pozostaje dostępna. Limity logowania: 8 prób dla adresu e-mail + IP i 40 dla IP w 15 minut. Nie blokuj ostatniego aktywnego Administratora.

Każdy zapis sprawdza globalny numer wersji i blokuje rekord `app_meta` w transakcji InnoDB. Przy konflikcie aplikacja pobiera świeże dane i prosi o ponowny zapis. Dane są pobierane w pełnym, spójnym zbiorze; rozwiązanie przeznaczone jest na początek dla małych i średnich turniejów. Bardzo duża historia może wymagać późniejszej optymalizacji; nie jest to część obecnego wdrożenia. Ekran hali pobiera wyniki co 15 sekund i wymaga aktywnej sesji uprawnionego użytkownika — nie udostępnia publicznego adresu z danymi zawodników. Po upływie sesji zaloguj się ponownie. Bez logowania dostępne są tylko terminarz najbliższych turniejów na ekranie logowania i podgląd turnieju tylko do odczytu, w którym zawodnicy są pokazani inicjałami i nazwą klubu (szczegóły w `DEPLOY-PL.md` i `README.md`).

## Utrzymanie i kopie

Regularnie twórz kopie bazy oraz konfiguracji poza katalogiem WWW i sprawdzaj odtworzenie kopii. Kopia JSON z wcześniejszego demo nie zastępuje kopii MySQL. Nie udostępniaj logów z danymi połączenia. Nie ustawiaj `allow_insecure_http=true` na hostingu; parametr służy wyłącznie lokalnym testom. Włącz wymuszanie HTTPS w panelu hostingu. Dołączony `.htaccess` ustawia nagłówki bezpieczeństwa na Apache; na nginx ustaw ich odpowiedniki w konfiguracji serwera.

Kod nie wykonuje automatycznego importu dawnych danych produkcyjnych. Pierwsza instalacja zaczyna się od pustej bazy, bez fikcyjnych zawodników. Przed aktualizacją istniejącego wdrożenia wykonaj kopię i zachowaj `backend/config.php`.
