# MatBravo (MatDraw) — przekazanie właścicielowi i kolejnej sesji

Dokument jest pisany dla właściciela, który nie jest programistą, i dla każdego, kto przejmie projekt. Mówi, **co jest zrobione, co musisz zrobić Ty, w jakiej kolejności i jakimi poleceniami**, na które pytania trzeba odpowiedzieć przed startem płatności, oraz jak awaryjnie wyłączyć czat albo zwolnić jego tempo bez wdrożenia. Szczegóły techniczne są w `README.md` (po angielsku), instalacja w `INSTALL-PL.md`, wdrożenie i kopie w `DEPLOY-PL.md`, wyniki testów w `VALIDATION.md`. Pełny plan z uzasadnieniem decyzji: `docs/plan/PLAN-CZAT-PLATNOSCI-PWA.md`.

Rozmawiaj po polsku. Repozytorium: `eMCe71/MatDraw`. Domena: `matbravo.com`.

## 1. Stan na dziś

**Gotowe (w gałęzi integracyjnej `claude/quirky-einstein-sgelzm`):**

- publiczny czat: cztery kanały globalne (Taekwondo Świat, Taekwondo Polska, Karate Świat, Ogólny) i czat każdego turnieju; czytać może każdy, pisać mogą zalogowani z pełnym dostępem; goście i niepłacący nie widzą żadnych danych autorów;
- konta członków z profilem (imię, nazwisko, nazwa użytkownika, kraj, sporty, zdjęcie) i samodzielna rejestracja w 3 krokach;
- płatne konta przez Stripe (8,99 zł / mies. w Polsce, 2,99 USD / mies. gdzie indziej), konta darmowe z decyzji Administratora, panel „Członkowie”, moderacja czatu;
- aplikacja na telefon (PWA): instalacja, praca bez internetu (strona „Brak połączenia”), pasek aktualizacji;
- wdrożenie przez GitHub Actions z kopią bazy przed migracją, ochroną przed złym powrotem do starej wersji i weryfikacją po wdrożeniu;
- wszystkie dotychczasowe funkcje turniejowe bez zmian (zapisy, kontrola startowa, drabinki, wyniki, wydruki, ekran hali, PL | EN).

**Wszystko, co nowe, jest domyślnie wyłączone.** Po wdrożeniu bez zmian w `config.php`: nie ma rejestracji ani płatności, kluby logują się jak dotąd, czat jest do czytania, a pisać mogą tylko osoby z kont personelu. Nic się nie włączy samo.

**Do `main` (a więc na produkcję) trafia jedno scalenie po końcowym przeglądzie.** Do tego czasu `matbravo.com` działa na poprzedniej wersji. Decyzję o scaleniu i wypchnięciu podejmuje właściciel. Każde scalenie do `main` wdraża stronę, więc rób to w dzień bez zawodów.

**Czego nie sprawdzono, bo da się to sprawdzić tylko na prawdziwym serwerze albo koncie Stripe** (lista z wynikami: `VALIDATION.md`, sekcja „Tylko na prawdziwym serwerze”): GD z WebP na web9, wychodzące HTTPS do `api.stripe.com`, odpowiedź 403 dla webhooków, dostępność crona, limity żądań hostingu przy wielu telefonach naraz, instalacja aplikacji na polskim iPhonie, ustawienia konta Stripe.

## 2. Co musisz zrobić — po kolei

Każdy krok ma polecenia do skopiowania. Polecenia z `/usr/local/php83/bin/php` wykonujesz przez SSH na serwerze (domyślne `php` w SSH to wersja 8.1, a aplikacja potrzebuje 8.3).

1. **Repozytorium.** Rozstrzygnięte: środowisko `production` z sekretami `SSH_*` ma `eMCe71/MatDraw` (kroki 1–2 w `DEPLOY-PL.md`). Starsze dokumenty z `Meducase/MatDraw` i `matdraw.mdcse.com` są nieaktualne.

2. **Odpowiedz na pytania z sekcji 3**, zwłaszcza na cztery **bramki startu** (P2, P3, P8/P21, P19). Wdrożenie na nie nie czeka, ale **włączenie rejestracji i wymuszania płatności tak**.

