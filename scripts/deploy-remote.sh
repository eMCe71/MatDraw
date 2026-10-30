#!/usr/bin/env bash
# Runs on the hosting server: ssh host bash -s -- <command> <base> <docroot> [release] < scripts/deploy-remote.sh
# (the workflow also keeps a copy in <base>/bin for manual use over SSH).
# Layout: <base>/releases/<release>/{public,backend}, <base>/current -> active release,
# <base>/shared/config.php (created once by the owner). The active release is copied into the real
# directories <docroot> and its sibling backend/, because public/api/index.php loads ../../backend.
set -euo pipefail
umask 022
cmd=$1 base=$2 docroot=$3 release=${4:-}
site=$(dirname "$docroot")
private_html=$site/private_html
fail(){ echo "::error::$*" >&2; exit 1; }
# Atomic symlink replacement (rename over the old link).
switch(){ ln -sfn "$2" "$1.tmp.$$"; mv -Tf "$1.tmp.$$" "$1"; }
# Content MatDraw did not deploy is moved to <base>/backups, outside web access.
backup(){ mkdir -p "$base/backups"; local to="$base/backups/$(basename "$1").before-matdraw-$(date +%Y%m%d%H%M%S)"; mv -T "$1" "$to"; echo "Poprzednią zawartość $1 przeniesiono do $to"; }
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

mkdir -p "$base/releases" "$base/shared"
chmod 700 "$base/shared"
cd "$base"

case $cmd in
 check)
  [[ -f shared/config.php ]] || fail "Brak $base/shared/config.php. Utwórz go według DEPLOY-PL.md (krok 4) i uruchom deploy ponownie."
  [[ $(stat -c %a shared/config.php) == 600 ]] || echo "::warning::$base/shared/config.php powinien mieć uprawnienia 600 (chmod 600)."
  [[ -d $site ]] || fail "Brak katalogu $site. Czy domena jest dodana w DirectAdmin?"
  command -v tar >/dev/null || fail 'Brak polecenia tar na serwerze.'
  echo "Aktywne wydanie: $(readlink current 2>/dev/null || echo 'brak (pierwsze wdrożenie)')"
  ;;
 activate)
  dir="$base/releases/$release"
  [[ -n $release && -f $dir/public/index.html && -f $dir/backend/bootstrap.php ]] || fail "Niekompletne wydanie $dir."
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
  go_live "$prev"
  echo "Przywrócono wydanie: $prev (wycofane: $cur)"
  ;;
 cleanup)
  # Keep the 5 newest releases plus the active one and its predecessor.
  active=$(readlink -f current); previous=$(cat "$active/.previous" 2>/dev/null || true)
  ls -1d releases/*/ 2>/dev/null | sort -r | tail -n +6 | while read -r r; do
   r=$(readlink -f "$r"); [[ $r == "$active" || $r == "$previous" ]] || { rm -rf "$r"; echo "Usunięto stare wydanie $r"; }
  done
  ;;
 *) fail "Nieznane polecenie: $cmd" ;;
esac
