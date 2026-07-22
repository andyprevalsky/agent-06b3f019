"""Tests for the central-hub mode of agent_link_server.

The hub is ONE persistent server over a runs-root: a run-index at ``/``, each
run's dashboard at ``/run/<id>/``, and cross-run ``/open-agent`` resolution that
prefers a durable static ``cloudbench-run.json`` over any live upstream.
"""

import json
import multiprocessing
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from benchmarks import agent_link_server as als


def _hold_allocated_port(preferred: int, release, result) -> None:
    """Child-process helper proving the host launch lock spans allocation+bind."""
    with als._host_archive_launch_lock():
        port = als._free_port(preferred)
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", port))
        listener.listen(1)
    result.put(port)
    release.wait(10)
    listener.close()


def test_free_port_search_continues_past_first_hundred_candidates(monkeypatch) -> None:
    preferred = 12_000

    class FakeSocket:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def bind(self, address) -> None:
            if address[1] < preferred + 100:
                raise OSError("occupied")

        def close(self) -> None:
            pass

    monkeypatch.setattr(als.socket, "socket", FakeSocket)
    assert als._free_port(preferred) == preferred + 100


def test_free_port_wraps_after_65535_without_trying_invalid_ports(monkeypatch) -> None:
    attempted = []

    class FakeSocket:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def bind(self, address) -> None:
            attempted.append(address[1])
            if address[1] != 1024:
                raise OSError("occupied")

        def close(self) -> None:
            pass

    monkeypatch.setattr(als.socket, "socket", FakeSocket)
    assert als._free_port(65535) == 1024
    assert attempted == [65535, 1024]


def test_archive_port_pair_wraps_after_65535_and_remains_distinct(monkeypatch) -> None:
    attempted = []

    class FakeSocket:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def bind(self, address) -> None:
            attempted.append(address[1])
            if address[1] not in (65535, 1024):
                raise OSError("occupied")

        def close(self) -> None:
            pass

    monkeypatch.setattr(als.socket, "socket", FakeSocket)
    assert als._allocate_archive_ports(65535) == (65535, 1024)
    assert all(1024 <= port <= 65535 for port in attempted)


def test_host_launch_lock_gives_concurrent_processes_distinct_ports() -> None:
    ctx = multiprocessing.get_context("fork")
    release = ctx.Event()
    result = ctx.Queue()
    preferred = als._free_port(12_500)
    processes = [
        ctx.Process(target=_hold_allocated_port, args=(preferred, release, result))
        for _ in range(2)
    ]
    for process in processes:
        process.start()
    ports = [result.get(timeout=10) for _ in processes]
    release.set()
    for process in processes:
        process.join(10)
        assert process.exitcode == 0
    assert len(set(ports)) == 2


def test_existing_archive_requires_healthy_frontend_and_api(tmp_path: Path, monkeypatch) -> None:
    frontend = "http://127.0.0.1:13001"
    api = "http://127.0.0.1:13000"
    (tmp_path / "archive-frontend-live.json").write_text(
        json.dumps({"frontend_url": frontend, "api_url": api, "supervisor_pid": os.getpid()})
    )
    monkeypatch.setattr(als, "_healthy", lambda url: url == frontend)
    assert als._existing_archive_in(tmp_path) == ""
    monkeypatch.setattr(als, "_healthy", lambda url: url in (frontend, api))
    assert als._existing_archive_in(tmp_path) == frontend


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


def test_derive_run_name_summarizes_benches() -> None:
    # 1 bench → its name; ≤3 → joined; >3 → "first, second +N more"; dedupes.
    assert als._derive_run_name({"benches": [{"name": "browser-amazon-return"}]}) == (
        "browser-amazon-return"
    )
    assert als._derive_run_name({"benches": [{"name": "a"}, {"name": "b"}, {"name": "c"}]}) == (
        "a, b, c"
    )
    assert als._derive_run_name(
        {"benches": [{"name": "a"}, {"name": "b"}, {"name": "a"}, {"name": "c"}, {"name": "d"}]}
    ) == "a, b +2 more"
    assert als._derive_run_name({"benches": []}) == "run"


def test_run_index_page_shows_semantic_name_beside_id(tmp_path: Path) -> None:
    _make_run(
        tmp_path,
        "20260719-131303-17378",
        [
            {"name": "browser-amazon-return", "status": "passed"},
            {"name": "browser-hotel-booking", "status": "passed"},
        ],
    )
    page = als._run_index_page(als._scan_runs(tmp_path)).decode()
    # semantic name rendered prominently...
    assert "browser-amazon-return, browser-hotel-booking" in page
    # ...alongside (not instead of) the opaque run id
    assert "20260719-131303-17378" in page
    assert 'class="rn"' in page and 'class="id"' in page


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


def test_http_open_agent_reports_archive_port_exhaustion(
    hub_server: str, monkeypatch
) -> None:
    def fail_launch(*_args, **_kwargs):
        raise als.PortAllocationError("no free local port found")

    monkeypatch.setattr(als, "_launch_archive_for", fail_launch)
    with pytest.raises(urllib.error.HTTPError) as error:
        _get(hub_server + "/open-agent?agent-id=AGENT")
    assert error.value.code == 503
    body = error.value.read().decode()
    assert "No local user port is available" in body
    assert "http-equiv='refresh'" not in body
    assert error.value.headers["Retry-After"] == "5"
    status, index = _get(hub_server + "/")
    assert status == 200 and "Benchmark runs" in index


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
