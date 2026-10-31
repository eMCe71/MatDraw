#!/usr/bin/env bash
# Load probe of the public chat (plan §9.11 step 12, reports 02 §6 and 04 §2.c). Run it from a laptop or a phone hotspot,
# never from the server and never from GitHub Actions (the hosting answers 403 to data-centre addresses):
#   bash scripts/poll-probe.sh https://matbravo.com 5 600
# <parallel> loops (1-50), each requesting ?route=public-chat every 2.5 s like an open chat, and ?route=public-chat-channels
# on its first request and then every 30 s, for <seconds> (1-7200). No cookies are sent or kept, so the probe sees exactly what
# a guest sees. Prints the count of every status code and the slowest answer; exit code 1 when any answer was
# 429/503/508 (hosting limits) or no answer came at all (code 000), else 0.
set -uo pipefail
url=${1:-} par=${2:-5} secs=${3:-600}
[[ $url =~ ^https?://[A-Za-z0-9.:-]+(/[A-Za-z0-9._/-]*)?$ && $par =~ ^[0-9]+$ && $secs =~ ^[0-9]+$ ]] && ((par>=1 && par<=50 && secs>=1 && secs<=7200)) \
 || { echo "Użycie: bash scripts/poll-probe.sh <adres strony, np. https://matbravo.com> <równoległość 1-50> <sekundy 1-7200>" >&2; exit 2; }
api=${url%/}/api/index.php
tmp=$(mktemp -d); trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$tmp"' EXIT
# One request: "<code> <seconds>" appended to the loop's log. --max-time keeps a hung request from stalling the loop.
hit(){ local r; r=$(curl -sS -o "$tmp/body.$1" -w '%{http_code} %{time_total}' --max-time 20 -H 'Accept: application/json' "$2" 2>/dev/null); echo "${r:-000 20}" >> "$tmp/log.$1"; }
# A lobby channel id from the public channel list, so the poll asks for a real channel (as the chat client does).
ch=$(curl -sS --max-time 20 "$api?route=public-chat-channels" 2>/dev/null | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
q="$api?route=public-chat"; [[ -n $ch ]] && q="$q&ch=$ch:0"
echo "Sonda: równoległe pętle: $par, czas: $secs s, odstęp 2,5 s, adres: $q"
end=$(( $(date +%s) + secs ))
for i in $(seq 1 "$par"); do
 ( n=0; sleep "0.$((i*37%10))"
   while (( $(date +%s) < end )); do
    ((n%12==0)) && hit "$i" "$api?route=public-chat-channels"
    hit "$i" "$q"; n=$((n+1)); sleep 2.5
   done ) &
done
wait
cat "$tmp"/log.* 2>/dev/null > "$tmp/all"
total=$(wc -l < "$tmp/all")
echo "Żądania: $total"
awk '{c[$1]++} END{for(k in c)printf "  HTTP %s: %d\n",k,c[k]}' "$tmp/all" | sort
awk 'BEGIN{m=0} {if($2>m)m=$2} END{printf "Najwolniejsza odpowiedź: %.2f s\n",m}' "$tmp/all"
bad=$(awk '$1==429||$1==503||$1==508||$1=="000"{n++} END{print n+0}' "$tmp/all")
if ((bad>0 || total==0)); then echo "WYNIK: $bad odpowiedzi 429/503/508 lub bez odpowiedzi. Hosting ogranicza ruch: zobacz DEPLOY-PL.md, „Odpowiedzi hostingu 429/503”."; exit 1; fi
echo "WYNIK: brak odpowiedzi 429/503/508."
