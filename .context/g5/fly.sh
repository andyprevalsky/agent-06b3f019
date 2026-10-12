. /home/boxes/rose/.context/g5/common.sh
python3 scripts/record_factory_event.py deploy production-start fly >/dev/null
RID=""
for i in $(seq 1 120); do
  RID=$(gh run list --workflow deploy-agents.yml --branch main --limit 30 --json databaseId,headSha --jq ".[] | select(.headSha == \"$DEPLOY_MERGED_SHA\") | .databaseId" 2>/dev/null | head -1)
  [ -n "$RID" ] && break; sleep 5
done
[ -n "$RID" ] || { echo "FLY_RUN_NOT_STARTED"; exit 1; }
ATT=$(gh api "repos/Rose-Ai-Labs/rose/actions/runs/$RID" --jq '.run_attempt')
echo "AGENT_DEPLOYMENT_TOKEN=${RID}-${ATT}"
echo "${RID}-${ATT}" > /home/boxes/rose/.context/g5/agent-deployment-token
cd back-end && set -a && . ./.env && set +a
HASH=$(python3 ../scripts/agent_workflow_surface_hash.py)
OLDP=$(npx tsx scripts/set-agent-queue-pointer.ts --read 2>/dev/null || echo null)
OLDQ=$(printf '%s' "$OLDP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.split("\n").reverse()){const t=l.trim();if(!t.startsWith("{"))continue;try{const o=JSON.parse(t);process.stdout.write(String(o?.taskQueue||""));return}catch{}}})')
OLDH=$(printf '%s' "$OLDP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.split("\n").reverse()){const t=l.trim();if(!t.startsWith("{"))continue;try{const o=JSON.parse(t);process.stdout.write(String(o?.surfaceHash||""));return}catch{}}})')
if [ -n "$OLDH" ] && [ "$OLDH" != "$HASH" ]; then echo "Pre-cutover generation: hash=$OLDH queue=$OLDQ (new hash=$HASH)"; else OLDQ=""; echo "Same-generation rolling deploy expected (hash=$HASH)"; fi
printf 'HASH=%s\nOLDQ=%s\n' "$HASH" "$OLDQ" > /home/boxes/rose/.context/g5/cutover.env
python3 ../scripts/record_factory_event.py deploy stage-start cooperative-cutover >/dev/null
for i in $(seq 1 420); do
  ST=$(gh run view "$RID" --json status,conclusion --jq '[.status, (.conclusion // "none")] | join("|")' 2>/dev/null)
  IFS='|' read -r S C <<<"$ST"
  if [ $((i % 6)) -eq 1 ]; then echo "--- cutover progress (run $RID, $S) $(date -u +%T)"; npx tsx scripts/monitor-cooperative-cutover.ts --expected-hash "$HASH" ${OLDQ:+--old-queue "$OLDQ"} 2>&1 | tail -6 || true; fi
  case "$S" in completed) [ "$C" = success ] && break; echo "FLY_CUTOVER_FAILED $C"; exit 1;; esac
  sleep 10
done
[ "$C" = success ] || { echo "FLY_CUTOVER_TIMEOUT"; exit 1; }
python3 ../scripts/record_factory_event.py deploy stage-finish cooperative-cutover >/dev/null
echo "FLY_WORKFLOW_OK"
