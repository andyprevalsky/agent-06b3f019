#!/bin/bash
# Wait for the Claude review fallback run on HEAD created after the recorded timestamp; print terminal conclusion.
cd /home/boxes/rose
T=$(grep -E '^GITHUB_TOKEN=' agents/.env | cut -d= -f2- | tr -d '"'"'"); R=https://api.github.com/repos/Rose-Ai-Labs/rose
HEAD_SHA="$1"; TS=$(cat .context/g4/fallback-c2.ts); id=""
for i in $(seq 1 60); do
  id=$(curl -s -H "Authorization: Bearer $T" "$R/actions/workflows/claude-code-review-fallback.yml/runs?head_sha=$HEAD_SHA&per_page=20" | python3 -c "import json,sys;d=json.load(sys.stdin);r=[x for x in d.get('workflow_runs',[]) if x['created_at']>'$TS'];print(r[0]['id'] if r else '')")
  [ -n "$id" ] && break; sleep 15
done
[ -n "$id" ] || { echo "FALLBACK_NOT_STARTED"; exit 1; }
echo "run=$id"
while true; do
  s=$(curl -s -H "Authorization: Bearer $T" "$R/actions/runs/$id" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status'),d.get('conclusion'))")
  case "$s" in completed*) echo "FALLBACK $s"; exit 0;; esac
  sleep 20
done
