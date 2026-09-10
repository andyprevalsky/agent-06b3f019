#!/usr/bin/env python3
"""Planner memory A/B scenarios: real planner LLM calls, memory off vs on.

For every scenario in ``memory_scenarios.json`` the runner:
  1. loads the suite's frozen memory fixture rows into a dedicated backend and
     verifies the exact row IDs and contents before making planner calls;
  2. calls the real planner activity twice with the same goal — memory off,
     then memory on — through the real Rose client (real LLM);
  3. evaluates the plan-shape assertions on both arms and records the exact
     memory context that was injected (the get_memories fork).

Proof contract:
  * every scenario's memory-on plan must satisfy its assertions;
  * "strict" scenarios must FAIL with memory off (the improvement is caused by
    memory, not by the prompt);
  * "control" scenarios must retrieve zero memories;
  * held-out scenarios are reported separately from fit scenarios.

Usage:
    cd agents && python benchmarks/run_memory_scenarios.py --port 3001 [--only name,name] [--split held_out]
Outputs:
    agents/benchmarks/runs/memory-scenarios-<ts>.json
    .context/memory-dashboard/index.html   (opened in a browser when possible)
"""

from __future__ import annotations

import argparse
import asyncio
import html
import importlib
import json
import os
import sys
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx

AGENTS_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = AGENTS_ROOT.parent
sys.path.insert(0, str(AGENTS_ROOT))

evaluate_plan_assertions = importlib.import_module("benchmarks.plan_assertions").evaluate_plan_assertions

SCENARIOS_PATH = AGENTS_ROOT / "benchmarks" / "memory_scenarios.json"
SCENARIO_FIXTURE = "memory-scenarios-v1"
RUNS_DIR = AGENTS_ROOT / "benchmarks" / "runs"
DASHBOARD_DIR = REPO_ROOT / ".context" / "memory-dashboard"
USER_ID = os.environ.get("BENCHMARK_USER_ID", "1f85ff25-6e29-4c1b-8739-f917bd101a30")
MODEL = os.environ.get("PLANNER_MEMORY_SCENARIO_MODEL", "rose-labs/rose-1-ultra")


def load_scenarios(only: Optional[set[str]], split: Optional[str]) -> list[dict[str, Any]]:
    data = json.loads(SCENARIOS_PATH.read_text(encoding="utf-8"))
    scenarios = data["scenarios"]
    if only:
        scenarios = [s for s in scenarios if s["name"] in only]
    if split:
        scenarios = [s for s in scenarios if s.get("split") == split]
    return scenarios


def fixture_rows() -> dict[str, dict[str, Any]]:
    from scripts.build_memory_fixture import load_fixture

    return {row["id"]: row for row in load_fixture(SCENARIO_FIXTURE)["rows"]}


async def upsert_rows(base_url: str, api_key: str, rows: list[dict[str, Any]]) -> None:
    headers = {"X-API-Key": api_key, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=30) as client:
        for row in rows:
            body = {
                k: v
                for k, v in row.items()
                if k
                in {
                    "goal",
                    "benchmark_task_name",
                    "passed",
                    "root_status",
                    "world_model_mode",
                    "agent_created_at",
                    "critical_path",
                    "compressor_version",
                }
            }
            resp = await client.put(f"{base_url}/api/planner-memory/{row['id']}", headers=headers, json=body)
            resp.raise_for_status()


async def stats(base_url: str, api_key: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{base_url}/api/planner-memory/stats", headers={"X-API-Key": api_key})
        resp.raise_for_status()
        return resp.json()


async def fetch_rows(base_url: str, api_key: str, row_ids: list[str]) -> list[dict[str, Any]]:
    headers = {"X-API-Key": api_key}
    rows: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=30) as client:
        for row_id in row_ids:
            resp = await client.get(f"{base_url}/api/planner-memory/{row_id}", headers=headers)
            if resp.status_code != 200:
                raise RuntimeError(f"isolated PlannerMemory fixture row {row_id} returned HTTP {resp.status_code}")
            body = resp.json()
            if not isinstance(body, dict):
                raise RuntimeError(f"isolated PlannerMemory fixture row {row_id} returned a non-object")
            rows.append(body)
    return rows


_FIXTURE_FIELDS = (
    "id",
    "goal",
    "benchmark_task_name",
    "passed",
    "root_status",
    "world_model_mode",
    "critical_path",
    "compressor_version",
)


