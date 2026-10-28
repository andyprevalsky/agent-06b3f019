#!/usr/bin/env python3
"""The CLI benchmark scorecard renders only recorded artifacts and enforces FORMAT v8.

Golden text renders cover fleet, campaign and sharded runs; set UPDATE_GOLDEN=1
to rewrite them after an intentional presentation change.
"""

import io
import json
import os
import re
import runpy
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
CARD = runpy.run_path(str(ROOT / "scripts/cloudbench-scorecard.py"))
LEDGER = runpy.run_path(str(ROOT / "scripts/cloudbench_experiments.py"))
AUDIT = runpy.run_path(str(ROOT / "scripts/cloudbench-native-release-audit.py"))
GOLDEN = ROOT / "scripts/tests/fixtures/scorecard"
T0 = 1792351732.0  # Oct 18 2026, 12:28:52 PM PDT
NOW = T0 + 3600


def write(path: Path, value) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value if isinstance(value, str) else json.dumps(value))
    return path


def card(run_id, tasks, *, window="480", cost=True):
    return {"run_id": run_id, "timestamp": "2026-10-18T19:28:52+00:00", "status": "passed",
            "code": "HEAD@126b82622 (pinned)",
            "cost": {"agents_llm_usd": 0.5 if cost else None, "wmh_grounding_usd": None, "infra_usd": None,
                     "total_usd": 0.5, "fast_cache_hit_rate": 0.8 if cost else None},
            "tasks": {"total": len(tasks)}, "per_task": tasks,
            "execution_provenance": {"base_sha": "1387ae608e7cfb8e3f0a876daae92093f503b465",
                                     "config": {"values": {"benchmark_wall_clock_backstop_seconds": window}}}}


def task(name, status, *, duration=120.0, cost=0.25, reason=None, stage="released"):
    return {"name": name, "status": status, "duration_s": duration, "cost_usd": cost,
            "failure_reason": reason, "lifecycle_stage": stage, "agent_id": "8041de66-1bd1-4fe9-bb78-93c12c51e16c"}


def job(index, status, verdict, infra, *, run_id=None, fleet=None, pid=None, attempts=1, wall=600.0, released=True):
    jid = f"r001-j{index:04d}"
    tries = [dict(attempt=n, status=status if n == attempts else "failed", finished_at="2026-10-18T20:00:00Z",
                  infra_failure=infra if n == attempts else True, run_id=run_id if n == attempts else None,
                  controller_pid=pid) for n in range(1, attempts + 1)] if status in ("passed", "failed") else (
        [dict(attempt=1, status="running")] if status == "running" else [])
    return dict(job_id=jid, task=f"task-{index}", run=1, status=status, task_status=verdict, infra_failure=infra,
                run_id=run_id, fleet_dir=fleet, controller_pid=pid, attempts=tries, wall_clock_seconds=wall,
                started_at="2026-10-18T19:40:00+00:00", finished_at="2026-10-18T19:50:00+00:00" if status in ("passed", "failed") else None,
                resources_released=released if status in ("passed", "failed") else None,
                lifecycle_verified=released if status in ("passed", "failed") else None)


class Fixtures:
    def __init__(self, base: Path):
        self.base = base
        self.ledger = base / "ledger.jsonl"

    def fleet(self) -> Path:
        run = self.base / "20261018-192852-4242"
        write(run / "_batch/report-card.json", card(run.name, [
            task("alpha", "passed"), task("beta", "failed", reason="Timeout after 480s (wall-clock backstop=480s) | Agent status: PAUSED")]))
        write(run / "_batch/lifecycle.json", {"run_id": run.name, "status": "verified", "controller_exit_code": 1,
                                             "hub_publication_failed": False})
        for name, end in (("alpha", T0 + 700), ("beta", T0 + 900)):
            write(run / name / "bench-e2e.started-epoch", str(T0))
            write(run / name / "bench-e2e.finished-epoch", str(end))
        write(run / "teardown-ownership/provider-teardown-verified.epoch", str(T0 + 960))
        LEDGER["record"]("launch", run.name, ledger=self.ledger, goal="fleet-goal", slice="alpha +1", kind="fleet",
                         run_dir=str(run), triggered_at=T0)
        return run

    def campaign(self) -> Path:
        directory = self.base / "campaigns/campaign-20261018-192852-7"
        fleet = self.base / "fleet/runs/20261018-193000-11"
        write(fleet / "_batch/report-card.json", card(fleet.name, [task("task-2", "failed", reason="Expected tool 'spawn_browser_agent' not found in messages")]))
        jobs = [job(1, "passed", "PASSED", False), job(2, "failed", "FAILED", False, run_id=fleet.name, fleet=str(fleet)),
                job(3, "failed", "INFRA_ERROR", True, attempts=2, released=True), job(4, "running", None, None),
                job(5, "queued", None, None)]
        write(directory / "summary.json", {"campaign_id": directory.name, "started_at": "2026-10-18T19:28:52+00:00",
                                           "e2e_started_at_epoch": T0, "status": "running", "runs": 1, "task_count": 5,
                                           "total_jobs": 5, "jobs": jobs})
        LEDGER["record"]("launch", directory.name, ledger=self.ledger, goal="campaign-goal", slice="mixed5",
                         kind="campaign", run_dir=str(directory), triggered_at=T0)
        return directory

    def sharded(self, *, result=True, audit=True, live=False) -> Path:
        admission = self.base / "original600-1792351732378699991"
        write(admission / "coordination.json", {
            "schema": "original600-shard-coordination-v1", "controllers": 2, "scheduled_total": 4,
            "started_at": T0 + 12, "released_at": T0 + 600, "finished_at": None if live else T0 + 2000,
            "abort_reason": None, "terminate_reason": None,
            "shards": {"0": {"out": str(admission / "shard-00/run")}, "1": {"out": str(admission / "shard-01/run")}}})
        for index in (0, 1):
            shard = admission / f"shard-{index:02d}"
            write(shard / "attempt-start.safe.json", {"started_at_epoch": T0, "source_ref": "126b82622ed84875512852fcaf6a7afe1b4b5130",
                                                      "task_ref": "1387ae608e7cfb8e3f0a876daae92093f503b465"})
            progress = {"combos": [["passed", "PASSED", False, 1], ["running", None, None, 1]], "jobs": 2,
                        "terminal_attempts": 1, "infra_attempts": 0,
                        "reasons": [["AGENT FAIL", "Timeout after 480s (wall-clock backstop=480s)", 1]] if index else []}
            write(shard / "run/shard-status.json", {"schema": "original600-shard-status-v1", "state": "LIVE",
                                                    "infra": {"infra_true": 0, "unique_jobs": 2, "progress": progress}})
            if not live:
                write(shard / "run/terminal.json", {"status": "CONTROLLER_RELEASE_VERIFIED", "machine": f"8744150b0d72{index:02d}"})
                write(shard / "run/export/disposable-export.verified.json", "{}")
        write(admission / "hub-group/hub-group.json", {"run_group": {"members": [
            {"member_id": f"r001-j{i:04d}", "name": f"task-{i}", "run_number": 1} for i in range(1, 5)]}})
        if result and not live:
            rows = CARD["compact_rows"]({"jobs": [job(1, "passed", "PASSED", False), job(2, "failed", "FAILED", False),
                                                  job(3, "failed", "FAILED", False), job(4, "failed", None, None, pid=99, released=False)]},
                                        {"20261018-1-99": card("20261018-1-99", [task("task-4", "passed", stage="teardown")])})
            write(admission / "result.json", {"scheduled_total": 4, "observed_jobs": 4, "missing_jobs": 0,
                                              "hub_group_final_published": True, "jobs": rows})
        if audit and not live:
            write(admission / "native-release-audit.json", AUDIT["audit"](
                [{"id": "abcdefabcdef01", "name": "unrelated", "state": "started"}], app="navi-whisper-lux-bench",
                guest_names={"cloudbench-a", "cloudbench-b"}, guest_ids={"0123456789abcd"},
                controllers={"8744150b0d7200"}, exports=2, now=T0 + 2100))
        LEDGER["record"]("launch", "original600-1792319287448456235", ledger=self.ledger, goal="original600",
                         slice="run600c", kind="sharded", run_dir=str(self.base / "absent"), triggered_at=T0 - 32000,
                         scheduled_total=600)
        LEDGER["record"]("end", "original600-1792319287448456235", ledger=self.ledger, goal="original600",
                         ended_at=T0 - 27000, state="FAILED",
                         outcome={"task_status": {"PASSED": 90, "FAILED": 484, "INFRA_ERROR": 14, "UNKNOWN": 12},
                                  "infra_failures": 14})
        LEDGER["record"]("launch", admission.name, ledger=self.ledger, goal="original600", slice="polar4",
                         kind="sharded", run_dir=str(admission), triggered_at=T0, scheduled_total=4)
        return admission

    def barrier_abort(self, *, shards=3, scheduled=70) -> Path:
        """Mirrors original600-1792402040642867509: operator SIGTERM at the launch barrier, no
        terminal.json, controllers released afterwards by the exact cleanup helper's canonical receipts."""
        admission = self.base / "original600-1792402040642867509"
        outs = {str(i): {"out": str(admission / f"shard-{i:02d}/run"), "pid": 347865 + i} for i in range(shards)}
        write(admission / "coordination.json", {
            "schema": "original600-shard-coordination-v1", "controllers": shards, "scheduled_total": scheduled,
            "started_at": T0 + 10, "released_at": None, "aborted_at": T0 + 1072, "abort_reason": "operator SIGTERM",
            "terminated_at": T0 + 1072, "terminate_reason": "operator SIGTERM", "finished_at": T0 + 3124,
            "infra_true": 0, "exit_codes": {str(i): -9 for i in range(shards)}, "shards": outs})
        for i in range(shards):
            run = admission / f"shard-{i:02d}/run"
            mid, vid = f"80e9037b3942{i:02d}", f"vol_vxmzjq6z13mwl9{i:02d}"
            write(admission / f"shard-{i:02d}/attempt-start.safe.json", {"started_at_epoch": T0, "source_ref": "7441b41f4c56a24f350303fa31bfcf698e2519ff"})
            write(run / "shard-status.json", {"schema": "original600-shard-status-v1", "state": "NOT_PUBLISHED",
                                              "barrier": None, "infra": None, "machine": mid})
            write(run / "global-abort.json", {"reason": "operator SIGTERM", "release_id": "354e4f818c1ed72f00480145"})
            write(run / "export/disposable-export.verified.json", "{}")
            write(run / "export/disposable-controller.ownership.json", {"machine": {"id": mid}, "volume": {"id": vid}})
            write(run / "export/workspace-volume.ownership.json", {"volume_id": vid})
            write(run / "export/disposable-controller.release.json", {"machine_deleted": True, "machine_id": mid,
                                                                     "volume_disposition": "pending_destroy", "volume_id": vid})
        write(admission / "result.json", {"campaign_status": {}, "jobs": [], "observed_jobs": 0, "missing_jobs": scheduled,
                                          "scheduled_total": scheduled, "task_status": {}, "infra_failures": 0,
                                          "hub_group_final_published": True})
        LEDGER["record"]("launch", admission.name, ledger=self.ledger, goal="70-tasks", slice="70-tasks",
                         kind="sharded", run_dir=str(admission), triggered_at=T0, scheduled_total=scheduled)
        return admission


def render(path, fixtures, **kw):
    return CARD["build"](path, ledger=fixtures.ledger, now=NOW, **kw)


