#!/usr/bin/env python3
"""Reproduce a host-overload renderer stall inside one semantic (Playwright) spec.

Runs ``front-end/scripts/run-semantic-tests.sh <spec>`` unmodified, waits for a
trigger observed in the backend log, then SIGSTOPs every Chromium renderer that
descends from the runner it launched, holds them for ``--stall-s`` seconds, and
SIGCONTs them. Only processes started by this invocation are ever signalled, and
they are always resumed on exit (including Ctrl-C / SIGTERM).

Trigger: the spec's agent is found by goal substring. Once that agent has at
least ``--arm-after-tool-messages`` persisted TOOL messages, the next backend
request for the agent whose path matches ``--trigger-path`` fires the stall
after ``--delay-s``. An empty ``--trigger-path`` fires as soon as it is armed.

Reproduces RCA 2026-10-02-semantic-renderer-stall-consumed-chip-poll-budget
(a 34s renderer stall right after the post-reload boot):

  CONDUCTOR_PORT=55010 LOCAL_DB_PORT=55015 BACKEND_PORT=55010 FRONTEND_PORT=55011 \\
    python3 scripts/semantic-renderer-stall.py --spec browser-chip-count \\
      --agent-goal "browser chip count invariant" --arm-after-tool-messages 7 \\
      --trigger-path '/ancestors' --delay-s 0 --stall-s 34
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
API_KEY = os.environ.get("TEST_API_KEY", "AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=")


def log(msg: str, t0: float) -> None:
    print(f"[stall +{time.time() - t0:6.1f}s] {msg}", flush=True)


def renderer_descendants(root: int) -> list[int]:
    """One `ps` snapshot (not a pgrep per node) so the stop lands within ms of the trigger."""
    children: dict[int, list[int]] = {}
    commands: dict[int, str] = {}
    for row in subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True).stdout.splitlines():
        parts = row.split(None, 2)
        if len(parts) == 3:
            pid, ppid = int(parts[0]), int(parts[1])
            children.setdefault(ppid, []).append(pid)
            commands[pid] = parts[2]
    found, stack = [], [root]
    while stack:
        for kid in children.get(stack.pop(), []):
            stack.append(kid)
            if "--type=renderer" in commands.get(kid, ""):
                found.append(kid)
    return found


def fetch_agent(api: str, agent_id: str) -> dict:
    req = urllib.request.Request(f"{api}/api/agents/{agent_id}", headers={"X-API-Key": API_KEY})
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.load(res)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--spec", required=True, help="semantic spec name (tests-e2e/<spec>.spec.ts)")
    ap.add_argument("--agent-goal", required=True, help="substring of the goal of the agent the spec creates")
    ap.add_argument("--arm-after-tool-messages", type=int, default=0)
    ap.add_argument("--trigger-path", default="", help="regex on the request path; empty = fire when armed")
    ap.add_argument("--delay-s", type=float, default=0.0)
    ap.add_argument("--stall-s", type=float, required=True)
    args = ap.parse_args()

    api = f"http://localhost:{os.environ.get('BACKEND_PORT', '3001')}"
    backend_log = Path(os.environ.get("BACKEND_LOG_FILE", REPO / "back-end" / "backend-logs.log"))
    pos = backend_log.stat().st_size
    t0 = time.time()
    runner = subprocess.Popen(
        ["bash", str(REPO / "front-end" / "scripts" / "run-semantic-tests.sh"), args.spec],
        cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    threading.Thread(target=lambda: [print(line, end="", flush=True) for line in runner.stdout], daemon=True).start()

    stopped: list[int] = []

    def resume(*_sig: object) -> None:
        for pid in stopped:
            try:
                os.kill(pid, signal.SIGCONT)
            except ProcessLookupError:
                pass
        stopped.clear()

    def on_signal(signum: int, _frame: object) -> None:
        resume()
        runner.send_signal(signum)
        sys.exit(128 + signum)

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    checked: set[str] = set()
    agent: str | None = None
    armed = fired = False
    stall_started = 0.0
    try:
        while runner.poll() is None:
            with backend_log.open(errors="ignore") as fh:
                fh.seek(pos)
                chunk = fh.read()
                pos = fh.tell()
            for line in chunk.splitlines():
                if "[HTTP]" not in line:
                    continue
                if agent is None:
                    for cand in re.findall(rf"/api/agents/({UUID})", line):
                        if cand in checked:
                            continue
                        checked.add(cand)
                        try:
                            if args.agent_goal in (fetch_agent(api, cand).get("agent", {}).get("goal") or ""):
                                agent = cand
                                log(f"spec agent {agent}", t0)
                        except OSError:
                            pass
                if agent is None or agent not in line or fired:
                    continue
                if not armed:
                    # Re-count only when a message lands; our own GETs also hit this log.
                    if f"POST /api/agents/{agent}/messages" not in line and args.arm_after_tool_messages:
                        continue
                    tools = [m for m in fetch_agent(api, agent).get("messages", []) if m.get("role") == "TOOL"]
                    armed = len(tools) >= args.arm_after_tool_messages
                    if armed:
                        log(f"armed after {len(tools)} TOOL messages", t0)
                        if args.trigger_path:
                            continue
                path = re.search(r"\[HTTP\] \S+ (\S+)", line)
                if armed and (not args.trigger_path or (path and re.search(args.trigger_path, path.group(1)))):
                    time.sleep(args.delay_s)
                    stopped.extend(renderer_descendants(runner.pid))
                    for pid in stopped:
                        os.kill(pid, signal.SIGSTOP)
                    fired, stall_started = True, time.time()
                    log(f"SIGSTOP renderers {stopped} for {args.stall_s}s", t0)
            if stopped and time.time() - stall_started >= args.stall_s:
                resume()
                log("SIGCONT renderers", t0)
            time.sleep(0.05 if armed and not fired else 0.2)
    finally:
        resume()
    log(f"runner exit={runner.returncode} fired={fired}", t0)
    return runner.returncode or 0


if __name__ == "__main__":
    sys.exit(main())
