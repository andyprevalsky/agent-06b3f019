#!/usr/bin/env bash
source /home/boxes/rose/.context/g4/env.sh
bash scripts/list-services.sh > .context/g4/sweep.log 2>&1
bash scripts/kill-services.sh >> .context/g4/sweep.log 2>&1; echo "exit=$?" >> .context/g4/sweep.log
