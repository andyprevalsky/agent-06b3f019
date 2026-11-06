#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "$(uname -s)" != "Linux" ]; then
    exec python3 "$ROOT/scripts/tests/run-cloudbench-controller-linux.py" \
        --fixture export-recovery
fi

for interpreter in python3 /usr/bin/python3; do
    if "$interpreter" -c 'import os, signal, sys; assert sys.version_info >= (3, 11) and hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"); fd = os.pidfd_open(os.getpid()); os.close(fd)' >/dev/null 2>&1; then
        if [ -e "$ROOT/.git" ]; then
            exec "$interpreter" "$ROOT/scripts/tests/cloudbench-resume-controller-export.test.py"
        fi
        # Offline dispatcher mounts contain source files, but no Git metadata.
        # Copy them as this fixture user, preserving bytes and readable modes.
        exec "$interpreter" - "$ROOT" <<'PY_SOURCE'
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory(prefix="export-recovery-source-") as temporary:
    root = Path(temporary) / "repo"
    source = Path(sys.argv[1])
    for relative in ("scripts", "agents/benchmarks"):
        shutil.copytree(source / relative, root / relative)
    registry = Path("agents/providers/rose/pools.py")
    (root / registry).parent.mkdir(parents=True)
    shutil.copy2(source / registry, root / registry)
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "add", "--force", "scripts", "agents/benchmarks", "agents/providers/rose/pools.py"], check=True)
    subprocess.run([
        "git", "-C", str(root), "-c", "user.name=Export recovery fixture",
        "-c", "user.email=export-fixture@example.invalid", "-c", "commit.gpgsign=false",
        "commit", "-qm", "Offline export recovery source fixture",
    ], check=True)
    raise SystemExit(subprocess.run([
        sys.executable, str(root / "scripts/tests/cloudbench-resume-controller-export.test.py"),
    ]).returncode)
PY_SOURCE
    fi
done

exec python3 "$ROOT/scripts/tests/run-cloudbench-controller-linux.py" \
    --fixture export-recovery
