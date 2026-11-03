#!/usr/bin/env bash
source /home/boxes/rose/.context/g4/env.sh
bash scripts/run-deploy-stage smoke -- bash scripts/run-predeploy-local > .context/g4/smoke.log 2>&1; echo "exit=$?" >> .context/g4/smoke.log
