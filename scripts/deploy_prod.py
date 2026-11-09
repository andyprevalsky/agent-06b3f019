#!/usr/bin/env python3
"""Post-merge production verification as one command (`scripts/deploy production`).

Ports the production lanes (DEPRECATED_deploy.md Steps 13-13c). Lane applicability comes from the merge commit's
own diff (`git diff --name-only <sha>^1 <sha>`, never the latest main). Every
applicable lane runs concurrently once its dependencies pass; a failed lane
never cancels another, and its dependents are recorded BLOCKED. Existing tools
own each check (run_deploy_pipeline.py production / production-render /
production-semantic, prod-endpoint-smoke.ts, validate-prod-workflow-migration.ts,
run-bench). The result is <state-dir>/production-lanes.json and one final
`DEPLOY_PRODUCTION PASS|FAIL` line; exit 0 only when every applicable lane passed, was
elected away (--skip-agentcard), or is the standing AgentCard release stall
(SKIPPED-stall: satisfied like a pass, recorded loudly, never a PASS). A Render,
Vercel or Mac release rollout of the merge that a newer main commit replaced
(canceled / inactive / superseded) is satisfied only by a successful live
rollout of a strict descendant of the merge commit: recorded
PASS-verified-by-descendant with the live SHA, never relabelled an exact PASS.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import threading
import time
from typing import Callable
import urllib.error
import urllib.parse
import urllib.request
import uuid

from run_deploy_pipeline import _dotenv_values  # scripts/ is sys.path[0]: one env-file parser
from run_deploy_pipeline import gh_token_pool_argv  # one GitHub token pool pick for read-only gh calls

ROOT = Path(__file__).resolve().parents[1]
PY = sys.executable or 'python3'
BACKEND_URL = 'https://navi-j9a9.onrender.com'
FRONTEND_URL = 'https://www.roselabs.ai'
PROBE_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30'
RENDER_LOGS_URL = 'https://api.render.com/v1/logs'
RENDER_LOG_PATTERNS = ('prisma:error', 'does not exist', '-> 500', '"status":500')
DEVBOX_GH = Path('/opt/devbox-tools/gh/current/bin/gh')
EXISTING_PROCESS_DOC = 'docs/existing-worker-process-deployment.md'
CLASSIFY = Path('scripts') / 'classify-agent-runtime-changes.sh'
SMOKE_VARS = ('SMOKE_BASE_URL', 'SMOKE_HEALTH_URL', 'SMOKE_FRONTEND_URL')
REPORT = 'production-lanes.json'
SCHEMA = 1

# deploy.md Phase 1 path rules (CHANGED_BACKEND / CHANGED_AGENTCARD_PAYMENT).
BACKEND_RE = re.compile(r'^(back-end/|scripts/run-bench-hub-poller$)')
AGENTCARD_RE = re.compile(
    r'^(back-end/(scripts/setup-benchmark-payment\.ts|src/domains/(agentcard|purchases|test-payment)/|'
    r'src/providers/(agentcard/|card-provider/|purchaseCleanup\.ts|purchase-wallet-funding|wallet-funding\.ts))|'
    r'agents/(benchmarks/|domains/request_payment_card/|tools/request_payment_card\.py)|'
    r'front-end/src/features/test-payment/|scripts/(run\.sh|run-agentcard-lifecycle-task\.sh))')
LEDGER_PREFIX = 'agents/benchmarks/history/'
AGENTS_WORKFLOW_PATH = '.github/workflows/deploy-agents.yml'
# Step 13w: `grep -F` substrings. Build inputs force --build-wmh + --refresh-wmh
# first (guests refuse a stale native venv; setup-world-model.sh builds that venv).
WMH_PATHS = ('agents/benchmarks/world_model_harness.py', 'agents/benchmarks/experiential_bridge.py',
             'agents/benchmarks/serve_world_model.py', 'agents/benchmarks/build_experiential_world_model.py',
             'agents/benchmarks/wmh_', 'agents/vendor/world-model/', 'agents/requirements-world-model.txt',
             'scripts/setup-world-model.sh')
WMH_BUILD_INPUTS = ('agents/benchmarks/build_experiential_world_model.py', 'agents/vendor/world-model/',
                    'agents/requirements-world-model.txt', 'scripts/setup-world-model.sh')
MAC_LABEL = 'MAC-APP-RELEASE'
# auto-tag-mac-app.yml's own decision (label OR a shipped mac-app/front-end change), so a release CI cuts is watched.
MAC_DECISION = Path('scripts') / 'mac-app-release-decision'

LANES = ('render', 'fly', 'vercel', 'mac-release', 'wmh', 'backend-probes', 'workflow-migration', 'agentcard',
         'semantic')
DEPENDS = {'backend-probes': ('render',), 'workflow-migration': ('fly',), 'agentcard': ('render', 'vercel'),
           'semantic': ('render', 'vercel', 'fly')}
FACTORY_LANES = frozenset({'vercel', 'render', 'fly', 'mac-release', 'backend-probes', 'semantic', 'agentcard'})
PASS, FAIL, BLOCKED, SKIPPED, NOT_SELECTED = 'PASS', 'FAIL', 'BLOCKED', 'SKIPPED-not-applicable', 'NOT-SELECTED'
ELECTED = 'SKIPPED-elected'  # explicit --skip-agentcard election (deploy.md AgentCard election): not a failure
# The permanent user-approved AgentCard release stall (docs/rca/cases/2026-10-02-agentcard-abandonment-closed-card-
# transfer-never-released.md, deploy.md Skippable tests), proven from the run's own native record: satisfied like a
# pass, never a PASS. The unreleased allocation and pending Stripe refund are recorded and never called cleaned up.
STALL = 'SKIPPED-stall'
# The merge's own rollout was replaced by a newer main commit and a successful live rollout of a strict descendant of
# the merge commit carries it: satisfied like a pass, recorded with the live SHA, never an exact-SHA PASS.
DESCENDANT = 'PASS-verified-by-descendant'
SATISFIED = (PASS, ELECTED, STALL, DESCENDANT)
PASSED = (PASS, DESCENDANT)  # what a dependent lane accepts
STALL_ENV = 'BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL'  # run_benchmark._agentcard_release_skip_enabled: only "1" waives
AGENTCARD_TASK = 'agent-payment-production-abandonment'
RUNS_DIR = Path('agents') / 'benchmarks' / 'runs'  # BenchmarkRun.save() writes the native record here
RECORD_SAVED = re.compile(r'^\s*Results saved:\s*(\S.*?)\s*$')  # run_benchmark prints it after saving
MAX_RECORD_BYTES = 256 * 1024 * 1024
SECRET_KEY = re.compile(r'(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|DATABASE_URL|DIRECT_URL)', re.I)


class LaneError(RuntimeError):
    """A lane cannot pass; the message is the operator's next action."""


class Stall(str):
    """The reason of the standing AgentCard release stall. A lane returns (False, Stall(...), code), so a caller that
    only reads `passed` fails closed; only the scheduler records it as the satisfied-but-never-PASS STALL status."""


class Descendant(str):
    """The reason of a lane verified by a descendant: (True, Descendant('verified by descendant <live sha>: ...'), 0).
    The scheduler records it as DESCENDANT, never as an exact-SHA PASS."""


@dataclass
class IO:
    """Every side effect, injectable for offline tests."""
    run: Callable[..., int]  # (argv, cwd, env, on_line) -> exit code; streams merged stdout/stderr
    capture: Callable[..., tuple[int, str, str]]  # (argv, cwd, env, input=None) -> (code, stdout, stderr)
    http_get: Callable[..., tuple[int, bytes]]  # (url, headers, timeout) -> (status, body); 0 = network error
    sleep: Callable[[float], None] = time.sleep
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)
    out: Callable[[str], None] = lambda line: print(line, flush=True)
    exists: Callable[[Path], bool] = lambda path: path.exists()


def _run_stream(argv: list[str], cwd: Path, env: dict, on_line: Callable[[str], None]) -> int:
    try:
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, errors='replace', bufsize=1)
    except OSError as error:
        on_line(f'cannot start {argv[0]}: {error}')
        return 127
    assert proc.stdout is not None
    for line in proc.stdout:
        on_line(line.rstrip('\n'))
    return proc.wait()


def _capture(argv: list[str], cwd: Path, env: dict, input: str | None = None) -> tuple[int, str, str]:
    try:
        done = subprocess.run(argv, cwd=cwd, env=env, input=input, capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired) as error:
        return 127, '', str(error)
    return done.returncode, done.stdout, done.stderr


