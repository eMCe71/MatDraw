# Pochodzenie paczki

MatDraw / MEDUCASE. Eksport przygotowany 30.10.2026, instrukcje uproszczone tego samego dnia do wdrożenia przez CI/CD. Paczka nadaje się zarówno do Claude Code w przeglądarce, jak i do VS Code.

Kod aplikacji, testy, zasoby i skrypt build pochodzą z commita `af9f62fed6f1616bd28d36f5db9d9851e3bcd100` i pozostały niezmienione. Uproszczenie dotyczy wyłącznie dokumentacji: `HANDOFF.md`, `START-PROMPT.txt`, `README.md`, `INSTALL-PL.md`, tego opisu i sum kontrolnych.

Usunięto z instrukcji zlecenie szerokiego przeglądu, dalszego rozwoju i dodatkowych prac nad funkcjami oraz przestarzałe polecenie publikacji przez Sites. Zachowano opis znanych ograniczeń i oryginalny dokument trenera jako materiały referencyjne.

Paczka nie zawiera historii Git, konfiguracji projektu Sites, sekretów ani bazy produkcyjnej. Jest źródłem dla CI/CD. Artefakt na hosting przygotowuje istniejący `scripts/build-php.mjs`; nie publikuj całego repozytorium jako katalogu domeny.

Jeżeli zaczynasz w Claude Code w przeglądarce, możesz wgrać ZIP do prywatnego repozytorium `Meducase/MatDraw` i zlecić jego rozpakowanie oraz deploy. Polecenie startowe znajduje się w `START-PROMPT.txt`. Zachowaj pliki ukryte przy rozpakowaniu.

`CHECKSUMS.sha256` opisuje zawartość tego eksportu z wyjątkiem samego manifestu. Integralność sprawdzisz poleceniem `sha256sum -c CHECKSUMS.sha256` w katalogu paczki.
