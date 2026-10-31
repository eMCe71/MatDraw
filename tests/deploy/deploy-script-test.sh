#!/usr/bin/env bash
# Deploy logic test without SSH (plan §9.9 deploy-script-test, §12.14): a fake server tree in a temporary directory
# (<base>=matdraw/{releases,shared,backups,logs}, domains/matbravo.test/{public_html,backend}) and a disposable
# database at the frozen baseline (schema.sql, version 1) with sample data. Runs scripts/deploy-remote.sh
# check|migrate|activate|rollback|cleanup|backup-db|backup-files|server-check and scripts/deploy-verify.sh against it:
#  - the first migrate makes a database copy, the second changes nothing and makes no copy (a copy younger than 24 h);
#  - the copies (mysqldump/mariadb-dump and backend/bin/dump.php) restore with an equal data hash, the pre-migration
#    copy with the hash of the old data, and the migration leaves the old rows unchanged;
#  - a failing migration stops before activate; a missing copy blocks a migration unless ALLOW_NO_BACKUP=1;
#  - the floor guard blocks a rollback to a release before 0002 while a member exists (FORCE_ROLLBACK=1 overrides);
#  - cleanup deletes copies older than 30 days and always keeps the newest one of each kind;
#  - deploy-verify: ROLLBACK=false on a good release, ROLLBACK=true for a schema older than the code, ROLLBACK=false
#    with the maintenance file, 503 chat_off accepted with the chat-off file; poll-probe.sh reports the status codes.
# Usage: tests/deploy/deploy-script-test.sh [port] [db_name]   (defaults 8090 and matdraw_deploy_test_<port>)
# Databases <db_name> and <db_name>_r (restore target); the test user md_<port>. The database server is reached as in
# scripts/test-http.sh: MATDRAW_TEST_DB_ROOT (default `mariadb -uroot`), MATDRAW_TEST_DB_HOST/PORT, MATDRAW_TEST_DB_USER_HOST.
#  - server-check reports only the rights granted on this database (or *.*), item by item (CREATE TEMPORARY TABLES is
#    not CREATE); the floor guard ignores PHP notices around the floor number.
# KEEP=1 keeps the work directory and the databases.
set -uo pipefail
port=${1:-8090} dbn=${2:-matdraw_deploy_test_${1:-8090}}
[[ $port =~ ^[0-9]+$ && $dbn =~ ^[A-Za-z0-9_]{1,40}$ ]] || { echo "Invalid port or database name." >&2; exit 2; }
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
php=${PHP_BIN:-$(command -v php)}; rdb=${dbn}_r
root=${MATDRAW_TEST_DB_ROOT:-$(command -v mariadb >/dev/null && echo 'mariadb -uroot' || echo 'mysql -uroot')}
dbhost=${MATDRAW_TEST_DB_HOST:-127.0.0.1}; dbport=${MATDRAW_TEST_DB_PORT:-3306}; read -ra uhosts <<<"${MATDRAW_TEST_DB_USER_HOST:-localhost 127.0.0.1}"
work=$(mktemp -d "${TMPDIR:-/tmp}/matdraw-deploy.XXXXXX")
base=$work/srv/matdraw site=$work/srv/domains/matbravo.test; docroot=$site/public_html; shared=$base/shared
app=http://127.0.0.1:$port; srvpid=; fails=0 n=0
remote(){ bash "$repo/scripts/deploy-remote.sh" "$1" "$base" "$docroot" "${@:2}"; }
verify(){ APP_URL=$app DOCROOT=$docroot DEPLOY_BASE=$base bash "$repo/scripts/deploy-verify.sh"; }
# run <name> <command...>: output in $work/out.<n> and $out, exit code in $rc.
run(){ n=$((n+1)); local name=$1; shift; "$@" > "$work/out.$n" 2>&1; rc=$?; out=$(cat "$work/out.$n"); echo "# $name (exit $rc)"; }
ok(){ if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; fails=$((fails+1)); echo "--- last output ---"; tail -25 <<<"${out:-}"; echo "---"; fi; }
sql(){ $root "$dbn" -e "$1"; }
q1(){ $root -N -B "$dbn" -e "$1"; }
count(){ ls -1 "$base"/backups/$1 2>/dev/null | wc -l; }
# The test's own server must hold the port: another server there would answer every verify/probe step instead.
start_server(){ [[ -n $srvpid ]] && { kill "$srvpid" 2>/dev/null; wait "$srvpid" 2>/dev/null; srvpid=; }
 curl -s -o /dev/null "$app/" && { echo "Port $port is busy (another server answers there)." >&2; fails=$((fails+1)); exit 2; }
 PHP_CLI_SERVER_WORKERS=2 "$php" -S "127.0.0.1:$port" -t "$docroot" > "$work/php-server.log" 2>&1 & srvpid=$!
 for _ in $(seq 1 30); do curl -fsS "$app/api/index.php?route=session" >/dev/null 2>&1 && break; sleep 0.3; done
 kill -0 "$srvpid" 2>/dev/null || { echo "php -S did not start on port $port: $(head -c 300 "$work/php-server.log")" >&2; srvpid=; fails=$((fails+1)); exit 2; }
 [[ ! -f $docroot/version.json || "$(curl -sS "$app/version.json")" == "$(cat "$docroot/version.json")" ]] || { echo "The server on port $port does not serve $docroot." >&2; fails=$((fails+1)); exit 2; }; }
