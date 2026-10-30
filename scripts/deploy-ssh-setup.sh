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
# Connection failure diagnostics: entries stored in the secret vs. keys the server presents (fingerprints are public).
echo "::group::Diagnostyka SSH_KNOWN_HOSTS"
echo "Linie w sekrecie (liczba pól i rodzaj pierwszego pola; poprawna linia: 3 pola, host typ klucz):"
awk 'NF{t=$1; k=(t~/^(ssh-|ecdsa-)/)?"typ klucza "t:(t~/^SHA256:/)?"odcisk SHA256 (to nie jest klucz)":(t~/^#/)?"komentarz #":(t~/^-----BEGIN/)?"klucz prywatny (NIE wklejaj go tutaj!)":"host lub inne"; print "  linia "NR": "NF" pól, "k}' ~/.ssh/known_hosts
echo "Odciski w sekrecie:"; ssh-keygen -lf ~/.ssh/known_hosts 2>&1 | sed 's/^/  /' || true
echo "Odciski, które pokazuje serwer na porcie SSH_PORT:"; ssh-keyscan -p "$SSH_PORT" "$SSH_HOST" 2>/dev/null | ssh-keygen -lf - 2>&1 | sed 's/^/  /' || true
echo "::endgroup::"
echo "::error::Połączenie SSH nieudane. \"Host key verification failed\" = popraw SSH_KNOWN_HOSTS (ssh-keyscan -p <SSH_PORT> <SSH_HOST>); \"Permission denied\" lub \"Load key\" = popraw SSH_PRIVATE_KEY albo klucz w DirectAdmin."
exit 1
