. /home/boxes/rose/.context/g5/common.sh
if [ -x /opt/devbox-tools/gh/current/bin/gh ]; then GH=/opt/devbox-tools/gh/current/bin/gh; else GH=$(command -v gh); fi
export GH_TOKEN=$(set -a && . back-end/.env >/dev/null && printf %s "$GITHUB_TOKEN")
python3 scripts/record_factory_event.py deploy production-start semantic >/dev/null
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
$GH workflow run chat-lifecycle-ratchet.yml --ref main -f frontend_url=https://www.roselabs.ai -f backend_url=https://navi-j9a9.onrender.com || { echo "SEMANTIC_DISPATCH_FAILED"; exit 1; }
RID=""; for i in $(seq 1 40); do RID=$($GH run list --workflow chat-lifecycle-ratchet.yml --event workflow_dispatch --branch main --limit 20 --json databaseId,createdAt --jq ".[] | select(.createdAt >= \"$TS\") | .databaseId" | head -1); [ -n "$RID" ] && break; sleep 5; done
[ -n "$RID" ] || { echo "SEMANTIC_NOT_STARTED"; exit 1; }
echo "semantic run=$RID"
while true; do S=$($GH run view $RID --json status,conclusion --jq '"\(.status) \(.conclusion)"'); case "$S" in completed*) echo "SEMANTIC $S"; [ "$S" = "completed success" ] && { python3 scripts/record_factory_event.py deploy production-finish semantic >/dev/null; exit 0; }; exit 1;; esac; sleep 30; done
