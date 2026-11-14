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
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import deploy_gate_progress as progress

TRANSPORT = 'github-actions'
WORKFLOW = 'deploy-gates.yml'
WORKFLOW_PATH = '.github/workflows/' + WORKFLOW
TAG_PREFIX = 'deploy-gates'
ARTIFACT = 'deploy-gate-result'
CHANNEL_PREFIX = 'deploy-gates/v1'
REQUEST_REF = 'refs/deploy-gate/request'
REMOTE_ROOT = '/home/runner/_work/rose/rose'
RUNNER = re.compile(r'^blacksmith-(2|4|8|16|32)vcpu-ubuntu-2404$')
WORKER_SCRIPTS = ('deploy_test_worker.py', 'deploy_test_backend.py')
ENVELOPE_VERSION = 1
API = 'https://api.github.com'
START_SECONDS = 300.0        # tag push -> run visible (GitHub queueing + Blacksmith pickup)
POLL_SECONDS = 60.0          # ETag-conditional; gates take minutes and the REST quota is shared
START_POLL_SECONDS = 10.0
CHANNEL_POLL_SECONDS = 15.0     # R2 GETs: no GitHub quota
LIVENESS_SECONDS = 600.0        # one REST status read per gate every 10 min
STREAM_SECONDS = 5.0            # VM -> R2 progress uploads while the worker runs
CANCEL_SECONDS = 180.0       # cancel request -> run completed (VM destroyed)
# After TERM/INT/HUP or parent exit: find, cancel and confirm the launched run inside the owning
# supervisor's 10 s TERM grace (deploy_test_supervisor.TERM_GRACE_SECONDS), then write the receipt.
STOP_CANCEL_SECONDS = 7.0
PARENT_POLL_SECONDS = 1.0
MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
PUSH_ATTEMPTS = 4
MAX_RESULT_BYTES = 64 * 1024 * 1024
BUNDLE_FILE_BYTES = 64 * 1024 * 1024
BUNDLE_TOTAL_BYTES = 400 * 1024 * 1024
BUNDLE_SKIP = {'seed-cache', 'tsbuildinfo', 'frontend-builds', 'experiential-venv', 'node_modules'}
SERVICE_LOGS = ('back-end/backend-logs.log', 'agents/navi-worker-log.txt', 'front-end/frontend-logs.log')
BUNDLE_SUMMARIES = ('summary.json', 'manifest.json')  # small run indexes RCA reads first
LOG_TREES = ('back-end/coverage', 'front-end/coverage', 'agents/coverage', 'front-end/test-results')
STOP = threading.Event()
STOPPED = {'at': None, 'cause': None}


def request_stop(cause: str) -> None:
    if STOPPED['at'] is None:
        STOPPED.update(at=time.time(), cause=cause)
    STOP.set()


def stop_bound() -> float:
    return (STOPPED['at'] or time.time()) + STOP_CANCEL_SECONDS


def watch_parent(parent: int) -> None:
    """A launcher whose supervisor/cycle died (SIGKILL, OOM) still cancels the run it launched."""
    while not STOP.wait(PARENT_POLL_SECONDS):
        if os.getppid() != parent:
            request_stop('parent exited')


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


OVERRIDES_ENV = 'DEPLOY_GATE_OVERRIDES'
OVERRIDE_NAME = re.compile(r'[a-z0-9][a-z0-9_.:-]*')


def gate_overrides(value: str | None = None) -> str:
    """The user-elected harness overrides (deploy.md: an override names its gate explicitly), as the
    comma list the suites read from DEPLOY_GATE_OVERRIDES. The coordinator's value is part of the cycle's
    bound environment; remote gates receive it through the envelope, since a VM's env is its own."""
    raw = os.environ.get(OVERRIDES_ENV, '') if value is None else value
    names = [part.strip() for part in raw.split(',') if part.strip()]
    if any(not OVERRIDE_NAME.fullmatch(name) for name in names):
        raise ValueError(f'invalid {OVERRIDES_ENV} entry in {raw!r}')
    return ','.join(sorted(set(names)))


def envelope(request: dict, worker_script: str, runner: str) -> bytes:
    if worker_script not in WORKER_SCRIPTS:
        raise ValueError(f'unsupported worker script: {worker_script}')
    if request.get('worker_root') != REMOTE_ROOT:
        raise ValueError(f'remote gates must bind worker_root {REMOTE_ROOT}')
    body = {'version': ENVELOPE_VERSION, 'worker_script': worker_script, 'runner': runner, 'request': request}
    overrides = gate_overrides()
    if overrides:  # absent when none, so the deterministic tag of an ordinary request is unchanged
        body['overrides'] = overrides
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


def rate_limit_pause(headers, now: float) -> float:
    """Seconds until GitHub says the limit lifts: Retry-After (secondary), else X-RateLimit-Reset (primary).

    GitHub documents waiting at least a minute when a secondary limit names neither.
    """
    for name, base in (('Retry-After', 0.0), ('X-RateLimit-Reset', now - 1.0)):
        try:
            return max(float(headers[name]) - base, 1.0)
        except (KeyError, TypeError, ValueError):
            continue
    return 60.0


