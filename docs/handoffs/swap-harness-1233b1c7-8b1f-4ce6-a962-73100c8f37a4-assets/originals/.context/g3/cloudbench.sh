. /home/boxes/rose/.context/g3/env.sh
bash scripts/run-deploy-stage cloudbench-controller -- bash scripts/run-cloudbench-controller-gate; e1=$?
cd agents && ./venv/bin/python scripts/run_blackbox_tests.py benchmark; e2=$?
echo "CLOUDBENCH_DONE gate=$e1 benchmark-domain=$e2"