def _http_get(url: str, headers: dict, timeout: float) -> tuple[int, bytes]:
    request = urllib.request.Request(url, headers={'User-Agent': 'rose-deploy-production/1', **headers})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    except (urllib.error.URLError, OSError, ValueError) as error:
        return 0, str(error).encode()


def default_io() -> IO:
    return IO(run=_run_stream, capture=_capture, http_get=_http_get)


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ── Applicability ─────────────────────────────────────────────────────────────
@dataclass
class Lane:
    name: str
    applicable: bool
    reason: str
    deps: tuple[str, ...] = ()
    error: str | None = None  # applicable, but cannot pass (e.g. Mac release decision unknown)
    build_wmh: bool = False
    elected: str | None = None  # --skip-agentcard reason: recorded, never run


def _list(paths: list[str], limit: int = 3) -> str:
    more = f' (+{len(paths) - limit} more)' if len(paths) > limit else ''
    return ', '.join(paths[:limit]) + more


def plan_lanes(changed: list[str], runtime_files: list[str], mac: dict | None, pr: int | None = None,
               mac_error: str | None = None) -> dict[str, Lane]:
    """deploy.md Step 13 lane rules for the merge commit's changed files."""
    backend = [p for p in changed if BACKEND_RE.match(p)]
    frontend = [p for p in changed if p.startswith('front-end/')]
    workflow = AGENTS_WORKFLOW_PATH in changed
    agentcard = [p for p in changed if not p.startswith(LEDGER_PREFIX) and AGENTCARD_RE.match(p)]
    wmh = [p for p in changed if any(fragment in p for fragment in WMH_PATHS)]
    wmh_build = [p for p in changed if any(fragment in p for fragment in WMH_BUILD_INPUTS)]
    fly_reason = '; '.join(filter(None, ['agent runtime files: ' + _list(runtime_files) if runtime_files else '',
                                         f'{AGENTS_WORKFLOW_PATH} changed' if workflow else '']))
    pr_name = f'PR #{pr}' if pr else 'the merged PR'
    lanes = {
        'render': Lane('render', bool(backend), 'back-end changed: ' + _list(backend) if backend
                       else 'no back-end/ or scripts/run-bench-hub-poller change'),
        'backend-probes': Lane('backend-probes', bool(backend), 'back-end changed (Step 13a probes + log scan)'
                               if backend else 'no back-end change'),
        'fly': Lane('fly', bool(fly_reason), fly_reason or 'no agent runtime or deploy-agents.yml change'),
        'workflow-migration': Lane('workflow-migration', bool(fly_reason), 'agent cutover required (Step 13ac)'
                                   if fly_reason else 'no agent cutover'),
        'vercel': Lane('vercel', bool(frontend), 'front-end/ changed: ' + _list(frontend) if frontend
                       else 'no front-end/ change'),
        'semantic': Lane('semantic', True, 'always runs (Step 13b)'),
        'agentcard': Lane('agentcard', bool(agentcard), 'AgentCard payment path changed: ' + _list(agentcard)
                          if agentcard else 'no AgentCard payment path change (benchmark history ledgers excluded)'),
        'wmh': Lane('wmh', bool(wmh), ('WMH path changed: ' + _list(wmh) + (
            '; build input changed: --build-wmh + --refresh-wmh first' if wmh_build else '; serving only, no rebuild'))
                    if wmh else 'no WMH path change', build_wmh=bool(wmh_build)),
    }
    if mac_error or not mac:
        lanes['mac-release'] = Lane('mac-release', True, 'Mac release decision unknown',
                                    error=mac_error or 'no mac-app-release-decision result')
    else:
        label = 'with' if mac.get('label') == 'true' else 'without'
        lanes['mac-release'] = Lane('mac-release', mac.get('ship') == 'true',
                                    f'mac-app-release-decision ship={mac.get("ship")} reason={mac.get("reason")} '
                                    f'({pr_name} {label} {MAC_LABEL})')
    for name, lane in lanes.items():
        lane.deps = tuple(dep for dep in DEPENDS.get(name, ()) if lanes[dep].applicable)
    return {name: lanes[name] for name in LANES}


def waves(plan: dict[str, Lane]) -> list[list[str]]:
    """Topological levels of the applicable lanes (each level starts when its dependencies pass)."""
    level: dict[str, int] = {}
    for name in LANES:  # LANES lists every dependency before its dependents
        if plan[name].applicable and not plan[name].elected:
            level[name] = 1 + max((level.get(dep, 0) for dep in plan[name].deps), default=0)
    return [[n for n in LANES if level.get(n) == depth] for depth in range(1, max(level.values(), default=0) + 1)]


# ── Shared context ────────────────────────────────────────────────────────────
@dataclass
class Ctx:
    sha: str
    root: Path
    state_dir: Path
    io: IO
    environ: dict
    plan: dict[str, Lane] = field(default_factory=dict)
    resume_fly: bool = False
    gh: str = 'gh'
    gh_env: dict = field(default_factory=dict)
    secrets: list[str] = field(default_factory=list)
    records: dict = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)
    pool_warned: bool = False

    def dotenv(self, package: str) -> dict[str, str]:
        values = _dotenv_values(self.root / package / '.env')
        self.add_secrets(values)
        return values

    def add_secrets(self, values: dict[str, str]) -> None:
        with self.lock:
            for key, value in values.items():
                if SECRET_KEY.search(key) and len(value) >= 8 and value not in self.secrets:
                    self.secrets.append(value)
            self.secrets.sort(key=len, reverse=True)

    def redact(self, text: str) -> str:
        for secret in self.secrets:
            text = text.replace(secret, '***')
        return text

    def child_env(self, extra: dict | None = None, drop: tuple[str, ...] = ()) -> dict:
        env = {**self.environ, **self.gh_env, **(extra or {})}
        for key in drop:
            env.pop(key, None)
        return env

    def emit(self, lane: str, line: str) -> None:
        line = self.redact(line)
        with self.lock:
            self.io.out(f'[{lane}] {line}')
            log = self.records.get(lane, {}).get('log')
            if log:
                with open(log, 'a', encoding='utf-8') as handle:
                    handle.write(line + '\n')

    def sh(self, lane: str, argv: list[str], *, cwd: Path | None = None, extra: dict | None = None,
           drop: tuple[str, ...] = (), env_file: str | None = None,
           watch: tuple[re.Pattern, list[str]] | None = None) -> int:
        """Stream one lane command, prefixed `[lane]`, and record its display form. `watch` = (pattern, hits):
        the first group of every output line the pattern matches is appended to hits."""
        cwd = cwd or self.root
        loaded = self.dotenv(env_file) if env_file else {}
        display = show(argv, cwd=cwd, root=self.root, extra=extra, drop=drop, env_file=env_file)
        with self.lock:
            record = self.records.setdefault(lane, {})
            record['command'] = ' && '.join(filter(None, [record.get('command'), display]))
        self.emit(lane, f'$ {display}')
        def on_line(line: str) -> None:
            matched = watch[0].match(line) if watch else None
            if matched and watch:
                watch[1].append(matched.group(1))
            self.emit(lane, line)
        code = self.io.run(argv, cwd, self.child_env({**loaded, **(extra or {})}, drop), on_line)
        self.emit(lane, f'exit {code}')
        return code

    def note(self, lane: str, display: str) -> None:
        with self.lock:
            record = self.records.setdefault(lane, {})
            record['command'] = ' && '.join(filter(None, [record.get('command'), display]))
        self.emit(lane, f'$ {display}')

    def gh_json(self, args: list[str]) -> object:
        """A read-only gh call: the token pool's best member first (GH_TOKEN's REST quota can run out
        mid-deploy), then once more with GH_TOKEN when that member fails (its 404 is not authoritative)."""
        env = self.child_env()
        code, out, err = self.io.capture(gh_token_pool_argv(self.root, env), self.root, env)
        token = out.strip() if code == 0 else ''
        if token and token != env.get('GH_TOKEN'):
            self.add_secrets({'GITHUB_POOL_TOKEN': token})
            code, out, err = self.io.capture([self.gh, *args], self.root, {**env, 'GH_TOKEN': token})
            pooled = None if code == 0 else self.redact((err or out).strip())[:300]
        else:
            if not token and not self.pool_warned:
                self.pool_warned = True
                self.emit('gh', f'token pool picked no member ({self.redact((err or out).strip())[:200] or "empty"}); '
                                'reading with GH_TOKEN')
            code, pooled = 1, ''
        if code != 0:
            code, out, err = self.io.capture([self.gh, *args], self.root, env)
        if code != 0:
            first = f" with the token pool's member ({pooled}) and with GH_TOKEN" if pooled else ''
            raise LaneError(f'gh {" ".join(args[:2])} failed{first}: {self.redact((err or out).strip())[:300]}')
        try:
            return json.loads(out or 'null')
        except json.JSONDecodeError as error:
            raise LaneError(f'gh {" ".join(args[:2])} returned invalid JSON: {error}') from error

    def factory(self, event: str, value: str) -> None:
        """Telemetry, not a gate (deploy.md Step 13): a failed record is a warning."""
        argv = [PY, 'scripts/record_factory_event.py', 'deploy', event, value]
        code, _out, err = self.io.capture(argv, self.root, self.child_env())
        if code != 0:
            self.emit('factory', f'WARNING record_factory_event deploy {event} {value} exited {code}: '
                                 f'{self.redact(err.strip())[:200]}')

    def production_receipt(self) -> dict:
        try:
            receipt = json.loads((self.state_dir / 'production.json').read_text())
        except (OSError, json.JSONDecodeError):
            return {}
        return receipt if isinstance(receipt, dict) and receipt.get('merged_sha') == self.sha else {}


