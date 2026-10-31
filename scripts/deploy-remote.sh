#!/usr/bin/env bash
# Runs on the hosting server: ssh host bash -s -- <command> <base> <docroot> [release|app_url] < scripts/deploy-remote.sh
# (the workflow also keeps a copy in <base>/bin for manual use over SSH).
# Layout: <base>/releases/<release>/{public,backend}, <base>/current -> active release,
# <base>/shared/config.php (created once by the owner). The active release is copied into the real
# directories <docroot> and its sibling backend/, because public/api/index.php loads ../../backend.
# User data lives outside every release (plan §9.7): <base>/shared/{uploads,sessions} (700), <base>/backups (700:
# db-<date>-<reason>-<release>.sql.gz and uploads-<date>.tar.gz, mode 600) and <base>/logs (700).
# Commands: check [app_url] | migrate <release> | activate <release> | rollback | cleanup | backup-db | backup-files | server-check
# Environment: ALLOW_NO_BACKUP=1 lets migrate run although the database copy failed (the only exception);
# FORCE_ROLLBACK=1 skips the rollback floor guard (plan §2.8, own risk); BACKUP_KEEP_DAYS (default 30);
# MATDRAW_DUMP=php uses backend/bin/dump.php instead of mysqldump/mariadb-dump.
set -euo pipefail
umask 022
cmd=$1 base=$2 docroot=$3 release=${4:-}
site=$(dirname "$docroot")
private_html=$site/private_html
cfg=$base/shared/config.php
# The default php of an SSH session on web9 is 8.1; the application needs 8.3.
php=/usr/local/php83/bin/php; [[ -x $php ]] || php=$(command -v php)
keep_days=${BACKUP_KEEP_DAYS:-30}; [[ $keep_days =~ ^[0-9]{1,4}$ && $keep_days -ge 1 ]] || keep_days=30
fail(){ echo "::error::$*" >&2; exit 1; }
warn(){ echo "::warning::$*"; }
# Atomic symlink replacement (rename over the old link).
switch(){ ln -sfn "$2" "$1.tmp.$$"; mv -Tf "$1.tmp.$$" "$1"; }
# Content MatDraw did not deploy is moved to <base>/backups, outside web access.
backup(){ mkdir -p "$base/backups"; chmod 700 "$base/backups"; local to="$base/backups/$(basename "$1").before-matdraw-$(date +%Y%m%d%H%M%S)"; mv -T "$1" "$to"; echo "Poprzednią zawartość $1 przeniesiono do $to"; }
# Replaces <dst> with a copy of <src>; two renames keep the site from being served half-copied.
publish(){
 rm -rf "$2.new" "$2.old"
 cp -a "$1" "$2.new"
 if [[ -e $2 || -L $2 ]]; then mv -T "$2" "$2.old"; fi
 mv -T "$2.new" "$2"
 rm -rf "$2.old"
}
# Points current at <release> and copies it into the site.
go_live(){
 switch "$base/current" "$1"
 publish "$1/backend" "$site/backend"
 publish "$1/public" "$docroot"
}
# Highest migration id a release ships (1 = baseline only), from the file names, exactly as Migrator::target().
code_target(){ local n=1 f id; for f in "$1"/backend/migrations/[0-9][0-9][0-9][0-9]_*.php; do [[ -f $f ]] || continue; id=${f##*/}; id=$((10#${id:0:4})); ((id>n)) && n=$id; done; echo "$n"; }
# Rollback floor guard (plan §2.8): code older than the data needs (e.g. without member accounts, migration 0002) would
# show members data they may not see. The floor comes from migrate.php of the active release, which knows every
# migration the data could need; a target release at least as new as the active one never needs the database.
floor_guard(){
 local dir=$1 cur want have floor
 cur=$(readlink -f "$base/current" 2>/dev/null || true); [[ -n $cur && -d $cur && $cur != "$(readlink -f "$dir")" ]] || return 0
 want=$(code_target "$dir"); have=$(code_target "$cur"); ((want>=have)) && return 0
 if [[ -f $cur/backend/bin/migrate.php ]] && floor=$(MATDRAW_CONFIG=$cfg "$php" "$cur/backend/bin/migrate.php" --rollback-floor 2>&1) && [[ $floor =~ ^[0-9]+$ ]]; then
  ((floor<=want)) && return 0
  msg="Powrót zablokowany: dane w bazie wymagają kodu co najmniej w wersji $floor (np. istnieją konta członków), a wydanie $(basename "$dir") obsługuje tylko wersję $want. Starszy kod pokazałby członkom dane, których nie wolno im widzieć. Popraw błąd nowym wdrożeniem."
 else
  msg="Powrót zablokowany: nie udało się sprawdzić, jakiej wersji kodu wymagają dane (${floor:-brak migrate.php}). Wydanie $(basename "$dir") obsługuje tylko wersję $want."
 fi
 [[ ${FORCE_ROLLBACK:-} == 1 ]] || fail "$msg Wymuszenie: FORCE_ROLLBACK=1 (tylko na własną odpowiedzialność, DEPLOY-PL.md)."
 warn "FORCE_ROLLBACK=1: $msg Kontynuuję na własną odpowiedzialność operatora."
}
# Newest file matching a glob in backups/ (empty when none) and its age in seconds.
newest(){ ls -1t "$base"/backups/$1 2>/dev/null | head -1 || true; }
age(){ echo $(( $(date +%s) - $(stat -c %Y "$1") )); }
backup_dirs(){ mkdir -p "$base/backups" "$base/logs"; chmod 700 "$base/backups" "$base/logs"; }
# Client option file (mode 600) built from config.php: the password never appears in a process list or on a command line.
# Prints the file name; the database name is in its last line as "#DB=<name>".
dbcnf(){
 local f; f=$(mktemp "$base/shared/.my.XXXXXX"); chmod 600 "$f"
 if ! MATDRAW_CONFIG=$cfg "$php" -r '$c=(require getenv("MATDRAW_CONFIG"))["db"]??null;if(!is_array($c)||!preg_match("/^mysql:(.*)$/",(string)($c["dsn"]??""),$m))exit(1);
  $d=[];foreach(explode(";",$m[1]) as $p)if(str_contains($p,"=")){[$k,$v]=explode("=",$p,2);$d[trim($k)]=trim($v);}
  foreach([$c["user"]??"",$c["password"]??"",$d["host"]??"",$d["unix_socket"]??""] as $v)if(preg_match("/[\\r\\n\\x00]/",(string)$v))exit(1);
  if(!preg_match("/^[A-Za-z0-9_\$-]{1,64}$/D",$d["dbname"]??""))exit(1);
  $q=fn($v)=>"\"".str_replace(["\\","\""],["\\\\","\\\""],(string)$v)."\"";
  echo "[client]\nuser=",$q($c["user"]??""),"\npassword=",$q($c["password"]??""),"\n",isset($d["unix_socket"])?"socket=".$q($d["unix_socket"]):"host=".$q($d["host"]??"localhost")."\nport=".(int)($d["port"]??3306),"\ndefault-character-set=utf8mb4\n#DB=",$d["dbname"],"\n";' > "$f"; then rm -f "$f"; return 1; fi
 echo "$f"
}
# Database copy: mysqldump/mariadb-dump, else (or when the tool fails) backend/bin/dump.php of release dir $2.
# Accepted only as valid gzip larger than 1 KiB whose end carries "Dump completed"; written as *.tmp, then renamed.
dbbackup(){
 local label=$1 rel=$2 bin= cnf dbn help out ok=0 flags=(--single-transaction --quick --skip-lock-tables --hex-blob --default-character-set=utf8mb4)
 backup_dirs; out="$base/backups/db-$(date +%Y%m%d%H%M%S)-$label.sql.gz"
 accept(){ [[ -s $1 ]] && gzip -t "$1" 2>/dev/null && [[ $(stat -c %s "$1") -gt 1024 ]] && gzip -dc "$1" | tail -c 400 | grep -q 'Dump completed'; }
 [[ ${MATDRAW_DUMP:-} == php ]] || bin=$(command -v mysqldump || command -v mariadb-dump || true)
 if [[ -n $bin ]]; then
  if cnf=$(dbcnf); then
   dbn=$(sed -n 's/^#DB=//p' "$cnf"); help=$("$bin" --help 2>&1 || true)
   grep -q -- '--no-tablespaces' <<<"$help" && flags+=(--no-tablespaces)            # MySQL 8 client without the PROCESS privilege
   grep -q -- '--column-statistics' <<<"$help" && flags+=(--column-statistics=0)    # MySQL 8 client talking to MariaDB
   ( umask 077; set -o pipefail; "$bin" --defaults-extra-file="$cnf" "${flags[@]}" "$dbn" 2>"$base/logs/dump.err" | gzip -6 > "$out.tmp" ) && accept "$out.tmp" && ok=1
   rm -f "$cnf"
   [[ $ok == 1 ]] || { rm -f "$out.tmp"; warn "$(basename "$bin") nie wykonał kopii ($(head -c 300 "$base/logs/dump.err" 2>/dev/null | tr '\n' ' ')). Próbuję backend/bin/dump.php."; }
  else warn 'Nie można odczytać danych bazy z config.php dla mysqldump. Próbuję backend/bin/dump.php.'; fi
 fi
 if [[ $ok == 0 ]]; then
  [[ -f $rel/backend/bin/dump.php ]] || { echo "Kopia bazy nie powstała: brak mysqldump, mariadb-dump i $rel/backend/bin/dump.php." >&2; return 1; }
  ( umask 077; set -o pipefail; MATDRAW_CONFIG=$cfg "$php" "$rel/backend/bin/dump.php" 2>"$base/logs/dump.err" | gzip -6 > "$out.tmp" ) && accept "$out.tmp" && ok=1
  [[ $ok == 1 ]] || { rm -f "$out.tmp"; echo "Kopia bazy nie powstała: $(head -c 300 "$base/logs/dump.err" 2>/dev/null | tr '\n' ' ')" >&2; return 1; }
 fi
 rm -f "$base/logs/dump.err"; mv -f "$out.tmp" "$out"; chmod 600 "$out"; echo "Kopia bazy: $out ($(du -h "$out" | cut -f1))"
}
# Copy of shared/uploads (avatars are not reproducible). Skipped when the directory is empty.
filesbackup(){
 local out
 backup_dirs; [[ -d $base/shared/uploads ]] && [[ -n $(ls -A "$base/shared/uploads" 2>/dev/null) ]] || { echo 'Kopia plików: katalog shared/uploads jest pusty, pomijam.'; return 0; }
 out="$base/backups/uploads-$(date +%Y%m%d%H%M%S).tar.gz"
 ( umask 077; tar -C "$base/shared" -czf "$out.tmp" uploads ) && gzip -t "$out.tmp" || { rm -f "$out.tmp"; echo 'Kopia plików (shared/uploads) nie powstała.' >&2; return 1; }
 mv -f "$out.tmp" "$out"; chmod 600 "$out"; echo "Kopia plików: $out ($(du -h "$out" | cut -f1))"
}
# Deletes copies of one kind older than keep_days, always keeping the newest; also partial *.tmp files older than 6 h.
retain(){
 local f n=0 limit=$(( $(date +%s) - keep_days*86400 ))
 while read -r f; do [[ -n $f ]] || continue; n=$((n+1)); ((n==1)) && continue
  if (( $(stat -c %Y "$f") < limit )); then rm -f "$f"; echo "Usunięto starą kopię: $(basename "$f")"; fi
 done < <(ls -1t "$base"/backups/$1 2>/dev/null || true)
 find "$base/backups" -maxdepth 1 -name "${1}.tmp" -mmin +360 -print -delete 2>/dev/null | sed 's#^.*/#Usunięto niedokończoną kopię: #' || true
}

# Read-only report (workflow job "server_check"): nothing below is created or changed.
if [[ $cmd == server-check ]]; then
 echo "PHP 8.3 CLI: $("$php" -r 'echo PHP_VERSION;' 2>&1) ($php)"
 "$php" -r 'foreach(["pdo_mysql","mbstring","openssl","curl","gd","exif","fileinfo","intl","zlib","sodium"] as $e)echo "  ",str_pad($e,10),extension_loaded($e)?"OK":"BRAK","\n";
  if(function_exists("gd_info")){$g=gd_info();foreach(["WebP Support","JPEG Support","PNG Support"] as $k)echo "  GD $k: ",!empty($g[$k])?"tak":"NIE","\n";}
  foreach(["memory_limit","max_execution_time","upload_max_filesize","post_max_size","disable_functions"] as $k)echo "  $k=",ini_get($k),"\n";
  echo "  shell_exec (ukryte wpisywanie hasła przez stty): ",function_exists("shell_exec")&&!in_array("shell_exec",array_map("trim",explode(",",(string)ini_get("disable_functions"))),true)?"tak":"NIE","\n";
  echo "  session.save_handler=",ini_get("session.save_handler")," session.save_path=",ini_get("session.save_path")," (PHP CLI; PHP strony: panel Admina, Diagnostyka)\n";'
 for b in mysqldump mariadb-dump gzip tar crontab; do echo "$b: $(command -v $b || echo BRAK)"; done
 crontab -l >/dev/null 2>&1 && echo 'crontab -l: dostępny' || echo 'crontab -l: niedostępny lub pusty (cron w DirectAdmin: DEPLOY-PL.md)'
 [[ -d $base/shared/sessions ]] && echo "Pliki sesji w shared/sessions: $(find "$base/shared/sessions" -maxdepth 1 -name 'sess_*' 2>/dev/null | wc -l)"
 if [[ -f $cfg && -f $site/backend/bootstrap.php ]]; then
  # Same probe as the Admin diagnostics (StripeClient::probe) and the database user's rights, through PHP 8.3 and the deployed backend.
  (cd "$site" && MATDRAW_CONFIG=$cfg "$php" -r 'require "backend/bootstrap.php";
   try{$c=matdraw_config();}catch(Throwable $e){exit("Konfiguracja: błąd (".$e->getMessage().")\n");}
   if(class_exists("MatDraw\\StripeClient")&&method_exists("MatDraw\\StripeClient","probe")){$p=MatDraw\StripeClient::probe($c);echo "Stripe: ",$p["reachable"]?"osiągalny":"NIEOSIĄGALNY"," status=",$p["status"]??"-"," czas=",$p["ms"]??"-","ms TLS=",$p["tls"]??"-",$p["error"]?" błąd=".$p["error"]:"","\n";}
   try{$pdo=matdraw_database(["db"=>is_array($c["db_migrate"]??null)?$c["db_migrate"]:$c["db"]]);$g=implode(" ",$pdo->query("SHOW GRANTS FOR CURRENT_USER()")->fetchAll(PDO::FETCH_COLUMN));
    $all=(bool)preg_match("/GRANT ALL PRIVILEGES/i",$g);foreach(["ALTER","CREATE","INDEX","REFERENCES"] as $r)echo "Prawo bazy $r: ",$all||preg_match("/\\b$r\\b/i",$g)?"tak":"NIE (potrzebne do migracji, DEPLOY-PL.md)","\n";
    if(class_exists("MatDraw\\Migrator")){$m=new MatDraw\Migrator($pdo,"backend/migrations");echo "Schemat bazy: v",$m->current()," (kod v",MatDraw\Migrator::target("backend/migrations"),")\n";}
   }catch(Throwable $e){echo "Baza: błąd połączenia (",get_class($e),")\n";}' 2>&1) || true
 else echo 'Stripe i prawa bazy: brak config.php albo wdrożonego backendu.'; fi
 for k in 'db-*.sql.gz' 'uploads-*.tar.gz'; do f=$(newest "$k"); [[ -n $f ]] && echo "Najnowsza kopia $k: $(basename "$f"), $(( $(age "$f")/3600 )) h temu" || echo "Najnowsza kopia $k: brak"; done
 df -h "$base" 2>/dev/null | tail -1; ls -ld "$base/shared" "$base/shared/uploads" "$base/shared/sessions" "$base/backups" "$base/logs" 2>&1 || true
 exit 0
fi

mkdir -p "$base/releases" "$base/shared"
chmod 700 "$base/shared"
cd "$base"

case $cmd in
 check)
  [[ -f shared/config.php ]] || fail "Brak $base/shared/config.php. Utwórz go według DEPLOY-PL.md (krok 4) i uruchom deploy ponownie."
  [[ $(stat -c %a shared/config.php) == 600 ]] || echo "::warning::$base/shared/config.php powinien mieć uprawnienia 600 (chmod 600)."
  [[ -d $site ]] || fail "Brak katalogu $site. Czy domena jest dodana w DirectAdmin?"
  command -v tar >/dev/null || fail 'Brak polecenia tar na serwerze.'
  # app_url must match the served address (CSRF origin check, secure cookie); the workflow's APP_URL decides.
  want=${4:-}
  url_in(){ "$php" -r 'echo (require $argv[1])["app_url"] ?? "";' "$base/shared/config.php"; }
  if [[ -n $want && $(url_in) != "$want" ]]; then
   old=$(url_in); cp -p shared/config.php "shared/config.php.tmp.$$"
   sed -i "s#\('app_url'[[:space:]]*=>[[:space:]]*'\)[^']*'#\1$want'#" shared/config.php
   if [[ $(url_in) != "$want" ]]; then mv -f "shared/config.php.tmp.$$" shared/config.php; fail "Nie udało się ustawić app_url w $base/shared/config.php. Wpisz ręcznie: 'app_url' => '$want',"; fi
   rm -f "shared/config.php.tmp.$$"; echo "W config.php zmieniono app_url: $old -> $want"
  fi
  # Directories outside the release (plan §9.7); the PHP user must be able to write uploads.
  mkdir -p shared/uploads shared/sessions backups logs; chmod 700 shared/uploads shared/sessions backups logs
  probe="shared/uploads/.write-test.$$"; { touch "$probe" && rm -f "$probe"; } || fail "Nie można zapisywać w $base/shared/uploads."
  echo "Miejsce na dysku: $(df -h "$base" | tail -1)"
  echo "Aktywne wydanie: $(readlink current 2>/dev/null || echo 'brak (pierwsze wdrożenie)')"
  ;;
 migrate)
  # Runs the new release's migrate.php before activate, while the previous release still serves (plan §9.6).
  # Any error stops the deploy here; the database copy comes first whenever a migration is waiting.
  dir="$base/releases/$release"
  [[ -n $release && -f $dir/backend/bootstrap.php ]] || fail "Niekompletne wydanie $dir."
  [[ -f $cfg ]] || fail "Brak $cfg."
  if [[ ! -f $dir/backend/bin/migrate.php ]]; then echo 'Wydanie bez migracji bazy (brak backend/bin/migrate.php).'; exit 0; fi
  backup_dirs
  st=$(MATDRAW_CONFIG=$cfg "$php" "$dir/backend/bin/migrate.php" --status 2>&1) || fail "Nie można odczytać stanu bazy: $st"
  echo "Stan bazy: $st"
  val(){ sed -n "s/.*\\b$1=\\([A-Za-z0-9]*\\).*/\\1/p" <<<"$st" | tail -1; }
  state=$(val STATE) current=$(val CURRENT) target=$(val TARGET) pending=$(val PENDING) destructive=$(val DESTRUCTIVE)
  [[ $state =~ ^(ready|empty)$ && $current =~ ^[0-9]+$ && $target =~ ^[0-9]+$ && $pending =~ ^[0-9]+$ && $destructive =~ ^[0-9]+$ ]] || fail "Nieczytelny stan bazy: $st"
  if [[ $state == empty ]]; then echo '::warning::Baza danych jest pusta: uruchom jednorazowo instalator (DEPLOY-PL.md, krok 6). Instalator utworzy też tabele z migracji.'; exit 0; fi
  ((destructive==0)) || fail "Czeka migracja niszcząca ($destructive). Wdrożenie zatrzymane przed przełączeniem; zrób kopię bazy i uruchom ją ręcznie (migrate.php --allow-destructive)."
  f=$(newest 'db-*.sql.gz')
  if ((pending>0)) || [[ -z $f ]] || (( $(age "$f") > 86400 )); then
   ((pending>0)) && reason="pre-v$current-to-v$target" || reason=daily
   if ! dbbackup "$reason-$release" "$dir"; then
    if ((pending==0)); then warn 'Codzienna kopia bazy nie powstała. Schemat jest aktualny, wdrożenie trwa dalej; sprawdź kopie (server_check).'
    elif [[ ${ALLOW_NO_BACKUP:-} == 1 ]]; then warn 'ALLOW_NO_BACKUP=1: migracja bez kopii bazy.'
    else fail "Brak kopii bazy, więc migracja się nie odbyła. Strona działa na poprzednim wydaniu. Sprawdź server_check (mysqldump, miejsce na dysku) albo ustaw ALLOW_NO_BACKUP=1 na własne ryzyko."; fi
   fi
  else echo "Kopia bazy z ostatnich 24 h: $(basename "$f")."; fi
  f=$(newest 'uploads-*.tar.gz')
  if [[ -z $f ]] || (( $(age "$f") > 7*86400 )); then filesbackup || warn 'Kopia plików nie powstała; wdrożenie trwa dalej.'; fi
  if ((pending==0)); then echo "Schemat aktualny (v$current)."; exit 0; fi
  log="$base/logs/migrate-$release.log"
  set +e; ( umask 077; MATDRAW_CONFIG=$cfg "$php" "$dir/backend/bin/migrate.php" 2>&1 | tee -a "$log"; exit "${PIPESTATUS[0]}" ); rc=$?; set -e
  chmod 600 "$log" 2>/dev/null || true
  ((rc==0)) || fail "Migracja bazy nie powiodła się (kod $rc). Strona działa na poprzednim wydaniu. Log: $log. Najnowsza kopia bazy: $(basename "$(newest 'db-*.sql.gz')"). Po poprawce wdrożenie można powtórzyć."
  ;;
 activate)
  dir="$base/releases/$release"
  [[ -n $release && -f $dir/public/index.html && -f $dir/backend/bootstrap.php ]] || fail "Niekompletne wydanie $dir."
  floor_guard "$dir"
  ln -sfn "$base/shared/config.php" "$dir/backend/config.php"
  prev=$(readlink current 2>/dev/null || true)
  if [[ -z $prev ]]; then
   # First deploy with this base: keep whatever the site held before.
   for p in "$docroot" "$site/backend"; do if [[ -e $p || -L $p ]]; then backup "$p"; fi; done
  elif [[ $prev != "$dir" ]]; then
   printf '%s\n' "$prev" > "$dir/.previous"
  fi
  go_live "$dir"
  # DirectAdmin serves HTTPS from private_html; like DirectAdmin's own default it must link to public_html.
  if [[ -d $private_html && ! -L $private_html ]]; then backup "$private_html"; ln -s ./public_html "$private_html"; fi
  if [[ -e $private_html && $(readlink -f "$private_html") != "$(readlink -f "$docroot")" ]]; then fail "$private_html nie wskazuje na $docroot."; fi
  echo "Aktywne wydanie: $dir"
  ;;
 rollback)
  cur=$(readlink current 2>/dev/null || true)
  prev=$(cat "$cur/.previous" 2>/dev/null || true)
  [[ -n $prev && -d $prev ]] || fail 'Brak poprzedniego wydania do przywrócenia.'
  floor_guard "$prev"
  go_live "$prev"
  echo "Przywrócono wydanie: $prev (wycofane: $cur)"
  ;;
 cleanup)
  # Keep the 5 newest releases plus the active one and its predecessor.
  active=$(readlink -f current); previous=$(cat "$active/.previous" 2>/dev/null || true)
  ls -1d releases/*/ 2>/dev/null | sort -r | tail -n +6 | while read -r r; do
   r=$(readlink -f "$r"); [[ $r == "$active" || $r == "$previous" ]] || { rm -rf "$r"; echo "Usunięto stare wydanie $r"; }
  done
  # Backups: older than BACKUP_KEEP_DAYS (30) are deleted, the newest of each kind always stays (plan §9.6).
  if [[ -d backups ]]; then
   retain 'db-*.sql.gz'; retain 'uploads-*.tar.gz'
   mb=$(du -sm backups 2>/dev/null | cut -f1); [[ ${mb:-0} -le 1024 ]] || warn "Katalog $base/backups zajmuje ${mb} MB. Pobierz kopie na własny dysk i usuń najstarsze."
  fi
  ;;
 backup-db)
  # By hand over SSH (cron uses backend/bin/dump.php --auto, because this script is not kept up to date on the server).
  [[ -f $cfg ]] || fail "Brak $cfg."
  cur=$(readlink -f current 2>/dev/null || true); [[ -n $cur ]] || cur=$site
  dbbackup "manual-$(basename "$cur")" "$cur" || fail 'Kopia bazy nie powstała.'
  ;;
 backup-files)
  filesbackup || fail 'Kopia plików nie powstała.'
  ;;
 *) fail "Nieznane polecenie: $cmd" ;;
esac
