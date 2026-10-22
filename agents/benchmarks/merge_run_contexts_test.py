"""merge_run_contexts: two local invocations of one suite -> one scorecard run context."""

import json
import runpy
from pathlib import Path

from benchmarks.merge_run_contexts import merge_run_contexts

SCORECARD = runpy.run_path(str(Path(__file__).resolve().parents[2] / "scripts/cloudbench-scorecard.py"))


def _run(root: Path, name: str, rows: list, *, tokens: str, cost: float, start: float, end: float,
         reasons: dict, cleanup: str = "clean") -> Path:
    run = root / name
    run.mkdir(parents=True)
    (run / "report-card.json").write_text(json.dumps({
        "run_id": name, "source_sha": "a" * 40, "started_at": start, "finished_at": end,
        "tasks": {"total": len(rows)}, "results": {},
        "cost": {"agents_llm_usd": cost, "wmh_grounding_usd": None, "infra_usd": None, "total_usd": cost},
        "per_task": rows,
    }))
    (run / "run.json").write_text(json.dumps(
        {"run_id": name, "tasks": [{"name": k, "failure_reason": v} for k, v in reasons.items()]}))
    (run / "local-stack-owner.json").write_text(json.dumps({"run_id": name, "token": tokens}))
    (run / "local-stack-cleanup.status").write_text(f"version=2\ntoken={tokens}\nstate={cleanup}\n")
    (run / "local-benchmark-owner.json").write_text(json.dumps({"run_id": name, "token": tokens + "-b"}))
    (run / f"benchmark-cleanup-{tokens}-b.status").write_text(f"version=1\ntoken={tokens}-b\nstate=clean\n")
    return run


def _row(name, status, agent):
    return {"name": name, "status": status, "duration_s": 60.0, "agent_id": agent, "agent_url": None}


def test_later_run_replaces_tasks_costs_add_up_and_receipts_gate_release(tmp_path):
    first = _run(tmp_path, "run-guest", [_row("alpha", "passed", "a1"), _row("amazon", "failed", "a2")],
                 tokens="t1", cost=1.25, start=1000.0, end=2000.0, reasons={"amazon": "signed out (guest mode)"})
    second = _run(tmp_path, "run-auth", [_row("amazon", "passed", "a3")],
                  tokens="t2", cost=0.5, start=2100.0, end=2500.0, reasons={})
    out = tmp_path / "antibot-kernel"
    merge_run_contexts(out, [first, second], label="antibot-kernel")

    card = json.loads((out / "report-card.json").read_text())
    rows = {row["name"]: row for row in card["per_task"]}
    assert (rows["amazon"]["status"], rows["amazon"]["agent_id"]) == ("passed", "a3")  # later run wins
    assert card["tasks"]["total"] == 2 and card["results"]["passed"] == 2
    assert card["cost"]["agents_llm_usd"] == 1.75  # every attempt was paid for
    assert (card["started_at"], card["finished_at"], card["source_sha"]) == (1000.0, 2500.0, "a" * 40)
    run = json.loads((out / "run.json").read_text())
    assert run["superseded"] == [{"task": "amazon", "from_run": "run-guest", "status": "failed", "agent_id": "a2",
                                  "agent_url": None, "duration_s": 60.0, "failure_reason": "signed out (guest mode)"}]

    data = SCORECARD["build"](out, ledger=tmp_path / "none.jsonl", now=3000.0)
    assert data["experiment"]["state"] == "COMPLETE"
    assert data["experiment"]["outcomes"]["PASS"] == 2
    # A source stack whose cleanup receipt is not clean keeps the merged run INCOMPLETE.
    (out / "sources/run-auth/local-stack-cleanup.status").write_text("version=2\ntoken=t2\nstate=pending\n")
    assert SCORECARD["build"](out, ledger=tmp_path / "none.jsonl", now=3000.0)["experiment"]["state"] == "INCOMPLETE"


def test_unrecorded_costs_and_mixed_sources_stay_unclaimed(tmp_path):
    first = _run(tmp_path, "r1", [_row("alpha", "passed", "a1")], tokens="t1", cost=1.0, start=1.0, end=2.0, reasons={})
    second = _run(tmp_path, "r2", [_row("beta", "failed", "b1")], tokens="t2", cost=1.0, start=3.0, end=4.0, reasons={})
    card2 = json.loads((second / "report-card.json").read_text())
    card2["cost"]["agents_llm_usd"] = None
    card2["source_sha"] = "b" * 40
    (second / "report-card.json").write_text(json.dumps(card2))
    merge_run_contexts(tmp_path / "out", [first, second])
    card = json.loads((tmp_path / "out/report-card.json").read_text())
    assert card["cost"]["agents_llm_usd"] is None
    assert card["source_sha"] is None
