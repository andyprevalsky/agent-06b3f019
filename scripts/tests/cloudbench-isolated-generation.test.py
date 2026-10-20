#!/usr/bin/env python3
"""Offline guest-isolation controls; real mount test requires Linux sudo capability."""

import base64
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / "cloudbench-isolated-generation.py"
spec = importlib.util.spec_from_file_location("generation", HELPER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def envelope():
    claim = "a" * 32
    value = {
        "schema": "cloudbench-archived-reuse-v1",
        "storage_mode": module.MODE,
        "claim_id": claim,
        "generation_id": claim,
        "machine_id": "a" * 14,
        "volume_id": "vol_fixture",
        "source_instance_id": "instance-before",
        "source_config_sha256": "b" * 64,
        "predecessor_archive_sha256s": ["c" * 64],
        "successor": {
            "controller_id": "controller",
            "harness_ref": "d" * 40,
            "task_ref": "e" * 40,
            "run_id": "new-run",
            "owner_token": "new-owner",
            "task": "same-task",
            "ordinal": 0,
        },
        "guest": {
            "data_dir": "/data/.cloudbench-generations/" + claim,
            "repo_dir": "/data/.cloudbench-generations/" + claim + "/repo",
        },
        "native_marker_sha256": "f" * 64,
    }
    raw = json.dumps(value).encode()
    env = {
        "CLOUDBENCH_STORAGE_MODE": module.MODE,
        "CLOUDBENCH_ARCHIVED_REUSE_PROOF_B64": base64.b64encode(raw).decode(),
        "CLOUDBENCH_ARCHIVED_REUSE_PROOF_SHA256": hashlib.sha256(raw).hexdigest(),
        "FLY_MACHINE_ID": value["machine_id"],
        "REF": "e" * 40,
        "CLOUDBENCH_RUN_TOKEN": "new-owner-0",
    }
    return value, env


def namespace_case():
    """Only modifies a private temporary bind mount; never the host /data."""
    with tempfile.TemporaryDirectory(prefix="generation-real-") as folder:
        root = Path(folder)
        root.chmod(0o755)
        helper = root / "generation.py"
        shutil.copyfile(HELPER, helper)
        helper.chmod(0o700)
        fetch = root / "cloudbench-fetch-ref.sh"
        shutil.copyfile(HELPER.with_name("cloudbench-fetch-ref.sh"), fetch)
        shutil.copyfile(helper, root / "cloudbench-isolated-generation.py")
        driver_source = HELPER.with_name("cloudbench-run.sh").read_text()
        admission = driver_source.split("# ── 0. Sanity:", 1)[1].split('cd "$REPO_DIR"', 1)[0]
        admission = admission[admission.index('if [ "${CLOUDBENCH_COLD_PRIMARY_BOOTSTRAP') :]
        driver = root / "driver-admission.sh"
        driver.write_text(
            'set -eu\nBENCH_SIMULATE=0\nAPP_USER=""\nREPO_DIR="$CLOUDBENCH_REPO_DIR"\nFETCH_REF_SCRIPT="$FETCH_HELPER"\nlog(){ echo "$*"; }\nfinish(){ exit "$1"; }\n'
            + admission
        )
        origin = root / "origin"
        subprocess.run(["git", "init", "-q", str(origin)], check=True)
        (origin / "EXACT-SOURCE").write_text("new-source-only")
        subprocess.run(["git", "-C", str(origin), "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(origin),
                "-c",
                "user.name=fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-qm",
                "fixture",
            ],
            check=True,
        )
        task_ref = subprocess.check_output(["git", "-C", str(origin), "rev-parse", "HEAD"], text=True).strip()
        bin_dir = root / "bin"
        bin_dir.mkdir()
        git = bin_dir / "git"
        git.write_text(
            '#!/bin/bash\nargs=("$@")\nfor ((i=0;i<${#args[@]};i++)); do if [[ "${args[i]}" == https://github.com/Rose-Ai-Labs/rose.git ]]; then args[i]="$LOCAL_ORIGIN"; fi; done\nexec /usr/bin/git "${args[@]}"\n'
        )
        git.chmod(0o755)
        data = root / "data"
        data.mkdir(mode=0o755)
        sentinel = data / "OLD-ARCHIVE"
        sentinel.write_text("old-data-must-stay")
        before = hashlib.sha256(sentinel.read_bytes()).hexdigest()
        subprocess.run(["mount", "--bind", str(data), str(data)], check=True)
        try:
            boot = root / "boot.sh"
            boot.write_text("""set -eu
[ ! -e "$CLOUDBENCH_DATA_DIR/OLD-ARCHIVE" ]
[ ! -e "$CLOUDBENCH_DATA_DIR/.cloudbench-generations" ]
bash "$DRIVER_ADMISSION"
[ "$(cat "$CLOUDBENCH_REPO_DIR/EXACT-SOURCE")" = new-source-only ]
[ "$CLOUDBENCH_FRESH_VOLUME" = 0 ]
setpriv --reuid=65534 --regid=65534 --clear-groups python3 -c '
import os,pathlib
root=pathlib.Path(os.environ["CLOUDBENCH_DATA_DIR"])
assert not (root/"OLD-ARCHIVE").exists()
try:
 pathlib.Path("/proc/"+os.environ["OUTER_PID"]+"/root"+str(root)+"/OLD-ARCHIVE").read_bytes()
except (PermissionError,FileNotFoundError): pass
else: raise AssertionError("old root reachable through proc")
assert not pathlib.Path("/proc/self/fd/9").exists()
assert os.getcwd()=="/"
assert not int(pathlib.Path("/proc/self/status").read_text().split("CapEff:\\t")[1].splitlines()[0],16)
'
printf new-generation > "$CLOUDBENCH_DATA_DIR/NEW-ONLY"
while [ ! -e "$CLOUDBENCH_DATA_DIR/STOP" ]; do sleep .05; done
""")
            boot.chmod(0o700)
            value, env = envelope()
            value["successor"]["task_ref"] = task_ref
            raw = json.dumps(value).encode()
            env.update(
                CLOUDBENCH_ARCHIVED_REUSE_PROOF_B64=base64.b64encode(raw).decode(),
                CLOUDBENCH_ARCHIVED_REUSE_PROOF_SHA256=hashlib.sha256(raw).hexdigest(),
                REF=task_ref,
                PATH=str(bin_dir) + ":" + os.environ["PATH"],
                OUTER_PID=str(os.getpid()),
                LOCAL_ORIGIN=str(origin),
                FETCH_HELPER=str(fetch),
                DRIVER_ADMISSION=str(driver),
            )
            fd = os.open(sentinel, os.O_RDONLY)
            os.dup2(fd, 9)
            os.close(fd)
            generation = data / ".cloudbench-generations" / ("a" * 32)
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(helper),
                    "--data-root",
                    str(data),
                    "--boot-script",
                    str(boot),
                ],
                env=env,
                pass_fds=(9,),
            )
            try:
                deadline = time.monotonic() + 10
                while not (generation / "NEW-ONLY").exists():
                    if process.poll() is not None:
                        raise AssertionError("boot failed before external entry")
                    assert time.monotonic() < deadline, "boot readiness timed out"
                    time.sleep(0.02)
                command = [
                    sys.executable,
                    str(helper),
                    "--data-root",
                    str(data),
                    "--external-exec",
                    "/bin/bash",
                    "-c",
                    'test ! -e "$CLOUDBENCH_DATA_DIR/OLD-ARCHIVE" && cat "$CLOUDBENCH_DATA_DIR/NEW-ONLY"',
                ]
                entered = subprocess.run(command, env=env, capture_output=True)
                assert entered.returncode == 0 and entered.stdout == b"new-generation", entered.stderr
                certificate_path = generation / ".cloudbench-generation.json"
                original_certificate = certificate_path.read_bytes()
                for key, invalid in [
                    ("birth", "0"),
                    ("claim_id", "b" * 32),
                    ("mount_namespace", "mnt:[0]"),
                ]:
                    stale = json.loads(original_certificate)
                    stale[key] = invalid
                    certificate_path.write_text(json.dumps(stale))
                    denied = subprocess.run(command, env=env, capture_output=True)
                    assert denied.returncode != 0, "stale certificate admitted"
                certificate_path.write_bytes(original_certificate)
            finally:
                os.close(9)
                (generation / "STOP").touch()
                assert process.wait(timeout=5) == 0
            dead = subprocess.run(command, env=env, capture_output=True)
            assert dead.returncode != 0, "dead namespace owner admitted"
            assert hashlib.sha256(sentinel.read_bytes()).hexdigest() == before
            assert not (data / "NEW-ONLY").exists(), "bind propagated into parent namespace"
            generation = data / ".cloudbench-generations" / ("a" * 32)
            assert (generation / "NEW-ONLY").read_text() == "new-generation"
            certificate = json.loads((generation / ".cloudbench-generation.json").read_text())
            assert certificate["root_inode"] == generation.stat().st_ino
            assert certificate["storage_mode"] == module.MODE
            outside_env = {
                **env,
                "CLOUDBENCH_DATA_DIR": str(generation),
                "CLOUDBENCH_REPO_DIR": str(generation / "repo"),
            }
            outside = subprocess.run(
                [
                    sys.executable,
                    str(helper),
                    "--data-root",
                    str(generation),
                    "--verify-checkout",
                    str(generation / "repo"),
                    task_ref,
                ],
                env=outside_env,
                capture_output=True,
            )
            assert outside.returncode != 0 and b"generation certificate mismatch" in outside.stderr
            again = subprocess.run(
                [
                    sys.executable,
                    str(helper),
                    "--data-root",
                    str(data),
                    "--boot-script",
                    str(boot),
                ],
                env=env,
                capture_output=True,
            )
            assert again.returncode != 0 and b"FileExistsError" in again.stderr
            assert hashlib.sha256(sentinel.read_bytes()).hexdigest() == before
            # A linked generation parent cannot redirect new writes into old data.
            other = root / "linked"
            other.mkdir(mode=0o755)
            (other / ".cloudbench-generations").symlink_to(data)
            subprocess.run(["mount", "--bind", str(other), str(other)], check=True)
            try:
                denied = subprocess.run(
                    [
                        sys.executable,
                        str(helper),
                        "--data-root",
                        str(other),
                        "--boot-script",
                        str(boot),
                    ],
                    env=env,
                    capture_output=True,
                )
                assert denied.returncode != 0
            finally:
                subprocess.run(["umount", str(other)], check=True)
        finally:
            subprocess.run(["umount", str(data)], check=True)


