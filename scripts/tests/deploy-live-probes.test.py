#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "run_deploy_live_probes.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("run_deploy_live_probes", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load live-probe runner")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class DeployLiveProbeTests(unittest.TestCase):
    def test_independent_probes_run_concurrently(self) -> None:
        module = _load_module()
        commands = (
            module.Command("first", (sys.executable, "-c", "first"), ROOT),
            module.Command("second", (sys.executable, "-c", "second"), ROOT),
        )
        events: list[tuple[str, str]] = []

        class FinishedProcess:
            def __init__(self, name: str) -> None:
                self.name = name
                self.pid = 1

            def poll(self) -> int:
                events.append(("poll", self.name))
                return 0

            def wait(self) -> int:
                events.append(("wait", self.name))
                return 0

        def launch(argv, *, cwd, start_new_session):
            self.assertEqual(cwd, ROOT)
            self.assertTrue(start_new_session)
            name = argv[-1]
            events.append(("launch", name))
            return FinishedProcess(name)

        with patch.object(module.subprocess, "Popen", side_effect=launch):
            results = module.run_commands(commands)

        self.assertEqual(events[:2], [("launch", "first"), ("launch", "second")])
        self.assertEqual(results, {"first": 0, "second": 0})

    def test_failure_does_not_interrupt_sibling_evidence(self) -> None:
        module = _load_module()
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / "completed"
            commands = (
                module.Command("failed", (sys.executable, "-c", "raise SystemExit(7)"), ROOT),
                module.Command(
                    "slow",
                    (sys.executable, "-c", f"import time; time.sleep(.15); open({str(marker)!r}, 'w').write('done')"),
                    ROOT,
                ),
            )
            results = module.run_commands(commands)

            self.assertEqual(results, {"failed": 7, "slow": 0})
            self.assertEqual(marker.read_text(), "done")


if __name__ == "__main__":
    unittest.main()
