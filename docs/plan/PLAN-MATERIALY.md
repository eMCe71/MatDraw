# Materiały turnieju: plakat i regulamin

Prośba: Mistrz Wojciech Dolny (współzałożyciel inicjatywy MatBravo) chce „mądrze dodawać plakaty do turniejów”. Właściciel dołożył
„regulamin per turniej”. Oba to materiały konkretnego turnieju, więc mają wspólne uprawnienia, przechowywanie i wyświetlanie.

Założenie: „regulamin” to dokument zawodów od organizatora (PDF: regulamin, komunikat organizacyjny). Osobne reguły kategorii
(wagi, wiek) dla turnieju to inna, dużo większa zmiana silnika i nie wchodzą tutaj.

## 1. Co dostaje użytkownik

**Organizator, edytor, Administrator** (każdy, kto zarządza turniejem: `Domain::manages`):
- w oknie turnieju (nowy i ustawienia) sekcja **„Materiały”**: kafel plakatu i wiersz regulaminu;
- **plakat**: wybór zdjęcia z telefonu albo przeciągnięcie pliku (JPG, PNG, WebP; zdjęcie z iPhone'a też, bo przeglądarka
  dekoduje je sama). Przeglądarka sama obraca zdjęcie według EXIF, zmniejsza do 2400 px na dłuższym boku i kompresuje
  (WebP, inaczej JPEG), więc nawet 12-megapikselowe zdjęcie plakatu z telefonu idzie szybko. Pasek postępu, podgląd,
  „Zmień”, „Usuń”. Plakatu nigdy nie przycinamy (plakaty mają tekst przy krawędziach);
- **regulamin**: PDF do limitu (domyślnie 10 MB, mniej, jeśli serwer przyjmuje mniej); nazwa, rozmiar, „Otwórz”, „Zmień”, „Usuń”;
- przy **nowym turnieju** wybrane pliki czekają i wysyłają się zaraz po utworzeniu turnieju (bez drugiego otwierania okna);
- na karcie turnieju zarządzający bez plakatu widzi dyskretny kafel „Dodaj plakat”.

**Wszyscy (gość, zawodnik, rodzic, klub)** tam, gdzie turniej już jest widoczny:
- karta turnieju, lista „Nadchodzące turnieje” na stronie głównej, strona turnieju dla gościa (`#guest?t=`), „Moje starty”
  (otwarte turnieje i własne zgłoszenia), okno zgłoszenia;
- miniatura plakatu w stałym pionowym kadrze 3:4, dopasowana bez przycinania (contain) na tle w **dominującym kolorze
  plakatu** (liczony na serwerze), więc karty mają równą wysokość niezależnie od kształtu plakatu;
- dotknięcie plakatu otwiera **podgląd pełnoekranowy** (dialog: zamknij Escape/przyciskiem, „Pobierz plakat”, focus w
  dialogu); na stronie turnieju dla gościa plakat jest dużym obrazem u góry;
- **„Regulamin (PDF, 1,2 MB)”** jako wyraźny przycisk; w oknie zgłoszenia link „Przeczytaj regulamin zawodów” (bez
  zgód i tekstów prawnych: to sesja prawna właściciela).

**Administrator** usuwa plakat lub regulamin każdego turnieju (nadużycie) tym samym przyciskiem „Usuń”.

Nie w tym wydaniu (do decyzji później): PDF jako plakat (wymaga pdf.js ~2 MB), podgląd linku z plakatem w Messengerze/
Facebooku (Open Graph; hosting odpowiada 403 serwerom centrów danych, najpierw trzeba sprawdzić, czy robot Facebooka w ogóle
dostanie stronę), generator plakatu z szablonu z kodem QR do zapisów, link do zewnętrznego regulaminu.

## 2. Kontrakt (backend ↔ frontend), wiążący

