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
ssh deploy true