def show(argv: list[str], *, cwd: Path, root: Path, extra: dict | None = None, drop: tuple[str, ...] = (),
         env_file: str | None = None) -> str:
    """Shell-equivalent display of a command; env values shown are never secrets."""
    parts = []
    if cwd != root:
        parts.append(f'cd {shlex.quote(os.path.relpath(cwd, root))} &&')
    if env_file:
        parts.append('set -a && . ./.env && set +a &&')
    if drop:
        parts.append('env ' + ' '.join(f'-u {key}' for key in drop))
    for key, value in (extra or {}).items():  # PATH is shown as the prefix it adds
        parts.append(f'PATH={shlex.quote(str(value).split(os.pathsep)[0])}:$PATH' if key == 'PATH'
                     else f'{key}={shlex.quote(str(value))}')
    parts.append(shlex.join(argv))
    return ' '.join(parts)


def gh_setup(root: Path, environ: dict, exists: Callable[[Path], bool]) -> tuple[str, dict, dict]:
    """Step 13b's override, used for every gh call and child env: the boxes.dev
    gh wrapper swaps GH_TOKEN for an App token that cannot dispatch workflows,
    so call its real binary with back-end/.env's workflow-scoped GITHUB_TOKEN
    and export DEPLOY_GH_BIN for run_deploy_pipeline.py. Returns
    (gh binary, child env overrides, values read)."""
    if not exists(DEVBOX_GH):
        return environ.get('DEPLOY_GH_BIN') or 'gh', {}, {}
    values = _dotenv_values(root / 'back-end' / '.env')
    overrides = {'DEPLOY_GH_BIN': str(DEVBOX_GH)}
    if values.get('GITHUB_TOKEN'):
        overrides['GH_TOKEN'] = values['GITHUB_TOKEN']
    return str(DEVBOX_GH), overrides, {'GITHUB_TOKEN': values.get('GITHUB_TOKEN', '')}


# ── Lane commands (shared by --dry-run and execution) ─────────────────────────
def render_argv(sha: str, state_dir: Path) -> list[str]:
    return [PY, 'scripts/run_deploy_pipeline.py', 'production-render', '--merged-sha', sha, '--state-dir', str(state_dir)]


def production_argv(sha: str, state_dir: Path) -> list[str]:
    return [PY, 'scripts/run_deploy_pipeline.py', 'production', '--merged-sha', sha, '--state-dir', str(state_dir)]


def semantic_argv(sha: str, state_dir: Path) -> list[str]:
    return [PY, 'scripts/run_deploy_pipeline.py', 'production-semantic', '--merged-sha', sha, '--state-dir',
            str(state_dir), '--frontend-url', FRONTEND_URL, '--backend-url', BACKEND_URL]


def resume_argv(job_id: str) -> list[str]:
    return ['node', '--import', 'tsx', 'scripts/worker-deployment-queue.ts', 'run', '--job-id', job_id, '--',
            'python3', '../scripts/worker_pool_cutover.py']


MIGRATION_ARGV = ['npx', 'tsx', 'scripts/validate-prod-workflow-migration.ts', '--execute']
SMOKE_ARGV = ['npx', 'tsx', 'scripts/prod-endpoint-smoke.ts']
AGENTCARD_ARGV = ['scripts/run-bench', AGENTCARD_TASK]
WMH_ARGV = ['scripts/run-bench', 'raise-5m-rose-labs-brex', '--sim-on', 'raise-5m-rose-labs-brex']
WMH_BUILD_ARGV = (['bash', 'scripts/run-bench-cloud', '--build-wmh'], ['bash', 'scripts/run-bench-cloud', '--refresh-wmh'])


def migration_env(sha: str, token: str) -> dict:
    return {'PRODUCTION_WORKFLOW_MIGRATION_VALIDATION': '1', 'TEMPORAL_TASK_QUEUE': 'navi-agent-tasks',
            'TEMPORAL_WORKER_BUILD_ID': sha, 'TEMPORAL_WORKER_DEPLOYMENT_TOKEN': token}


def venv_env(ctx: Ctx) -> dict:
    venv = ctx.root / 'agents' / 'venv'
    return {'PATH': f'{venv / "bin"}{os.pathsep}{ctx.environ.get("PATH", "")}', 'VIRTUAL_ENV': str(venv)}


def planned_commands(name: str, ctx: Ctx) -> list[str]:
    sha, sd, root, backend = ctx.sha, ctx.state_dir, ctx.root, ctx.root / 'back-end'

    def s(argv: list[str], cwd: Path = root, **kw) -> str:
        return show(argv, root=root, cwd=cwd, **kw)
    if name == 'render':
        return [s(render_argv(sha, sd))]
    if name == 'backend-probes':
        return [f'GET {BACKEND_URL}/health',
                f'GET {BACKEND_URL}/api/agents (X-API-Key=back-end/.env BACKEND_API_KEY, X-User-Id={PROBE_USER_ID}; '
                'retry 12x5s until 200)', s(SMOKE_ARGV, cwd=backend, drop=SMOKE_VARS),
                f'GET {RENDER_LOGS_URL}?ownerId=$RENDER_OWNER_ID&resource=$RENDER_SERVICE_ID&limit=100&direction=backward '
                f'(fail on {", ".join(RENDER_LOG_PATTERNS)})']
    if name == 'fly':
        return [s(production_argv(sha, sd)),
                f'on a durable job that is not SUCCEEDED: {s(resume_argv("<job_id>"), cwd=backend, env_file="back-end")}'
                f' {"then rerun production" if ctx.resume_fly else "(only with --resume-fly; otherwise FAIL)"}']
    if name == 'workflow-migration':
        return [s(MIGRATION_ARGV, cwd=backend, extra=migration_env(sha, '<run_id>-<run_attempt>'))]
    if name == 'vercel':
        return [f'{ctx.gh} api repos/{{owner}}/{{repo}}/deployments?sha={sha} (creator vercel[bot]) -> '
                '.../deployments/<id>/statuses (latest state; 90x10s)']
    if name == 'semantic':
        return [f'{s(production_argv(sha, sd))} (only when production.json is not passed for this sha)',
                s(semantic_argv(sha, sd))]
    if name == 'agentcard':
        return [s(AGENTCARD_ARGV, extra=venv_env(ctx))]
    if name == 'wmh':
        build = [s(argv) for argv in WMH_BUILD_ARGV] if ctx.plan.get('wmh') and ctx.plan['wmh'].build_wmh else []
        return build + [s(WMH_ARGV, extra=venv_env(ctx))]
    if name == 'mac-release':
        return [f'{ctx.gh} run list --workflow release-mac-app.yml (headSha={sha}, created >= merge commit time)',
                f'{ctx.gh} run watch <id> --exit-status']
    return []


# ── Lane executors: each returns (passed, reason, exit code) ─────────────────
Result = tuple[bool, str, int]


def lane_render(ctx: Ctx) -> Result:
    code = ctx.sh('render', render_argv(ctx.sha, ctx.state_dir))
    render = ctx.production_receipt().get('render') or {}
    if code == 0 and render.get('status') == 'verified-by-descendant':
        evidence = render.get('verified_by_descendant') or {}
        return True, Descendant(f'verified by descendant {render.get("live_commit")}: {evidence.get("reason")} '
                                f'({evidence.get("detail")}); not an exact-SHA deploy'), 0
    if code == 0:
        return True, f'Render serves the merged backend ({render.get("status") or "live"})', 0
    return False, f'production-render exited {code}: {render.get("error") or "Render does not serve the merged backend"}', code