def _fixture_projection(row: dict[str, Any]) -> dict[str, Any]:
    return {field: row.get(field) for field in _FIXTURE_FIELDS}


def require_isolated_history(
    history: dict[str, Any], expected_rows: list[dict[str, Any]], observed_rows: list[dict[str, Any]]
) -> None:
    """Fail closed unless the backend contains exactly the frozen fixture corpus."""
    expected_by_id = {str(row["id"]): _fixture_projection(row) for row in expected_rows}
    observed_by_id = {str(row.get("id")): _fixture_projection(row) for row in observed_rows}
    actual = history.get("total")
    if actual != len(expected_by_id) or observed_by_id != expected_by_id:
        missing = sorted(set(expected_by_id) - set(observed_by_id))
        mismatched = sorted(
            row_id
            for row_id in set(expected_by_id) & set(observed_by_id)
            if expected_by_id[row_id] != observed_by_id[row_id]
        )
        raise RuntimeError(
            "memory scenario suite requires an isolated PlannerMemory table: "
            f"expected {len(expected_by_id)} exact fixture row(s), found total={actual}, "
            f"observed={len(observed_by_id)}, missing={missing[:3]}, mismatched={mismatched[:3]}. "
            "Start a fresh benchmark backend/database instead of testing against a backfilled corpus."
        )


async def run_planner(goal: str, *, memory_enabled: bool) -> dict[str, Any]:
    """One real planner call through the activity function (no Temporal)."""
    from domains.set_plan.service import get_planner_tools_description
    from helpers.llm import call_planner_llm_activity

    messages = [{"role": "user", "content": f"GOAL: {goal}\n\nPlan this goal into tasks."}]
    started = time.perf_counter()
    result = await call_planner_llm_activity(
        messages,
        MODEL,
        get_planner_tools_description(),
        "",
        None,
        None,
        None,
        None,
        None,
        None,
        USER_ID,
        memory_enabled=memory_enabled,
    )
    result["elapsed_s"] = round(time.perf_counter() - started, 1)
    return result


def _majority(trials: list[dict[str, Any]]) -> bool:
    return sum(1 for t in trials if t.get("passed")) * 2 > len(trials)


async def run_scenario(scenario: dict[str, Any], *, arms: tuple[str, ...], trials: int = 1) -> dict[str, Any]:
    out: dict[str, Any] = {
        "name": scenario["name"],
        "dimension": scenario["dimension"],
        "task": scenario.get("task"),
        "split": scenario.get("split"),
        "improvement": scenario["improvement"],
        "goal": scenario["goal"],
        "assertions": scenario["assertions"],
        "arms": {},
    }
    for arm in arms:
        enabled = arm == "on"
        arm_trials: list[dict[str, Any]] = []
        for _ in range(max(1, trials)):
            try:
                result = await run_planner(scenario["goal"], memory_enabled=enabled)
                plan = result.get("result") or {}
                memory = result.get("planner_memory") or {}
                retrieved = len(memory.get("hits") or []) if enabled else 0
                ok, failures = evaluate_plan_assertions(plan, scenario["assertions"], memories_retrieved=retrieved)
                arm_trials.append(
                    {
                        "passed": ok,
                        "failures": failures,
                        "plan": plan,
                        "memories_retrieved": retrieved,
                        "memory": memory,
                        "injected": result.get("planner_memory_injected"),
                        "elapsed_s": result.get("elapsed_s"),
                        "model": ((result.get("usage") or {}).get("llm") or [{}])[0].get("model"),
                        "tokens_in": ((result.get("usage") or {}).get("llm") or [{}])[0].get("tokens_in"),
                    }
                )
            except Exception as exc:  # keep going; the report shows the error
                arm_trials.append(
                    {"passed": False, "failures": [f"error: {str(exc)[:300]}"], "plan": None, "memories_retrieved": 0}
                )
        # The arm summary is the majority verdict; the representative trial is the first one
        # matching that verdict so the dashboard shows a plan consistent with the verdict.
        verdict = _majority(arm_trials)
        representative = next(t for t in arm_trials if bool(t.get("passed")) == verdict)
        out["arms"][arm] = {
            **representative,
            "passed": verdict,
            "trials": len(arm_trials),
            "trial_pass_count": sum(1 for t in arm_trials if t.get("passed")),
            "trial_results": [
                {
                    "passed": t.get("passed"),
                    "failures": t.get("failures"),
                    "memories_retrieved": t.get("memories_retrieved"),
                    "elapsed_s": t.get("elapsed_s"),
                }
                for t in arm_trials
            ],
        }
    on = out["arms"].get("on", {})
    off = out["arms"].get("off", {})
    improvement = scenario["improvement"]
    if improvement == "control":
        out["verdict"] = bool(on.get("passed"))
    elif improvement == "strict":
        out["verdict"] = bool(on.get("passed")) and ("off" not in out["arms"] or not off.get("passed"))
    else:
        out["verdict"] = bool(on.get("passed"))
    return out


