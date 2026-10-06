#!/usr/bin/env python3
"""Compact exact-container ownership controls for the native fixture dispatcher."""

import importlib.util
import contextlib
import io
import os
import json
from pathlib import Path
import subprocess
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
    def check_retirement(self, *, label="owned-label", foreign_mount=False, cid=True):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            identity = "a" * 64
            if cid:
                (root / "container.cid").write_text(identity)
            mounts = [
                {
                    "Source": str(root / relative),
                    "Destination": destination,
                    "RW": writable,
                }
                for relative, destination, writable in [
                    ("scripts", "/repo/scripts", False),
                    ("agents/benchmarks", "/repo/agents/benchmarks", False),
                    ("fixture-tmp", "/fixture-tmp", True),
                ]
            ]
            if foreign_mount:
                mounts[0]["Source"] = str(root / "foreign-source")
            calls = []

            def docker(args, **_kwargs):
                calls.append(args)
                if args[1] == "stop":
                    return subprocess.CompletedProcess(args, 0, "", "")
                if len(calls) > 1:
                    return subprocess.CompletedProcess(
                        args, 1, "", "Error: No such object"
                    )
                return subprocess.CompletedProcess(
                    args,
                    0,
                    "\n".join([identity, "/owned-name", label, json.dumps(mounts)])
                    + "\n",
                    "",
                )

            with patch.object(runner.subprocess, "run", side_effect=docker):
                result = runner.retire_owned_container(
                    root, "owned-name", "owned-label"
                )
            return result, calls, identity

    def test_owned_container_is_stopped_and_removed(self):
        result, calls, identity = self.check_retirement()
        self.assertTrue(result)
        self.assertIn(["docker", "stop", "--time", "30", identity], calls)

    def test_foreign_label_or_source_mount_is_never_stopped(self):
        for settings in ({"label": "foreign-label"}, {"foreign_mount": True}):
            with self.subTest(settings=settings):
                result, calls, _ = self.check_retirement(**settings)
                self.assertFalse(result)
                self.assertFalse(any(call[1] == "stop" for call in calls))

    def test_missing_cid_resolves_only_exact_named_owner(self):
        result, calls, _ = self.check_retirement(cid=False)
        self.assertTrue(result)
        self.assertEqual(calls[0][2], "owned-name")

    def test_dispatch_keeps_exact_owner_with_inherited_proxies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tests = root / "scripts/tests"
            tests.mkdir(parents=True)
            (tests / "cloudbench-controller-linux.Dockerfile").write_text(
                "FROM fixture\n"
            )
            calls = []
            image = "sha256:" + "a" * 64

            def docker(args, **_kwargs):
                return subprocess.CompletedProcess(
                    args,
                    0,
                    image + "\n" if args[1:3] == ["image", "inspect"] else "",
                    "",
                )

            class Process:
                def __init__(self, command):
                    calls.append(command)

                def wait(self):
                    return 0

                def poll(self):
                    return 0

            with (
                patch.object(
                    runner,
                    "__file__",
                    str(tests / "run-cloudbench-controller-linux.py"),
                ),
                patch.object(runner.sys, "platform", "darwin"),
                patch.object(runner.sys, "argv", ["runner"]),
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
                    runner, "retire_owned_container", return_value=True
                ) as retire,
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(runner.main(), 0)
            command = calls[0]
            self.assertEqual(
                retire.call_args.args[1], command[command.index("--name") + 1]
            )
            self.assertEqual(
                retire.call_args.args[2],
                command[command.index("--label") + 1].split("=", 1)[1],
            )
            self.assertIn("HTTPS_PROXY", command)
            self.assertNotIn("http://inherited.invalid", command)

    def test_malformed_cid_does_not_invoke_docker(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "container.cid").write_text("foreign-invalid-identity")
            with patch.object(runner.subprocess, "run") as docker:
                self.assertFalse(
                    runner.retire_owned_container(root, "owned-name", "owned-label")
                )
                docker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