class Tests(unittest.TestCase):
    def test_exact_proof_and_foreign_bindings(self):
        value, env = envelope()
        self.assertEqual(module.proof(env), value)
        for key, invalid in [
            ("FLY_MACHINE_ID", "b" * 14),
            ("REF", "f" * 40),
            ("CLOUDBENCH_RUN_TOKEN", "old-owner-0"),
            ("CLOUDBENCH_ARCHIVED_REUSE_PROOF_SHA256", "0" * 64),
        ]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                module.proof({**env, key: invalid})

    def test_real_private_bind_and_unprivileged_old_data_exclusion(self):
        if sys.platform != "linux" or not shutil.which("sudo"):
            self.skipTest("Linux sudo mount capability required; no isolation qualification here")
        capability = subprocess.run(
            ["sudo", "-n", "unshare", "--mount", "--propagation", "private", "true"],
            capture_output=True,
        )
        if capability.returncode:
            self.skipTest("sudo private mount namespace unavailable; no isolation qualification here")
        subprocess.run(
            [
                "sudo",
                "-n",
                "unshare",
                "--mount",
                "--propagation",
                "private",
                sys.executable,
                str(Path(__file__).resolve()),
                "--namespace-case",
            ],
            check=True,
        )


if __name__ == "__main__":
    if "--namespace-case" in sys.argv:
        namespace_case()
    else:
        unittest.main()
