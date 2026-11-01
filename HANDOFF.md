# MatBravo (MatDraw) — przekazanie właścicielowi i kolejnej sesji

Dokument jest pisany dla właściciela, który nie jest programistą, i dla każdego, kto przejmie projekt. Mówi, **co jest zrobione, co musisz zrobić Ty, w jakiej kolejności i jakimi poleceniami**, na które pytania trzeba odpowiedzieć przed startem płatności, oraz jak awaryjnie wyłączyć czat albo zwolnić jego tempo bez wdrożenia. Szczegóły techniczne są w `README.md` (po angielsku), instalacja w `INSTALL-PL.md`, wdrożenie i kopie w `DEPLOY-PL.md`, wyniki testów w `VALIDATION.md`. Pełny plan z uzasadnieniem decyzji: `docs/plan/PLAN-CZAT-PLATNOSCI-PWA.md` (czat, płatności, aplikacja na telefon) i `docs/plan/PLAN-REJESTRACJA-ROLE.md` (otwarta rejestracja, role, samodzielne zgłoszenia). **Najnowsze wydanie opisuje sekcja 0.**

Rozmawiaj po polsku. Repozytorium: `eMCe71/MatDraw`. Domena: `matbravo.com`.

## 0. Wydanie z rolami „Organizator” i „Zawodnik” — zacznij tutaj

To wydanie dodaje otwartą rejestrację z dwiema rolami i samodzielne zgłoszenia do turniejów. **Po wdrożeniu nic się nie zmienia dla nikogo**, dopóki Ty, jako Administrator, nie otworzysz rejestracji w panelu, z jednym wyjątkiem: **od wdrożenia ekran logowania ma link „Nie pamiętasz hasła?” z adresem `hello@matbravo.com`** (patrz sekcja 0.7, więc skrzynka musi istnieć przed scaleniem). Do `config.php` nie musisz niczego dopisywać.

### 0.1 Co jest nowe

- **Rejestracja w panelu.** Administrator → **Ustawienia → „Rejestracja nowych kont”**: trzy tryby, **„Wyłączona”**, **„Otwarta, bezpłatna”** i **„Otwarta, płatna”**. Zmiana działa od razu, bez wdrożenia i bez SSH. Na starcie jest „Wyłączona”.
- **Organizator turnieju.** Przy zakładaniu konta (albo później w **Moje konto → Role**) każdy może zaznaczyć „Organizator turnieju”. Taka osoba tworzy **własne** turnieje, dodaje **własnych** zawodników, prowadzi kontrolę startową, losowania i wyniki. Widzi **tylko swoje** turnieje i swoich zawodników. Nie widzi bazy zawodników, cudzych turniejów ani cudzych zgłoszeń. Jej turniej od razu ma własny adres do wysłania zawodnikom (przycisk „Kopiuj link do zapisów”) i plakietkę „Turniej społeczności”.
- **Zawodnik.** Zaznaczenie „Zawodnik” dodaje krótki formularz: kogo zgłaszasz (siebie albo swoje dziecko lub podopiecznego), data urodzenia, waga, wzrost, stopień, klub (z listy, nowy albo „Niezrzeszony”). **Jedno konto ma jeden profil zawodnika.** Osoba poniżej 16 lat nie założy profilu „Siebie”; zrobi to rodzic lub opiekun na swoim koncie. Na stronie **„Moje starty”** zawodnik widzi swoje zgłoszenia, status (przyjęte, czeka na kontrolę, obecność, losowanie, wynik), miejsce w drabince, wycofania oraz **„Otwarte turnieje”**, do których może się zgłosić. Zgłosić się można tylko do turnieju, w którym włączono **„Zawodnicy mogą zgłaszać się sami”**.
- **Kluby.** Administrator ma nową stronę **Kluby**: weryfikacja klubów dodanych przez użytkowników, zmiana nazwy, scalanie dubli, nazwy oczekujące. Niezweryfikowany klub nie jest publiczny.
- **Członkowie.** Znaczniki (organizator, potwierdzony, zablokowany, zawodnik, konto z okresu bezpłatnego), filtry, potwierdzanie i odbieranie roli organizatora, blokada zbiorcza.
- Drobne zmiany: kanał **Taekwondo Polska jest pierwszy** na liście czatu, kanały światowe mają ikonę globu, strona główna jest wyśrodkowana na bardzo szerokich ekranach.

