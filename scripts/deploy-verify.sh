#!/usr/bin/env bash
# Checks the deployed site from the CI runner: HTTPS certificate, start page, API mode and API session.
# Env: APP_URL; PREVIOUS (empty on the first deploy, when a missing certificate or an uninitialised
# database are warnings because there is nothing to roll back to).
set -uo pipefail
failed=0
error(){ echo "::error::$*"; failed=1; }
problem(){ if [[ -z ${PREVIOUS:-} ]]; then echo "::warning::$*"; else error "$*"; fi; }
k=()
if ! curl -sS -o /dev/null --max-time 20 "$APP_URL/" 2>curl.err; then
 if grep -qiE 'certificate|SSL' curl.err; then
  problem "HTTPS: brak ważnego certyfikatu dla $APP_URL ($(head -1 curl.err)). DirectAdmin wystawia go automatycznie (Certyfikaty SSL/TLS). Dalsze sprawdzenia bez weryfikacji certyfikatu."
  k=(-k)
 else
  error "Brak połączenia z $APP_URL: $(head -1 curl.err)"; exit 1
 fi
fi
page=$(curl -sS "${k[@]}" -o page.html -w '%{http_code}' --retry 3 --retry-delay 5 "$APP_URL/")
if [[ $page == 429 ]]; then error "Serwer hostingu zwraca 429 Too Many Requests dla $APP_URL (blokada po stronie AfterMarket, zob. DEPLOY-PL.md)."; exit 1; fi
if [[ $page != 200 ]] || ! grep -q '<title>MatBravo' page.html; then error "Strona startowa: kod $page, brak tytułu MatBravo."; fi
curl -sS "${k[@]}" "$APP_URL/runtime-config.js" | grep -q "mode:'api'" || error "runtime-config.js nie jest w trybie API."
api=$(curl -sS "${k[@]}" -o api.json -w '%{http_code}' "$APP_URL/api/index.php?route=session")
if [[ $api == 200 ]] && grep -q '"csrf"' api.json; then
 echo "API odpowiada poprawnie (200)."
elif grep -q '^{"error"' api.json; then
 problem "API działa (PHP odpowiada), ale zwraca $api: $(head -c 200 api.json). Przy pierwszym wdrożeniu uruchom instalator bazy (DEPLOY-PL.md, krok 6) i uruchom workflow ponownie."
else
 error "API nie odpowiada w formacie JSON (kod $api). Sprawdź PHP 8.3 dla domeny w DirectAdmin. Początek odpowiedzi: $(head -c 200 api.json | tr '\n' ' ')"
fi
[[ $failed == 0 ]] && echo "Weryfikacja zakończona."
exit $failed
