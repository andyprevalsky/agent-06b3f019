#!/bin/bash
# Reproduce check_observation_validity under CPU contention: 16 busy loops on 8 cores.
cd "$1"
pids=(); for i in $(seq 1 16); do (while :; do :; done) & pids+=($!); done
/home/boxes/rose/agents/venv/bin/python - <<'PY'
import importlib.util, sys, tempfile, os
from pathlib import Path
spec = importlib.util.spec_from_file_location("t", "scripts/tests/run-deploy-pipeline.test.py")
t = importlib.util.module_from_spec(spec); sys.argv=["t"]; spec.loader.exec_module(t)
ok = fail = 0
for i in range(8):
    with tempfile.TemporaryDirectory(prefix="obs-") as raw:
        tmp = Path(raw)
        source_root = t.make_source_root(tmp / "source"); t.DRIVER = source_root / "scripts" / "run_deploy_pipeline.py"
        env = {**{k: v for k, v in os.environ.items() if not k.startswith("DEPLOY_ADMISSION_") and k not in {"FACTORY_METADATA_FILE", "DEPLOY_LANE_SCOPED_REUSE"}},
               "DEPLOY_RUN_ROOT": str(tmp / "runs"), "DEPLOY_PIPELINE_SOURCE_ROOT": str(source_root)}
        t.start_timing(tmp / "runs", env)
        try:
            t.check_observation_validity(tmp, env); ok += 1
        except AssertionError as e:
            fail += 1; print("FAIL", str(e)[:170])
print("ok", ok, "fail", fail)
PY
kill "${pids[@]}" 2>/dev/null
