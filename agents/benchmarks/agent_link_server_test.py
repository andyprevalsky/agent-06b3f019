"""Tests for the central-hub mode of agent_link_server.

The hub is ONE persistent server over a runs-root: a run-index at ``/``, each
run's dashboard at ``/run/<id>/``, and cross-run ``/open-agent`` resolution that
prefers a durable static ``cloudbench-run.json`` over any live upstream.
"""

import json
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from benchmarks import agent_link_server as als


def _make_run(runs_root: Path, run_id: str, per_task: list) -> Path:
    """Create runs_root/<run_id>/_batch/report-card.json + dashboard.html."""
    batch = runs_root / run_id / "_batch"
    batch.mkdir(parents=True)
    (batch / "report-card.json").write_text(json.dumps({"per_task": per_task}))
    (batch / "dashboard.html").write_text("<html>DASH</html>")
    return runs_root / run_id


def _add_static_bench(run_dir: Path, bench: str, agent_id: str) -> None:
    """A bench dir with a durable cloudbench-run.json (survives box teardown)."""
    bd = run_dir / bench
    bd.mkdir(parents=True, exist_ok=True)
    (bd / "cloudbench-run.json").write_text(
        json.dumps({"tasks": [{"agent_id": agent_id, "status": "FAILED"}]})
    )


def _add_live_bench(run_dir: Path, bench: str, agent_id: str, url: str) -> None:
    """A bench dir with only a live upstream (mid-run, no run.json yet)."""
    bd = run_dir / bench
    bd.mkdir(parents=True, exist_ok=True)
    (bd / ".upstream.json").write_text(
        json.dumps(
            {
                "upstream_url": url,
                "upstream_api_key": "k",
                "upstream_user_id": "u",
                "machine_id": "m1",
                "app": "app1",
            }
        )
    )
    live = bd / "cloudbench-live"
    live.mkdir(exist_ok=True)
    (live / "report-card.json").write_text(
        json.dumps({"per_task": [{"agent_url": f"http://x/?agent-id={agent_id}"}]})
    )


def test_scan_runs_newest_first_with_status(tmp_path: Path) -> None:
    _make_run(
        tmp_path,
        "20260710-100000-1",
        [
            {"name": "a", "status": "pass", "world_model_mode": "real", "fast_mode": False},
            {"name": "b", "status": "running", "world_model_mode": "simulate", "fast_mode": True},
        ],
    )
    time.sleep(0.02)
    _make_run(tmp_path, "20260710-110000-2", [{"name": "c", "status": "pass"}])

    runs = als._scan_runs(tmp_path)
    assert [r["id"] for r in runs] == ["20260710-110000-2", "20260710-100000-1"]
    first = runs[1]
    assert (first["passed"], first["running"], first["total"]) == (1, 1, 2)
    assert first["live"] is True
    assert runs[0]["live"] is False


def test_scan_runs_ignores_underscore_dirs(tmp_path: Path) -> None:
    _make_run(tmp_path, "run-1", [{"name": "a", "status": "pass"}])
    (tmp_path / "_hub" / "viewers").mkdir(parents=True)  # infra dir, not a run
    runs = als._scan_runs(tmp_path)
    assert [r["id"] for r in runs] == ["run-1"]


def test_run_index_page_has_rows_flags_links_badges(tmp_path: Path) -> None:
    _make_run(
        tmp_path,
        "run-1",
        [
            {"name": "sim-task", "status": "running", "world_model_mode": "simulate", "fast_mode": True},
        ],
    )
    page = als._run_index_page(als._scan_runs(tmp_path)).decode()
    assert "Benchmark runs" in page
    assert "sim-task" in page
    assert "🧪" in page and "⚡" in page  # sim + fast flags
    assert "/run/run-1/dashboard.html" in page  # clickable into the run
    assert "LIVE" in page  # running badge


def test_run_index_empty_state(tmp_path: Path) -> None:
    page = als._run_index_page(als._scan_runs(tmp_path)).decode()
    assert "No runs yet" in page


