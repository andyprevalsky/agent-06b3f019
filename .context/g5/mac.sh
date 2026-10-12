. /home/boxes/rose/.context/g5/common.sh
python3 scripts/record_factory_event.py deploy production-start mac-release >/dev/null
MT=$(date -u -d '-10 min' +%Y-%m-%dT%H:%M:%SZ)
for wf in release-mac-app.yml; do :; done
RID=""
for i in $(seq 1 90); do
  RID=$(gh run list --workflow release-mac-app.yml --limit 10 --json databaseId,createdAt,headSha,event --jq ".[] | select(.createdAt >= \"$MT\") | .databaseId" 2>/dev/null | head -1)
  [ -n "$RID" ] && break
  sleep 20
done
[ -n "$RID" ] || { echo "MAC_RELEASE_NOT_STARTED"; gh run list --limit 8 --json name,createdAt,status,conclusion,headSha --jq '.[] | "\(.createdAt) \(.name) \(.status) \(.conclusion) \(.headSha[0:9])"'; exit 1; }
echo "mac release run=$RID"
while true; do S=$(gh run view $RID --json status,conclusion --jq '"\(.status) \(.conclusion)"'); case "$S" in completed*) echo "MAC_RELEASE $S"; [ "$S" = "completed success" ] && python3 scripts/record_factory_event.py deploy production-finish mac-release >/dev/null; exit 0;; esac; sleep 30; done
