#!/usr/bin/env python3
"""Compact exact-container ownership controls for the native fixture dispatcher."""

import importlib.util
import contextlib
import io
import os
import json
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tarfile
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
        foreign_registry_mount=False,
        writable_registry_mount=False,
        extra_mount=False,
        cid=True,
        export_failure=False,
        export_exception=False,
        invalid_archive=False,
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
                    (
                        "agents/providers/rose/pools.py",
                        "/repo/agents/providers/rose/pools.py",
                        False,
                    ),
                ]
            ]
            if foreign_mount:
                mounts[0]["Source"] = str(root / "foreign-source")
            if writable_mount:
                mounts[0]["RW"] = True
            if foreign_registry_mount:
                mounts[2]["Source"] = str(root / "foreign-registry.py")
            if writable_registry_mount:
                mounts[2]["RW"] = True
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
                        if args[-1] == "-":
                            if invalid_archive:
                                _kwargs["stdout"].write(b"incomplete tar stream")
                                return subprocess.CompletedProcess(args, 0, None, "")
                            with tarfile.open(
                                fileobj=_kwargs["stdout"], mode="w|"
                            ) as archive:
                                directory = tarfile.TarInfo("restrictive")
                                directory.type = tarfile.DIRTYPE
                                directory.mode = 0o500
                                archive.addfile(directory)
                                member = tarfile.TarInfo("restrictive/retained.log")
                                member.size = len(b"private")
                                member.mode = 0o400
                                archive.addfile(member, io.BytesIO(b"private"))
                                link = tarfile.TarInfo("external-link")
                                link.type = tarfile.SYMTYPE
                                link.linkname = "/etc/passwd"
                                archive.addfile(link)
                        else:
                            (root / "fixture-tmp" / "retained.log").write_text(
                                "private"
                            )
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
                self.assertEqual(root.stat().st_mode & 0o777, 0o700)
                self.assertEqual(
                    (root / "fixture-tmp.tar").stat().st_mode & 0o777,
                    0o600,
                )
                inventory = json.loads(
                    (root / "fixture-tmp.inventory.json").read_text()
                )
                self.assertEqual(
                    inventory["regular_files"],
                    [
                        {
                            "name": "restrictive/retained.log",
                            "size": 7,
                            "sha256": hashlib.sha256(b"private").hexdigest(),
                        }
                    ],
                )
                self.assertEqual(
                    inventory["archive_sha256"],
                    hashlib.sha256((root / "fixture-tmp.tar").read_bytes()).hexdigest(),
                )
                self.assertFalse((root / "restrictive").exists())
                self.assertFalse((root / "external-link").exists())
                self.assertEqual(
                    (root / "cleanup-commands.jsonl").stat().st_mode & 0o777, 0o600
                )
                self.assertEqual(
                    (root / "fixture-tmp.inventory.json").stat().st_mode & 0o777, 0o600
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
        self.assertEqual(calls[2][-1], "-")
        self.assertEqual(calls[3], ["docker", "rm", identity])

    def test_foreign_identity_or_nonsealed_mounts_are_never_mutated(self):
        for settings in (
            {"label": "foreign-label"},
            {"foreign_mount": True},
            {"foreign_image": True},
            {"writable_mount": True},
            {"foreign_registry_mount": True},
            {"writable_registry_mount": True},
            {"extra_mount": True},
        ):
            with self.subTest(settings=settings):
                result, calls, _ = self.check_retirement(**settings)
                self.assertFalse(result)
                self.assertFalse(any(call[1] in ("stop", "cp", "rm") for call in calls))

    def test_export_failure_still_removes_exact_owner_and_fails_evidence(self):
        for settings in (
            {"export_failure": True},
            {"export_exception": True},
            {"invalid_archive": True},
        ):
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

    @unittest.skipUnless(
        sys.platform == "darwin"
        or os.environ.get("CLOUDBENCH_TEST_LINUX_EXPORT_REAL") == "1",
        "Mac exporter boundary; explicit flag enables the bounded Docker proof elsewhere",
    )
    def test_real_restrictive_linux_export_keeps_complete_bytes_and_retires_owner(self):
        repo = Path(__file__).resolve().parents[2]
        recipe_sha = hashlib.sha256(
            (repo / "scripts/tests/cloudbench-controller-linux.Dockerfile").read_bytes()
        ).hexdigest()
        image = "rose-cloudbench-controller-tests:" + recipe_sha[:16]
        image_id = subprocess.check_output(
            ["docker", "image", "inspect", image, "--format", "{{.Id}}"], text=True
        ).strip()
        label = subprocess.check_output(
            [
                "docker",
                "image",
                "inspect",
                image_id,
                "--format",
                '{{index .Config.Labels "org.rose.controller-recipe-sha256"}}',
            ],
            text=True,
        ).strip()
        self.assertEqual(label, recipe_sha)
        parent = repo / ".context/cloudbench-controller-tests"
        parent.mkdir(parents=True, exist_ok=True)
        snapshot = Path(tempfile.mkdtemp(prefix="export-proof-", dir=parent))
        owner = snapshot.name.replace("-", "")
        name = "rose-controller-export-proof-" + owner
        command = [
            "docker",
            "run",
            "--detach",
            "--network",
            "none",
            "--name",
            name,
            "--label",
            "org.rose.controller-test-owner=" + owner,
            "--cidfile",
            str(snapshot / "container.cid"),
        ]
        for relative, destination in (
            ("scripts", "/repo/scripts"),
            ("agents/benchmarks", "/repo/agents/benchmarks"),
            ("agents/providers/rose/pools.py", "/repo/agents/providers/rose/pools.py"),
        ):
            target = snapshot / relative
            if target.suffix == ".py":
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(repo / relative, target)
            else:
                target.mkdir(parents=True, exist_ok=True)
            command.extend(["-v", str(target) + ":" + destination + ":ro"])
        command.extend(
            [
                "--entrypoint",
                "/bin/bash",
                image_id,
                "-lc",
                "mkdir -p /tmp/restrictive/nested; printf '%s' preserved > /tmp/restrictive/nested/result; chmod 0500 /tmp/restrictive; chmod 0400 /tmp/restrictive/nested/result; ln -s /etc/passwd /tmp/external-link; touch /tmp/export-ready; exec sleep infinity",
            ]
        )
        native_run = subprocess.run
        try:
            identity = subprocess.check_output(command, text=True).strip()
            subprocess.run(
                [
                    "docker",
                    "exec",
                    identity,
                    "bash",
                    "-lc",
                    "for i in {1..100}; do test -f /tmp/export-ready && exit 0; sleep .05; done; exit 1",
                ],
                check=True,
                timeout=10,
            )
            calls = []
            native_run = subprocess.run

            def capture(args, **kwargs):
                result = native_run(args, **kwargs)
                if args[0] == "docker":
                    calls.append(
                        {
                            "args": args,
                            "returncode": result.returncode,
                            "stdout": result.stdout,
                            "stderr": result.stderr,
                        }
                    )
                    (snapshot / "actual-cleanup-calls.json").write_text(
                        json.dumps(calls, indent=2) + "\n"
                    )
                return result

            with patch.object(runner.subprocess, "run", side_effect=capture):
                retired = runner.retire_owned_container(snapshot, name, owner, image_id)
            print("Actual restrictive export proof: " + str(snapshot), flush=True)
            self.assertTrue(retired, json.dumps(calls))
            self.assertEqual(
                (snapshot / "fixture-tmp.tar").stat().st_mode & 0o777, 0o600
            )
            inventory = json.loads(
                (snapshot / "fixture-tmp.inventory.json").read_text()
            )
            member = next(
                row
                for row in inventory["regular_files"]
                if row["name"].endswith("restrictive/nested/result")
            )
            self.assertEqual(member["sha256"], hashlib.sha256(b"preserved").hexdigest())
            self.assertFalse(
                any(
                    row["name"].endswith("external-link")
                    for row in inventory["regular_files"]
                )
            )
            self.assertFalse((snapshot / "restrictive").exists())
            gone = native_run(
                ["docker", "inspect", identity], capture_output=True, text=True
            )
            self.assertEqual(gone.returncode, 1)
            self.assertIn("no such", gone.stderr.lower())
        finally:
            cidfile = snapshot / "container.cid"
            if cidfile.is_file():
                exact = cidfile.read_text().strip()
                exists = native_run(
                    ["docker", "inspect", exact], capture_output=True, text=True
                )
                if exists.returncode == 0:
                    self.assertTrue(
                        runner.retire_owned_container(snapshot, name, owner, image_id),
                        "exact test owner cleanup failed",
                    )

    def check_dispatch(self, *, cancelled=False, fixture=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tests = root / "scripts/tests"
            tests.mkdir(parents=True)
            (tests / "cloudbench-controller-linux.Dockerfile").write_text(
                "FROM fixture\n"
            )
            selected = fixture or "scripts/tests/cloudbench-multi-workstream.test.sh"
            shutil.copy2(
                Path(__file__).resolve().parents[2] / selected, root / selected
            )
            actual_registry = (
                Path(__file__).resolve().parents[2] / "agents/providers/rose/pools.py"
            )
            registry = root / "agents/providers/rose/pools.py"
            registry.parent.mkdir(parents=True)
            shutil.copy2(actual_registry, registry)
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
                    ["runner", *(["--fixture", fixture] if fixture else [])],
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
                patch.object(
                    runner.subprocess, "check_output", return_value=selected + "\n"
                ),
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
            self.assertEqual(command[-1], "bash /repo/" + selected)
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
            self.assertIn("--init", command)
            self.assertIn("TMPDIR=/tmp", command)
            mounts = [
                command[index + 1]
                for index, value in enumerate(command)
                if value == "-v"
            ]
            self.assertEqual(len(mounts), 3)
            self.assertTrue(all(value.endswith(":ro") for value in mounts))
            registry_mount = next(
                value
                for value in mounts
                if value.endswith(":/repo/agents/providers/rose/pools.py:ro")
            )
            staged_registry = Path(registry_mount.split(":", 1)[0])
            self.assertEqual(staged_registry.read_bytes(), actual_registry.read_bytes())
            snapshot = staged_registry.parents[3]
            source_receipt = json.loads((snapshot / "source.json").read_text())
            self.assertEqual(source_receipt["fixture"], selected)
            self.assertEqual(
                source_receipt["source_file_sha256"][selected],
                hashlib.sha256((root / selected).read_bytes()).hexdigest(),
            )
            self.assertEqual(
                source_receipt["source_file_sha256"]["agents/providers/rose/pools.py"],
                hashlib.sha256(actual_registry.read_bytes()).hexdigest(),
            )
            self.assertTrue(
                any(args[1] == "run" and "--rm" in args for args in tool_commands)
            )
            return lifecycle

    def test_dispatch_uses_native_storage_and_keeps_inherited_proxies(self):
        self.assertEqual(self.check_dispatch(), ["join", "retire"])

    def test_selected_status_fixture_uses_exact_verified_snapshot_and_retirement(self):
        self.assertEqual(
            self.check_dispatch(
                fixture="scripts/tests/cloudbench-status-service-shutdown.test.sh"
            ),
            ["join", "retire"],
        )

    def test_linux_dispatch_executes_only_the_selected_registered_fixture(self):
        for fixture in (
            "scripts/tests/cloudbench-multi-workstream.test.sh",
            "scripts/tests/cloudbench-status-service-shutdown.test.sh",
        ):
            with (
                self.subTest(fixture=fixture),
                patch.object(runner.sys, "platform", "linux"),
                patch.object(runner.sys, "argv", ["runner", "--fixture", fixture]),
                patch.object(runner.subprocess, "run") as tool_check,
                patch.object(
                    runner.os, "execvp", side_effect=SystemExit(0)
                ) as execution,
            ):
                with self.assertRaises(SystemExit) as exited:
                    runner.main()
                self.assertEqual(exited.exception.code, 0)
                self.assertEqual(
                    tool_check.call_args.args[0],
                    [sys.executable, "-c", runner.TOOL_CHECK],
                )
                execution.assert_called_once_with(
                    "bash", ["bash", str(Path(__file__).resolve().parents[2] / fixture)]
                )

    def test_unregistered_fixture_is_rejected_before_native_or_container_launch(self):
        with (
            patch.object(
                runner.sys, "argv", ["runner", "--fixture", "scripts/foreign.sh"]
            ),
            patch.object(runner.subprocess, "run") as native,
            patch.object(runner.subprocess, "Popen") as container,
            patch.object(runner.os, "execvp") as execution,
            contextlib.redirect_stderr(io.StringIO()),
        ):
            with self.assertRaises(SystemExit) as exited:
                runner.main()
            self.assertEqual(exited.exception.code, 2)
            native.assert_not_called()
            container.assert_not_called()
            execution.assert_not_called()

    def check_status_fixture_dispatch(self, *argv):
        root = Path(__file__).resolve().parents[2]
        source = (
            root / "scripts/tests/cloudbench-status-service-shutdown.test.sh"
        ).read_text()
        prefix = source.split("\nfail() {", 1)[0]
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary)
            (binary / "uname").write_text("#!/bin/sh\nprintf 'Darwin\\n'\n")
            arguments = binary / "arguments"
            (binary / "python3").write_text(
                '#!/bin/sh\nprintf "%s\\n" "$@" > "$DISPATCH_ARGUMENTS"\n'
            )
            for name in ("uname", "python3"):
                (binary / name).chmod(0o700)
            result = subprocess.run(
                ["bash", "-c", prefix, "status-fixture", *argv],
                env={
                    **os.environ,
                    "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                    "CLOUDBENCH_ROOT_UNDER_TEST": str(root),
                    "DISPATCH_ARGUMENTS": str(arguments),
                },
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(arguments.is_file(), "non-Linux fixture did not dispatch")
            self.assertEqual(
                arguments.read_text().splitlines(),
                [
                    str(root / "scripts/tests/run-cloudbench-controller-linux.py"),
                    "--fixture",
                    "scripts/tests/cloudbench-status-service-shutdown.test.sh",
                ],
            )

    def test_status_fixture_dispatches_to_the_closed_linux_selector(self):
        self.check_status_fixture_dispatch()

    def test_status_fixture_arguments_cannot_replace_its_exact_owning_suite(self):
        self.check_status_fixture_dispatch(
            "--fixture",
            "scripts/tests/cloudbench-multi-workstream.test.sh",
            "--check-only",
        )

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
