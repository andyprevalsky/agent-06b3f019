#!/usr/bin/env python3
"""Serve the benchmark dashboard plus a durable, RLS-free agent-open redirect.

Clicking "open" on any dashboard row (running or finished) hits ``/open-agent``
here. We resolve it to ONE reused benchmark *archive* frontend — never the box's
real frontend. The real frontend is RLS-blocked for benchmark agents: agents are
owned by the runner user, not the frontend's auto-login user, so the box would
render an empty/errored view (the "dead localhost" symptom).

The archive frontend bypasses RLS by design:
  * During a run, its archive API proxies live reads to the box backend using the
    benchmark API key (``X-API-Key`` + ``X-User-Id`` → sees the runner's agents).
  * After the box is torn down, the same server serves the saved ``run.json``
    (hot-reloaded), so the link keeps working.

The archive frontend is launched lazily on the first click and reused for every
later click (one Vite process, not one per click). If it is still warming up we
return a tiny auto-refreshing page — so a click NEVER lands on a dead localhost.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.error
import urllib.request
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Serialize archive-frontend launches across handler threads so concurrent first
# clicks spawn ONE Vite process, not several (the user's "no wasted resources").
_LAUNCH_LOCK = threading.Lock()

# A hub is durable, but its generated localhost viewers are a bounded cache. Each
# viewer owns one archive API and one Vite process; leaving one pair per clicked
# source forever exhausts both ports and memory as historical runs accumulate.
_MAX_ARCHIVE_VIEWERS = 16
_VIEWER_METADATA_NAMES = ("archive-frontend-live.json", "archive-frontend.json")

# Never route a localhost health/redirect probe through an ambient HTTP proxy.
_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class PortAllocationError(RuntimeError):
    """No local user port is available for a benchmark archive viewer."""


@contextmanager
def _host_archive_launch_lock():
    """Serialize viewer port selection and launch across all local hub processes."""
    lock_path = Path(tempfile.gettempdir()) / f"navi-cloudbench-archive-launch-{os.getuid()}.lock"
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(lock_path, flags, 0o600)
    with os.fdopen(fd, "a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _healthy(url: str) -> bool:
    if not url:
        return False
    try:
        with _DIRECT_OPENER.open(url.rstrip("/") + "/", timeout=1.5) as resp:
            return 200 <= int(resp.status) < 500
    except urllib.error.HTTPError as exc:
        # An API root commonly has no route and answers 404. That is still a
        # complete HTTP response proving the listener is bound and serving.
        return int(exc.code) < 500
    except Exception:
        return False


def _free_port(preferred: int, exclude: set[int] | None = None) -> int:
    if not 1024 <= preferred <= 65535:
        raise ValueError("preferred local port must be between 1024 and 65535")
    # Archive viewers are intentionally durable across benchmark epochs. A
    # fixed preferred+99 window therefore fills even though the host still has
    # thousands of valid user ports. Search the complete user-port space,
    # preserving the preferred high range first and wrapping only if needed.
    excluded = exclude or set()
    for candidates in (range(preferred, 65536), range(1024, preferred)):
        for port in candidates:
            if port in excluded:
                continue
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                sock.close()
                continue
            sock.close()
            return port
    # If every explicit user port raced occupied between selection attempts,
    # give the kernel a bounded chance to choose an ephemeral port. Preserve
    # pair exclusion because port zero can return the API port selected just
    # before the frontend allocation.
    for _ in range(10):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind(("127.0.0.1", 0))
        except OSError:
            sock.close()
            continue
        assigned = int(sock.getsockname()[1])
        sock.close()
        if assigned not in excluded:
            return assigned
    raise PortAllocationError("no free local port found")


def _allocate_archive_ports(preferred: int) -> tuple[int, int]:
    """Select a distinct API/frontend pair, wrapping safely at port 65535."""
    api_port = _free_port(preferred)
    frontend_start = 1024 if api_port == 65535 else api_port + 1
    frontend_port = _free_port(frontend_start, {api_port})
    return api_port, frontend_port


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _metadata_pid(metadata: dict) -> int:
    try:
        return max(0, int(metadata.get("supervisor_pid") or 0))
    except (TypeError, ValueError):
        return 0


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        # Fail closed on permission/transient probe errors: an unverified PID is
        # never safe to forget, overwrite, or recycle.
        return True
    try:
        state = subprocess.check_output(
            ["ps", "-p", str(pid), "-o", "stat="],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except Exception:
        return True
    return not state.startswith("Z")


def _viewer_context_from_command(pid: int, command: str) -> Path | None:
    """Resolve one archive supervisor's exact context, including legacy relative paths."""
    marker = " --context-dir "
    if "archive_frontend.py" not in command or marker not in command:
        return None
    context_argument = command.split(marker, 1)[1].split(" --host ", 1)[0]
    candidate = Path(context_argument)
    if candidate.is_absolute():
        return candidate.resolve()

    # Older hubs passed relative paths. Resolve those against the candidate
    # process's cwd, not this hub's cwd, so stale metadata can never target a
    # same-named viewer belonging to another Conductor workspace.
    try:
        cwd_record = subprocess.check_output(
            ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None
    cwd = next((line[1:] for line in cwd_record.splitlines() if line.startswith("n")), "")
    return (Path(cwd) / candidate).resolve() if cwd else None


def _viewer_pid_is_owned(pid: int, context_dir: Path) -> bool:
    """Confirm a metadata PID still names this exact archive supervisor."""
    try:
        command = subprocess.check_output(
            ["ps", "-ww", "-p", str(pid), "-o", "command="],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except Exception:
        return False
    return _viewer_context_from_command(pid, command) == context_dir.resolve()


def _viewer_processes_by_context(viewers_root: Path) -> tuple[dict[Path, list[int]], bool]:
    """Discover every exact-owned supervisor, including metadata-overwritten duplicates."""
    root = viewers_root.resolve()
    found: dict[Path, list[int]] = {}
    try:
        process_table = subprocess.check_output(
            ["ps", "-ww", "-axo", "pid=,command="],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return found, False
    for line in process_table.splitlines():
        raw_pid, separator, command = line.strip().partition(" ")
        if (
            not separator
            or "archive_frontend.py" not in command
            or " --context-dir " not in command
        ):
            continue
        try:
            pid = int(raw_pid)
        except ValueError:
            continue
        context_dir = _viewer_context_from_command(pid, command)
        if context_dir is None:
            # A relative supervisor whose cwd cannot be established might belong
            # to this hub. Never treat an incomplete inventory as an empty one.
            return found, False
        if context_dir.parent != root:
            continue
        found.setdefault(context_dir, []).append(pid)
    return found, True


def _remove_viewer_context(viewers_root: Path, context_dir: Path) -> None:
    """Remove only a generated child of this hub's viewer-cache directory."""
    root = viewers_root.resolve()
    target = context_dir.resolve()
    if target.parent == root:
        shutil.rmtree(target, ignore_errors=True)


def _terminate_viewer(context_dir: Path, pid: int) -> bool:
    if not _viewer_pid_is_owned(pid, context_dir):
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    return _wait_for_pid_exit(pid)


def _wait_for_pid_exit(pid: int) -> bool:
    """Confirm the supervisor ran its child-process-group shutdown handler."""
    for _ in range(100):
        if not _pid_alive(pid):
            return True
        time.sleep(0.05)
    return not _pid_alive(pid)


def _reap_excess_viewers(viewers_root: Path, launching_context: Path) -> tuple[list[int], bool]:
    """Recycle a target and reserve one bounded slot without losing ownership."""
    viewers_root.mkdir(parents=True, exist_ok=True)
    launching_context = launching_context.resolve()
    discovered, discovery_complete = _viewer_processes_by_context(viewers_root)
    if not discovery_complete:
        return [], False
    active: list[tuple[float, Path, list[int], bool]] = []
    terminated: list[int] = []
    launching_blocked = False

    stored_contexts = {path.resolve() for path in viewers_root.iterdir() if path.is_dir()}
    for context_dir in sorted(stored_contexts | set(discovered)):
        pid_access: dict[int, float] = {pid: 0.0 for pid in discovered.get(context_dir, [])}
        last_access = 0.0
        unknown_owner = False
        had_metadata = False
        for metadata_name in _VIEWER_METADATA_NAMES:
            metadata_path = context_dir / metadata_name
            if not metadata_path.exists():
                continue
            had_metadata = True
            metadata = _read_json(metadata_path)
            try:
                accessed_at = metadata_path.stat().st_mtime
            except OSError:
                accessed_at = 0.0
            last_access = max(last_access, accessed_at)
            pid = _metadata_pid(metadata)
            if not pid:
                # Corrupt/incomplete metadata may still belong to a running
                # viewer. Count it conservatively but never guess what to kill.
                unknown_owner = True
                continue
            if pid and _pid_alive(pid):
                pid_access[pid] = max(accessed_at, pid_access.get(pid, 0.0))

        pids = list(pid_access)
        if not pids and not unknown_owner:
            # No metadata is the just-created launch directory; dead, valid
            # metadata is stale and safe to remove.
            if context_dir != launching_context or had_metadata:
                _remove_viewer_context(viewers_root, context_dir)
            continue

        if context_dir == launching_context:
            # The caller's two health checks already failed. Do not overwrite its
            # metadata and strand an alive-but-unhealthy supervisor on every retry.
            remaining: list[int] = []
            for pid in pids:
                if _terminate_viewer(context_dir, pid):
                    terminated.append(pid)
                else:
                    remaining.append(pid)
            if not remaining and not unknown_owner:
                _remove_viewer_context(viewers_root, context_dir)
            else:
                active.append((last_access, context_dir, remaining, unknown_owner))
                launching_blocked = True
            continue

        active.append((last_access, context_dir, pids, unknown_owner))

    # Count supervisors, not directories: interrupted mode switches can leave two
    # metadata owners in one context. An unknown owner reserves one safe slot.
    active_units = sum(len(pids) + int(unknown) for _at, _ctx, pids, unknown in active)
    for _accessed_at, context_dir, pids, unknown_owner in sorted(active, key=lambda entry: entry[0]):
        if active_units <= _MAX_ARCHIVE_VIEWERS - 1:
            break
        remaining: list[int] = []
        for pid in pids:
            if _terminate_viewer(context_dir, pid):
                terminated.append(pid)
                active_units -= 1
            else:
                remaining.append(pid)
        if not remaining and not unknown_owner:
            _remove_viewer_context(viewers_root, context_dir)

    slot_available = not launching_blocked and active_units <= _MAX_ARCHIVE_VIEWERS - 1
    return terminated, slot_available


def _existing_archive_frontend(context_dir: Path) -> str:
    """URL of the already-running archive frontend if it is healthy, else ''."""
    meta = _read_json(context_dir / "archive-frontend-live.json")
    url = str(meta.get("frontend_url") or "")
    api = str(meta.get("api_url") or "")
    pid = _metadata_pid(meta)
    if url and api and pid and _pid_alive(pid) and _healthy(url) and _healthy(api):
        return url.rstrip("/")
    return ""


def _run_json_has_agent(run_json: Path, agent_id: str) -> bool:
    run = _read_json(run_json)
    return any(str(t.get("agent_id") or "") == agent_id for t in run.get("tasks", []))


def _card_has_agent(bench_dir: Path, agent_id: str) -> bool:
    card = _read_json(bench_dir / "cloudbench-live" / "report-card.json")
    return any(agent_id in str(t.get("agent_url") or "") for t in card.get("per_task", []))


def _resolve_fleet_source(fleet_dir: Path, agent_id: str) -> dict | None:
    """Find which bench owns ``agent_id`` and how to serve it, DURABLY.

    Prefers the bench's saved ``cloudbench-run.json`` (fully local — survives box
    teardown, reap, and even a later session), else the bench's live upstream
    (mid-run, before run.json is written). Returns a source dict or None.
    """
    if not agent_id or not fleet_dir.is_dir():
        return None
    live: dict | None = None
    for sub in sorted(p for p in fleet_dir.iterdir() if p.is_dir() and p.name != "_batch"):
        rj = sub / "cloudbench-run.json"
        if rj.exists() and _run_json_has_agent(rj, agent_id):
            return {"key": sub.name, "run_json": rj, "upstream_url": "",
                    "upstream_api_key": "", "upstream_user_id": ""}
        if live is None:
            up = _read_json(sub / ".upstream.json")
            if up.get("upstream_url") and _card_has_agent(sub, agent_id):
                # Always hand over the run.json PATH (even before it exists): the
                # archive hot-reloads it the moment run-bench-cloud saves it, so the
                # viewer survives the box/upstream teardown without going dead.
                live = {"key": sub.name, "run_json": rj,
                        "upstream_url": up.get("upstream_url", ""),
                        "upstream_api_key": up.get("upstream_api_key", ""),
                        "upstream_user_id": up.get("upstream_user_id", ""),
                        "ssh_machine": up.get("machine_id", ""),
                        "ssh_app": up.get("app", "")}
    return live


def _resolve_hub_source(runs_dir: Path, agent_id: str) -> dict | None:
    """Resolve an agent across EVERY run under the hub's runs-root.

    Prefers a static ``cloudbench-run.json`` (durable — survives box teardown) from
    any run, else the newest live upstream. The viewer key is namespaced by run id
    so identical bench names across runs never collide in the viewers cache.
    """
    if not agent_id or not runs_dir.is_dir():
        return None
    live: dict | None = None
    runs = sorted(
        (p for p in runs_dir.iterdir() if p.is_dir() and not p.name.startswith("_")),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for rd in runs:
        src = _resolve_fleet_source(rd, agent_id)
        if not src:
            continue
        src = dict(src)
        src["key"] = f"{rd.name}--{src['key']}"
        if not src.get("upstream_url"):
            return src  # static/durable — always the best answer, take it now
        if live is None:
            live = src
    return live


_MODE_FLAG = {"simulate": "🧪", "shadow": "👁️"}


def _run_status(per_task: list) -> tuple[int, int, int]:
    """(passed, running, total) over a run's per_task rows."""
    total = len(per_task)
    passed = sum(
        1
        for t in per_task
        if str(t.get("status", "")).lower() in ("pass", "passed", "ok", "success")
    )
    running = sum(
        1
        for t in per_task
        if str(t.get("status", "")).lower() in ("running", "queued", "in_progress", "starting")
    )
    return passed, running, total


def _scan_runs(runs_dir: Path) -> list[dict]:
    """Every run under the hub's runs-root, newest first, with a status summary."""
    out: list[dict] = []
    if not runs_dir.is_dir():
        return out
    for rd in runs_dir.iterdir():
        if not rd.is_dir() or rd.name.startswith("_"):
            continue
        card_path = rd / "_batch" / "report-card.json"
        card = _read_json(card_path)
        per_task = card.get("per_task") or []
        passed, running, total = _run_status(per_task)
        try:
            mtime = card_path.stat().st_mtime if card_path.exists() else rd.stat().st_mtime
        except OSError:
            mtime = 0.0
        benches = [
            {
                "name": t.get("name"),
                "status": str(t.get("status") or ""),
                "mode": str(t.get("world_model_mode") or ""),
                "fast": bool(t.get("fast_mode")),
            }
            for t in per_task
        ]
        out.append(
            {
                "id": rd.name,
                "passed": passed,
                "running": running,
                "total": total,
                "benches": benches,
                "mtime": mtime,
                "live": running > 0,
            }
        )
    out.sort(key=lambda r: r["mtime"], reverse=True)
    return out


def _derive_run_name(run: dict) -> str:
    """Human-readable label for a run, shown next to the opaque run id so the
    hub reads semantically instead of as a wall of `<date>-<pid>` ids. Derived
    from the run's (deduped) bench names — 1 shows its name, <=3 join with
    commas, longer slices summarize as "first, second +N more". Mirrors the
    frontend deriveRunName (front-end/src/features/benchmarks/RunsPane.tsx)."""
    names: list[str] = []
    for b in run.get("benches") or []:
        n = str(b.get("name") or "").strip()
        if n and n not in names:
            names.append(n)
    if not names:
        return "run"
    if len(names) <= 3:
        return ", ".join(names)
    return f"{', '.join(names[:2])} +{len(names) - 2} more"


def _run_index_page(runs: list[dict]) -> bytes:
    """The central hub landing page: every run at a glance, click into any run."""
    rows = []
    for r in runs:
        flags = ""
        for b in r["benches"]:
            f = _MODE_FLAG.get(b["mode"].lower(), "")
            if b["fast"]:
                f += "⚡"
            if f:
                flags += f'<span class="bf" title="{html_escape(b["name"])}">{f}</span>'
        names = ", ".join(html_escape(str(b["name"])) for b in r["benches"][:6]) or "—"
        if len(r["benches"]) > 6:
            names += f" +{len(r['benches']) - 6}"
        if r["live"]:
            badge = '<span class="b live">● LIVE</span>'
        elif r["total"] and r["passed"] == r["total"]:
            badge = '<span class="b pass">✓ ALL PASS</span>'
        elif r["total"]:
            badge = f'<span class="b fail">{r["passed"]}/{r["total"]}</span>'
        else:
            badge = '<span class="b idle">—</span>'
        rows.append(
            f'<tr onclick="location.href=\'/run/{urllib.parse.quote(r["id"])}/dashboard.html\'">'
            f'<td class="run"><span class="rn">{html_escape(_derive_run_name(r))}</span>'
            f'<span class="id">{html_escape(r["id"])}</span></td>'
            f"<td>{badge}</td>"
            f'<td class="n">{r["total"]}</td>'
            f'<td class="fl">{flags}</td>'
            f'<td class="bn">{names}</td>'
            f"</tr>"
        )
    body = (
        "".join(rows)
        or '<tr><td colspan="5" class="empty">No runs yet — start one with '
        "<code>scripts/run-bench-fleet &lt;task&gt;</code></td></tr>"
    )
    html = _RUN_INDEX_TEMPLATE.replace("__ROWS__", body).replace("__COUNT__", str(len(runs)))
    return html.encode("utf-8")


def html_escape(s: str) -> str:
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


_RUN_INDEX_TEMPLATE = """<!doctype html><html><head><meta charset="utf-8">
<title>Benchmark runs</title><meta http-equiv="refresh" content="6">
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#fafafa;color:#121218}
header{padding:22px 28px 14px;border-bottom:1px solid #ececf0;background:#fff}
h1{margin:0;font-size:19px;font-weight:650}.sub{color:#6f6f7b;font-size:13px;margin-top:3px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;padding:10px 16px;color:#6f6f7b;font-weight:600;font-size:12px;
   text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #ececf0}
td{padding:13px 16px;border-bottom:1px solid #f2f2f5}
tr[onclick]{cursor:pointer}tr[onclick]:hover td{background:#f6f6f9}
td.run .rn{display:block;font-size:14px;font-weight:600;color:#121218}
td.run .id{display:block;margin-top:2px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
   font-size:11px;color:#8a8a94}
td.n{color:#6f6f7b}td.bn{color:#3a3a44}.fl{font-size:13px}.bf{margin-right:5px}
.b{display:inline-block;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:600}
.b.live{background:#fff2e8;color:#c8590a}.b.pass{background:#e9f7ec;color:#1a7f37}
.b.fail{background:#fdeaea;color:#c02626}
.b.idle{background:#f0f0f3;color:#8a8a94}
td.empty{text-align:center;color:#8a8a94;padding:40px}code{background:#f0f0f3;padding:2px 6px;border-radius:5px}
</style></head><body>
<header><h1>Benchmark runs</h1><div class="sub">__COUNT__ run(s) · click any run to open its dashboard · refreshes every 6s</div></header>
<table><thead><tr><th>Run</th><th>Status</th><th>Tasks</th><th>Flags</th><th>Benches</th></tr></thead>
<tbody>__ROWS__</tbody></table></body></html>"""


def _api_url_from_meta(ctx: Path) -> str:
    """The archive's REAL api url from its metadata (api and frontend ports are
    independently free-port-picked, so never assume api = frontend - 1)."""
    for meta_name in ("archive-frontend-live.json", "archive-frontend.json"):
        meta = _read_json(ctx / meta_name)
        api = str(meta.get("api_url") or "")
        pid = _metadata_pid(meta)
        if api and pid and _pid_alive(pid):
            return api.rstrip("/")
    return ""


def _existing_archive_in(ctx: Path) -> str:
    """Reused archive URL only when BOTH its frontend and API are healthy."""
    for meta_name in ("archive-frontend-live.json", "archive-frontend.json"):
        meta = _read_json(ctx / meta_name)
        url = str(meta.get("frontend_url") or "")
        api = str(meta.get("api_url") or "")
        pid = _metadata_pid(meta)
        if url and api and pid and _pid_alive(pid) and _healthy(url) and _healthy(api):
            try:
                (ctx / meta_name).touch()
            except OSError:
                pass
            return url.rstrip("/")
    return ""


def _launch_archive_for(args: argparse.Namespace, source: dict) -> str:
    """Launch/reuse ONE archive frontend for a specific bench source (run.json +/-
    upstream), isolated under viewers/<key> so each bench gets its own reused Vite."""
    ctx = args.context_dir / "viewers" / source["key"]
    ctx.mkdir(parents=True, exist_ok=True)
    existing = _existing_archive_in(ctx)
    if existing:
        return existing
    with _LAUNCH_LOCK:
        with _host_archive_launch_lock():
            existing = _existing_archive_in(ctx)
            if existing:
                return existing
            _terminated, slot_available = _reap_excess_viewers(
                args.context_dir / "viewers", ctx
            )
            if not slot_available:
                return ""
            ctx.mkdir(parents=True, exist_ok=True)
            api_port, frontend_port = _allocate_archive_ports(args.preferred_archive_port)
            cmd = ["python3", str(args.repo_root / "agents/benchmarks/archive_frontend.py")]
            if source.get("run_json"):
                cmd.append(str(source["run_json"]))
            cmd += ["--frontend-dir", str(args.frontend_dir), "--context-dir", str(ctx),
                    "--host", "127.0.0.1", "--api-port", str(api_port),
                    "--frontend-port", str(frontend_port), "--daemon"]
            if source.get("upstream_url"):
                cmd += ["--upstream-url", source["upstream_url"]]
            if source.get("upstream_api_key"):
                cmd += ["--upstream-api-key", source["upstream_api_key"]]
            if source.get("upstream_user_id"):
                cmd += ["--upstream-user-id", source["upstream_user_id"]]
            if source.get("ssh_machine"):
                cmd += ["--ssh-machine", source["ssh_machine"]]
            if source.get("ssh_app"):
                cmd += ["--ssh-app", source["ssh_app"]]
            subprocess.Popen(
                cmd, cwd=args.repo_root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            # Metadata is published before both listeners necessarily bind. Keep
            # the host lock until the complete frontend+API pair answers.
            for _ in range(60):
                url = _existing_archive_in(ctx)
                if url:
                    return url
                time.sleep(0.25)
    return ""


def _launch_archive_frontend(args: argparse.Namespace) -> str:
    """Return the reused archive frontend URL, launching it once if needed."""
    existing = _existing_archive_frontend(args.context_dir)
    if existing:
        return existing

    # Hold the lock across launch AND the health-wait so a second concurrent click
    # reuses the one Vite this thread starts instead of spawning its own (the user's
    # "no wasted resources"). Other request types are served by sibling threads.
    with _LAUNCH_LOCK:
        with _host_archive_launch_lock():
            existing = _existing_archive_frontend(args.context_dir)
            if existing:
                return existing

            api_port, frontend_port = _allocate_archive_ports(args.preferred_archive_port)
            cmd = ["python3", str(args.repo_root / "agents/benchmarks/archive_frontend.py")]
            if args.run_json:
                cmd.append(str(args.run_json))
            cmd += [
                "--frontend-dir",
                str(args.frontend_dir),
                "--context-dir",
                str(args.context_dir),
                "--host",
                "127.0.0.1",
                "--api-port",
                str(api_port),
                "--frontend-port",
                str(frontend_port),
                "--daemon",
            ]
            if args.upstream_url:
                cmd += ["--upstream-url", args.upstream_url]
            if args.upstream_api_key:
                cmd += ["--upstream-api-key", args.upstream_api_key]
            if args.upstream_user_id:
                cmd += ["--upstream-user-id", args.upstream_user_id]
            subprocess.Popen(
                cmd,
                cwd=args.repo_root,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            for _ in range(60):
                url = _existing_archive_frontend(args.context_dir)
                if url:
                    return url
                time.sleep(0.25)
    return ""


_RETRY_PAGE = (
    b"<!doctype html><meta http-equiv='refresh' content='2'>"
    b"<title>Opening agent\xe2\x80\xa6</title>"
    b"<body style='font-family: system-ui; padding: 32px; color:#121218'>"
    b"<h1>Opening the agent view\xe2\x80\xa6</h1>"
    b"<p>The benchmark archive viewer is starting up. This page refreshes "
    b"automatically and will redirect as soon as it is ready.</p></body>"
)


_PORT_CAPACITY_PAGE = (
    b"<!doctype html><title>Agent viewer unavailable</title>"
    b"<body style='font-family: system-ui; padding: 32px; color:#121218'>"
    b"<h1>The agent viewer is temporarily unavailable</h1>"
    b"<p>No local user port is available for another benchmark archive viewer. "
    b"Close an older viewer and retry this link.</p></body>"
)


_NOT_FOUND_PAGE = (
    b"<!doctype html><title>Agent not in this run</title>"
    b"<body style='font-family: system-ui; padding: 32px; color:#121218'>"
    b"<h1>That agent isn't in any local run record yet</h1>"
    b"<p>No saved run data on this machine contains that agent id. If the run is "
    b"still starting, wait for it to create the agent; otherwise it belongs to a "
    b"different run.</p></body>"
)


def _archive_api_url(frontend_url: str) -> str:
    """The archive API sits one port below its Vite frontend (api_port, api_port+1)."""
    parsed = urllib.parse.urlparse(frontend_url)
    port = parsed.port or 0
    return f"{parsed.scheme}://{parsed.hostname}:{port - 1}" if port else ""


def _loading_page(frontend_url: str, api_url: str, agent_id: str) -> bytes:
    """A page that stays put until the agent is CONFIRMED served, warms the Vite
    bundle, then redirects — so a click never lands on a cold/empty frontend that
    falls back to the home route (the "no agent loaded" bug)."""
    # str.replace (NOT %-format) — the CSS carries literal % chars.
    html = """<!doctype html><html><head><meta charset="utf-8"><title>Loading agent…</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;padding:40px;color:#121218;background:#fafafa}
.s{color:#6f6f7b;margin-top:8px}.dot{display:inline-block;width:9px;height:9px;border-radius:999px;
background:linear-gradient(90deg,#fe7503,#fc585c,#fd5776,#a76ced);margin-right:8px;animation:p 1.4s infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:.35}}</style></head>
<body><h1><span class="dot"></span>Loading agent</h1>
<p class="s" id="s">Confirming the agent is available…</p>
<script>
var FE=__FE__, API=__API__, ID=__AID__, tries=0;
function warm(){ try{ fetch(FE+"/",{mode:"no-cors",cache:"no-store"}); }catch(e){} }
function go(){ document.getElementById("s").textContent="Agent ready — opening view…";
  setTimeout(function(){ location.replace(FE+"/?agent-id="+encodeURIComponent(ID)); }, 300); }
function poll(){ tries++; warm();
  fetch(API+"/api/agents/"+encodeURIComponent(ID),{cache:"no-store"})
    .then(function(r){ return r.ok?r.json():Promise.reject(); })
    .then(function(d){ if(d&&d.agent&&d.agent.agent_id){ go(); } else { throw 0; } })
    .catch(function(){ document.getElementById("s").textContent=
      "Waiting for the agent view to come online… ("+tries+"s)"; setTimeout(poll,1000); });
}
poll();
</script></body></html>"""
    html = (
        html.replace("__FE__", json.dumps(frontend_url.rstrip("/")))
        .replace("__API__", json.dumps(api_url.rstrip("/")))
        .replace("__AID__", json.dumps(agent_id))
    )
    return html.encode("utf-8")


def _make_handler(args: argparse.Namespace):
    class AgentLinkHandler(SimpleHTTPRequestHandler):
        def log_message(self, format_str: str, *values: object) -> None:
            return

        def _agent_id(self) -> str:
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            return (query.get("agent-id") or [""])[0].strip()

        def do_HEAD(self) -> None:  # noqa: N802
            if urllib.parse.urlparse(self.path).path != "/open-agent":
                return super().do_HEAD()
            # HEAD never launches (used for prefetch); redirect only if already up.
            target = _existing_archive_frontend(args.context_dir)
            if target:
                self.send_response(302)
                agent_id = self._agent_id()
                suffix = f"?agent-id={urllib.parse.quote(agent_id)}" if agent_id else ""
                self.send_header("Location", f"{target}/{suffix}")
                self.end_headers()
            else:
                self.send_response(503)
                self.end_headers()

        def _send_bytes(self, page: bytes, ctype: str, code: int = 200) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(page)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(page)

        def _serve_run_file(self, runs_dir: Path, path: str) -> None:
            """Serve a file from runs/<id>/_batch/ (the per-run dashboard + card)."""
            rest = path[len("/run/") :]
            run_id, _, fname = rest.partition("/")
            fname = fname or "dashboard.html"
            if fname.endswith("/") or not fname:
                fname = "dashboard.html"
            base = (runs_dir / run_id / "_batch").resolve()
            target = (base / fname).resolve()
            if not str(target).startswith(str(base)) or not target.is_file():
                self._send_bytes(_NOT_FOUND_PAGE, "text/html; charset=utf-8", 404)
                return
            ctype = "application/json" if target.suffix == ".json" else (
                "text/html; charset=utf-8" if target.suffix in (".html", ".htm") else "text/plain"
            )
            self._send_bytes(target.read_bytes(), ctype)

        def do_GET(self) -> None:  # noqa: N802
            hub = getattr(args, "hub_runs_dir", None)
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path

            if hub:
                if path == "/hub-meta.json":
                    payload = json.dumps(
                        {
                            "hub_runs_dir": str(hub.resolve()),
                            "repo_root": str(args.repo_root.resolve()),
                        }
                    ).encode("utf-8")
                    self._send_bytes(payload, "application/json")
                    return
                if path in ("/", "/index.html"):
                    self._send_bytes(_run_index_page(_scan_runs(hub)), "text/html; charset=utf-8")
                    return
                if path.startswith("/run/"):
                    self._serve_run_file(hub, path)
                    return
                if path != "/open-agent":
                    self._send_bytes(_NOT_FOUND_PAGE, "text/html; charset=utf-8", 404)
                    return
            elif path != "/open-agent":
                return super().do_GET()

            agent_id = self._agent_id()
            if not agent_id:
                self.send_error(400, "missing agent-id")
                return

            # Resolve WHICH run/bench owns this agent from local run data (durable)
            # and launch that view. Hub mode scans every run; fleet mode one run;
            # single mode the one configured run.json/upstream. api_ctx is the dir
            # whose metadata records the archive's REAL api port (see below).
            try:
                if hub:
                    source = _resolve_hub_source(hub, agent_id)
                    target = _launch_archive_for(args, source) if source else ""
                    api_ctx = args.context_dir / "viewers" / source["key"] if source else None
                elif getattr(args, "fleet_dir", None):
                    source = _resolve_fleet_source(args.fleet_dir, agent_id)
                    target = _launch_archive_for(args, source) if source else ""
                    api_ctx = args.context_dir / "viewers" / source["key"] if source else None
                else:
                    target = _launch_archive_frontend(args)
                    api_ctx = args.context_dir
            except PortAllocationError:
                # A capacity fault must remain an honest HTTP response. Dropping
                # the socket produces curl 52 and a dead-looking dashboard link.
                self.send_response(503)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(_PORT_CAPACITY_PAGE)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Retry-After", "5")
                self.end_headers()
                self.wfile.write(_PORT_CAPACITY_PAGE)
                return

            if target:
                # Serve a loading page (NOT a bare 302): it polls the archive API
                # until the agent is actually served + warms Vite, then redirects.
                # A bare 302 landed on a not-yet-compiled SPA → home route → the
                # "opened, no agent loaded" bug. The archive API confirms the data
                # (live upstream to the box, or the static run.json) is ready first.
                # Read the archive's ACTUAL api url from its metadata — the api and
                # frontend ports are NOT always consecutive (each is independently
                # free-port-picked), so the old frontend-1 guess polled a dead port
                # → the loading page hung forever on "waiting for agent to come
                # online". Fall back to the heuristic only if metadata is absent.
                api_url = (_api_url_from_meta(api_ctx) if api_ctx else "") or _archive_api_url(target)
                page = _loading_page(target, api_url, agent_id)
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(page)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(page)
                return

            # Never a dead link: if the viewer isn't ready yet (source found,
            # archive still warming) auto-refresh; if the agent is genuinely unknown
            # in all local run data, say so plainly instead of a broken redirect.
            page = _RETRY_PAGE
            _fleet = getattr(args, "fleet_dir", None)
            if hub and _resolve_hub_source(hub, agent_id) is None:
                page = _NOT_FOUND_PAGE
            elif _fleet and _resolve_fleet_source(_fleet, agent_id) is None:
                page = _NOT_FOUND_PAGE
            self.send_response(200 if page is _NOT_FOUND_PAGE else 503)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(page)

    return partial(AgentLinkHandler, directory=str(args.root.resolve()))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--context-dir", type=Path, required=True)
    parser.add_argument("--frontend-dir", type=Path, required=True)
    parser.add_argument("--run-json", type=Path, default=None)
    parser.add_argument("--preferred-archive-port", type=int, default=8775)
    parser.add_argument("--upstream-url", default="")
    parser.add_argument("--upstream-api-key", default="")
    parser.add_argument("--upstream-user-id", default="")
    # Batch/durable mode: resolve any agent from any bench's local run data under
    # this fleet dir (each subdir = a bench with cloudbench-run.json / .upstream.json).
    parser.add_argument("--fleet-dir", type=Path, default=None)
    # Central-hub mode: ONE persistent server over a runs-root (each subdir = one
    # run's fleet dir). Serves a run-index at /, each run's dashboard at /run/<id>/,
    # and resolves open-agent across EVERY run. This is the single dashboard.
    parser.add_argument("--hub-runs-dir", type=Path, default=None)
    args = parser.parse_args()
    args.root.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), _make_handler(args))
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
