#!/usr/bin/env python3
"""Launch the real frontend against a saved benchmark run archive."""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import NoReturn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from benchmarks.archive_api import ArchiveHandler, configure_archive_handler


def _daemonize(log_path: Path) -> None:
    pid = os.fork()
    if pid:
        raise SystemExit(0)
    os.setsid()
    pid = os.fork()
    if pid:
        os._exit(0)
    fd = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    os.close(fd)


def _write_metadata(path: Path, payload: dict[str, object]) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _process_group_alive(group_id: int) -> bool:
    try:
        os.killpg(group_id, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return True


def _wait_for_process_group_exit(group_id: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _process_group_alive(group_id):
            return True
        time.sleep(0.05)
    return not _process_group_alive(group_id)


def _require_frontend_started(
    frontend: subprocess.Popen,
    log_path: Path,
    frontend_dir: Path,
    host: str,
    frontend_port: int,
    *,
    timeout_seconds: float = 90.0,
) -> None:
    """Fail closed unless the archive Vite is actually accepting connections.

    The supervisor used to spawn `npm run dev` and immediately advertise
    `frontend=http://localhost:<port>` without ever checking it. In a worktree
    created by a plain `git worktree add`, `front-end/node_modules` is empty, so
    Vite dies instantly with `sh: vite: command not found` (exit 127) and every
    /open-agent link for that run is dead while the supervisor reports success.
    """
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        exit_code = frontend.poll()
        if exit_code is not None:
            tail = ""
            try:
                tail = "\n".join(log_path.read_text(errors="replace").splitlines()[-15:])
            except OSError:
                pass
            hint = ""
            if not (frontend_dir / "node_modules").is_dir():
                hint = (
                    f"\n  cause: {frontend_dir}/node_modules is missing — this worktree was never provisioned."
                    f"\n  fix:   (cd {frontend_dir} && npm install)"
                )
            raise SystemExit(
                f"archive frontend exited with code {exit_code} before serving "
                f"http://localhost:{frontend_port}; refusing to advertise a dead viewer."
                f"{hint}\n  log: {log_path}\n{tail}"
            )
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.5)
            if probe.connect_ex((host, frontend_port)) == 0:
                return
        time.sleep(0.25)
    _stop_frontend(frontend)
    raise SystemExit(
        f"archive frontend did not accept connections on http://localhost:{frontend_port} "
        f"within {timeout_seconds:.0f}s; refusing to advertise a dead viewer.\n  log: {log_path}"
    )


def _stop_frontend(frontend: subprocess.Popen, *, grace_seconds: float = 2.0) -> bool:
    """Stop and confirm the dedicated npm/Vite process group, with escalation."""
    group_id = frontend.pid  # start_new_session=True makes the child its group leader.
    try:
        os.killpg(group_id, signal.SIGTERM)
    except OSError:
        pass
    try:
        frontend.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        pass
    if _wait_for_process_group_exit(group_id, 0.5):
        return True

    try:
        os.killpg(group_id, signal.SIGKILL)
    except OSError:
        pass
    try:
        frontend.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        return False
    return _wait_for_process_group_exit(group_id, 1.0)


def launch(
    *,
    run_json: Path | None,
    frontend_dir: Path,
    context_dir: Path,
    host: str,
    api_port: int,
    frontend_port: int,
    upstream_url: str = "",
    upstream_api_key: str = "",
    upstream_user_id: str = "",
    ssh_machine: str = "",
    ssh_app: str = "",
) -> NoReturn:
    context_dir.mkdir(parents=True, exist_ok=True)
    configure_archive_handler(
        run_json,
        upstream_url=upstream_url,
        upstream_api_key=upstream_api_key,
        upstream_user_id=upstream_user_id,
        ssh_machine=ssh_machine,
        ssh_app=ssh_app,
    )

    env = {
        **os.environ,
        "VITE_BENCHMARK_ARCHIVE": "1",
        "VITE_BACKEND_API_URL": f"http://{host}:{api_port}",
        "VITE_DEV_PORT": str(frontend_port),
    }
    frontend_log_path = context_dir / "archive-frontend.log"
    with open(frontend_log_path, "a") as frontend_log:
        frontend = subprocess.Popen(
            ["npm", "run", "dev", "--", "--host", host],
            cwd=frontend_dir,
            env=env,
            stdout=frontend_log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    _require_frontend_started(frontend, frontend_log_path, frontend_dir, host, frontend_port)

    server: ThreadingHTTPServer | None = None
    try:
        metadata_name = "archive-frontend-live.json" if upstream_url else "archive-frontend.json"
        _write_metadata(
            context_dir / metadata_name,
            {
                "supervisor_pid": os.getpid(),
                "frontend_pid": frontend.pid,
                "api_url": f"http://{host}:{api_port}",
                "frontend_url": f"http://localhost:{frontend_port}",
                "run_json": str(run_json) if run_json else "",
                "live": bool(upstream_url),
            },
        )
        pid_name = "archive-frontend-live.pid" if upstream_url else "archive-frontend.pid"
        (context_dir / pid_name).write_text(str(os.getpid()), encoding="utf-8")

        def shutdown(_signum: int, _frame: object) -> None:
            if not _stop_frontend(frontend):
                print("archive frontend process group did not exit; retaining supervisor ownership", flush=True)
                return
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)

        server = ThreadingHTTPServer((host, api_port), ArchiveHandler)
        print(
            f"benchmark archive frontend supervisor pid={os.getpid()} "
            f"api=http://{host}:{api_port} frontend=http://localhost:{frontend_port} "
            f"agents={len(ArchiveHandler.agents)}",
            flush=True,
        )
        server.serve_forever()
        raise SystemExit(0)
    finally:
        if server is not None:
            server.server_close()
        _stop_frontend(frontend)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_json", type=Path, nargs="?", default=None)
    parser.add_argument("--frontend-dir", type=Path, required=True)
    parser.add_argument("--context-dir", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--api-port", type=int, required=True)
    parser.add_argument("--frontend-port", type=int, required=True)
    parser.add_argument("--upstream-url", default="")
    parser.add_argument("--upstream-api-key", default="")
    parser.add_argument("--upstream-user-id", default="")
    parser.add_argument("--ssh-machine", default="")
    parser.add_argument("--ssh-app", default="")
    parser.add_argument("--daemon", action="store_true")
    args = parser.parse_args()

    if args.daemon:
        log_name = "archive-supervisor-live.log" if args.upstream_url else "archive-supervisor.log"
        _daemonize(args.context_dir / log_name)
    launch(
        run_json=args.run_json.resolve() if args.run_json else None,
        frontend_dir=args.frontend_dir.resolve(),
        context_dir=args.context_dir.resolve(),
        host=args.host,
        api_port=args.api_port,
        frontend_port=args.frontend_port,
        upstream_url=args.upstream_url,
        upstream_api_key=args.upstream_api_key,
        upstream_user_id=args.upstream_user_id,
        ssh_machine=args.ssh_machine,
        ssh_app=args.ssh_app,
    )


if __name__ == "__main__":
    raise SystemExit(main())
