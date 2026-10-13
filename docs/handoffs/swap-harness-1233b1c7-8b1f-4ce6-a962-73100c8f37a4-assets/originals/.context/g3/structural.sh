. /home/boxes/rose/.context/g3/env.sh
bash scripts/run-deploy-stage deploy-command-structural --reuse-passed -- python3 scripts/run-deploy-structural-gates.py --max-workers 4; e1=$?
bash scripts/run-deploy-stage seed-cache-decision --reuse-passed -- bash scripts/tests/seed-cache-decision.test.sh; e2=$?
bash scripts/run-deploy-stage canonical-seed-whatsapp-content --reuse-passed -- bash scripts/tests/canonical-seed-whatsapp-content.test.sh; e3=$?
echo "STRUCTURAL_DONE deploy-command=$e1 seed-cache=$e2 whatsapp=$e3"