3. **Wdrożenie w dzień bez zawodów.** Scal gałąź do `main` (albo uruchom workflow na `main`). Pierwsze wdrożenie wyloguje wszystkich jeden raz (sesje przenoszą się do nowego katalogu). Potem w GitHub: **Actions → Test, build i deploy → Run workflow**, zaznacz **„Tylko sprawdź połączenie SSH i serwer”** i uruchom. W wyniku sprawdź:
   - PHP 8.3 i rozszerzenia (`gd` z WebP, `curl`, `openssl`, `intl`, `exif`);
   - `mysqldump` (albo `mariadb-dump`) i `crontab`;
   - linie „Prawo bazy …: tak” (ALTER, CREATE, INDEX, REFERENCES);
   - linię „Stripe:” — ma być „osiągalny”. Jeśli jest „NIEOSIĄGALNY”, płatności na tym hostingu nie zadziałają: zgłoś to do AfterMarket (albo rozważ zmianę hostingu). Reszta aplikacji działa bez tego.
   - W panelu AfterMarket odczytaj swój plan (Start/Biznes/Pro) i zapisz go w tym pliku.

4. **Uprawnienia bazy.** Użytkownik bazy musi mieć ALTER, CREATE, INDEX i REFERENCES. DirectAdmin zwykle daje je domyślnie; krok 3 to pokazuje. Ewentualnie `db_migrate` w `config.php` (`INSTALL-PL.md`, Załącznik A).

5. **Kopie zapasowe (przed startem płatności).**
   - DirectAdmin → **Advanced Features → Cron Jobs**, raz na dobę (np. 3:17):

     ```
     /usr/local/php83/bin/php /home/meducase/domains/matbravo.com/backend/bin/dump.php --auto
     ```

   - Zapytaj AfterMarket, jak często i jak długo przechowują własne kopie konta i jak je przywrócić.
   - Raz w miesiącu pobierz `~/matdraw/backups` na własny dysk (polecenie `scp` w `DEPLOY-PL.md`).

6. **Stripe w trybie testowym.**
   - W panelu Stripe (tryb testowy): **Developers → API keys → Create restricted key**, nazwa „MatBravo serwer”; uprawnienia: Customers — Write; Checkout Sessions — Write; Customer portal — Write; Subscriptions — Write; Prices i Products — Read; Invoices — Read; Events — Read; reszta — None. Powstaje klucz `rk_test_…`.
   - Przez SSH:

     ```bash
     /usr/local/php83/bin/php ~/domains/matbravo.com/backend/bin/stripe-setup.php --mode=test
     ```

     Skrypt poprosi o pełny klucz `sk_test_…` w **ukrytym polu** (nic nie widać podczas wklejania). **Nigdy nie wpisuj klucza w samym poleceniu.**
   - Wypisany blok wklej do `~/matdraw/shared/config.php`, jako `stripe_secret_key` wpisz klucz **ograniczony** `rk_test_…`, a potem `chmod 600 ~/matdraw/shared/config.php`.
   - W panelu Stripe przy kluczu tajnym wybierz **Roll key** — klucz `sk_`, który wkleiłeś do skryptu, przestaje działać. Na serwerze zostaje tylko klucz ograniczony.

7. **Ustawienia w panelu Stripe** (osobno dla trybu testowego i na żywo): nazwa „MatBravo”, opis na wyciągu `MATBRAVO`, logo i kolory; karty, Apple Pay i Google Pay włączone, Link wyłączony; Smart Retries, a po ostatniej nieudanej próbie anulowanie subskrypcji; e-maile o nieudanej płatności i o 3DS oraz paragony; „Limit customers to one subscription” włączone; Adaptive Pricing wyłączone; Tax wyłączony do czasu konsultacji prawnej.

