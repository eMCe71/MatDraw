# MatDraw — wdrożenie istniejącej aplikacji przez CI/CD

Aktualny zakres na 30.10.2026: skonfiguruj i wykonaj wdrożenie dostarczonej aplikacji PHP/MySQL na hosting użytkownika. Repozytorium: `Meducase/MatDraw`. Docelowa domena: `matdraw.mdcse.com`. Rozmawiaj po polsku.

Aplikacja jest zaimplementowana. Zachowaj jej funkcje, reguły sportowe, role, wygląd i branding MEDUCASE. Zakres obejmuje konfigurację, istniejące testy, przygotowanie wydania i deploy. Nie obejmuje budowy od zera, redesignu, nowych funkcji, ogólnego audytu ani refaktoryzacji. Naprawiaj tylko usterki uniemożliwiające poprawne lub bezpieczne uruchomienie; inne uwagi krótko zanotuj bez rozszerzania zadania.

## 1. Przygotuj repozytorium

Jeżeli w repozytorium jest tylko ZIP, rozpakuj go i przenieś zawartość `MatDraw-VSCode/` do głównego katalogu repozytorium, zachowując pliki ukryte i istniejącą historię Git. Zachowaj wcześniejszą konfigurację repozytorium, jeżeli istnieje. Usuń roboczy ZIP z bieżącego drzewa po poprawnym imporcie źródeł.

Przeczytaj `INSTALL-PL.md`, `README.md` i ewentualne lokalne instrukcje. `VALIDATION.md` jest raportem poprzednich testów. Dokument trenera w `references/` i opis ograniczeń to materiał referencyjny, a nie zlecenie dodatkowych prac przed deployem. Zachowaj istniejące ograniczenia i blokady spornych kategorii.

## 2. Ustal konfigurację wdrożenia

Sprawdź istniejące workflow CI/CD. Jeśli go brak, dla tego repozytorium GitHub przygotuj GitHub Actions. Zadaj jedną zbiorczą wiadomość z pytaniami tylko o brakujące dane: hosting, wersję PHP i silnik bazy, dostępny sposób wdrażania, ścieżkę docelową, konfigurację domeny oraz sposób uruchamiania pipeline'u. Wskaż nazwy i miejsca ustawienia wymaganych sekretów; nie proś o ich treść w czacie.

Dopasuj rozwiązanie do istniejącego hostingu. Nie wymagaj tworzenia dodatkowego środowiska staging, jeżeli użytkownik go nie ma. Zakres konfiguracji DNS ustal tylko wtedy, gdy domena nie wskazuje jeszcze właściwego serwera.

## 3. Sprawdź i przygotuj wydanie

Uruchom istniejące testy w środowisku CI. Projekt nie wymaga zależności npm ani Composera. Node służy do testów i pakowania, PHP/MySQL do działania aplikacji.

```bash
node --check dist/app.js
node --check dist/client.js
node --test tests/engine.test.mjs tests/workspace.test.mjs
PHP_BIN="$(command -v php)" node --test tests/php.test.mjs
node scripts/build-php.mjs ./build/matdraw-php
```

Test HTTP z `tests/http.test.mjs` uruchamiaj wyłącznie na osobnej, jednorazowej bazie i testowym serwerze. Wymaga `MATDRAW_TEST_URL`, konta testowego wskazanego w pliku oraz wielu workerów do sprawdzenia współbieżności. Bez `PHP_BIN` testy PHP są pomijane; bez `MATDRAW_TEST_URL` test HTTP jest pomijany. Raportuj pominięcia. Nie uruchamiaj testów tworzących dane na produkcyjnej bazie.

Build tworzy `build/matdraw-php/public/` i `build/matdraw-php/backend/`. To istniejący skrypt pakujący gotowy kod, nie tworzenie aplikacji na nowo. Użyj dedykowanego katalogu build: skrypt odtwarza jego `public/`.

Wdróż wygenerowane wydanie. Katalogiem domeny ma być jego `public/`; `backend/` pozostaje poza dostępem WWW. Zachowaj `.htaccess`. Źródłowy `dist/` działa jako demo; build przełącza aplikację na prawdziwe API. Pliki źródłowe, testy i dokumenty trenera nie należą do katalogu publicznego.

## 4. Skonfiguruj hosting i uruchom pipeline

Wykonaj kroki z `INSTALL-PL.md`: PHP, MySQL, HTTPS, ustawienia aplikacji i uprawnienia. `MATDRAW_CONFIG` może wskazywać plik PHP z konfiguracją poza wydaniem; alternatywnie użyj `backend/config.php` w wydaniu. Konfiguracja z sekretami musi przetrwać kolejne aktualizacje i pozostać poza repozytorium oraz artefaktem. Zachowuj `app_key` i bazę między wydaniami.

Tylko przy pierwszej instalacji utwórz pustą bazę i pierwszego Administratora przez `backend/bin/install.php`. Instalator nie jest migratorem i nie powinien działać przy każdym deployu. Jeżeli na serwerze są już dane, zachowaj je wraz z konfiguracją i wykonaj kopię przed aktualizacją.

Pipeline ma uruchomić testy, zbudować wydanie i dostarczyć je na wskazany hosting. Skorzystaj z mechanizmu wdrażania dostępnego na tym hostingu. Udokumentuj ponowne uruchomienie deployu i powrót do poprzedniego wydania. Jeśli jakąś czynność może wykonać wyłącznie właściciel hostingu lub repozytorium, podaj mu dokładnie ten krok.

Po wdrożeniu sprawdź odpowiedź aplikacji/API, HTTPS i logowanie. Zweryfikuj zapis danych na środowisku testowym, jeśli jest dostępne. Podaj adres aplikacji, wynik pipeline'u oraz wynik wykonanych sprawdzeń. Zakończ po wdrożeniu i jego weryfikacji; ewentualne dalsze prace wymagają osobnego zlecenia.