def bad_log_lines(logs: list) -> list[dict]:
    """Step 13a step 3: Render log lines that prove a post-deploy runtime error."""
    return [entry for entry in logs if isinstance(entry, dict)
            and any(pattern in str(entry.get('message', '')) for pattern in RENDER_LOG_PATTERNS)]


def render_log_scan(ctx: Ctx, lane: str = 'backend-probes') -> tuple[bool, str]:
    env = ctx.dotenv('back-end')
    missing = [key for key in ('RENDER_API_KEY', 'RENDER_OWNER_ID', 'RENDER_SERVICE_ID') if not env.get(key)]
    if missing:
        return False, f'Render log scan: {", ".join(missing)} missing from back-end/.env'
    query = urllib.parse.urlencode({'ownerId': env['RENDER_OWNER_ID'], 'resource': env['RENDER_SERVICE_ID'],
                                    'limit': 100, 'direction': 'backward'})
    ctx.note(lane, f'GET {RENDER_LOGS_URL}?ownerId=$RENDER_OWNER_ID&resource=$RENDER_SERVICE_ID&limit=100&direction=backward')
    status, body = ctx.io.http_get(f'{RENDER_LOGS_URL}?{query}', {'Authorization': f'Bearer {env["RENDER_API_KEY"]}',
                                                                  'Accept': 'application/json'}, 30)
    if status != 200:
        return False, f'Render logs API -> {status}: {ctx.redact(body[:200].decode("utf-8", "replace"))}'
    try:
        logs = json.loads(body)['logs']
        assert isinstance(logs, list)
    except (ValueError, KeyError, TypeError, AssertionError):
        return False, 'Render logs API returned no `logs` list'
    bad = bad_log_lines(logs)
    ctx.emit(lane, f'post-deploy error lines: {len(bad)}')
    for entry in bad[:10]:
        ctx.emit(lane, f'{str(entry.get("timestamp", ""))[11:19]} {str(entry.get("message", ""))[:160]}')
    return (not bad), (f'{len(bad)} post-deploy error lines in the Render log' if bad else 'Render log clean')


def lane_backend_probes(ctx: Ctx) -> Result:
    lane, url = 'backend-probes', BACKEND_URL
    ctx.note(lane, f'GET {url}/health')
    status, _body = ctx.io.http_get(f'{url}/health', {}, 30)
    if not 200 <= status < 400:
        return False, f'/health -> {status} {ctx.redact(_body[:200].decode("utf-8", "replace"))}'.strip(), 1
    key = ctx.dotenv('back-end').get('BACKEND_API_KEY')
    if not key:
        return False, 'BACKEND_API_KEY missing from back-end/.env', 1
    ctx.note(lane, f'GET {url}/api/agents (X-API-Key=$BACKEND_API_KEY, X-User-Id={PROBE_USER_ID})')
    body = b''
    for attempt in range(1, 13):  # ~1 min: Render flips live a beat before the new process serves
        status, body = ctx.io.http_get(f'{url}/api/agents', {'X-API-Key': key, 'X-User-Id': PROBE_USER_ID}, 30)
        if status == 200:
            break
        ctx.emit(lane, f'/api/agents -> {status} (retry {attempt})')
        if attempt < 12:
            ctx.io.sleep(5)
    else:
        ctx.emit(lane, body[:500].decode('utf-8', 'replace'))
        return False, f'FUNCTIONAL CHECK FAILED: /api/agents -> {status}', 1
    ctx.emit(lane, '/api/agents -> 200 (DB/Prisma path healthy)')
    smoke = ctx.sh(lane, SMOKE_ARGV, cwd=ctx.root / 'back-end', drop=SMOKE_VARS)
    scanned, scan_reason = render_log_scan(ctx, lane)
    if smoke != 0 or not scanned:
        failures = ([f'prod-endpoint-smoke exited {smoke}'] if smoke else []) + ([scan_reason] if not scanned else [])
        return False, '; '.join(failures), smoke or 1
    return True, '/health + /api/agents 200, endpoint smoke passed, Render log clean', 0


def lane_fly(ctx: Ctx) -> Result:
    if ctx.environ.get('AGENT_DEPLOY_MODE', 'cooperative') == 'existing-process':
        return False, (f'AGENT_DEPLOY_MODE=existing-process is not automated by this command: follow '
                       f'{EXISTING_PROCESS_DOC} (deploy-existing-worker-processes.ts activate, then verify-live), '
                       'then rerun the remaining lanes'), 2
    ctx.factory('stage-start', 'cooperative-cutover')
    code = ctx.sh('fly', production_argv(ctx.sha, ctx.state_dir))
    if code != 0:
        receipt = ctx.production_receipt()
        fly = receipt.get('fly') or {}
        job, stage = fly.get('job_id'), fly.get('job_stage')
        if not (job and stage and stage not in ('SUCCEEDED', 'ABORTED')):
            return False, f'Fly lane blocked (production exit {code}): {receipt.get("error") or "see [fly] output"}', code
        resume = show(resume_argv(job), cwd=ctx.root / 'back-end', root=ctx.root, env_file='back-end')
        if not ctx.resume_fly:
            return False, (f'durable job {job} is {stage}, not SUCCEEDED; resume the SAME job: `{resume}` '
                           '(or rerun with --resume-fly)'), code
        resumed = ctx.sh('fly', resume_argv(job), cwd=ctx.root / 'back-end', env_file='back-end')
        if resumed != 0:
            return False, f'resume of durable job {job} exited {resumed}', resumed
        code = ctx.sh('fly', production_argv(ctx.sha, ctx.state_dir))
        if code != 0:
            error = ctx.production_receipt().get('error') or 'see [fly] output'
            return False, f'Fly lane still blocked after resuming job {job}: {error}', code
    ctx.factory('stage-finish', 'cooperative-cutover')
    fly = ctx.production_receipt().get('fly') or {}
    if fly.get('required') is False:
        return True, 'production gate open (no agent runtime change in the merge)', 0
    carried = (fly.get('verified_by_descendant') or {}).get('descendant_job_id')
    return True, (f'deploy-agents run {fly.get("run_id")} attempt {fly.get("attempt")} job {fly.get("job_id")} '
                  f'{fly.get("job_stage")} + monitor --verify'
                  + (f' (verified by descendant cutover {carried}, not its own)' if carried else '')), 0


def lane_workflow_migration(ctx: Ctx) -> Result:
    token = (ctx.production_receipt().get('fly') or {}).get('deployment_token')
    if not token:
        return False, 'no fly.deployment_token for this sha in production.json; run the fly lane first', 1
    code = ctx.sh('workflow-migration', MIGRATION_ARGV, cwd=ctx.root / 'back-end', extra=migration_env(ctx.sha, token))
    return (code == 0), ('every migration row PASS' if code == 0 else f'validate-prod-workflow-migration exited {code}'), code


def is_descendant(ctx: Ctx, live: str) -> bool:
    """`live` strictly descends from the merge commit (`git merge-base --is-ancestor <merge> <live>`). A commit this
    checkout does not know yet (a newer main merge) gets one `git fetch origin main`; any other git failure is a
    LaneError, never an answer."""
    if not re.fullmatch(r'[0-9a-f]{40}', live or '') or live == ctx.sha:
        return False
    argv = ['git', 'merge-base', '--is-ancestor', ctx.sha, live]
    code, _out, err = ctx.io.capture(argv, ctx.root, ctx.child_env())
    if code not in (0, 1):
        fetched, _out, _err = ctx.io.capture(['git', 'fetch', '--quiet', 'origin', 'main'], ctx.root, ctx.child_env())
        if fetched == 0:
            code, _out, err = ctx.io.capture(argv, ctx.root, ctx.child_env())
    if code not in (0, 1):
        raise LaneError(f'git merge-base --is-ancestor {ctx.sha[:12]} {live[:12]} failed: {ctx.redact(err.strip())[:200]}'
                        '; fetch origin main and rerun')
    return code == 0


def vercel_decide(statuses: object) -> tuple[str, str]:
    """(decision, state): decision is success | failed | pending."""
    state = 'pending'
    if isinstance(statuses, list) and statuses and isinstance(statuses[0], dict):
        state = statuses[0].get('state') or 'pending'
    if state == 'success':
        return 'success', state
    if state in ('failure', 'error', 'inactive'):
        return 'failed', state
    return 'pending', state


def vercel_rows(deployments: object) -> list[dict]:
    return [row for row in deployments if isinstance(row, dict) and (row.get('creator') or {}).get('login')
            == 'vercel[bot]'] if isinstance(deployments, list) else []


