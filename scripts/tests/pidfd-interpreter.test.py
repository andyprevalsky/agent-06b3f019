#!/usr/bin/env python3
"""Guest-payload tests run under a pidfd-capable python3 even from agents/venv.

T57 (2026-10-22): with agents/venv first on PATH, `python3` is a uv standalone
CPython 3.11.9 built without os.pidfd_open/signal.pidfd_send_signal, so the
orphan-drain, relay-retire and disposable-Hub suites errored under
scripts/test.sh while passing under /usr/bin/python3.
"""

import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/tests/pidfd_interpreter.py"
VENV_PYTHON = ROOT / "agents/venv/bin/python"
_HELPER = runpy.run_path(str(HELPER))
SYSTEM_PIDFD = sys.platform.startswith("linux") and any(_HELPER["capable"](path) for path in _HELPER["candidates"]())


def lacks_pidfd(python: Path) -> bool:
    probe = "import os,sys;sys.exit(1 if hasattr(os,'pidfd_open') else 0)"
    return python.exists() and subprocess.run([str(python), "-I", "-S", "-c", probe]).returncode == 0


@unittest.skipUnless(sys.platform.startswith("linux"), "pidfd guests are Linux-only")
class PidfdInterpreter(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = {key: value for key, value in os.environ.items()
                    if key not in ("CLOUDBENCH_PIDFD_PYTHON", "CLOUDBENCH_PIDFD_REEXEC")}

    @unittest.skipUnless(SYSTEM_PIDFD, "needs one pidfd-capable python3 to re-execute under")
    def test_missing_pidfd_reexecs_the_script_under_a_capable_python(self):
        script = Path(self.temp.name) / "probe.py"
        script.write_text(
            "import os,runpy,signal,sys\n"
            "if os.environ.get('CLOUDBENCH_PIDFD_REEXEC') != '1' and hasattr(os, 'pidfd_open'):\n"
            "    del os.pidfd_open  # model the uv build's missing API\n"
            f"runpy.run_path({str(HELPER)!r})['require_pidfd_interpreter'](__file__)\n"
            "print('pidfd', hasattr(os, 'pidfd_open'), hasattr(signal, 'pidfd_send_signal'), sys.argv[1:])\n"
        )
        result = subprocess.run([sys.executable, str(script), "alpha", "beta"], env=self.env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("pidfd True True ['alpha', 'beta']", result.stdout)
        self.assertIn("lacks os.pidfd_open; re-running under", result.stderr)

    def test_no_capable_python_fails_loudly_instead_of_skipping(self):
        module = runpy.run_path(str(HELPER))
        with mock.patch.dict(module["require_pidfd_interpreter"].__globals__,
                             has_pidfd=lambda: False, candidates=lambda: ["/nonexistent/python3"]):
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("CLOUDBENCH_PIDFD_REEXEC", None)
                with self.assertRaisesRegex(SystemExit, "no pidfd-capable python3 was found"):
                    module["require_pidfd_interpreter"](__file__)

    def test_reexec_never_loops(self):
        module = runpy.run_path(str(HELPER))
        with mock.patch.dict(module["require_pidfd_interpreter"].__globals__, has_pidfd=lambda: False), \
                mock.patch.dict(os.environ, {"CLOUDBENCH_PIDFD_REEXEC": "1"}):
            with self.assertRaisesRegex(SystemExit, "still lacks os.pidfd_open"):
                module["require_pidfd_interpreter"](__file__)

    @unittest.skipUnless(lacks_pidfd(VENV_PYTHON) and SYSTEM_PIDFD,
                         "agents/venv is absent or already has pidfd")
    def test_orphan_drain_suite_passes_under_the_venv_interpreter(self):
        # The exact T57 failure: scripts/test.sh with agents/venv first on PATH.
        env = dict(self.env, PATH=f"{VENV_PYTHON.parent}{os.pathsep}{self.env.get('PATH', '')}")
        result = subprocess.run([str(VENV_PYTHON), str(ROOT / "scripts/tests/cloudbench-controller-orphan-drain.test.py")],
                                cwd=ROOT, env=env, capture_output=True, text=True, timeout=240)
        self.assertEqual(result.returncode, 0, result.stdout[-2000:] + result.stderr[-4000:])
        self.assertIn("re-running under", result.stderr)


if __name__ == "__main__":
    unittest.main()
