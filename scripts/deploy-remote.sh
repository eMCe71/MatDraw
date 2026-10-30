#!/usr/bin/env bash
# Runs on the hosting server: ssh host bash -s -- <command> <base> <docroot> [release] < scripts/deploy-remote.sh
# Layout: <base>/releases/<release>/{public,backend}, <base>/current -> active release,
# <base>/shared/config.php (created once by the owner), <docroot> -> <base>/current/public.
set -euo pipefail
cmd=$1 base=$2 docroot=$3 release=${4:-}
private_html="$(dirname "$docroot")/private_html"
fail(){ echo "::error::$*" >&2; exit 1; }
# Atomic symlink replacement (rename over the old link).
switch(){ ln -sfn "$2" "$1.tmp.$$"; mv -Tf "$1.tmp.$$" "$1"; }
backup(){ local to="$1.before-matdraw-$(date +%Y%m%d%H%M%S)"; mv "$1" "$to"; echo "Poprzedni katalog $1 przeniesiono do $to"; }

mkdir -p "$base/releases" "$base/shared"
chmod 700 "$base/shared"
cd "$base"

case $cmd in
 check)
  [[ -f shared/config.php ]] || fail "Brak $base/shared/config.php. Utwórz go według DEPLOY-PL.md (krok 4) i uruchom deploy ponownie."
  command -v tar >/dev/null || fail 'Brak polecenia tar na serwerze.'
  echo "Aktywne wydanie: $(readlink current 2>/dev/null || echo 'brak (pierwsze wdrożenie)')"
  ;;
 activate)
  dir="$base/releases/$release"
  [[ -n $release && -f $dir/public/index.html && -f $dir/backend/bootstrap.php ]] || fail "Niekompletne wydanie $dir."
  ln -sfn "$base/shared/config.php" "$dir/backend/config.php"
  prev=$(readlink current 2>/dev/null || true)
  [[ -n $prev && $prev != "$dir" ]] && printf '%s\n' "$prev" > "$dir/.previous"
  switch current "$dir"
  if [[ -L $docroot ]]; then
   [[ $(readlink "$docroot") == "$base/current/public" ]] || switch "$docroot" "$base/current/public"
  else
   [[ -e $docroot ]] && backup "$docroot"
   ln -s "$base/current/public" "$docroot"
  fi
  # DirectAdmin serves HTTPS from private_html; it must lead to the same files.
  if [[ -d $private_html && ! -L $private_html ]]; then backup "$private_html"; ln -s ./public_html "$private_html"; fi
  if [[ -e $private_html && $(readlink -f "$private_html") != "$(readlink -f "$docroot")" ]]; then fail "$private_html nie wskazuje na $docroot."; fi
  echo "Aktywne wydanie: $dir"
  ;;
 rollback)
  cur=$(readlink current 2>/dev/null || true)
  prev=$(cat "$cur/.previous" 2>/dev/null || true)
  [[ -n $prev && -d $prev ]] || fail 'Brak poprzedniego wydania do przywrócenia.'
  switch current "$prev"
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
