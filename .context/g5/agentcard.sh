. /home/boxes/rose/.context/g5/common.sh
python3 scripts/record_factory_event.py deploy production-start agentcard >/dev/null
source agents/venv/bin/activate
scripts/run-bench agent-payment-production-abandonment; rc=$?
echo "AGENTCARD_PROD_EXIT=$rc"
[ "$rc" = "0" ] && python3 scripts/record_factory_event.py deploy production-finish agentcard >/dev/null
exit $rc
