"""Tests for the live benchmark dashboard (dashboard.py + dashboard.html).

Covers:
  - write_dashboard_asset writes valid HTML containing the poll logic.
  - DashboardServer serves report-card.json (write a fake one, GET it, 200 + body).
  - open_in_chrome builds the right per-platform argv (subprocess monkeypatched;
    no real browser launched).
  - maybe_launch_dashboard / dashboard_enabled gating returns None / False when
    disabled/CI/headless/opt-out.
"""

import json
import urllib.error
import urllib.request

from benchmarks.agent_link_server import _existing_archive_frontend
from benchmarks.dashboard import (
    DASHBOARD_ASSET_NAME,
    DashboardServer,
    _chrome_open_command,
    dashboard_enabled,
    maybe_launch_dashboard,
    open_in_chrome,
    write_dashboard_asset,
)

_SAMPLE_CARD = {
    "run_id": "run-xyz",
    "elapsed_s": 42.0,
    "world_model_mode": "simulate",
    "tasks": {"total": 2, "running": 1, "completed": 1, "queued": 0},
    "results": {"passed": 1, "failed": 0, "transient": 0, "success_rate": 1.0},
    "cost": {"agents_llm_usd": 0.12, "wmh_grounding_usd": None, "total_usd": 0.12, "fast_cache_hit_rate": None},
    "infra": None,
    "per_task": [
        {
            "name": "chat-mode",
            "status": "passed",
            "duration_s": 30.0,
            "cost_usd": 0.12,
            "agent_url": "http://localhost:5050/?agent-id=aaa",
        },
        {"name": "web-search", "status": "running", "duration_s": None, "cost_usd": None, "agent_url": None},
    ],
}


# --- write_dashboard_asset --------------------------------------------------


def test_write_dashboard_asset_writes_valid_html_with_poll_logic(tmp_path):
    ctx = tmp_path / "benchmarks" / "run-xyz"
    path = write_dashboard_asset(ctx)
    assert path.exists()
    assert path.name == DASHBOARD_ASSET_NAME
    html = path.read_text()
    # Structural HTML markers.
    assert html.lstrip().lower().startswith("<!doctype html>")
    assert "<html" in html and "</html>" in html
    # The polling contract: fetch report-card.json on an interval.
    assert "report-card.json" in html
    assert "setInterval" in html
    assert "fetch(" in html
    # State-machine diagram present per repo convention.
    assert "state machine" in html.lower()
    assert "waiting for first report" in html.lower()


def test_write_dashboard_asset_creates_missing_dirs(tmp_path):
    ctx = tmp_path / "a" / "b" / "c"
    path = write_dashboard_asset(ctx)
    assert path.exists()
    assert path.parent == ctx


# --- DashboardServer --------------------------------------------------------


def test_dashboard_server_serves_report_card_and_asset(tmp_path):
    write_dashboard_asset(tmp_path)
    (tmp_path / "report-card.json").write_text(json.dumps(_SAMPLE_CARD))

    server = DashboardServer(tmp_path).start()
    try:
        assert server.port > 0
        assert server.url == f"http://localhost:{server.port}/{DASHBOARD_ASSET_NAME}"

        # report-card.json is served with 200 + the exact body.
        with urllib.request.urlopen(f"http://127.0.0.1:{server.port}/report-card.json", timeout=3) as resp:
            assert resp.status == 200
            body = json.loads(resp.read().decode())
        assert body["run_id"] == "run-xyz"
        assert body["tasks"]["total"] == 2

        # The dashboard page itself is served.
        with urllib.request.urlopen(f"http://127.0.0.1:{server.port}/{DASHBOARD_ASSET_NAME}", timeout=3) as resp:
            assert resp.status == 200
            page = resp.read().decode()
        assert "report-card.json" in page
    finally:
        server.stop()


def test_dashboard_server_404_before_report_card_written(tmp_path):
    write_dashboard_asset(tmp_path)
    server = DashboardServer(tmp_path).start()
    try:
        raised = False
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{server.port}/report-card.json", timeout=3)
        except urllib.error.HTTPError as exc:
            raised = True
            assert exc.code == 404
        assert raised, "expected 404 for a not-yet-written report card"
    finally:
        server.stop()


def test_dashboard_server_stop_is_idempotent(tmp_path):
    server = DashboardServer(tmp_path).start()
    server.stop()
    server.stop()  # second stop must not raise


def test_dashboard_server_root_is_resolved_context_dir(tmp_path):
    ctx = tmp_path / "ctx"
    server = DashboardServer(ctx)
    try:
        assert server.root == ctx.resolve()
        assert ctx.exists()  # constructor creates the dir
    finally:
        server.stop()


# --- open_in_chrome (argv per platform, no real browser) --------------------