### 0.2 Jak otworzyć rejestrację (po kolei)

1. **Załóż skrzynkę `hello@matbravo.com`** w panelu AfterMarket (może to być przekierowanie na Twój adres) i wyślij na nią próbną wiadomość. To adres, który aplikacja pokazuje każdemu, kto zapomni hasła (**od samego wdrożenia**, nie dopiero po otwarciu rejestracji, patrz sekcja 0.7); prośby o reset hasła trafiają właśnie tam, a odpowiadasz na nie według procedury z sekcji 4. Jeśli skrzynka już istnieje (krok 1 z sekcji 0.7), tu tylko ją sprawdź.
2. **Zrób sesję prawną przed otwarciem** (zalecenie, decyzja należy do Ciebie): rejestracja otwiera serwis dla dzieci i rodziców, więc potrzebne są polityka prywatności, regulamin, zgoda opiekuna i okres przechowywania danych (w kodzie 24 miesiące od ostatniego turnieju). Aplikacja ma przygotowane puste miejsca na zgody; tekstów jeszcze nie ma. Szczegóły w sekcji 3, ostatni akapit.
3. Zaloguj się jako Administrator → **Ustawienia**. Sprawdź **„Adres pomocy”** (ma być `hello@matbravo.com`).
4. W **„Rejestracja nowych kont”** wybierz **„Otwarta, bezpłatna”** i kliknij **„Zapisz tryb rejestracji”**. Pojawi się „Zapisano ustawienia.”, a w „Historii zmian” nowy wpis. Gdyby napis „Obowiązuje teraz: …” pokazywał inny tryb niż wybrany, coś ogranicza ustawienie (na przykład `signup_force_off` albo brak konfiguracji Stripe); wtedy przeczytaj czerwony baner na tej stronie.
5. Wyloguj się i sprawdź jako gość: karta **„Załóż konto”** na stronie logowania, rejestracja z polem „Zawodnik” na telefonie, wejście na „Moje starty”.
6. **W każdym turnieju, do którego mają się zgłaszać sami zawodnicy**, otwórz **Ustawienia turnieju** i zaznacz **„Zawodnicy mogą zgłaszać się sami”**. Po aktualizacji to pole jest wyłączone we wszystkich dotychczasowych turniejach. Nowe turnieje organizatorów mają je włączone od razu, nowe turnieje personelu wyłączone.
7. Później (dopiero po konfiguracji Stripe, kroki 6–9 sekcji 2): **Ustawienia → „Sprawdź Stripe”**, potem **„Otwarta, płatna”**. Uwaga na kolejność: **od pierwszego zapisu w panelu (krok 4) wartości `billing_enforce` i `signup_enabled` z `config.php` przestają działać**, więc okno testów płatności z kroku 8 sekcji 2 (token zaproszeń w pliku) trzeba wtedy przeprowadzić przez panel, jak opisano w tym kroku 8. Aplikacja zapyta, co zrobić z kontami założonymi w okresie bezpłatnym: zostawić im darmowy dostęp albo wymagać płatności od wybranej daty (co najmniej 14 dni w przód; potem baner i 7 dni karencji). Przełączenie z płatnej na bezpłatną jest zawsze możliwe, ale osoby z aktywną subskrypcją dalej płacą, dopóki ich subskrypcji nie zatrzymasz.

### 0.3 Jak z tego korzystają organizatorzy i zawodnicy

**Organizator:** zakłada konto z zaznaczonym „Organizator turnieju” (albo włącza rolę w Moje konto → Role) → w menu pojawiają się jego **Turnieje** → „Nowy turniej” (domyślnie „Zapisy otwarte”, samodzielne zgłoszenia włączone) → „Kopiuj link do zapisów” i wysyła zawodnikom → dodaje własnych zawodników (dla osoby poniżej 16 lat zaznacza zgodę rodzica lub opiekuna) → w dniu zawodów robi kontrolę startową (przy zgłoszeniach własnych widzi znaczniki „Zgłoszenie własne”, „Klub niezweryfikowany”, „Niezrzeszony” i może poprawić klub), losowanie, wyniki i ekran hali. Narzędzia **proszą o hasło po 30 minutach bezczynności** i najpóźniej co 12 godzin; to normalne. Roli nie da się wyłączyć, dopóki ma turnieje z otwartymi lub zamkniętymi zapisami. Limity: 3 nowe turnieje na dobę, 10 opublikowanych nadchodzących. Status „Zakończony” można ustawić dopiero w dniu turnieju. W nazwach nie wolno podawać adresów stron, e-maili ani długich numerów.

