"""Regression tests for the Agent Display static checks (benchmarks/display_check.py).

Registered in the deploy path through tests/blackbox/benchmark.blackbox.py.
"""

from __future__ import annotations

import asyncio
import base64
import csv
import hashlib
import json
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

from benchmarks import display_check
from benchmarks.long_horizon import validate_catalog
from benchmarks.benchmark_tasks import BenchmarkTask, all_tasks
from benchmarks.run_benchmark import _run_declared_static_check
from benchmarks.select_predeploy_benches import KNOWN_DEPLOY_CATEGORIES, categories_triggered_by_paths
from domains.display.service import validate_tool_call

REPO_ROOT = Path(__file__).resolve().parents[2]
TASK_NAME = "agent-display-revenue-chart"
CSV_PATH = REPO_ROOT / "front-end/public/test-assets/orders-export-10d.csv"
EXPECTED = ["2342.78", "3203.32", "4033.28"]
# What an agent reports if it forgets to drop refunded/cancelled orders.
UNFILTERED = ["3206.75", "3773.63", "4682.17"]



def _chart_html(values: list[str]) -> str:
    """A displayed chart: float sums in the data array plus formatted labels."""
    float_sum = Decimal("-0.0000000000003")
    data = ", ".join(f"{{day:'2026-09-{21 + i}', revenue: {Decimal(v) + float_sum}}}" for i, v in enumerate(values))
    labels = "".join(f"<text>${Decimal(v):,.2f}</text>" for v in values)
    return (
        "<!doctype html><html><body><h1>Revenue, last 3 days</h1>"
        f"<script>const data = [{data}];</script>{labels}</body></html>"
    )


CHART_HTML = _chart_html(EXPECTED)


def _catalog_entry() -> dict:
    tasks = json.loads((REPO_ROOT / "agents/benchmarks/tasks.json").read_text())
    return next(t for t in tasks if t["name"] == TASK_NAME)


def _task() -> BenchmarkTask:
    return next(t for t in all_tasks() if t.name == TASK_NAME)


def _display_row(message_id: str, *, media_kind: str = "page", mime: str = "text/html", sha: str = "a" * 64) -> dict:
    pointer = {
        "id": f"fp-{message_id}",
        "storage_path": f"user-1/display/{sha}.html",
        "original_filename": "chart.html",
        "mime_type": mime,
        "size_bytes": 512,
        "created_at": "2026-10-23T00:00:00Z",
        "kind": media_kind,
    }
    if media_kind in {"page", "bundle"}:
        pointer["usercontent_url"] = f"https://ngrok.example/usercontent/display/root-1/{sha}.html"
    return {
        "id": message_id,
        "role": "ASSISTANT",
        "message": "Revenue chart",
        "file_pointer": pointer,
        "metadata": {
            "source": "display",
            "excludeFromModel": True,
            "display": {
                "placement": "inline",
                "kind": "media",
                "media_kind": media_kind,
                "canonical_id": f"dsp_{sha[:32]}",
                "sha256": sha,
                "mime_type": mime,
            },
        },
    }


def _completion(summary: str) -> dict:
    return {
        "role": "TOOL",
        "metadata": {
            "toolName": "completion_summary",
            "toolStatus": "FINISHED",
            "completionSummary": {"summary": summary, "outputs": []},
        },
    }


def _record(messages: list[dict]) -> dict:
    return {"agent": {"agent_id": "root-1", "status": "COMPLETED"}, "messages": messages}


def _hydrate(
    data: dict,
    *,
    pages: dict[str, bytes],
    tree: list[dict] | None = None,
    transcript: str | None = None,
) -> dict:
    fetched: list[str] = []

    async def tree_messages() -> list[dict]:
        return list(tree or [])

    async def fetch_usercontent(path: str) -> bytes | None:
        fetched.append(path)
        if path not in pages:
            raise RuntimeError(f"GET {path} returned HTTP 404")
        return pages[path]

    async def fetch_storage(path: str) -> bytes | None:
        return pages.get(path)

    async def transcribe_image(raw: bytes, mime: str) -> str:
        request = json.dumps(display_check.transcription_messages(raw, mime))
        assert not any(value in request for value in EXPECTED + UNFILTERED)
        return str(transcript)

    asyncio.run(
        display_check.hydrate_display_artifacts(
            data,
            tree_messages=tree_messages,
            fetch_usercontent=fetch_usercontent,
            fetch_storage=fetch_storage,
            transcribe_image=transcribe_image if transcript is not None else None,
        )
    )
    data["_fetched"] = fetched
    return data


