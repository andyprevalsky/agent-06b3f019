"""Offline regression: concurrent PRs never modify one shared ledger or generated path.

GitHub's mergeability check ignores .gitattributes merge drivers (merge=union
only helps local merges). When two PRs edit the same file near the same lines,
the later one turns CONFLICTING, `scripts/deploy merge` refuses, and the deploy
must sync main and rerun its full gates. Measured on origin/main merges from
2026-10-24 to 2026-11-07 with merge drivers disabled: 223 of 589 branch syncs
conflicted; docs/rca/INDEX.md conflicted in 189, task_attempts.jsonl and
task_durations.jsonl in 36 each, and 132 syncs conflicted on nothing else.

Each case forks branches from one base in a throwaway repository, runs the real
writer each branch runs (an RCA case + `rca_archive.py reindex`; benchmark rows
through timeout_history and the deploy's latest-only publish), commits, and
asserts that no path is modified by two branches, that GitHub-style merges
(merge drivers disabled) are clean, and that readers then see every merged
branch's latest run with superseded iterations still excluded.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HISTORY = "agents/benchmarks/history"
BENCH_MODULES = ("__init__.py", "timeout_history.py", "span_history.py", "select_predeploy_benches.py",
                 "history_ledger.py")

RECORD = r"""
import json, sys
from benchmarks import timeout_history as th
for row in json.loads(sys.argv[1]):
    th.record_attempt(task_name=row["task"], passed=row["passed"],
                      status="COMPLETED" if row["passed"] else "FAILED",
                      duration_seconds=row["duration"], cost_cents=0.0, agent_id=row["agent"],
                      timestamp=row["end"], suite="bench")
    if row["passed"]:
        th.record_pass(task_name=row["task"], duration_seconds=row["duration"], cost_cents=0.0,
                       agent_id=row["agent"], timestamp=row["end"])
"""

READ = r"""
import json, sys
from pathlib import Path
from benchmarks import timeout_history as th
from benchmarks import select_predeploy_benches as spb
tasks = json.loads(sys.argv[1])
print(json.dumps({
    "durations": {task: th._load_durations(task) for task in tasks},
    "passes": spb.load_attempt_passes(Path(th.ATTEMPTS_FILE)),
}))
"""


def run(args, cwd, env=None, check=True):
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True,
                            stdin=subprocess.DEVNULL, timeout=120)
    if check and result.returncode:
        raise AssertionError(f"{args} exited {result.returncode}:\n{result.stdout}\n{result.stderr}")
    return result


class Repo:
    def __init__(self, path: Path):
        self.path = path
        path.mkdir(parents=True)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "t")
        self.git("config", "commit.gpgsign", "false")

    def git(self, *args, check=True, env=None):
        return run(("git", *args), self.path, env=env, check=check)

    def commit_all(self, message):
        self.git("add", "-A")
        self.git("commit", "-qm", message, "--allow-empty")
        return self.git("rev-parse", "HEAD").stdout.strip()

    def changed(self, old, new):
        return set(self.git("diff", "--name-only", old, new).stdout.split())

    def empty_tree(self):
        return run(("git", "hash-object", "-t", "tree", "-w", os.devnull), self.path).stdout.strip()

    def github_merge(self, branch):
        """Merge as GitHub's mergeability check does: no merge drivers (merge=union ignored)."""
        result = self.git(f"--attr-source={self.empty_tree()}", "merge", "--no-ff", "--no-edit", branch,
                          check=False)
        conflicts = self.git("diff", "--name-only", "--diff-filter=U").stdout.split()
        if result.returncode:
            self.git("merge", "--abort", check=False)
        return result.returncode, conflicts


def assert_disjoint(test, repo, base, branches):
    """No path is modified by two branches relative to the base they forked from."""
    changed = {name: repo.changed(base, name) for name in branches}
    names = sorted(changed)
    for index, left in enumerate(names):
        for right in names[index + 1:]:
            test.assertEqual(changed[left] & changed[right], set(),
                             f"{left} and {right} both modify a shared path; GitHub reports CONFLICTING")
    return changed


