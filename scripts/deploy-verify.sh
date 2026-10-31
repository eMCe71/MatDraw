#!/usr/bin/env bash
# Checks the deployed site. Runs on the server over SSH, because the hosting answers 403 to GitHub
# Actions addresses for every site of the account:  ssh host "APP_URL=… DOCROOT=… bash -s" < scripts/deploy-verify.sh
# Checks the HTTPS certificate, start page, API mode, database state and API session. The last line is
# ROLLBACK=true|false: true only for problems of the release itself. Hosting problems (HTTP 429, no
# connection, database unreachable) fail without a rollback, since the previous release would not help.
set -uo pipefail
failed=0 rollback=false
site=$(dirname "$DOCROOT")
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
php=/usr/local/php83/bin/php; [[ -x $php ]] || php=$(command -v php)
warn(){ echo "::warning::$*"; }
env_error(){ echo "::error::$*"; failed=1; }
error(){ echo "::error::$*"; failed=1; rollback=true; }
finish(){ [[ $failed == 0 ]] && echo "Weryfikacja zakończona."; echo "ROLLBACK=$rollback"; exit $failed; }
k=()
if curl -sS -o /dev/null --max-time 20 "$APP_URL/" 2>"$tmp/curl.err"; then
 echo "HTTPS: certyfikat ważny."
elif grep -qiE 'certificate|SSL' "$tmp/curl.err"; then
 warn "HTTPS: brak ważnego certyfikatu dla $APP_URL. DirectAdmin wystawia go automatycznie (Certyfikaty SSL/TLS). Dalsze sprawdzenia bez weryfikacji certyfikatu."
 k=(-k)
else
 env_error "Brak połączenia z $APP_URL: $(head -1 "$tmp/curl.err")"; finish
fi
page=$(curl -sS "${k[@]}" -o "$tmp/page.html" -w '%{http_code}' --retry 2 --retry-delay 3 "$APP_URL/")
if [[ $page == 429 ]]; then env_error "Hosting zwraca 429 Too Many Requests dla $APP_URL (zob. DEPLOY-PL.md)."; finish; fi
if [[ $page == 200 ]] && grep -q '<title>MatBravo' "$tmp/page.html"; then echo "Strona startowa: 200, MatBravo."; else error "Strona startowa: kod $page, brak tytułu MatBravo."; fi
curl -sS "${k[@]}" "$APP_URL/runtime-config.js" | grep -q "mode:'api'" || error "runtime-config.js nie jest w trybie API."
# Database state straight from the deployed backend: the API itself only reports a generic server error.
db=$(cd "$site" && "$php" 2>/dev/null <<'PHP' | sed -n 's/^.*DB://p' | tail -1
<?php
require 'backend/bootstrap.php';
try { $pdo = matdraw_database(matdraw_config()); } catch (Throwable $e) { exit('DB:error ' . get_class($e)); }
try { $pdo->query('SELECT revision FROM app_meta WHERE id=1'); echo 'DB:ready'; } catch (Throwable $e) { echo 'DB:empty'; }
PHP
)
api=$(curl -sS "${k[@]}" -D "$tmp/api.h" -o "$tmp/api.json" -w '%{http_code}' "$APP_URL/api/index.php?route=session")
pv=$(grep -i '^x-powered-by:' "$tmp/api.h" | cut -d' ' -f2- | tr -d '\r')
echo "PHP strony: ${pv:-nieznana (serwer nie podaje wersji)}"
grep -q '^{' "$tmp/api.json" || error "API nie odpowiada w formacie JSON (kod $api). Sprawdź PHP 8.3 dla domeny w DirectAdmin."
case $db in
 empty) warn "Baza danych jest pusta: uruchom jednorazowo instalator (DEPLOY-PL.md, krok 6) i ponów sprawdzenie." ;;
 ready) if [[ $api == 200 ]] && grep -q '"csrf"' "$tmp/api.json"; then echo "API: 200, sesja działa."; else error "API: kod $api mimo gotowej bazy. Początek odpowiedzi: $(head -c 200 "$tmp/api.json" | tr '\n' ' ')"; fi ;;
 *) env_error "Brak połączenia z bazą danych (${db:-brak odpowiedzi PHP}). Sprawdź dane bazy w ~/matdraw/shared/config.php." ;;
esac
finish
