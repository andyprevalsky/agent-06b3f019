#!/bin/bash
# Usage: prepare.sh <trial-number> <seed>   (run from /home/boxes/rose on a branch cut from main)
set -euo pipefail
n="$1"; seed="$2"
. /tmp/deploy-env.sh
umask 077
trial_dir=".context/daily-live50/$(date -u +%Y%m%d-%H%M%S)-t$n"
mkdir -p "$trial_dir"
# Benign source marker, committed and pushed so the ref is fetchable.
printf '# Independent ordinary DAILY LIVE50 trial %s source marker (%s).\n' "$n" "$(date -u +%F)" >> agents/benchmarks/__init__.py
git add agents/benchmarks/__init__.py
git -c user.name="Andy Prevalsky" commit -q -m "Add DAILY LIVE50 trial $n source marker"
git push -q origin HEAD
trial_ref=$(git rev-parse HEAD); echo "$trial_ref" > "$trial_dir/trial-ref"
# Sample fifty distinct eligible DAILY tasks with a recorded seed.
python3 - "$trial_dir" "$seed" <<'PY'
import json, subprocess, sys
from pathlib import Path
sys.path.insert(0, "scripts")
from cloudbench_catalog import resolve_task_selection
from fleet_infra_sample import catalog_path
d, seed = Path(sys.argv[1]), sys.argv[2]
daily = resolve_task_selection(catalog_path(Path.cwd()), ["daily"])
from fleet_infra_sample import eligible_pool
eligible = set(eligible_pool(Path.cwd(), None, require_cloud_root=True, minimum_successful_llm=3))
(d / "daily-pool.json").write_text(json.dumps([n for n in daily if n in eligible]))
out = subprocess.run([sys.executable, "scripts/fleet_infra_sample.py", "sample", "--pool-file", str(d / "daily-pool.json"),
                      "--require-cloud-root", "--min-successful-llm", "3", "--width", "50", "--seed", seed, "--json"],
                     capture_output=True, text=True, check=True).stdout
names = json.loads(out)
names = names if isinstance(names, list) else names.get("tasks") or names.get("names")
assert len(names) == 50 == len(set(names)), names
(d / "tasks.json").write_text(json.dumps(names))
(d / "seed").write_text(seed + "\n")
print(len(names), "tasks sampled")
PY
# Backend import check from Fresh clone setup, then start the image clock.
(cd back-end && node --import tsx -e "require('./scripts/seed-dump-cache.ts'); console.log('backend seed-cache imports ready')")
echo "$trial_dir"