**Zawodnik lub rodzic:** zakłada konto z „Zawodnik” → **Moje starty** → „Zgłoś się” przy otwartym turnieju (można też wejść z linku od organizatora albo z podglądu turnieju) → wybiera konkurencje i potwierdza. Zgłoszenie można poprawić i wycofać, dopóki zapisy są otwarte, a kategoria nie ma zapisanego losowania. Po zamknięciu zapisów nieobecność oznacza organizator przy kontroli. W trybie płatnym nowe zgłoszenie wymaga aktywnego konta, ale **wycofanie, poprawka własnego zgłoszenia i usunięcie własnych danych działają zawsze**. Maile nie są wysyłane: o wszystkim informuje strona „Moje starty” (łącznie z komunikatem „Zgłoszenie wycofane przez organizatora/Administratora”).

### 0.4 Dwa przełączniki, o które możesz zapytać

- **„Zawodnicy mogą zgłaszać się sami”** (przy każdym turnieju, w Ustawieniach turnieju) — decyduje, czy w tym turnieju w ogóle można się zgłosić samemu. Wyłączony przełącznik = zgłoszenia tylko przez klub, edytora, organizatora albo Administratora jak dotąd.
- **„Wymagaj potwierdzenia organizatorów”** (Ustawienia → Organizatorzy). **Domyślnie wyłączone — to Twoja decyzja z założenia „pełnej automatyki”**: każdy niezablokowany organizator działa od razu tak samo jak potwierdzony (jego turnieje są na stronie głównej i w czacie, przyjmują zgłoszenia osób niepełnoletnich). Po włączeniu: turnieje **niepotwierdzonych** organizatorów są dostępne tylko pod własnym adresem (nie ma ich na stronie głównej ani w lobby czatu), a osoby poniżej 18 lat nie zgłoszą się do nich same, dopóki nie klikniesz **„Potwierdź organizatora”** (Członkowie → filtr „Organizatorzy do potwierdzenia”, licznik przy menu, albo na karcie turnieju). Włącz ten przełącznik, gdy zauważysz nadużycia albo chcesz zacząć ostrożniej. Obok jest **„Publikowanie turniejów przez nowych organizatorów: Włączone / Wstrzymane”**; wstrzymanie działa tylko na niepotwierdzonych, więc ma sens razem z włączonym potwierdzaniem.

### 0.5 Kluby i Członkowie — codzienna kontrola

- **Kluby** (menu Administratora): „Niezweryfikowane” — klub dodany przez użytkownika; kliknij **„Zweryfikuj”**, zmień nazwę albo **„Scal z…”** (gdy to dubel istniejącego klubu; scalenia nie można cofnąć). **„Oczekujące nazwy klubów”** — zawodnicy, którzy przy wyczerpanym dziennym limicie zostali zapisani jako „Niezrzeszeni”; „Utwórz klub i przypisz” robi z nich klub. W publicznych drabinkach niezweryfikowany klub nie ma nazwy.
- **Członkowie**: filtr „Organizatorzy do potwierdzenia”, „Potwierdź organizatora” / „Cofnij potwierdzenie”, **„Odbierz rolę organizatora”** (z opcją ukrycia jego nadchodzących turniejów), „Zablokuj konto”, a dla wielu naraz zaznaczenie wierszy i **„Zablokuj i ukryj turnieje”**.
- **Karta turnieju** (Administrator): „Pokaż organizatora”, **„Ukryj turniej”** z powodem (organizator go widzi) i „Przywróć”.
- **Ustawienia → Historia zmian**: ostatnie 50 zdarzeń (ustawienia, organizatorzy, kluby, ukrycia turniejów, usunięcia danych).

### 0.6 Wyłączniki awaryjne (od najlżejszego)