### 2.1 Dane
- Kolumna `tournaments.materials TEXT NULL` (migracja **0009_materials**: tylko `ADD COLUMN`, idempotentna, bez „floor”: stary
  kod ignoruje kolumnę; składnia zgodna z lintem `tests/migrations.test.mjs`; migracja nie zmienia żadnego istniejącego wiersza).
- Wewnętrznie (PHP `$db`, JS `workspace.js`) turniej ma opcjonalne `materials`:
  `{"poster":{"f":"<32 hex>.webp|jpg","w":int,"h":int,"c":"#rrggbb","at":int},"rules":{"f":"<32 hex>.pdf","b":int,"at":int}}`
  (każdy klucz opcjonalny; brak obu = `materials` nieobecne / NULL). `f` nigdy nie wychodzi do klienta.
- **Na zewnątrz** (każdy widok turnieju: `Domain::publicData` / `publicWorkspace`, `GuestView` (lista i `public-tournament`),
  `AthleteView` (otwarte turnieje i zgłoszenia)) pola **rzadkie** (nieobecne, gdy brak):
  - `poster: {v:'<12 hex>', w:int, h:int, color:'#rrggbb'}`
  - `rules: {v:'<12 hex>', size:int}`
  - `v` = pierwsze 12 znaków hasha pliku. Demo (`workspace.js`) dodaje `src` (adres pliku lub data URL) do `poster` i `rules`.
- Klient buduje adresy (`dist/materials.js`): plakat `api/index.php?route=material&t=<id>&k=poster&s=sm|lg&v=<v>`,
  regulamin `api/index.php?route=material&t=<id>&k=rules&v=<v>`; w demo `src`.

### 2.2 Trasy (backend/routes/materials.php)
| Trasa | Metoda, auth | Wejście | Wyjście |
|---|---|---|---|
| `poster-upload` | POST, `upload`, typy `image/jpeg`, `image/png`, `image/webp`, max `Materials::posterMax($c)` (4 MB, nie więcej niż limit serwera) | `?t=<id>`, surowe bajty | jak `command`: `{workspace, result:{poster:{v,w,h,color}}}` |
| `rules-upload` | POST, `upload`, typ `application/pdf`, max `Materials::rulesMax($c)` (10 MB, nie więcej niż `post_max_size` − 64 KB) | `?t=<id>`, surowe bajty | `{workspace, result:{rules:{v,size}}}` |
| `material-delete` | POST, `session`, JSON | `{t, kind:'poster'\|'rules'}` | `{workspace, result:{}}` |
| `material` | GET, `peek`, user optional | `?t, k=poster\|rules, s=sm\|lg (plakat), v` | plik albo 404 |

- Uprawnienia zapisu: `Domain::manages(actor, t)` pod blokadą przestrzeni (`Repository::transaction` + `Domain::execute` typu
  `tournament.material`); członek-organizator jak w `command`: `caps.organizer`, `Auth::stepUp`, pełny dostęp (402 w trybie
  płatnym), `MemberTx`; personel bez pełnego dostępu 402. Limity: `material-upload` 30/h, `material-delete` 60/h na konto.
  Stare pliki usuwane po zatwierdzeniu transakcji.