READ_METHODS = ('GET', 'HEAD')
READ_REPICK_SECONDS = 1500.0    # App installation tokens live an hour; re-pick the read member well before
READ_REPICK_RETRY_SECONDS = 60.0  # a failed pick is not retried on every request
READ_LOW_REMAINING = 200        # re-pick once the read member's own X-RateLimit-Remaining runs low


def identity(token: str) -> str:
    """A non-secret key for one credential: ETags and cached bodies are per identity."""
    return hashlib.sha256(token.encode()).hexdigest()[:16]


def pick_read_member(root: Path) -> tuple[str, str] | None:
    """(name, token) of the token-pool member with the most core quota, for READ-ONLY REST calls.

    DEPLOY_GATE_GITHUB_POOL=0 keeps every read on the launch identity. Any pool failure does the same.
    """
    if os.environ.get('DEPLOY_GATE_GITHUB_POOL', '1') == '0':
        return None
    try:
        import github_token_pool
        member = github_token_pool.pick_member('core', repo_root=root, timeout=5.0)
    except Exception as error:  # advisory: reads fall back to the launch identity
        print(f'DEPLOY_GATE_GITHUB_POOL pick failed ({type(error).__name__}); reads use the launch token', flush=True)
        return None
    return (member.name, member.token) if member else None