cleanup(){ [[ -n $srvpid ]] && kill "$srvpid" 2>/dev/null; wait 2>/dev/null
 if [[ $fails == 0 && -z ${KEEP:-} ]]; then rm -rf "$work"; drop="DROP DATABASE IF EXISTS \`$dbn\`; DROP DATABASE IF EXISTS \`$rdb\`;"
  for h in "${uhosts[@]}"; do drop+=" DROP USER IF EXISTS 'md_$port'@'$h'; DROP USER IF EXISTS 'md_${port}h'@'$h';"; done; $root -e "$drop" 2>/dev/null; fi; }
trap cleanup EXIT

# --- database: baseline v1 with sample data; the test user's password has characters the option file must escape ---
pass='Dp"#;$\x'$(openssl rand -hex 8); spass=${pass//\\/\\\\}; grants=
for h in "${uhosts[@]}"; do grants+="CREATE USER IF NOT EXISTS 'md_$port'@'$h' IDENTIFIED BY '$spass'; ALTER USER 'md_$port'@'$h' IDENTIFIED BY '$spass';
 GRANT ALL ON \`$dbn\`.* TO 'md_$port'@'$h'; GRANT ALL ON \`$rdb\`.* TO 'md_$port'@'$h'; "; done
$root -e "DROP DATABASE IF EXISTS \`$dbn\`; CREATE DATABASE \`$dbn\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
 DROP DATABASE IF EXISTS \`$rdb\`; CREATE DATABASE \`$rdb\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; $grants FLUSH PRIVILEGES;" || { echo "Database setup failed." >&2; exit 2; }
$root "$dbn" < "$repo/backend/database/schema.sql" || { echo "schema.sql failed." >&2; exit 2; }
today=$("$php" -r 'date_default_timezone_set("Europe/Warsaw");echo date("Y-m-d");')
sql "INSERT INTO clubs VALUES ('c1','Klub Łódź – Żółć'),('c2','TKD Kraków');
 INSERT INTO users (id,club_id,email,role,active,password_hash,auth_version) VALUES ('u1','c1','admin@test.example','admin',1,'\$2y\$10\$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXY',1),('u2','c2','club@test.example','club',1,'x',3);
 INSERT INTO profiles VALUES ('p1','c1','u1',0,'{\"firstName\":\"Zażółć\",\"lastName\":\"Gęślą 🥋\",\"weight\":61.5}'),('p2','c2','u2',1,'{\"firstName\":\"O''Brien\",\"note\":\"a\\\\\\\\b\"}');
 INSERT INTO tournaments VALUES ('t1','u1','Turniej Dzisiejszy','Warszawa','$today','Mata 1','open','[]'),('t2','u1','Archiwum','Gdańsk','2024-05-01','Mata 2','finished','[{\"a\":1}]');
 INSERT INTO entries VALUES ('t1','p1','c1','{\"x\":true}'),('t2','p2','c2','{}');
 INSERT INTO draws VALUES ('t1','Kat-A','{\"rounds\":[]}'),('t1','kat-a','{}');
 UPDATE app_meta SET revision=7 WHERE id=1;" || { echo "Sample data failed." >&2; exit 2; }

# --- release tree, config and the data hash helper ---
(cd "$repo" && node scripts/build-php.mjs "$work/build/matdraw-php" >/dev/null) || { echo "Build failed." >&2; exit 3; }
mkdir -p "$base/releases" "$shared" "$site"; chmod 700 "$shared"
"$php" -r 'echo "<?php\nreturn ",var_export(["app_url"=>$argv[1],"db"=>["dsn"=>$argv[2],"user"=>$argv[3],"password"=>$argv[4]],"app_key"=>$argv[5],"allow_insecure_http"=>true,"session_idle_seconds"=>1800,"session_max_seconds"=>43200],true),";\n";' \
 "$app" "mysql:host=$dbhost;port=$dbport;dbname=$dbn;charset=utf8mb4" "md_$port" "$pass" "$(openssl rand -hex 32)" > "$shared/config.php"
chmod 600 "$shared/config.php"; export MATDRAW_CONFIG=$shared/config.php
release(){ mkdir -p "$base/releases/$1"; cp -a "$work/build/matdraw-php/public" "$work/build/matdraw-php/backend" "$base/releases/$1/"; }
R0=20250101000000-old0000 R1=20260101000001-new1111 R2=20260101000002-bad2222 R3=20260101000003-nob3333
release "$R1"; release "$R0"; rm -rf "$base/releases/$R0/backend/migrations" "$base/releases/$R0/backend/bin/migrate.php"
ln -s "$shared/config.php" "$base/releases/$R0/backend/config.php"
release "$R2"; echo r2 > "$base/releases/$R2/public/r2-marker.txt"
printf '%s\n' '<?php' "return ['id'=>5,'name'=>'broken','destructive'=>false,'up'=>function(MatDraw\\Migrator \$m):void{throw new RuntimeException('Celowo błędna migracja testowa.');}];" > "$base/releases/$R2/backend/migrations/0005_broken.php"
release "$R3"; printf '%s\n' '<?php' "return ['id'=>5,'name'=>'probe','destructive'=>false,'up'=>function(MatDraw\\Migrator \$m):void{\$m->exec('CREATE TABLE IF NOT EXISTS zz_deploy_probe (id INT PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');}];" > "$base/releases/$R3/backend/migrations/0005_probe.php"
printf '%s\n' '<?php' 'fwrite(STDERR,"dump.php disabled by the test\n");exit(1);' > "$base/releases/$R3/backend/bin/dump.php"
# Data hash (same method as the http-compat job): per table the sorted SHA-1 of every row's values. --save stores the
# column lists (without app_meta.schema_version, which a migration advances), --cols hashes only those columns (old rows
# after a migration that added columns and tables).
cat > "$work/hash.php" <<'PHP'
<?php
$c=require getenv('MATDRAW_CONFIG');$pdo=new PDO(preg_replace('/dbname=[^;]*/','dbname='.$argv[1],$c['db']['dsn']),$c['db']['user'],$c['db']['password'],[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
$opt=$argv[2]??'';
if(str_starts_with($opt,'--cols='))$cols=json_decode(file_get_contents(substr($opt,7)),true);
else{$cols=[];foreach($pdo->query("SELECT c.TABLE_NAME,c.COLUMN_NAME FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME WHERE c.TABLE_SCHEMA=DATABASE() AND t.TABLE_TYPE='BASE TABLE' ORDER BY c.TABLE_NAME,c.COLUMN_NAME")->fetchAll(PDO::FETCH_NUM) as [$t,$col])$cols[$t][]=$col;
 if(str_starts_with($opt,'--save=')){$cols['app_meta']=array_values(array_diff($cols['app_meta']??[],['schema_version']));file_put_contents(substr($opt,7),json_encode($cols));}}
foreach($cols as $t=>$cs){$rows=[];$q=$pdo->query('SELECT `'.implode('`,`',$cs).'` FROM `'.$t.'`');while($r=$q->fetch(PDO::FETCH_NUM))$rows[]=sha1(serialize($r));sort($rows);echo $t,' ',count($rows),' ',sha1(implode("\n",$rows)),"\n";}
PHP
dhash(){ "$php" "$work/hash.php" "$@"; }
restore(){ $root -e "DROP DATABASE IF EXISTS \`$rdb\`; CREATE DATABASE \`$rdb\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" && gzip -dc "$1" | $root "$rdb"; }

# --- check: directories outside the release ---
run check remote check "$app"
ok 'check succeeds' '[[ $rc == 0 ]]'
ok 'check creates shared/uploads, shared/sessions, backups, logs with mode 700' '[[ $(stat -c %a "$shared/uploads" "$shared/sessions" "$base/backups" "$base/logs" | sort -u) == 700 ]]'
mkdir -p "$shared/uploads/avatars/ab"; echo 'avatar' > "$shared/uploads/avatars/ab/0123.webp"
dhash "$dbn" --save="$work/cols-v1" > "$work/h-v1"

# --- first migrate: copy first, then v1 -> target ---
target=$("$php" -r 'require $argv[1];echo MatDraw\Migrator::target($argv[2]);' "$base/releases/$R1/backend/src/Migrator.php" "$base/releases/$R1/backend/migrations")
run 'migrate (first)' remote migrate "$R1"
ok 'first migrate succeeds' '[[ $rc == 0 ]]'
pre=$(ls -1 "$base"/backups/db-*-pre-v1-to-v$target-$R1.sql.gz 2>/dev/null | head -1)
ok "first migrate makes a copy db-*-pre-v1-to-v$target-$R1.sql.gz (mode 600)" '[[ -n $pre && $(stat -c %a "$pre") == 600 ]]'
ok 'first migrate makes a copy of shared/uploads' '[[ $(count "uploads-*.tar.gz") == 1 ]] && tar -tzf "$(ls "$base"/backups/uploads-*.tar.gz)" | grep -q avatars/ab/0123.webp'
ok "schema is at v$target and the log is in logs/" '[[ $(q1 "SELECT schema_version FROM app_meta") == "$target" && -s $base/logs/migrate-$R1.log ]]'
ok 'the migration leaves the old rows unchanged' '[[ "$(dhash "$dbn" --cols="$work/cols-v1")" == "$(cat "$work/h-v1")" ]]'
restore "$pre"
ok 'the pre-migration copy restores with the hash of the old data (v1)' '[[ "$(dhash "$rdb" --cols="$work/cols-v1")" == "$(cat "$work/h-v1")" && $(q1 "SELECT schema_version FROM \`$rdb\`.app_meta") == 1 ]]'
dbs=$(count 'db-*.sql.gz') files=$(count 'uploads-*.tar.gz'); h4=$(dhash "$dbn")
run 'migrate (second)' remote migrate "$R1"
ok 'second migrate succeeds without changes and without a copy' '[[ $rc == 0 && $(count "db-*.sql.gz") == "$dbs" && $(count "uploads-*.tar.gz") == "$files" && "$(dhash "$dbn")" == "$h4" ]] && grep -q "Schemat aktualny" <<<"$out" && grep -q "z ostatnich 24 h" <<<"$out"'

# --- activate and verify ---
run activate remote activate "$R1"
ok 'activate publishes the release and links config.php' '[[ $rc == 0 && $(readlink -f "$base/current") == "$base/releases/$R1" && -f $docroot/index.html && $(readlink "$site/backend/config.php") == "$shared/config.php" ]]'
start_server
run verify verify
ok 'deploy-verify passes with ROLLBACK=false' '[[ $rc == 0 ]] && grep -qx "ROLLBACK=false" <<<"$out"'
ok 'deploy-verify checks the schema, sw.js, manifests, chat and me' 'grep -q "Schemat bazy: v$target" <<<"$out" && grep -q "sw.js: wydanie" <<<"$out" && grep -q "manifest.en.webmanifest: poprawny" <<<"$out" && grep -q "Czat: 200" <<<"$out" && grep -q "me bez sesji: 401" <<<"$out"'
ok 'deploy-verify warns about a tournament today' 'grep -q "Dziś trwa turniej Turniej Dzisiejszy" <<<"$out"'
touch "$shared/maintenance"
run 'verify with maintenance' verify
ok 'deploy-verify with the maintenance file: warning, API skipped, ROLLBACK=false' '[[ $rc == 0 ]] && grep -qx "ROLLBACK=false" <<<"$out" && grep -q "Trwa przerwa techniczna (plik maintenance)" <<<"$out" && ! grep -q "API: 200" <<<"$out"'
rm -f "$shared/maintenance"; touch "$shared/chat-off"
run 'verify with chat-off' verify
ok 'deploy-verify with the chat-off file accepts 503 chat_off' '[[ $rc == 0 ]] && grep -qx "ROLLBACK=false" <<<"$out" && grep -q "503 chat_off" <<<"$out"'
run 'poll-probe with chat-off' bash "$repo/scripts/poll-probe.sh" "$app" 2 2
ok 'poll-probe reports 503 and exits 1' '[[ $rc == 1 ]] && grep -q "HTTP 503" <<<"$out"'
rm -f "$shared/chat-off"
run 'poll-probe' bash "$repo/scripts/poll-probe.sh" "$app" 2 4
ok 'poll-probe reports the status codes and exits 0' '[[ $rc == 0 ]] && grep -q "HTTP 200" <<<"$out" && grep -q "ch=[0-9]*:0" <<<"$out"'

# --- copies restore with an equal data hash: dump tool, then backend/bin/dump.php ---
sleep 1; run backup-db remote backup-db
f=$(ls -1t "$base"/backups/db-*-manual-*.sql.gz 2>/dev/null | head -1); restore "$f"
ok 'backup-db (dump tool) restores with an equal data hash' '[[ $rc == 0 && -n $f && "$(dhash "$rdb")" == "$(dhash "$dbn")" ]]'
ok 'backup-db made the copy with the dump tool, not with the bin/dump.php fallback' '! grep -q "Próbuję backend/bin/dump.php" <<<"$out" && gzip -dc "$f" | head -5 | grep -qE "(MySQL|MariaDB) dump"'
sleep 1; run 'backup-db (dump.php)' env MATDRAW_DUMP=php bash "$repo/scripts/deploy-remote.sh" backup-db "$base" "$docroot"
g=$(ls -1t "$base"/backups/db-*-manual-*.sql.gz 2>/dev/null | head -1); restore "$g"
ok 'backup-db (bin/dump.php) restores with an equal data hash' '[[ $rc == 0 && $g != "$f" && "$(dhash "$rdb")" == "$(dhash "$dbn")" ]] && gzip -dc "$g" | head -1 | grep -q "MatDraw database dump"'
run backup-files remote backup-files
ok 'backup-files succeeds' '[[ $rc == 0 && $(count "uploads-*.tar.gz") -ge 1 ]]'

# --- a failing migration stops before activate ---
before=$(count 'db-*.sql.gz')
run 'migrate (broken) && activate' bash -c "bash '$repo/scripts/deploy-remote.sh' migrate '$base' '$docroot' '$R2' && bash '$repo/scripts/deploy-remote.sh' activate '$base' '$docroot' '$R2'"
ok 'a failing migration exits non-zero and activate does not run' '[[ $rc != 0 && $(readlink -f "$base/current") == "$base/releases/$R1" && ! -e $docroot/r2-marker.txt ]] && grep -q "Migracja bazy nie powiodła się" <<<"$out"'
ok 'the failing migration was preceded by a copy, the schema stays' '[[ $(count "db-*.sql.gz") -gt $before && $(q1 "SELECT schema_version FROM app_meta") == "$target" ]] && grep -q "Celowo błędna migracja" "$base/logs/migrate-$R2.log"'
# A release whose code expects a newer schema than the database: verify asks for a rollback.
run 'activate R2 without its migration' remote activate "$R2"; start_server
run 'verify (schema older than code)' verify
ok 'deploy-verify with a schema older than the code: ROLLBACK=true' '[[ $rc != 0 ]] && grep -qx "ROLLBACK=true" <<<"$out" && grep -q "jest starszy niż kod" <<<"$out"'
run 'rollback to R1' remote rollback
ok 'rollback returns to the previous release' '[[ $rc == 0 && $(readlink -f "$base/current") == "$base/releases/$R1" && ! -e $docroot/r2-marker.txt ]]'

# --- floor guard (plan §2.8): R0 has no migrations (code before 0002) ---
printf '%s\n' "$base/releases/$R0" > "$base/releases/$R1/.previous"
# PHP noise around the floor number (a notice on STDOUT and a deprecation through display_errors), only in migrate.php
# --rollback-floor: the guard must still read the floor and allow the rollback.
mkdir "$work/ini"; printf '%s\n' '<?php if(in_array("--rollback-floor",$argv??[],true)){echo "Deprecated: test notice on STDOUT\n";trigger_error("test deprecation",E_USER_DEPRECATED);}' > "$work/noise.php"
printf 'auto_prepend_file=%s\nerror_reporting=E_ALL\ndisplay_errors=1\n' "$work/noise.php" > "$work/ini/zz-noise.ini"
run 'rollback to R0 without members (PHP notices)' env PHP_INI_SCAN_DIR=":$work/ini" bash "$repo/scripts/deploy-remote.sh" rollback "$base" "$docroot"
ok 'rollback to a release before 0002 is allowed without members, despite PHP notices' '[[ $rc == 0 && $(readlink -f "$base/current") == "$base/releases/$R0" ]] && ! grep -q "Powrót zablokowany" <<<"$out"'
run 'activate R1 again' remote activate "$R1"
ok 'activate a newer release needs no floor check' '[[ $rc == 0 && $(readlink -f "$base/current") == "$base/releases/$R1" && $(cat "$base/releases/$R1/.previous") == "$base/releases/$R0" ]]'
sql "INSERT INTO users (id,club_id,email,role,active,password_hash,auth_version) VALUES ('m1',NULL,'member@test.example','member',1,'x',1)"
run 'rollback to R0 with a member' env PHP_INI_SCAN_DIR=":$work/ini" bash "$repo/scripts/deploy-remote.sh" rollback "$base" "$docroot"
ok 'the floor guard blocks the rollback while a member exists' '[[ $rc != 0 && $(readlink -f "$base/current") == "$base/releases/$R1" ]] && grep -q "dane w bazie wymagają kodu co najmniej w wersji" <<<"$out" && grep -q FORCE_ROLLBACK <<<"$out"'
run 'activate R0 with a member' remote activate "$R0"
ok 'the floor guard also blocks activating the old release by name' '[[ $rc != 0 && $(readlink -f "$base/current") == "$base/releases/$R1" ]]'
run 'FORCE_ROLLBACK=1 rollback' env FORCE_ROLLBACK=1 bash "$repo/scripts/deploy-remote.sh" rollback "$base" "$docroot"
ok 'FORCE_ROLLBACK=1 overrides the guard with a warning' '[[ $rc == 0 && $(readlink -f "$base/current") == "$base/releases/$R0" ]] && grep -q "FORCE_ROLLBACK=1" <<<"$out"'
run 'activate R1 after the forced rollback' remote activate "$R1"
ok 'activate R1 again' '[[ $rc == 0 && $(readlink -f "$base/current") == "$base/releases/$R1" ]]'

# --- cleanup: 30 days, the newest of each kind stays ---
old(){ local f="$base/backups/$1"; echo "$1" | gzip > "$f"; touch -d "$2 days ago" "$f"; }
old db-20200101000000-daily.sql.gz 40; old db-20200201000000-daily.sql.gz 35; old uploads-20200101000000.tar.gz 45
echo x > "$base/backups/db-20200301000000-daily.sql.gz.tmp"; touch -d '7 hours ago' "$base/backups/db-20200301000000-daily.sql.gz.tmp"
fresh=$(count 'db-*.sql.gz')
run cleanup remote cleanup
ok 'cleanup deletes copies older than 30 days and partial files' '[[ $rc == 0 && ! -e $base/backups/db-20200101000000-daily.sql.gz && ! -e $base/backups/db-20200201000000-daily.sql.gz && ! -e $base/backups/uploads-20200101000000.tar.gz && ! -e $base/backups/db-20200301000000-daily.sql.gz.tmp && $(count "db-*.sql.gz") == $((fresh-2)) ]]'
mkdir "$work/hold"; mv "$base"/backups/db-*.sql.gz "$base"/backups/uploads-*.tar.gz "$work/hold/"
old db-20200101000000-daily.sql.gz 50; old db-20200201000000-daily.sql.gz 40; old uploads-20200101000000.tar.gz 45; old uploads-20191201000000.tar.gz 60
run 'cleanup with old copies only' remote cleanup
ok 'cleanup keeps the newest copy of each kind even when it is older than 30 days' '[[ $rc == 0 && -e $base/backups/db-20200201000000-daily.sql.gz && ! -e $base/backups/db-20200101000000-daily.sql.gz && -e $base/backups/uploads-20200101000000.tar.gz && ! -e $base/backups/uploads-20191201000000.tar.gz ]]'
rm -f "$base"/backups/db-*.sql.gz "$base"/backups/uploads-*.tar.gz; mv "$work"/hold/* "$base/backups/"

# --- no copy, no migration (ALLOW_NO_BACKUP=1 is the only exception) ---
mkdir "$work/nodump"; for b in mysqldump mariadb-dump; do printf '#!/bin/sh\necho "disabled by the test" >&2\nexit 1\n' > "$work/nodump/$b"; chmod 755 "$work/nodump/$b"; done
run 'migrate without a possible copy' env PATH="$work/nodump:$PATH" bash "$repo/scripts/deploy-remote.sh" migrate "$base" "$docroot" "$R3"
ok 'a migration without a database copy is refused' '[[ $rc != 0 && $(q1 "SELECT schema_version FROM app_meta") == "$target" ]] && grep -q "Brak kopii bazy" <<<"$out"'
run 'migrate with ALLOW_NO_BACKUP=1' env PATH="$work/nodump:$PATH" ALLOW_NO_BACKUP=1 bash "$repo/scripts/deploy-remote.sh" migrate "$base" "$docroot" "$R3"
ok 'ALLOW_NO_BACKUP=1 migrates without a copy' '[[ $rc == 0 && $(q1 "SELECT schema_version FROM app_meta") == 5 ]] && grep -q "ALLOW_NO_BACKUP=1" <<<"$out"'

# --- an empty database: the installer hint, no copy, no error ---
$root -e "DROP DATABASE IF EXISTS \`$rdb\`; CREATE DATABASE \`$rdb\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
cp -p "$shared/config.php" "$work/config.keep"; sed -i "s/dbname=$dbn;/dbname=$rdb;/" "$shared/config.php"; before=$(count 'db-*.sql.gz')
run 'migrate on an empty database' remote migrate "$R1"
ok 'migrate on an empty database points to the installer and exits 0 without a copy' '[[ $rc == 0 && $(count "db-*.sql.gz") == "$before" ]] && grep -q "Baza danych jest pusta" <<<"$out"'
cp -p "$work/config.keep" "$shared/config.php"

# --- server-check (read-only) ---
run server-check remote server-check
ok 'server-check reports the database rights, schema and copies' '[[ $rc == 0 ]] && grep -q "Prawo bazy ALTER: tak" <<<"$out" && grep -q "Prawo bazy CREATE: tak" <<<"$out" && grep -q "Prawo bazy REFERENCES: tak" <<<"$out" && grep -q "Schemat bazy: v5" <<<"$out" && grep -q "Najnowsza kopia db-\*.sql.gz: db-" <<<"$out" && grep -q "Stripe:" <<<"$out"'
# A hardened account (db_migrate): no CREATE/ALTER/REFERENCES here although it has CREATE TEMPORARY TABLES and ALL
# PRIVILEGES on another database; the grant names this database by an escaped pattern (`a\_b`.*, as phpMyAdmin writes it).
hpass=$(openssl rand -hex 12); hg=; edb=${dbn//_/\\_}
for h in "${uhosts[@]}"; do hg+="CREATE USER IF NOT EXISTS 'md_${port}h'@'$h' IDENTIFIED BY '$hpass'; ALTER USER 'md_${port}h'@'$h' IDENTIFIED BY '$hpass';
 GRANT SELECT, INSERT, UPDATE, DELETE, INDEX, CREATE TEMPORARY TABLES, LOCK TABLES ON \`$edb\`.* TO 'md_${port}h'@'$h'; GRANT ALL ON \`$rdb\`.* TO 'md_${port}h'@'$h'; "; done
$root -e "$hg FLUSH PRIVILEGES;"
"$php" -r '$c=require $argv[1];$c["db_migrate"]=["dsn"=>$c["db"]["dsn"],"user"=>$argv[2],"password"=>$argv[3]];echo "<?php\nreturn ",var_export($c,true),";\n";' "$work/config.keep" "md_${port}h" "$hpass" > "$shared/config.php"
run 'server-check (hardened account)' remote server-check
ok 'server-check counts only the exact rights on this database' '[[ $rc == 0 ]] && grep -q "Prawo bazy CREATE: NIE" <<<"$out" && grep -q "Prawo bazy ALTER: NIE" <<<"$out" && grep -q "Prawo bazy REFERENCES: NIE" <<<"$out" && grep -q "Prawo bazy INDEX: tak" <<<"$out" && grep -q "Schemat bazy: v5" <<<"$out"'
cp -p "$work/config.keep" "$shared/config.php"

echo "DEPLOY_SCRIPT_TEST: $n steps, $fails failed (work dir: $work)"
[[ $fails == 0 ]]