def vercel_superseded(ctx: Ctx, mine: dict) -> tuple[str, str]:
    """The merge's Vercel deployment is `inactive`: GitHub deactivates an older deployment once a newer one in the same
    environment succeeds. (verdict, reason): `verified` only when the newest successful vercel[bot] deployment created
    after ours in that environment is a strict descendant of the merge commit; `pending` while no newer deployment
    succeeded but one is still in progress; otherwise `refused` (no newer success, an older or unrelated live commit)."""
    ours, environment, created = str(mine.get('id')), mine.get('environment'), mine.get('created_at')
    head = f'Vercel deployment {ours} inactive'
    if not environment or not created:
        return 'refused', f'{head}; it names no environment/created_at, so no newer production deployment is verifiable'
    query = urllib.parse.urlencode({'environment': environment, 'per_page': 30})
    newer = sorted((row for row in vercel_rows(ctx.gh_json(['api', f'repos/{{owner}}/{{repo}}/deployments?{query}']))
                    if str(row.get('id')) != ours and str(row.get('created_at') or '') > str(created)),
                   key=lambda row: str(row.get('created_at')), reverse=True)
    pending = []
    for row in newer:  # newest first: the first success is the live production deployment
        decision, state = vercel_decide(ctx.gh_json(['api', f'repos/{{owner}}/{{repo}}/deployments/{row.get("id")}'
                                                     '/statuses']))
        if decision == 'pending':
            pending.append(row)
        if state != 'success':
            continue
        live = str(row.get('sha') or '')
        if is_descendant(ctx, live):
            return 'verified', (f'verified by descendant {live}: {head}; {environment} deployment {row.get("id")} for '
                                f'{live[:12]} (a descendant of {ctx.sha[:12]}) success')
        if pending:
            break
        return 'refused', (f'{head}; the live {environment} deployment {row.get("id")} is {live[:12] or "unknown"}, '
                           f'not a descendant of {ctx.sha[:12]}')
    if pending:
        return 'pending', f'{head}; newer {environment} deployment {pending[-1].get("id")} still in progress'
    return 'refused', f'{head} and no newer successful {environment} deployment exists'


def lane_vercel(ctx: Ctx, attempts: int = 90, interval: float = 10.0) -> Result:
    lane = 'vercel'
    ctx.note(lane, f'{ctx.gh} api repos/{{owner}}/{{repo}}/deployments?sha={ctx.sha} (vercel[bot]) + statuses')
    for attempt in range(1, attempts + 1):
        try:
            rows = vercel_rows(ctx.gh_json(['api', f'repos/{{owner}}/{{repo}}/deployments?sha={ctx.sha}']))
            if rows:
                deployment = str(rows[0].get('id'))
                statuses = ctx.gh_json(['api', f'repos/{{owner}}/{{repo}}/deployments/{deployment}/statuses'])
                decision, state = vercel_decide(statuses)
                ctx.emit(lane, f'Vercel: state={state} deployment={deployment}')
                if decision == 'success':
                    return True, f'Vercel deployment {deployment} success', 0
                if state == 'inactive':  # replaced by a newer deployment: only a live descendant verifies it
                    verdict, reason = vercel_superseded(ctx, rows[0])
                    ctx.emit(lane, f'Vercel: {verdict}: {reason}')
                    if verdict == 'verified':
                        return True, Descendant(reason), 0
                    if verdict == 'refused':
                        return False, reason, 1
                elif decision == 'failed':
                    return False, f'Vercel deployment {deployment} {state}', 1
        except LaneError as error:  # a transient gh error is a missed poll, as in the old loop
            ctx.emit(lane, f'poll {attempt}: {error}')
        if attempt < attempts:
            ctx.io.sleep(interval)
    return False, f'Vercel did not bring {ctx.sha[:12]} live within {attempts}x{interval:.0f}s', 1


def lane_semantic(ctx: Ctx) -> Result:
    receipt = ctx.production_receipt()
    if receipt.get('status') != 'passed':  # production-semantic requires the passed Fly-lane receipt
        code = ctx.sh('semantic', production_argv(ctx.sha, ctx.state_dir))
        if code != 0:
            return False, f'Fly-lane gate (production) exited {code}; semantics not dispatched', code
    code = ctx.sh('semantic', semantic_argv(ctx.sha, ctx.state_dir))
    run = (ctx.production_receipt().get('semantic') or {}).get('run_id')
    return (code == 0), (f'chat-lifecycle-ratchet run {run} success' if code == 0
                         else f'production-semantic exited {code} (run {run})'), code


def release_stalled(lifecycle: object, *, livemode: bool) -> bool:
    """Mirror of agents/benchmarks/run_benchmark.py::_agentcard_release_stalled (that module needs the full agent
    env to import; scripts/tests/deploy-prod.test.py pins this copy to the runner's own function over every
    single-field mutation): Rose closed the card and is reclaiming while AgentCard still reports this card's
    transfer consumed with nothing released, in the expected provider mode."""
    if not isinstance(lifecycle, dict):
        return False
    purchase, funding = lifecycle.get('purchase'), lifecycle.get('walletFunding')
    card, transfer = lifecycle.get('agentCard'), lifecycle.get('orgTransfer')
    return (isinstance(purchase, dict) and purchase.get('status') == 'HELD'
            and isinstance(funding, dict) and funding.get('status') == 'RECLAIMING'
            and isinstance(card, dict) and card.get('status') == 'CLOSED'
            and card.get('balanceCents') == 0 and not isinstance(card.get('balanceCents'), bool)
            and isinstance(card.get('id'), str) and bool(card['id'].strip())
            and purchase.get('cardId') == card['id']
            and isinstance(transfer, dict) and isinstance(transfer.get('id'), str) and bool(transfer['id'].strip())
            and funding.get('providerTransferId') == transfer['id']
            and transfer.get('cardId') == card['id']
            and transfer.get('status') == 'consumed'
            and transfer.get('livemode') is livemode
            and transfer.get('releasedCents') == 0 and not isinstance(transfer.get('releasedCents'), bool)
            and 'stripeRefund' in lifecycle and lifecycle['stripeRefund'] is None)


@dataclass
class StallCheck:
    stall: Stall | None = None  # the lane reason of the exact standing stall
    why: str = ''  # otherwise: why this execution's record is not that stall (the operator's next fact)
    claims: bool = False  # the located record itself claims the stall (SKIPPED + the runtime reason prefix)


def check_stall(ctx: Ctx, saved: list[str], started: datetime) -> StallCheck:
    """Prove the standing release stall from THIS execution's native run record, or say why not.

    The record is the one the CLI printed (`Results saved:`), written directly in agents/benchmarks/runs, created
    after the lane started and holding exactly the production task. It qualifies only when the task is SKIPPED with
    the runner's own stall reason, nothing else failed (no cleanup failure, no evidence/cleanup error, no failed or
    extra task), its typed lifecycle is the exact livemode=true stall (release_stalled) and the catalog declares the
    production waiver (the staged cycle's predicate). Anything else, or BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL
    other than 1, is not the stall.
    """
    import deploy_test_cycle as cycle  # scripts/ is sys.path[0]: the staged cycle owns the stall's reason and amount
    if ctx.environ.get(STALL_ENV, '1') != '1':
        return StallCheck(why=f'{STALL_ENV} is not 1, so release diagnostics are strict')
    paths = sorted(set(saved))
    if len(paths) != 1:
        return StallCheck(why='no run record path was printed by this execution' if not paths
                          else f'{len(paths)} different run records were printed')
    raw = Path(paths[0])
    path = (raw if raw.is_absolute() else ctx.root / 'agents' / raw).resolve()
    if path.parent != (ctx.root / RUNS_DIR).resolve():
        return StallCheck(why=f'record {raw} is outside {RUNS_DIR}')
    try:
        if not path.is_file():
            return StallCheck(why=f'record {path.name} is not a file')
        if path.stat().st_size > MAX_RECORD_BYTES:
            return StallCheck(why=f'record {path.name} exceeds {MAX_RECORD_BYTES} bytes')
        record = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        return StallCheck(why=f'record {path.name} is not a JSON object ({error})')
    if not isinstance(record, dict):
        return StallCheck(why=f'record {path.name} is not a JSON object')
    try:
        created = datetime.fromisoformat(str(record['timestamp']))
        if created.tzinfo is None:
            raise ValueError('no timezone')
    except (KeyError, ValueError):
        return StallCheck(why=f'record {path.name} timestamp is missing or not a timezone-aware ISO time')
    if created < started:
        return StallCheck(why=f'record {path.name} was created before this lane started ({created.isoformat()})')
    tasks = record.get('tasks')
    rows = [row for row in tasks if isinstance(row, dict) and row.get('name') == AGENTCARD_TASK] \
        if isinstance(tasks, list) else []
    if len(rows) != 1 or len(tasks) != 1:
        return StallCheck(why=f'record {path.name} is not exactly one {AGENTCARD_TASK} task')
    row, summary = rows[0], record.get('summary')
    reason = row.get('failure_reason')
    prefixed = isinstance(reason, str) and reason.startswith(cycle.AGENTCARD_RELEASE_STALL_REASON)
    claims = 'SKIPPED' in (row.get('status'), row.get('benchmark_status')) and prefixed
    logs = row.get('logs') if isinstance(row.get('logs'), dict) else {}
    evidence = logs.get('failure_evidence') if isinstance(logs.get('failure_evidence'), dict) else {}
    lifecycle = logs.get('agentcard_release_stall_lifecycle')
    for ok, why in (
            (row.get('status') == 'SKIPPED' and row.get('benchmark_status') == 'SKIPPED' and row.get('passed') is False,
             'task status/benchmark_status is not SKIPPED'),
            (prefixed, 'task failure_reason is not the standing release-stall reason'),
            (not row.get('cleanup_failure'), 'task has a cleanup_failure'),
            (evidence.get('errors') == [], 'task logs carry evidence/cleanup errors'),
            (isinstance(summary, dict) and all(type(summary.get(key)) is int and summary[key] == want for key, want in
                                               {'total': 1, 'skipped': 1, 'passed': 0, 'failed': 0,
                                                'cleanup_failures': 0}.items()),
             'run summary is not exactly one skipped task with no failed or cleanup failures'),
            (release_stalled(lifecycle, livemode=True),
             'typed lifecycle is not the exact live closed-card / consumed-transfer / zero-release stall'),
            (cycle.agentcard_release_stall_task(AGENTCARD_TASK, ctx.root, production=True),
             'the catalog does not declare the production release-stall waiver')):
        if not ok:
            return StallCheck(why=f'{why} (record {path.name})', claims=claims)
    shown = path.relative_to(ctx.root.resolve())
    return StallCheck(Stall(f'{cycle.unreleased_amount_text(lifecycle["orgTransfer"])}; pending Stripe refund; '
                            f'followup: unreleased funds stay open (record {shown})'), claims=True)