1. **Ukryj turniej** albo **odbierz rolę** pojedynczemu organizatorowi (sekcja 0.5).
2. **Włącz „Wymagaj potwierdzenia organizatorów”** i/lub **wstrzymaj publikowanie** (sekcja 0.4) — przy fali fałszywych turniejów.
3. **Zamknij rejestrację:** Ustawienia → **„Wyłączona”**. Zalogowani dalej korzystają z serwisu; nikt nowy się nie zarejestruje.
4. **Panel nie działa:** przez SSH dopisz w `~/matdraw/shared/config.php` linię `'signup_force_off' => true,` (działa od razu, bez wdrożenia; panel pokaże czerwony baner). Cofasz usunięciem tej linii.
5. Czat: `touch ~/matdraw/shared/chat-off`; przerwa techniczna: `touch ~/matdraw/shared/maintenance` (sekcja 6). **Powrót do starej wersji kodu po pojawieniu się danych społeczności jest blokowany** (strażnik „floor”, `DEPLOY-PL.md`): błąd poprawia się nowym wdrożeniem.

### 0.7 Wdrożenie tego wydania

Scal gałąź do `main` w **dzień bez zawodów**. Pipeline sam zrobi kopię bazy, uruchomi migracje 0007–0009 (tylko dodają kolumny i tabele; schemat v6 → v9), przełączy wydanie i sprawdzi stronę. Bez zmian w `config.php` (poza opcjonalnym `support_email`). **Przed scaleniem:**

1. **Załóż skrzynkę `hello@matbravo.com`** (może być przekierowanie na Twój adres) albo wpisz w `config.php` klucz `'support_email'` z istniejącą skrzynką. Gdy w pliku nie ma `support_email`, obowiązuje `hello@matbravo.com` **od chwili wdrożenia**, jeszcze przed jakimkolwiek zapisem w panelu: publiczna konfiguracja zwraca go, a ekran logowania pokazuje link „Nie pamiętasz hasła?” z tym adresem (dotąd takiego linku nie było). Ludzie zaczną tam pisać, więc skrzynka musi działać już po pierwszym wdrożeniu.

Po wdrożeniu aplikacja na telefonie pokaże pasek „Dostępna jest nowa wersja”. Jeśli kiedykolwiek wgrywałeś na produkcję przykładowych zawodników (`seed-athletes`), uruchom ten skrypt raz po aktualizacji (`INSTALL-PL.md`, „Przykładowi zawodnicy”), bo kluby demo zostają wtedy zweryfikowane. Sprawdź po wdrożeniu: logowanie klubu i Administratora jak dotąd, czat (Taekwondo Polska pierwszy), strona „Ustawienia” (tryb „Wyłączona”), strona „Kluby”.

### 0.8 Znane ograniczenia tego wydania

- **Jeden profil zawodnika na konto.** Rodzic z dwójką dzieci musi mieć dwa konta (dwa adresy e-mail). Kod potrafi więcej profili, ale limit 1 to Twoja decyzja; zmiana wymaga zmiany stałej w kodzie.
- **Teksty prawne i zgody są puste.** Są przygotowane miejsca w formularzach; do czasu sesji prawnej nie ma regulaminu, polityki prywatności ani treści zgody opiekuna. Organizator tylko oświadcza, że ma zgodę rodzica (pole wyboru).
- **Brak e-maili.** Nikt nie dostaje powiadomień ani potwierdzeń; adresów nie weryfikujemy. Rejestracja na zajęty adres pokazuje inny komunikat niż sukces, więc da się sprawdzić, czy adres ma konto (ograniczamy to limitami na sieć). Pełne rozwiązanie wymaga wysyłki e-maili.
- **Zawodnik nie wycofa się po zamknięciu zapisów** ani po losowaniu swojej kategorii; robi to organizator (oznacza nieobecność lub wycofuje zgłoszenie).
- **Profil dodany przez organizatora nie może zostać przejęty** przez zawodnika, który później założy własne konto (powstanie osobny profil).
- Lista „Otwarte turnieje” zawodnika pokazuje do 50 najbliższych; turniej z linku jest pokazywany zawsze, o ile jest otwarty.
- Przechowywanie danych społeczności: profile dodane przez organizatorów są anonimizowane po 24 miesiącach od ostatniego turnieju (wartość do potwierdzenia w sesji prawnej). Profil konta zawodnika zostaje, dopóki istnieje konto; właściciel może go usunąć („Usuń dane zawodnika”, z hasłem).
- Zgłoszenia w turniejach zakończonych albo z zapisanym losowaniem nie znikają przy usunięciu danych (zostają jako wynik). **Usunięcie konta samo w sobie nie usuwa nazwiska z takich zgłoszeń:** profil zawodnika zmienia się w „Dane usunięte”, ale pełne imię i nazwisko zostaje w zachowanym wyniku (widzą je personel i organizator turnieju; gość widzi tylko inicjały). Żeby nazwisko zniknęło, przed usunięciem konta użyj **„Usuń dane zawodnika”** (z hasłem) albo Administrator robi to w kartotece zawodnika (przycisk „Usuń dane zawodnika”, w Zawodnikach), zanim usunie konto w Członkowie: wtedy w zachowanych zgłoszeniach zostają inicjały. Obiecując rodzicowi usunięcie nazwiska dziecka, zrób to w tej kolejności.
- Każde polecenie turniejowe nadal ładuje cały zbiór danych pod jedną blokadą (wcześniejsze ograniczenie); dlatego zgłoszenia samodzielne mają wspólny limit 120 operacji na minutę dla wszystkich członków razem. Przy bardzo dużym ruchu zawodnik może zobaczyć „Serwer jest teraz mocno obciążony. Spróbuj ponownie za chwilę.”.
- To, co da się sprawdzić tylko na prawdziwym serwerze i telefonie (rejestracja z telefonu, lądowanie po płatności w Stripe, wydajność przy wielu zgłoszeniach naraz), jest wypisane w `VALIDATION.md`.