8. **Okno testów** (tylko Ty możesz się zarejestrować). W `~/matdraw/shared/config.php` dopisz:

   ```php
   'billing_enabled' => true,
   'billing_mode' => 'test',
   'billing_enforce' => true,
   'signup_enabled' => false,
   'signup_invite_token' => 'LOSOWE_32_ZNAKI',
   'support_email' => 'pomoc@matbravo.com',
   ```

   Blok z kroku 6 (`stripe_secret_key` z kluczem `rk_test_…`, ceny, portal) musi już być w pliku, inaczej aplikacja odpowie błędem 500. Token wygenerujesz poleceniem `/usr/local/php83/bin/php -r 'echo bin2hex(random_bytes(16)), PHP_EOL;'`. Po zapisaniu pliku odśwież stronę: jeśli widzisz błąd 500, kombinacja ustawień jest niedozwolona (usuń dopisane linie). Potem:
   - zalogowany jako Administrator, otwórz w przeglądarce `https://matbravo.com/api/index.php?route=diagnostics&probe=stripe`; w odpowiedzi `"stripe":{"reachable":true,…}` oznacza, że serwer widzi Stripe (limit: 6 sprawdzeń na godzinę). Panelu graficznego dla tej diagnostyki nie ma;
   - zarejestruj konto z linku `https://matbravo.com/#signup?invite=TOKEN`, zapłać kartą testową `4242 4242 4242 4242` (każda data w przyszłości, dowolny CVC), sprawdź płatność z 3DS, portal klienta (anulowanie na koniec okresu), usunięcie konta;
   - nowe konta personelu zakładane w tym oknie oznaczaj jako darmowe („Darmowe konto”).

9. **Start (tryb na żywo).** Powtórz krok 6 z `--mode=live` (klucze `sk_live_…` i `rk_live_…`, potem Roll key), w `config.php` zmień `billing_mode` na `'live'` i klucz na `rk_live_…`. Zrób jedną własną płatność i zwróć ją w panelu Stripe. Usuń konta testowe w panelu **Członkowie**. Dopiero wtedy: `'signup_enabled' => true`, usuń linię `signup_invite_token`. To jest start. (Odpowiedzi na bramki z sekcji 3 muszą być gotowe.)

10. **(Opcjonalnie) webhooki Stripe.** Hosting odpowiada 403 na adresy centrów danych, więc Stripe zwykle nie dostarczy powiadomień; płatności działają poprawnie także bez nich. Treść zgłoszenia do AfterMarket jest w `DEPLOY-PL.md` (Stripe, punkt 6). Dopiero po potwierdzeniu: `stripe-setup.php --mode=… --webhook` i „Send test event” w panelu Stripe.

11. **(Opcjonalnie) dodatkowe wpisy crona** (przyspieszają porządki i synchronizację płatności; bez nich wszystko działa, tylko wolniej się odświeża):

    ```
    */5 * * * *  /usr/local/php83/bin/php /home/meducase/domains/matbravo.com/backend/bin/cron.php
    */20 * * * * /usr/local/php83/bin/php /home/meducase/domains/matbravo.com/backend/bin/stripe-sync.php --events --due
    37 3 * * *    /usr/local/php83/bin/php /home/meducase/domains/matbravo.com/backend/bin/stripe-sync.php --reconcile
    ```

12. **Test obciążenia z zewnątrz** (po pierwszym wdrożeniu, przed startem), z laptopa albo telefonu w trybie hotspotu — **nie z serwera i nie z GitHub** (hosting odpowiada im 403):

    ```bash
    curl -sI https://matbravo.com/sw.js
    curl -sI https://matbravo.com/manifest.webmanifest
    bash scripts/poll-probe.sh https://matbravo.com 5 600
    ```

    `sw.js` ma mieć typ JavaScript i `Cache-Control: no-cache`, manifest typ `application/manifest+json`. Sonda to 5 równoległych „czytelników” czatu przez 10 minut; **kryterium: zero odpowiedzi 429/503/508**. W tym czasie w DirectAdmin obserwuj **Resource Usage**. Jeśli pojawią się 429/503/508, zgłoś wynik AfterMarket i ustaw tempo czatu „Oszczędne” (sekcja 6).

13. **(Etap 2, opcjonalnie) BLIK cykliczny:** e-mail do Stripe Support z konta MEDUCASE, po starcie.

14. **Ręczna kontrola na telefonie** (według listy w `docs/plan/PLAN-CZAT-PLATNOSCI-PWA.md`, §11, punkty 1–11): instalacja na Androidzie, dodanie do ekranu początkowego na iPhonie (arkusz z instrukcją jest do sprawdzenia na polskim iPhonie, zwłaszcza dopisek o iOS 26), logowanie w zainstalowanej aplikacji, powrót ze Stripe, tryb samolotowy, ekran hali.

### Kolejność włączania ustawień (macierz)