def lane_agentcard(ctx: Ctx) -> Result:
    """The production abandonment lifecycle. The runner records the standing release stall as a natively SKIPPED
    task that its own --ci rule permits (exit 0), so an exit code alone would read the stall as PASS (or, were the
    runner to fail on it, block the deploy). Exit 0 or 1 is therefore judged by this execution's native record:
    the exact stall is SKIPPED-stall; a record that claims the stall without the exact evidence fails even at
    exit 0. Every other exit code, and any run without that proof, keeps its exit-code verdict."""
    started, saved = ctx.io.now(), []
    code = ctx.sh('agentcard', AGENTCARD_ARGV, extra=venv_env(ctx), watch=(RECORD_SAVED, saved))
    failed = f'run-bench {AGENTCARD_TASK} exited {code}'
    if code not in (0, 1):
        return False, failed, code
    check = check_stall(ctx, saved, started)
    if check.stall:
        return False, check.stall, code
    if code == 0:
        if check.claims:
            return False, f'{failed} but its run record claims the AgentCard release stall: {check.why}', code
        return True, f'{AGENTCARD_TASK} passed', 0
    return False, (f'{failed}; AgentCard release stall not qualified: {check.why}' if check.why else failed), code


def lane_wmh(ctx: Ctx) -> Result:
    if ctx.plan['wmh'].build_wmh:
        for argv in WMH_BUILD_ARGV:
            code = ctx.sh('wmh', argv)
            if code != 0:
                return False, f'{shlex.join(argv)} exited {code}', code
    code = ctx.sh('wmh', WMH_ARGV, extra=venv_env(ctx))
    return (code == 0), ('raise-5m-rose-labs-brex SIM passed' if code == 0
                         else f'run-bench raise-5m-rose-labs-brex --sim-on exited {code}'), code


def merge_time(ctx: Ctx) -> str:
    code, out, err = ctx.io.capture(['git', 'show', '-s', '--format=%cI', ctx.sha], ctx.root, ctx.child_env())
    if code != 0 or not out.strip():
        raise LaneError(f'cannot read the merge commit time of {ctx.sha[:12]}: {err.strip()}')
    return iso(datetime.fromisoformat(out.strip().replace('Z', '+00:00')))


MAC_RUN_FIELDS = 'databaseId,headSha,createdAt,headBranch,status,conclusion'
MAC_DESCENDANT_HOPS = 5  # later releases followed when each one is itself cancelled by a newer tag


def mac_release_runs(ctx: Ctx, lane: str, attempt: int) -> list[dict]:
    try:
        rows = ctx.gh_json(['run', 'list', '--workflow', 'release-mac-app.yml', '--limit', '30', '--json',
                            MAC_RUN_FIELDS])
    except LaneError as failure:
        ctx.emit(lane, f'poll {attempt}: {failure}')
        return []
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def mac_descendant_runs(ctx: Ctx, rows: list[dict], since: str, tried: set[str]) -> list[dict]:
    """Release runs created after the merge for a tag on a strict descendant of the merge commit, oldest first (the
    release that replaced ours), skipping runs already tried and runs GitHub cancelled for a newer tag."""
    later = [row for row in rows if str(row.get('createdAt', '')) >= since and row.get('headSha') != ctx.sha
             and str(row.get('databaseId')) not in tried
             and not (row.get('status') == 'completed' and row.get('conclusion') == 'cancelled')]
    return sorted((row for row in later if is_descendant(ctx, str(row.get('headSha') or ''))),
                  key=lambda row: str(row.get('createdAt')))


def mac_watch(ctx: Ctx, lane: str, run_id: str) -> tuple[int, str]:
    """(exit code, conclusion) of `gh run watch --exit-status`; a non-zero exit reads the run's conclusion so a
    cancelled (superseded) run is told apart from a failed one."""
    code = ctx.sh(lane, [ctx.gh, 'run', 'watch', run_id, '--exit-status'])
    if code == 0:
        return 0, 'success'
    try:
        view = ctx.gh_json(['run', 'view', run_id, '--json', 'status,conclusion'])
    except LaneError as failure:
        ctx.emit(lane, f'run view {run_id}: {failure}')
        return code, ''
    return code, str(view.get('conclusion') or '') if isinstance(view, dict) else ''


def lane_mac_release(ctx: Ctx, attempts: int = 60, interval: float = 10.0) -> Result:
    """release-mac-app.yml runs on the v* tag auto-tag-mac-app.yml points at the
    merge commit, so its headBranch is the tag, never main: bind the exact
    headSha created after the merge (never a stale run). Both workflows keep at
    most one pending run per concurrency group, so a newer merge can cancel the
    merge's pending release (or its pending auto-tag, leaving no release run):
    then only a later release run for a strict descendant of the merge commit
    that succeeds verifies the lane, as PASS-verified-by-descendant."""
    lane, error = 'mac-release', ctx.plan['mac-release'].error
    if error:
        return False, f'cannot decide the Mac release: {error}', 1
    since = merge_time(ctx)
    ctx.note(lane, f'{ctx.gh} run list --workflow release-mac-app.yml --limit 30 (headSha={ctx.sha}, created>={since})')
    run_id, descendant = None, None
    for attempt in range(1, attempts + 1):
        rows = mac_release_runs(ctx, lane, attempt)
        match = [r for r in rows if r.get('headSha') == ctx.sha and str(r.get('createdAt', '')) >= since]
        if match:
            run_id = str(match[0]['databaseId'])
            ctx.emit(lane, f'release run {run_id} ({match[0].get("headBranch")}) {match[0].get("status")}')
            break
        later = mac_descendant_runs(ctx, rows, since, set())
        if later:  # auto-tag serializes tags: a descendant's release with none for ours means ours was never tagged
            descendant = later[0]
            ctx.emit(lane, f'no release run for {ctx.sha[:12]}; descendant release run {descendant.get("databaseId")} '
                           f'({descendant.get("headBranch")}) for {str(descendant.get("headSha"))[:12]}')
            break
        if attempt < attempts:
            ctx.io.sleep(interval)
    if not run_id and not descendant:
        return False, (f'no release-mac-app.yml run for {ctx.sha[:12]} appeared within {attempts}x{interval:.0f}s '
                       '(check auto-tag-mac-app.yml)'), 1
    tried: set[str] = set()
    if run_id:
        code, conclusion = mac_watch(ctx, lane, run_id)
        if code == 0:
            return True, f'release-mac-app run {run_id} success', 0
        if conclusion != 'cancelled':
            return False, f'release-mac-app run {run_id} failed (exit {code})', code
        superseded = f'release-mac-app run {run_id} for {ctx.sha[:12]} was cancelled'
        tried.add(run_id)
    else:
        code, superseded = 1, f'no release-mac-app run for {ctx.sha[:12]} was created (its auto-tag was superseded)'
    for _hop in range(MAC_DESCENDANT_HOPS):
        if descendant is None:
            later = mac_descendant_runs(ctx, mac_release_runs(ctx, lane, 0), since, tried)
            if not later:
                return False, f'{superseded} and no later release run of a descendant of it exists', code or 1
            descendant = later[0]
        later_id, head = str(descendant.get('databaseId')), str(descendant.get('headSha'))
        tried.add(later_id)
        later_code, later_conclusion = mac_watch(ctx, lane, later_id)
        if later_code == 0:
            return True, Descendant(f'verified by descendant {head}: {superseded}; release-mac-app run {later_id} '
                                    f'({descendant.get("headBranch")}) for {head[:12]} success'), 0
        if later_conclusion != 'cancelled':
            return False, (f'{superseded}; descendant release run {later_id} for {head[:12]} failed '
                           f'(exit {later_code})'), later_code
        descendant = None
    return False, f'{superseded}; {MAC_DESCENDANT_HOPS} later descendant release runs were all cancelled', code or 1


