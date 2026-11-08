"""Offline regression: canonical condition wait + the test-sleep ratchet.

Covers scripts/lib/condition_wait.py (wait_until, async_wait_until, FakeClock)
and scripts/check_test_sleeps.py, which fails when a test file adds a fixed
literal sleep beyond scripts/test-sleep-baseline.json.
"""
from __future__ import annotations

import asyncio
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "check_test_sleeps.py"


def load(name, path):
    module_spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(module_spec)
    sys.modules[name] = module
    module_spec.loader.exec_module(module)
    return module


cw = load("condition_wait", ROOT / "scripts" / "lib" / "condition_wait.py")
ratchet = load("check_test_sleeps", SCRIPT)
BASELINE = ROOT / "scripts" / "test-sleep-baseline.json"


class WaitUntilCase(unittest.TestCase):
    def test_returns_the_first_truthy_value(self):
        clock = cw.FakeClock()
        values = iter([None, 0, "", "ready"])
        self.assertEqual(cw.wait_until(lambda: next(values), timeout=5, description="x", clock=clock), "ready")
        self.assertEqual(clock.sleeps, [0.01, 0.02, 0.04])

    def test_timeout_reports_the_last_observed_value(self):
        clock = cw.FakeClock()
        observed = iter(range(1000))
        with self.assertRaises(cw.WaitTimeout) as raised:
            cw.wait_until(lambda: [next(observed)] and False, timeout=2, description="never", clock=clock)
        self.assertIs(raised.exception.last_value, False)
        self.assertIn("waiting for never", str(raised.exception))
        self.assertIn("last value False", str(raised.exception))
        # Backoff is capped and the final sleep stops exactly at the deadline.
        self.assertEqual(max(clock.sleeps), 0.25)
        self.assertAlmostEqual(sum(clock.sleeps), 2.0)

    def test_checks_once_more_at_the_deadline(self):
        clock = cw.FakeClock()
        start = clock.monotonic()
        result = cw.wait_until(
            lambda: clock.monotonic() - start >= 1.0 and "late", timeout=1.0, description="deadline", clock=clock
        )
        self.assertEqual(result, "late")

    def test_ignored_exceptions_are_reported_and_others_propagate(self):
        clock = cw.FakeClock()

        def missing():
            raise FileNotFoundError("pid file")

        with self.assertRaises(cw.WaitTimeout) as raised:
            cw.wait_until(missing, timeout=1, description="pid", ignore_exceptions=(FileNotFoundError,), clock=clock)
        self.assertIsInstance(raised.exception.last_error, FileNotFoundError)
        self.assertIn("FileNotFoundError", str(raised.exception))
        with self.assertRaises(FileNotFoundError):
            cw.wait_until(missing, timeout=1, description="pid", clock=clock)

    def test_async_form_accepts_async_predicates(self):
        clock = cw.FakeClock()
        calls = []

        async def probe():
            calls.append(clock.monotonic())
            return len(calls) >= 3 and {"done": True}

        self.assertEqual(
            asyncio.run(cw.async_wait_until(probe, timeout=5, description="async", clock=clock)), {"done": True}
        )
        with self.assertRaises(cw.WaitTimeout):
            asyncio.run(cw.async_wait_until(lambda: None, timeout=1, description="none", clock=clock))

    def test_real_clock_waits_for_a_condition_set_by_another_thread(self):
        event = threading.Event()
        threading.Thread(target=event.set).start()
        self.assertTrue(cw.wait_until(event.is_set, timeout=60, description="thread set the event"))

    def test_fake_clock_moves_wall_and_monotonic_together(self):
        clock = cw.FakeClock(start=10, wall_start=1000)
        clock.advance(5)
        self.assertEqual((clock.monotonic(), clock.time()), (15, 1005))
        with self.assertRaises(ValueError):
            clock.advance(-1)


PY_SAMPLE = '''import asyncio, time
from time import sleep
SLOW_CHILD_SECONDS = 0.5
# time.sleep(9) in a comment is not code
TEXT = "time.sleep(9) inside a string"
async def main():
    await asyncio.sleep(0)          # a yield, not synchronization
    time.sleep(SLOW_CHILD_SECONDS)  # a named, deliberate delay
    time.sleep(0.2)
    await asyncio.sleep(1)
    sleep(3)
'''

TS_SAMPLE = '''function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
// await sleep(100) in a comment
/* setTimeout(done, 50) in a block comment */
const text = 'await sleep(5) in a string';
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 25));
setTimeout(() => {
  fire(1, 2);
}, 1_000);
await sleep(200);
await page.waitForTimeout(100);
await delay(SETTLE_MS);
'''


class DetectionCase(unittest.TestCase):
    def test_python_counts_only_nonzero_literal_sleeps_in_code(self):
        self.assertEqual(ratchet.python_sleep_lines(PY_SAMPLE), [9, 10, 11])

    def test_typescript_counts_only_nonzero_literal_sleeps_in_code(self):
        self.assertEqual(ratchet.script_sleep_lines(TS_SAMPLE), [6, 7, 10, 11])

    def test_test_file_classification(self):
        self.assertEqual(ratchet.classify("agents/tests/blackbox/x.blackbox.py"), "python")
        self.assertEqual(ratchet.classify("agents/benchmarks/foo_test.py"), "python")
        self.assertEqual(ratchet.classify("scripts/tests/a.test.py"), "python")
        self.assertEqual(ratchet.classify("back-end/src/tests/unit/a.test.ts"), "script")
        self.assertEqual(ratchet.classify("front-end/src/components/A.test.tsx"), "script")
        self.assertIsNone(ratchet.classify("agents/helpers/llm.py"))
        self.assertIsNone(ratchet.classify("back-end/src/providers/retry.ts"))
        self.assertIsNone(ratchet.classify("front-end/node_modules/x/a.test.ts"))


class RatchetCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="/var/tmp" if Path("/var/tmp").is_dir() else None)
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = ratchet.main(["--root", str(self.root), *args])
        return code, out.getvalue() + err.getvalue()

    def copy(self, rel):
        target = self.root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / rel, target)
        return target

    def baseline_counts(self):
        return json.loads((self.root / "scripts/test-sleep-baseline.json").read_text())["counts"]

    def real_file_with_baseline(self, kind):
        counts = json.loads(BASELINE.read_text())["counts"]
        for rel, count in sorted(counts.items()):
            if ratchet.classify(rel) == kind and (ROOT / rel).is_file():
                if len(ratchet.sleep_lines(ROOT, rel)) == count:
                    return rel, count
        self.skipTest(f"no baselined {kind} test file at its exact baseline")

    def test_current_tree_passes(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("test sleep ratchet OK", result.stdout)

    def test_synthetic_added_sleep_in_a_copied_real_file_fails(self):
        for kind, added in (
            ("python", "\n\ndef _synthetic():\n    time.sleep(0.1)\n"),
            ("script", "\nawait new Promise((resolve) => setTimeout(resolve, 50));\n"),
        ):
            with self.subTest(kind=kind):
                rel, count = self.real_file_with_baseline(kind)
                self.copy("scripts/test-sleep-baseline.json")
                target = self.copy(rel)
                self.assertEqual(self.run_tool()[0], 0)
                target.write_text(target.read_text() + added)
                code, output = self.run_tool()
                self.assertEqual(code, 1, output)
                self.assertIn(f"{rel}: {count + 1} fixed literal sleeps, baseline {count}", output)
                self.assertIn("condition_wait.py", output)
                target.unlink()

    def test_new_test_file_has_baseline_zero(self):
        (self.root / "scripts").mkdir()
        (self.root / "scripts/test-sleep-baseline.json").write_text(json.dumps({"counts": {}}))
        new = self.root / "back-end/src/tests/unit/new.test.ts"
        new.parent.mkdir(parents=True)
        new.write_text("await waitFor('ready', () => ready);\n")
        self.assertEqual(self.run_tool()[0], 0)
        new.write_text("await new Promise((r) => setTimeout(r, 10));\n")
        code, output = self.run_tool()
        self.assertEqual(code, 1)
        self.assertIn("new.test.ts: 1 fixed literal sleeps, baseline 0 (lines 1)", output)

    def test_update_only_lowers_counts(self):
        rel = "agents/tests/unit/test_sample.py"
        path = self.root / rel
        path.parent.mkdir(parents=True)
        path.write_text("import time\ntime.sleep(1)\ntime.sleep(2)\n")
        (self.root / "scripts").mkdir()
        baseline = self.root / "scripts/test-sleep-baseline.json"
        self.assertEqual(self.run_tool("--init")[0], 0)
        self.assertEqual(self.baseline_counts(), {rel: 2})
        self.assertEqual(self.run_tool("--init")[0], 2)
        path.write_text("import time\ntime.sleep(1)\n")
        code, output = self.run_tool()
        self.assertEqual(code, 0)
        self.assertIn("1 below baseline", output)
        self.assertEqual(self.run_tool("--update")[0], 0)
        self.assertEqual(self.baseline_counts(), {rel: 1})
        path.write_text("import time\ntime.sleep(1)\ntime.sleep(2)\n")
        code, output = self.run_tool("--update")
        self.assertEqual(code, 1)
        self.assertIn("refusing --update", output)
        self.assertEqual(self.baseline_counts(), {rel: 1})
        path.unlink()
        self.assertEqual(self.run_tool("--update")[0], 0)
        self.assertEqual(self.baseline_counts(), {})
        self.assertTrue(baseline.exists())

    def test_raising_the_committed_baseline_above_the_base_ref_fails(self):
        def git(*args):
            subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True)

        git("init", "-q", "-b", "main")
        git("config", "user.email", "t@example.com")
        git("config", "user.name", "t")
        rel = "scripts/tests/sample.test.py"
        path = self.root / rel
        path.parent.mkdir(parents=True)
        path.write_text("import time\ntime.sleep(1)\n")
        self.assertEqual(self.run_tool("--init")[0], 0)
        git("add", "-A")
        git("commit", "-q", "-m", "base")
        path.write_text("import time\ntime.sleep(1)\ntime.sleep(2)\n")
        (self.root / "scripts/test-sleep-baseline.json").write_text(json.dumps({"counts": {rel: 2}}))
        code, output = self.run_tool("--base", "main")
        self.assertEqual(code, 1)
        self.assertIn(f"{rel}: baseline raised to 2 (was 1 on main); counts may only go down", output)
        code, output = self.run_tool("--base", "no-such-ref")
        self.assertEqual(code, 0, output)
        self.assertIn("no baseline at no-such-ref", output)


if __name__ == "__main__":
    unittest.main()