def test_resolve_hub_prefers_static_over_live(tmp_path: Path) -> None:
    # newer run has the agent only as LIVE; older run has it as STATIC (durable).
    old = _make_run(tmp_path, "20260710-100000-1", [{"name": "b", "status": "failed"}])
    _add_static_bench(old, "b", "AGENT")
    time.sleep(0.02)
    new = _make_run(tmp_path, "20260710-110000-2", [{"name": "b", "status": "running"}])
    _add_live_bench(new, "b", "AGENT", "http://localhost:9999")

    src = als._resolve_hub_source(tmp_path, "AGENT")
    assert src is not None
    assert not src["upstream_url"], "static (durable) source must win over live"
    assert src["key"].startswith("20260710-100000-1--")


def test_resolve_hub_falls_back_to_live(tmp_path: Path) -> None:
    run = _make_run(tmp_path, "run-1", [{"name": "b", "status": "running"}])
    _add_live_bench(run, "b", "AGENT", "http://localhost:9999")
    src = als._resolve_hub_source(tmp_path, "AGENT")
    assert src is not None
    assert src["upstream_url"] == "http://localhost:9999"
    assert src["ssh_machine"] == "m1" and src["ssh_app"] == "app1"
    assert src["key"] == "run-1--b"


def test_resolve_hub_unknown_agent_is_none(tmp_path: Path) -> None:
    run = _make_run(tmp_path, "run-1", [{"name": "b", "status": "failed"}])
    _add_static_bench(run, "b", "AGENT")
    assert als._resolve_hub_source(tmp_path, "NOPE") is None
    assert als._resolve_hub_source(tmp_path, "") is None


# ── HTTP-level routing (real server on a free port) ──────────────────────────


@pytest.fixture
def hub_server(tmp_path: Path):
    import argparse

    run = _make_run(tmp_path, "run-1", [{"name": "b", "status": "failed"}])
    _add_static_bench(run, "b", "AGENT")

    args = argparse.Namespace(
        root=tmp_path,
        host="127.0.0.1",
        repo_root=Path.cwd(),
        context_dir=tmp_path / "_hub",
        frontend_dir=Path.cwd(),
        run_json=None,
        preferred_archive_port=8750,
        upstream_url="",
        upstream_api_key="",
        upstream_user_id="",
        fleet_dir=None,
        hub_runs_dir=tmp_path,
    )
    port = als._free_port(8730)
    server = ThreadingHTTPServer((args.host, port), als._make_handler(args))
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{port}"
    try:
        yield base
    finally:
        server.shutdown()


def _get(url: str):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=5) as r:
        return r.status, r.read().decode()


def test_http_run_index(hub_server: str) -> None:
    status, body = _get(hub_server + "/")
    assert status == 200
    assert "Benchmark runs" in body and "/run/run-1/dashboard.html" in body


def test_http_serve_run_dashboard(hub_server: str) -> None:
    status, body = _get(hub_server + "/run/run-1/dashboard.html")
    assert status == 200 and "DASH" in body


def test_http_serve_run_card(hub_server: str) -> None:
    status, body = _get(hub_server + "/run/run-1/report-card.json")
    assert status == 200
    assert json.loads(body)["per_task"][0]["name"] == "b"


def test_http_run_file_traversal_blocked(hub_server: str) -> None:
    # A path escaping the run's _batch dir must NOT leak files.
    try:
        status, _ = _get(hub_server + "/run/run-1/../../../../etc/hosts")
    except urllib.error.HTTPError as e:
        status = e.code
    assert status == 404


def test_http_open_agent_unknown_is_not_found(hub_server: str) -> None:
    # Unknown agent → honest NOT_FOUND page (200), never a dead redirect.
    status, body = _get(hub_server + "/open-agent?agent-id=NOPE")
    assert status == 200
    assert "isn't in any local run record" in body


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