| Etap | `signup_enabled` | `signup_invite_token` | `billing_enabled` | `billing_enforce` | Co widzi gość |
|---|---|---|---|---|---|
| Po wdrożeniu (domyślnie) | `false` | brak | `false` | `false` | „Zaloguj się, aby pisać”, bez rejestracji |
| Okno testów (krok 8) | `false` | ustawiony | `true`, `billing_mode='test'` | `true` | jak wyżej; rejestracja tylko z linku z tokenem |
| Start (krok 9) | `true` | usunięty | `true`, `billing_mode='live'` | `true` | „Załóż konto · 8,99 zł / mies.” |
| Darmowa beta (tylko świadomie) | `true` + `signup_free_beta=true` | brak | `false` | `false` | „Załóż konto” bez ceny |

Inne kombinacje aplikacja odrzuca błędem 500 (opis w `INSTALL-PL.md`, Załącznik A).

## 3. Pytania do właściciela i przyjęte odpowiedzi

Żadne pytanie nie blokuje implementacji: kod obsługuje obie odpowiedzi, a w tabeli jest wartość, którą przyjęto, dopóki nie zdecydujesz inaczej. **Pytania oznaczone „BRAMKA STARTU” muszą mieć Twoją odpowiedź, zanim włączysz wymuszanie płatności i rejestrację** (kroki 8–9).

| # | Pytanie | Przyjęto domyślnie |
|---|---|---|
| P1 | Które repozytorium ma środowisko `production` z sekretami SSH? | Rozstrzygnięte: `eMCe71/MatDraw` |
| **P2** | **BRAMKA STARTU.** Czy obecne konta klubów i sędziów (admin/edytor/reprezentant) mają płacić i od kiedy? Czy nowe konta personelu są domyślnie płatne? | Obecne konta są darmowe przejściowo, do Twojej decyzji; „Członkowie → Wymagaj płatności od…” ustawia datę (co najmniej 14 dni w przód; baner 14 dni wcześniej, potem 7 dni karencji). Nowe konta personelu są płatne, chyba że zaznaczysz „Darmowe konto” |
| **P3** | **BRAMKA STARTU.** Jak długo czat turnieju przyjmuje wiadomości i kto czyta go dzień po turnieju i w archiwum? (To zawęża „czytać może każdy”.) | Pisanie do 23:59 dnia po turnieju; gość widzi czat turnieju tak długo jak podgląd turnieju (do dnia zawodów włącznie); dzień po turnieju i archiwum tylko dla zalogowanych |
| P4 | Progi moderacji? | Ukrycie po 3 zgłoszeniach różnych osób; oryginały usuniętych albo zgłoszonych wiadomości 30 dni; wiadomości przechowywane 365 dni |
| P5 | Przypięta wiadomość organizatora? | Dopiero wersja 1.1 |
| P6 | Kraj autora: font z flagami czy kod? | Kod kraju (`PL`) |
| P7 | Domyślny sposób pokazywania nazwiska? | Imię i inicjał nazwiska („Marta K.”); pełne nazwisko tylko po zaznaczeniu przez członka (wielu zawodników jest niepełnoletnich) |
| **P8** | **BRAMKA STARTU.** Wysyłka e-maili (weryfikacja adresu, reset hasła)? | Wersja 1 bez e-maili; hasło resetuje Administrator według procedury z sekcji 4; e-maile (dostawca SMTP z SPF/DKIM) w etapie 2 |
| P9 | Usuwać nieopłacone, porzucone konta? | Tak, po 30 dniach bez logowania, bez historii płatności, wiadomości i zgłoszeń; tylko przy wymuszonych płatnościach |
| P10 | Czy goście widzą zdjęcia profilowe? | Nie |
| P11 | Awans członka na przedstawiciela klubu? | Nie w wersji 1; osobne konto personelu od Administratora |
| P12 | Anonimowe liczniki instalacji aplikacji? | Nie w wersji 1 |
| P13 | Stripe Link i BLIK cykliczny? | Link wyłączony; o BLIK cykliczny prosimy Stripe po starcie |
| P14 | Karencja po nieudanym odnowieniu i po końcu darmowego okresu? | 7 dni w obu przypadkach; Smart Retries, po ostatniej próbie anulowanie |
| P15 | Długość sesji członka? | 14 dni bezczynności, 30 dni maksymalnie; personel bez zmian (30 min / 12 h) |
| P16 | Czy rejestracja może ruszyć przed wymuszeniem płatności (darmowa beta)? | Nie: rejestracja razem z wymuszaniem płatności po testach na żywo; Twoje testy idą przez token zaproszeń |
| P17 | Czy niepłacący zalogowani czytają archiwa turniejów (z ukrytymi autorami)? | Tak |
| P18 | Kolejne kanały globalne (np. Judo)? | Tylko cztery kanały; nowe dodaje migracja |
| **P19** | **BRAMKA STARTU.** Prezentacja ceny: brutto, VAT, OSS, KSeF? | Pokazujemy „8,99 zł / mies.” i „$2.99 / month” jako cenę końcową; podatki i dokumenty ustali sesja prawna **przed** włączeniem `billing_enforce` |
| P20 | Czy waluta wynika z kraju w profilu, bez wyboru przez użytkownika? | Tak (Polska → 8,99 zł, inne kraje → 2,99 USD); Administrator może zmienić walutę konta bez trwającej subskrypcji |
| **P21** | **BRAMKA STARTU.** Jaki adres pomocy pokazujemy przy „Nie pamiętasz hasła?” i kto go obsługuje? | Adres w domenie MatBravo (np. `pomoc@matbravo.com`) obsługiwany przez Administratora; bez `support_email` rejestracja się nie włączy |
| P22 | Usunięcie konta przy trwającej subskrypcji? | Kończy subskrypcję od razu, bez zwrotu za bieżący okres, po wyraźnym potwierdzeniu; zasady zwrotów ustali sesja prawna |