def _evaluate(data: dict) -> dict[str, tuple[bool, str]]:
    task = _task()
    return {ev["id"]: _run_declared_static_check(task, ev, data) for ev in task.evaluators}


def test_display_fixture_expected_totals_match_csv():
    """The catalog's expected values are recomputed from the committed CSV, not trusted."""
    completed: dict[str, Decimal] = defaultdict(Decimal)
    everything: dict[str, Decimal] = defaultdict(Decimal)
    with CSV_PATH.open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        day = row["created_at"][:10]
        everything[day] += Decimal(row["amount_usd"])
        if row["status"] == "completed":
            completed[day] += Decimal(row["amount_usd"])
    last3 = sorted(completed)[-3:]
    assert last3 == ["2026-09-21", "2026-09-22", "2026-09-23"]
    assert [str(completed[d]) for d in last3] == EXPECTED
    assert [str(everything[d]) for d in last3] == UNFILTERED
    assert {r["status"] for r in rows} == {"completed", "refunded", "cancelled"}
    # No single order can be mistaken for a daily total.
    assert max(Decimal(r["amount_usd"]) for r in rows) < Decimal("1000")
    for evaluator in _catalog_entry()["evaluators"]:
        for check in evaluator["checks"]:
            if "expected_values" in check:
                assert check["expected_values"] == EXPECTED


def test_display_task_is_registered_in_catalog_and_selector():
    entry = _catalog_entry()
    assert entry["status"] == "ready" and entry["runner"] == "agent" and entry["bench"] == "pipeline-e2e"
    assert entry["attachment"] == CSV_PATH.name and CSV_PATH.is_file()
    assert entry["deploy_category"] == "display" and "display" in KNOWN_DEPLOY_CATEGORIES
    assert "today" not in entry["prompt"].lower()
    validate_catalog()
    from benchmarks import local

    # The code agent's E2B sandbox needs the public tunnel to publish to Agent Display.
    assert local.needs_public_tunnel([TASK_NAME]) is True
    assert local.needs_public_tunnel(["claude-code-agent"]) is False
    for path in (
        "agents/domains/display/handler.py",
        "agents/tools/prompts/display.py",
        "back-end/src/domains/agent-tools/displayService.ts",
        "back-end/src/providers/agentTools/displayBundle.ts",
    ):
        assert "display" in categories_triggered_by_paths([path]), path


def test_display_correct_chart_and_answer_pass():
    data = _record(
        [
            _display_row("m-1"),
            _completion("Daily revenue: Sep 21 $2,342.78, Sep 22 $3,203.32, Sep 23 $4,033.28."),
        ]
    )
    _hydrate(data, pages={f"/usercontent/display/root-1/{'a' * 64}.html": CHART_HTML.encode()})
    # The local backend is asked for the usercontent path, not the configured public host.
    assert data["_fetched"] == [f"/usercontent/display/root-1/{'a' * 64}.html"]
    results = _evaluate(data)
    assert all(ok for ok, _ in results.values()), results


def test_display_not_called_fails_display_checks():
    """Right answer in chat but nothing shown in Agent Display: red for the display reason."""
    data = _hydrate(
        _record([_completion("Daily revenue: 2,342.78 / 3,203.32 / 4,033.28 (chart saved to chart.html).")]),
        pages={},
    )
    results = _evaluate(data)
    ok, reason = results["display-shown"]
    assert not ok and "Agent Display showed 0 item(s)" in reason, reason
    ok, reason = results["displayed-daily-revenue"]
    assert not ok and "No displayed artifact content" in reason, reason
    assert results["final-answer-daily-revenue"][0]


def test_display_unfiltered_revenue_fails_figure_checks():
    wrong_html = _chart_html(UNFILTERED)
    data = _hydrate(
        _record([_display_row("m-1"), _completion("Totals: $3,206.75, $3,773.63, $4,682.17")]),
        pages={f"/usercontent/display/root-1/{'a' * 64}.html": wrong_html.encode()},
    )
    results = _evaluate(data)
    assert results["display-shown"][0]
    ok, reason = results["displayed-daily-revenue"]
    assert not ok and "missing" in reason, reason
    ok, reason = results["final-answer-daily-revenue"]
    assert not ok and "2342.78" in reason, reason