LANE_FUNCS: dict[str, Callable[[Ctx], Result]] = {
    'render': lane_render, 'backend-probes': lane_backend_probes, 'fly': lane_fly,
    'workflow-migration': lane_workflow_migration, 'vercel': lane_vercel, 'semantic': lane_semantic,
    'agentcard': lane_agentcard, 'wmh': lane_wmh, 'mac-release': lane_mac_release,
}


# ── Scheduler + report ────────────────────────────────────────────────────────
def write_report(ctx: Ctx, meta: dict) -> None:
    with ctx.lock:
        payload = {**meta, 'lanes': {name: dict(ctx.records[name]) for name in LANES if name in ctx.records}}
        path = ctx.state_dir / REPORT
        temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
        temporary.write_text(json.dumps(payload, indent=2) + '\n')
        temporary.replace(path)


def execute(ctx: Ctx, selected: set[str], meta: dict, lane_funcs: dict | None = None) -> dict:
    funcs = {**LANE_FUNCS, **(lane_funcs or {})}
    prior: dict = {}
    try:
        previous = json.loads((ctx.state_dir / REPORT).read_text())
        if isinstance(previous, dict) and previous.get('sha') == ctx.sha:
            prior = previous.get('lanes') or {}
    except (OSError, json.JSONDecodeError):
        pass
    to_run = [name for name in LANES if ctx.plan[name].applicable and not ctx.plan[name].elected and name in selected]
    log_dir = ctx.state_dir / 'production-logs'
    log_dir.mkdir(parents=True, exist_ok=True)
    for name in LANES:
        lane = ctx.plan[name]
        base = {'status': SKIPPED, 'reason': lane.reason, 'applicable': lane.applicable, 'depends_on': list(lane.deps),
                'started_at': None, 'finished_at': None, 'exit_code': None, 'command': None, 'log': None}
        if lane.applicable and lane.elected:
            base.update(status=ELECTED, reason=f'elected: {lane.elected}')
        elif lane.applicable and name not in selected:
            carried = prior.get(name)
            base = ({**carried, 'carried_forward': True} if isinstance(carried, dict) and carried.get('status')
                    in SATISFIED else {**base, 'status': NOT_SELECTED, 'reason': 'applicable but not in --lanes; no prior PASS'})
        elif name in to_run:
            base.update(status='PENDING', log=str(log_dir / f'{name}.log'))
            (log_dir / f'{name}.log').write_text('')
        ctx.records[name] = base
    write_report(ctx, meta)
    done = {name: threading.Event() for name in to_run}

    def finish(name: str, **fields) -> None:
        with ctx.lock:
            ctx.records[name].update(fields)
        write_report(ctx, meta)
        done[name].set()

    def worker(name: str) -> None:
        lane = ctx.plan[name]
        for dep in lane.deps:
            if dep in done:
                done[dep].wait()
        failed = [dep for dep in lane.deps if ctx.records[dep]['status'] not in PASSED]
        if failed:
            ctx.emit(name, f'BLOCKED: dependency {", ".join(failed)} did not pass')
            return finish(name, status=BLOCKED, reason=f'dependency {", ".join(failed)} did not pass',
                          command=' && '.join(planned_commands(name, ctx)))
        with ctx.lock:
            ctx.records[name].update(status='RUNNING', started_at=iso(ctx.io.now()))
        write_report(ctx, meta)
        if name in FACTORY_LANES:
            ctx.factory('production-start', name)
        try:
            passed, reason, code = funcs[name](ctx)
        except Exception as error:  # one lane's crash never takes down the others
            passed, reason, code = False, f'{type(error).__name__}: {ctx.redact(str(error))}', 1
        stalled = passed is False and isinstance(reason, Stall)
        # production-start/finish is a wall-clock pair with no verdict field (factory_diagnostics pairs it as
        # external-deploy time): a stalled lane's run time is real lane time, so it closes the pair like a pass.
        # The verdict lives in production-lanes.json and the final line, where the stall is never a PASS.
        if (passed or stalled) and name in FACTORY_LANES:
            ctx.factory('production-finish', name)
        descended = passed is True and isinstance(reason, Descendant)
        status = STALL if stalled else DESCENDANT if descended else PASS if passed else FAIL
        shown = f'\u26a0\ufe0f\u26a0\ufe0f {STALL}' if stalled else status
        ctx.emit(name, f'{shown}: {reason}')
        finish(name, status=status, reason=ctx.redact(reason), exit_code=code, finished_at=iso(ctx.io.now()))

    def guarded(name: str) -> None:
        try:
            worker(name)
        except Exception as error:  # bookkeeping failed: never leave a dependent waiting or a lane RUNNING
            with ctx.lock:
                ctx.records[name].update(status=FAIL, reason=f'{type(error).__name__}: {ctx.redact(str(error))}')
        finally:
            done[name].set()

    threads = [threading.Thread(target=guarded, args=(name,), name=f'lane-{name}', daemon=True) for name in to_run]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return ctx.records


# ── CLI ───────────────────────────────────────────────────────────────────────
def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--sha', help='merge commit to verify (default: merged_sha in .context/deploy-merged.json)')
    parser.add_argument('--state-dir', type=Path, default=None,
                        help='receipt directory (default: ${DEPLOY_TEST_CYCLE_STATE_DIR:-.context/deploy-pipeline})')
    parser.add_argument('--lanes', default=None,
                        help=f'comma-separated subset of: {",".join(LANES)} (unselected lanes keep a prior PASS '
                             'for the same sha)')
    parser.add_argument('--dry-run', action='store_true',
                        help='print applicable lanes, why, their order/dependencies and exact commands; run nothing')
    parser.add_argument('--skip-agentcard', metavar='REASON', default=None,
                        help='elect to skip an applicable agentcard lane (deploy.md AgentCard election): recorded '
                             f'{ELECTED} with REASON, never run, not a failure')
    parser.add_argument('--resume-fly', action='store_true',
                        help='resume the SAME durable worker deployment job when it did not succeed '
                             '(default: fail the fly lane and print the resume command)')
    args = parser.parse_args(argv)
    if args.lanes is not None:
        lanes = [lane.strip() for lane in args.lanes.split(',') if lane.strip()]
        unknown = sorted(set(lanes) - set(LANES))
        if unknown or not lanes:
            parser.error(f'--lanes: unknown {",".join(unknown) or "(empty)"}; choose from {",".join(LANES)}')
        args.lanes = lanes
    if args.skip_agentcard is not None:
        args.skip_agentcard = args.skip_agentcard.strip()
        if not args.skip_agentcard:
            parser.error('--skip-agentcard requires a nonempty REASON')
    return args