def test_open_in_chrome_macos_argv():
    calls = []

    def fake_runner(command, **kwargs):
        calls.append(command)

    assert open_in_chrome("http://localhost:9/x", system="Darwin", runner=fake_runner) is True
    assert calls == [["open", "-na", "Google Chrome", "--args", "--new-window", "http://localhost:9/x"]]


def test_open_in_chrome_linux_argv(monkeypatch):
    import benchmarks.dashboard as dash

    # Force a known Chrome binary to be "found".
    monkeypatch.setattr(
        dash.shutil, "which", lambda name: "/usr/bin/google-chrome" if name == "google-chrome" else None
    )
    calls = []

    def fake_runner(command, **kwargs):
        calls.append(command)

    assert open_in_chrome("http://localhost:9/x", system="Linux", runner=fake_runner) is True
    assert calls == [["google-chrome", "--new-window", "http://localhost:9/x"]]


def test_open_in_chrome_linux_falls_back_to_xdg_open(monkeypatch):
    import benchmarks.dashboard as dash

    monkeypatch.setattr(dash.shutil, "which", lambda name: "/usr/bin/xdg-open" if name == "xdg-open" else None)
    calls = []
    assert open_in_chrome("http://h/x", system="Linux", runner=lambda command, **kw: calls.append(command)) is True
    assert calls == [["xdg-open", "http://h/x"]]


def test_open_in_chrome_windows_argv():
    calls = []
    launched = open_in_chrome("http://h/x", system="Windows", runner=lambda command, **kw: calls.append(command))
    assert launched is True
    assert calls == [["cmd", "/c", "start", "", "chrome", "--new-window", "http://h/x"]]


def test_open_in_chrome_unknown_platform_returns_false():
    calls = []
    launched = open_in_chrome("http://h/x", system="Plan9", runner=lambda command, **kw: calls.append(command))
    assert launched is False
    assert calls == []


def test_open_in_chrome_linux_no_launcher_returns_false(monkeypatch):
    import benchmarks.dashboard as dash

    monkeypatch.setattr(dash.shutil, "which", lambda name: None)
    assert open_in_chrome("http://h/x", system="Linux", runner=lambda *a, **k: None) is False


def test_open_in_chrome_runner_exception_returns_false():
    def boom(command, **kwargs):
        raise OSError("no such binary")

    assert open_in_chrome("http://h/x", system="Darwin", runner=boom) is False


def test_chrome_open_command_url_is_last_arg():
    cmd = _chrome_open_command("http://localhost:1234/dashboard.html", system="Darwin")
    assert cmd is not None
    assert cmd[-1] == "http://localhost:1234/dashboard.html"


def test_existing_archive_frontend_ignores_dead_supervisor(tmp_path):
    context_dir = tmp_path / "ctx"
    context_dir.mkdir()
    # No metadata at all → nothing to reuse.
    assert _existing_archive_frontend(context_dir) == ""

    # Metadata pointing at a dead pid / unreachable url → not reused (so the
    # link server relaunches instead of redirecting to a dead port).
    (context_dir / "archive-frontend-live.json").write_text(
        json.dumps(
            {
                "supervisor_pid": 999999,  # not a live process
                "frontend_url": "http://localhost:1",  # nothing listening
            }
        )
    )
    assert _existing_archive_frontend(context_dir) == ""


def _link_server_args(tmp_path):
    import argparse

    root = tmp_path / "dash"
    root.mkdir()
    return argparse.Namespace(
        root=root,
        context_dir=tmp_path / "ctx2",
        repo_root=tmp_path,
        frontend_dir=tmp_path / "front-end",
        run_json=tmp_path / "run.json",
        preferred_archive_port=18775,
        upstream_url="",
        upstream_api_key="",
        upstream_user_id="",
    )


def _serve(handler_cls):
    import threading
    from http.server import ThreadingHTTPServer

    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def _no_redirect_opener():
    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_a, **_k):
            return None

    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def test_open_agent_redirects_to_running_archive_frontend(tmp_path):
    import os
    from http.server import BaseHTTPRequestHandler

    from benchmarks.agent_link_server import _make_handler

    # A stand-in "archive frontend" that answers 200 on / (health probe).
    class FakeFrontend(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *_a):
            return

    fake, fake_url = _serve(FakeFrontend)
    args = _link_server_args(tmp_path)
    args.context_dir.mkdir(parents=True)
    (args.context_dir / "archive-frontend-live.json").write_text(
        json.dumps({"supervisor_pid": os.getpid(), "frontend_url": fake_url, "api_url": fake_url, "live": True})
    )
    link, link_url = _serve(_make_handler(args))
    try:
        # /open-agent serves a loading page (NOT a bare 302): it confirms the agent
        # is served + warms Vite client-side, THEN redirects — so a click never
        # lands on a cold SPA that falls back to the home route.
        resp = urllib.request.urlopen(f"{link_url}/open-agent?agent-id=abc123", timeout=5)
        body = resp.read().decode()
        assert resp.status == 200
        assert fake_url in body            # redirect target embedded
        assert "abc123" in body            # the agent id
        assert "location.replace" in body  # client-side redirect once ready
        assert "/api/agents/" in body      # polls the archive API to confirm the agent first
    finally:
        link.shutdown()
        fake.shutdown()


