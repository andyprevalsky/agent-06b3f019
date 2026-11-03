#!/usr/bin/env bash
cd /home/boxes/rose/back-end
export ROSE_USE_SYSTEM_PG=true; source ../.cloud-env
export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
export PATH="$HOME/.fly/bin:/home/boxes/rose/agents/venv/bin:$PATH"
bash ../scripts/run-deploy-stage seed-memory-ratchet -- bash scripts/measure-seed-memory.sh 5 0 0 --enforce-budget > ../.context/g3/seed-ratchet.log 2>&1; echo "exit=$?" >> ../.context/g3/seed-ratchet.log