def read_merged(root: Path) -> dict:
    try:
        merged = json.loads((root / '.context' / 'deploy-merged.json').read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return merged if isinstance(merged, dict) else {}


def pr_labels(ctx: Ctx, merged: dict, pr: int | None) -> tuple[list[str] | None, str | None]:
    if isinstance(merged.get('labels'), list) and merged.get('merged_sha') == ctx.sha:
        return [str(label) for label in merged['labels']], None
    try:
        if pr:
            payload = ctx.gh_json(['pr', 'view', str(pr), '--json', 'labels'])
            labels = payload.get('labels') if isinstance(payload, dict) else None
        else:
            pulls = ctx.gh_json(['api', f'repos/{{owner}}/{{repo}}/commits/{ctx.sha}/pulls'])
            labels = [label for pull in pulls if isinstance(pull, dict) for label in pull.get('labels') or []] \
                if isinstance(pulls, list) else None
    except LaneError as error:
        return None, str(error)
    if not isinstance(labels, list):
        return None, 'GitHub returned no labels list'
    return [str(label.get('name')) if isinstance(label, dict) else str(label) for label in labels], None


def mac_release_decision(capture: Callable[..., tuple[int, str, str]], root: Path, environ: dict, changed: list[str],
                         labels: list[str] | None, label_error: str | None = None) -> tuple[dict | None, str | None]:
    """Run auto-tag-mac-app.yml's decision on the merge diff: (parsed ship/reason/label, error). An unknown label
    only matters when the changed files alone would not ship."""
    label = 'true' if labels is not None and MAC_LABEL in labels else 'false'
    code, out, err = capture(['bash', str(root / MAC_DECISION)], root, {**environ, 'MAC_APP_RELEASE_LABEL': label},
                             input=''.join(f'{path}\n' for path in changed))
    decision = dict(line.split('=', 1) for line in out.splitlines() if '=' in line)
    if code != 0 or decision.get('ship') not in ('true', 'false'):
        return None, f'{MAC_DECISION} exited {code} without ship=true|false: {(err or out).strip()[:200]}'
    decision['label'] = label
    if label_error and decision['ship'] == 'false':
        return decision, f'{MAC_LABEL} label unknown ({label_error}) and no shipped-surface change'
    return decision, None


def main(argv: list[str] | None = None, *, io: IO | None = None, root: Path = ROOT, environ: dict | None = None,
         lane_funcs: dict | None = None) -> int:
    args = parse_args(argv)
    io = io or default_io()
    environ = dict(os.environ if environ is None else environ)
    out = io.out
    merged = read_merged(root)
    state_dir = args.state_dir or (Path(environ['DEPLOY_TEST_CYCLE_STATE_DIR']) if environ.get(
        'DEPLOY_TEST_CYCLE_STATE_DIR') else root / '.context' / 'deploy-pipeline')
    state_dir = state_dir if state_dir.is_absolute() else (Path.cwd() / state_dir)
    ref = args.sha or merged.get('merged_sha')
    if not ref:
        out('DEPLOY_PRODUCTION FAIL no --sha and no merged_sha in .context/deploy-merged.json')
        return 2
    code, sha, err = io.capture(['git', 'rev-parse', '--verify', f'{ref}^{{commit}}'], root, environ)
    sha = sha.strip()
    if code != 0 or not re.fullmatch(r'[0-9a-f]{40}', sha):
        out(f'DEPLOY_PRODUCTION FAIL cannot resolve {ref}: {err.strip()}')
        return 2
    gh, gh_env, gh_values = gh_setup(root, environ, io.exists)
    ctx = Ctx(sha=sha, root=root, state_dir=state_dir, io=io, environ=environ, resume_fly=args.resume_fly, gh=gh,
              gh_env=gh_env)
    ctx.add_secrets(gh_values)
    for package in ('back-end', 'agents'):  # redact what any child could echo, before any child runs
        ctx.dotenv(package)
    code, diff, err = io.capture(['git', 'diff', '--name-only', f'{sha}^1', sha], root, environ)
    if code != 0:
        out(f'DEPLOY_PRODUCTION FAIL git diff {sha[:12]}^1 {sha[:12]} failed: {err.strip()}')
        return 2
    changed = [line for line in diff.splitlines() if line]
    code, classified, err = io.capture(['bash', str(root / CLASSIFY)], root, environ, input=''.join(
        f'{path}\n' for path in changed))
    if code != 0:
        out(f'DEPLOY_PRODUCTION FAIL {CLASSIFY} failed: {err.strip()}')
        return 2
    runtime = [line for line in classified.splitlines() if line]
    pr = merged.get('pr') if merged.get('merged_sha') == sha else None
    labels, label_error = pr_labels(ctx, merged, pr)
    mac, mac_error = mac_release_decision(io.capture, root, environ, changed, labels, label_error)
    ctx.plan = plan_lanes(changed, runtime, mac, pr=pr, mac_error=mac_error)
    if args.skip_agentcard is not None and ctx.plan['agentcard'].applicable:
        ctx.plan['agentcard'].elected = args.skip_agentcard
    selected = set(args.lanes or LANES)
    if args.dry_run:
        return dry_run(ctx, changed, pr, selected)
    state_dir.mkdir(parents=True, exist_ok=True)
    started = iso(io.now())
    meta = {'schema_version': SCHEMA, 'sha': sha, 'pr': pr, 'status': 'RUNNING', 'started_at': started,
            'finished_at': None, 'changed_files': len(changed), 'selected': [n for n in LANES if n in selected]}
    out(f'DEPLOY_PRODUCTION START sha={sha[:12]} changed={len(changed)} lanes='
        + ','.join(n for n in LANES if ctx.plan[n].applicable and n in selected))
    records = execute(ctx, selected, meta, lane_funcs)
    applicable = [n for n in LANES if ctx.plan[n].applicable]
    passed = all(records[n]['status'] in SATISFIED for n in applicable)
    ran = any(ctx.plan[n].applicable and not ctx.plan[n].elected and n in selected for n in LANES)
    if passed and ran:
        ctx.factory('stage-finish', 'production-verify')
    meta.update(status=PASS if passed else FAIL, finished_at=iso(io.now()))
    write_report(ctx, meta)
    summary = ','.join(f'{n}:{records[n]["status"]}' for n in applicable)
    summary += ''.join(f' elected={n}:{json.dumps(records[n]["reason"])}' for n in applicable
                       if records[n]['status'] == ELECTED)
    summary += ''.join(f' stall={n}:{json.dumps(records[n]["reason"])}' for n in applicable
                       if records[n]['status'] == STALL)
    summary += ''.join(f' descendant={n}:{json.dumps(records[n]["reason"])}' for n in applicable
                       if records[n]['status'] == DESCENDANT)
    for name in applicable:  # loud and last, where the verdict is read: satisfied, but never a PASS
        if records[name]['status'] == STALL:
            out(f'\u26a0\ufe0f\u26a0\ufe0f SKIPPED {name} (standing AgentCard release stall, never PASS): '
                f'{records[name]["reason"]}')
    if passed:
        out(f'DEPLOY_PRODUCTION PASS sha={sha[:12]} lanes={summary} report={state_dir / REPORT}')
        return 0
    failed = [n for n in applicable if records[n]['status'] == FAIL]
    blocked = [n for n in applicable if records[n]['status'] in (BLOCKED, NOT_SELECTED)]
    out(f'DEPLOY_PRODUCTION FAIL sha={sha[:12]} failed={",".join(failed) or "-"} '
        f'not-run={",".join(blocked) or "-"} lanes={summary} report={state_dir / REPORT}')
    for name in failed:
        out(f'  {name}: {records[name]["reason"]}')
    return 1


def dry_run(ctx: Ctx, changed: list[str], pr: int | None, selected: set[str]) -> int:
    out = ctx.io.out
    out(f'DEPLOY_PRODUCTION DRY-RUN sha={ctx.sha[:12]} pr={f"#{pr}" if pr else "-"} changed={len(changed)} '
        f'state-dir={ctx.state_dir}')
    token = 'GH_TOKEN=back-end/.env GITHUB_TOKEN' + ('' if 'GH_TOKEN' in ctx.gh_env else ' (MISSING)')
    out(f'gh: {ctx.gh}' + (f' ({token}; DEPLOY_GH_BIN exported to children)' if ctx.gh_env else ''))
    for name in LANES:
        lane = ctx.plan[name]
        state = ((ELECTED if lane.elected else 'APPLICABLE' if name in selected else 'NOT-SELECTED')
                 if lane.applicable else SKIPPED)
        out(f'  {name:<19} {state:<23} {lane.reason}' + (f' [ERROR: {ctx.redact(lane.error)}]' if lane.error else ''))
        if lane.elected:
            out(f'      elected: {lane.elected} (never run; not a failure)')
        elif lane.applicable:
            out(f'      after: {", ".join(lane.deps) or "- (starts immediately)"}')
            for command in planned_commands(name, ctx):
                out(f'      $ {ctx.redact(command)}')
    for depth, names in enumerate(waves(ctx.plan), 1):
        out(f'order {depth}: {", ".join(names)} (concurrent)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
