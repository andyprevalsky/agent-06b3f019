#!/usr/bin/env python3
"""Launch the real frontend against a saved benchmark run archive."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
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
    frontend = subprocess.Popen(
        ["npm", "run", "dev", "--", "--host", host],
        cwd=frontend_dir,
        env=env,
        stdout=open(context_dir / "archive-frontend.log", "a"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

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
        try:
            frontend.terminate()
        except Exception:
            pass
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
