#!/usr/bin/env python3
"""Compact exact-container ownership controls for the native fixture dispatcher."""

import importlib.util
import contextlib
import io
import os
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "controller_linux_runner",
    Path(__file__).with_name("run-cloudbench-controller-linux.py"),
)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class ContainerOwnership(unittest.TestCase):
    def test_tool_preflight_rejects_missing_or_broken_package_runners(self):
        # Execute the actual preflight with isolated executable tools. No host
        # npm or network can rescue an absent or nonfunctional package runner.
        for failure in (
            None,
            "missing-npm",
            "missing-npx",
            "broken-npm",
            "broken-npx",
            "invalid-npm",
            "mismatch-npx",
        ):
            with (
                self.subTest(failure=failure),
                tempfile.TemporaryDirectory() as temporary,
            ):
                binary = Path(temporary)
                versions = {
                    "node": "v22.13.0",
                    "bash": "GNU bash, version 5.2.0",
                    "npm": "10.9.2",
                    "npx": "10.9.2",
                }
                for name in ("node", "bash", "git", "curl", "ps", "rg", "npm", "npx"):
                    if failure == "missing-" + name:
                        continue
                    body = (
                        "exit 7"
                        if failure == "broken-" + name
                        else "printf '%s\\n' '" + versions.get(name, "fixture") + "'"
                    )
                    if failure == "invalid-" + name:
                        body = "printf '%s\\n' 'not-a-version'"
                    elif failure == "mismatch-" + name:
                        body = "printf '%s\\n' '10.9.1'"
                    executable = binary / name
                    executable.write_text("#!/bin/sh\n" + body + "\n")
                    executable.chmod(0o700)
                result = subprocess.run(
                    [
                        sys.executable,
                        "-c",
                        "import sys;sys.platform='linux';sys.version_info=(3,11,9)\n"
                        + runner.TOOL_CHECK,
                    ],
                    env={**os.environ, "PATH": str(binary)},
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if failure is None:
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assertNotEqual(
                        result.returncode, 0, "preflight admitted " + failure
                    )

    def check_retirement(
        self,
        *,
        label="owned-label",
        foreign_mount=False,
        foreign_image=False,
        writable_mount=False,
        extra_mount=False,
        cid=True,
        export_failure=False,
        export_exception=False,
        stop_failure=False,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            identity = "a" * 64
            image = "sha256:" + "b" * 64
            if cid:
                (root / "container.cid").write_text(identity)
            mounts = [
                {
                    "Source": str(root / relative),
                    "Destination": destination,
                    "RW": writable,
                    "Type": "bind",
                }
                for relative, destination, writable in [
                    ("scripts", "/repo/scripts", False),
                    ("agents/benchmarks", "/repo/agents/benchmarks", False),
                ]
            ]
            if foreign_mount:
                mounts[0]["Source"] = str(root / "foreign-source")
            if writable_mount:
                mounts[0]["RW"] = True
            if extra_mount:
                mounts.append(
                    {"Source": str(root / "extra"), "Destination": "/extra", "RW": True}
                )
            calls = []

            def docker(args, **_kwargs):
                calls.append(args)
                if args[1] == "stop" and stop_failure:
                    return subprocess.CompletedProcess(
                        args, 1, "", "controlled stop failure"
                    )
                if args[1] in ("stop", "rm"):
                    return subprocess.CompletedProcess(args, 0, "", "")
                if args[1] == "cp":
                    if export_exception:
                        raise OSError("controlled export exception")
                    if not export_failure:
                        (root / "fixture-tmp" / "retained.log").write_text("private")
                    return subprocess.CompletedProcess(
                        args, int(export_failure), "", "controlled export failure"
                    )
                if len(calls) > 1:
                    return subprocess.CompletedProcess(
                        args, 1, "", "Error: No such object"
                    )
                return subprocess.CompletedProcess(
                    args,
                    0,
                    "\n".join(
                        [
                            identity,
                            "/owned-name",
                            label,
                            "sha256:" + "c" * 64 if foreign_image else image,
                            json.dumps(mounts),
                        ]
                    )
                    + "\n",
                    "",
                )

            with patch.object(runner.subprocess, "run", side_effect=docker):
                result = runner.retire_owned_container(
                    root, "owned-name", "owned-label", image
                )
            if result:
                self.assertEqual((root / "fixture-tmp").stat().st_mode & 0o777, 0o700)
                self.assertEqual(
                    (root / "fixture-tmp" / "retained.log").stat().st_mode & 0o777,
                    0o600,
                )
            return result, calls, identity

    def test_owned_container_is_stopped_exported_privately_and_removed(self):
        result, calls, identity = self.check_retirement()
        self.assertTrue(result)
        self.assertIn(["docker", "stop", "--time", "30", identity], calls)
        self.assertEqual(
            [call[1] for call in calls], ["inspect", "stop", "cp", "rm", "inspect"]
        )
        self.assertEqual(calls[2][2], identity + ":/tmp/.")
        self.assertEqual(calls[3], ["docker", "rm", identity])

    def test_foreign_identity_or_nonsealed_mounts_are_never_mutated(self):
        for settings in (
            {"label": "foreign-label"},
            {"foreign_mount": True},
            {"foreign_image": True},
            {"writable_mount": True},
            {"extra_mount": True},
        ):
            with self.subTest(settings=settings):
                result, calls, _ = self.check_retirement(**settings)
                self.assertFalse(result)
                self.assertFalse(any(call[1] in ("stop", "cp", "rm") for call in calls))

    def test_export_failure_still_removes_exact_owner_and_fails_evidence(self):
        for settings in ({"export_failure": True}, {"export_exception": True}):
            with self.subTest(settings=settings):
                result, calls, identity = self.check_retirement(**settings)
                self.assertFalse(result)
                self.assertIn(["docker", "rm", identity], calls)
                self.assertEqual(calls[-1], ["docker", "inspect", identity])

    def test_stop_failure_never_exports_live_state_and_attempts_exact_removal(self):
        result, calls, identity = self.check_retirement(stop_failure=True)
        self.assertFalse(result)
        self.assertFalse(any(call[1] == "cp" for call in calls))
        self.assertIn(["docker", "rm", identity], calls)
        self.assertEqual(calls[-1], ["docker", "inspect", identity])

    def test_missing_cid_resolves_only_exact_named_owner(self):
        result, calls, _ = self.check_retirement(cid=False)
        self.assertTrue(result)
        self.assertEqual(calls[0][2], "owned-name")

    def check_dispatch(self, *, cancelled=False, fixture=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tests = root / "scripts/tests"
            tests.mkdir(parents=True)
            (tests / "cloudbench-controller-linux.Dockerfile").write_text(
                "FROM fixture\n"
            )
            calls = []
            tool_commands = []
            lifecycle = []
            image = "sha256:" + "a" * 64

            def docker(args, **_kwargs):
                tool_commands.append(args)
                return subprocess.CompletedProcess(
                    args,
                    0,
                    image + "\n" if args[1:3] == ["image", "inspect"] else "",
                    "",
                )

            class Process:
                def __init__(self, command):
                    calls.append(command)
                    self.joined = False

                def wait(self, **_kwargs):
                    if cancelled and not self.joined:
                        self.joined = True
                        raise SystemExit(143)
                    lifecycle.append("join")
                    self.joined = True
                    return 0

                def poll(self):
                    return None if cancelled else 0

                def terminate(self):
                    lifecycle.append("terminate")

            def retire(*_args):
                lifecycle.append("retire")
                return True

            with (
                patch.object(
                    runner,
                    "__file__",
                    str(tests / "run-cloudbench-controller-linux.py"),
                ),
                patch.object(runner.sys, "platform", "darwin"),
                patch.object(
                    runner.sys,
                    "argv",
                    ["runner"] + (["--fixture", fixture] if fixture else []),
                ),
                patch.dict(
                    os.environ,
                    {
                        "CLOUDBENCH_CONTROLLER_TEST_IMAGE": "fixture",
                        "HTTPS_PROXY": "http://inherited.invalid",
                    },
                    clear=True,
                ),
                patch.object(runner.subprocess, "run", side_effect=docker),
                patch.object(runner.subprocess, "check_output", return_value=""),
                patch.object(runner.subprocess, "Popen", side_effect=Process),
                patch.object(
                    runner, "retire_owned_container", side_effect=retire
                ) as retirement,
                contextlib.redirect_stdout(io.StringIO()),
            ):
                if cancelled:
                    with self.assertRaises(SystemExit) as exit_status:
                        runner.main()
                    self.assertEqual(exit_status.exception.code, 143)
                else:
                    self.assertEqual(runner.main(), 0)
            command = calls[0]
            self.assertEqual(
                command[-1],
                f"bash /repo/scripts/tests/cloudbench-{fixture or 'multi-workstream'}.test.sh",
            )
            self.assertEqual(
                retirement.call_args.args[1], command[command.index("--name") + 1]
            )
            self.assertEqual(
                retirement.call_args.args[2],
                command[command.index("--label") + 1].split("=", 1)[1],
            )
            self.assertIn("HTTPS_PROXY", command)
            self.assertNotIn("http://inherited.invalid", command)
            self.assertEqual(retirement.call_args.args[3], image)
            self.assertNotIn("--rm", command)
            self.assertIn("TMPDIR=/tmp", command)
            mounts = [
                command[index + 1]
                for index, value in enumerate(command)
                if value == "-v"
            ]
            self.assertEqual(len(mounts), 2)
            self.assertTrue(all(value.endswith(":ro") for value in mounts))
            self.assertTrue(
                any(args[1] == "run" and "--rm" in args for args in tool_commands)
            )
            return lifecycle

    def test_dispatch_uses_native_storage_and_keeps_inherited_proxies(self):
        self.assertEqual(self.check_dispatch(), ["join", "retire"])

    def test_registered_fixture_selector_preserves_exact_dispatch_owner(self):
        for fixture in ("multi-workstream", "status-service-shutdown"):
            with self.subTest(fixture=fixture):
                self.assertEqual(
                    self.check_dispatch(fixture=fixture), ["join", "retire"]
                )

    def test_invalid_fixture_is_rejected_before_any_docker_operation(self):
        for fixture in ("unknown", "../foreign"):
            with (
                self.subTest(fixture=fixture),
                patch.object(runner.sys, "argv", ["runner", "--fixture", fixture]),
                patch.object(runner.subprocess, "run") as docker,
                patch.object(runner.subprocess, "Popen") as launch,
                patch.object(runner, "retire_owned_container") as retire,
                contextlib.redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit) as exit_status,
            ):
                runner.main()
            self.assertEqual(exit_status.exception.code, 2)
            docker.assert_not_called()
            launch.assert_not_called()
            retire.assert_not_called()

    def test_cancellation_joins_owned_client_before_export_retirement(self):
        self.assertEqual(
            self.check_dispatch(cancelled=True), ["terminate", "join", "retire"]
        )

    def test_actual_fixture_cleanup_retains_only_requested_failure_evidence(self):
        fixture = Path(__file__).with_name("cloudbench-multi-workstream.test.sh")
        source = fixture.read_text()
        cleanup = source.split("\ncleanup() {", 1)[1].split("\ntrap cleanup EXIT", 1)[0]
        cleanup = "cleanup() {" + cleanup
        for status, keep, retained in (
            (143, "1", True),
            (0, "1", False),
            (143, "0", False),
        ):
            with (
                self.subTest(status=status, keep=keep),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary) / "owned-fixture"
                root.mkdir()
                (root / "state.json").write_text("{}\n")
                command = (
                    'TMP_ROOT="$1"; PIDS=(); HUB_PIDS=(); TEST_FAILED=0; '
                    'PORT_CLAIM_DIR=""; CLOUDBENCH_TEST_KEEP_TMP_ON_FAILURE="$2"\n'
                    + cleanup
                    + '\ncleanup "$3"\n'
                )
                result = subprocess.run(
                    [
                        "bash",
                        "-c",
                        command,
                        "cleanup-control",
                        str(root),
                        keep,
                        str(status),
                    ],
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, status)
                self.assertEqual((root / "state.json").is_file(), retained)

    def test_malformed_cid_does_not_invoke_docker(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "container.cid").write_text("foreign-invalid-identity")
            with patch.object(runner.subprocess, "run") as docker:
                self.assertFalse(
                    runner.retire_owned_container(
                        root, "owned-name", "owned-label", "sha256:" + "b" * 64
                    )
                )
                docker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