def test_display_raster_chart_is_read_through_a_vision_transcript():
    """A matplotlib PNG is a valid chart: its labels are transcribed, then matched as numbers."""
    png = _display_row("m-1", media_kind="image", mime="image/png", sha="b" * 64)
    png_path = png["file_pointer"]["storage_path"]
    labels = "Completed-order revenue\n2026-09-21\n$2,342.78\n2026-09-22\n$3,203.32\n2026-09-23\n$4,033.28"
    data = _hydrate(_record([png, _completion("2342.78 3203.32 4033.28")]), pages={png_path: b"PNG"}, transcript=labels)
    assert data["_benchmark"]["display_artifacts"][0]["text_source"] == "vision_transcript"
    results = _evaluate(data)
    assert all(ok for ok, _ in results.values()), results

    wrong = labels.replace("2,342.78", "3,206.75").replace("3,203.32", "3,773.63").replace("4,033.28", "4,682.17")
    data = _hydrate(_record([png]), pages={png_path: b"PNG"}, transcript=wrong)
    ok, reason = _evaluate(data)["displayed-daily-revenue"]
    assert not ok and "missing" in reason, reason

    # Without a transcriber the raster chart is shown but its figures are an evidence gap, never a pass.
    data = _hydrate(_record([png]), pages={png_path: b"PNG"})
    results = _evaluate(data)
    assert results["display-shown"][0]
    ok, reason = results["displayed-daily-revenue"]
    assert not ok and "vision transcriber" in reason, reason


def test_display_bundle_data_file_and_subagent_tree_rows():
    """Chart data in a bundle's data.js, displayed by a sub-agent and mirrored once per canonical id."""
    sha = "c" * 64
    row = _display_row("m-sub", media_kind="bundle", sha=sha)
    row["file_pointer"]["usercontent_url"] = f"http://localhost:9999/usercontent/display/sub-1/{sha}/index.html"
    entry_path = f"/usercontent/display/sub-1/{sha}/index.html"
    pages = {
        entry_path: b'<html><script src="./data.js"></script><script src="https://cdn.example/x.js"></script></html>',
        f"/usercontent/display/sub-1/{sha}/data.js": b"window.DATA=[2342.78,3203.32,4033.28];",
    }
    data = _hydrate(_record([_completion("2342.78 3203.32 4033.28")]), pages=pages, tree=[row, dict(row, id="dup")])
    artifacts = data["_benchmark"]["display_artifacts"]
    assert len(artifacts) == 1 and artifacts[0]["media_kind"] == "bundle"
    assert "https://cdn.example/x.js" not in "".join(data["_fetched"])
    results = _evaluate(data)
    assert all(ok for ok, _ in results.values()), results


def test_display_fetch_failure_is_an_evidence_gap_not_a_pass():
    data = _hydrate(_record([_display_row("m-1"), _completion("2342.78 3203.32 4033.28")]), pages={})
    assert "HTTP 404" in data["_benchmark"]["display_artifacts"][0]["fetch_error"]
    results = _evaluate(data)
    assert results["display-shown"][0]
    assert not results["displayed-daily-revenue"][0]


def test_display_root_inline_html_page_is_read():
    """A root's display(html=...) is one display.html page: the check reads it back by its content hash."""
    validation = validate_tool_call(
        {"tool": "display", "html": CHART_HTML},
        agent_id="root-1",
        user_id="user-1",
        workflow_id="wf-root-1",
        tool_call_id="call-1",
    )
    assert validation["ok"], validation
    [item] = validation["payload"]["items"]
    assert item["filename"] == "display.html", item
    page = base64.b64decode(item["content_base64"])
    sha = hashlib.sha256(page).hexdigest()
    row = _display_row("m-root", sha=sha)
    row["file_pointer"]["original_filename"] = "display.html"
    data = _hydrate(
        _record([row, _completion("2342.78 3203.32 4033.28")]),
        pages={f"/usercontent/display/root-1/{sha}.html": page},
    )
    assert data["_fetched"] == [f"/usercontent/display/root-1/{sha}.html"]
    results = _evaluate(data)
    assert all(ok for ok, _ in results.values()), results