class Scorecard(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="scorecard-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.f = Fixtures(self.tmp)

    def golden(self, name, value):
        text = value.replace(str(self.tmp), "<tmp>")
        path = GOLDEN / f"{name}.golden.txt"
        if os.environ.get("UPDATE_GOLDEN") == "1":
            write(path, text)
        self.assertEqual(text, path.read_text(), f"golden {name} changed; rerun with UPDATE_GOLDEN=1 if intentional")

    def valid(self, data):
        document = CARD["render_html"](data)
        self.assertEqual(CARD["validate_html"](document), [])
        return document

    def test_descent_does_not_reload_history_for_unused_batch_trend(self):
        paths = []
        for index in range(4):
            ident = f"history-perf-{index}"
            path = self.tmp / ident
            write(path / "_batch/report-card.json", card(ident, [task("same-task", "passed")]))
            write(path / "teardown-ownership/provider-teardown-verified.epoch", str(T0 + 100 + index * 20))
            LEDGER["record"]("launch", ident, ledger=self.f.ledger, goal="history-perf", kind="fleet",
                             run_dir=str(path), triggered_at=T0 + index * 20)
            paths.append(path)
        load = CARD["build"].__globals__["load"]
        with mock.patch.dict(CARD["build"].__globals__, {"load": mock.Mock(wraps=load)}) as scope:
            traced = scope["load"]
            descent = render(paths[-1], self.f, iterations=4)
            self.assertEqual(traced.call_count, 4, "descent must read each of its four history runs once")
            self.assertEqual([call.args[0] for call in traced.call_args_list].count(paths[0]), 1)
        self.assertEqual(len(descent["history"]), 4)
        self.assertEqual(descent["trend"], [])
        self.assertIn('data-section="global-trend"', self.valid(descent))
        with mock.patch.dict(CARD["build"].__globals__, {"load": mock.Mock(wraps=load)}) as scope:
            generic = render(paths[-1], self.f)
            self.assertEqual(scope["load"].call_count, 6)
        self.assertEqual(len(generic["trend"]), 4)
        self.assertEqual(len(generic["history"]), 3)
        self.assertIn('data-section="trend"', self.valid(generic))

    def test_descent_global_display_default_contract(self):
        data = render(self.f.fleet(), self.f, iterations=2)
        document = self.valid(data)
        self.assertIn('data-section="global-progress"', document)
        self.assertNotIn('data-section="lifecycle"', document)
        self.assertNotIn('class="bar"', document)

    def global_inputs(self, count=6, k=2):
        import hashlib
        names = [f"global-task-{i}" for i in range(count)]
        selected = write(self.tmp / "selected.json", {"schema": "descend-selected-tasks-v1", "rows": [{"name": name} for name in names]})
        digest = hashlib.sha256(selected.read_bytes()).hexdigest()
        def receipt(i, verdict):
            return {"campaign_id": "original-global", "job_id": f"job-{i}", "run": i + 1,
                    "verdict": verdict, "source_commit": "a" * 40, "evidence_sha256": "b" * 64,
                    "controller_terminal_at": T0 + 100 + i}
        rows = []
        for i, name in enumerate(names):
            records = [receipt(i * k + j, "PASS") for j in range(k)]
            rows.append({"task": name, "last_scored": records, "known_scored_count": len(records),
                         "acceptance": "FINAL_SOURCE_REVERIFICATION_REQUIRED", "green": False})
        ledger = {"schema": "descend-rolling-acceptance-v1", "task_count": count, "k": k, "rows": rows}
        path = write(self.tmp / "acceptance.json", ledger)
        args = {"global_acceptance": path, "selected_tasks": selected,
                "selected_tasks_sha256": digest, "global_runs": k}
        return ledger, args

    def test_global_cake_uses_full_scope_historical_pairs_and_keeps_audits(self):
        ledger, args = self.global_inputs()
        rows = ledger["rows"]
        rows[1]["last_scored"][0]["verdict"] = "FAIL"
        rows[2]["last_scored"] = rows[2]["last_scored"][:1]; rows[2]["known_scored_count"] = 1
        rows[3].update(last_scored=[], known_scored_count=0, acceptance="UNTESTED")
        rows[4]["last_scored"][0]["verdict"] = "INFRA_ERROR"
        rows.pop()
        write(args["global_acceptance"], ledger)
        before = {str(p): p.read_bytes() for p in (args["global_acceptance"], args["selected_tasks"])}
        run = self.f.fleet()
        old = render(run, self.f, iterations=5)
        data = render(run, self.f, iterations=5, **args)
        gp = data["global_progress"]
        self.assertEqual(gp["counts"], {"PASS": 1, "FAIL": 1, "PARTIAL": 1, "UNKNOWN": 2, "UNRUN": 1})
        self.assertEqual(gp["final_source_qualified"], 0)
        self.assertEqual(data["experiment"]["outcomes"], old["experiment"]["outcomes"])
        self.assertEqual(data["experiment"]["lifecycle"], old["experiment"]["lifecycle"])
        html = self.valid(data)
        self.assertEqual(html.count('data-task="global-task-'), 12)
        self.assertEqual(gp["slot_counts"], {"PASS": 5, "FAIL": 1, "UNKNOWN": 3, "UNRUN": 3})
        self.assertIn("5/12", html)
        self.assertEqual(re.findall(r'data-status="([A-Z]+)"', html), ["PASS"] * 5 + ["FAIL"] + ["UNKNOWN"] * 3 + ["UNRUN"] * 3)
        self.assertEqual(sorted(map(int, re.findall(r'data-selected-ordinal="(\d+)"', html))), sorted(list(range(1, 7)) * 2))
        self.assertIn(".trend text{fill:var(--fg);font-size:15px}", html)
        self.assertNotIn('data-section="lifecycle"', html)
        self.assertNotIn('class="bar"', html)
        self.assertIn('data-section="global-trend"', html)
        self.assertNotIn('data-section="trend"', html)
        self.assertIn("Historical outcomes are not final-source acceptance", html)
        self.assertIn("GLOBAL", CARD["render_text"](data))
        for p, raw in before.items(): self.assertEqual(Path(p).read_bytes(), raw)
        generic = self.valid(render(run, self.f))
        self.assertIn('data-section="lifecycle"', generic)
        self.assertNotIn('data-section="global-progress"', generic)

    def test_individual_slot_denominator_and_curve_do_not_collapse_task_pairs(self):
        ledger, args = self.global_inputs(count=200)
        for i, row in enumerate(ledger["rows"]):
            if 17 <= i < 25:
                row["last_scored"][1]["verdict"] = "FAIL"
            elif 25 <= i < 35:
                for receipt in row["last_scored"]: receipt["verdict"] = "FAIL"
            elif i >= 35:
                row.update(last_scored=[], known_scored_count=0, acceptance="UNTESTED")
        write(args["global_acceptance"], ledger)
        history = dict(schema="descend-global-history-v1", selected_tasks_sha256=args["selected_tasks_sha256"], task_count=200, k=2,
                       snapshots=[dict(experiment_id="original-finish", finished_at=NOW - 1, acceptance_ledger=ledger)])
        args["global_history"] = write(self.tmp / "slot-history.json", history)
        data = render(self.f.fleet(), self.f, iterations=8, **args)
        html = self.valid(data)
        self.assertIn("42/400", html)
        gp = data["global_progress"]
        self.assertEqual(gp["slot_count"], 400)
        self.assertEqual(gp["historical_pass_fraction"], 42 / 400)
        self.assertEqual(gp["historical_task_pass_fraction"], 17 / 200)
        self.assertEqual(gp["slot_counts"], dict(PASS=42, FAIL=28, UNKNOWN=0, UNRUN=330))
        self.assertEqual(gp["history"][0]["rate"], 42 / 400)
        self.assertEqual(gp["counts"]["PASS"], 17)  # separate task qualification, never cake denominator
        html = self.valid(data)
        self.assertIn("42/400", html)
        self.assertIn("10.5%", html)
        self.assertEqual(html.count('data-slot="'), 400)
        self.assertIn("individual scored PASS", html)
        self.assertNotIn("Tasks with all", html)
        before = {p: Path(p).read_bytes() for p in (args["global_acceptance"], args["global_history"])}
        # One verified pass with its expected companion receipt missing: green + amber.
        ledger["rows"][0]["last_scored"].pop()
        write(args["global_acceptance"], ledger)
        gp = render(self.f.fleet(), self.f, iterations=8, **args)["global_progress"]
        self.assertEqual(gp["slots"][0]["status"], "PASS")
        self.assertEqual(gp["slots"][1]["status"], "UNKNOWN")
        # Explicitly one known scored run: green + gray, not amber task collapse.
        ledger["rows"][0]["known_scored_count"] = 1
        write(args["global_acceptance"], ledger)
        gp = render(self.f.fleet(), self.f, iterations=8, **args)["global_progress"]
        self.assertEqual(gp["slots"][1]["status"], "UNRUN")
        # An invalid actual receipt remains unknown even if its value is None.
        ledger["rows"][0].update(last_scored=[None], known_scored_count=1)
        write(args["global_acceptance"], ledger)
        gp = render(self.f.fleet(), self.f, iterations=8, **args)["global_progress"]
        self.assertEqual(gp["slots"][0]["status"], "UNKNOWN")
        self.assertEqual(Path(args["global_history"]).read_bytes(), before[args["global_history"]])

    def test_global_scope_hash_identity_and_generic_k_contract(self):
        ledger, args = self.global_inputs()
        run = self.f.fleet()
        for bad in ("0" * 64, "", None):
            with self.subTest(hash=bad), self.assertRaises(ValueError):
                render(run, self.f, iterations=2, **dict(args, selected_tasks_sha256=bad))
        for mutate in (lambda d: d.update(task_count=7), lambda d: d.update(k=True),
                       lambda d: d["rows"].append(dict(d["rows"][0])),
                       lambda d: d["rows"][0]["last_scored"].append(d["rows"][0]["last_scored"][0])):
            altered = json.loads(json.dumps(ledger)); mutate(altered); write(args["global_acceptance"], altered)
            with self.assertRaises(ValueError): render(run, self.f, iterations=2, **args)
        missing = json.loads(json.dumps(ledger))
        missing["rows"][0]["last_scored"] = missing["rows"][0]["last_scored"][:1]
        write(args["global_acceptance"], missing)
        self.assertEqual(render(run, self.f, iterations=2, **args)["global_progress"]["rows"][0]["status"], "UNKNOWN")
        with self.assertRaises(ValueError):
            render(run, self.f, global_runs=0)
        failed = json.loads(json.dumps(ledger))
        failed["rows"][0]["last_scored"][0]["verdict"] = "FAIL"
        failed["rows"][0]["last_scored"][1].pop("evidence_sha256")
        write(args["global_acceptance"], failed)
        row = render(run, self.f, iterations=2, **args)["global_progress"]["rows"][0]
        self.assertEqual(row["status"], "FAIL")
        self.assertIn("incomplete", row["reason"])
        failed["rows"][0]["last_scored"] = failed["rows"][0]["last_scored"][:1]
        write(args["global_acceptance"], failed)
        self.assertEqual(render(run, self.f, iterations=2, **args)["global_progress"]["rows"][0]["status"], "FAIL")
        for k in (1, 3):
            ledger, args = self.global_inputs(k=k)
            data = render(run, self.f, iterations=2, **args)
            self.assertEqual(data["global_progress"]["counts"]["PASS"], 6)
            self.assertIn("individual scored PASS", self.valid(data))
            self.assertNotIn("Tasks with all", self.valid(data))
            self.assertEqual(data["global_progress"]["slot_count"], 6 * k)
            self.assertIn(f"GLOBAL latest {k} scored runs", CARD["render_text"](data))

    def test_global_history_never_bridges_missing_snapshots_or_uses_slice_rate(self):
        ledger, args = self.global_inputs()
        empty = json.loads(json.dumps(ledger))
        for row in empty["rows"]: row.update(last_scored=[], known_scored_count=0, acceptance="UNTESTED")
        history = {"schema": "descend-global-history-v1", "selected_tasks_sha256": args["selected_tasks_sha256"],
                   "task_count": 6, "k": 2, "snapshots": [
                    {"experiment_id": "one", "finished_at": T0 + 10, "acceptance_ledger": empty},
                    {"experiment_id": "two", "finished_at": T0 + 500, "acceptance_ledger": None},
                    {"experiment_id": "three", "finished_at": T0 + 1000, "acceptance_ledger": ledger}]}
        args["global_history"] = write(self.tmp / "global-history.json", history)
        data = render(self.f.fleet(), self.f, iterations=5, **args)
        self.assertEqual([p["rate"] for p in data["global_progress"]["history"]], [0, None, 1])
        html = self.valid(data)
        self.assertEqual(html.count('<path class="path"'), 0)
        self.assertIn("missing snapshots are not bridged", html)
        history["snapshots"][2]["finished_at"] = T0 + 100
        write(args["global_history"], history)
        with self.assertRaises(ValueError): render(self.f.fleet(), self.f, iterations=5, **args)

    def test_descent_strict_color_boundaries_and_unknowns(self):
        data = render(self.f.fleet(), self.f, iterations=2)
        exp = data["experiment"]
        for passed, expected in ((80, "bad"), (81, "warn"), (95, "warn"), (96, "ok")):
            exp.update(scored=100, scheduled_total=100, infra_jobs=4)
            exp["outcomes"].update(PASS=passed)
            html = CARD["render_html"](data)
            self.assertRegex(html, rf'✅ Pass</div><div class="v {expected}">')
            self.assertRegex(html, r'🧯 Infra</div><div class="v ok">')
        exp["infra_jobs"] = 5
        self.assertRegex(CARD["render_html"](data), r'🧯 Infra</div><div class="v bad">')
        exp["infra_unattributed_cancelled"] = 1
        self.assertRegex(CARD["render_html"](data), r'🧯 Infra</div><div class="v warn">')

    def test_observed_telemetry_is_bound_deduplicated_and_never_invented(self):
        import copy
        import hashlib
        run = self.f.sharded()
        result = json.loads((run / "result.json").read_text())
        sources = self.tmp / "sources"
        summary = {"campaign_id": "original-campaign", "jobs": []}
        manifest = {"archive_sha256": "a" * 64, "files": {}}
        index, members, costs = [], [], []
        for i, row in enumerate(result["jobs"]):
            job, name = row["job_id"], row["task"]
            agent, fleet, digest = "agent-" + job, "fleet-" + job, str(i) * 64
            row.update(agent_id=agent, cost_usd=.17 if i == 1 else 0)
            summary["jobs"].append(dict(job_id=job, task=name, run_id=fleet, task_status=row["task_status"]))
            entry = {"sha256": digest, "kind": "file", "bytes": 100}
            manifest["files"]["context/" + fleet + "/" + name + "/run.json"] = entry
            manifest["files"]["context/" + fleet + "/" + name + "/worker.log"] = entry
            index.append(dict(job=job, task=name, fleet=fleet, root_agent=agent, file="context/" + fleet + "/" + name + "/worker.log", sha256=digest))
            members.append(dict(job_id=job, task=name, shard="00", campaign_id=summary["campaign_id"],
                fleet_run_id=fleet, original_task_status=row["task_status"], root_agent_id=agent,
                allowed_agent_ids=[agent], run_json_sha256=digest, run_json_path="context/" + fleet + "/" + name + "/run.json",
                manifest_run_entry=entry, allowed_source_sha256=[digest], binding_status="verified-scored-run",
                source_log_entries=[dict(path="context/" + fleet + "/" + name + "/worker.log", sha256=digest, manifest_entry=entry)]))
            costs.append(dict(job_id=job, task=name, cost_cents=17 if i == 1 else 0, run_json_sha256=digest))
        write(run / "result.json", result)
        for name, obj in (("export-manifest.json", manifest), ("summary.json", summary), ("native-log-index.json", index)):
            write(sources / "00" / name, obj)
        sha = lambda name: hashlib.sha256((sources / "00" / name).read_bytes()).hexdigest()
        membership = dict(schema="descend-scorecard-membership-v1", experiment_id=run.name, scheduled_jobs=4,
            proofs={"00": dict(export_manifest_sha256=sha("export-manifest.json"), campaign_summary_sha256=sha("summary.json"),
                original_export_archive_sha256=manifest["archive_sha256"], campaign_id=summary["campaign_id"])}, rows=members)
        member_path = write(self.tmp / "membership.json", membership)
        first = members[0]
        timing = dict(agent_id=first["root_agent_id"], job_id=first["job_id"], task=first["task"], request_id="one",
            ttft_seconds=.1, total_seconds=1.2, source_sha256=first["run_json_sha256"], run_json_sha256=first["run_json_sha256"])
        telemetry = dict(schema="descend-scorecard-telemetry-v1", experiment_id=run.name, scheduled_jobs=4,
            covered_run_count=4, cost_rows=costs, latency_rows=[timing])
        path = write(self.tmp / "telemetry.json", telemetry)
        receipt_path = self.tmp / "producer-receipt.json"
        def build(refresh_receipt=True, receipt_pin=None):
            write(path, telemetry)
            # Isolated consumer fixture; actual extraction is exercised separately.
            if refresh_receipt:
                write(receipt_path, dict(schema="descend-telemetry-producer-v1", experiment_id=run.name,
                    telemetry_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                    membership_sha256=hashlib.sha256(member_path.read_bytes()).hexdigest(),
                    producer_sha256=hashlib.sha256((ROOT / "scripts/cloudbench_telemetry.py").read_bytes()).hexdigest(),
                    replay_owner="fixture-custodian", replayed_at=T0, input_manifest_sha256={"00":sha("export-manifest.json")},
                    inputs=[dict(shard=m["shard"], path=m["run_json_path"], sha256=m["run_json_sha256"]) for m in members]))
            return render(run, self.f, iterations=2, telemetry=path, telemetry_membership=member_path, telemetry_sources=sources,
                          telemetry_receipt=receipt_path, telemetry_receipt_sha256=receipt_pin or hashlib.sha256(receipt_path.read_bytes()).hexdigest())
        data = build()
        self.assertAlmostEqual(data["experiment"]["cost"]["metered_usd"], .17)
        self.assertIn("p50 0.10s", self.valid(data))
        receipt_pin = hashlib.sha256(receipt_path.read_bytes()).hexdigest()
        changed_receipt = json.loads(receipt_path.read_text()); changed_receipt["replay_owner"] = "foreign"
        write(receipt_path, changed_receipt)
        with self.assertRaisesRegex(ValueError, "receipt SHA256"):
            build(refresh_receipt=False, receipt_pin=receipt_pin)
        build()
        for key, val in (("request_id", "NEVER_OBSERVED_REQUEST"), ("ttft_seconds", 999999), ("total_seconds", 1000000)):
            old = timing[key]; timing[key] = val
            with self.assertRaisesRegex(ValueError, "producer receipt"):
                build(refresh_receipt=False)
            timing[key] = old
        build()
        self.assertNotIn("LLM latency UNMEASURED", CARD["render_text"](data))
        for field, value in (("job_id", "FOREIGN_JOB"), ("task", "foreign-task"), ("agent_id", "FOREIGN_AGENT"),
                             ("run_json_sha256", "f" * 64), ("source_sha256", "e" * 64), ("ttft_seconds", True),
                             ("total_seconds", float("nan")), ("total_seconds", -1), ("agent_id", None)):
            with self.subTest(field=field, value=value):
                original = timing[field]; timing[field] = value
                with self.assertRaises(ValueError): build()
                timing[field] = original
        for field, value in (("job_id", "FOREIGN_JOB"), ("task", "foreign-task"), ("run_json_sha256", "f" * 64), ("cost_cents", 123)):
            original = costs[0][field]; costs[0][field] = value
            with self.assertRaises(ValueError): build()
            costs[0][field] = original
        telemetry["latency_rows"].append(copy.deepcopy(timing))
        with self.assertRaises(ValueError): build()
        telemetry["latency_rows"].pop()
        orphan = dict(timing, agent_id=None, request_id="orphan", ttft_seconds=None, total_seconds=None)
        telemetry["latency_rows"].append(orphan)
        data = build()
        self.assertEqual(data["observed_telemetry"]["requests"], 2)
        self.assertEqual(data["observed_telemetry"]["ttft"]["n"], 1)
        # An internally consistent invented member cannot override canonical root identity.
        members[0]["root_agent_id"] = "invented"
        members[0]["allowed_agent_ids"] = ["invented"]
        write(member_path, membership)
        with self.assertRaises(ValueError): build()
        members[0]["root_agent_id"] = timing["agent_id"]
        members[0]["allowed_agent_ids"] = [timing["agent_id"]]
        write(member_path, membership)
        # Original source bytes and proof hashes are checked, not just metadata shape.
        write(sources / "00/summary.json", dict(summary, campaign_id="foreign"))
        with self.assertRaises(ValueError): build()

    def test_native_telemetry_producer_uses_original_events_and_hashes(self):
        import hashlib
        producer = runpy.run_path(str(ROOT / "scripts/cloudbench_telemetry.py"))
        raw_path = self.tmp / "original/run.json"
        start = dict(event="rose.complete.start", agent_id="root", request_id="req", timestamp="2026-10-18T19:00:00Z")
        first = dict(start, event="rose.complete.first_productive_chunk", timestamp="2026-10-18T19:00:02Z", elapsed_s=999)
        end = dict(start, event="rose.complete.foundry.done", timestamp="2026-10-18T19:00:05Z")
        write(raw_path, {"tasks": [{"cost_cents": 17, "logs": {"worker_logs": [json.dumps(start), first, end, end]}}]})
        digest = hashlib.sha256(raw_path.read_bytes()).hexdigest()
        member = dict(job_id="job", task="task", shard="00", run_json_path="original/run.json", run_json_sha256=digest,
                      allowed_agent_ids=["root"], binding_status="verified-scored-run")
        manifest_path = write(self.tmp / "export-manifest.json", {"files": {"original/run.json": {"sha256":digest}}})
        membership_path = write(self.tmp / "native-membership.json", dict(proofs={"00": {"export_manifest_sha256":hashlib.sha256(manifest_path.read_bytes()).hexdigest()}}, schema="descend-scorecard-membership-v1", experiment_id="exp",
                                scheduled_jobs=1, rows=[member]))
        output, receipt = self.tmp / "native.json", self.tmp / "native-receipt.json"
        data, proof = producer["produce"](membership_path, {"00": self.tmp}, output, receipt, "fixture-custodian")
        row = data["latency_rows"][0]
        self.assertEqual((row["ttft_seconds"], row["total_seconds"]), (2, 5))  # actual clocks, not elapsed_s=999
        self.assertEqual(data["cost_rows"][0]["cost_cents"], 17)
        self.assertEqual(proof["telemetry_sha256"], hashlib.sha256(output.read_bytes()).hexdigest())
        self.assertEqual(proof["inputs"][0]["sha256"], digest)
        observations = [(o, digest) for o in (start, first, end)]
        for changed in (dict(first, request_id="foreign"), dict(first, agent_id="other"),
                        dict(first, timestamp="invalid"), dict(first, timestamp="2026-10-18T18:59:00Z"),
                        dict(first, timestamp="2026-10-18T19:00:02")):
            projected = producer["project_events"](member, [(o, digest) for o in (start, changed, end)])
            own = next(r for r in projected if r["request_id"] == "req")
            self.assertIsNone(own["ttft_seconds"])
        changed = producer["project_events"](member, [(o, digest) for o in (start, dict(first, timestamp="2026-10-18T19:00:03Z"), end)])
        self.assertEqual(changed[0]["ttft_seconds"], 3)
        conflicting = producer["project_events"](member, observations + [(dict(first, timestamp="2026-10-18T19:00:03Z"), digest)])
        self.assertIsNone(conflicting[0]["ttft_seconds"])
        self.assertEqual(conflicting[0]["total_seconds"], 5)
        self.assertEqual(len(producer["project_events"](member, observations + observations)), 1)
        raw_path.write_text(raw_path.read_text() + " ")
        with self.assertRaisesRegex(ValueError, "SHA256"):
            producer["produce"](membership_path, {"00": self.tmp}, output, receipt, "fixture-custodian")

    def test_descent_last_ten_and_finish_speed_include_interexperiment_work(self):
        ids = [f"history-{i:02d}" for i in range(1, 13)]
        for i, ident in enumerate(ids, 1):
            LEDGER["record"]("launch", ident, ledger=self.f.ledger, goal=f"cohort-{i % 2}",
                             run_dir=str(self.tmp / ident), triggered_at=T0 + i * 1000)
            if i < 12:
                LEDGER["record"]("end", ident, ledger=self.f.ledger, ended_at=T0 + i * 1000 + 100,
                                 state="ABORTED" if i == 10 else "COMPLETE")
        directory = self.tmp / ids[-1]
        write(directory / "summary.json", {"campaign_id": ids[-1], "status": "running",
              "started_at": "2026-10-18T22:48:52Z", "jobs": [], "total_jobs": 1})
        before = self.f.ledger.read_bytes()
        data = CARD["build"](directory, ledger=self.f.ledger, history_ids=list(reversed(ids)),
                             iterations=8, now=T0 + 13000)
        self.assertEqual([r["id"] for r in data["history"]], list(reversed(ids[-10:])))
        self.assertEqual(data["iteration_speed"]["per_hour"], 3.6)
        self.assertEqual((data["iteration_speed"]["older_number"], data["iteration_speed"]["newer_number"]), (10, 11))
        text = CARD["render_text"](data)
        self.assertTrue(text.startswith("3.60 iter/h"))
        self.assertIn("finish-to-finish #10 → #11", text)
        self.assertIn("LAST 10 EXPERIMENTS", text)
        self.assertIn("T-RUNNING", text)
        self.assertIn("T-31m40s since finish", text)
        document = self.valid(data)
        self.assertLess(document.index('class="iteration-speed"'), document.index('data-section="header"'))
        self.assertEqual(document.count('class="hist"'), 10)
        self.assertIn('data-finished-at=', document)
        generic = CARD["build"](directory, ledger=self.f.ledger, history_ids=ids, now=T0 + 13000)
        self.assertEqual(len(generic["history"]), 3)
        self.assertIsNone(generic["iteration_speed"])
        self.assertNotIn("iter/h", CARD["render_text"](generic))
        self.assertEqual(self.f.ledger.read_bytes(), before)
        write(directory / "summary.json", {"campaign_id": ids[-1], "status": "failed",
              "started_at": "2026-10-18T22:48:52Z", "finished_at": "2026-10-18T22:55:32Z",
              "jobs": [], "total_jobs": 1})
        finished = CARD["build"](directory, ledger=self.f.ledger, history_ids=ids,
                                 iterations=8, now=T0 + 13000)
        self.assertEqual((finished["iteration_speed"]["older_number"],
                          finished["iteration_speed"]["newer_number"]), (11, 12))
        self.assertAlmostEqual(finished["iteration_speed"]["per_hour"], 3600 / 1300)
        self.assertEqual(self.f.ledger.read_bytes(), before)

    def test_descent_public_render_speed_and_finish_age(self):
        run = self.f.fleet()
        LEDGER["record"]("launch", "older", ledger=self.f.ledger, goal="fleet-goal",
                         run_dir=str(self.tmp / "older"), triggered_at=T0 - 3600)
        LEDGER["record"]("end", "older", ledger=self.f.ledger, ended_at=T0 - 1800, state="ABORTED")
        card = render(run, self.f, iterations=1)
        text = CARD["render_text"](card)
        self.assertTrue(text.startswith("1.30 iter/h"))
        self.assertIn("T-44m00s since finish", text)
        self.assertIn("1.30 iter/h", self.valid(card))
        newer = render(run, self.f, iterations=1)
        newer["generated_at"] += 3600
        self.assertIn("T-1h44m since finish", CARD["render_text"](newer))
        self.assertEqual(card["experiment"]["ended_at"], newer["experiment"]["ended_at"])

    def test_public_descent_render_rejects_missing_future_or_nonpositive_interval(self):
        run = self.f.fleet()
        LEDGER["record"]("launch", "older", ledger=self.f.ledger, goal="fleet-goal",
                         run_dir=str(self.tmp / "older"), triggered_at=T0 - 3600)
        LEDGER["record"]("end", "older", ledger=self.f.ledger, ended_at=T0 - 1800, state="COMPLETE")
        entries = LEDGER["read"](self.f.ledger)
        for end in (None, 0, NOW + 1, T0 + 960, T0 + 1000):
            changed = [dict(e, ended_at=end) if e.get("id") == "older" and e.get("event") == "end" else e for e in entries]
            self.f.ledger.write_text("".join(json.dumps(e) + "\n" for e in changed))
            card = render(run, self.f, iterations=1)
            self.assertIsNone(card["iteration_speed"])
            self.assertTrue(CARD["render_text"](card).startswith("UNMEASURED iter/h"))
            self.valid(card)
            if end is None or end == 0 or end > NOW:
                self.assertIn("T-UNRECORDED", CARD["render_text"](card))

    def test_unrecorded_current_finish_cannot_supply_iteration_speed(self):
        run = self.f.fleet()
        other = self.tmp / "unrecorded"
        write(other / "summary.json", {"campaign_id": "unrecorded", "status": "failed", "jobs": [],
              "started_at": "2026-10-18T19:50:00Z", "finished_at": "2026-10-18T20:00:00Z"})
        card = CARD["build"](other, ledger=self.f.ledger, goal="fleet-goal", iterations=1, now=NOW)
        self.assertFalse(card["in_ledger"])
        self.assertIsNone(card["iteration_speed"])
        self.assertIsNone(card["speed_change"])
        self.assertTrue(CARD["render_text"](card).startswith("UNMEASURED iter/h"))
        self.valid(card)

    def test_public_five_finish_speed_change(self):
        for intervals, expected in (([800, 400, 200, 100], 100.0),
                                    ([100, 200, 400, 800], -50.0),
                                    ([400, 400, 400, 400], 0.0)):
            with self.subTest(intervals=intervals):
                self.f.ledger.unlink(missing_ok=True)
                ends = [T0]
                for delta in intervals:
                    ends.append(ends[-1] + delta)
                ids = [f"change-{i}" for i in range(1, 7)]
                for i, ident in enumerate(ids):
                    LEDGER["record"]("launch", ident, ledger=self.f.ledger, goal="change",
                                     run_dir=str(self.tmp / ident), triggered_at=T0 - 10 + i)
                    if i < 5:
                        LEDGER["record"]("end", ident, ledger=self.f.ledger, ended_at=ends[i], state="ABORTED" if i == 2 else "COMPLETE")
                run = self.tmp / ids[-1]
                write(run / "summary.json", {"campaign_id": ids[-1], "status": "running", "jobs": [], "total_jobs": 1})
                before = self.f.ledger.read_bytes()
                card = CARD["build"](run, ledger=self.f.ledger, iterations=5, history_ids=ids, now=T0 + 10000)
                text = CARD["render_text"](card)
                label = f"{expected:+.1f}%" if expected else "0.0%"
                self.assertIn(f"[avg Δ {label} over last 5 runs]", text)
                self.assertAlmostEqual(card["speed_change"]["percent"], expected)
                self.assertEqual(card["speed_change"]["runs"], 5)
                html = self.valid(card)
                self.assertIn('class="ok"' if expected > 0 else 'class="bad"' if expected < 0 else 'class="muted"', html)
                self.assertIn("arithmetic mean of 3 successive", html)
                self.assertEqual(self.f.ledger.read_bytes(), before)
                entries = LEDGER["read"](self.f.ledger)
                for invalid in (None, 0, T0 + 20000):
                    changed = [dict(e, ended_at=invalid) if e.get("id") == ids[2] and e.get("event") == "end" else e for e in entries]
                    self.f.ledger.write_text("".join(json.dumps(e) + "\n" for e in changed))
                    invalid_card = CARD["build"](run, ledger=self.f.ledger, iterations=5, history_ids=ids, now=T0 + 10000)
                    self.assertIsNone(invalid_card["speed_change"]["percent"])
                    self.assertIn("avg Δ UNMEASURED", CARD["render_text"](invalid_card))
                    self.valid(invalid_card)

    def test_captured_eight_experiment_speed_change(self):
        entries = LEDGER["read"](GOLDEN / "rotating-cohort-ledger.jsonl")
        launch_ids = [e["id"] for e in LEDGER["experiments"](entries)[-6:]]
        # Original final It6 receipt and original observer #6->#7 interval.
        end6 = 1793149302.101414
        end7 = end6 + 8028.104736804962
        for e in entries:
            if "run_dir" in e:
                e["run_dir"] = str(self.tmp / e["id"])
        self.f.ledger.write_text("".join(json.dumps(e) + "\n" for e in entries))
        LEDGER["record"]("end", launch_ids[-1], ledger=self.f.ledger, ended_at=end6, state="COMPLETE")
        for i, ident in enumerate(("original600-1793152917121861690", "original600-1793163509958414749"), 7):
            launch_ids.append(ident)
            LEDGER["record"]("launch", ident, ledger=self.f.ledger, goal="new-cohort",
                             run_dir=str(self.tmp / ident), triggered_at=end7 + i)
            if i == 7:
                LEDGER["record"]("end", ident, ledger=self.f.ledger, ended_at=end7, state="INCOMPLETE")
        run = self.tmp / launch_ids[-1]
        write(run / "summary.json", {"campaign_id": launch_ids[-1], "status":"running", "jobs":[]})
        before = self.f.ledger.read_bytes()
        card = CARD["build"](run, ledger=self.f.ledger, history_ids=launch_ids, iterations=7, now=end7+10000)
        self.assertAlmostEqual(card["iteration_speed"]["per_hour"], .448424642929202)
        self.assertEqual(len(card["history"]), 8)
        intervals = [5616.887976646423, 1161.9379551410675, 6614.532918691635, 8028.104736804962]
        rates = [3600 / interval for interval in intervals]
        expected = sum(100*(b/a-1) for a,b in zip(rates,rates[1:]))/3
        self.assertAlmostEqual(card["speed_change"]["percent"], expected)
        self.assertTrue(CARD["render_text"](card).startswith(".45 iter/h [avg Δ"))
        self.assertIn("last 5 runs", self.valid(card))
        self.assertEqual(self.f.ledger.read_bytes(), before)

    def test_speed_change_requires_five_consecutive_valid_finishes(self):
        rows = [{"id":str(i), "number":i, "state":"COMPLETE", "ended_at":1000*i} for i in range(5, 0, -1)]
        self.assertEqual(CARD["average_speed_change"](rows, 10000)["percent"], 0)
        self.assertIsNone(CARD["average_speed_change"](rows[:4], 10000)["percent"])
        for value in (float("nan"), float("inf"), True, -1, 0, None, 6000):
            broken = [dict(r) for r in rows];broken[2]["ended_at"] = value
            self.assertIsNone(CARD["average_speed_change"](broken, 10000)["percent"])
        broken = [dict(r) for r in rows];broken[2]["number"] = None
        self.assertIsNone(CARD["average_speed_change"](broken, 10000)["percent"])
        broken = [dict(r) for r in rows];broken[2]["state"] = "RUNNING"
        self.assertIsNone(CARD["average_speed_change"](broken, 10000)["percent"])

    def test_finish_speed_and_age_do_not_bridge_missing_or_invalid_clocks(self):
        older = {"id": "a", "number": 6, "state": "COMPLETE", "ended_at": 1000}
        newer = {"id": "b", "number": 7, "state": "FAILED", "ended_at": 4600}
        running = {"id": "c", "number": 8, "state": "RUNNING", "ended_at": None}
        speed = CARD["finish_to_finish_speed"]([running, newer, older], 10000, "c")
        self.assertEqual(speed["per_hour"], 1)
        for invalid in (None, 0, -1, True, float("nan"), float("inf"), 11000, 4600, 5000):
            broken = dict(older, ended_at=invalid)
            self.assertIsNone(CARD["finish_to_finish_speed"]([running, newer, broken], 10000, "c"))
        # A missing intervening finish cannot be bridged to the prior good one.
        self.assertIsNone(CARD["finish_to_finish_speed"]([newer, dict(running, number=6), older], 10000))
        self.assertIsNone(CARD["finish_to_finish_speed"]([dict(newer, ended_at=None), older], 10000))
        self.assertIsNone(CARD["finish_to_finish_speed"]([running], 10000))
        self.assertEqual(CARD["finish_age"](older, 4600), "T-1h00m since finish")
        self.assertEqual(CARD["finish_age"](older, 8200), "T-2h00m since finish")
        self.assertEqual(CARD["finish_age"](running, 4600), "T-RUNNING")
        self.assertEqual(CARD["finish_age"](dict(older, ended_at=None), 4600), "T-UNRECORDED")
        self.assertEqual(CARD["finish_age"](dict(older, ended_at=5000), 4600), "T-UNRECORDED")

    def test_finish_age_browser_clock_updates_only_age_text(self):
        script = """const nodes = [{dataset:{finishedAt:'1000'}, textContent:''}];
let clock=4600000, tick;
global.Date={now:()=>clock};
global.document={querySelectorAll:()=>nodes};
global.setInterval=(f,ms)=>{tick=f;if(ms!==1000)throw Error('cadence');};
""" + CARD["FINISH_AGE_SCRIPT"] + """
if(nodes[0].textContent!=='T-1h00m since finish')throw Error('first age');
clock=8200000;tick();
if(nodes[0].textContent!=='T-2h00m since finish')throw Error('live age');
if(nodes[0].dataset.finishedAt!=='1000')throw Error('finish changed');
if(finishAgeLabel(9000,8200)!=='T-UNRECORDED')throw Error('future finish');
"""
        subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)

    def test_explicit_history_scope_preserves_rotating_cohort_continuity(self):
        entries = LEDGER["read"](GOLDEN / "rotating-cohort-ledger.jsonl")
        launches = LEDGER["experiments"](entries)
        ids = [entry["id"] for entry in launches[-6:]]
        for entry in entries:
            if "run_dir" in entry:
                entry["run_dir"] = str(self.tmp / entry["id"])
        self.f.ledger.write_text("".join(json.dumps(entry) + "\n" for entry in entries))
        directory = self.tmp / ids[-1]
        write(directory / "summary.json", {"campaign_id": ids[-1], "jobs": [], "total_jobs": 30,
              "started_at": "2026-10-28T00:05:53Z", "status": "running"})
        old = self.f.ledger.read_bytes()
        default = CARD["build"](directory, ledger=self.f.ledger, iterations=5, now=1793147000)
        self.assertEqual(default["number"], 1, "the original cohort-local scope remains available")
        data = CARD["build"](directory, ledger=self.f.ledger, history_ids=list(reversed(ids)), iterations=5, now=1793147000)
        self.assertEqual(data["number"], 6)
        self.assertEqual(data["rate"]["launches"], 6)
        self.assertEqual([r["id"] for r in data["history"]], list(reversed(ids)))
        self.assertEqual([r["number"] for r in data["history"]], [6, 5, 4, 3, 2, 1])
        self.assertEqual(data["trend"], [], "descent uses global history, not an unused batch trend")
        self.assertEqual(data["rate"]["goal_started_at"], launches[-6]["triggered_at"])
        self.assertEqual(self.f.ledger.read_bytes(), old, "scope selection never rewrites the original ledger")
        for invalid in (ids + ["missing"], ids[:-1], ids + [ids[0]]):
            with self.assertRaises(ValueError):
                CARD["build"](directory, ledger=self.f.ledger, history_ids=invalid, now=1793147000)
        command = [sys.executable, str(ROOT / "scripts/cloudbench-scorecard.py"), str(directory),
                   "--ledger", str(self.f.ledger), "--json", "--iterations", "5", "--now", "1793147000"]
        for ident in reversed(ids):
            command += ["--history-id", ident]
        result = subprocess.run(command, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)["number"], 6)
        self.assertEqual(self.f.ledger.read_bytes(), old)

    def test_provider_prompt_cache_share_requires_complete_denominator(self):
        capture = json.loads((GOLDEN / "provider-prompt-cache.json").read_text())
        recorded = task("task-1", "passed")
        recorded.update(prompt_cache_read_input_tokens=capture["legacy_read"],
                        prompt_cache_creation_input_tokens=capture["legacy_write"],
                        prompt_cache_uncached_input_tokens=capture["prompt_uncached"])
        report = card("r1", [recorded])
        report["cost"]["fast_cache_hit_rate"] = 1.0
        row = CARD["compact_rows"]({"jobs": [job(1, "passed", "PASSED", False, run_id="r1")]}, {"r1": report})[0]
        self.assertAlmostEqual(row["cache_hit"], 213760 / 231563)
        for invalid in (None, -1, True, float("nan"), float("inf")):
            recorded["prompt_cache_uncached_input_tokens"] = invalid
            self.assertIsNone(CARD["compact_rows"]({"jobs": [job(1, "passed", "PASSED", False, run_id="r1")]},
                                                   {"r1": report})[0]["cache_hit"])
        for key in list(recorded):
            if key.startswith("prompt_cache_"):
                recorded.pop(key)
        self.assertIsNone(CARD["compact_rows"]({"jobs": [job(1, "passed", "PASSED", False, run_id="r1")]},
                                               {"r1": report})[0]["cache_hit"], "legacy ratio is not a complete denominator")

    def test_preallocation_controller_cancellation_receipts(self):
        capture = json.loads((GOLDEN / "preallocation-campaign-receipts.json").read_text())
        root = self.tmp / "workspace"
        directory = root / ".context/benchmarks/campaigns" / capture["summary"]["campaign_id"]
        summary = dict(capture["summary"], jobs=[])
        fleets = []
        for record in capture["records"]:
            job_record = dict(record["job"])
            fleet = root / ".context/fleet/runs" / record["card"]["run_id"]
            fleets.append(fleet)
            job_record["fleet_dir"] = str(fleet)
            summary["jobs"].append(job_record)
            write(fleet / "_batch/report-card.json", record["card"])
            write(fleet / "_batch/lifecycle.json", dict(record["lifecycle"], workspace_root=str(root)))
            write(fleet / "teardown-ownership/meta", record["meta"].replace("/home/boxes/rose", str(root)))
            write(fleet / "teardown-ownership/provider-teardown-verified.epoch", record["release_epoch"])
        write(directory / "summary.json", summary)
        exp = CARD["load"](directory)
        self.assertEqual(exp["infra_unattributed_cancelled"], 1, "27 matching controller TERM receipts prove induced cancellations")
        self.assertEqual(exp["infra_confirmed_jobs"], 2, "only the original latched breach certifies these infra jobs")
        self.assertEqual(exp["outcomes"]["CANCELLED"], 28)
        self.assertEqual(exp["scored"], 0)
        self.assertIsNone(exp["infra_jobs"], "the third refusal has no typed pre-cancel failure receipt")
        self.assertIsNone(exp["source_ref"], "prelaunch checkout is not executed-source provenance")
        self.assertEqual(exp["released"], {"yes": 30, "of": 30})
        self.assertEqual(exp["lifecycle_verified"], {"yes": 0, "of": 30}, "failed full lifecycle stays failed")
        self.assertEqual(exp["ended_at"], CARD["epoch_of"](summary["finished_at"]))
        # A foreign lifecycle cannot lend its exit status to the scheduled job.
        lifecycle = dict(capture["records"][0]["lifecycle"], workspace_root=str(root), run_id="foreign")
        write(fleets[0] / "_batch/lifecycle.json", lifecycle)
        invalid = CARD["load"](directory)
        self.assertEqual(invalid["infra_unattributed_cancelled"], 2)
        self.assertEqual(invalid["released"], {"yes": 29, "of": 30})
        # Matching failure exit 1 alone never proves a pre-cancellation cause.
        lifecycle["run_id"] = fleets[0].name
        lifecycle["controller_exit_code"] = 1
        write(fleets[0] / "_batch/lifecycle.json", lifecycle)
        self.assertEqual(CARD["load"](directory)["infra_unattributed_cancelled"], 2)

    def test_cancelled_campaign_keeps_started_lifecycles_and_infra_uncertainty(self):
        capture = json.loads((GOLDEN / "cancelled-campaign-receipts.json").read_text())
        root = self.tmp / "workspace"
        directory = root / ".context/benchmarks/campaigns" / capture["summary"]["campaign_id"]
        summary = dict(capture["summary"], jobs=[])
        for record in capture["records"]:
            job_record = dict(record["job"])
            fleet = root / ".context/fleet/runs" / record["card"]["run_id"]
            job_record["log"] = str(directory / Path(job_record["log"]).name)
            write(Path(job_record["log"]), f"{root}/scripts/run-bench monitor {fleet}\n")
            summary["jobs"].append(job_record)
            write(fleet / "_batch/report-card.json", record["card"])
            write(fleet / "_batch/lifecycle.json", dict(record["lifecycle"], workspace_root=str(root)))
            for name in ("meta", "provider-teardown-verified.epoch"):
                if name in record:
                    write(fleet / "teardown-ownership" / name, record[name].replace("/home/boxes/rose", str(root)))
        write(directory / "summary.json", summary)
        exp = CARD["load"](directory)
        self.assertEqual(exp["terminal_attempts"], 20, "empty attempts does not mean an exited controller never started")
        self.assertEqual((exp["scored"], exp["outcomes"]["CANCELLED"]), (0, 20))
        self.assertEqual(exp["released"], {"yes": 1, "of": 20}, "one provider seal is independent of failed execution")
        self.assertEqual(exp["lifecycle_verified"], {"yes": 0, "of": 20})
        self.assertIsNone(exp["infra_jobs"], "post-cancel INFRA_ERROR is not qualified pre-cancel evidence")
        self.assertIsNone(exp["infra_attempts"])
        self.assertEqual(exp["infra_unattributed_cancelled"], 20)
        self.assertEqual(CARD["_infra_text"](exp)[0], "UNCLASSIFIED")
        self.assertEqual(exp["ended_at"], CARD["epoch_of"](summary["finished_at"]))
        self.assertTrue(any("cancel" in i["text"].lower() for i in CARD["_issues"](exp)))
        rendered = CARD["build"](directory, ledger=self.f.ledger,
                                 now=CARD["epoch_of"](summary["finished_at"]) + 60)
        self.assertIn("INFRA UNCLASSIFIED", CARD["render_text"](rendered))
        self.assertIn("■ INFRA UNCLASSIFIED", self.valid(rendered))
        for record in capture["records"]:
            write(root / ".context/fleet/runs" / record["card"]["run_id"] / record["job"]["task"]
                  / "benchmark-child.finished", record["child_exit"])
        native = CARD["load"](directory)
        self.assertEqual((native["infra_jobs"], native["infra_attempts"]), (1, 1))
        self.assertEqual((native["outcomes"]["INFRA"], native["outcomes"]["CANCELLED"]), (1, 19))
        self.assertEqual(native["terminal_attempts"], 20)
        self.assertEqual(native["infra_unattributed_cancelled"], 0)
        self.assertTrue(native["infra_breached"])
        self.assertEqual(native["reasons"], [["INFRA", "Native child exit 125; no current run artifact produced", 1]])
        for record in capture["records"]:
            (root / ".context/fleet/runs" / record["card"]["run_id"] / record["job"]["task"]
             / "benchmark-child.finished").unlink()
        # A canonical pre-cancellation breach receipt retains the authentic job;
        # a generic post-TERM INFRA_ERROR alone cannot provide this distinction.
        summary["infra_stop"] = {"infra_jobs": 1, "scheduled_total": 20,
                                 "infra_job_ids": ["r002-j0017"]}
        write(directory / "summary.json", summary)
        with_stop = CARD["load"](directory)
        self.assertEqual(with_stop["infra_confirmed_jobs"], 1)
        self.assertTrue(with_stop["infra_breached"])
        self.assertEqual(with_stop["infra_unattributed_cancelled"], 19)
        self.assertEqual(with_stop["outcomes"]["CANCELLED"], 19)
        summary["infra_stop"]["scheduled_total"] = 600
        write(directory / "summary.json", summary)
        self.assertEqual(CARD["load"](directory)["infra_confirmed_jobs"], 0, "foreign cohort receipt cannot certify a failure")
        # A never-dispatched queued cancellation still owns no resource/attempt.
        pending = {"status": "cancelled", "attempts": 0, "started_at": None}
        self.assertFalse(CARD["started_terminal"](pending))

    def test_fleet_golden_and_html(self):
        data = render(self.f.fleet(), self.f)
        self.golden("fleet", CARD["render_text"](data))
        document = self.valid(data)
        self.assertIn("🧪 Experiment #1", document)
        self.assertEqual(data["experiment"]["state"], "COMPLETE")
        self.assertEqual(data["experiment"]["ended_at"], T0 + 960, "end comes from the producer teardown epoch")

    def test_campaign_golden_progress_and_retry_attempts(self):
        data = render(self.f.campaign(), self.f)
        self.golden("campaign", CARD["render_text"](data))
        exp = data["experiment"]
        self.assertEqual(exp["progress"], {"queued": 1, "in_progress": 1, "completed": 3, "unobserved": 0})
        self.assertEqual((exp["terminal_attempts"], exp["infra_attempts"], exp["infra_jobs"]), (4, 2, 1),
                         "retained retry attempts stay in the infra denominator; the job counts once")
        self.assertEqual(exp["state"], "RUNNING")
        self.assertEqual(exp["reasons"][0][1], "Expected tool 'spawn_browser_agent' not found in messages")
        self.valid(data)

    def test_campaign_monitor_receipts(self):
        captured = json.loads((GOLDEN / "campaign-receipts.json").read_text())
        root = self.tmp / "workspace"
        directory = root / ".context/benchmarks/campaigns" / captured["summary"]["campaign_id"]
        summary = dict(captured["summary"], total_jobs=2, task_count=2, runs=1, jobs=[])
        fleets = []
        for item in captured["jobs"]:
            entry = dict(item["job"])
            fleet = root / ".context/fleet/runs" / item["card"]["run_id"]
            fleets.append(fleet)
            entry["log"] = str(directory / Path(entry["log"]).name)
            write(Path(entry["log"]), f"    {root}/scripts/run-bench monitor {fleet}\n"
                  f"    {root}/scripts/run-bench monitor {root}/.context/fleet/runs/nested-canary\n")
            write(fleet / "_batch/report-card.json", item["card"])
            lifecycle = dict(item["lifecycle"], workspace_root=str(root))
            write(fleet / "_batch/lifecycle.json", lifecycle)
            write(fleet / "teardown-ownership/meta", item["meta"].replace("/home/boxes/rose", str(root)))
            write(fleet / "teardown-ownership/provider-teardown-verified.epoch", item["released_epoch"])
            summary["jobs"].append(entry)
        write(directory / "summary.json", summary)
        before = (directory / "summary.json").read_bytes()
        exp = CARD["load"](directory)
        self.assertEqual(exp["source_ref"], captured["provenance"]["source"])
        self.assertEqual((exp["outcomes"]["PASS"], exp["outcomes"]["AGENT FAIL"], exp["outcomes"]["INFRA"]), (1, 1, 0))
        self.assertEqual(exp["reasons"][0][1], CARD["reason_key"](captured["jobs"][0]["card"]["per_task"][0]["failure_reason"]))
        self.assertEqual(exp["lifecycle_verified"], {"yes": 2, "of": 2})
        self.assertEqual(exp["released"], {"yes": 2, "of": 2})
        self.assertEqual(exp["ended_at"], CARD["epoch_of"](summary["finished_at"]))
        self.assertEqual((directory / "summary.json").read_bytes(), before)
        relocated = write(self.tmp / "custom-campaign-root/summary.json", summary).parent
        self.assertEqual(CARD["load"](relocated)["lifecycle_verified"], {"yes": 2, "of": 2})
        mixed = json.loads((fleets[1] / "_batch/report-card.json").read_text())
        mixed["execution_provenance"]["base_sha"] = "a" * 40
        write(fleets[1] / "_batch/report-card.json", mixed)
        self.assertIsNone(CARD["load"](directory)["source_ref"], "mixed sources must remain explicit")
        write(fleets[1] / "_batch/report-card.json", captured["jobs"][1]["card"])
        for invalid in ("nan", "inf", "-1", "unrecorded"):
            write(fleets[0] / "teardown-ownership/provider-teardown-verified.epoch", invalid)
            self.assertEqual(CARD["load"](directory)["released"], {"yes": 1, "of": 2})
        write(fleets[0] / "teardown-ownership/provider-teardown-verified.epoch", captured["jobs"][0]["released_epoch"])
        # Retry-mode summaries carry the same handle explicitly; no log needed.
        for entry, fleet in zip(summary["jobs"], fleets):
            entry["fleet_dir"] = str(fleet)
            entry["run_id"] = fleet.name
            Path(entry["log"]).unlink()
        write(directory / "summary.json", summary)
        self.assertEqual(CARD["load"](directory)["lifecycle_verified"], {"yes": 2, "of": 2})
        # A different run's seal and a missing seal cannot certify this job.
        lifecycle["run_id"] = "different-run"
        write(fleets[1] / "_batch/lifecycle.json", lifecycle)
        (fleets[0] / "teardown-ownership/provider-teardown-verified.epoch").unlink()
        exp = CARD["load"](directory)
        self.assertEqual(exp["lifecycle_verified"], {"yes": 0, "of": 2})
        self.assertEqual(exp["released"], {"yes": 0, "of": 2})
        # Binding a log to a different task must not borrow its reason or source.
        wrong = dict(captured["jobs"][0]["card"])
        wrong["per_task"] = [task("unrelated", "failed", reason="unrelated failure")]
        write(fleets[0] / "_batch/report-card.json", wrong)
        exp = CARD["load"](directory)
        self.assertIsNone(exp["source_ref"], "partial source coverage is not campaign provenance")
        self.assertIn(["AGENT FAIL", "reason UNRECORDED", 1], exp["reasons"])

    def test_sharded_golden_audit_and_history(self):
        data = render(self.f.sharded(), self.f)
        self.golden("sharded", CARD["render_text"](data))
        exp = data["experiment"]
        self.assertEqual(data["number"], 2)
        self.assertEqual(exp["outcomes"]["PASS"], 2, "an evaluated card verdict survives a later release failure")
        released = next(i for i in exp["lifecycle"] if i["label"].startswith("Guests released"))
        self.assertEqual((released["state"], released["label"]), ("ok", "Guests released (native audit)"))
        self.assertEqual([h["label"] for h in data["history"]], ["polar4", "run600c"])
        self.assertEqual(data["history"][1]["outcomes"]["INFRA"], 14)
        self.valid(data)

    def test_success_rate_trend_after_four_experiments(self):
        data = render(self.f.sharded(), self.f)
        data["trend"] = [
            {"number": 1, "rate": .25, "running": False},
            {"number": 2, "rate": None, "running": False},
            {"number": 3, "rate": .75, "running": False},
            {"number": 4, "rate": 1.0, "running": True},
        ]
        document = self.valid(data)
        self.assertIn("SUCCESS RATE OVER TIME", document)
        self.assertIn("Experiment #4: 100.0%", document)
        self.assertIn('class="dot running"', document)
        self.assertEqual(document.count('class="path"'), 1, "unscored experiment breaks the line")
        fallback = CARD["render_text"](data)
        self.assertIn("#2 gap", fallback)
        self.assertIn("#4 100.0% (running)", fallback)
        data["trend"] = data["trend"][:3]
        self.assertNotIn("SUCCESS RATE OVER TIME", self.valid(data))

    def test_descent_iteration_count_controls_trend_threshold(self):
        run = self.f.fleet()
        sparse = render(run, self.f, iterations=4)
        self.assertEqual(sparse["trend"], [], "descent does not load an unused batch trend")
        self.assertIn("SUCCESS RATE OVER TIME", self.valid(sparse))
        self.assertIn("SUCCESS RATE OVER TIME", CARD["render_text"](sparse))
        for number in range(2, 5):
            run_id = f"historical-{number}"
            LEDGER["record"]("launch", run_id, ledger=self.f.ledger, goal="fleet-goal",
                             slice=run_id, kind="fleet", run_dir=str(self.tmp / run_id),
                             triggered_at=T0 + number * 10, scheduled_total=2)
            LEDGER["record"]("end", run_id, ledger=self.f.ledger, goal="fleet-goal",
                             ended_at=T0 + number * 10 + 5, state="COMPLETE",
                             outcome={"task_status": {"PASSED": number % 3, "FAILED": 2 - number % 3}})
        self.assertEqual(render(run, self.f, iterations=3)["trend"], [], "two launches may share one iteration")
        card = render(run, self.f, iterations=4)
        self.assertEqual(card["trend"], [])
        self.assertEqual(len(card["history"]), 4)
        self.assertIn("SUCCESS RATE OVER TIME", self.valid(card))

    def test_native_audit_presence_and_absence(self):
        admission = self.f.sharded(audit=False)
        no_audit = render(admission, self.f)["experiment"]
        item = next(i for i in no_audit["lifecycle"] if i["label"].startswith("Guests released"))
        self.assertEqual((item["state"], item["label"]), ("warn", "Guests released"))
        write(admission / "native-release-audit.json", AUDIT["audit"](
            [{"id": "0123456789abcd", "name": "cloudbench-a", "state": "stopped"}], app="app",
            guest_names={"cloudbench-a"}, guest_ids={"0123456789abcd"}, controllers=set(), exports=2, now=T0 + 2100))
        present = render(admission, self.f)["experiment"]
        item = next(i for i in present["lifecycle"] if i["label"].startswith("Guests released"))
        self.assertEqual(item["state"], "fail")
        self.assertIn("cloudbench-a", item["detail"])

    def test_native_audit_retained_owner_without_guest_names_is_not_hidden(self):
        admission = self.f.sharded(audit=False)
        write(admission / "native-release-audit.json", AUDIT["audit"](
            [], app="app", guest_names=set(), guest_ids=set(), controllers=set(), exports=2, now=T0 + 2100,
            retained_owners=["0123456789abcdef0123"]))
        item = next(i for i in render(admission, self.f)["experiment"]["lifecycle"] if i["label"].startswith("Guests released"))
        self.assertEqual((item["state"], item["label"]), ("fail", "Guests released (native audit)"))
        self.assertIn("retained owners: 0123456789ab", item["detail"])

    def test_native_audit_fails_closed_without_identities_or_every_shard_export(self):
        unchecked = AUDIT["audit"]([], app="app", guest_names=set(), guest_ids=set(), controllers=set(), exports=0, now=T0)
        self.assertFalse(unchecked["released"], "an audit that checked no identity never certifies release")
        partial = AUDIT["audit"]([], app="app", guest_names={"cloudbench-a"}, guest_ids=set(), controllers=set(),
                                 exports=1, shards=2, now=T0)
        self.assertFalse(partial["released"], "a shard without its verified export never certifies release")
        self.assertTrue(AUDIT["audit"]([], app="app", guest_names={"cloudbench-a"}, guest_ids=set(), controllers=set(),
                                       exports=2, shards=2, now=T0)["released"])
        admission = self.f.sharded(audit=False)
        (admission / "shard-01/run/export/disposable-export.verified.json").unlink()

        class Api:
            def api(self, method, path, timeout):
                return []
        result = AUDIT["run"](admission, Api(), "app")
        self.assertEqual((result["present"], result["released"], result["checked"]["expected_shards"]), ([], False, 2))
        write(admission / "native-release-audit.json", AUDIT["audit"](
            [], app="app", guest_names={"cloudbench-a"}, guest_ids=set(), controllers=set(), exports=1, shards=2,
            now=T0 + 2100))
        item = next(i for i in render(admission, self.f)["experiment"]["lifecycle"] if i["label"].startswith("Guests released"))
        self.assertNotEqual(item["state"], "ok", "an incomplete native audit renders no verified release")

    def controllers_released(self, admission):
        return next(i for i in render(admission, self.f)["experiment"]["lifecycle"] if i["label"] == "Controllers released")

    def test_canonical_release_receipts_count_controllers_released(self):
        admission = self.f.barrier_abort()
        item = self.controllers_released(admission)
        self.assertEqual(item["state"], "ok", item)
        self.assertTrue(item["detail"].startswith("3/3 "), item)
        self.assertIn("pending_destroy", item["detail"])
        export = admission / "shard-01/run/export"
        bad = {"machine_deleted": False}, {"volume_disposition": "attached"}, {"machine_id": "abcdefabcdef01"}, {"volume_id": "vol_other"}
        for change in bad:
            receipt = json.loads((export / "disposable-controller.release.json").read_text())
            original = dict(receipt)
            write(export / "disposable-controller.release.json", dict(receipt, **change))
            item = self.controllers_released(admission)
            self.assertEqual((item["state"], item["detail"][:4]), ("pending", "2/3 "), f"{change} must not certify release")
            write(export / "disposable-controller.release.json", original)
        (export / "disposable-controller.ownership.json").unlink()
        self.assertTrue(self.controllers_released(admission)["detail"].startswith("2/3 "),
                        "a receipt without the exact controller ownership record certifies nothing")

    def test_runner_pre_supervisor_release_terminal_counts_controllers_released(self):
        # The runner now ends a startup that never published a supervisor with its own terminal.
        admission = self.f.barrier_abort()
        for shard in ("00", "01", "02"):
            write(admission / f"shard-{shard}/run/terminal.json",
                  {"status": "FAILED_BEFORE_SUPERVISOR_RELEASED", "supervisor_state": "NOT_PUBLISHED", "gate_exit_code": 1,
                   "release": {"machine_deleted": True, "volume_disposition": "pending_destroy"}, "benchmark_success_inferred": False})
        item = self.controllers_released(admission)
        self.assertEqual((item["state"], item["detail"][:4]), ("ok", "3/3 "), item)
        self.assertIn("FAILED_BEFORE_SUPERVISOR_RELEASED", item["detail"])

    def test_barrier_abort_before_release_renders_never_started_queue(self):
        admission = self.f.barrier_abort()
        data = render(admission, self.f)
        exp = data["experiment"]
        self.assertEqual(exp["progress"], {"queued": 70, "in_progress": 0, "completed": 0, "unobserved": 0})
        self.assertTrue(exp["never_started"])
        text = CARD["render_text"](data)
        self.assertIn("QUEUED 70 · IN_PROGRESS 0 · COMPLETED 0/70 · never started", text)
        self.assertNotIn("QUEUED / IN_PROGRESS / COMPLETED UNMEASURED", text)
        self.assertIn("never started", self.valid(data))
        # Any evidence that the barrier could have released keeps the queue UNMEASURED.
        write(admission / "shard-02/run/global-release.json", {"release_id": "354e4f818c1ed72f00480145"})
        self.assertIsNone(render(admission, self.f)["experiment"]["progress"])
        (admission / "shard-02/run/global-release.json").unlink()
        (admission / "shard-02/run/global-abort.json").unlink()
        self.assertIsNone(render(admission, self.f)["experiment"]["progress"], "undelivered abort is not proof")

    def test_experiments_per_day_warms_until_one_day_of_goal_history(self):
        admission = self.f.barrier_abort()
        text = CARD["render_text"](render(admission, self.f))
        self.assertIn("experiments/day warming 1h00m · 1 launch (rate after 1 d)", text)
        self.assertNotIn("24.0 experiments/day", text)
        self.assertIn("experiments/day warming 1h00m", self.valid(render(admission, self.f)))
        later = CARD["build"](admission, ledger=self.f.ledger, now=T0 + 2 * 86400)
        self.assertIn("0.5 experiments/day · 1 launch / 2.00 d", CARD["render_text"](later))

    def test_unpublished_hub_group_names_its_receipt(self):
        admission = self.f.sharded()
        result = json.loads((admission / "result.json").read_text())
        reason = ("HubVisibilityError: benchmark Hub upload failed: HTTP Error 400; "
                  'response_metadata={"status": 400, "x_request_id": "683e826b152f"}')
        write(admission / "result.json", {**result, "hub_group_final_published": False,
                                          "hub_group_final_error": reason})
        item = next(i for i in render(admission, self.f)["experiment"]["lifecycle"]
                    if i["label"] == "Hub group publication")
        self.assertEqual(item["state"], "warn")
        self.assertEqual(item["detail"], "final group NOT published: " + reason[:160])

    def mixed_shard_fixture(self):
        admission = self.f.sharded(live=True)
        coordination = json.loads((admission / "coordination.json").read_text())
        coordination["scheduled_total"] = 40
        write(admission / "coordination.json", coordination)
        rows = [job(i, "passed" if i <= 18 else "failed", "PASSED" if i <= 18 else "FAILED", False)
                for i in range(1, 21)]
        export = admission / "shard-00/run/export"
        write(export / "disposable-export.verified.json", {})
        with tarfile.open(export / "originals.tar.gz", "w:gz") as stream:
            raw = json.dumps({"jobs": rows}).encode()
            info = tarfile.TarInfo("context/benchmarks/campaigns/campaign-it7-shard00/summary.json")
            info.size = len(raw)
            stream.addfile(info, io.BytesIO(raw))
        # Stale counters for the exported shard must not be counted or supply reasons.
        write(admission / "shard-00/run/shard-status.json", {"state": "LIVE", "infra": {"progress": {
            "combos": [["failed", "INFRA_ERROR", True, 20]], "reasons": [["INFRA", "stale", 20]]}}})
        write(admission / "shard-01/run/shard-status.json", {"state": "LIVE", "infra": {"progress": {
            "combos": [["passed", "PASSED", False, 17], ["failed", "FAILED", False, 1],
                       ["failed", "INFRA_ERROR", True, 1], ["running", None, None, 1]],
            "jobs": 20, "terminal_attempts": 19, "infra_attempts": 1,
            "reasons": [["INFRA", "seed failed", 1]]}}})
        return admission, rows

    def test_mixed_verified_export_and_live_shard_keep_all_scheduled_jobs(self):
        admission, _ = self.mixed_shard_fixture()
        data = render(admission, self.f)
        exp = data["experiment"]
        self.assertEqual(exp["progress"], {"queued": 0, "in_progress": 1, "completed": 39, "unobserved": 0})
        self.assertEqual(exp["scheduled_total"], 40)
        self.assertEqual((exp["outcomes"]["PASS"], exp["outcomes"]["AGENT FAIL"], exp["outcomes"]["INFRA"]), (35, 3, 1))
        self.assertEqual((exp["infra_jobs"], exp["infra_threshold"], exp["infra_breached"]), (1, 2, False))
        self.assertEqual((exp["terminal_attempts"], exp["infra_attempts"]), (39, 1))
        self.assertEqual(exp["state"], "RUNNING")
        self.assertEqual(exp["rows_source"], "verified controller exports + live shard-status counters")
        self.assertIn(["INFRA", "seed failed", 1], exp["reasons"])
        self.assertFalse(any("stale" in reason for _, reason, _ in exp["reasons"]))
        self.assertEqual(exp["released"], {"yes": 20, "of": 39})
        self.assertEqual(exp["lifecycle_verified"], {"yes": 20, "of": 39})
        self.assertEqual(exp["wall"]["n"], 20)
        self.assertIsNone(exp["cost"]["metered_usd"])
        self.assertIn("COMPLETED 39/40", CARD["render_text"](data))
        document = self.valid(data)
        self.assertIn("35/38 scored", document)
        self.assertIn("39/40", document)
        self.assertIn("verified controller exports + live shard-status counters", document)

    def test_mixed_shards_without_status_remain_unobserved(self):
        admission, _ = self.mixed_shard_fixture()
        (admission / "shard-01/run/shard-status.json").unlink()
        exp = CARD["load"](admission)
        self.assertEqual(exp["progress"], {"queued": 0, "in_progress": 0, "completed": 20, "unobserved": 20})
        self.assertEqual(exp["outcomes"]["PASS"], 18)
        self.assertEqual(exp["rows_source"], "verified controller exports")
        self.assertEqual(exp["state"], "RUNNING")

    def test_exported_empty_summary_does_not_revive_its_stale_counters(self):
        admission, _ = self.mixed_shard_fixture()
        (admission / "shard-01/run/shard-status.json").unlink()
        archive = admission / "shard-00/run/export/originals.tar.gz"
        with tarfile.open(archive, "w:gz") as stream:
            raw = json.dumps({"jobs": []}).encode()
            info = tarfile.TarInfo("context/benchmarks/campaigns/campaign-empty/summary.json")
            info.size = len(raw)
            stream.addfile(info, io.BytesIO(raw))
        exp = CARD["load"](admission)
        self.assertEqual(exp["scheduled_total"], 40)
        self.assertIsNone(exp["outcomes"])
        self.assertIsNone(exp["progress"])
        self.assertEqual(exp["reasons"], [])
        self.assertEqual(exp["state"], "RUNNING")

    def test_result_rows_still_override_export_and_live_counters(self):
        admission, exported = self.mixed_shard_fixture()
        final = exported + [job(i, "passed", "PASSED", False) for i in range(21, 41)]
        write(admission / "result.json", {"jobs": CARD["compact_rows"]({"jobs": final})})
        exp = CARD["load"](admission)
        self.assertEqual(exp["rows_source"], "result.json")
        self.assertEqual(exp["progress"]["completed"], 40)
        self.assertEqual(exp["outcomes"]["PASS"], 38)
        self.assertEqual(exp["outcomes"]["INFRA"], 0)
        self.assertEqual(exp["reasons"], [["AGENT FAIL", "reason UNRECORDED", 2]])

    def test_sharded_live_counters_render_running(self):
        data = render(self.f.sharded(live=True), self.f)
        exp = data["experiment"]
        self.assertEqual(exp["state"], "RUNNING")
        self.assertEqual(exp["rows_source"], "live shard-status counters")
        self.assertEqual(exp["progress"], {"queued": 0, "in_progress": 2, "completed": 2, "unobserved": 0})
        self.assertEqual(exp["reasons"], [["AGENT FAIL", "Timeout after 480s (wall-clock backstop=480s)", 1]])
        self.assertEqual(data["since"], {"state": "RUNNING"})
        document = self.valid(data)
        self.assertIn("RUNNING", document)

    def test_sharded_unknown_counters_without_ids_preserve_outcomes_and_clocks(self):
        # Archived pre-barrier failures have counts but no per-job identities/results.
        admission = self.f.sharded(result=False, audit=False, live=True)
        coordination = json.loads((admission / "coordination.json").read_text())
        coordination.update(scheduled_total=40, released_at=None, aborted_at=T0 + 2000,
                            abort_reason="shards failed before global release")
        write(admission / "coordination.json", coordination)
        for index in (0, 1):
            write(admission / f"shard-{index:02d}/run/shard-status.json", {
                "state": "JOINED", "infra": {"progress": {"combos": [["failed", None, None, 20]],
                "jobs": 20, "terminal_attempts": 20, "infra_attempts": 0, "reasons": []}}})
        data = render(admission, self.f)
        exp = data["experiment"]
        self.assertEqual(exp["rows_source"], "live shard-status counters")
        self.assertEqual(exp["unknown_jobs"], [None] * 6)
        self.assertEqual(exp["outcomes"], {category: 40 if category == "UNKNOWN" else 0
                                          for category in CARD["CATEGORIES"]})
        self.assertEqual(exp["progress"], {"queued": 0, "in_progress": 0, "completed": 40, "unobserved": 0})
        self.assertEqual((exp["state"], exp["triggered_at"], exp["released_at"], exp["ended_at"]),
                         ("ABORTED", T0, None, None))
        self.assertIsNone(exp["wall"])
        self.assertIsNone(exp["exec"])
        self.assertIsNone(exp["cost"]["metered_usd"])
        for output in (CARD["render_text"](data), self.valid(data)):
            self.assertIn("No recorded task result: " + ", ".join(["job ID UNRECORDED"] * 6) + ".", output)

    def test_missing_ids_in_unknown_and_unreleased_rows_render_without_changing_names(self):
        admission = self.f.sharded(audit=False)
        for verdict in (None, "PASSED"):
            with self.subTest(verdict=verdict):
                rows = [{"status": "failed", "task_status": verdict, "released": False, **identity}
                        for identity in ({"task": "recorded-task"}, {"job_id": "recorded-job"},
                                         {}, {"task": "", "job_id": None})]
                write(admission / "result.json", {"jobs": rows})
                data = render(admission, self.f)
                exp = data["experiment"]
                self.assertEqual(exp["unreleased_jobs"], ["recorded-task", "recorded-job", None, None])
                labels = "recorded-task, recorded-job, job ID UNRECORDED, job ID UNRECORDED."
                for output in (CARD["render_text"](data), self.valid(data)):
                    self.assertIn("Release unverified: " + labels, output)
                    if verdict is None:
                        self.assertIn("No recorded task result: " + labels, output)
                self.assertEqual(exp["outcomes"]["UNKNOWN" if verdict is None else "PASS"], 4)

    def test_missing_data_renders_explicit_states(self):
        empty = self.tmp / "empty"
        empty.mkdir()
        data = CARD["build"](empty, ledger=self.tmp / "none.jsonl", now=NOW)
        text = CARD["render_text"](data)
        for state in ("UNRECORDED", "UNMEASURED", "UNMETERED", "experiments/day UNRECORDED (no ledger launch)"):
            self.assertIn(state, text)
        self.valid(data)
        run = self.tmp / "20261018-192852-1"
        write(run / "_batch/report-card.json", card(run.name, [task("alpha", "running", stage="running", cost=None, duration=None)], cost=False))
        data = CARD["build"](run, ledger=self.tmp / "none.jsonl", now=NOW)
        exp = data["experiment"]
        self.assertEqual((exp["state"], exp["terminal_attempts"], exp["cost"]["metered_usd"]), ("RUNNING", 0, None))
        document = self.valid(data)
        self.assertIn("NO TERMINAL ATTEMPTS", document)
        self.assertIsNone(CARD["SENTINEL"].search(" ".join(re.sub(r"<script.*?</script>|<style.*?</style>|<[^>]+>", " ", document, flags=re.S).split())))

    def test_fleet_startup_card_lists_starting_tasks(self):
        run = self.tmp / "20261018-192852-2"
        starting = [{"name": n, "status": "starting", "phase": "verifying environment"} for n in ("alpha", "beta")]
        write(run / "_batch/report-card.json", {"run_id": run.name, "timestamp": "2026-10-18T19:28:52+00:00",
                                               "status": "starting", "phase": "verifying environment",
                                               "summary": {"total": 2, "passed": 0, "failed": 0},
                                               "tasks": starting, "per_task": starting})
        data = CARD["build"](run, ledger=self.tmp / "none.jsonl", now=NOW)
        self.assertEqual((data["experiment"]["scheduled_total"], data["experiment"]["state"]), (2, "RUNNING"))
        self.valid(data)

    def test_local_terminal_tasks_use_local_cleanup_receipts(self):
        run = self.tmp / "1792604578-local-1"
        write(run / "report-card.json", {
            "run_id": "local-1", "tasks": {"total": 2},
            "per_task": [task("alpha", "passed", stage="released"),
                         task("beta", "failed", reason="Timeout after 300s", stage="running")],
        })
        write(run / "run.json", {"run_id": "local-1", "summary": {"passed": 1, "failed": 1,
                                                                  "cache_hit_pct": 93.8},
                                "tasks": [{"name": "beta", "failure_reason": "Timeout after 300s"}]})
        write(run / "local-stack-owner.json", {"run_id": run.name, "token": "stack-owned"})
        write(run / "local-benchmark-owner.json", {"run_id": run.name, "token": "bench-owned",
                                                    "state": "cleanup_verified"})
        write(run / "local-stack-cleanup.status", "version=2\ntoken=stack-owned\nstate=clean\n")
        write(run / "benchmark-cleanup-bench-owned.status", "version=1\ntoken=bench-owned\nstate=clean\n")
        data = CARD["build"](run, ledger=self.tmp / "none.jsonl", now=NOW)
        exp = data["experiment"]
        self.assertEqual((exp["state"], exp["progress"]["completed"]), ("COMPLETE", 2))
        self.assertEqual((exp["outcomes"]["PASS"], exp["outcomes"]["AGENT FAIL"]), (1, 1))
        self.assertIsNone(exp["cache"], "legacy summary percentage lacks uncached-input coverage")
        self.assertIn("Timeout after 300s", CARD["render_text"](data))
        self.valid(data)
        # The run ends when its last required cleanup receipt lands, including a
        # benchmark cleanup that finishes after the stack cleanup and run.json.
        for name, mtime in (("run.json", T0), ("local-stack-cleanup.status", T0 + 5),
                            ("benchmark-cleanup-bench-owned.status", T0 + 30)):
            os.utime(run / name, (mtime, mtime))
        late = CARD["build"](run, ledger=self.tmp / "none.jsonl", now=NOW)["experiment"]
        self.assertEqual(late["ended_at"], T0 + 30)
        write(run / "local-stack-cleanup.status", "version=2\ntoken=wrong-owner\nstate=clean\n")
        unverified = CARD["build"](run, ledger=self.tmp / "none.jsonl", now=NOW)["experiment"]
        self.assertEqual(unverified["state"], "INCOMPLETE")

    def test_local_run_benchmark_card_lists_terminal_tasks_with_fe_links(self):
        # run_benchmark.py's report-card.json: no per-task dirs, no lifecycle_stage, agent only in agent_url.
        run = self.tmp / "1792629049-local-2"
        url = "https://roselabs.ai/?agent-id=7d7be967-eecf-4fca-80af-d1973327fdd6"
        write(run / "report-card.json", {
            "run_id": "local-2", "tasks": {"total": 3, "running": 0, "completed": 3, "queued": 0},
            "per_task": [{"name": "alpha", "status": "passed", "duration_s": 160.8, "cost_usd": 0.0, "agent_url": url},
                         {"name": "beta", "status": "failed", "duration_s": 99.0, "cost_usd": 0.01, "agent_url": None},
                         {"name": "gamma", "status": "passed", "duration_s": 50.0, "cost_usd": 0.0, "agent_url": None}],
        })
        write(run / "run.json", {"run_id": "local-2", "summary": {"passed": 2, "failed": 1},
                                "tasks": [{"name": "beta", "agent_id": "b0f841a5-5d35-4c79-8b13-f20ecf54bdcb"}]})
        data = CARD["build"](run, ledger=self.tmp / "none.jsonl", now=NOW)
        exp = data["experiment"]
        self.assertEqual((exp["progress"]["queued"], exp["progress"]["completed"]), (0, 3))
        self.assertEqual((exp["outcomes"]["PASS"], exp["outcomes"]["AGENT FAIL"]), (2, 1))
        self.assertEqual([(t["task"], t["agent_id"]) for t in exp["task_links"]],
                         [("alpha", "7d7be967-eecf-4fca-80af-d1973327fdd6"),
                          ("beta", "b0f841a5-5d35-4c79-8b13-f20ecf54bdcb"), ("gamma", None)])
        text = CARD["render_text"](data)
        self.assertIn("PASS alpha · " + url, text)
        self.assertIn("AGENT FAIL beta · b0f841a5-5d35-4c79-8b13-f20ecf54bdcb · FE link UNRECORDED", text)
        self.assertIn("PASS gamma · agent UNRECORDED", text)
        self.assertNotIn("NO SCORED TASKS", text)
        html = CARD["render_html"](data)
        self.assertIn(url, html)
        self.valid(data)

    def test_assembled_local_card_needs_every_lane_stack_receipt(self):
        # run_captcha_probe.py --assemble: one run context from several lanes' stacks, each
        # stack's own cleanup receipts copied under sources/<lane>/<stack>.
        run = self.tmp / "tilion-captcha-round2"
        write(run / "report-card.json", {
            "run_id": "tilion-captcha-round2", "source_sha": None, "started_at": T0, "finished_at": T0 + 900,
            "tasks": {"total": 3},
            "per_task": [{"name": "alpha", "status": "passed", "agent_id": "7d7be967-eecf-4fca-80af-d1973327fdd6"},
                         {"name": "beta", "status": "failed", "agent_id": "b0f841a5-5d35-4c79-8b13-f20ecf54bdcb"},
                         {"name": "held", "status": "skipped"}],
        })
        write(run / "run.json", {"run_id": "tilion-captcha-round2",
                                "tasks": [{"name": "beta", "failure_reason": "PerimeterX press and hold still blocking"}]})
        stacks = []
        for lane, stack in (("F", "stack-f"), ("A2", "stack-a2")):
            receipts = run / "sources" / lane / stack
            write(receipts / "local-stack-owner.json", {"run_id": stack, "token": f"{stack}-tok"})
            write(receipts / "local-stack-cleanup.status", f"version=2\ntoken={stack}-tok\nstate=clean\n")
            stacks.append({"lane": lane, "stack_run_id": stack, "receipts": f"sources/{lane}/{stack}"})
        write(run / "assembled-from.json", {"stacks": stacks})
        data = CARD["build"](run, ledger=self.tmp / "none.jsonl", now=NOW)
        exp = data["experiment"]
        self.assertEqual((exp["state"], exp["ended_at"]), ("COMPLETE", T0 + 900))
        self.assertEqual((exp["outcomes"]["PASS"], exp["outcomes"]["AGENT FAIL"], exp["outcomes"]["SKIPPED"]), (1, 1, 1))
        text = CARD["render_text"](data)
        self.assertIn("all 2 lane stacks have clean cleanup receipts", text)
        self.assertIn("PerimeterX press and hold still blocking", text)
        self.valid(data)
        # One lane stack whose receipt is still pending keeps the run INCOMPLETE and names it.
        write(run / "sources/A2/stack-a2/local-stack-cleanup.status", "version=2\ntoken=stack-a2-tok\nstate=pending\n")
        data = CARD["build"](run, ledger=self.tmp / "none.jsonl", now=NOW)
        self.assertEqual(data["experiment"]["state"], "INCOMPLETE")
        self.assertIn("cleanup receipt not clean: A2/stack-a2", CARD["render_text"](data))

    def test_local_interrupted_tasks_are_cancelled_not_agent_failures(self):
        # A run stopped mid-way (Tilion 402 premium_egress_exhausted, 2026-10-22): tasks that
        # never started or were cut off have benchmark_status CANCELLED and no verdict.
        run = self.tmp / "1792712097-local-cancel"
        write(run / "report-card.json", {
            "run_id": "local-cancel", "tasks": {"total": 4},
            "per_task": [{"name": "alpha", "status": "passed"}, {"name": "beta", "status": "failed"},
                         {"name": "gamma", "status": "failed"}, {"name": "delta", "status": "cancelled"}],
        })
        write(run / "run.json", {"run_id": "local-cancel", "tasks": [
            {"name": "alpha", "status": "COMPLETED", "benchmark_status": "PASSED", "passed": True},
            {"name": "beta", "status": "COMPLETED", "benchmark_status": "FAILED", "passed": False,
             "failure_reason": "Expected isolated browser session metadata was not observed"},
            {"name": "gamma", "status": "ACTIVE", "benchmark_status": "CANCELLED", "passed": False,
             "failure_reason": "Benchmark interrupted; prod logs were collected before shutdown"},
            {"name": "delta", "status": "CANCELLED", "benchmark_status": "CANCELLED", "passed": False}]})
        exp = CARD["build"](run, ledger=self.tmp / "none.jsonl", now=NOW)["experiment"]
        self.assertEqual((exp["outcomes"]["PASS"], exp["outcomes"]["AGENT FAIL"], exp["outcomes"]["CANCELLED"]), (1, 1, 2))
        self.assertEqual(exp["progress"]["completed"], 4)

    def test_local_card_reads_recorded_source_and_clock(self):
        run = self.tmp / "local-run-without-epoch-name"
        sha = "a873eae49" + "0" * 31
        body = {"run_id": "local-3", "source_sha": sha, "started_at": T0, "finished_at": T0 + 600,
                "tasks": {"total": 1}, "per_task": [{"name": "alpha", "status": "passed", "agent_url": None}]}
        write(run / "report-card.json", body)
        write(run / "run.json", {"run_id": "local-3", "summary": {"passed": 1}, "tasks": []})
        exp = CARD["build"](run, ledger=self.tmp / "none.jsonl", now=NOW)["experiment"]
        # Results are final but no cleanup receipt exists: the producer's finish time is the end.
        self.assertEqual((exp["source_ref"], exp["triggered_at"]), (sha, T0))
        self.assertEqual((exp["state"], exp["ended_at"]), ("INCOMPLETE", T0 + 600))
        self.assertIn("src a873eae49", CARD["render_text"](CARD["build"](run, ledger=self.tmp / "none.jsonl", now=NOW)))
        # Missing or malformed producer fields stay unrecorded, never guessed.
        write(run / "report-card.json", {**body, "source_sha": "HEAD", "started_at": None, "finished_at": None})
        exp = CARD["build"](run, ledger=self.tmp / "none.jsonl", now=NOW)["experiment"]
        self.assertEqual((exp["source_ref"], exp["triggered_at"], exp["ended_at"]), (None, None, None))

    def test_monitor_observation_time_respects_daylight_saving(self):
        monitor = runpy.run_path(str(ROOT / "scripts/cloudbench-monitor.py"), run_name="monitor")
        write(self.tmp / "_batch/report-card.json", {"per_task": []})
        for instant, label in ((T0, "Oct 18, 12:28:52 PM PDT"), (T0 + 55 * 86400, "Dec 12, 11:28:52 AM PST")):
            class Fixed(monitor["datetime"]):
                @classmethod
                def now(cls, tz=None, instant=instant):
                    return monitor["datetime"].fromtimestamp(instant, tz)
            with mock.patch.dict(monitor["observe"].__globals__, {"datetime": Fixed}):
                self.assertEqual(monitor["observe"](self.tmp)["timestamp_pst"], label)

    def test_pacific_time_respects_daylight_saving(self):
        pacific = CARD["pacific"]
        self.assertEqual(pacific(T0), "Oct 18, 12:28:52 PM PDT")
        self.assertEqual(pacific(1768521600), "Jan 15, 4:00:00 PM PST")  # 2026-01-16 00:00 UTC
        self.assertEqual(pacific(1772964000 - 1), "Mar 8, 1:59:59 AM PST")  # spring forward 2026-03-08 10:00 UTC
        self.assertEqual(pacific(1772964000), "Mar 8, 3:00:00 AM PDT")
        self.assertEqual(pacific(1793523600 - 1), "Nov 1, 1:59:59 AM PDT")  # fall back 2026-11-01 09:00 UTC
        self.assertEqual(pacific(1793523600), "Nov 1, 1:00:00 AM PST")
        self.assertEqual(pacific(1792393200), "Oct 19, 12:00:00 AM PDT")  # midnight is 12 AM, never 00
        self.assertEqual(pacific(None), "UNRECORDED")

    def test_validator_rejects_noncompliant_cards(self):
        document = self.valid(render(self.f.fleet(), self.f))
        hand = '<!doctype html><html><body><pre>🧪 EXPERIMENT #6 PASS 4 HARNESS 0 INFRA 0</pre></body></html>'
        self.assertIn("hand-written cards are non-compliant", " ".join(CARD["validate_html"](hand)))
        cases = {
            "null sentinel": document.replace("Triggered", "Triggered null", 1),
            "em dash": document.replace("Lifecycle</h2>", "Lifecycle —</h2>", 1),
            "fixed width": document.replace("main{max-width:760px", "main{width:800px;max-width:760px", 1),
            "remote": document.replace("</main>", '<img src="https://example.com/x.png"></main>', 1),
            "section": document.replace('data-section="issues"', 'data-section="other"', 1),
        }
        for name, bad in cases.items():
            with self.subTest(name):
                self.assertTrue(CARD["validate_html"](bad), name)

    def test_markup_is_360px_safe(self):
        document = self.valid(render(self.f.sharded(), self.f))
        css = re.search(r"<style>(.*?)</style>", document, re.S).group(1)
        widths = [float(v) for v in re.findall(r"(?<![-\w])(?:min-)?width\s*:\s*(\d+(?:\.\d+)?)px", css)]
        self.assertTrue(all(w <= 360 for w in widths), widths)
        self.assertIn("max-width:760px", css)
        self.assertIn('name="viewport"', document)
        self.assertNotIn("vh", re.sub(r"[a-z]vh|vh[a-z]", "", css))

    def test_blocking_agent_moves_section_above_history(self):
        agents = [{"name": "rca-timeout", "work": "480s cutoff", "blocking": True, "status": "⛔", "tokens": 1250000,
                   "warming_s": 420, "started_at": NOW - 3000, "blocker": "needs approval", "action": "parent delivers packet",
                   "observed_at": NOW},
                  {"name": "monitor", "status": "🔄", "tokens": None, "life_s": 600, "observed_at": NOW}]
        document = self.valid(render(self.f.fleet(), self.f, agents=agents))
        self.assertLess(document.index('data-section="agents"'), document.index('data-section="history"'))
        self.assertIn("warming 7m00s", document)
        self.assertIn("needs approval", document)
        self.assertIn("UNMETERED", document)
        relaxed = self.valid(render(self.f.fleet(), self.f, agents=[dict(agents[1])]))
        self.assertGreater(relaxed.index('data-section="agents"'), relaxed.index('data-section="history"'))

    def test_stale_overlay_rows_are_refused(self):
        """2026-10-25 descend-full69: a card published 9m after the run ended still showed the
        parent "shards launching (1:09 AM)" and pre-run cluster statuses from a hand-kept state
        file. Overlay rows are claims; each must say when it was observed, after the run's
        latest evidence and within the 15-minute checkpoint, or the card is not rendered."""
        run = self.f.fleet()  # ended at T0 + 960; NOW = T0 + 3600
        fresh_issue = {"text": "mass-agent T7 RCA", "owner": "ma", "action": "fix", "observed_at": NOW - 60}
        fresh_agent = {"name": "parent", "work": "/descend", "status": "🔄", "observed_at": NOW - 60}
        cases = {
            "issue without observed_at": {"issues": [{"text": "shards launching", "owner": "parent"}]},
            "agent without observed_at": {"agents": [{"name": "parent", "work": "shards launching"}]},
            "issue observed before the run ended": {"issues": [dict(fresh_issue, observed_at=T0 + 900)]},
            "agent older than 15 minutes": {"agents": [dict(fresh_agent, observed_at=NOW - 16 * 60)]},
            "unparseable observed_at": {"issues": [dict(fresh_issue, observed_at="yesterday")]},
        }
        for name, overlay in cases.items():
            with self.subTest(name), self.assertRaises(CARD["StaleOverlay"]) as raised:
                render(run, self.f, **overlay)
            self.assertIn("observed", str(raised.exception))
        card = render(run, self.f, agents=[fresh_agent], issues=[fresh_issue])
        self.valid(card)
        self.assertIn("mass-agent T7 RCA", json.dumps(card["issues"]))
        self.valid(render(run, self.f, agents=[], issues=[]))

    def test_cli_refuses_stale_overlay_without_writing_the_card(self):
        run = self.f.fleet()
        out = self.tmp / "card/stale.html"
        issues = write(self.tmp / "issues.json", json.dumps([{"text": "shards launching (1:09 AM)", "owner": "parent",
                                                              "observed_at": T0 + 10}]))
        env = dict(os.environ, CLOUDBENCH_EXPERIMENTS_LEDGER=str(self.f.ledger))
        made = subprocess.run(["bash", str(ROOT / "scripts/run-bench"), "scorecard", str(run), "--html", str(out),
                               "--issues", str(issues), "--now", str(NOW)],
                              capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(made.returncode, 1, made.stdout)
        self.assertIn("shards launching", made.stderr)
        self.assertIn("before the run's latest evidence", made.stderr)
        self.assertFalse(out.exists(), "a stale card must not be written")

    def test_cli_html_text_json_and_validate(self):
        run = self.f.fleet()
        out = self.tmp / "card/index.html"
        env = dict(os.environ, CLOUDBENCH_EXPERIMENTS_LEDGER=str(self.f.ledger))
        cli = ["bash", str(ROOT / "scripts/run-bench"), "scorecard"]
        made = subprocess.run(cli + [str(run), "--html", str(out), "--json"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(made.returncode, 0, made.stderr)
        self.assertTrue(json.loads(made.stdout.splitlines()[0])["valid"])
        checked = subprocess.run(cli + ["--validate", str(out)], capture_output=True, text=True, timeout=60)
        self.assertEqual((checked.returncode, json.loads(checked.stdout)["valid"]), (0, True))
        hand = write(self.tmp / "hand.html", "<html><body>card</body></html>")
        self.assertEqual(subprocess.run(cli + ["--validate", str(hand)], capture_output=True, timeout=60).returncode, 1)
        text = subprocess.run(cli + [str(run), "--text"], capture_output=True, text=True, env=env, timeout=60)
        self.assertTrue(text.stdout.startswith("🧪 EXPERIMENT #1"), text.stdout[:200])


class NativeReleaseAuditOwnership(unittest.TestCase):
    """2026-10-19 polar70: three retained guests stayed started while the audit said released.

    Their fleets ended with ``cleanup_policy=retain``. Each primary was recorded only in its
    run's ``primary.ids``, its exported git-common ownership registry/audit and the guest's
    native ``CLOUDBENCH_RUN_TOKEN``; none of those were read, so ``present`` stayed empty.
    """

    RELEASED, RETAINED = "1f" * 16, "dc" * 16

    def admission(self, base: Path) -> Path:
        admission = base / "original600-1792440129763435696"
        write(admission / "coordination.json", {"controllers": 1})
        export = admission / "shard-00/run/export"
        write(export / "disposable-export.verified.json", "{}")
        members = {
            # A fully released fleet: teardown moved its audit into the run directory.
            "context/fleet/runs/20261019-201626-26082/teardown-ownership/owned-clones.ids": "847559f2e20318\n",
            "context/fleet/runs/20261019-201626-26082/teardown-ownership/owned-clones.names": "cloudbench-aaaa\n",
            f"git-common/cloudbench-fleet-audits/{self.RELEASED}/meta":
                f"fleet_owner_token={self.RELEASED}\nstatus=provider-teardown-verified\n",
            # The retained fleet: guest cleanup unconfirmed, ownership left in git-common.
            "context/fleet/runs/20261019-201626-26147/teardown-ownership.path":
                f"/tmp/gate/repo/.git/cloudbench-fleet-audits/{self.RETAINED}",
            "context/fleet/runs/20261019-201626-26147/polar-odysseys-a24232e8f6e7/primary.ids": "8ed954ef9d2138\n",
            f"git-common/cloudbench-fleet-ownership/{self.RETAINED}/meta":
                f"version=2\napp=navi-whisper-lux-bench\nfleet_owner_token={self.RETAINED}\n"
                "run_id=20261019-201626-26147\ncleanup_policy=retain\n",
            f"git-common/cloudbench-fleet-ownership/{self.RETAINED}/guest-cleanup-unconfirmed": "",
            f"git-common/cloudbench-fleet-ownership/{self.RETAINED}/clones/cloudbench-774d3d3f3cc54c569a86cff6":
                "name=cloudbench-774d3d3f3cc54c569a86cff6\nid=8ed954ef9d2138\nvolume_id=vol_4m3mqdlj75d6901v\n",
            f"git-common/cloudbench-fleet-audits/{self.RETAINED}/meta":
                f"fleet_owner_token={self.RETAINED}\nstatus=incomplete\n",
        }
        with tarfile.open(export / "originals.tar.gz", "w:gz") as stream:
            for name, text in members.items():
                data = text.encode()
                info = tarfile.TarInfo(name)
                info.size = len(data)
                stream.addfile(info, io.BytesIO(data))
        return admission

    @staticmethod
    def api(machines, volumes):
        class Api:
            def api(self, method, path, timeout):
                assert method == "GET"
                return volumes if path.startswith("/volumes") else machines
        return Api()

    def guest(self, mid, name, token, volume):
        return {"id": mid, "name": name, "state": "started",
                "config": {"env": {"CLOUDBENCH_RUN_TOKEN": token + "-0", "UNRELATED_SECRET": "never-recorded"},
                           "mounts": [{"volume": volume}]}}

    def test_retained_owner_guests_and_volumes_are_found_and_fail_closed(self):
        with tempfile.TemporaryDirectory() as name:
            admission = self.admission(Path(name))
            machines = [
                self.guest("8ed954ef9d2138", "cloudbench-774d3d3f3cc54c569a86cff6", self.RETAINED, "vol_4m3mqdlj75d6901v"),
                # A sibling guest of the same owner whose ID was never written to any export file.
                self.guest("e82037df15e468", "cloudbench-bdad8546e65142dd8267b1da", self.RETAINED, "vol_r7ymxn76780g71gr"),
                # Protected warm donor and another owner's guest: never matched.
                {"id": "8ed16dc75ee958", "name": "cloudbench-warm-t10-ord-85a7e2c", "state": "stopped", "config": {"env": {}}},
                self.guest("80000000000001", "cloudbench-other", "ab" * 16, "vol_other"),
            ]
            volumes = [{"id": "vol_4m3mqdlj75d6901v", "name": "cbv_774d3d3f3cc54c569a86cff6", "state": "created"},
                       {"id": "vol_r7ymxn76780g71gr", "name": "cbv_bdad8546e65142dd8267b1da", "state": "created"},
                       {"id": "vol_other", "name": "cbv_other", "state": "created"}]
            result = AUDIT["run"](admission, self.api(machines, volumes), "navi-whisper-lux-bench")
            self.assertFalse(result["released"], "a live retained guest never certifies release")
            self.assertEqual(sorted(m["id"] for m in result["present"]), ["8ed954ef9d2138", "e82037df15e468"])
            self.assertEqual(sorted(v["id"] for v in result["present_volumes"]),
                             ["vol_4m3mqdlj75d6901v", "vol_r7ymxn76780g71gr"])
            self.assertEqual(result["retained_owners"], [self.RETAINED])
            self.assertNotIn("never-recorded", json.dumps(result), "the audit never records guest environment values")
            saved = json.loads((admission / "native-release-audit.json").read_text())
            self.assertFalse(saved["released"])

            # Native absence alone does not discharge an exported owner that never retired.
            absent = AUDIT["run"](admission, self.api([machines[2]], []), "navi-whisper-lux-bench")
            self.assertEqual((absent["present"], absent["present_volumes"]), ([], []))
            self.assertFalse(absent["released"], "a retained ownership registry fails closed")
            self.assertTrue(AUDIT["audit"]([], app="app", guest_names={"cloudbench-a"}, guest_ids=set(), controllers=set(),
                                           exports=1, shards=1, now=T0)["released"])

    def test_retried_shard_counts_only_its_final_attempt_export(self):
        with tempfile.TemporaryDirectory() as name:
            admission = self.admission(Path(name))
            retained = admission / "shard-00/run/export/originals.tar.gz"
            # The released fleet alone, in the shard's first attempt and in shard-01.
            for target in (admission / "shard-00/run/export", admission / "shard-01/run/export"):
                write(target / "disposable-export.verified.json", "{}")
                with tarfile.open(target / "originals.tar.gz", "w:gz") as stream:
                    data = b"847559f2e20318\n"
                    info = tarfile.TarInfo("context/fleet/runs/20261019-201626-26082/teardown-ownership/owned-clones.ids")
                    info.size = len(data)
                    stream.addfile(info, io.BytesIO(data))
            final = admission / "shard-01/attempt-02/run"
            final.mkdir(parents=True)
            write(admission / "coordination.json", {"controllers": 2, "shards": {
                "0": {"out": str(admission / "shard-00/run")}, "1": {"out": str(final)}}})
            result = AUDIT["run"](admission, self.api([], []), "app")
            self.assertEqual(result["checked"]["verified_exports"], 1, "shard-01's final attempt exported nothing")
            self.assertFalse(result["released"], "an earlier attempt's export never stands in for the final one")
            write(final / "export/disposable-export.verified.json", "{}")
            (final / "export/originals.tar.gz").write_bytes((admission / "shard-01/run/export/originals.tar.gz").read_bytes())
            result = AUDIT["run"](admission, self.api([], []), "app")
            self.assertEqual((result["checked"]["verified_exports"], result["checked"]["expected_shards"]), (2, 2))
            self.assertTrue(result["released"], "every final export checked, nothing present, no retained owner")
            self.assertTrue(retained.exists())


class LaunchInstructions(unittest.TestCase):
    def test_instruction_names_the_exact_render_and_publish_commands(self):
        printed = StringIO()
        with redirect_stdout(printed):
            CARD["print_instruction"]("/runs/abc")
        text = printed.getvalue()
        for needle in ("scripts/run-bench scorecard /runs/abc --html /runs/abc/scorecard.html",
                       "dvb-onbox visuals publish --file /runs/abc/scorecard.html",
                       "hand-written cards are non-compliant", "every 15 minutes", "state change", "completion"):
            self.assertIn(needle, text)

    def test_every_launch_path_prints_the_scorecard_command(self):
        fleet = (ROOT / "scripts/run-bench-fleet").read_text()
        self.assertIn('cloudbench-scorecard.py" --instruction "$FLEET_DIR"', fleet)
        self.assertEqual(fleet.count("fleet_scorecard_report launch"), 1)
        self.assertIn("fleet_scorecard_report end", fleet)
        campaign = (ROOT / "scripts/run-bench-campaign.py").read_text()
        self.assertEqual(campaign.count('scorecard["print_instruction"](campaign_dir)'), 2, "campaign start and end")
        operator = (ROOT / "scripts/run-original600-controller.py").read_text()
        self.assertEqual(operator.count("scorecard['print_instruction'](directory)"), 2, "operator start and end")
        local = (ROOT / "agents/benchmarks/local.py").read_text()
        self.assertEqual(local.count("print_scorecard_instruction(_dashboard_context_dir(stack))"), 2, "local start and end")
        contract = (ROOT / ".claude/shared/benchmark-report-format.txt").read_text()
        self.assertIn("FORMAT v8", contract)
        self.assertIn("scripts/run-bench scorecard <run-dir> --html", contract)
        self.assertIn("non-compliant", contract)

    def test_fleet_report_hook_records_standalone_launches_only(self):
        source = (ROOT / "scripts/run-bench-fleet").read_text()
        body = source[source.index("fleet_scorecard_report() {"):source.index("fleet_scorecard_report launch\n")]
        with tempfile.TemporaryDirectory() as name:
            base = Path(name)
            (base / "scripts").mkdir()
            for script in ("cloudbench-scorecard.py", "cloudbench_experiments.py", "cloudbench_global_progress.py"):
                shutil.copy2(ROOT / "scripts" / script, base / "scripts" / script)
            harness = f'''set -euo pipefail
ROOT_DIR={base}; FLEET_DIR={base}/run; RUN_ID=20261018-1-7; GIT_COMMON_DIR={base}; PROVISION_POOL=""
BENCHES=(alpha beta)
{body}
fleet_scorecard_report launch
RUN_BENCH_CAMPAIGN_CHILD=1 RUN_ID=child fleet_scorecard_report launch
fleet_scorecard_report end ENDED
'''
            done = subprocess.run(["bash", "-c", harness], capture_output=True, text=True, timeout=60,
                                  env={k: v for k, v in os.environ.items() if k not in ("CLOUDBENCH_EXPERIMENTS_LEDGER", "RUN_BENCH_CAMPAIGN_CHILD")})
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(done.stdout.count("scripts/run-bench scorecard"), 6, "every hook call prints the command")
            entries = LEDGER["read"](base / "cloudbench-experiments.jsonl")
            self.assertEqual([(e["event"], e["id"]) for e in entries], [("launch", "20261018-1-7"), ("end", "20261018-1-7")])
            self.assertEqual((entries[0]["goal"], entries[0]["slice"], entries[0]["scheduled_total"]), ("fleet:alpha,beta", "alpha +1", 2))

    def test_campaign_hooks_skip_sharded_children(self):
        module = runpy.run_path(str(ROOT / "scripts/run-bench-campaign.py"))
        hooks = module["scorecard_hooks"]()
        self.assertIsNotNone(hooks)
        with tempfile.TemporaryDirectory() as name:
            ledger = Path(name) / "ledger.jsonl"
            env = dict(os.environ, CLOUDBENCH_EXPERIMENTS_LEDGER=str(ledger))
            env.pop("RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER", None)
            with mock.patch.dict(os.environ, env, clear=True):
                module["record_experiment"](hooks, "launch", Path(name) / "campaign-a", ROOT, goal="g")
                os.environ["RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER"] = "/barrier"
                module["record_experiment"](hooks, "launch", Path(name) / "campaign-b", ROOT, goal="g")
            self.assertEqual([e["id"] for e in LEDGER["read"](ledger)], ["campaign-a"])


class ExperimentsLedger(unittest.TestCase):
    def test_append_only_idempotent_numbered_per_goal(self):
        with tempfile.TemporaryDirectory() as name:
            ledger = Path(name) / "l.jsonl"
            for ident, goal, at in (("a", "g1", T0), ("b", "g2", T0 + 10), ("c", "g1", T0 + 20)):
                LEDGER["record"]("launch", ident, ledger=ledger, goal=goal, triggered_at=at)
            LEDGER["record"]("launch", "a", ledger=ledger, goal="g1", triggered_at=T0 + 999)
            LEDGER["record"]("end", "a", ledger=ledger, goal="g1", ended_at=T0 + 5)
            with ledger.open("a") as stream:
                stream.write("{not json\n")
            entries = LEDGER["read"](ledger)
            self.assertEqual(len(entries), 4, "duplicates are not appended and malformed lines are skipped")
            g1 = LEDGER["experiments"](entries, "g1")
            self.assertEqual([(e["id"], e["number"], e["triggered_at"]) for e in g1], [("a", 1, T0), ("c", 2, T0 + 20)])
            self.assertEqual(g1[0]["end"]["ended_at"], T0 + 5)
            rate = LEDGER["launch_rate"](g1, T0 + 43200)
            self.assertEqual((rate["launches"], round(rate["days"], 2), round(rate["per_day"], 1)), (2, 0.5, 4.0))

    def test_oversized_entry_drops_optional_fields_and_never_writes_partial_line(self):
        with tempfile.TemporaryDirectory() as name:
            ledger = Path(name) / "l.jsonl"
            bulky = {f"field_{i:02d}": "y" * 300 for i in range(20)}
            first = LEDGER["record"]("launch", "big", ledger=ledger, goal="g", triggered_at=T0,
                                     notes="n" * 300, outcome="o" * 300, **bulky)
            self.assertIsNotNone(first)
            LEDGER["record"]("end", "big", ledger=ledger, goal="g", ended_at=T0 + 5)
            raw = ledger.read_bytes()
            self.assertTrue(raw.endswith(b"\n"))
            lines = raw.splitlines()
            self.assertEqual(len(lines), 2, "the next append stays on its own line")
            self.assertTrue(all(len(line) + 1 <= LEDGER["MAX_LINE_BYTES"] for line in lines))
            entries = LEDGER["read"](ledger)
            self.assertEqual([(e["event"], e["id"]) for e in entries], [("launch", "big"), ("end", "big")])
            launch = entries[0]
            self.assertEqual((launch["goal"], launch["triggered_at"]), ("g", T0))
            self.assertNotIn("notes", launch)
            self.assertNotIn("outcome", launch)
            self.assertTrue(any(key.startswith("field_") for key in launch), "only enough optional fields are dropped")
            g = LEDGER["experiments"](entries, "g")
            self.assertEqual((len(g), g[0]["number"], g[0]["end"]["ended_at"]), (1, 1, T0 + 5))

    def test_concurrent_processes_append_complete_lines(self):
        with tempfile.TemporaryDirectory() as name:
            ledger = Path(name) / "l.jsonl"
            code = ("import runpy,sys;m=runpy.run_path(sys.argv[1]);"
                    "[m['record']('launch',f'{sys.argv[3]}-{i}',ledger=__import__('pathlib').Path(sys.argv[2]),goal='g',notes='x'*900) for i in range(25)]")
            procs = [subprocess.Popen([sys.executable, "-c", code, str(ROOT / "scripts/cloudbench_experiments.py"), str(ledger), str(n)])
                     for n in range(4)]
            self.assertEqual([p.wait(timeout=60) for p in procs], [0] * 4)
            lines = ledger.read_text().splitlines()
            self.assertEqual(len(lines), 100)
            self.assertTrue(all(json.loads(line)["schema"] == "cloudbench-experiment-v1" for line in lines))

    def test_backfill_reads_only_existing_admission_receipts(self):
        with tempfile.TemporaryDirectory() as name:
            fixtures = Fixtures(Path(name))
            admission = fixtures.sharded()
            write(admission / "result.json", {"task_status": {"PASSED": 2, "FAILED": 2}, "infra_failures": 0,
                                              "observed_jobs": 4, "missing_jobs": 0})
            entries = LEDGER["original600_entries"](admission, "goal")
            self.assertEqual([e for e, _ in entries], ["launch", "end"])
            self.assertEqual((entries[0][1]["triggered_at"], entries[0][1]["backfilled"]), (T0, True))
            self.assertEqual((entries[1][1]["ended_at"], entries[1][1]["state"]), (T0 + 2000, "COMPLETE"))
            never = Path(name) / "never-launched"
            never.mkdir()
            self.assertEqual(LEDGER["original600_entries"](never, "goal"), [], "an admission without coordination never launched")


if __name__ == "__main__":
    unittest.main()