**Dokumenty prawne są poza tym zakresem** (wymaganie 8): regulamin, polityka prywatności, prawo odstąpienia od umowy, zasady zwrotów, ochrona małoletnich i podatki (P19, P22) trzeba przygotować w osobnej sesji prawnej **przed** `billing_enforce=true`. W formularzu rejestracji zarezerwowano miejsce na zgody; tekstów jeszcze nie ma.

## 4. Odzyskiwanie dostępu do konta (procedura Administratora)

Aplikacja nie wysyła e-maili, więc hasło resetuje Administrator. Panel „Nie pamiętasz hasła?” mówi członkowi: „Napisz z adresu, na który założono konto, na {adres pomocy}. Odpowiemy tylko na ten adres.”

1. Prośba musi przyjść **z adresu zapisanego w koncie**. Nie odpowiadaj na żaden inny adres i **nie resetuj hasła na prośbę telefoniczną ani przez komunikator**.
2. W panelu **Członkowie** znajdź konto i wybierz **„Ustaw hasło tymczasowe”**. Serwer pokaże 16-znakowe hasło **jeden raz**.
3. Wyślij hasło **na adres skopiowany z panelu Członkowie**, a nie z pola „Od” otrzymanej wiadomości (to pole da się podrobić; odpowiedź na adres z konta dotrze tylko do właściciela skrzynki).
4. Przy koncie płatnym możesz dodatkowo poprosić o numer paragonu Stripe widoczny w szczegółach płatności konta.

Po zalogowaniu hasłem tymczasowym członek musi ustawić własne hasło (aplikacja sama go do tego prowadzi); do tego czasu nie może pisać na czacie. Każdy reset, zmiana adresu e-mail, blokada i usunięcie konta trafia do dziennika konta z nazwą Administratora. Hasło **personelu** (edytor, reprezentant klubu) resetujesz w „Konta i role” według tych samych zasad (wiadomość z adresu konta, odpowiedź na ten adres).

Konflikt adresu e-mail (ktoś założył konto na cudzy adres, bo adresy nie są weryfikowane): procedura w `DEPLOY-PL.md`, sekcja „Konflikt adresu e-mail”. Nigdy nie mów nikomu, czy dany adres ma konto.

## 5. Co ujawniają znaczniki `g` i `c` w czacie dla gościa

Gość i osoba niezalogowana albo bez pełnego dostępu widzi wiadomość bez imienia, inicjałów, nazwy użytkownika, zdjęcia, kraju i klubu. Zamiast tego widzi **zaprojektowany placeholder**: okrągły „awatar” i pasek na miejscu nazwy. Dwa znaczniki są jednak w danych celowo:

- `g` — jeden z 5 wariantów wyglądu placeholdera. Wariant zależy od autora, kanału **i dnia**, więc wiadomości jednej osoby w jednym kanale tego samego dnia wyglądają tak samo. Ten sam wariant mają średnio co piąta osoba, więc to nie jest identyfikator;
- `c` — „ta wiadomość jest od tej samej osoby co poprzednia” (mniej niż 5 minut odstępu).

