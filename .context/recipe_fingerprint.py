"""Compute the pre-service source-review fingerprint for a git ref (mirrors native_recipe)."""
import hashlib, json, runpy, subprocess, sys
mod = runpy.run_path("scripts/cloudbench-prestack-recovery.py")
RECIPE_PATHS = mod["RECIPE_PATHS"]
PACKED = ("cloudbench-benchmark-target.py","cloudbench-codex-auth.py","cloudbench-current-run-artifact.py","cloudbench-env.sh","cloudbench-exact-session-cleanup.py","cloudbench-execution-provenance.py","cloudbench-fetch-ref.sh","cloudbench-guest-recovery.py","cloudbench-install-ngrok.sh","cloudbench-prepare-patch.sh","cloudbench-run.sh","cloudbench-seed-budget.sh","cloudbench-sync-deps.sh","cloudbench-sync-prisma-client.sh","cloudbench_catalog.py")
def sha(b): return hashlib.sha256(b).hexdigest()
def recipe(ref):
    blob = lambda p: subprocess.run(["git","show",f"{ref}:{p}"],capture_output=True,check=True).stdout
    def path(n):
        if n == "cloudbench-execution-provenance.py": return "scripts/cloudbench_execution_provenance.py"
        if n in ("cloudbench-env.sh","cloudbench-seed-budget.sh"): return "scripts/lib/"+n
        return "scripts/"+n
    r = {"checkout": {p: sha(blob(p)) for p in RECIPE_PATHS},
         "injected_controls": {path(n): sha(blob(path(n))) for n in PACKED},
         "boot_controls": {n: sha(blob("scripts/"+n)) for n in ("cloudbench-boot.sh","cloudbench-boot-payload.py","cloudbench-status-server.py")}}
    return r, sha(json.dumps(r, sort_keys=True, separators=(",",":")).encode())
if __name__ == "__main__":
    for ref in sys.argv[1:]:
        r, fp = recipe(ref)
        print(ref, fp, len(r["checkout"])+len(r["injected_controls"])+len(r["boot_controls"]))
