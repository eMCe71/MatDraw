#!/usr/bin/env bash
# Checks the deployed site. Runs on the server over SSH, because the hosting answers 403 to GitHub
# Actions addresses for every site of the account:  ssh host "APP_URL=… DOCROOT=… DEPLOY_BASE=… bash -s" < scripts/deploy-verify.sh
# Checks the HTTPS certificate, start page, API mode, database state and API session, then (plan §9.8) the PWA files
# and the release identity, the schema version against the code, the chat and me routes. The last line is
# ROLLBACK=true|false: true only for problems of the release itself. Hosting problems (HTTP 429/503/508, no
# connection, database unreachable) fail without a rollback, since the previous release would not help.
# Flag files first: with <shared>/maintenance (manual database restore) the API checks are skipped and ROLLBACK=false;
# with <shared>/chat-off or chat_force_off the chat answers 503 chat_off, which is accepted.
set -uo pipefail
failed=0 rollback=false maintenance=false chatoff=false
site=$(dirname "$DOCROOT")
# <base>/shared: from DEPLOY_BASE, else the directory of the real config.php the backend links to.
if [[ -n ${DEPLOY_BASE:-} ]]; then shared=$DEPLOY_BASE/shared; else shared=$(dirname "$(readlink -f "$site/backend/config.php" 2>/dev/null || echo "$site/backend/config.php")"); fi
backups=$(dirname "$shared")/backups
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
php=/usr/local/php83/bin/php; [[ -x $php ]] || php=$(command -v php)
warn(){ echo "::warning::$*"; }
env_error(){ echo "::error::$*"; failed=1; }
error(){ echo "::error::$*"; failed=1; rollback=true; }
finish(){ [[ $maintenance == true ]] && rollback=false; [[ $failed == 0 ]] && echo "Weryfikacja zakończona."; echo "ROLLBACK=$rollback"; exit $failed; }
# Hosting answers (rate limit, resource limits) are environment problems, never a reason to roll back.
hosting(){ case $1 in 429) env_error "Hosting zwraca 429 Too Many Requests ($2, zob. DEPLOY-PL.md)."; finish ;; 503|508) env_error "Hosting zwraca $1 ($2): limity zasobów konta (DEPLOY-PL.md, „Odpowiedzi hostingu 429/503”)."; return 0 ;; 000) env_error "Brak odpowiedzi ($2)."; return 0 ;; esac; return 1; }
if [[ -f $shared/maintenance ]]; then
 maintenance=true; warn "Trwa przerwa techniczna (plik maintenance). Usuń go i ponów weryfikację."
