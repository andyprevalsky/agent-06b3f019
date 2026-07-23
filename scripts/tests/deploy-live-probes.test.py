#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import tempfile
import time
import unittest
from pathlib import Path


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
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / "marker"
            commands = (
                module.Command(
                    "first",
                    (sys.executable, "-c", f"import time; time.sleep(.3); open({str(marker)!r}, 'a').write('a')"),
                    ROOT,
                ),
                module.Command(
                    "second",
                    (sys.executable, "-c", f"import time; time.sleep(.3); open({str(marker)!r}, 'a').write('b')"),
                    ROOT,
                ),
            )
            started = time.monotonic()
            results = module.run_commands(commands)
            elapsed = time.monotonic() - started

            self.assertLess(elapsed, 0.52, "two 300ms probes ran serially")
            self.assertEqual(results, {"first": 0, "second": 0})
            self.assertCountEqual(marker.read_text(), "ab")

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