**Co to oznacza w praktyce:** gość może zauważyć, że kilka kolejnych wiadomości napisała jedna osoba (w jednym kanale, jednego dnia). **Nie dowie się, kim jest**, nie powiąże jej wiadomości z innym kanałem ani z innym dniem, nie zobaczy jej danych. To świadomy kompromis (decyzja D6): wariant losowany osobno dla każdej wiadomości sprawiałby, że jedna rozmowa wyglądałaby jak rozmowa wielu osób. Sama treść wiadomości jest publiczna (taka była decyzja produktowa), dlatego pole wiadomości przypomina, żeby nie pisać danych dzieci ani numerów telefonów, a w zgłoszeniach jest powód „Dane osobowe lub wizerunek dziecka”.

## 6. Wyłączenie czatu i strojenie tempa — bez wdrożenia

- **Awaryjnie, przez SSH** (działa natychmiast, jeszcze przed bazą; czat odpowiada „Czat jest chwilowo wyłączony”):

  ```bash
  touch ~/matdraw/shared/chat-off
  ```

  Włączenie z powrotem: `rm ~/matdraw/shared/chat-off`. To samo robi `'chat_force_off' => true,` w `config.php`.
- **Na co dzień, w panelu Administratora:** **Moderacja → Ustawienia czatu**. Wyłącznik czatu, **tempo odświeżania** (presety „Normalne” — co 2,5 s przy aktywnym oglądaniu, „Oszczędne” — co 5 s, „Awaryjne” — co 15 s; bezczynne karty zwalniają same do 60 s i więcej) oraz komunikat dla wszystkich. Zmiany docierają do każdej otwartej karty przy najbliższym odświeżeniu. Preset nie zmienia się sam; po zawodach wróć do „Normalnego”.
- **Co patrzeć:** w tym samym miejscu jest „Odpowiedzi hostingu w ostatniej godzinie” (zgłaszają je przeglądarki, bo hosting odrzuca żądania, zanim dotrą do aplikacji; jedno zgłoszenie na minutę i rodzaj odpowiedzi z jednego adresu gościa lub konta, w nim najwyżej 10 odpowiedzi; przed zgłoszeniem do AfterMarket potwierdź problem w DirectAdmin → Resource Usage). Gdy jest ponad 50 odpowiedzi 429 w godzinie (albo kilka 503/508), przełącz na „Oszczędne”; gdy to nie pomaga, na „Awaryjne”.
- **Limity rejestracji i logowania w dniu zawodów** (wiele telefonów ma jeden adres IP): jeśli ludzie widzą „Zbyt wiele prób…”, dopisz w `config.php` np. `'signup_limit_ip_hour' => 100,` i `'login_limit_ip' => 300,`; po zawodach usuń te linie (`DEPLOY-PL.md`, „Limity w dniu zawodów”).
- **Wyłączenie wszystkiego, co nowe, jednym ruchem:** usuń dopisane linie z `config.php` (wracają ustawienia domyślne: bez rejestracji i płatności). Przerwa techniczna na czas przywracania bazy: `touch ~/matdraw/shared/maintenance` (i `rm` po zakończeniu — `DEPLOY-PL.md`).

## 7. Etapy 2 i 3 — zaprojektowane, nie zbudowane

Obecny czat odpytuje serwer, czy jest coś nowego (krótkie zapytanie, zwykle odpowiedź „nic nowego” o rozmiarze kilkuset bajtów). To wystarcza dla kilkuset czytelników jednocześnie. Gdyby hosting zaczął odrzucać zapytania (429) albo czytelników było znacznie więcej, są dwa dalsze kroki, **żaden nie wchodzi w to wdrożenie**:

- **Etap 2: „beacon” — statyczny plik.** Serwer zapisuje po każdej nowej wiadomości mały plik z numerem zmiany, a przeglądarki pytają o ten plik zamiast o PHP (hosting obsłuży go bez uruchamiania aplikacji). Wymaga pomiarów na web9 (czy plik jest serwowany bez PHP, czy nie ma 429, jak działa pamięć podręczna) i dowiązania katalogu `live` przy wdrożeniu. Dochodzą też e-maile (reset hasła, weryfikacja) jako osobny etap.
- **Etap 3: zewnętrzny push (Ably/Pusher, UE).** Zewnętrzna usługa wysyła samo „jest coś nowego”, bez treści. Wymaga zmiany CSP (`connect-src`), umowy powierzenia przetwarzania danych (DPA) i decyzji właściciela; sensowne dopiero przy setkach jednoczesnych czytelników.