- Trasa `command` **odrzuca** typ `tournament.material` (400 „Niepoprawna operacja.”): wartość ustawia wyłącznie serwer.
- Odczyt (`material`): turniej istnieje i (patrzący nim zarządza **albo** status ≠ `draft`, `hidden_by` puste i twórca nie
  jest zablokowany). Każda odmowa to ten sam 404. Nagłówki: ETag z `v`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin`;
  publiczny → `Cache-Control: public, max-age=31536000, immutable`, tylko dla zarządzających → `private, …`. Obraz:
  `image/webp|jpeg`, `Content-Security-Policy: default-src 'none'; sandbox`. PDF: `application/pdf`,
  `Content-Disposition: inline; filename="regulamin-<slug>.pdf"` (bez sandbox, bo blokuje przeglądarkę PDF).
- `me.features.materials`: `{poster:int, rules:int}` (maksymalne bajty; `poster:0`, gdy GD wyłączone lub katalog uploadów
  niezapisywalny; `rules:0`, gdy katalog niezapisywalny). Demo: `{poster: 4194304, rules: 10485760}`.

### 2.3 Przetwarzanie (backend/src/Materials.php, wzór: `Avatars.php`)
- Plakat: format po treści (JPEG/PNG/WebP, nigdy SVG/GIF), bok 200–4096 px, ≤ 12 Mpx, kontrola pamięci jak w `Avatars`;
  orientacja EXIF; przezroczystość na białym; wyjście `lg` (dłuższy bok ≤ 2000 px, bez powiększania) i `sm` (mieści się w
  480×720) jako WebP 80 albo JPEG 85 (`Capabilities::avatarMode`); kolor = średni kolor obrazu; nazwa = 32 hex SHA-256 pliku `lg`.
- Regulamin: `%PDF-` w pierwszych 1024 bajtach, `%%EOF` w ostatnich 2048, rozmiar ≤ max; plik zapisywany bez zmian.
- Pliki: `<uploads>/materials/<h[0..1]>/<h>/<hash>-lg.<ext>`, `-sm.<ext>`, `<hash>.pdf`, gdzie `h` = 32 hex SHA-256 id turnieju
  (żadna ścieżka z żądania); katalogi 0700, pliki 0600, zapis atomowy.
- Sprzątanie w zadaniu kont (jak `Avatars::sweep`): pliki nieużywane i starsze niż dzień, katalogi turniejów, których już nie ma.

### 2.4 Domena (PHP i lustro JS, testy zgodności)
`tournament.material` `{id, kind:'poster'|'rules', value: meta|null}`: `manages` albo 403/404 jak `tournament.save`; ścisła
walidacja `meta`; ustawia/usuwa `materials[kind]`; stempluje rewizję turnieju; zwraca `{kind, previous: f|null}`.
Nie należy do `ORGANIZER_TYPES` (tylko trasy materiałów). Demo: `src` w meta zamiast `f`, z obrazem zmniejszonym w przeglądarce.

## 3. Podział pracy
- **backend**: migracja, `Materials.php`, trasy, `Repository` (load/snapshot/organizerSnapshot/guest/persist), `Domain` + lustro
  `dist/workspace.js` (w tym seed demo: plakat `./demo/poster-demo.webp` (`w` 1240, `h` 1754) i regulamin `./demo/regulamin-demo.pdf`
  przy turnieju `t-autumn-2026`), `GuestView`, `AthleteView`, `me.features.materials`, odmowa w `command`, sprzątanie, testy
  PHP/HTTP/zgodności/migracji, dokumentacja serwerowa.
- **frontend**: `dist/materials.js`, UI w oknie turnieju, karty, strona gościa, lista nadchodzących, „Moje starty”, okno zgłoszenia,
  podgląd pełnoekranowy, demo (pliki `dist/demo/poster-demo.webp` 1240×1754 i `dist/demo/regulamin-demo.pdf`), i18n EN, testy
  przeglądarkowe (demo; część na wersji PHP pisana pod kontrakt i uruchamiana po scaleniu), telefony bez poziomego przewijania.

## 4. Zmiana kontraktu (właściciel, w trakcie pracy): regulamin jako PDF **albo** tekst

Organizator wybiera rodzaj regulaminu: **PDF** albo **tekst** wpisany w polu. Turniej ma najwyżej jeden regulamin; zapis
jednego rodzaju zastępuje drugi.
- Wewnętrznie: `materials.rules` = `{"f":"<32 hex>.pdf","b":int,"at":int}` (PDF) **albo** `{"t":"<tekst>","at":int}` (tekst).
- Na zewnątrz: `rules: {v:'<12 hex>', size:int, type:'pdf'|'text'}`; `size` = bajty PDF albo liczba znaków tekstu; `v` =
  12 hex SHA-256 pliku albo tekstu. Tekstu **nie ma** w `publicData`/`GuestView`/`AthleteView` (rozmiar odpowiedzi); demo
  (`workspace.js`) trzyma go w `rules.text`.
- Nowa trasa `rules-text`: POST, `session`, JSON `{t, text}` → `{workspace, result:{rules:{v,size,type:'text'}}}`; tekst po
  `Text::clean` z zachowaniem nowych linii (CRLF → LF, najwyżej 2 puste linie z rzędu), 1–20 000 znaków; pusty = błąd
  („Wpisz treść regulaminu albo usuń regulamin.”). Te same uprawnienia i limity co `rules-upload` (`material-upload`).
- `material` z `k=rules` dla tekstu: `text/plain; charset=utf-8`, `inline`, `nosniff`, `Content-Security-Policy: default-src
  'none'; sandbox`, te same zasady dostępu i pamięci podręcznej.
- `tournament.material` z `kind:'rules'` przyjmuje meta PDF albo tekstu (ścisła walidacja); zwraca `previous` (plik PDF do
  usunięcia albo null).
- Frontend: w sekcji „Materiały” przełącznik **PDF / Tekst**; tekst w polu (16 px na telefonie) z licznikiem znaków, prostą
  ściągą formatowania i podglądem. Wyświetlanie (bez HTML od użytkownika, tylko węzły z escapowaniem): pusta linia = nowy
  akapit, `## ` = nagłówek, `- ` lub `• ` = punkt listy, `1. ` = lista numerowana, adresy `https://…` jako linki
  (`rel="noopener noreferrer nofollow ugc"`, nowa karta). „Regulamin” otwiera czytelny dialog (na telefonie pełny ekran);
  tekst pobierany z trasy `material` (w demo z `rules.text`). PDF otwiera się jak wcześniej.

