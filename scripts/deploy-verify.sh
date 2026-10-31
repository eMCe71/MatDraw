#!/usr/bin/env bash
# Checks the deployed site from the CI runner: HTTPS certificate, start page, API mode and API session.
# Env: APP_URL; PREVIOUS (empty on the first deploy, when an uninitialised database is only a warning).
# Writes rollback=true to $GITHUB_OUTPUT only for problems of the release itself; hosting problems
# (HTTP 429, no connection) fail the check without a rollback, since the previous release would not help.
set -uo pipefail
failed=0 rollback=false
warn(){ echo "::warning::$*"; }
env_error(){ echo "::error::$*"; failed=1; }
error(){ echo "::error::$*"; failed=1; rollback=true; }
problem(){ if [[ -z ${PREVIOUS:-} ]]; then warn "$*"; else error "$*"; fi; }
finish(){
 [[ -n ${GITHUB_OUTPUT:-} ]] && echo "rollback=$rollback" >> "$GITHUB_OUTPUT"
 [[ $failed == 0 ]] && echo "Weryfikacja zakończona."
 exit $failed
}
k=()
if ! curl -sS -o /dev/null --max-time 20 "$APP_URL/" 2>curl.err; then
 if grep -qiE 'certificate|SSL' curl.err; then
  warn "HTTPS: brak ważnego certyfikatu dla $APP_URL ($(head -1 curl.err)). DirectAdmin wystawia go automatycznie (Certyfikaty SSL/TLS). Dalsze sprawdzenia bez weryfikacji certyfikatu."
  k=(-k)
 else
  env_error "Brak połączenia z $APP_URL: $(head -1 curl.err)"; finish
 fi
fi
page=$(curl -sS "${k[@]}" -o page.html -w '%{http_code}' --retry 3 --retry-delay 5 "$APP_URL/")
if [[ $page == 429 ]]; then env_error "Serwer hostingu zwraca 429 Too Many Requests dla $APP_URL: blokada po stronie AfterMarket, niezależna od wydania (zob. DEPLOY-PL.md)."; finish; fi
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
finish
