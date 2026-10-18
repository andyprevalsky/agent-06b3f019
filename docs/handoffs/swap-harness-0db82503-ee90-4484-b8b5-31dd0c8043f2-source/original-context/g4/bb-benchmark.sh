#!/bin/bash
cd /home/boxes/rose/agents
source venv/bin/activate
export ROSE_USE_SYSTEM_PG=true
[ -f ../.cloud-env ] && . ../.cloud-env
python scripts/run_blackbox_tests.py benchmark
echo "EXIT=$?"
