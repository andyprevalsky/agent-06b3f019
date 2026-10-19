#!/usr/bin/env bash
source /home/boxes/rose/.context/g4/env.sh
export GH_TOKEN=$(set -a && . agents/.env >/dev/null 2>&1 && printf %s "$GITHUB_TOKEN")
export PATH="/opt/devbox-tools/gh/current/bin:$PATH"
REVIEW_HEAD=$(python3 scripts/deploy_review_cycle.py status | python3 -c 'import json,sys; print(json.load(sys.stdin)["cycles"][-1]["head"])')
bash scripts/wait-for-code-review --pr 1473 --head "$REVIEW_HEAD" --timeout 900 --poll 10 > .context/g4/review.log 2>&1; echo "exit=$?" >> .context/g4/review.log