def render_dashboard(report: dict[str, Any]) -> Path:
    DASHBOARD_DIR.mkdir(parents=True, exist_ok=True)
    esc = html.escape

    def plan_html(plan: Optional[dict[str, Any]]) -> str:
        if not plan:
            return "<em>no plan</em>"
        rows = []
        for t in plan.get("tasks", []):
            deps = ", ".join(t.get("depends_on") or []) or "—"
            rows.append(
                f"<tr><td>{esc(str(t.get('task_idx')))}</td><td><code>{esc(str(t.get('tool_name')))}</code></td>"
                f"<td>{esc(str(t.get('goal')))}</td><td>{esc(deps)}</td></tr>"
            )
        return (
            f"<div class='plan-title'>{esc(str(plan.get('title', '')))} <span class='muted'>join={esc(str(plan.get('join', '')))}</span></div>"
            f"<table class='plan'><thead><tr><th>#</th><th>tool</th><th>goal</th><th>depends_on</th></tr></thead><tbody>{''.join(rows)}</tbody></table>"
        )

    cards = []
    for s in report["scenarios"]:
        on = s["arms"].get("on", {})
        off = s["arms"].get("off", {})
        injected = on.get("injected") or {}
        verdict = "PASS" if s["verdict"] else "FAIL"
        cards.append(
            f"""
<section class='card {"pass" if s["verdict"] else "fail"}'>
  <header>
    <span class='badge {"pass" if s["verdict"] else "fail"}'>{verdict}</span>
    <h2>{esc(s["name"])}</h2>
    <span class='pill'>{esc(s["dimension"])}</span>
    <span class='pill'>{esc(s["improvement"])}</span>
    <span class='pill'>{esc(str(s.get("split")))}</span>
    <span class='muted'>task: {esc(str(s.get("task")))}</span>
  </header>
  <p class='goal'><strong>Goal</strong> {esc(s["goal"])}</p>
  <details><summary>Assertions</summary><pre>{esc(json.dumps(s["assertions"], indent=1))}</pre></details>
  <div class='arms'>
    <div class='arm'>
      <h3>Memory OFF <span class='badge {"pass" if off.get("passed") else "fail"}'>{"assertions hold" if off.get("passed") else "assertions fail"}</span> <span class='muted'>{esc(str(off.get("elapsed_s")))}s · {esc(str(off.get("model")))}</span></h3>
      {plan_html(off.get("plan"))}
      {('<ul class="failures">' + "".join(f"<li>{esc(f)}</li>" for f in off.get("failures", [])) + "</ul>") if off.get("failures") else ""}
    </div>
    <div class='arm'>
      <h3>Memory ON <span class='badge {"pass" if on.get("passed") else "fail"}'>{"assertions hold" if on.get("passed") else "assertions fail"}</span> <span class='muted'>{esc(str(on.get("elapsed_s")))}s · {esc(str(on.get("model")))} · {on.get("memories_retrieved", 0)} memories</span></h3>
      {plan_html(on.get("plan"))}
      {('<ul class="failures">' + "".join(f"<li>{esc(f)}</li>" for f in on.get("failures", [])) + "</ul>") if on.get("failures") else ""}
      <details open><summary>Injected context (the get_memories fork the planner saw)</summary>
        <div class='fork'>
          <div class='msg assistant'><span class='role'>assistant → tool_call</span> <code>get_memories</code> <span class='muted'>{esc(str(injected.get("tool_call_id", "")))}</span><div>{esc(str(injected.get("assistant", "")))}</div></div>
          <div class='msg tool'><span class='role'>tool result</span><pre>{esc(str(injected.get("tool_result", "(no memories injected)")))}</pre></div>
        </div>
      </details>
      <details><summary>Retrieval details</summary><pre>{esc(json.dumps(on.get("memory"), indent=1))}</pre></details>
    </div>
  </div>
</section>"""
        )
    summary = report["summary"]
    page = f"""<!doctype html><html><head><meta charset='utf-8'><title>Planner memory A/B — {esc(report["run_id"])}</title>
<style>
body{{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;margin:0;background:#0f1115;color:#e6e6e6}}
.wrap{{max-width:1500px;margin:0 auto;padding:24px}}
h1{{font-size:22px;margin:0 0 6px}} h2{{font-size:16px;margin:0 8px;display:inline}} h3{{font-size:14px;margin:8px 0}}
.summary{{display:flex;gap:16px;flex-wrap:wrap;margin:14px 0 24px}}
.stat{{background:#171a21;border:1px solid #2a2f3a;border-radius:10px;padding:12px 16px;min-width:150px}}
.stat b{{display:block;font-size:22px}} .muted{{color:#8b93a5;font-size:12px}}
.card{{background:#141720;border:1px solid #2a2f3a;border-left:5px solid #444;border-radius:12px;padding:14px 16px;margin:14px 0}}
.card.pass{{border-left-color:#22c55e}} .card.fail{{border-left-color:#ef4444}}
.badge{{font-size:11px;padding:2px 8px;border-radius:999px;color:#fff;background:#666;vertical-align:middle}}
.badge.pass{{background:#16a34a}} .badge.fail{{background:#dc2626}}
.pill{{font-size:11px;padding:2px 8px;border-radius:999px;background:#242a37;color:#c7cbd6;margin-left:4px}}
.goal{{font-size:13px;color:#c7cbd6}}
.arms{{display:grid;grid-template-columns:1fr 1fr;gap:14px}} .arm{{background:#0f1115;border:1px solid #242a37;border-radius:10px;padding:10px}}
table.plan{{width:100%;border-collapse:collapse;font-size:12px}} table.plan th,table.plan td{{border-bottom:1px solid #242a37;padding:4px 6px;text-align:left;vertical-align:top}}
.plan-title{{font-weight:600;margin:4px 0}} pre{{white-space:pre-wrap;font-size:12px;background:#0b0d12;padding:8px;border-radius:8px;border:1px solid #242a37}}
.failures{{color:#fca5a5;font-size:12px}} .fork .msg{{margin:6px 0;padding:8px;border-radius:8px;border:1px solid #242a37}}
.msg.assistant{{background:#131a2b}} .msg.tool{{background:#101a14}} .role{{font-size:11px;color:#8b93a5;margin-right:6px}}
details summary{{cursor:pointer;font-size:12px;color:#8b93a5}}
</style></head><body><div class='wrap'>
<h1>Planner memory A/B — real planner LLM calls</h1>
<div class='muted'>run {esc(report["run_id"])} · model {esc(MODEL)} · {esc(report["generated_at"])} · history table: {esc(json.dumps(report.get("history_stats")))}</div>
<div class='summary'>
 <div class='stat'><b>{summary["passed"]}/{summary["total"]}</b>scenarios passed</div>
 <div class='stat'><b>{summary["fit_passed"]}/{summary["fit_total"]}</b>fit split</div>
 <div class='stat'><b>{summary["held_out_passed"]}/{summary["held_out_total"]}</b>held-out split</div>
 <div class='stat'><b>{summary["strict_improved"]}/{summary["strict_total"]}</b>strict improvements (off fails, on passes)</div>
 <div class='stat'><b>{summary["on_assertion_pass"]}/{summary["total"]}</b>memory-on assertions hold</div>
 <div class='stat'><b>{summary["off_assertion_pass"]}/{summary["total"]}</b>memory-off assertions hold</div>
 <div class='stat'><b>{summary["controls_passed"]}/{summary["controls_total"]}</b>negative controls (0 memories)</div>
</div>
{"".join(cards)}
</div></body></html>"""
    path = DASHBOARD_DIR / "index.html"
    path.write_text(page, encoding="utf-8")
    return path


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    def count(pred) -> int:
        return sum(1 for r in results if pred(r))

    strict = [r for r in results if r["improvement"] == "strict"]
    controls = [r for r in results if r["improvement"] == "control"]
    return {
        "total": len(results),
        "passed": count(lambda r: r["verdict"]),
        "fit_total": count(lambda r: r.get("split") == "fit"),
        "fit_passed": count(lambda r: r.get("split") == "fit" and r["verdict"]),
        "held_out_total": count(lambda r: r.get("split") == "held_out"),
        "held_out_passed": count(lambda r: r.get("split") == "held_out" and r["verdict"]),
        "strict_total": len(strict),
        "strict_improved": sum(1 for r in strict if r["verdict"]),
        "on_assertion_pass": count(lambda r: r["arms"].get("on", {}).get("passed")),
        "off_assertion_pass": count(lambda r: r["arms"].get("off", {}).get("passed")),
        "controls_total": len(controls),
        "controls_passed": sum(1 for r in controls if r["verdict"]),
    }