def test_open_agent_head_is_503_when_no_archive_yet(tmp_path):
    from benchmarks.agent_link_server import _make_handler

    args = _link_server_args(tmp_path)  # no metadata → nothing running
    link, link_url = _serve(_make_handler(args))
    try:
        opener = _no_redirect_opener()
        req = urllib.request.Request(f"{link_url}/open-agent?agent-id=abc", method="HEAD")
        try:
            status = opener.open(req, timeout=5).status
        except urllib.error.HTTPError as err:
            status = err.code
        # Never a dead connection: a clean 503 (HEAD never spawns a viewer).
        assert status == 503
    finally:
        link.shutdown()


# --- gating -----------------------------------------------------------------


_GATING_ENV_VARS = (
    "CI",
    "GITHUB_ACTIONS",
    "CONTINUOUS_INTEGRATION",
    "BENCHMARK_NO_DASHBOARD",
    "BENCHMARK_ISOLATED_RUN",
)


def _clear_ci_env(monkeypatch):
    for var in _GATING_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    # Ensure a display so the non-CI path is reachable on Linux test runners.
    monkeypatch.setenv("DISPLAY", ":0")


def test_dashboard_enabled_default_true_interactive(monkeypatch):
    _clear_ci_env(monkeypatch)
    assert dashboard_enabled() is True


def test_dashboard_enabled_false_when_ci_flag(monkeypatch):
    _clear_ci_env(monkeypatch)
    assert dashboard_enabled(ci=True) is False


def test_dashboard_enabled_false_when_ci_env(monkeypatch):
    _clear_ci_env(monkeypatch)
    monkeypatch.setenv("CI", "true")
    assert dashboard_enabled() is False


def test_dashboard_enabled_false_when_github_actions(monkeypatch):
    _clear_ci_env(monkeypatch)
    monkeypatch.setenv("GITHUB_ACTIONS", "1")
    assert dashboard_enabled() is False


def test_dashboard_enabled_false_when_opt_out_env(monkeypatch):
    _clear_ci_env(monkeypatch)
    monkeypatch.setenv("BENCHMARK_NO_DASHBOARD", "1")
    assert dashboard_enabled() is False


def test_dashboard_enabled_false_when_headless_linux(monkeypatch):
    import benchmarks.dashboard as dash

    _clear_ci_env(monkeypatch)
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    monkeypatch.setattr(dash.platform, "system", lambda: "Linux")
    assert dashboard_enabled() is False


def test_dashboard_enabled_true_headless_check_skipped_on_macos(monkeypatch):
    import benchmarks.dashboard as dash

    _clear_ci_env(monkeypatch)
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setattr(dash.platform, "system", lambda: "Darwin")
    assert dashboard_enabled() is True


# --- maybe_launch_dashboard -------------------------------------------------


def test_maybe_launch_dashboard_disabled_returns_none(tmp_path):
    assert maybe_launch_dashboard(tmp_path, enabled=False) is None
    # No asset written when disabled.
    assert not (tmp_path / DASHBOARD_ASSET_NAME).exists()


def test_maybe_launch_dashboard_optin_opens_browser(tmp_path, monkeypatch):
    import benchmarks.dashboard as dash

    opened = []
    monkeypatch.setattr(dash, "open_in_chrome", lambda url: opened.append(url) or True)
    logs = []
    server = maybe_launch_dashboard(tmp_path, enabled=True, open_browser=True, stream=logs.append)
    assert server is not None
    try:
        assert (tmp_path / DASHBOARD_ASSET_NAME).exists()
        assert opened == [server.url]
        assert any("live at" in line for line in logs)
        assert any("Chrome" in line for line in logs)
    finally:
        server.stop()


def test_maybe_launch_dashboard_default_does_not_open_browser(tmp_path, monkeypatch):
    import benchmarks.dashboard as dash

    opened = []
    monkeypatch.setattr(dash, "open_in_chrome", lambda url: opened.append(url) or True)
    server = maybe_launch_dashboard(tmp_path, enabled=True, stream=lambda _m: None)
    assert server is not None
    try:
        assert opened == []
    finally:
        server.stop()


def test_maybe_launch_dashboard_logs_when_chrome_fails(tmp_path, monkeypatch):
    import benchmarks.dashboard as dash

    monkeypatch.setattr(dash, "open_in_chrome", lambda url: False)
    logs = []
    server = maybe_launch_dashboard(tmp_path, enabled=True, open_browser=True, stream=logs.append)
    assert server is not None
    try:
        assert any("could not auto-open" in line for line in logs)
    finally:
        server.stop()
