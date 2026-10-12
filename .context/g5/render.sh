. /home/boxes/rose/.context/g5/common.sh
python3 scripts/record_factory_event.py deploy production-start render >/dev/null
cd back-end && set -a && . ./.env && set +a
DEPLOY_OK=""
for i in $(seq 1 120); do
  read -r STATUS COMMIT < <(curl -s -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys?limit=1" | python3 -c "import sys,json; d=json.load(sys.stdin)[0]['deploy']; print(d.get('status',''), (d.get('commit') or {}).get('id','')[:7])")
  echo "  Render: status=$STATUS commit=$COMMIT (want ${DEPLOY_MERGED_SHA:0:7})"
  case "$STATUS" in
    live) [ "$COMMIT" = "${DEPLOY_MERGED_SHA:0:7}" ] && { DEPLOY_OK=1; break; } ;;
    build_failed|update_failed|canceled|pre_deploy_failed) echo "RENDER_FAILED $STATUS"; exit 1 ;;
  esac
  sleep 10
done
[ "$DEPLOY_OK" = "1" ] || { echo "RENDER_NOT_LIVE"; exit 1; }
echo "RENDER_LIVE ${DEPLOY_MERGED_SHA:0:7}"
python3 ../scripts/record_factory_event.py deploy production-finish render >/dev/null
python3 ../scripts/record_factory_event.py deploy production-start backend-probes >/dev/null
PROD_URL="https://navi-j9a9.onrender.com"; USER_ID="1f85ff25-6e29-4c1b-8739-f917bd101a30"
curl -sf "$PROD_URL/health" >/dev/null || { echo "PROBE_FAIL health"; exit 1; }
HEALTHY=""; for i in $(seq 1 12); do CODE=$(curl -s -o /tmp/prod-agents.json -w "%{http_code}" "$PROD_URL/api/agents" -H "X-API-Key: $BACKEND_API_KEY" -H "X-User-Id: $USER_ID"); [ "$CODE" = "200" ] && { HEALTHY=1; break; }; echo "  /api/agents -> $CODE"; sleep 5; done
[ "$HEALTHY" = "1" ] || { echo "PROBE_FAIL api/agents $CODE"; exit 1; }
echo "PROBE_OK api/agents"
env -u SMOKE_BASE_URL -u SMOKE_HEALTH_URL -u SMOKE_FRONTEND_URL npx tsx scripts/prod-endpoint-smoke.ts 2>&1 | tail -15; rc=${PIPESTATUS[0]}
[ "$rc" = "0" ] || { echo "PROBE_FAIL endpoint-smoke rc=$rc"; exit 1; }
sleep 30
curl -s -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/logs?ownerId=$RENDER_OWNER_ID&resource=$RENDER_SERVICE_ID&limit=100&direction=backward" | python3 -c "
import sys, json
logs = json.load(sys.stdin)['logs']
bad = [l for l in logs if any(s in l['message'] for s in ('prisma:error', 'does not exist', '-> 500', '\"status\":500'))]
print(f'post-deploy error lines: {len(bad)}')
for l in bad[:10]: print(l['timestamp'][11:19], l['message'][:160])
sys.exit(1 if bad else 0)
" || { echo "PROBE_FAIL log-scan"; exit 1; }
python3 ../scripts/record_factory_event.py deploy production-finish backend-probes >/dev/null
echo "RENDER_LANE_OK"
