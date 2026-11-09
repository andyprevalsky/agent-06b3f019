#!/bin/sh
""":"
exec python3 -I "$0" "$@"
" (the three lines above let sh, bash and python3 all run this file)

Replay stub for a repository CLI (``scripts/run-bench`` by default) inside a skill-test sandbox.

Installed by the ``replay_cli:<scenario>`` fixture (``fixtures.py``). The first lines make this
file valid for ``scripts/run-bench``, ``bash scripts/run-bench`` and ``python3 scripts/run-bench``.

Installed layout (``<gc>`` = ``git rev-parse --git-common-dir`` of the replay repository):
  scripts/run-bench               this file (stub); the real script is moved to scripts/.run-bench.real
  scripts/run-bench-fleet, scripts/run-bench-campaign.py, scripts/run-bench-cloud
                                  refusing shims: every direct call is logged and exits 1
  <gc>/replay-cli/scenario.json   operational copy of skill_scenarios/<scenario>.json (provenance stripped)
  <gc>/replay-cli/state.json      per-rule call counters (flock-guarded)
  <gc>/replay-cli/<controller argv0 name>   copy of this file, run as the dummy controller
  <repo>/../mocks/run-bench.jsonl          one row per call (also refused and delegated calls)
  <repo>/../mocks/controller.json          controller pid, pid_start, token, argv (written on start)
  <repo>/../mocks/controller-signals.jsonl every signal the controller (and its children) received, the
                                           controller's "cleanup" event (it TERMs its children after it) and exits
  <gc>/cloudbench-fleet-ownership/<token>/meta   real-format owner meta (version=2, pid, pid_start=proc-start:...)

Scenario format (stable; other scenario authors depend on it). JSON object:
  scenario     str, the name (``replay_cli:<scenario>`` resolves skill_scenarios/<scenario>.json)
  provenance   free-form object (recorded vs synthesized parts); stripped before install
  vars         {NAME: str} extra placeholders; values may use the built-ins below
  files        {repo-relative path: str | JSON value} written at install time (pre-existing run dirs)
  controller   optional {token: 32-hex, app, run_id, argv0: "run-bench-fleet" | "run-bench-campaign.py",
               args: [str], start: "install" | "rule", children: int (default 1),
               exit_after_seconds: number | null, max_lifetime_seconds (default 3600),
               on_term_files / on_exit_files: {path: content} written when it exits on TERM / by itself}
  delegate     list of regexes for read-only calls passed to scripts/.run-bench.real
               (default: a first word of list, --list or report-format, or any --help / -h word)
  rules        ordered list; the first rule whose ``match`` regex (re.search on the space-joined argv)
               matches and whose ``when`` holds is used:
                 id: str, match: regex, tool: "run-bench" (default) or another installed tool name,
                 when: {"controller": "alive" | "exited" | "not_started"} (optional),
                 start_controller: bool (start the controller before rendering the response),
                 responses: [ {stdout, stderr (printed at once), exit_code (0), files {path: content},
                               sleep_seconds (0; the call blocks like a foreground launcher),
                               controller: "exit" (after the sleep, ask the controller to exit by itself),
                               stdout_after / stderr_after (printed after the sleep and exit)} ],
                 repeat_last: bool (default true; false -> the default response once exhausted)
  default      response used when no rule matches (default: exit 2 with a refusal on stderr)
  tools        optional {name: {path: repo-relative path (may be ../bin/<tool> for a PATH tool),
               passthrough: bool}}: extra commands routed through the same rules (rule ``tool`` = name);
               with passthrough, an unmatched call execs the next ``name`` on PATH
Placeholders ``{CONTROLLER_PID}``, ``{CONTROLLER_PID_START}``, ``{CONTROLLER_TOKEN}``, ``{REPO}``,
``{GIT_COMMON}``, ``{MOCKS}``, ``{HEAD_SHA}``/``{HEAD_SHORT}``/``{HEAD_13}`` (the replay repo's HEAD), ``{CALL}`` (1-based call number), ``{CHILD_PID_<n>}``, ``{NOW_PST}``, ``{REPORT_FORMAT}`` (the replay repo's
.claude/shared/benchmark-report-format.txt, as the real launch prints it), the matched rule's named regex
groups (``(?P<HTML>[^ ]+)`` -> ``{HTML}``) and every ``vars`` key are replaced in stdout, stderr, file
paths and file contents. The n-th call matching a rule gets responses[n-1].
"""

