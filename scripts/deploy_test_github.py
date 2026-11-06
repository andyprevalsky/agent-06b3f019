#!/usr/bin/env python3
"""Run one staged deploy gate on an ephemeral Blacksmith GitHub Actions runner.

launch (default, coordinator): read $DEPLOY_GATE_REQUEST, push the frozen commit
with a deterministic annotated tag `deploy-gates/<size>/<gate>-<token16>` whose
message is the request envelope, watch the `.github/workflows/deploy-gates.yml`
run that the tag push starts, download its `deploy-gate-result` artifact and write
the worker's own result to $DEPLOY_GATE_RESULT. The remote VM runs the unchanged
deploy_test_worker.py / deploy_test_backend.py against the tagged commit; GitHub
records the run, its head SHA and runner. Cancellation and the deadline cancel the
run; Blacksmith destroys the VM when the run ends. A run that cannot be confirmed
finished is returned as an explicit `cleanup_owner`.

remote-extract / remote-run / remote-bundle are the runner-side steps of that
workflow. Exit codes follow the local worker: 0 all PASS, otherwise 1 with a written result.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

TRANSPORT = 'github-actions'
WORKFLOW = 'deploy-gates.yml'
WORKFLOW_PATH = '.github/workflows/' + WORKFLOW
TAG_PREFIX = 'deploy-gates'
ARTIFACT = 'deploy-gate-result'
REQUEST_REF = 'refs/deploy-gate/request'
REMOTE_ROOT = '/home/runner/_work/rose/rose'
RUNNER = re.compile(r'^blacksmith-(2|4|8|16|32)vcpu-ubuntu-2404$')
WORKER_SCRIPTS = ('deploy_test_worker.py', 'deploy_test_backend.py')
ENVELOPE_VERSION = 1
API = 'https://api.github.com'
START_SECONDS = 300.0        # tag push -> run visible (GitHub queueing + Blacksmith pickup)
POLL_SECONDS = 20.0          # ETag-conditional: unchanged 304 answers do not spend the rate limit
CANCEL_SECONDS = 180.0       # cancel request -> run completed (VM destroyed)
MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
MAX_RESULT_BYTES = 64 * 1024 * 1024
BUNDLE_FILE_BYTES = 64 * 1024 * 1024
BUNDLE_TOTAL_BYTES = 400 * 1024 * 1024
BUNDLE_SKIP = {'seed-cache', 'tsbuildinfo', 'frontend-builds', 'experiential-venv', 'node_modules'}
SERVICE_LOGS = ('back-end/backend-logs.log', 'agents/navi-worker-log.txt', 'front-end/frontend-logs.log')
STOP = threading.Event()


# ---------------------------------------------------------------- shared helpers

def git(root: Path, *args: str, env: dict | None = None, input_bytes: bytes | None = None) -> str:
    return subprocess.run(['git', *args], cwd=root, check=True, capture_output=True, input=input_bytes,
                          env=env).stdout.decode().strip()


def safe_name(gate: str) -> str:
    name = re.sub(r'[^A-Za-z0-9_.-]+', '-', gate).strip('-.')
    if not name:
        raise ValueError('gate name has no tag-safe characters')
    return name[:80]


def tag_name(runner: str, gate: str, token: str) -> str:
    match = RUNNER.match(runner)
    if not match:
        raise ValueError(f'unsupported Blacksmith runner label: {runner}')
    return f'{TAG_PREFIX}/{match.group(1)}vcpu/{safe_name(gate)}-{hashlib.sha256(token.encode()).hexdigest()[:16]}'


def envelope(request: dict, worker_script: str, runner: str) -> bytes:
    if worker_script not in WORKER_SCRIPTS:
        raise ValueError(f'unsupported worker script: {worker_script}')
    if request.get('worker_root') != REMOTE_ROOT:
        raise ValueError(f'remote gates must bind worker_root {REMOTE_ROOT}')
    body = {'version': ENVELOPE_VERSION, 'worker_script': worker_script, 'runner': runner, 'request': request}
    return (json.dumps(body, sort_keys=True, separators=(',', ':')) + '\n').encode()


def tag_object(root: Path, head: str, name: str, message: bytes) -> bytes:
    """Deterministic tag bytes: a relaunch of the same request reuses the same tag and run."""
    stamp = git(root, 'show', '-s', '--format=%ct', head)
    header = (f'object {head}\ntype commit\ntag {name}\n'
              f'tagger Rose Deploy Gates <deploy-gates@roselabs.ai> {stamp} +0000\n\n').encode()
    return header + message


def parse_tag(raw: bytes) -> tuple[dict, bytes]:
    head, sep, message = raw.partition(b'\n\n')
    if not sep:
        raise ValueError('tag has no message')
    fields = {}
    for line in head.decode().splitlines():
        key, _, value = line.partition(' ')
        fields[key] = value
    return fields, message


def load_token(root: Path) -> str:
    token = os.environ.get('DEPLOY_GATE_GITHUB_TOKEN')
    if token:
        return token
    path = root / 'agents/.env'
    try:
        from dotenv import dotenv_values
        token = dotenv_values(path).get('GITHUB_TOKEN') or ''
    except ImportError:
        token = ''
        for line in path.read_text().splitlines():
            if line.startswith('GITHUB_TOKEN='):
                token = line.split('=', 1)[1].strip().strip('"\'')
    if not token:
        raise ValueError('no workflow-scoped GitHub token (DEPLOY_GATE_GITHUB_TOKEN or agents/.env GITHUB_TOKEN)')
    return token


def repository(root: Path) -> str:
    url = git(root, 'remote', 'get-url', 'origin')
    match = re.search(r'github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$', url)
    if not match:
        raise ValueError(f'origin is not a GitHub repository: {url}')
    return match.group(1)


class GitHub:
    def __init__(self, token: str, repo: str):
        self.token, self.repo, self.etags, self.cache = token, repo, {}, {}

    def request(self, method: str, path: str, *, conditional: bool = False, redirect: bool = True):
        url = path if path.startswith('https://') else f'{API}/repos/{self.repo}{path}'
        req = urllib.request.Request(url, method=method, headers={
            'Authorization': f'Bearer {self.token}', 'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'rose-deploy-gates'})
        if conditional and url in self.etags:
            req.add_header('If-None-Match', self.etags[url])
        opener = urllib.request.build_opener(*([] if redirect else [NoRedirect()]))
        for attempt in range(5):
            try:
                with opener.open(req, timeout=60) as response:
                    body = response.read()
                    if conditional and response.headers.get('ETag'):
                        self.etags[url] = response.headers['ETag']
                        self.cache[url] = json.loads(body or b'null')
                    return response.status, response.headers, body
            except urllib.error.HTTPError as error:
                if error.code == 304 and url in self.cache:
                    return 304, error.headers, None
                if error.code in (301, 302, 303, 307, 308) and not redirect:
                    return error.code, error.headers, b''
                if error.code in (403, 429) and 'rate limit' in error.read().decode(errors='replace').lower():
                    reset = float(error.headers.get('X-RateLimit-Reset') or time.time() + 60)
                    STOP.wait(min(max(reset - time.time(), 5), 300))
                    continue
                if error.code >= 500 and attempt < 4:
                    STOP.wait(2 ** attempt)
                    continue
                raise
            except (urllib.error.URLError, TimeoutError):
                if attempt == 4:
                    raise
                STOP.wait(2 ** attempt)
        raise RuntimeError(f'GitHub API {method} {path} kept failing')

    def json(self, path: str, conditional: bool = False):
        status, _, body = self.request('GET', path, conditional=conditional)
        url = path if path.startswith('https://') else f'{API}/repos/{self.repo}{path}'
        return self.cache[url] if status == 304 else json.loads(body)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


# ---------------------------------------------------------------- coordinator side

def push_tag(root: Path, token: str, repo: str, name: str, raw: bytes) -> str:
    sha = git(root, 'hash-object', '-t', 'tag', '-w', '--stdin', input_bytes=raw)
    env = {**os.environ, 'DEPLOY_GATE_GIT_TOKEN': token, 'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_COUNT': '2',
           'GIT_CONFIG_KEY_0': 'credential.helper', 'GIT_CONFIG_VALUE_0': '',
           'GIT_CONFIG_KEY_1': 'credential.helper',
           'GIT_CONFIG_VALUE_1': '!f(){ echo username=x-access-token; echo "password=$DEPLOY_GATE_GIT_TOKEN"; }; f'}
    url = f'https://github.com/{repo}.git'
    existing = git(root, 'ls-remote', url, f'refs/tags/{name}', env=env).split()
    if existing and existing[0] != sha:
        raise ValueError(f'remote tag {name} already names a different request')
    if not existing:
        git(root, 'push', '--quiet', '--no-verify', url, f'{sha}:refs/tags/{name}', env=env)
    return sha


def delete_tag(root: Path, token: str, repo: str, name: str) -> None:
    gh = GitHub(token, repo)
    try:
        gh.request('DELETE', f'/git/refs/tags/{name}')
    except urllib.error.HTTPError:
        pass  # Retention only; the run, its logs and artifacts are independent of the tag.


class WorkflowRejected(Exception):
    """GitHub refused the workflow file at this commit; the run never owned a VM."""


def find_run(gh: GitHub, head: str, name: str, deadline: float, pushed: float) -> dict | None:
    # Filter by path, not the by-filename endpoint: that 404s until the workflow is on the default branch.
    path = f'/actions/runs?event=push&head_sha={head}&per_page=100'
    rejected_since = None
    while time.time() < deadline and not STOP.is_set():
        runs = [r for r in gh.json(path, conditional=True).get('workflow_runs', []) if r.get('path') == WORKFLOW_PATH]
        mine = [r for r in runs if r.get('head_branch') == name]
        if mine:
            return min(mine, key=lambda r: r['id'])
        # A workflow-file error yields an unnamed failed run (head_branch null) with no jobs.
        invalid = [r for r in runs if r.get('head_branch') is None and r.get('conclusion') == 'failure'
                   and iso_epoch(r.get('created_at')) >= pushed - 5]
        if invalid:
            rejected_since = rejected_since or time.time()
            if time.time() - rejected_since > 30:
                raise WorkflowRejected(f"GitHub rejected {WORKFLOW_PATH} at {head}: {invalid[0].get('html_url')}")
        STOP.wait(5)
    return None


def iso_epoch(value: str | None) -> float:
    from datetime import datetime
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() if value else 0.0


def wait_run(gh: GitHub, run_id: int, deadline: float) -> dict:
    while True:
        run = gh.json(f'/actions/runs/{run_id}', conditional=True)
        if run.get('status') == 'completed' or STOP.is_set() or time.time() >= deadline:
            return run
        STOP.wait(min(POLL_SECONDS, max(1.0, deadline - time.time())))


def cancel_run(gh: GitHub, run_id: int) -> dict:
    try:
        gh.request('POST', f'/actions/runs/{run_id}/cancel')
    except urllib.error.HTTPError as error:
        if error.code != 409:  # 409: already completed
            raise
    end = time.time() + CANCEL_SECONDS
    while time.time() < end:
        run = gh.json(f'/actions/runs/{run_id}')
        if run.get('status') == 'completed':
            return run
        time.sleep(5)
    return gh.json(f'/actions/runs/{run_id}')


def job_receipt(gh: GitHub, run: dict) -> dict:
    jobs = gh.json(f"/actions/runs/{run['id']}/jobs").get('jobs', [])
    job = jobs[0] if jobs else {}
    return {'transport': TRANSPORT, 'run_id': run['id'], 'url': run.get('html_url'), 'head_sha': run.get('head_sha'),
            'tag': run.get('head_branch'), 'status': run.get('status'), 'conclusion': run.get('conclusion'),
            'run_created_at': run.get('created_at'), 'job_id': job.get('id'), 'runner_name': job.get('runner_name'),
            'labels': job.get('labels'), 'job_started_at': job.get('started_at'),
            'job_completed_at': job.get('completed_at'),
            'steps': [{k: s.get(k) for k in ('name', 'conclusion', 'started_at', 'completed_at')}
                      for s in job.get('steps', [])]}


def download_artifact(gh: GitHub, run_id: int, destination: Path) -> Path | None:
    artifacts = gh.json(f'/actions/runs/{run_id}/artifacts').get('artifacts', [])
    match = [a for a in artifacts if a.get('name') == ARTIFACT and not a.get('expired')]
    if not match:
        return None
    if match[0].get('size_in_bytes', 0) > MAX_ARTIFACT_BYTES:
        raise ValueError('remote gate artifact exceeds the transport limit')
    status, headers, body = gh.request('GET', match[0]['archive_download_url'], redirect=False)
    if status in (301, 302, 303, 307, 308):
        # The signed blob URL must not receive the GitHub token.
        with urllib.request.urlopen(urllib.request.Request(headers['Location'],
                                    headers={'User-Agent': 'rose-deploy-gates'}), timeout=300) as response:
            body = response.read(MAX_ARTIFACT_BYTES + 1)
    if len(body) > MAX_ARTIFACT_BYTES:
        raise ValueError('remote gate artifact exceeds the transport limit')
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        for member in archive.infolist():
            target = (destination / member.filename).resolve()
            if destination.resolve() not in target.parents and target != destination.resolve():
                raise ValueError('artifact member escapes its directory')
        archive.extractall(destination)
    return destination


def localize_logs(result: dict, artifact: Path) -> None:
    """Point each evidence log at the downloaded copy so RCA reads it on the coordinator."""
    for row in (result.get('evidence') or {}).values():
        if isinstance(row, dict) and isinstance(row.get('log'), str) and row['log'].startswith(REMOTE_ROOT + '/'):
            local = artifact / 'files' / row['log'][len(REMOTE_ROOT) + 1:]
            row['remote_log'] = row['log']
            if local.is_file():
                row['log'] = str(local)


def blocked(request: dict, reason: str, *, owner: dict | None = None, receipt: dict | None = None) -> dict:
    cases = {name: 'UNVERIFIED' for name in request.get('checks', [])}
    result = {k: request.get(k) for k in ('token', 'source', 'gate')}
    result.update(cases=cases, complete=False, reused=False, cleanup_complete=owner is None,
                  evidence={name: {'status': 'UNVERIFIED', 'reason': reason} for name in cases},
                  worker_root=request.get('worker_root'), reason=reason, remote=receipt)
    if 'worker_recipe' in request:
        result['recipe_digest'] = hashlib.sha256(json.dumps(request['worker_recipe'], sort_keys=True,
                                                 separators=(',', ':')).encode()).hexdigest()
    if owner is not None:
        result['cleanup_owner'] = owner
    return result


def launch(args) -> int:
    root = args.root.resolve()
    request = json.loads(Path(os.environ['DEPLOY_GATE_REQUEST']).read_text())
    result_path = Path(os.environ['DEPLOY_GATE_RESULT'])
    started = time.time()
    deadline = started + args.deadline_seconds - CANCEL_SECONDS
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda *_: STOP.set())

    def finish(result: dict) -> int:
        result.setdefault('remote', {})
        if isinstance(result['remote'], dict):
            result['remote'].update(launcher_started_at=started, launcher_finished_at=time.time())
        tmp = result_path.with_name(result_path.name + '.tmp')
        tmp.write_text(json.dumps(result, indent=2))
        os.replace(tmp, result_path)
        # Same contract as deploy_test_worker: a written result exits 0 only when every case passed.
        return 0 if result.get('complete') and all(v == 'PASS' for v in result['cases'].values()) else 1

    try:
        head = request['source']['head']
        if args.worker_root != REMOTE_ROOT or request.get('worker_root') != REMOTE_ROOT:
            raise ValueError(f'remote worker root must be {REMOTE_ROOT}')
        git(root, 'cat-file', '-e', f'{head}:{WORKFLOW_PATH}')
        token, repo = load_token(root), repository(root)
        name = tag_name(args.runner, request['gate'], request['token'])
        push_tag(root, token, repo, name, tag_object(root, head, name, envelope(request, args.worker_script, args.runner)))
    except (KeyError, ValueError, OSError, subprocess.CalledProcessError, urllib.error.URLError) as error:
        detail = error.stderr.decode(errors='replace')[-2000:] if isinstance(error, subprocess.CalledProcessError) else ''
        return finish(blocked(request, f'remote gate launch failed: {error} {detail}'.strip()))
    gh = GitHub(token, repo)
    try:
        run = find_run(gh, head, name, min(deadline, time.time() + START_SECONDS), started)
    except (WorkflowRejected, urllib.error.URLError) as error:
        delete_tag(root, token, repo, name)
        return finish(blocked(request, str(error), receipt={'transport': TRANSPORT, 'tag': name}))
    if run is None:
        reason = 'cancelled before the remote run started' if STOP.is_set() else 'deploy-gates workflow run never started'
        # Nothing started that we can name; the tag alone owns no VM.
        delete_tag(root, token, repo, name)
        return finish(blocked(request, reason, receipt={'transport': TRANSPORT, 'tag': name}))
    print(f'DEPLOY_GATE_REMOTE_RUN {run["html_url"]}', flush=True)
    run = wait_run(gh, run['id'], deadline)
    if run.get('status') != 'completed':
        reason = 'cancelled' if STOP.is_set() else 'existing gate deadline exhausted'
        run = cancel_run(gh, run['id'])
        receipt = job_receipt(gh, run)
        owner = None if run.get('status') == 'completed' else {k: receipt[k] for k in ('transport', 'run_id', 'url')}
        if owner is None:
            delete_tag(root, token, repo, name)
        return finish(blocked(request, f'remote run {reason}', owner=owner, receipt=receipt))
    receipt = job_receipt(gh, run)
    delete_tag(root, token, repo, name)  # The run, its logs and artifact outlive the tag.
    if run.get('head_sha') != head:
        return finish(blocked(request, 'remote run executed a different commit', receipt=receipt))
    folder = result_path.parent / 'remote-artifact'
    try:
        artifact = download_artifact(gh, run['id'], folder)
        if artifact is None or not (artifact / 'result.json').is_file():
            return finish(blocked(request, f"remote run {run.get('conclusion')} without a worker result", receipt=receipt))
        if (artifact / 'result.json').stat().st_size > MAX_RESULT_BYTES:
            raise ValueError('remote worker result exceeds the transport limit')
        result = json.loads((artifact / 'result.json').read_text())
        timing = artifact / 'timing.json'
        if timing.is_file():
            receipt['timing'] = json.loads(timing.read_text())
    except (ValueError, OSError, zipfile.BadZipFile, urllib.error.URLError) as error:
        return finish(blocked(request, f'remote artifact unusable: {error}', receipt=receipt))
    if any(result.get(k) != request.get(k) for k in ('token', 'source', 'gate')):
        return finish(blocked(request, 'remote worker result identity mismatch', receipt=receipt))
    localize_logs(result, artifact)
    result['remote'] = receipt
    return finish(result)


# ---------------------------------------------------------------- runner side

def remote_extract(args) -> int:
    root, out = Path.cwd().resolve(), args.out
    out.mkdir(parents=True, exist_ok=True)
    name = args.ref.removeprefix('refs/tags/')
    if not name.startswith(TAG_PREFIX + '/'):
        raise SystemExit('not a deploy-gates tag')
    # The workflow's mirror checkout stores the annotated tag object itself at REQUEST_REF.
    raw = subprocess.run(['git', 'cat-file', 'tag', REQUEST_REF], cwd=root, check=True, capture_output=True).stdout
    fields, message = parse_tag(raw)
    body = json.loads(message)
    request = body['request']
    head = git(root, 'rev-parse', 'HEAD')
    if (body.get('version') != ENVELOPE_VERSION or body.get('worker_script') not in WORKER_SCRIPTS
            or fields.get('object') != head or request['source']['head'] != head
            or tag_name(body['runner'], request['gate'], request['token']) != name
            or request.get('worker_root') != str(root)):
        raise SystemExit('deploy-gates envelope does not match this checkout and tag')
    (out / 'request.json').write_text(json.dumps(request))
    (out / 'worker_script').write_text(body['worker_script'])
    timing = {'job_started_at': float(os.environ.get('DEPLOY_GATE_T0') or time.time()), 'extracted_at': time.time()}
    (out / 'timing.json').write_text(json.dumps(timing))
    print(f"gate={request['gate']} worker={body['worker_script']} checks={len(request['checks'])}")
    return 0


def remote_run(args) -> int:
    out = args.out
    timing = json.loads((out / 'timing.json').read_text())
    timing['setup_finished_at'] = time.time()
    script = (out / 'worker_script').read_text().strip()
    # Gates record stage receipts into an active deploy timing run, as on the coordinator.
    token = json.loads((out / 'request.json').read_text())['token']
    started = subprocess.run(['bash', str(ROOT / 'scripts/run-deploy-stage'), '--start', '--run-id',
                              'gate-' + hashlib.sha256(token.encode()).hexdigest()[:16]], cwd=ROOT)
    timing['timing_run_started'] = started.returncode == 0
    env = {**os.environ, 'DEPLOY_GATE_REQUEST': str(out / 'request.json'), 'DEPLOY_GATE_RESULT': str(out / 'result.json')}
    code = subprocess.run([sys.executable, str(ROOT / 'scripts' / script), '--root', str(ROOT)], env=env).returncode
    timing.update(worker_finished_at=time.time(), worker_exit=code)
    (out / 'timing.json').write_text(json.dumps(timing))
    print(f'DEPLOY_GATE_WORKER_EXIT {code}')
    return 0  # The verdict is result.json; a failing gate still uploads its evidence and caches.


def remote_bundle(args) -> int:
    out = args.out
    artifact = out / 'artifact'
    artifact.mkdir(parents=True, exist_ok=True)
    for name in ('result.json', 'timing.json', 'request.json'):
        if (out / name).is_file():
            shutil.copyfile(out / name, artifact / name)
    root = ROOT.resolve()
    paths = set()
    if (out / 'result.json').is_file():
        for row in (json.loads((out / 'result.json').read_text()).get('evidence') or {}).values():
            if isinstance(row, dict):
                paths.update(v for k, v in row.items() if isinstance(v, str) and v.startswith(str(root) + '/'))
    # Everything a gate leaves for RCA: its .context state and logs plus the stack's service logs.
    # Caches and dependency trees stay behind; per-file and total caps bound the artifact.
    if (root / '.context').is_dir():
        for path in (root / '.context').rglob('*'):
            parts = path.relative_to(root / '.context').parts
            if path.is_file() and not path.is_symlink() and parts[0] not in BUNDLE_SKIP:
                paths.add(str(path))
    paths.update(str(root / rel) for rel in SERVICE_LOGS if (root / rel).is_file())
    total, skipped = 0, []
    for raw in sorted(paths, key=lambda p: (Path(p).stat().st_size, p)):
        path = Path(raw)
        if not path.is_file() or root not in path.resolve().parents:
            continue
        size = path.stat().st_size
        if size > BUNDLE_FILE_BYTES or total + size > BUNDLE_TOTAL_BYTES:
            skipped.append({'path': str(path.relative_to(root)), 'bytes': size})
            continue
        target = artifact / 'files' / path.resolve().relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        total += size
    (artifact / 'bundle.json').write_text(json.dumps({'bytes': total, 'skipped': skipped}, indent=1))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode')
    for mode in ('remote-extract', 'remote-run', 'remote-bundle'):
        step = sub.add_parser(mode)
        step.add_argument('--out', type=Path, required=True)
        if mode == 'remote-extract':
            step.add_argument('--ref', required=True)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--runner')
    parser.add_argument('--worker-script', choices=WORKER_SCRIPTS)
    parser.add_argument('--worker-root')
    parser.add_argument('--deadline-seconds', type=float)
    args = parser.parse_args(argv)
    if args.mode == 'remote-extract':
        return remote_extract(args)
    if args.mode == 'remote-run':
        return remote_run(args)
    if args.mode == 'remote-bundle':
        return remote_bundle(args)
    if not (args.runner and args.worker_script and args.worker_root and args.deadline_seconds):
        parser.error('launch requires --runner, --worker-script, --worker-root and --deadline-seconds')
    return launch(args)


if __name__ == '__main__':
    raise SystemExit(main())
