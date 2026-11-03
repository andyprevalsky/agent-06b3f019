#!/usr/bin/env python3
"""Offline owning boundaries for archived-generation run-bench-cloud transport."""

import base64
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
SOURCE = (SCRIPTS / "run-bench-cloud").read_text()
spec = importlib.util.spec_from_file_location(
    "guest_fixture", Path(__file__).with_name("cloudbench-isolated-generation.test.py")
)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
BLOCK = (
    SOURCE.split("# BEGIN archived-generation transport", 1)[1]
    .split("# END archived-generation transport.", 1)[0]
    .split("\n", 1)[1]
)
SSH = "ssh_exec() {" + SOURCE.split("ssh_exec() {", 1)[1].split("# Retry-wrapped, QUIET", 1)[0]
FLY = "FLY() {" + SOURCE.split("FLY() {", 1)[1].split("request_machine_start()", 1)[0]


class Tests(unittest.TestCase):
    def shell(self, body, *, change=None, proof_kind=None):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            binary = root / "bin"
            binary.mkdir()
            stub = binary / "python3"
            stub.write_text(
                '#!/usr/bin/python3\nimport os,json,sys\nopen(os.environ["CAPTURE"],"w").write(json.dumps(sys.argv[1:]))\n'
            )
            stub.chmod(0o755)
            value, env = fixture.envelope()
            if change:
                change(value)
            path = root / "proof.json"
            path.write_text(json.dumps(value))
            path.chmod(0o600)
            if proof_kind == "symlink":
                linked = root / "linked-proof.json"
                linked.symlink_to(path)
                path = linked
            elif proof_kind == "public":
                path.chmod(0o644)
            elif proof_kind == "oversized":
                path.write_bytes(b"x" * 65537)
            env.update(os.environ)
            env.update(
                CLOUDBENCH_ARCHIVED_REUSE_PROOF_FILE=str(path),
                CLOUDBENCH_STORAGE_MODE=fixture.module.MODE,
                CLOUDBENCH_COLD_PRIMARY_BOOTSTRAP="1",
                CLOUDBENCH_FRESH_VOLUME="0",
                CLOUDBENCH_BOOT_LAUNCH="1",
                CLOUDBENCH_FLEET_RUN_TOKEN="new-owner-0",
                CAPTURE=str(root / "capture"),
            )
            prefix = f"""set -eu
MODE=run; BENCH_SIMULATE=0; BENCH_REF={"e" * 40}; FLEET_MACHINE_ID={"a" * 14}
BENCH_TASKS=(same-task); APP=fixture; ROOT_DIR={str(root)!r}
CLOUDBENCH_GUEST_GENERATION_SCRIPT={str(SCRIPTS / "cloudbench-isolated-generation.py")!r}
_with_timeout() {{ shift; "$@"; }}
flyctl() {{ printf '%s\\n' "$@" >> "$CAPTURE"; }}
"""
            result = subprocess.run(
                ["bash", "-c", prefix + BLOCK + SSH + FLY + body],
                env=env,
                capture_output=True,
                text=True,
            )
            capture = (root / "capture").read_text() if (root / "capture").exists() else ""
            return result, capture

    def test_exact_proof_namespace_and_sftp_paths(self):
        result, capture = self.shell("""
cloudbench_load_archived_proof
ssh_exec "$FLEET_MACHINE_ID" 'cat /data/repo/.context/services.json'
FLY ssh sftp put -a fixture --machine "$FLEET_MACHINE_ID" local /tmp/auth.pending
cloudbench_generation_sftp_path "$FLEET_MACHINE_ID" /data/repo/artifact.json
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            "/data/.cloudbench-generations/" + "a" * 32 + "/repo/artifact.json",
            result.stdout,
        )
        self.assertIn("/tmp/auth.pending", capture)
        # SSH commands are encoded exactly once by the existing transport.
        commands = [line for line in capture.splitlines() if line.startswith('bash -lc "printf %s ')]
        self.assertTrue(commands)
        for line in commands:
            encoded = line.split("printf %s ", 1)[1].split(" |", 1)[0]
            decoded = base64.b64decode(encoded).decode()
            self.assertIn("--external-exec /bin/bash -c", decoded)
            self.assertIn("CLOUDBENCH_ARCHIVED_REUSE_PROOF_SHA256=", decoded)
        self.assertIn(
            "/data/repo/.context/services.json",
            base64.b64decode(
                base64.b64decode(commands[0].split("printf %s ", 1)[1].split(" |", 1)[0])
                .decode()
                .split("printf %s ", 1)[1]
                .split(" |", 1)[0]
            ).decode(),
        )

    def test_boot_and_fleet_share_canonical_proof_bytes(self):
        import hashlib
        import runpy
        import shlex

        value, _ = fixture.envelope()
        canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        expected = hashlib.sha256(canonical).hexdigest()
        result, _ = self.shell('cloudbench_load_archived_proof\nprintf "%s\\n" "$CLOUDBENCH_ARCHIVED_PROOF_SHA"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), expected)
        transport = runpy.run_path(str(SCRIPTS / "cloudbench-archived-reuse-transport.py"))
        command = transport["external_command"](value, "true", canonical)
        self.assertIn("CLOUDBENCH_ARCHIVED_REUSE_PROOF_SHA256=" + expected, shlex.split(command))

    def test_foreign_and_unsafe_inputs_fail_before_transport(self):
        for mutation in [
            lambda x: x.update(machine_id="b" * 14),
            lambda x: x["successor"].update(task="different-task"),
            lambda x: x["successor"].update(task_ref="f" * 40),
        ]:
            with self.subTest(mutation=mutation):
                result, capture = self.shell(
                    'cloudbench_load_archived_proof\nssh_exec "$FLEET_MACHINE_ID" true',
                    change=mutation,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(capture, "")
        for command in [
            "cloudbench_namespace_command bbbbbbbbbbbbbb true",
            'FLY ssh sftp put -a fixture --machine "$FLEET_MACHINE_ID" local /data/repo/possible-link',
            'FLY ssh sftp get -a fixture --machine "$FLEET_MACHINE_ID" /data/repo/possible-link local',
            'cloudbench_generation_sftp_path "$FLEET_MACHINE_ID" /data/../OLD',
            "MODE=destroy; cloudbench_load_archived_proof",
            "CLOUDBENCH_BOOT_TRANSPORT=staged; cloudbench_load_archived_proof",
        ]:
            result, capture = self.shell("cloudbench_load_archived_proof\n" + command)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(capture, "")

    def test_external_command_quotes_survive_without_execution_on_host(self):
        command = "printf '%s\n' \"literal $HOME ; $(false)\"\ncat /data/repo/.context/services.json"
        result, capture = self.shell(
            "cloudbench_load_archived_proof\n"
            + 'wrapped="$(cloudbench_namespace_command "$FLEET_MACHINE_ID" '
            + __import__("shlex").quote(command)
            + ')"\n'
            + 'PATH="$ROOT_DIR/bin:$PATH" bash -c "$wrapped"'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(capture)
        self.assertEqual(
            args[:5],
            [
                "-S",
                "/cloudbench-isolated-generation.py",
                "--external-exec",
                "/bin/bash",
                "-c",
            ],
        )
        self.assertEqual(args[5], command)

    def test_private_regular_bounded_proof_required(self):
        for kind in ("symlink", "public", "oversized"):
            result, capture = self.shell(
                'cloudbench_load_archived_proof\nssh_exec "$FLEET_MACHINE_ID" true',
                proof_kind=kind,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(capture, "")

    def test_actual_entrypoint_and_payload_partition(self):
        setup = SOURCE.split('    _boot_command="bash /cloudbench-boot.sh"', 1)[1].split("    _pool_shape_args=()", 1)[
            0
        ]
        partition = (
            "    _boot_payload_args=()"
            + SOURCE.split("    _boot_payload_args=()", 1)[1].split("    _boot_payload_file=", 1)[0]
        )
        result, _ = self.shell(
            'cloudbench_load_archived_proof\nmid="$FLEET_MACHINE_ID"; _envargs=()\n_boot_command="bash /cloudbench-boot.sh"\n'
            + setup
            + '\n[ "$_boot_command" = "python3 -S /cloudbench-isolated-generation.py" ]\n'
            + "_boot_file_args=(--file-local /cloudbench-isolated-generation.py=immutable-helper --file-local /cloudbench-fetch-ref.sh=immutable-fetch)\n"
            + partition
            + '\nprintf "%s\\n" "${_boot_entrypoint_args[@]}" "${_boot_payload_args[@]}"\n'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.splitlines(),
            [
                "--file-local",
                "/cloudbench-isolated-generation.py=immutable-helper",
                "--file-local",
                "/cloudbench-fetch-ref.sh=immutable-fetch",
            ],
        )

    def test_ordinary_transport_unchanged(self):
        result, capture = self.shell("""
unset CLOUDBENCH_ARCHIVED_REUSE_PROOF_FILE CLOUDBENCH_STORAGE_MODE
cloudbench_load_archived_proof
ssh_exec "$FLEET_MACHINE_ID" 'echo ordinary'
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        command = next(line for line in capture.splitlines() if line.startswith('bash -lc "printf %s '))
        self.assertEqual(
            base64.b64decode(command.split("printf %s ", 1)[1].split(" |", 1)[0]),
            b"echo ordinary",
        )

    def test_injected_entrypoint_precedes_boot_and_payload(self):
        self.assertIn(
            '--file-local "/cloudbench-isolated-generation.py=$CLOUDBENCH_GUEST_GENERATION_SCRIPT"',
            SOURCE,
        )
        self.assertIn(
            "/cloudbench-boot.sh|/cloudbench-status-server.py|/cloudbench-isolated-generation.py)",
            SOURCE,
        )
        self.assertIn('_boot_command="python3 -S /cloudbench-isolated-generation.py"', SOURCE)
        self.assertIn('--command "$_boot_command" --skip-health-checks --skip-start', SOURCE)
        self.assertIn(
            '--file-local "/cloudbench-fetch-ref.sh=$CLOUDBENCH_GUEST_FETCH_REF_SCRIPT"',
            SOURCE,
        )


if __name__ == "__main__":
    unittest.main()