import fcntl
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

DEFAULT_DELEGATE = (r"^(list|--list)(\s|$)", r"^report-format$", r"(^|\s)(--help|-h)(\s|$)")
DEFAULT_RESPONSE = {
    "stderr": "❌ run-bench: this invocation is not available in this environment; the call was recorded and refused.\n",
    "exit_code": 2,
}
REFUSED_SCRIPTS = ("run-bench-fleet", "run-bench-campaign.py", "run-bench-cloud")
CONFIG_ENV = "REPLAY_CLI_CONFIG"
SIGNALS = ("SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2", "SIGALRM", "SIGCONT", "SIGTSTP")


# ---------------------------------------------------------------------------
# Paths and helpers
# ---------------------------------------------------------------------------


def _git_common(repo: Path) -> Path:
    out = subprocess.run(["git", "-C", str(repo), "rev-parse", "--git-common-dir"], capture_output=True, text=True)
    value = out.stdout.strip() or ".git"
    path = Path(value)
    return (path if path.is_absolute() else repo / path).resolve()


class Layout:
    def __init__(self, repo: Path, git_common: Optional[Path] = None) -> None:
        self.repo = repo.resolve()
        self.git_common = (git_common or _git_common(self.repo)).resolve()
        self.dir = self.git_common / "replay-cli"
        self.scenario = self.dir / "scenario.json"
        self.state = self.dir / "state.json"
        self.lock = self.dir / "state.lock"
        self.stop_request = self.dir / "controller.stop"
        self.mocks = self.repo.parent / "mocks"
        self.log = self.mocks / "run-bench.jsonl"
        self.pidfile = self.mocks / "controller.json"
        self.signals = self.mocks / "controller-signals.jsonl"
        self.real = self.repo / "scripts" / ".run-bench.real"


