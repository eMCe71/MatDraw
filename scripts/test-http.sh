#!/usr/bin/env bash
# HTTP integration tests on a disposable local database (plan §11, §12.1).
# Usage: scripts/test-http.sh <port> [db_name] [test files...]
#   Builds the PHP release, creates a fresh MariaDB/MySQL database <db_name> (default matdraw_test_<port>) plus
#   <db_name>_aux (second database for migration and backup tests), writes a test-only config in <work>/shared,
#   runs install.php and migrate.php twice, starts tests/stubs/stripe-stub.mjs on <port+1> when it exists, serves
#   the release with `php -S 127.0.0.1:<port>` and runs tests/http.test.mjs first, then the given files or the glob
#   tests/*.http.test.mjs, one file at a time. Distinct ports and database names allow parallel runs.
# Needs a local server reachable as `mariadb -uroot` (or `mysql -uroot`); override with MATDRAW_TEST_DB_ROOT.
# A server in a container (CI services): MATDRAW_TEST_DB_HOST (default 127.0.0.1) and MATDRAW_TEST_DB_PORT (3306) go
# into the app DSN; MATDRAW_TEST_DB_USER_HOST lists the host parts of the test user mt_<port> (default
# 'localhost 127.0.0.1'; set '%' when the server sees the client through docker NAT), e.g.
#   MATDRAW_TEST_DB_ROOT='mysql -h127.0.0.1 -P3306 -uroot -pci-root' MATDRAW_TEST_DB_USER_HOST='%' scripts/test-http.sh 8110
# Exports MATDRAW_CONFIG, MATDRAW_TEST_SHARED_DIR, MATDRAW_TEST_URL, MATDRAW_TEST_AUX_DB, MATDRAW_TEST_RELEASE, PHP_BIN.
# KEEP=1 keeps the work directory after a successful run. Test credentials and config never leave the work directory.
set -uo pipefail
port=${1:?usage: scripts/test-http.sh <port> [db_name] [test files...]}; shift
dbn=${1:-matdraw_test_$port}; [[ $# -gt 0 ]] && shift
[[ $port =~ ^[0-9]+$ && $dbn =~ ^[A-Za-z0-9_]{1,50}$ ]] || { echo "Invalid port or database name." >&2; exit 2; }
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
php=${PHP_BIN:-$(command -v php)}; stub_port=$((port+1)); aux=${dbn}_aux
root=${MATDRAW_TEST_DB_ROOT:-$(command -v mariadb >/dev/null && echo 'mariadb -uroot' || echo 'mysql -uroot')}
dbhost=${MATDRAW_TEST_DB_HOST:-127.0.0.1}; dbport=${MATDRAW_TEST_DB_PORT:-3306}; read -ra uhosts <<<"${MATDRAW_TEST_DB_USER_HOST:-localhost 127.0.0.1}"
[[ $dbhost =~ ^[A-Za-z0-9._:-]+$ && $dbport =~ ^[0-9]+$ && ${#uhosts[@]} -gt 0 ]] || { echo "Invalid MATDRAW_TEST_DB_HOST, MATDRAW_TEST_DB_PORT or MATDRAW_TEST_DB_USER_HOST." >&2; exit 2; }
for h in "${uhosts[@]}"; do [[ $h =~ ^[A-Za-z0-9._%:-]+$ ]] || { echo "Invalid MATDRAW_TEST_DB_USER_HOST entry: $h" >&2; exit 2; }; done
work=$(mktemp -d "${TMPDIR:-/tmp}/matdraw-http.XXXXXX"); shared=$work/shared
srv=; stub=
cleanup(){ [[ -n $srv ]] && kill "$srv" 2>/dev/null; [[ -n $stub ]] && kill "$stub" 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT
# Start a local MariaDB if none answers (development containers); CI provides its own service.
if ! $root -e 'SELECT 1' >/dev/null 2>&1 && command -v mysqld_safe >/dev/null; then
 (mysqld_safe --user=mysql >"$work/mysqld.log" 2>&1 &)
 for _ in $(seq 1 30); do $root -e 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
fi
pass=$(openssl rand -hex 16); grants=
for h in "${uhosts[@]}"; do grants+="CREATE USER IF NOT EXISTS 'mt_$port'@'$h' IDENTIFIED BY '$pass'; ALTER USER 'mt_$port'@'$h' IDENTIFIED BY '$pass';
 GRANT ALL ON \`$dbn\`.* TO 'mt_$port'@'$h'; GRANT ALL ON \`$aux\`.* TO 'mt_$port'@'$h'; "; done
$root -e "DROP DATABASE IF EXISTS \`$dbn\`; CREATE DATABASE \`$dbn\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
 DROP DATABASE IF EXISTS \`$aux\`; CREATE DATABASE \`$aux\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
 $grants FLUSH PRIVILEGES;" || { echo "Database setup failed." >&2; exit 2; }
(cd "$repo" && node scripts/build-php.mjs "$work/matdraw-php" >/dev/null) || { echo "Build failed." >&2; exit 3; }
mkdir -p "$shared/uploads" "$shared/sessions"; chmod 700 "$shared" "$shared/uploads" "$shared/sessions"
# Test values from plan §9.9 (billing in test mode against the local Stripe stub; nothing real).
cat > "$shared/config.php" <<PHP
<?php
return [
 'app_url'=>'http://127.0.0.1:$port',
 'db'=>['dsn'=>'mysql:host=$dbhost;port=$dbport;dbname=$dbn;charset=utf8mb4','user'=>'mt_$port','password'=>'$pass'],
 'app_key'=>'$(openssl rand -hex 32)',
 'allow_insecure_http'=>true,'session_idle_seconds'=>1800,'session_max_seconds'=>43200,
 'uploads_dir'=>'$shared/uploads',
 'signup_enabled'=>true,'billing_enabled'=>true,'billing_enforce'=>true,'billing_mode'=>'test','support_email'=>'pomoc@example.test',
 'stripe_secret_key'=>'rk_test_stub','stripe_api_base'=>'http://127.0.0.1:$stub_port','stripe_webhook_secrets'=>['whsec_test_secret'],
 'stripe_prices'=>['pln'=>'matbravo_monthly_pln','usd'=>'matbravo_monthly_usd'],'billing_amounts'=>['pln'=>899,'usd'=>299],
 'stripe_portal_configuration'=>'bpc_stub',
];
PHP
chmod 600 "$shared/config.php"
export MATDRAW_CONFIG=$shared/config.php MATDRAW_TEST_SHARED_DIR=$shared MATDRAW_TEST_AUX_DB=$aux MATDRAW_TEST_RELEASE=$work/matdraw-php PHP_BIN=$php
export MATDRAW_TEST_URL=http://127.0.0.1:$port/api/index.php
bin=$work/matdraw-php/backend/bin
printf '%s\n' 'AdminForTests2026!' | "$php" "$bin/install.php" --email=admin@test.example --club='Test Warszawa' --password-stdin || { echo "install.php failed." >&2; exit 4; }
"$php" "$bin/migrate.php" || { echo "migrate.php failed." >&2; exit 5; }
second=$("$php" "$bin/migrate.php") || { echo "Second migrate.php failed." >&2; exit 5; }
grep -q '^Schemat aktualny' <<<"$second" || { echo "Second migrate.php changed something: $second" >&2; exit 5; }
if [[ -f $repo/tests/stubs/stripe-stub.mjs ]]; then
 node "$repo/tests/stubs/stripe-stub.mjs" "$stub_port" > "$work/stripe-stub.log" 2>&1 & stub=$!
 for _ in $(seq 1 30); do (exec 3<>"/dev/tcp/127.0.0.1/$stub_port") 2>/dev/null && break; sleep 0.2; done
fi
PHP_CLI_SERVER_WORKERS=4 "$php" -S "127.0.0.1:$port" -t "$work/matdraw-php/public" > "$work/php-server.log" 2>&1 & srv=$!
for _ in $(seq 1 30); do curl -fsS "$MATDRAW_TEST_URL?route=session" >/dev/null 2>&1 && break; sleep 0.5; done
cd "$repo"
if [[ $# -gt 0 ]]; then files=(); for f in "$@"; do [[ $(basename "$f") == http.test.mjs ]] || files+=("$f"); done
else shopt -s nullglob; files=(tests/*.http.test.mjs); shopt -u nullglob; fi
node --test --test-concurrency=1 tests/http.test.mjs; rc=$?
if [[ ${#files[@]} -gt 0 ]]; then node --test --test-concurrency=1 "${files[@]}" || rc=1; fi
if [[ $rc != 0 ]]; then echo "--- php server log (tail) ---"; tail -40 "$work/php-server.log"; [[ -n $stub ]] && { echo "--- stripe stub log (tail) ---"; tail -20 "$work/stripe-stub.log"; }; fi
echo "HTTP_TEST_EXIT=$rc (work dir: $work)"
if [[ $rc == 0 && -z ${KEEP:-} ]]; then rm -rf "$work"; fi
exit $rc
