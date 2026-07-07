"""Live benchmark dashboard: an HTTP-served report-card viewer for LOCAL runs.

When a benchmark is run interactively via `scripts/run-bench` (through
`local.py`), this module:

  1. Copies the self-contained `dashboard.html` into the run's context dir
     (the same dir `report_card.py` atomically writes `report-card.json` to).
  2. Serves that dir over HTTP on a free port (so the page can `fetch()` the
     JSON — `file://` cannot).
  3. Opens the dashboard URL in a NEW Chrome window for the human running the
     benchmark. Chrome is product behavior here — NOT the Claude browser MCP.

Design contract:
  - PURE-ish + testable: no global state, injected/overridable subprocess call
    for `open_in_chrome`, port-0 binding so tests never need a fixed port.
  - Gating lives in `maybe_launch_dashboard`: it returns None (no server, no
    browser) under CI / headless / opt-out conditions. It must NEVER pop a
    browser during deploy/CI/smoke automation.
  - `DashboardServer` runs its HTTP server on a daemon thread and shuts down
    cleanly via `.stop()`; teardown leaves the Chrome window open so the final
    card stays visible.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

_THIS_DIR = Path(__file__).resolve().parent
_DASHBOARD_HTML_SRC = _THIS_DIR / "dashboard.html"
DASHBOARD_ASSET_NAME = "dashboard.html"


def write_dashboard_asset(context_dir: os.PathLike | str) -> Path:
    """Copy `dashboard.html` into the run's context dir; return its path.

    The dashboard fetches `report-card.json` from its own directory, so the
    asset must sit alongside the report card in `context_dir`.
    """
    directory = Path(context_dir)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / DASHBOARD_ASSET_NAME
    shutil.copyfile(_DASHBOARD_HTML_SRC, target)
    return target


class _QuietHandler(SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler that doesn't spam stderr with request logs."""

    def log_message(self, format_str: str, *args: object) -> None:
        # Intentionally silent: the dashboard polls ~every 3s; logging each GET
        # would flood the benchmark's own stdout/stderr.
        return


class DashboardServer:
    """A tiny ThreadingHTTPServer rooted at a benchmark run's context dir.

    Serves `dashboard.html` + `report-card.json` (and any sibling assets) so the
    page can `fetch()` the JSON over HTTP. Binds to a free port (port 0 unless a
    preferred port is supplied) and runs on a daemon thread.
    """

    def __init__(self, context_dir: os.PathLike | str, *, port: int = 0, host: str = "127.0.0.1") -> None:
        self._root = Path(context_dir).resolve()
        self._root.mkdir(parents=True, exist_ok=True)
        # partial(..., directory=...) roots SimpleHTTPRequestHandler at our dir
        # without a chdir (which would race across threads / other servers).
        handler = partial(_QuietHandler, directory=str(self._root))
        self._httpd = ThreadingHTTPServer((host, port), handler)
        self._host = host
        self._thread = threading.Thread(
            target=self._httpd.serve_forever,
            name="benchmark-dashboard-server",
            daemon=True,
        )
        self._started = False

    @property
    def port(self) -> int:
        """The actual bound port (resolved even when constructed with port=0)."""
        return int(self._httpd.server_address[1])

    @property
    def root(self) -> Path:
        return self._root

    @property
    def url(self) -> str:
        """Deep link to the dashboard page served by this server."""
        return f"http://localhost:{self.port}/{DASHBOARD_ASSET_NAME}"

    def start(self) -> "DashboardServer":
        if not self._started:
            self._thread.start()
            self._started = True
        return self

    def stop(self) -> None:
        """Shut the server down cleanly and join its thread.

        `shutdown()` blocks until `serve_forever()` returns, so it must ONLY be
        called when the serve loop was actually started — otherwise it deadlocks
        waiting on an event the loop never sets. `server_close()` is always safe
        and idempotent, closing the listening socket.
        """
        if self._started:
            try:
                self._httpd.shutdown()
            except Exception:
                pass
            self._started = False
            if self._thread.is_alive():
                self._thread.join(timeout=5)
        try:
            self._httpd.server_close()
        except Exception:
            pass


