"""Stop retained isolated local benchmark stacks through local.stop_services (identity-verified)."""
import json, sys
from pathlib import Path
sys.path.insert(0, "/home/boxes/rose/agents")
from benchmarks import local

for run_dir in sys.argv[1:]:
    ctx = Path(run_dir).resolve()
    manifest = ctx / "services.json"
    data = json.loads(manifest.read_text())
    stack = local.ServiceStack(
        run_id=ctx.name, context_dir=ctx, manifest_path=manifest, service_log=ctx / "services.log",
        isolated=True, workspace_name=data.get("workspace_name"), base_port=(data.get("ports") or {}).get("backend"),
        use_system_postgres=True,
    )
    try:
        local.stop_services(None, stack=stack)
        print(f"STOPPED {ctx.name}: receipt verified")
    except Exception as exc:  # report, never escalate to broad kills
        print(f"NOT STOPPED {ctx.name}: {exc}")