class RcaIndexIsNotASharedPath(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.repo = Repo(Path(self.tmp.name) / "repo")
        root = self.repo.path
        (root / "scripts").mkdir()
        shutil.copy(ROOT / "scripts/rca_archive.py", root / "scripts/rca_archive.py")
        shutil.copy(ROOT / ".gitignore", root / ".gitignore")
        cases = root / "docs/rca/cases"
        cases.mkdir(parents=True)
        self.templates = sorted((ROOT / "docs/rca/cases").glob("*.md"))[:2]
        for template in self.templates:
            shutil.copy(template, cases / template.name)
        self.archive("reindex")
        self.base = self.repo.commit_all("base archive")

    def tearDown(self):
        self.tmp.cleanup()

    def archive(self, *args, check=True):
        return run((sys.executable, "scripts/rca_archive.py", *args), self.repo.path, check=check)

    def add_case(self, case_id):
        """What /RCA does: write a case file, reindex, commit."""
        text = self.templates[0].read_text(encoding="utf-8")
        text = re.sub(r"(?m)^id: .*$", f"id: {case_id}", text, count=1)
        text = re.sub(r"(?m)^date: .*$", f"date: {case_id[:10]}", text, count=1)
        (self.repo.path / "docs/rca/cases" / f"{case_id}.md").write_text(text, encoding="utf-8")
        self.archive("reindex")
        return self.repo.commit_all(f"rca {case_id}")

    def test_two_case_adding_prs_share_no_path_and_merge_cleanly_on_github(self):
        repo = self.repo
        repo.git("checkout", "-qb", "pr-a", self.base)
        self.add_case("2099-01-02-concurrent-cause-a")
        repo.git("checkout", "-qb", "pr-b", self.base)
        self.add_case("2099-01-02-concurrent-cause-b")
        changed = assert_disjoint(self, repo, self.base, ["pr-a", "pr-b"])
        self.assertEqual(changed["pr-a"], {"docs/rca/cases/2099-01-02-concurrent-cause-a.md"})
        repo.git("checkout", "-q", "main")
        for branch in ("pr-a", "pr-b"):
            code, conflicts = repo.github_merge(branch)
            self.assertEqual((code, conflicts), (0, []), f"{branch} conflicts on GitHub: {conflicts}")
        self.archive("reindex")
        index = (repo.path / "docs/rca/INDEX.md").read_text(encoding="utf-8")
        self.assertIn("2099-01-02-concurrent-cause-a", index)
        self.assertIn("2099-01-02-concurrent-cause-b", index)
        self.assertEqual(self.archive("validate", check=False).returncode, 0)

    def test_validate_refuses_a_committed_index(self):
        self.archive("reindex")
        self.repo.git("add", "-f", "docs/rca/INDEX.md")
        result = self.archive("validate", check=False)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("docs/rca/INDEX.md is committed", result.stderr)


def attempt(task, passed, end, duration, agent):
    return {"task": task, "passed": passed, "end": end, "duration": duration, "agent": agent}


class BenchmarkLedgerIsNotASharedPath(unittest.TestCase):
    TASKS = ("smoke-shared", "smoke-a", "smoke-b", "smoke-c")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.repo = Repo(Path(self.tmp.name) / "repo")
        root = self.repo.path
        (root / "scripts").mkdir()
        shutil.copy(ROOT / "scripts/benchmark-history-latest-only.py", root / "scripts")
        (root / "agents/benchmarks").mkdir(parents=True)
        for name in BENCH_MODULES:
            if (ROOT / "agents/benchmarks" / name).is_file():
                shutil.copy(ROOT / "agents/benchmarks" / name, root / "agents/benchmarks" / name)
        shutil.copy(ROOT / ".gitattributes", root / ".gitattributes")
        (root / ".gitignore").write_text(".context/\n__pycache__/\n")
        history = root / HISTORY
        history.mkdir(parents=True)
        (history / "task_attempts.jsonl").write_text(json.dumps(
            {"task": "smoke-shared", "passed": True, "status": "COMPLETED", "duration_seconds": 50.0,
             "timestamp": "2026-10-01T00:00:00+00:00", "agent_id": "main-0"}) + "\n")
        (history / "task_durations.jsonl").write_text(json.dumps(
            {"task": "smoke-shared", "duration_seconds": 50.0, "cost_cents": 0.0,
             "timestamp": "2026-10-01T00:00:00+00:00", "agent_id": "main-0"}) + "\n")
        self.base = self.repo.commit_all("base ledgers")
        self.repo.git("branch", "base")

    def tearDown(self):
        self.tmp.cleanup()

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items()
               if k not in {"BENCHMARK_HISTORY_PARK_DIR", "BENCHMARK_HISTORY_WRITER", "PYTHONPATH",
                            "BENCHMARK_HUB_GROUP_RUN_ID", "BENCHMARK_ATTEMPT_SUITE",
                            "BENCHMARK_COUNTS_FOR_DEPLOY_ELIGIBILITY"}}
        env.update(extra)
        return env

    def record(self, rows, **env):
        run((sys.executable, "-c", RECORD, json.dumps(rows)), self.repo.path / "agents", env=self.env(**env))

    def publish(self, *extra):
        """The deploy `ledger` step: latest-only --write, then --check must pass."""
        tool = (sys.executable, "scripts/benchmark-history-latest-only.py", "--base", "base")
        run((*tool, *extra, "--write"), self.repo.path, env=self.env())
        self.assertEqual(run((*tool, "--check"), self.repo.path, env=self.env(), check=False).returncode, 0)

    def readers(self):
        out = run((sys.executable, "-c", READ, json.dumps(self.TASKS)), self.repo.path / "agents",
                  env=self.env()).stdout
        return json.loads(out)

    def test_concurrent_ledger_prs_share_no_path_and_readers_see_every_latest_run(self):
        repo = self.repo
        # PR A: a local bench iteration (fail, fix, pass) recorded by the normal writers.
        repo.git("checkout", "-qb", "feat/a", self.base)
        self.record([attempt("smoke-a", False, "2026-11-07T10:00:00+00:00", 30, "a-1"),
                     attempt("smoke-shared", True, "2026-11-07T10:01:00+00:00", 61, "a-shared"),
                     attempt("smoke-a", True, "2026-11-07T11:00:00+00:00", 31, "a-2")])
        self.publish()
        repo.commit_all("feat/a ledger rows")
        # PR B: a deploy's smoke lane parks its rows; the ledger step replays them.
        repo.git("checkout", "-qb", "feat/b", self.base)
        park = repo.path / ".context/deploy-ledger-park"
        self.record([attempt("smoke-b", False, "2026-11-07T10:30:00+00:00", 40, "b-1"),
                     attempt("smoke-b", True, "2026-11-07T12:00:00+00:00", 41, "b-2"),
                     attempt("smoke-shared", True, "2026-11-07T12:01:00+00:00", 62, "b-shared")],
                    BENCHMARK_HISTORY_PARK_DIR=str(park))
        self.assertEqual(repo.changed("base", "HEAD") | set(repo.git("status", "--porcelain", "--", HISTORY)
                                                            .stdout.split()), set(),
                         "parked smoke rows must not touch the tracked ledgers before the publish")
        self.publish("--apply-parked", str(park))
        repo.commit_all("feat/b ledger rows")
        # PR C: an in-flight branch whose older writer appended to the shared base file.
        repo.git("checkout", "-qb", "feat/c", self.base)
        legacy = [{"task": "smoke-c", "passed": passed, "status": "COMPLETED", "duration_seconds": 20.0,
                   "timestamp": end, "agent_id": agent}
                  for passed, end, agent in ((False, "2026-11-07T09:00:00+00:00", "c-1"),
                                             (True, "2026-11-07T13:00:00+00:00", "c-2"))]
        with (repo.path / HISTORY / "task_attempts.jsonl").open("a") as handle:
            handle.writelines(json.dumps(row) + "\n" for row in legacy)
        with (repo.path / HISTORY / "task_durations.jsonl").open("a") as handle:
            handle.write(json.dumps({"task": "smoke-c", "duration_seconds": 20.0, "cost_cents": 0.0,
                                     "timestamp": "2026-11-07T13:00:00+00:00", "agent_id": "c-2"}) + "\n")
        self.publish()
        repo.commit_all("feat/c ledger rows")
        # Meanwhile main records its own run directly (a closeout/backfill commit).
        repo.git("checkout", "-q", "main")
        self.record([attempt("smoke-shared", True, "2026-11-07T08:00:00+00:00", 63, "main-1")])
        repo.commit_all("main ledger rows")

        changed = assert_disjoint(self, repo, self.base, ["main", "feat/a", "feat/b", "feat/c"])
        for name in ("task_attempts.jsonl", "task_durations.jsonl"):
            self.assertFalse(any(path == f"{HISTORY}/{name}" for paths in changed.values() for path in paths),
                             f"a branch modified the shared base {name}")
        for branch in ("feat/b", "feat/a", "feat/c"):  # merge order is irrelevant: every PR stays mergeable
            code, conflicts = repo.github_merge(branch)
            self.assertEqual((code, conflicts), (0, []), f"{branch} conflicts on GitHub: {conflicts}")

        seen = self.readers()
        # Every merged branch's latest run is visible; superseded iterations are not.
        self.assertEqual(seen["passes"]["smoke-a"], [True])
        self.assertEqual(seen["passes"]["smoke-b"], [True])
        self.assertEqual(seen["passes"]["smoke-c"], [True])
        self.assertEqual(seen["passes"]["smoke-shared"], [True, True, True, True])
        # Timeout/p50 inputs: base rows in file order, then shard rows in recorded order.
        self.assertEqual(seen["durations"]["smoke-shared"], [50.0, 63.0, 61.0, 62.0])
        self.assertEqual(seen["durations"]["smoke-a"], [31.0])
        self.assertEqual(seen["durations"]["smoke-c"], [20.0])


if __name__ == "__main__":
    unittest.main()