class GitHub:
    """REST client. Writes (POST cancel) always use `token`, the launch identity that pushed the tag.

    Reads (GET) use the token-pool member with the most quota when a `read_picker` is given, then
    retry with `token` when that member answers 401/403/404 (not authoritative: it may lack access)
    or is itself rate limited. Only the launch identity's answer, or its rate-limit wait, is final.
    """

    def __init__(self, token: str, repo: str, deadline: float | None = None, read_picker=None):
        self.token, self.repo, self.etags, self.cache = token, repo, {}, {}
        self.rate_limited_seconds = 0.0  # time spent waiting out the shared REST quota, for the receipt
        self.deadline = deadline  # epoch the caller must be done by; a rate-limit wait never passes it
        self.read_picker = read_picker
        self.read_name, self.read_token, self.read_remaining = None, None, None
        self.read_picked_at = self.read_attempted_at = float('-inf')
        self.read_fallbacks = 0  # reads a pool member could not answer, retried with the launch token
        self.read_denied: set[str] = set()  # pool identities refused (401/403/404) where the launch token was not
        self.served = identity(token)  # identity that produced the last response (selects the 304 cache)
        self.until = None  # epoch every request must finish by (the stop-cancel bound); None: 60 s per request

    def _read(self) -> str | None:
        """The pool member's token for a read, re-picked when stale or low; None means use `token`."""
        if self.read_picker is None:
            return None
        now = time.time()
        denied = self.read_token is not None and identity(self.read_token) in self.read_denied
        stale = (self.read_token is None or denied or now - self.read_picked_at >= READ_REPICK_SECONDS
                 or (self.read_remaining is not None and self.read_remaining < READ_LOW_REMAINING))
        if stale and now - self.read_attempted_at >= READ_REPICK_RETRY_SECONDS:
            self.read_attempted_at = now
            picked = self.read_picker()
            if picked and identity(picked[1]) not in self.read_denied:  # never hand out a denied member again
                (self.read_name, self.read_token), self.read_picked_at, self.read_remaining = picked, now, None
        token = self.read_token
        return token if token and token != self.token and identity(token) not in self.read_denied else None

    def tokens(self, method: str) -> list[str]:
        # A bounded stop window (until) spends nothing on a pool pick or a second identity: launch token only.
        read = self._read() if method in READ_METHODS and self.until is None else None
        return [read, self.token] if read else [self.token]

    def _settle_denied(self, denied: str | None, token: str) -> None:
        """A pool member's 401/403/404 is remembered only once the launch token answered the same read."""
        if denied is not None and token == self.token:
            self.read_denied.add(denied)

    def _note_quota(self, token: str, headers) -> None:
        if token == self.read_token:
            try:
                self.read_remaining = int(headers.get('X-RateLimit-Remaining'))
            except (AttributeError, TypeError, ValueError):
                pass

    def request(self, method: str, path: str, *, conditional: bool = False, redirect: bool = True,
                wait_on_rate_limit: bool = True):
        url = path if path.startswith('https://') else f'{API}/repos/{self.repo}{path}'
        opener = urllib.request.build_opener(*([] if redirect else [NoRedirect()]))
        tokens, index, attempt = self.tokens(method), 0, 0
        denied = None  # identity of a pool member that refused this read, pending the launch token's answer
        while attempt < 5:
            if self.until is not None and time.time() >= self.until:
                raise urllib.error.URLError(f'stop-cancel bound exhausted before {method} {path}')
            token = tokens[index]
            key = identity(token)
            req = urllib.request.Request(url, method=method, headers={
                'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'rose-deploy-gates'})
            if conditional and (key, url) in self.etags:
                req.add_header('If-None-Match', self.etags[(key, url)])
            try:
                timeout = 60.0 if self.until is None else max(0.5, min(60.0, self.until - time.time()))
                with opener.open(req, timeout=timeout) as response:
                    body = response.read()
                    self.served = key
                    self._settle_denied(denied, token)
                    self._note_quota(token, response.headers)
                    if conditional and response.headers.get('ETag'):
                        self.etags[(key, url)] = response.headers['ETag']
                        self.cache[(key, url)] = json.loads(body or b'null')
                    return response.status, response.headers, body
            except urllib.error.HTTPError as error:
                self.served = key
                if error.code == 304 and (key, url) in self.cache:
                    self._settle_denied(denied, token)
                    return 304, error.headers, None
                if error.code in (301, 302, 303, 307, 308) and not redirect:
                    return error.code, error.headers, b''
                try:
                    text = error.read().decode(errors='replace').lower()
                except (AttributeError, OSError, ValueError):
                    text = ''
                limited = error.code in (403, 429) and 'rate limit' in text
                if index + 1 < len(tokens) and (limited or error.code in (401, 403, 404)):
                    # A pool member's 401/403/404 is not authoritative and its quota is not the launch
                    # identity's: ask the launch token before treating this as GitHub's answer.
                    if not limited:
                        denied = key  # remembered only if the launch token then answers (both 404: GitHub's answer)
                    index += 1
                    self.read_fallbacks += 1
                    if limited or error.code == 401:
                        # Expired or drained: re-pick on the next read (one pick per such answer).
                        self.read_picked_at = self.read_attempted_at = float('-inf')
                    continue
                if limited:
                    if not wait_on_rate_limit:
                        raise  # Advisory liveness must not block the authoritative R2 result poll.
                    now = time.time()
                    pause = rate_limit_pause(error.headers, now)
                    if self.deadline is not None:
                        if self.deadline - now <= 0:
                            raise  # the caller's deadline is spent; its own timeout path reports it
                        pause = min(pause, self.deadline - now)
                    print(f'DEPLOY_GATE_RATE_LIMITED waiting {pause:.0f}s (until '
                          f'{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + pause))})', flush=True)
                    self.rate_limited_seconds += pause
                    STOP.wait(pause)
                    attempt += 1
                    tokens, index = self.tokens(method), 0
                    continue
                if error.code >= 500 and attempt < 4:
                    STOP.wait(2 ** attempt)
                    attempt += 1
                    continue
                raise
            except (urllib.error.URLError, TimeoutError):
                if attempt == 4:
                    raise
                STOP.wait(2 ** attempt)
                attempt += 1
        raise RuntimeError(f'GitHub API {method} {path} kept failing')

    def json(self, path: str, conditional: bool = False, *, wait_on_rate_limit: bool = True):
        status, _, body = self.request('GET', path, conditional=conditional, wait_on_rate_limit=wait_on_rate_limit)
        url = path if path.startswith('https://') else f'{API}/repos/{self.repo}{path}'
        return self.cache[(self.served, url)] if status == 304 else json.loads(body)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Channel:
    """The gate's result channel: the private R2 trace bucket under deploy-gates/v1/<tag>/.

    The VM writes started.json, then its result, timing and evidence zip, and done.json last
    (with each object's sha256). The coordinator polls these objects, so the hot path never
    spends the GitHub REST quota that every thread on a devbox shares.
    """

    def __init__(self, env: dict, client=None):
        self.bucket = env.get('R2_BUCKET_TRACE_ARCHIVE')
        if client is None:
            import boto3
            from botocore.config import Config
            if not (env.get('R2_ACCOUNT_ID') and env.get('R2_ACCESS_KEY_ID') and env.get('R2_SECRET_ACCESS_KEY')
                    and self.bucket):
                raise ValueError('R2 result channel credentials are missing')
            client = boto3.client('s3', endpoint_url=f"https://{env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                                  aws_access_key_id=env['R2_ACCESS_KEY_ID'],
                                  aws_secret_access_key=env['R2_SECRET_ACCESS_KEY'], region_name='auto',
                                  config=Config(connect_timeout=15, read_timeout=120,
                                                retries={'max_attempts': 5, 'mode': 'adaptive'}))
        self.client = client

    @staticmethod
    def prefix(name: str) -> str:
        return f'{CHANNEL_PREFIX}/{name}/'

    def put(self, name: str, leaf: str, data: bytes) -> str:
        self.client.put_object(Bucket=self.bucket, Key=self.prefix(name) + leaf, Body=data)
        return hashlib.sha256(data).hexdigest()

    def get(self, name: str, leaf: str) -> bytes | None:
        try:
            return self.client.get_object(Bucket=self.bucket, Key=self.prefix(name) + leaf)['Body'].read()
        except Exception as error:  # botocore NoSuchKey / 404: not written yet
            code = getattr(error, 'response', {}).get('Error', {}).get('Code')
            if code in ('NoSuchKey', '404', 'NotFound'):
                return None
            raise

    def delete(self, name: str) -> None:
        listed = self.client.list_objects_v2(Bucket=self.bucket, Prefix=self.prefix(name)).get('Contents', [])
        if listed:
            self.client.delete_objects(Bucket=self.bucket,
                                       Delete={'Objects': [{'Key': o['Key']} for o in listed]})


def env_file_values(root: Path) -> dict:
    values = dict(os.environ)
    try:
        from dotenv import dotenv_values
        for rel in ('back-end/.env', 'agents/.env'):
            for key, value in dotenv_values(root / rel).items():
                values.setdefault(key, value)
    except ImportError:
        pass
    return values


# ---------------------------------------------------------------- coordinator side

def git_env(token: str) -> dict:
    return {**os.environ, 'DEPLOY_GATE_GIT_TOKEN': token, 'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_COUNT': '2',
            'GIT_CONFIG_KEY_0': 'credential.helper', 'GIT_CONFIG_VALUE_0': '',
            'GIT_CONFIG_KEY_1': 'credential.helper',
            'GIT_CONFIG_VALUE_1': '!f(){ echo username=x-access-token; echo "password=$DEPLOY_GATE_GIT_TOKEN"; }; f'}


def push_tag(root: Path, token: str, repo: str, name: str, raw: bytes) -> str:
    sha = git(root, 'hash-object', '-t', 'tag', '-w', '--stdin', input_bytes=raw)
    env = git_env(token)
    url = f'https://github.com/{repo}.git'
    # GitHub transiently rejects some of many simultaneous ref updates ("remote rejected ... (failed)").
    # The tag bytes are deterministic, so a retry re-checks the remote and pushes the same object.
    for attempt in range(PUSH_ATTEMPTS):
        existing = git(root, 'ls-remote', url, f'refs/tags/{name}', env=env).split()
        if existing and existing[0] != sha:
            raise ValueError(f'remote tag {name} already names a different request')
        if existing:
            return sha
        try:
            git(root, 'push', '--quiet', '--no-verify', url, f'{sha}:refs/tags/{name}', env=env)
            return sha
        except subprocess.CalledProcessError:
            if attempt == PUSH_ATTEMPTS - 1:
                raise
            time.sleep(2 * (attempt + 1))
    return sha


def delete_tag(root: Path, token: str, repo: str, name: str) -> None:
    """Best effort over git (no REST quota); the run, its logs and artifacts do not depend on the tag."""
    try:
        subprocess.run(['git', 'push', '--quiet', '--no-verify', f'https://github.com/{repo}.git',
                        f':refs/tags/{name}'], cwd=root, env=git_env(token), capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        pass


class WorkflowRejected(Exception):
    """GitHub refused the workflow file at this commit; the run never owned a VM."""


def find_run(gh: GitHub, head: str, name: str, deadline: float, pushed: float, stopping: bool = False) -> dict | None:
    # Filter by path, not the by-filename endpoint: that 404s until the workflow is on the default branch.
    # head_branch is the tag for a tag push; the small filtered list rarely changes, so most polls are 304s.
    path = f'/actions/runs?event=push&head_sha={head}&branch={urllib.parse.quote(name, safe="")}&per_page=20'
    unnamed = f'/actions/runs?event=push&head_sha={head}&per_page=20'
    rejected_since = None
    # `stopping`: the tag was pushed before the stop, so its run may exist although nothing named it yet.
    while time.time() < deadline and (stopping or not STOP.is_set()):
        mine = [r for r in gh.json(path, conditional=True).get('workflow_runs', [])
                if r.get('path') == WORKFLOW_PATH and r.get('head_branch') == name]
        if mine:
            return min(mine, key=lambda r: r['id'])
        # A workflow-file error yields an unnamed failed run (head_branch null) with no jobs.
        runs = [r for r in gh.json(unnamed, conditional=True).get('workflow_runs', []) if r.get('path') == WORKFLOW_PATH]
        invalid = [r for r in runs if r.get('head_branch') is None and r.get('conclusion') == 'failure'
                   and iso_epoch(r.get('created_at')) >= pushed - 5]
        if invalid:
            rejected_since = rejected_since or time.time()
            if time.time() - rejected_since > 30:
                raise WorkflowRejected(f"GitHub rejected {WORKFLOW_PATH} at {head}: {invalid[0].get('html_url')}")
        if stopping:
            time.sleep(min(1.0, max(0.0, deadline - time.time())))
        else:
            STOP.wait(START_POLL_SECONDS)
    return None


def launched_run(gh: GitHub, head: str, name: str, deadline: float, pushed: float) -> dict | None:
    """find_run, then (once stopped) one bounded lookup of the run this tag push started."""
    run = find_run(gh, head, name, deadline, pushed)
    if run is None and STOP.is_set():
        gh.until = stop_bound()
        try:
            run = find_run(gh, head, name, gh.until, pushed, stopping=True)
        except (WorkflowRejected, urllib.error.URLError, RuntimeError, OSError):
            run = None
        finally:
            gh.until = None
    return run


def iso_epoch(value: str | None) -> float:
    from datetime import datetime
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() if value else 0.0


def wait_run(gh: GitHub, run_id: int, deadline: float) -> dict:
    while True:
        run = gh.json(f'/actions/runs/{run_id}', conditional=True)
        if run.get('status') == 'completed' or STOP.is_set() or time.time() >= deadline:
            return run
        STOP.wait(min(POLL_SECONDS, max(1.0, deadline - time.time())))


def cancel_run(gh: GitHub, run_id: int, end: float | None = None, note: dict | None = None) -> dict:
    try:
        gh.request('POST', f'/actions/runs/{run_id}/cancel')
    except urllib.error.HTTPError as error:
        if error.code != 409:  # 409: already completed
            raise
    if note is not None:
        note['cancel_requested_at'] = time.time()
    end = time.time() + CANCEL_SECONDS if end is None else end
    while time.time() < end:
        run = gh.json(f'/actions/runs/{run_id}', conditional=True)  # a 5 s poll; unchanged reads are free 304s
        if run.get('status') == 'completed':
            return run
        time.sleep(max(0.0, min(5.0, end - time.time())))
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
    return extract_zip(body, destination)


def extract_zip(body: bytes, destination: Path) -> Path:
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
        signal.signal(sig, lambda number, _frame: request_stop(signal.Signals(number).name))
    threading.Thread(target=watch_parent, args=(os.getppid(),), daemon=True).start()

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
    # Watching stops CANCEL_SECONDS early so a cancel still fits; a rate-limit wait keeps that window too.
    gh = GitHub(token, repo, deadline=deadline, read_picker=lambda: pick_read_member(root))
    folder = result_path.parent / 'remote-artifact'
    try:
        channel = Channel(env_file_values(root))
    except (ImportError, ValueError) as error:
        print(f'DEPLOY_GATE_CHANNEL unavailable ({error}); watching the run through the GitHub API', flush=True)
        channel = None
    try:
        mirror = ProgressMirror(os.environ.get(progress.ENV))
        outcome = (watch_channel(gh, channel, head, name, deadline, started, mirror) if channel is not None
                   else watch_rest(gh, head, name, deadline, started))
    except (WorkflowRejected, urllib.error.URLError) as error:
        delete_tag(root, token, repo, name)
        return finish(blocked(request, str(error), receipt={'transport': TRANSPORT, 'tag': name}))
    kind, receipt = outcome['kind'], outcome.get('receipt') or {'transport': TRANSPORT, 'tag': name}
    receipt['rate_limited_seconds'] = gh.rate_limited_seconds
    receipt.update(read_identity=gh.read_name, read_fallbacks=gh.read_fallbacks)  # names only, never tokens
    gh.deadline = started + args.deadline_seconds  # cancel, receipts and artifacts may use the reserved window
    if STOP.is_set():
        receipt['stop_cause'] = STOPPED['cause']
    if kind == 'never-started':
        delete_tag(root, token, repo, name)  # Nothing started that we can name; the tag alone owns no VM.
        if STOP.is_set():
            receipt['run_lookup'] = f'no run named {name} within the stop-cancel bound'
        reason = 'cancelled before the remote run started' if STOP.is_set() else 'deploy-gates workflow run never started'
        return finish(blocked(request, reason, receipt=receipt))
    if kind == 'unfinished':
        reason = 'cancelled' if STOP.is_set() else 'existing gate deadline exhausted'
        end = stop_bound() if STOP.is_set() else None
        gh.until = end  # stopped: every cancel request fits the supervisor's TERM grace
        try:
            run = cancel_run(gh, receipt['run_id'], end, note=receipt)
        except (urllib.error.URLError, RuntimeError, OSError) as error:  # best effort: the owner is retained
            run = {}
            receipt['cancel_error'] = f'{type(error).__name__}: {error}'[:300]
        gh.until = None
        confirmed = run.get('status') == 'completed'
        receipt.update(status=run.get('status'), conclusion=run.get('conclusion'))
        if confirmed:
            delete_tag(root, token, repo, name)
            if channel is not None:
                channel.delete(name)
        owner = None if confirmed else {k: receipt.get(k) for k in ('transport', 'run_id', 'url')}
        return finish(blocked(request, f'remote run {reason}', owner=owner, receipt=receipt))
    delete_tag(root, token, repo, name)  # The run, its logs and artifact outlive the tag.
    if receipt.get('head_sha') not in (None, head):
        return finish(blocked(request, 'remote run executed a different commit', receipt=receipt))
    try:
        if kind == 'channel':
            done = outcome['done']
            for leaf in ('artifact.zip', 'result.json'):
                if leaf in done['objects']:
                    data = channel.get(name, leaf)
                    if data is None or hashlib.sha256(data).hexdigest() != done['objects'][leaf]:
                        raise ValueError(f'channel {leaf} is missing or differs from its done.json digest')
                    if leaf == 'artifact.zip':
                        extract_zip(data, folder)
            artifact = folder if folder.is_dir() else None
            channel.delete(name)
        else:
            artifact = download_artifact(gh, receipt['run_id'], folder)
        if artifact is None or not (artifact / 'result.json').is_file():
            return finish(blocked(request, f"remote run {receipt.get('conclusion') or 'ended'} without a worker result",
                                  receipt=receipt))
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


def watch_rest(gh: GitHub, head: str, name: str, deadline: float, pushed: float) -> dict:
    run = launched_run(gh, head, name, min(deadline, time.time() + START_SECONDS), pushed)
    if run is None:
        return {'kind': 'never-started'}
    print(f'DEPLOY_GATE_REMOTE_RUN {run["html_url"]}', flush=True)
    run = wait_run(gh, run['id'], deadline)
    receipt = job_receipt(gh, run)
    return {'kind': 'rest' if run.get('status') == 'completed' else 'unfinished', 'receipt': receipt}


class ProgressMirror:
    """Appends the VM's new progress rows to the cycle's local progress file (DEPLOY_GATE_PROGRESS).

    The VM uploads its whole append-only file; only complete lines past what was mirrored are added.
    Advisory: an unreadable object or an unset path never affects the gate's result.
    """

    def __init__(self, path: str | None):
        self.path = Path(path) if path else None
        self.length = 0

    def pull(self, channel: 'Channel', name: str) -> int:
        if self.path is None:
            return 0
        try:
            data = channel.get(name, 'progress.jsonl')
        except Exception:  # advisory channel read
            return 0
        if not data or len(data) <= self.length:
            return 0
        new = data[self.length:]
        new = new[:new.rfind(b'\n') + 1]
        if not new:
            return 0
        try:
            with self.path.open('ab') as stream:
                stream.write(new)
        except OSError:
            return 0
        self.length += len(new)
        return len(new)


def watch_channel(gh: GitHub, channel: 'Channel', head: str, name: str, deadline: float, pushed: float,
                  mirror: ProgressMirror | None = None) -> dict:
    """Poll the R2 channel; GitHub is asked only when the channel stays silent or the run must be cancelled."""
    start_by, receipt, checked = min(deadline, time.time() + START_SECONDS), None, time.time()
    while not STOP.is_set() and time.time() < deadline:
        if mirror is not None and receipt is not None:
            mirror.pull(channel, name)  # a still-running gate's failing tests reach the cycle now
        raw = channel.get(name, 'done.json')
        if raw is not None:
            if mirror is not None:
                mirror.pull(channel, name)
            done = json.loads(raw)
            receipt = {**(receipt or {}), **{k: v for k, v in done.items() if k not in ('objects', 'at')},
                       'finished_at': done.get('at')}
            return {'kind': 'channel', 'done': done, 'receipt': receipt}
        if receipt is None:
            started = channel.get(name, 'started.json')
            if started is not None:
                receipt = json.loads(started)
                print(f"DEPLOY_GATE_REMOTE_RUN {receipt.get('url')}", flush=True)
            elif time.time() >= start_by:
                # Silent channel: a rejected workflow, a setup failure before the env bundle, or no runner yet.
                run = find_run(gh, head, name, time.time() + 30, pushed)
                if run is None:
                    if STOP.is_set():
                        break  # stopped mid-lookup: the bounded lookup below still names the run
                    return {'kind': 'never-started'}
                receipt = {'transport': TRANSPORT, 'run_id': run['id'], 'url': run.get('html_url'), 'tag': name}
                print(f"DEPLOY_GATE_REMOTE_RUN {receipt['url']}", flush=True)
        if receipt is not None and time.time() - checked >= LIVENESS_SECONDS:
            # A run that ended without done.json (VM lost, setup died early) must not wait out the deadline.
            checked = time.time()
            try:
                run = gh.json(f"/actions/runs/{receipt['run_id']}", conditional=True, wait_on_rate_limit=False)
            except urllib.error.HTTPError:
                run = {}
            if run.get('status') == 'completed' and channel.get(name, 'done.json') is None:
                STOP.wait(30)  # the bundle step's upload may still be landing
                if channel.get(name, 'done.json') is None:
                    return {'kind': 'rest', 'receipt': job_receipt(gh, run)}
        STOP.wait(START_POLL_SECONDS if receipt is None else CHANNEL_POLL_SECONDS)
    if receipt is None:
        run = launched_run(gh, head, name, time.time() + 30, pushed)
        if run is None:
            return {'kind': 'never-started'}
        receipt = {'transport': TRANSPORT, 'run_id': run['id'], 'url': run.get('html_url'), 'tag': name}
    return {'kind': 'unfinished', 'receipt': receipt}


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
    (out / 'overrides').write_text(gate_overrides(body.get('overrides', '')))
    timing = {'job_started_at': float(os.environ.get('DEPLOY_GATE_T0') or time.time()), 'extracted_at': time.time()}
    (out / 'timing.json').write_text(json.dumps(timing))
    print(f"gate={request['gate']} worker={body['worker_script']} checks={len(request['checks'])}")
    return 0


class ProgressStreamer(threading.Thread):
    """Puts the gate's growing progress file to the R2 channel while the worker runs (advisory)."""

    def __init__(self, channel: 'Channel', name: str, path: Path, interval: float | None = None):
        super().__init__(daemon=True)
        self.channel, self.name, self.path = channel, name, Path(path)
        self.interval = STREAM_SECONDS if interval is None else interval
        self.done = threading.Event()
        self.sent = 0
        self.failed = False

    def flush(self) -> None:
        try:
            data = self.path.read_bytes()
        except FileNotFoundError:
            return
        data = data[:data.rfind(b'\n') + 1]  # complete rows only
        if len(data) <= self.sent:
            return
        try:
            self.channel.put(self.name, 'progress.jsonl', data)
        except Exception as error:  # advisory upload; the result still arrives at the end
            if not self.failed:
                print(f'DEPLOY_GATE_PROGRESS upload failed ({type(error).__name__}); retrying', flush=True)
            self.failed = True
            return
        self.sent = len(data)

    def run(self) -> None:
        while not self.done.wait(self.interval):
            self.flush()
        self.flush()


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
    env = {**os.environ, 'DEPLOY_GATE_REQUEST': str(out / 'request.json'), 'DEPLOY_GATE_RESULT': str(out / 'result.json'),
           progress.ENV: str(out / 'progress.jsonl')}
    env.pop(OVERRIDES_ENV, None)  # only the coordinator's elected overrides apply, never the VM's own env
    overrides = (out / 'overrides').read_text().strip() if (out / 'overrides').is_file() else ''
    if overrides:
        env[OVERRIDES_ENV] = gate_overrides(overrides)
        print(f'DEPLOY_GATE_OVERRIDDEN {overrides} (user-elected; the overridden cases do not run)', flush=True)
    streamer = None
    try:
        streamer = ProgressStreamer(Channel(env_file_values(ROOT)), os.environ['GITHUB_REF_NAME'], out / 'progress.jsonl')
        streamer.start()
    except (ImportError, ValueError, KeyError) as error:
        print(f'DEPLOY_GATE_PROGRESS stream unavailable ({error}); failures arrive with the result', flush=True)
    try:
        code = subprocess.run([sys.executable, str(ROOT / 'scripts' / script), '--root', str(ROOT)], env=env).returncode
    finally:
        if streamer is not None:
            streamer.done.set()
            streamer.join(timeout=120)
    timing.update(worker_finished_at=time.time(), worker_exit=code)
    (out / 'timing.json').write_text(json.dumps(timing))
    print(f'DEPLOY_GATE_WORKER_EXIT {code}')
    return 0  # The verdict is result.json; a failing gate still uploads its evidence and caches.


def bundle_priority(path: Path, evidence: frozenset) -> tuple:
    """Order files for the capped artifact: the gate's named evidence and every log first.

    Smallest-first alone let thousands of raw V8 and replay-cache JSON files fill the
    400 MB budget, so the 10 MB backend server log of a failed coverage shard was the
    file dropped (docs/rca/cases/2026-11-08-grep-regex-safety-blocked-event-loop.md).
    """
    text = str(path) in evidence or path.suffix in ('.log', '.txt') or path.name in BUNDLE_SUMMARIES
    return (0 if text else 1, path.stat().st_size, str(path))


def remote_bundle(args) -> int:
    out = args.out
    artifact = out / 'artifact'
    artifact.mkdir(parents=True, exist_ok=True)
    for name in ('result.json', 'timing.json', 'request.json', 'progress.jsonl'):
        if (out / name).is_file():
            shutil.copyfile(out / name, artifact / name)
    root = ROOT.resolve()
    paths = set()
    if (out / 'result.json').is_file():
        for row in (json.loads((out / 'result.json').read_text()).get('evidence') or {}).values():
            if isinstance(row, dict):
                paths.update(v for k, v in row.items() if isinstance(v, str) and v.startswith(str(root) + '/'))
    # The native dump producers both write <checkout>/.llm-dumps/<agent>/*.json.
    # Retain existing dev dumps only; never enable dumping or read session configs.
    dumps = root / '.llm-dumps'
    if dumps.is_dir() and not dumps.is_symlink():
        paths.update(str(p) for p in dumps.glob('*/*.json') if p.is_file())
    # run.sh publishes actual service paths; local_worker_supervisor.py writes
    # worker 0 there and additional streams as <stem>.<index><suffix>.
    service_logs = {root / rel for rel in SERVICE_LOGS}
    for manifest in (root / '.context').rglob('services.json'):
        if manifest.is_symlink() or not manifest.is_file() or manifest.stat().st_size > 65536:
            continue
        try:
            document = json.loads(manifest.read_text())
            logs = document.get('logs', {}) if isinstance(document, dict) else {}
            for name in ('backend', 'frontend', 'worker'):
                raw = logs.get(name) if isinstance(logs, dict) else None
                if isinstance(raw, str):
                    path = Path(raw)
                    service_logs.add(path if path.is_absolute() else root / path)
        except (OSError, ValueError):
            continue
    for path in tuple(service_logs):
        if path.name and root in path.absolute().parents:
            for sibling in path.parent.glob(f'{path.stem}.*{path.suffix}'):
                index = sibling.name[len(path.stem) + 1:len(sibling.name) - len(path.suffix) or None]
                if index.isdigit():
                    service_logs.add(sibling)
    paths.update(str(p) for p in service_logs if p.is_file())
    # Existing dumps and all actual service streams outrank bulk cache JSON.
    evidence = frozenset(paths)
    # Everything a gate leaves for RCA: its .context state and logs plus the stack's service logs.
    # Caches and dependency trees stay behind; per-file and total caps bound the artifact.
    if (root / '.context').is_dir():
        for path in (root / '.context').rglob('*'):
            parts = path.relative_to(root / '.context').parts
            if path.is_file() and not path.is_symlink() and parts[0] not in BUNDLE_SKIP:
                paths.add(str(path))
    paths.update(str(root / rel) for rel in SERVICE_LOGS if (root / rel).is_file())
    for rel in LOG_TREES:  # per-domain/test logs the suites write outside .context
        if (root / rel).is_dir():
            paths.update(str(p) for p in (root / rel).rglob('*')
                         if p.is_file() and not p.is_symlink() and p.suffix in ('.log', '.json', '.txt'))
    total, skipped, captured = 0, [], []
    for raw in sorted(paths, key=lambda p: bundle_priority(Path(p), evidence)):
        path = Path(raw)
        if not path.is_file() or root not in path.absolute().parents or root not in path.resolve().parents:
            continue
        relative = path.absolute().relative_to(root)
        # Reject every symlink component, including aliases to in-checkout secrets.
        if any((root.joinpath(*relative.parts[:i])).is_symlink() for i in range(1, len(relative.parts) + 1)):
            skipped.append({'path': str(relative), 'reason': 'symlink'})
            continue
        if any(part in {'.rose', '.codex'} or part == '.env' or part.startswith('.env.') for part in relative.parts):
            skipped.append({'path': str(relative), 'reason': 'private_config'})
            continue
        size = path.stat().st_size
        if size > BUNDLE_FILE_BYTES or total + size > BUNDLE_TOTAL_BYTES:
            skipped.append({'path': str(path.relative_to(root)), 'bytes': size})
            continue
        target = artifact / 'files' / path.resolve().relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        captured.append({'path': str(target.relative_to(artifact / 'files')), 'bytes': size,
                         'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
        total += size
    (artifact / 'bundle.json').write_text(json.dumps({'bytes': total, 'skipped': skipped, 'captured': captured}, indent=1))
    publish_done(out, artifact)
    return 0


def runner_identity() -> dict:
    run_id = os.environ.get('GITHUB_RUN_ID')
    return {'transport': TRANSPORT, 'run_id': int(run_id) if run_id and run_id.isdigit() else None,
            'run_attempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'event_sha': os.environ.get('GITHUB_SHA'),
            'tag': os.environ.get('GITHUB_REF_NAME'), 'runner_name': os.environ.get('RUNNER_NAME'),
            'url': (f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/"
                    f"{os.environ.get('GITHUB_REPOSITORY')}/actions/runs/{run_id}") if run_id else None}


def remote_signal(args) -> int:
    """started.json, as soon as the VM can reach the channel: the coordinator's run id for cancellation."""
    Channel(env_file_values(ROOT)).put(os.environ['GITHUB_REF_NAME'], 'started.json',
                                       json.dumps({**runner_identity(), 'at': time.time()}).encode())
    return 0


def publish_done(out: Path, artifact: Path) -> None:
    try:
        channel = Channel(env_file_values(ROOT))
    except (ImportError, ValueError) as error:
        print(f'DEPLOY_GATE_CHANNEL unavailable: {error}', flush=True)
        return  # The coordinator falls back to the run's GitHub artifact.
    name = os.environ['GITHUB_REF_NAME']
    archive = out / 'artifact.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(artifact.rglob('*')):
            if path.is_file():
                bundle.write(path, path.relative_to(artifact))
    done = {**runner_identity(), 'at': time.time(), 'objects': {}}
    for leaf, path in (('artifact.zip', archive), ('result.json', out / 'result.json')):
        if path.is_file():
            done['objects'][leaf] = channel.put(name, leaf, path.read_bytes())
    channel.put(name, 'done.json', json.dumps(done).encode())  # written last: the completion marker


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode')
    for mode in ('remote-extract', 'remote-run', 'remote-bundle', 'remote-signal'):
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
    if args.mode == 'remote-signal':
        return remote_signal(args)
    if not (args.runner and args.worker_script and args.worker_root and args.deadline_seconds):
        parser.error('launch requires --runner, --worker-script, --worker-root and --deadline-seconds')
    return launch(args)


if __name__ == '__main__':
    raise SystemExit(main())
