#!/usr/bin/env bash
# Prepares the CI runner's SSH client (host alias "deploy") from the production environment secrets.
set -euo pipefail
for v in SSH_HOST SSH_PORT SSH_USER SSH_PRIVATE_KEY SSH_KNOWN_HOSTS; do
 [[ -n ${!v:-} ]] || { echo "::error::Brak sekretu $v w środowisku production (Settings → Environments → production)."; exit 1; }
done
install -m 700 -d ~/.ssh
printf '%s\n' "$SSH_PRIVATE_KEY" > ~/.ssh/deploy_key && chmod 600 ~/.ssh/deploy_key
printf '%s\n' "$SSH_KNOWN_HOSTS" > ~/.ssh/known_hosts
printf 'Host deploy\n HostName %s\n Port %s\n User %s\n IdentityFile ~/.ssh/deploy_key\n IdentitiesOnly yes\n StrictHostKeyChecking yes\n' "$SSH_HOST" "$SSH_PORT" "$SSH_USER" > ~/.ssh/config
ssh deploy true && exit 0
# Host key mismatch diagnostics: entries stored in the secret vs. keys the server presents (fingerprints are public).
echo "::group::Diagnostyka SSH_KNOWN_HOSTS"
echo "Wpisy w sekrecie (host, typ; ***=SSH_HOST):"; awk '!/^#/ && NF>=3 {print "  "$1"  "$2}' ~/.ssh/known_hosts
grep -q '^#' ~/.ssh/known_hosts && echo "  (są linie komentarza #, które nie zawierają kluczy)"
echo "Odciski w sekrecie:"; ssh-keygen -lf ~/.ssh/known_hosts 2>&1 | sed 's/^/  /'
echo "Odciski, które pokazuje serwer na porcie SSH_PORT:"; ssh-keyscan -p "$SSH_PORT" "$SSH_HOST" 2>/dev/null | ssh-keygen -lf - 2>&1 | sed 's/^/  /'
echo "::endgroup::"
echo "::error::SSH_KNOWN_HOSTS nie pasuje do serwera. Wklej pełny wynik: ssh-keyscan -p <SSH_PORT> <SSH_HOST> (linie bez #)."
exit 1