## 1. Stan na dziś

**Gotowe (w gałęzi integracyjnej `claude/quirky-einstein-sgelzm`):**

- publiczny czat: cztery kanały globalne (Taekwondo Świat, Taekwondo Polska, Karate Świat, Ogólny) i czat każdego turnieju; czytać może każdy, pisać mogą zalogowani z pełnym dostępem; goście i niepłacący nie widzą żadnych danych autorów;
- konta członków z profilem (imię, nazwisko, nazwa użytkownika, kraj, sporty, zdjęcie) i samodzielna rejestracja w 3 krokach;
- płatne konta przez Stripe (8,99 zł / mies. w Polsce, 2,99 USD / mies. gdzie indziej), konta darmowe z decyzji Administratora, panel „Członkowie”, moderacja czatu;
- aplikacja na telefon (PWA): instalacja, praca bez internetu (strona „Brak połączenia”), pasek aktualizacji;
- wdrożenie przez GitHub Actions z kopią bazy przed migracją, ochroną przed złym powrotem do starej wersji i weryfikacją po wdrożeniu;
- **role „Organizator turnieju” i „Zawodnik”, samodzielne zgłoszenia, panel „Ustawienia” (tryby rejestracji), strona „Kluby”** (sekcja 0);
- wszystkie dotychczasowe funkcje turniejowe bez zmian (zapisy, kontrola startowa, drabinki, wyniki, wydruki, ekran hali, PL | EN).

**Wszystko, co nowe, jest domyślnie wyłączone.** Po wdrożeniu bez zmian w `config.php` (i dopóki Administrator nie zapisze „Ustawień”): nie ma rejestracji ani płatności, kluby logują się jak dotąd, czat jest do czytania, a pisać mogą tylko osoby z kont personelu. Nic się nie włączy samo, poza linkiem „Nie pamiętasz hasła?” z adresem `hello@matbravo.com` na ekranie logowania (sekcja 0.7).

**Produkcja.** `matbravo.com` działa na `main` w wersji `a67ad42` (wdrożenie z 2026-10-31: czat, konta członków i płatności są na serwerze, ale wyłączone). **Wydanie z rolami (sekcja 0) trafia na produkcję jednym scaleniem do `main`**; decyzję o scaleniu podejmuje właściciel. Każde scalenie do `main` wdraża stronę, więc rób to w dzień bez zawodów.