def _append(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        fh.write(json.dumps(row) + "\n")


def pid_start(pid: int) -> str:
    """The fleet's ``proc-start:<boot_id>:<starttime ticks>`` identity (scripts/lib/cloudbench-env.sh)."""
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    stat = Path(f"/proc/{pid}/stat").read_text()
    fields = stat.rsplit(") ", 1)[1].split()
    return f"proc-start:{boot}:{fields[19]}"


def pid_alive(pid: int, start: str) -> bool:
    try:
        return pid_start(pid) == start and Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[0] != "Z"
    except (OSError, IndexError):
        return False


def controller_info(layout: Layout) -> Optional[dict[str, Any]]:
    try:
        return json.loads(layout.pidfile.read_text())
    except (OSError, ValueError):
        return None


def controller_state(layout: Layout) -> str:
    info = controller_info(layout)
    if not info:
        return "not_started"
    return "alive" if pid_alive(int(info["pid"]), str(info["pid_start"])) else "exited"


def placeholders(layout: Layout, scenario: dict[str, Any], call: int = 0, groups: Optional[dict[str, str]] = None) -> dict[str, str]:
    info = controller_info(layout) or {}
    ctl = scenario.get("controller") or {}
    values = {
        "CONTROLLER_PID": str(info.get("pid", "")),
        "CONTROLLER_PID_START": str(info.get("pid_start", "")),
        "CONTROLLER_TOKEN": str(ctl.get("token", "")),
        "REPO": str(layout.repo),
        "GIT_COMMON": str(layout.git_common),
        "MOCKS": str(layout.mocks),
        "CALL": str(call),
    }
    head = head_sha(layout.repo)
    if head:  # recorded output names the replay repo's own HEAD, not the source run's commit
        values.update({"HEAD_SHA": head, "HEAD_SHORT": head[:10], "HEAD_13": head[:13]})
    for n, child in enumerate(info.get("children") or [], 1):
        values[f"CHILD_PID_{n}"] = str(child)
    try:
        from zoneinfo import ZoneInfo

        values["NOW_PST"] = datetime.now(ZoneInfo("America/Los_Angeles")).strftime("%b %d, %I:%M:%S %p %Z")
    except (ImportError, KeyError, OSError):  # tzdata missing: keep the recorded text
        pass
    contract = layout.repo / ".claude" / "shared" / "benchmark-report-format.txt"
    values["REPORT_FORMAT"] = contract.read_text().rstrip("\n") if contract.is_file() else ""
    values.update({k: v or "" for k, v in (groups or {}).items()})
    for _ in range(3):  # vars may reference built-ins or each other
        for key, value in (scenario.get("vars") or {}).items():
            values[key] = substitute(str(value), values)
    return values


def head_sha(repo: Path) -> str:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def substitute(text: str, values: dict[str, str]) -> str:
    for key, value in values.items():
        text = text.replace("{" + key + "}", value)
    return text


def _sub_json(value: Any, values: dict[str, str]) -> Any:
    if isinstance(value, str):
        return substitute(value, values)
    if isinstance(value, list):
        return [_sub_json(v, values) for v in value]
    if isinstance(value, dict):
        return {substitute(k, values): _sub_json(v, values) for k, v in value.items()}
    return value


def write_files(layout: Layout, files: dict[str, Any], values: dict[str, str]) -> list[str]:
    written = []
    for rel, content in (files or {}).items():
        path = Path(substitute(rel, values))
        path = path if path.is_absolute() else layout.repo / path
        path.parent.mkdir(parents=True, exist_ok=True)
        text = substitute(content, values) if isinstance(content, str) else json.dumps(_sub_json(content, values), indent=2) + "\n"
        tmp = path.with_name(f".{path.name}.replay-tmp")
        tmp.write_text(text)
        os.replace(tmp, path)
        written.append(str(path))
    return written


# ---------------------------------------------------------------------------
# Dummy controller
# ---------------------------------------------------------------------------


def _owner_meta(layout: Layout, ctl: dict[str, Any], pid: int, start: str) -> Path:
    token = str(ctl["token"])
    registry = layout.git_common / "cloudbench-fleet-ownership" / token
    audit = layout.git_common / "cloudbench-fleet-audits" / token
    run_id = str(ctl.get("run_id") or "replay-run")
    runs_root = layout.repo / ".context" / "fleet" / "runs"
    rows = [
        ("version", "2"),
        ("app", str(ctl.get("app") or "navi-whisper-lux-bench")),
        ("fleet_owner_token", token),
        ("host", socket.gethostname()),
        ("pid", str(pid)),
        ("pid_start", start),
        ("run_id", run_id),
        ("workspace_root", str(layout.repo)),
        ("runs_root", str(runs_root)),
        ("audit_dir", str(audit)),
        ("owned_ids_file", str(audit / "owned-clones")),
        ("owned_names_file", str(audit / "owned-clone-names")),
        ("cleanup_policy", "retain"),
    ]
    (registry / "clones").mkdir(parents=True, exist_ok=True)
    audit.mkdir(parents=True, exist_ok=True)
    tmp = registry / f"meta.tmp.{pid}"
    tmp.write_text("".join(f"{k}={v}\n" for k, v in rows))
    os.replace(tmp, registry / "meta")
    return registry / "meta"


def run_controller(layout: Layout, role: str) -> int:
    """Detached dummy controller (or its child): log every signal; the controller exits on TERM."""
    scenario = json.loads(layout.scenario.read_text())
    ctl = scenario.get("controller") or {}
    pid = os.getpid()
    start = pid_start(pid)
    born = time.time()
    lifetime = float(ctl.get("max_lifetime_seconds") or 3600)
    exit_after = ctl.get("exit_after_seconds")
    state = {"exit": None}

    def log(event: str, **extra: Any) -> None:
        _append(layout.signals, {"ts": time.time(), "role": role, "pid": pid, "event": event, **extra})

    def handler(signum: int, _frame: Any) -> None:
        name = signal.Signals(signum).name
        log("signal", signal=name, sender_note="received")
        if signum == signal.SIGTERM:
            state["exit"] = "term"

    for name in SIGNALS:
        signal.signal(getattr(signal, name), handler)

    children: list[subprocess.Popen] = []
    if role == "controller":
        meta = _owner_meta(layout, ctl, pid, start)
        for _ in range(int(ctl.get("children", 1))):
            children.append(
                subprocess.Popen(
                    [sys.executable, "-I", sys.argv[0], "--replay-child", str(layout.repo), str(layout.git_common)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
            )
        info = {
            "pid": pid,
            "pid_start": start,
            "pgid": os.getpgid(pid),
            "token": ctl.get("token"),
            "argv": sys.argv,
            "meta": str(meta),
            "children": [c.pid for c in children],
            "started_at": born,
        }
        tmp = layout.pidfile.with_name(".controller.json.tmp")
        tmp.write_text(json.dumps(info, indent=2))
        os.replace(tmp, layout.pidfile)
        log("start", pid_start=start, children=info["children"])
    else:
        log("start", pid_start=start)

    parent = os.getppid()
    reason = "lifetime"
    while time.time() - born < lifetime:
        if state["exit"]:
            reason = state["exit"]
            break
        if not layout.repo.exists():
            reason = "repo_removed"
            break
        if role == "controller":
            if layout.stop_request.exists():
                reason = "self_exit"
                break
            if exit_after is not None and time.time() - born >= float(exit_after):
                reason = "self_exit"
                break
        elif os.getppid() != parent:
            reason = "parent_gone"
            break
        time.sleep(0.2)

    if role == "controller":
        log("cleanup", reason=reason)  # every later child signal comes from this cleanup
        files = ctl.get("on_term_files") if reason == "term" else ctl.get("on_exit_files")
        try:
            write_files(layout, files or {}, placeholders(layout, scenario))
        except OSError:
            pass
        for child in children:  # the controller's own cleanup reaps its children
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
    log("exit", reason=reason)
    return 0


def start_controller(layout: Layout, scenario: dict[str, Any]) -> dict[str, Any]:
    """Double-fork a detached controller (reparented away from the caller) and wait for its pidfile."""
    if controller_state(layout) != "not_started":
        return controller_info(layout) or {}
    ctl = scenario.get("controller") or {}
    argv0 = str(ctl.get("argv0") or "run-bench-fleet")
    script = layout.dir / argv0
    if not script.is_file():
        shutil.copyfile(Path(__file__).resolve(), script)
        script.chmod(0o755)
    args = [str(a) for a in (ctl.get("args") or [])]
    argv = [sys.executable, "-I", str(script), "--replay-controller", str(layout.repo), str(layout.git_common), *args]
    first = os.fork()
    if first == 0:
        os.setsid()
        if os.fork() == 0:
            devnull = os.open(os.devnull, os.O_RDWR)
            for fd in (0, 1, 2):
                os.dup2(devnull, fd)
            os.chdir(str(layout.repo))
            os.execv(sys.executable, argv)
        os._exit(0)
    os.waitpid(first, 0)
    deadline = time.time() + 10
    while time.time() < deadline:
        info = controller_info(layout)
        if info:
            return info
        time.sleep(0.05)
    raise RuntimeError("replay controller did not publish its pidfile within 10s")


# ---------------------------------------------------------------------------
# Install (called by the fixture) and dispatch
# ---------------------------------------------------------------------------


def operational(scenario: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in scenario.items() if k not in ("provenance", "description", "notes")}


def _refuser(kind: str, layout: Layout, name: str) -> str:
    if kind == "python":
        return f'''#!/usr/bin/env python3
import json, os, sys, time
with open({str(layout.log)!r}, "a") as fh:
    fh.write(json.dumps({{"ts": time.time(), "tool": {name!r}, "argv": sys.argv[1:], "cwd": os.getcwd(), "refused": True, "exit_code": 1}}) + "\\n")
sys.stderr.write("❌ " + {name!r} + " must not be called directly; use scripts/run-bench.\\n")
sys.exit(1)
'''
    return f'''#!/bin/sh
python3 -I -c 'import json, os, sys, time
open(sys.argv[1], "a").write(json.dumps({{"ts": time.time(), "tool": sys.argv[2], "argv": sys.argv[3:], "cwd": os.getcwd(), "refused": True, "exit_code": 1}}) + "\\n")' {str(layout.log)!r} {name!r} "$@"
echo "❌ {name} must not be called directly; use scripts/run-bench." >&2
exit 1
'''


def install(repo: Path, scenario_path: Path) -> dict[str, Any]:
    """Move the real CLI aside, install the stub, refusing shims and the scenario. Returns a receipt."""
    layout = Layout(repo)
    scenario = json.loads(scenario_path.read_text())
    if not isinstance(scenario.get("rules"), list):
        raise ValueError(f"{scenario_path}: a scenario needs a rules list")
    for rule in scenario["rules"]:
        re.compile(rule["match"])
    layout.dir.mkdir(parents=True, exist_ok=True)
    layout.mocks.mkdir(parents=True, exist_ok=True)
    layout.log.touch()
    layout.scenario.write_text(json.dumps(operational(scenario), indent=2))
    layout.state.write_text("{}")
    stub = layout.repo / "scripts" / "run-bench"
    if not stub.is_file():
        raise ValueError(f"{stub} does not exist at the base commit")
    if not layout.real.exists():
        os.replace(stub, layout.real)
    shutil.copyfile(Path(__file__).resolve(), stub)
    stub.chmod(0o755)
    hidden = ["scripts/run-bench"]
    for name in REFUSED_SCRIPTS:
        target = layout.repo / "scripts" / name
        if target.exists():
            target.write_text(_refuser("python" if name.endswith(".py") else "sh", layout, name))
            target.chmod(0o755)
            hidden.append(f"scripts/{name}")
    for tool, spec in (scenario.get("tools") or {}).items():
        target = layout.repo / spec["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            f"#!/bin/sh\nREPLAY_CLI_TOOL={tool!r} REPLAY_CLI_TOOL_PATH=\"$0\" exec python3 -I {str(stub)!r} \"$@\"\n"
        )
        target.chmod(0o755)
        if target.resolve().is_relative_to(layout.repo):
            hidden.append(target.resolve().relative_to(layout.repo).as_posix())
    values = placeholders(layout, scenario)
    written = write_files(layout, scenario.get("files") or {}, values)
    controller = None
    if (scenario.get("controller") or {}).get("start") == "install":
        controller = start_controller(layout, scenario)
    return {
        "scenario": scenario.get("scenario"),
        "stub": str(stub),
        "real": str(layout.real),
        "log": str(layout.log),
        "hidden_tracked": hidden,
        "files": written,
        "controller": controller,
    }


def _bump(layout: Layout, rule_id: str) -> tuple[int, int]:
    """(0-based index of this call among the rule's matches, 1-based call number overall)."""
    with layout.lock.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            counts = json.loads(layout.state.read_text() or "{}")
        except (OSError, ValueError):
            counts = {}
        counts[rule_id] = counts.get(rule_id, 0) + 1
        counts["__calls__"] = counts.get("__calls__", 0) + 1
        layout.state.write_text(json.dumps(counts))
        return counts[rule_id] - 1, counts["__calls__"]


def _next_on_path(name: str, wrapper: str) -> Optional[str]:
    skip = Path(wrapper).resolve() if wrapper else None
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        candidate = Path(entry or ".") / name
        if candidate.is_file() and os.access(candidate, os.X_OK) and candidate.resolve() != skip:
            return str(candidate)
    return None


def dispatch(argv: list[str], tool: str = "run-bench") -> int:
    layout = Layout(Path(__file__).resolve().parents[1])
    scenario = json.loads(layout.scenario.read_text())
    joined = " ".join(argv)
    row: dict[str, Any] = {"ts": time.time(), "tool": tool, "argv": argv, "joined": joined, "cwd": os.getcwd(), "pid": os.getpid()}
    if tool == "run-bench":
        for pattern in scenario.get("delegate") or DEFAULT_DELEGATE:
            if re.search(pattern, joined):
                row.update(delegated=True, rule=None, response_index=None)
                _append(layout.log, row)
                proc = subprocess.run(["bash", str(layout.real), *argv])
                _append(layout.log, {**row, "ts": time.time(), "delegated_exit_code": proc.returncode, "phase": "end"})
                return proc.returncode
    state = controller_state(layout)
    chosen: Optional[dict[str, Any]] = None
    groups: dict[str, str] = {}
    for rule in scenario["rules"]:
        found = re.search(rule["match"], joined) if rule.get("tool", "run-bench") == tool else None
        if not found:
            continue
        want = (rule.get("when") or {}).get("controller")
        if want and want != state:
            continue
        chosen, groups = rule, found.groupdict()
        break
    response: dict[str, Any]
    spec = (scenario.get("tools") or {}).get(tool) or {}
    if chosen is None and spec.get("passthrough"):
        real = _next_on_path(tool, os.environ.get("REPLAY_CLI_TOOL_PATH", ""))
        row.update(rule=None, response_index=None, passthrough=real)
        _append(layout.log, row)
        if not real:
            sys.stderr.write(f"{tool}: command not found\n")
            return 127
        os.execv(real, [real, *argv])
    if chosen is None:
        index, call = _bump(layout, "__default__")
        response = scenario.get("default") or DEFAULT_RESPONSE
        row.update(rule=None, response_index=None)
    else:
        index, call = _bump(layout, chosen["id"])
        responses = chosen.get("responses") or [{}]
        if index < len(responses):
            response = responses[index]
        elif chosen.get("repeat_last", True):
            response = responses[-1]
        else:
            response = scenario.get("default") or DEFAULT_RESPONSE
        row.update(rule=chosen["id"], response_index=index)
        if chosen.get("start_controller"):
            start_controller(layout, scenario)
    values = placeholders(layout, scenario, call, groups)
    row["controller_state"] = controller_state(layout)
    row["controller_pid"] = values["CONTROLLER_PID"] or None
    row["files_written"] = write_files(layout, response.get("files") or {}, values)
    exit_code = int(response.get("exit_code", 0))
    row["exit_code"] = exit_code
    _append(layout.log, row)
    sys.stdout.write(substitute(response.get("stdout", ""), values))
    sys.stderr.write(substitute(response.get("stderr", ""), values))
    sys.stdout.flush()
    sys.stderr.flush()
    if response.get("sleep_seconds"):
        time.sleep(float(response["sleep_seconds"]))
    if response.get("controller") == "exit":
        layout.stop_request.touch()
        deadline = time.time() + 10
        while controller_state(layout) == "alive" and time.time() < deadline:
            time.sleep(0.1)
    if response.get("stdout_after") or response.get("stderr_after"):
        values = placeholders(layout, scenario, call, groups)
        sys.stdout.write(substitute(response.get("stdout_after", ""), values))
        sys.stderr.write(substitute(response.get("stderr_after", ""), values))
        sys.stdout.flush()
        sys.stderr.flush()
    return exit_code


def main(argv: list[str]) -> int:
    if argv[:1] in (["--replay-controller"], ["--replay-child"]):
        return run_controller(Layout(Path(argv[1]), Path(argv[2])), "controller" if argv[0] == "--replay-controller" else "child")
    return dispatch(argv, os.environ.get("REPLAY_CLI_TOOL", "run-bench"))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