## 5. Przegląd niezależny (2026-11-02) i rozstrzygnięcia

Przegląd bezpieczeństwa, poprawności i UX (także ataki na działający serwer: SVG udający PNG, bomba pikselowa, HTML udający
PDF, `t=../..`, cudzy turniej, plakat szkicu jako gość, `<script>` i `javascript:` w tekście): bez uwag blokujących i poważnych.
Cztery drobne, wszystkie poprawione z testami, które bez poprawki nie przechodzą:

| # | Uwaga | Rozstrzygnięcie |
|---|---|---|
| 1 | Kafel „Dodaj plakat” na kartach pojawiał się dopiero po ponownym narysowaniu strony (po wczytaniu `me`) | `cardPoster`: kafel także przed wczytaniem danych konta (jak `available()`); test zaraz po zalogowaniu i po przeładowaniu |
| 2 | Wklejenie obrazka w dowolne pole okna („Kopiuj obraz” daje plik i text/html) podmieniało plakat | Wklejanie działa tylko w sekcji „Materiały” i nigdy w polu tekstowym; test z wklejeniem do nazwy turnieju |
| 3 | Usunięcie konta zostawiało materiały turniejów tej osoby w bazie i na dysku | `Domain::forgetMember` usuwa `materials` każdego turnieju utworzonego przez tę osobę; pliki usuwa `Materials::sweep` (nieużywane, starsze niż dzień) |
| 4 | Każde wczytanie przestrzeni pod blokadą czyściło ponownie wszystkie zapisane teksty regulaminów | Ścisła kontrola tekstu tylko przy zapisie; widoki i trasa `material` sprawdzają tanio (UTF-8, brak znaków usuwanych przy zapisie), w PHP i JS; sprzątanie czyta tylko wiersze z materiałami |

Do sprawdzenia po wdrożeniu (niezweryfikowane lokalnie): czy `Header always set Content-Security-Policy` z `.htaccess` nie
nadpisuje na LiteSpeed nagłówka `default-src 'none'; sandbox`, który PHP ustawia dla obrazów i tekstu (ten sam wzór mają
zdjęcia profilowe; `nosniff` i typy inne niż HTML chronią niezależnie). Sprawdzenie: `curl -sI` na adres plakatu.