async def main_async(args: argparse.Namespace) -> int:
    base_url = f"http://localhost:{args.port}"
    api_key = os.environ.get("BACKEND_API_KEY") or ""
    if not api_key:
        print("BACKEND_API_KEY is required")
        return 2
    os.environ["BACKEND_API_URL"] = base_url
    os.environ.setdefault("TRACE_ARCHIVE_ENABLED", "0")  # scenario planner calls are not runs; never archive them
    scenarios = load_scenarios(set(args.only.split(",")) if args.only else None, args.split)
    rows = fixture_rows()
    needed_by_id = {
        rows[s["memory_bundle"]]["id"]: rows[s["memory_bundle"]]
        for s in scenarios
        if s.get("memory_bundle") and s["memory_bundle"] in rows
    }
    needed = list(needed_by_id.values())
    missing = [s["name"] for s in scenarios if s.get("memory_bundle") and s["memory_bundle"] not in rows]
    if missing:
        print(f"⚠ scenarios without a compressed memory in {SCENARIO_FIXTURE}: {missing}")
    await upsert_rows(base_url, api_key, needed)
    print(f"🧠 loaded {len(needed)} memory rows into {base_url}")
    history = await stats(base_url, api_key)
    print(f"📚 history table: {history}")
    observed = await fetch_rows(base_url, api_key, list(needed_by_id))
    require_isolated_history(history, needed, observed)
    arms = ("off", "on") if not args.on_only else ("on",)
    results: list[dict[str, Any]] = []
    semaphore = asyncio.Semaphore(args.concurrency)

    async def one(s: dict[str, Any]) -> dict[str, Any]:
        async with semaphore:
            r = await run_scenario(s, arms=arms, trials=args.trials)
            on = r["arms"].get("on", {})
            off = r["arms"].get("off", {})
            print(
                f"  {'✅' if r['verdict'] else '❌'} {r['name']:36} [{r['improvement']:7}/{r.get('split')}] "
                f"off={'ok' if off.get('passed') else 'x'} on={'ok' if on.get('passed') else 'x'} "
                f"mem={on.get('memories_retrieved', 0)} trials off={off.get('trial_pass_count', 0)}/{off.get('trials', 0)} on={on.get('trial_pass_count', 0)}/{on.get('trials', 0)} "
                f"{('; '.join(on.get('failures', []))[:160]) if not r['verdict'] else ''}",
                flush=True,
            )
            return r

    results = list(await asyncio.gather(*(one(s) for s in scenarios)))
    results.sort(key=lambda r: [s["name"] for s in scenarios].index(r["name"]))
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report = {
        "run_id": run_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": MODEL,
        "trials_per_arm": args.trials,
        "history_stats": history,
        "summary": summarize(results),
        "scenarios": results,
    }
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    out = RUNS_DIR / f"memory-scenarios-{run_id}.json"
    out.write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    dashboard = render_dashboard(report)
    print(json.dumps(report["summary"], indent=1))
    print(f"📄 report: {out}\n🖥  dashboard: {dashboard}")
    if not args.no_open:
        try:
            webbrowser.open(dashboard.as_uri())
        except Exception:
            pass
    return 0 if report["summary"]["passed"] == report["summary"]["total"] else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=3001)
    parser.add_argument("--only", default="")
    parser.add_argument("--split", choices=["fit", "held_out"], default=None)
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--on-only", action="store_true")
    parser.add_argument("--trials", type=int, default=1, help="Planner calls per arm; verdicts are majority votes")
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
