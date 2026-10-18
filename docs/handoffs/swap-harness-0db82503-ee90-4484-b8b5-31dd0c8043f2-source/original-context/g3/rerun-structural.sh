#!/usr/bin/env bash
cd /home/boxes/rose
export ROSE_USE_SYSTEM_PG=true; source .cloud-env
export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
export PATH="$HOME/.fly/bin:/home/boxes/rose/agents/venv/bin:$PATH"
bash scripts/run-deploy-stage deploy-command-structural -- python3 scripts/run-deploy-structural-gates.py --max-workers 4 > .context/g3/deploy-structural-2.log 2>&1; echo "exit=$?" >> .context/g3/deploy-structural-2.log