**Czego nie sprawdzono, bo da się to sprawdzić tylko na prawdziwym serwerze albo koncie Stripe** (lista z wynikami: `VALIDATION.md`, sekcja „Tylko na prawdziwym serwerze”): odpowiedź 403 dla webhooków, to samo HTTPS do `api.stripe.com` i GD z WebP, ale z poziomu PHP działającego na stronie (z SSH już potwierdzone w uruchomieniu #71: PHP 8.3, GD z WebP, crontab, dostęp do `api.stripe.com`, prawa bazy), wpisy crona, limity żądań hostingu przy wielu telefonach naraz, instalacja aplikacji na polskim iPhonie, ustawienia konta Stripe.

## 2. Co musisz zrobić — po kolei

Każdy krok ma polecenia do skopiowania. Polecenia z `/usr/local/php83/bin/php` wykonujesz przez SSH na serwerze (domyślne `php` w SSH to wersja 8.1, a aplikacja potrzebuje 8.3).

1. **Repozytorium.** Rozstrzygnięte: środowisko `production` z sekretami `SSH_*` ma `eMCe71/MatDraw` (kroki 1–2 w `DEPLOY-PL.md`). Starsze dokumenty z `Meducase/MatDraw` i `matdraw.mdcse.com` są nieaktualne.

2. **Odpowiedz na pytania z sekcji 3**, zwłaszcza na cztery **bramki startu** (P2, P3, P8/P21, P19). Wdrożenie na nie nie czeka, ale **włączenie rejestracji i wymuszania płatności tak**. Dla rejestracji **bezpłatnej** liczą się przede wszystkim P8, P21 i sesja prawna z sekcji 0.2; P2 i P19 dotyczą płatności.

3. **Wdrożenie w dzień bez zawodów.** Przed scaleniem załóż skrzynkę `hello@matbravo.com` (sekcja 0.7). Scal gałąź do `main` (albo uruchom workflow na `main`). Sesje członków przeniesiono już do nowego katalogu przy wdrożeniu z 2026-10-31 (przebieg #69), więc to wydanie nikogo nie wyloguje. Pierwsze sprawdzenie serwera po SSH jest zrobione (przebieg #71, 2026-10-31, wyniki w `VALIDATION.md`); po tym wdrożeniu powtórz je jednym uruchomieniem (**Actions → Test, build i deploy → Run workflow**, zaznacz **„Tylko sprawdź połączenie SSH i serwer”**) i porównaj wynik:
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

8. **Okno testów** (tylko Ty możesz się zarejestrować). **Zanim zaczniesz, ustal, czy zapisałeś już cokolwiek w panelu „Ustawienia”.** Od pierwszego zapisu w panelu o płatnościach i rejestracji decyduje panel, a `billing_enforce` i `signup_enabled` z `config.php` są ignorowane; wtedy sam wpis w pliku nie włączy płatności i Checkout odpowie „Płatności nie są teraz wymagane.” (409). W `~/matdraw/shared/config.php` dopisz (tak w obu wariantach):

   ```php
   'billing_enabled' => true,
   'billing_mode' => 'test',
   'billing_enforce' => true,
   'signup_enabled' => false,
   'signup_invite_token' => 'LOSOWE_32_ZNAKI',
   'support_email' => 'hello@matbravo.com',
   ```

   (Aplikacja wymaga `support_email` w pliku, gdy ustawiony jest token zaproszeń; to ten sam adres, który i tak obowiązuje domyślnie.)

   **Wariant A (najprostszy): nic jeszcze nie zapisano w panelu.** Okno testów działa wtedy wprost z pliku, więc zrób je przed krokiem 4 z sekcji 0.2 (przed otwarciem rejestracji w panelu).

   **Wariant B: panel był już zapisany (np. „Otwarta, bezpłatna”).** Poza plikiem ustaw w panelu: **Ustawienia → „Wyłączona”**, zaznacz **„Płatności istniejących kont”** (przełącznik jest aktywny dopiero po udanym „Sprawdź Stripe”), kliknij **„Zapisz tryb rejestracji”** i potwierdź **„Potwierdzam tryb testowy”**. Jeśli istnieją konta z okresu bezpłatnego, aplikacja zapyta, co z nimi zrobić: na czas testów wybierz **„Zostaw im bezpłatny dostęp”**. Po testach zwróć panelowi właściwy tryb (krok 9).

   Blok z kroku 6 (`stripe_secret_key` z kluczem `rk_test_…`, ceny, portal) musi już być w pliku, inaczej aplikacja odpowie błędem 500. Token wygenerujesz poleceniem `/usr/local/php83/bin/php -r 'echo bin2hex(random_bytes(16)), PHP_EOL;'`. Po zapisaniu pliku odśwież stronę: jeśli widzisz błąd 500, kombinacja ustawień jest niedozwolona (usuń dopisane linie). Potem:
   - zalogowany jako Administrator, otwórz w przeglądarce `https://matbravo.com/api/index.php?route=diagnostics&probe=stripe`; w odpowiedzi `"stripe":{"reachable":true,…}` oznacza, że serwer widzi Stripe (limit: 6 sprawdzeń na godzinę). Panelu graficznego dla tej diagnostyki nie ma;
   - zarejestruj konto z linku `https://matbravo.com/#signup?invite=TOKEN`, zapłać kartą testową `4242 4242 4242 4242` (każda data w przyszłości, dowolny CVC), sprawdź płatność z 3DS, portal klienta (anulowanie na koniec okresu), usunięcie konta;
   - nowe konta personelu zakładane w tym oknie oznaczaj jako darmowe („Darmowe konto”).

9. **Start (tryb na żywo).** Powtórz krok 6 z `--mode=live` (klucze `sk_live_…` i `rk_live_…`, potem Roll key), w `config.php` zmień `billing_mode` na `'live'` i klucz na `rk_live_…`. Zrób jedną własną płatność i zwróć ją w panelu Stripe. Usuń konta testowe w panelu **Członkowie**. Dopiero wtedy usuń linię `signup_invite_token` z `config.php` i w panelu wybierz **Ustawienia → „Otwarta, płatna”** (aplikacja najpierw sprawdzi Stripe i zapyta o konta z okresu bezpłatnego). To jest start. `'signup_enabled' => true` w pliku nie jest już potrzebne. (Odpowiedzi na bramki z sekcji 3 muszą być gotowe.)

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

Inne kombinacje **w pliku** aplikacja odrzuca błędem 500 (opis w `INSTALL-PL.md`, Załącznik A). Tabela dotyczy wartości początkowych z pliku: od pierwszego zapisu w panelu „Ustawienia” rejestracją i wymuszaniem płatności steruje panel (sekcja 0), a w pliku zostają `billing_enabled`, `billing_mode` i klucze Stripe. Rejestracja **bezpłatna** (bez Stripe) jest teraz zwykłym trybem panelu „Otwarta, bezpłatna”; plik z `signup_free_beta` nie jest do tego potrzebny.

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
| P16 | Czy rejestracja może ruszyć przed wymuszeniem płatności (darmowa beta)? | **Zmienione decyzją właściciela (2026-11-01):** tak. Rejestracja może być otwarta i bezpłatna do czasu Stripe („Otwarta, bezpłatna” w panelu); przejście na płatną robi się w panelu, z decyzją o kontach z okresu bezpłatnego. Testy płatności z tokenem zaproszeń nadal są możliwe |
| P17 | Czy niepłacący zalogowani czytają archiwa turniejów (z ukrytymi autorami)? | Tak |
| P18 | Kolejne kanały globalne (np. Judo)? | Tylko cztery kanały; nowe dodaje migracja |
| **P19** | **BRAMKA STARTU.** Prezentacja ceny: brutto, VAT, OSS, KSeF? | Pokazujemy „8,99 zł / mies.” i „$2.99 / month” jako cenę końcową; podatki i dokumenty ustali sesja prawna **przed** włączeniem `billing_enforce` |
| P20 | Czy waluta wynika z kraju w profilu, bez wyboru przez użytkownika? | Tak (Polska → 8,99 zł, inne kraje → 2,99 USD); Administrator może zmienić walutę konta bez trwającej subskrypcji |
| **P21** | **BRAMKA STARTU.** Jaki adres pomocy pokazujemy przy „Nie pamiętasz hasła?” i kto go obsługuje? | **`hello@matbravo.com`** (domyślny adres w panelu „Ustawienia”, można go tam zmienić), obsługiwany przez Administratora; **skrzynka musi istnieć przed scaleniem wydania z rolami**, bo adres pokazuje się na ekranie logowania od wdrożenia (sekcja 0.7) |
| P22 | Usunięcie konta przy trwającej subskrypcji? | Kończy subskrypcję od razu, bez zwrotu za bieżący okres, po wyraźnym potwierdzeniu; zasady zwrotów ustali sesja prawna |

### Pytania z planu ról i przyjęte odpowiedzi

| # | Pytanie | Przyjęto |
|---|---|---|
| O3 | Od jakiego wieku zawodnik zakłada profil „Siebie”? | 16 lat; młodszych zgłasza rodzic lub opiekun na swoim koncie |
| O4 | Czy turnieje organizatorów od razu są na stronie głównej? | **Tak (Twoja decyzja o pełnej automatyce).** Przełącznik „Wymagaj potwierdzenia organizatorów” (domyślnie wyłączony) zawęża to do potwierdzonych |
| O6 | Czy w trybie płatnym zawodnik płaci za zgłoszenie? | Tak za nowe zgłoszenie; wycofanie, poprawka własnego zgłoszenia i usunięcie danych zawsze bezpłatnie |
| O7, O8 | Co z danymi po usunięciu konta zawodnika lub organizatora? | Profil usuwany albo anonimizowany („Dane usunięte”); wynik w zakończonym turnieju zostaje, a **nazwisko w nim zostaje po samym usunięciu konta** (gość widzi inicjały) i zamienia się w inicjały dopiero po „Usuń dane zawodnika” albo `profile.forget`; turnieje organizatora są ukrywane |
| O9 | Samodzielne zgłoszenia w istniejących turniejach | Wyłączone po aktualizacji; włączasz je w Ustawieniach każdego turnieju |
| O14 | Teksty prawne przed otwarciem rejestracji | Zalecane przed „Otwarta, bezpłatna”; Twoja decyzja |
| O17 | Kilku zawodników na jednym koncie | **Jeden profil na konto** (Twoja decyzja z 2026-11-01) |
| O18 | Czy osoby poniżej 18 lat zgłaszają się same do turniejów niepotwierdzonych organizatorów? | Nie (dotyczy tylko włączonego potwierdzania) |
| O20 | Jak długo przechowujemy dane społeczności? | 24 miesiące od ostatniego turnieju; do potwierdzenia w sesji prawnej |
| O21 | Jak często organizator podaje hasło? | Po 30 minutach bezczynności i co 12 godzin, jak personel |

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
- **Wyłączenie rejestracji:** Ustawienia → „Wyłączona” (sekcja 0.6); gdy panel nie działa, `'signup_force_off' => true,` w `config.php`. **Wyłączenie wszystkiego, co nowe, z pliku:** usuń dopisane linie z `config.php` (wracają ustawienia początkowe: bez rejestracji i płatności) — dotyczy to jednak tylko wartości, których panel jeszcze nie zapisał. Przerwa techniczna na czas przywracania bazy: `touch ~/matdraw/shared/maintenance` (i `rm` po zakończeniu — `DEPLOY-PL.md`).

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

- **Role, rejestracja, samodzielne zgłoszenia:** osobna lista w sekcji 0.8 (jeden profil na konto, puste teksty zgód, brak e-maili, wyliczanie istnienia konta po adresie e-mail).
- Diagnostyka serwera dla Administratora (`route=diagnostics`) jest dostępna tylko jako adres API (krok 8); nie ma dla niej ekranu w panelu.
- Testy przeglądarkowe (Playwright) w CI są osobnym zadaniem informacyjnym: nie blokują wdrożenia.
- Bez e-maili: weryfikacji adresów przy rejestracji nie ma (stąd procedura konfliktu adresów), reset hasła robi Administrator.
- Webhooki Stripe najpewniej nie dojdą (blokada hostingu); stan subskrypcji jest pobierany ze Stripe przy płatności, przy logowaniu i w tle (opóźnienie do kilkunastu minut zamiast sekund).
- Nie zbudowano: Web Push, liczników instalacji, wiadomości prywatnych, przypiętej wiadomości, flag krajów (zamiast nich kod `PL`), awansu członka na przedstawiciela klubu, rozszerzenia kanałów o inne sporty.
- Licznik nieprzeczytanych wiadomości przy kanale może chwilowo pokazywać za dużo, jeśli nieprzeczytaną wiadomość usunął moderator albo ukryło ją zgłoszenie. Poprawia się sam przy następnej nowej wiadomości w kanale. Pełna poprawka wymaga zmiany protokołu odpytywania i jest odłożona.
- Czat pełnoekranowy nie ma osobnej obsługi klawiatury ekranowej na iPhonie (testy działały tylko w Chromium). Przed startem sprawdź pisanie w czacie na prawdziwym iPhonie (krok 14).
- Wymagania tylko dla prawdziwego serwera i telefonu są wypisane w `VALIDATION.md`. Tam są też końcowe wyniki testów, ręcznej kontroli i końcowego przeglądu.