fi
if [[ -f $shared/chat-off ]]; then chatoff=true; echo "Czat wyłączony plikiem $shared/chat-off."; fi
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
# --- PWA files and release identity (static, no PHP; plan §9.8). A release without a service worker only warns. ---
if [[ -f $DOCROOT/sw.js && -f $DOCROOT/version.json ]]; then
 want=$(cat "$DOCROOT/version.json"); got=$(curl -sS "${k[@]}" "$APP_URL/version.json")
 [[ -n $want && $got == "$want" ]] && echo "version.json: zgodny z wydaniem." || error "version.json z serwera ($(head -c 200 <<<"$got")) różni się od katalogu domeny ($want): zły katalog albo pamięć podręczna."
 build=$(sed -n 's/.*"build":"\([0-9a-f]*\)".*/\1/p' <<<"$want")
 code=$(curl -sS "${k[@]}" -D "$tmp/sw.h" -o "$tmp/sw.js" -w '%{http_code}' "$APP_URL/sw.js")
 if ! hosting "$code" sw.js; then
  [[ $code == 200 ]] && grep -qi '^content-type:.*javascript' "$tmp/sw.h" || error "sw.js: kod $code albo zły Content-Type."
  [[ -n $build ]] && grep -q "\"$build\"" "$tmp/sw.js" && echo "sw.js: wydanie $build." || error "sw.js nie zawiera numeru wydania ${build:-?}."
  grep -qi '^cache-control:.*no-cache' "$tmp/sw.h" || warn "sw.js bez Cache-Control: no-cache (sprawdź .htaccess)."
 fi
 for m in manifest.webmanifest manifest.en.webmanifest; do
  code=$(curl -sS "${k[@]}" -D "$tmp/m.h" -o "$tmp/m.json" -w '%{http_code}' "$APP_URL/$m"); hosting "$code" "$m" && continue
  grep -qi '^content-type:.*manifest+json' "$tmp/m.h" || warn "$m: Content-Type to nie application/manifest+json."
  if "$php" -r '$m=json_decode(file_get_contents($argv[1]),true);exit(is_array($m)&&!empty($m["id"])&&!empty($m["start_url"])&&count($m["icons"]??[])>=2?0:1);' "$tmp/m.json"; then
   bad=0
   for src in $("$php" -r 'foreach((json_decode(file_get_contents($argv[1]),true)["icons"]??[]) as $i)if(is_string($i["src"]??null)&&preg_match("#^[A-Za-z0-9._/-]+$#D",$i["src"]))echo $i["src"],"\n";' "$tmp/m.json" | sort -u); do
    [[ $src == /* ]] && u=$APP_URL$src || u=$APP_URL/${src#./}
    [[ $(curl -sS "${k[@]}" -o /dev/null -w '%{http_code}' "$u") == 200 ]] || { error "$m: ikona $src nie jest dostępna."; bad=1; }
   done
   [[ $bad == 0 ]] && echo "$m: poprawny, ikony dostępne."
  else error "$m: kod $code, niepoprawny JSON lub brak id/start_url/icons."; fi
 done
 code=$(curl -sS "${k[@]}" -o /dev/null -w '%{http_code}' "$APP_URL/offline.html")
 hosting "$code" offline.html || { [[ $code == 200 ]] && echo "offline.html: 200." || error "offline.html niedostępny (kod $code)."; }
else
 warn "Wydanie bez sw.js lub version.json: pomijam kontrolę PWA."
fi
if [[ $maintenance == true ]]; then warn "Przerwa techniczna: kontrole API i bazy pominięte, bez powrotu do poprzedniego wydania."; finish; fi
# Database state straight from the deployed backend: the API itself only reports a generic server error.
# Also the schema version against the code, the chat switch of the config and tournaments taking place today.
out=$(cd "$site" && "$php" 2>/dev/null <<'PHP'
<?php
require 'backend/bootstrap.php';
try { $c = matdraw_config(); $pdo = matdraw_database($c); } catch (Throwable $e) { exit("\n@@DB=error " . get_class($e) . "\n"); }
try { $pdo->query('SELECT revision FROM app_meta WHERE id=1'); echo "\n@@DB=ready\n"; } catch (Throwable $e) { exit("\n@@DB=empty\n"); }
echo "\n@@CHATOFF=" . (empty($c['chat_force_off']) ? 0 : 1) . "\n";
if (is_file('backend/src/Migrator.php')) {
 try { echo "\n@@SCHEMA=" . (int)$pdo->query('SELECT schema_version FROM app_meta WHERE id=1')->fetchColumn() . ':' . MatDraw\Migrator::target('backend/migrations') . "\n"; }
 catch (Throwable $e) { echo "\n@@SCHEMA=error\n"; }
}
try {
 $q = $pdo->prepare("SELECT name FROM tournaments WHERE status IN ('open','closed') AND event_date=? ORDER BY name LIMIT 5"); $q->execute([date('Y-m-d')]);
 foreach ($q->fetchAll(PDO::FETCH_COLUMN) as $n) echo "\n@@TODAY=" . preg_replace('/[\x00-\x1f@]+/u', ' ', (string)$n) . "\n";
} catch (Throwable $e) {}
PHP
)
get(){ sed -n "s/^@@$1=//p" <<<"$out"; }
db=$(get DB | tail -1); [[ $(get CHATOFF | tail -1) == 1 ]] && { chatoff=true; echo "Czat wyłączony w config.php (chat_force_off)."; }
api=$(curl -sS "${k[@]}" -D "$tmp/api.h" -o "$tmp/api.json" -w '%{http_code}' "$APP_URL/api/index.php?route=session")
pv=$(grep -i '^x-powered-by:' "$tmp/api.h" | cut -d' ' -f2- | tr -d '\r')
echo "PHP strony: ${pv:-nieznana (serwer nie podaje wersji)}"
hosting "$api" "API session" || { grep -q '^{' "$tmp/api.json" || error "API nie odpowiada w formacie JSON (kod $api). Sprawdź PHP 8.3 dla domeny w DirectAdmin."; }
case $db in
 empty) warn "Baza danych jest pusta: uruchom jednorazowo instalator (DEPLOY-PL.md, krok 6) i ponów sprawdzenie." ;;
 ready) if [[ $api == 200 ]] && grep -q '"csrf"' "$tmp/api.json"; then echo "API: 200, sesja działa."; elif [[ ! $api =~ ^(429|503|508|000)$ ]]; then error "API: kod $api mimo gotowej bazy. Początek odpowiedzi: $(head -c 200 "$tmp/api.json" | tr '\n' ' ')"; fi ;;
 *) env_error "Brak połączenia z bazą danych (${db:-brak odpowiedzi PHP}). Sprawdź dane bazy w ~/matdraw/shared/config.php." ;;
esac
if [[ $db == ready ]]; then
 # --- schema: the database version must be at least the code's (Migrator::target) ---
 sc=$(get SCHEMA | tail -1)
 if [[ $sc =~ ^([0-9]+):([0-9]+)$ ]]; then
  if (( BASH_REMATCH[1] >= BASH_REMATCH[2] )); then echo "Schemat bazy: v${BASH_REMATCH[1]} (kod oczekuje v${BASH_REMATCH[2]})."
  else error "Schemat bazy (v${BASH_REMATCH[1]}) jest starszy niż kod (v${BASH_REMATCH[2]}): migracja nie została wykonana."; fi
 elif [[ -n $sc ]]; then error "Nie można odczytać wersji schematu bazy ($sc)."; fi
 # --- chat (public, no cookie): 200 JSON, or 503 chat_off while the chat is switched off ---
 if [[ -f $site/backend/routes/chat.php ]]; then
  code=$(curl -sS "${k[@]}" -o "$tmp/chat.json" -w '%{http_code}' "$APP_URL/api/index.php?route=public-chat-channels")
  if [[ $code == 503 ]] && grep -q '"code":"chat_off"' "$tmp/chat.json"; then
   [[ $chatoff == true ]] && echo "Czat: 503 chat_off (wyłączony), zaakceptowane." || warn "Czat odpowiada 503 chat_off, choć nie ma pliku chat-off ani chat_force_off."
  elif [[ $code == 200 ]] && grep -q '^{' "$tmp/chat.json"; then echo "Czat: 200, kanały publiczne dostępne."
  elif ! hosting "$code" "czat"; then error "Czat (public-chat-channels): kod $code. Początek odpowiedzi: $(head -c 200 "$tmp/chat.json" | tr '\n' ' ')"; fi
 fi
 # --- me without a cookie: 401 JSON ---
 if grep -q "'me'=>" "$site/backend/routes/core.php" 2>/dev/null; then
  code=$(curl -sS "${k[@]}" -o "$tmp/me.json" -w '%{http_code}' "$APP_URL/api/index.php?route=me")
  if [[ $code == 401 ]] && grep -q '^{' "$tmp/me.json"; then echo "me bez sesji: 401 JSON."
  elif ! hosting "$code" "me"; then error "me bez sesji: kod $code zamiast 401 JSON."; fi
 fi
 while IFS= read -r t; do [[ -n $t ]] && warn "Dziś trwa turniej $t. Wdrażaj w dni bez zawodów."; done < <(get TODAY)
fi
# --- backups: warn when the newest database copy is older than 7 days ---
f=$(ls -1t "$backups"/db-*.sql.gz 2>/dev/null | head -1)
if [[ -z $f ]]; then warn "Brak kopii bazy w $backups (DEPLOY-PL.md, „Migracje bazy i kopie zapasowe”)."
elif (( $(date +%s) - $(stat -c %Y "$f") > 7*86400 )); then warn "Najnowsza kopia bazy ($(basename "$f")) jest starsza niż 7 dni. Dodaj cron z bin/dump.php --auto (DEPLOY-PL.md)."
else echo "Kopia bazy: $(basename "$f")."; fi
finish
