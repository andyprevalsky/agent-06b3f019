#!/usr/bin/env bash
# Sol via Azure Foundry: export prod's AZURE_FOUNDRY_* into this process only (never written or printed).
set -u
cd /home/boxes/rose/back-end
eval "$(timeout 90 npx tsx scripts/render-env.ts AZURE_FOUNDRY_ENDPOINT AZURE_FOUNDRY_API_KEY AZURE_FOUNDRY_DEPLOYMENTS 2>/dev/null | sed -nE "s/^(AZURE_FOUNDRY_[A-Z_]+) = (.+)$/export \1='\2'/p")"
n=0; for k in AZURE_FOUNDRY_ENDPOINT AZURE_FOUNDRY_API_KEY AZURE_FOUNDRY_DEPLOYMENTS; do [ -n "${!k:-}" ] && n=$((n+1)); done
echo "azure vars exported: $n/3" >> /home/boxes/rose/.context/rca-tamy-eta/bench2/status.txt
[ "$n" -eq 3 ] || exit 1
cd /home/boxes/rose/.context/rca-tamy-eta/bench2 && exec ./run-config.sh sol-azure 4 rose-labs/rose-1-ultra pool-default