def _chrome_open_command(url: str, *, system: str) -> Optional[list[str]]:
    """Build the per-platform argv that opens `url` in a NEW Chrome window.

    Returns None when no known launcher exists for the platform, in which case
    the caller should treat the launch as a best-effort no-op.
    """
    if system == "Darwin":
        # `open -na "Google Chrome"` forces a new app instance/window; --args
        # forwards the rest to Chrome.
        return ["open", "-na", "Google Chrome", "--args", "--new-window", url]
    if system == "Linux":
        for binary in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
            if shutil.which(binary):
                return [binary, "--new-window", url]
        if shutil.which("xdg-open"):
            # xdg-open ignores browser-specific flags but still opens a window.
            return ["xdg-open", url]
        return None
    if system == "Windows":
        # `start` is a cmd builtin; the empty "" is the (required) window title.
        return ["cmd", "/c", "start", "", "chrome", "--new-window", url]
    return None


def open_in_chrome(url: str, *, system: Optional[str] = None, runner=subprocess.Popen) -> bool:
    """Open `url` in a NEW Chrome window, cross-platform. Best-effort.

    Returns True iff a launcher command was found and dispatched without an
    immediate error. `system` and `runner` are injectable for testing.
    """
    resolved_system = system if system is not None else platform.system()
    command = _chrome_open_command(url, system=resolved_system)
    if command is None:
        return False
    try:
        runner(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return False
    return True


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _ci_env_active() -> bool:
    # Common CI signals. GitHub Actions sets both CI and GITHUB_ACTIONS.
    return _truthy_env("CI") or _truthy_env("GITHUB_ACTIONS") or _truthy_env("CONTINUOUS_INTEGRATION")


def _has_display() -> bool:
    """True iff a graphical session is plausibly available.

    macOS/Windows are assumed to have a display. On Linux we require DISPLAY or
    WAYLAND_DISPLAY so headless CI containers never try to pop a browser.
    """
    system = platform.system()
    if system in {"Darwin", "Windows"}:
        return True
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def dashboard_enabled(*, ci: bool = False) -> bool:
    """Resolve whether the dashboard should launch for this run.

    DISABLED when ANY of:
      - `ci=True` (the caller's --ci flag) or a CI env var is set,
      - BENCHMARK_NO_DASHBOARD=1 (explicit opt-out),
      - BENCHMARK_ISOLATED_RUN is set AND this is a headless/CI context
        (isolated runs from deploy/smoke automation must never pop a browser),
      - no graphical display is available.
    """
    if ci or _ci_env_active():
        return False
    if _truthy_env("BENCHMARK_NO_DASHBOARD"):
        return False
    if not _has_display():
        return False
    # Isolated runs are legitimate interactive local runs (that's the normal
    # `run-bench` path), so isolation alone does NOT disable the dashboard.
    # It's only disabled when isolation coincides with a CI/headless context,
    # already caught by the checks above.
    return True


def maybe_launch_dashboard(
    context_dir: os.PathLike | str,
    *,
    enabled: bool = True,
    open_browser: bool = True,
    stream=print,
) -> Optional[DashboardServer]:
    """Single entry point local.py calls on run start.

    Writes the dashboard asset, starts the HTTP server, and (best-effort) opens
    Chrome. Returns the running DashboardServer, or None when disabled/failed.

    `enabled` is the caller's resolved gate (already ANDed with `dashboard_enabled`
    at the call site); passing enabled=False short-circuits to None.
    """
    if not enabled:
        return None
    try:
        write_dashboard_asset(context_dir)
        server = DashboardServer(context_dir).start()
    except Exception as exc:  # pragma: no cover - defensive; never crash a run
        _emit(stream, f"[dashboard] failed to start (non-fatal): {exc}")
        return None

    _emit(stream, f"[dashboard] live at {server.url}")
    if open_browser:
        if open_in_chrome(server.url):
            _emit(stream, "[dashboard] opened in a new Chrome window")
        else:
            _emit(stream, f"[dashboard] could not auto-open Chrome; open manually: {server.url}")
    return server


def _emit(stream, message: str) -> None:
    try:
        stream(message)
    except Exception:  # pragma: no cover - stream must never crash a run
        print(message, file=sys.stderr)