Nie ma wskaźników „ktoś pisze” ani licznika obecnych osób; wiadomości prywatnych i zdjęć w czacie nie przewidziano.

## 8. Zasady pracy dla kolejnej sesji Claude Code

- Aplikacja jest zaimplementowana i przetestowana. Zachowaj jej funkcje, reguły sportowe, role, wygląd i branding MEDUCASE oraz blokady spornych kategorii. Naprawiaj tylko usterki uniemożliwiające poprawne lub bezpieczne działanie; inne uwagi zanotuj krótko, bez rozszerzania zadania.
- Wdrożenie idzie wyłącznie przez GitHub Actions (`DEPLOY-PL.md`); na produkcję trafia tylko `main`. Nie wdrażaj ręcznie plików na serwer i nie edytuj `~/matdraw/shared/config.php` bez wiedzy właściciela. Sekrety (hasło bazy, `app_key`, klucze Stripe) nie trafiają do repozytorium ani do sekretów GitHub; w testach buduj wartości przez sklejanie tekstu, żeby GitHub nie odrzucił pusha.
- Testy: `node --check` i `node --test tests/*.test.mjs` (bez `PHP_BIN` testy PHP są pomijane), testy HTTP wyłącznie przez `bash scripts/test-http.sh <port> <baza>` na jednorazowej bazie — **nigdy na bazie produkcyjnej**; skrypty wdrożenia: `bash tests/deploy/deploy-script-test.sh <port> <baza>`. Raportuj pominięcia. Opis w `README.md` i `VALIDATION.md`.
- Nowe teksty interfejsu: polski klucz w `T()` i jeden wpis angielski w słowniku funkcji (`dist/i18n/*-en.js`); `tests/i18n.test.mjs` pilnuje kompletności i kolizji.
- Nowa migracja bazy: tylko dodawanie (nowy plik `backend/migrations/NNNN_nazwa.php`); `tests/migrations.test.mjs` pilnuje zgodności z MariaDB 10.6 i MySQL 8.0. Niszczące migracje uruchamia się ręcznie po kopii.
- Dokument trenera w `references/` i opis ograniczeń reguł (README) to materiał referencyjny, nie zlecenie dodatkowych prac.

## 9. Znane ograniczenia

- Diagnostyka serwera dla Administratora (`route=diagnostics`) jest dostępna tylko jako adres API (krok 8); nie ma dla niej ekranu w panelu.
- Testy przeglądarkowe (Playwright) w CI są osobnym zadaniem informacyjnym: nie blokują wdrożenia.
- Bez e-maili: weryfikacji adresów przy rejestracji nie ma (stąd procedura konfliktu adresów), reset hasła robi Administrator.
- Webhooki Stripe najpewniej nie dojdą (blokada hostingu); stan subskrypcji jest pobierany ze Stripe przy płatności, przy logowaniu i w tle (opóźnienie do kilkunastu minut zamiast sekund).
- Nie zbudowano: Web Push, liczników instalacji, wiadomości prywatnych, przypiętej wiadomości, flag krajów (zamiast nich kod `PL`), awansu członka na przedstawiciela klubu, rozszerzenia kanałów o inne sporty.
- Licznik nieprzeczytanych wiadomości przy kanale może chwilowo pokazywać za dużo, jeśli nieprzeczytaną wiadomość usunął moderator albo ukryło ją zgłoszenie. Poprawia się sam przy następnej nowej wiadomości w kanale. Pełna poprawka wymaga zmiany protokołu odpytywania i jest odłożona.
- Czat pełnoekranowy nie ma osobnej obsługi klawiatury ekranowej na iPhonie (testy działały tylko w Chromium). Przed startem sprawdź pisanie w czacie na prawdziwym iPhonie (krok 14).
- Wymagania tylko dla prawdziwego serwera i telefonu są wypisane w `VALIDATION.md`. Tam są też końcowe wyniki testów, ręcznej kontroli i końcowego przeglądu.
