"""Offline regression: runs of merged code recorded outside the ledger are backfilled latest-only."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "benchmark-history-backfill.py"
HISTORY = Path("agents/benchmarks/history")


def attempt(task, passed, end, agent, duration=60.0):
    return {"task": task, "passed": passed, "status": "COMPLETED" if passed else "FAILED",
            "duration_seconds": duration, "cost_cents": 0.0, "timestamp": end, "agent_id": agent,
            "failure_reason": None, "fast_mode_cache": False, "counts_for_deploy_eligibility": False}


def hub_task(name, passed, agent, duration=60.0):
    return {"name": name, "passed": passed, "status": "passed" if passed else "failed",
            "agent_id": agent, "duration_seconds": duration, "cost_cents": 1.0,
            "world_model_mode": "real", "fast_mode": False, "failure_reason": None if passed else "boom"}


def hub_run(run_id, start, tasks, code=None, group=None, source="cloud-fleet", live=False):
    run = {"run_id": run_id, "timestamp": start, "suite": "cloud-fleet", "source": source,
           "live": live, "tasks": tasks, "code": code}
    if group:
        run["group_run_id"] = group
    return run


class BackfillTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "t")
        (self.repo / HISTORY).mkdir(parents=True)
        self.rows = [attempt("t1", True, "2026-10-01T00:00:00+00:00", "main-1")]
        self.write_ledger(self.rows)
        (self.repo / HISTORY / "task_durations.jsonl").write_text(json.dumps(
            {"task": "t1", "duration_seconds": 60.0, "timestamp": "2026-10-01T00:00:00+00:00",
             "agent_id": "main-1"}) + "\n")
        self.commit("base")
        self.main_sha = self.head()

        # feature branch: a failing iteration, a fix, and one landed later t3 run
        self.git("checkout", "-q", "-b", "feat")
        self.code("feat.py", "v1")
        self.fail_sha = self.head()
        self.code("feat.py", "v2")
        self.fix_sha = self.head()
        self.write_ledger(self.rows + [attempt("t3", True, "2026-10-03T00:00:00+00:00", "feat-t3")])
        self.commit("feat history")

        # main gains a row that a later merge drops (conflict resolution took one side)
        self.git("checkout", "-q", "main")
        self.lost = attempt("t4", True, "2026-10-02T00:00:00+00:00", "lost-1")
        self.write_ledger(self.rows + [self.lost])
        self.commit("main history")
        self.git("merge", "-q", "--no-ff", "--no-commit", "feat", check=False)
        self.write_ledger(self.rows + [attempt("t3", True, "2026-10-03T00:00:00+00:00", "feat-t3")])
        self.commit("Merge feat")
        self.after_merge = self.head()

        # never-merged branch, plus an unmerged history-only commit on top of main
        self.git("checkout", "-q", "-b", "wip")
        self.code("wip.py", "x")
        self.wip_sha = self.head()
        self.write_ledger(self.current() + [attempt("t5", False, "2026-10-04T00:00:00+00:00", "wip-code")])
        self.commit("wip history with code")
        self.git("checkout", "-q", "-b", "history-only", "main")
        self.write_ledger(self.current() + [attempt("t6", True, "2026-10-05T00:00:00+00:00", "hist-only")])
        self.commit("history only")
        # two unmerged history-only commits on top of the merged fix: latest-only keeps the later
        for branch, agent, end in (("fix-early", "fix-early", "2026-10-02T13:00:00+00:00"),
                                   ("fix-late", "fix-late", "2026-10-02T14:00:00+00:00")):
            self.git("checkout", "-q", "-b", branch, self.fix_sha)
            self.write_ledger(self.current() + [attempt("t12", True, end, agent)])
            self.commit(f"{branch} history")
        # a pre-merge row whose timestamp cannot be parsed is reported, never fatal
        self.git("checkout", "-q", "-b", "fix-bad-time", self.fix_sha)
        self.write_ledger(self.current() + [attempt("t13", True, "not-a-time", "fix-bad-time")])
        self.commit("fix-bad-time history")
        self.git("checkout", "-q", "main")

        self.hub = Path(self.tmp.name) / "hub.json"
        self.hub.write_text(json.dumps({"runs": [
            hub_run("fail", "2026-10-02T10:00:00+00:00", [hub_task("t2", False, "hub-fail")],
                    code=f"HEAD@{self.fail_sha[:9]} (pinned; local patch excluded)"),
            hub_run("pass", "2026-10-02T12:00:00+00:00", [hub_task("t2", True, "hub-pass")],
                    code=f"HEAD@{self.fix_sha[:9]} (clean)"),
            hub_run("early-t3", "2026-10-02T00:00:00+00:00", [hub_task("t3", False, "hub-t3")],
                    code=f"HEAD@{self.fail_sha[:9]} (clean)"),
            hub_run("main-a", "2026-10-06T00:00:00+00:00", [hub_task("t7", False, "main-a")],
                    code=f"HEAD@{self.after_merge[:9]} (clean)", group="g1"),
            hub_run("main-b", "2026-10-06T00:00:00+00:00", [hub_task("t7", True, "main-b")], group="g1"),
            hub_run("wip", "2026-10-06T00:00:00+00:00", [hub_task("t8", True, "hub-wip")],
                    code=f"wip@{self.wip_sha[:9]} (clean)"),
            hub_run("patched", "2026-10-06T00:00:00+00:00", [hub_task("t9", True, "hub-patch")],
                    code=f"HEAD@{self.main_sha[:9]} +patch(1 file changed)"),
            hub_run("unbound", "2026-10-06T00:00:00+00:00", [hub_task("t10", True, "hub-unbound")],
                    source="manual-run"),
            hub_run("dup", "2026-10-06T00:00:00+00:00", [hub_task("t1", True, "main-1")],
                    code=f"HEAD@{self.main_sha[:9]} (clean)"),
            hub_run("infra", "2026-10-06T00:00:00+00:00",
                    [{**hub_task("t11", False, "hub-infra"), "status": "INFRA_ERROR", "passed": None}],
                    code=f"HEAD@{self.main_sha[:9]} (clean)"),
        ]}))

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args, check=True):
        return subprocess.run(("git", "-C", str(self.repo), *args), check=check, capture_output=True,
                              text=True).stdout

    def head(self):
        return self.git("rev-parse", "HEAD").strip()

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-qm", message)

    def code(self, name, body):
        (self.repo / name).write_text(body)
        self.commit(f"code {name}")

    def write_ledger(self, rows):
        (self.repo / HISTORY / "task_attempts.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))

    def current(self):
        text = (self.repo / HISTORY / "task_attempts.jsonl").read_text()
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    def run_tool(self, *extra):
        return subprocess.run(
            (sys.executable, str(SCRIPT), "--repo", str(self.repo), "--base", "main",
             "--hub-index", str(self.hub), *extra), capture_output=True, text=True, check=True).stdout

    def test_backfill_lands_only_merged_latest_runs(self):
        dry = self.run_tool()
        self.assertIn("dry-run:", dry)
        self.assertIn("gap: pre-merge rows without a parseable timestamp: 1", dry)
        self.assertEqual(self.current()[-1]["agent_id"], "feat-t3", "dry run must not write")
        self.run_tool("--write")
        added = {r["agent_id"]: r for r in self.current() if r.get("backfill_source")}
        # fail -> fix -> pass -> merge lands only the pass; an earlier t3 run is superseded
        # by the later t3 row the merge already landed. main-b shares a campaign group with
        # main-a but carries no source identity of its own, so it stays unbound.
        self.assertEqual(sorted(added), ["fix-late", "hist-only", "hub-pass", "lost-1", "main-a"])
        self.assertEqual(added["hub-pass"]["timestamp"], "2026-10-02T12:01:00+00:00")
        self.assertEqual(added["lost-1"]["backfill_source"], "main-loss")
        self.assertEqual(added["hist-only"]["backfill_source"], "branch")
        self.assertTrue(all(r["counts_for_deploy_eligibility"] is False for r in added.values()))
        durations = (self.repo / HISTORY / "task_durations.jsonl").read_text().splitlines()
        duration_agents = sorted(json.loads(line)["agent_id"] for line in durations)
        self.assertEqual(duration_agents, ["fix-late", "hist-only", "hub-pass", "lost-1", "main-1"])
        # the deploy-time latest-only pass leaves backfilled history alone
        latest_only = SCRIPT.with_name("benchmark-history-latest-only.py")
        check = subprocess.run((sys.executable, str(latest_only), "--repo", str(self.repo), "--base", "main",
                                "--check"), capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stdout + check.stderr)
        # idempotent
        before = (self.repo / HISTORY / "task_attempts.jsonl").read_text()
        self.assertIn("0 attempt rows, 0 duration rows", self.run_tool("--write"))
        self.assertEqual(before, (self.repo / HISTORY / "task_attempts.jsonl").read_text())
        # an interrupted write that appended attempts but not durations is recovered
        durations_path = self.repo / HISTORY / "task_durations.jsonl"
        durations_path.write_text("".join(
            line + "\n" for line in durations if not json.loads(line).get("backfill_source")))
        self.assertIn("0 attempt rows, 4 duration rows", self.run_tool("--write"))
        self.assertEqual(before, (self.repo / HISTORY / "task_attempts.jsonl").read_text())
        recovered = sorted(json.loads(line)["agent_id"] for line in durations_path.read_text().splitlines())
        self.assertEqual(recovered, duration_agents)


if __name__ == "__main__":
    unittest.main()
