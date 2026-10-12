. /home/boxes/rose/.context/g5/common.sh
T=$(grep -E '^GITHUB_TOKEN=' agents/.env | cut -d= -f2- | tr -d '"'"'"); R=https://api.github.com/repos/Rose-Ai-Labs/rose
python3 scripts/record_factory_event.py deploy production-start vercel >/dev/null
for i in $(seq 1 120); do
  DID=$(curl -s -H "Authorization: Bearer $T" "$R/deployments?sha=$DEPLOY_MERGED_SHA" | python3 -c "import json,sys; d=json.load(sys.stdin); r=[x for x in d if isinstance(x,dict) and (x.get('creator') or {}).get('login')=='vercel[bot]']; print(r[0]['id'] if r else '')")
  if [ -n "$DID" ]; then
    ST=$(curl -s -H "Authorization: Bearer $T" "$R/deployments/$DID/statuses" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['state'] if d else 'pending')")
    echo "  Vercel: state=$ST deployment=$DID"
    case "$ST" in success) python3 scripts/record_factory_event.py deploy production-finish vercel >/dev/null; echo "VERCEL_OK"; exit 0;; failure|error|inactive) echo "VERCEL_FAILED $ST"; exit 1;; esac
  else echo "  Vercel: no deployment for sha yet"; fi
  sleep 10
done
echo "VERCEL_TIMEOUT"; exit 1
