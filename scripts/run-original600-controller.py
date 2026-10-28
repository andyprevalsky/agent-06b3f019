#!/usr/bin/env python3
"""Portable original600 capacity → bind → owned controller entrypoint."""
import argparse
import ast
import copy
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import runpy
import signal
import ssl
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

PINS = [
    'run-cloudbench-controller-gate', 'cloudbench-disposable-controller.py',
    'cloudbench-controller-export.py', 'cloudbench-original-volume-capture.py',
    'cloudbench-original600-supervisor.py', 'cloudbench-install-controller-client.py',
    'cloudbench-campaign-mutation.py', 'cloudbench-script-snapshot.py',
    'cloudbench-cleanup-tickets.py', 'cloudbench-machine-readiness.py',
    'cloudbench-cohort-reconcile.py', 'cloudbench-shared-relay.py',
    'cloudbench-campaign-env.py', 'cloudbench-campaign-seed.py', 'cloudbench-port-lease.py',
    'cloudbench-operator-preflight.py', 'cloudbench-original600-runner.py',
    'cloudbench-controller-bulk-transfer.py', 'run-bench-campaign.py',
    'cloudbench-infra-canary-preflight.py',
    'run-original600-controller.py', 'cloudbench-archived-machine-reuse.py',
    'cloudbench-archived-reuse-effects.py', 'cloudbench-archived-reuse-transport.py',
    'cloudbench-retained-successor.py',
    'cloudbench-archived-owner-stop.py', 'cloudbench-stop-all.py',
    'cloudbench-unused-reservations.py',
    'cloudbench-parked-reservations.py',
    'cloudbench-reconcile-reservations.py',
    'cloudbench-observe-reservations.py',
    'cloudbench-incomplete-reservations.py',
    'cloudbench-recovered-reservations.py',
    'cloudbench-closed-transition-reservations.py',
    'cloudbench-prepare-admission.py',
    'cloudbench-reuse-index.py',
    'cloudbench-isolated-generation.py', 'cloudbench-fetch-ref.sh',
    'lib/cloudbench-archived-reuse.sh', 'run-bench-fleet', 'run-bench-cloud',
    'cloudbench-shard-coordinator.py',
]


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def reuse_module():
    return runpy.run_path(str(Path(__file__).with_name('cloudbench-archived-machine-reuse.py')))


class AdmissionInterrupted(BaseException):
    def __init__(self, signum):
        self.signum=signum


@contextmanager
def joined_admission_signals():
    """Interrupt admission once, allowing its executor to join owned operations."""
    previous={number:signal.getsignal(number) for number in (signal.SIGINT,signal.SIGTERM)}
    def interrupted(signum, frame):
        # Repeated signals must not interrupt the finite native join/lease release.
        for number in previous:
            signal.signal(number,lambda *_:None)
        raise AdmissionInterrupted(signum)
    for number in previous:
        signal.signal(number,interrupted)
    try:
        yield
    finally:
        for number,handler in previous.items():
            signal.signal(number,handler)


def source(root, ref):
    actual = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != ref:
        raise ValueError('exact harness HEAD required')
    if subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain', '--untracked-files=no']):
        raise ValueError('tracked harness changes refused')
    pins = {}
    for name in PINS:
        raw = (root / 'scripts' / name).read_bytes()
        committed = subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), 'show', ref + ':scripts/' + name])
        if raw != committed:
            raise ValueError('harness source changed: ' + name)
        pins[name] = digest(raw)
    return pins


def token_from_agents(raw):
    # Preserve the canonical credential's explicit scheme. Only a single
    # literal value is accepted; no shell expansion or multiline parsing.
    values = [line.split('=', 1)[1].strip()
              for line in raw.decode().splitlines() if line.startswith('FLY_API_TOKEN=')]
    if len(values) != 1:
        raise ValueError('one literal Fly token required in selected complete agents env')
    value = values[0]
    if value[:1] in ('"', "'") or value[-1:] in ('"', "'"):
        if len(value) < 2 or value[0] != value[-1]:
            raise ValueError('one literal Fly token required in selected complete agents env')
        value = value[1:-1]
    if value in ('FlyV1', 'Bearer') or not re.fullmatch(r'(?:(?:FlyV1|Bearer) )?[A-Za-z0-9_./+,=:\-]+', value):
        raise ValueError('one literal Fly token required in selected complete agents env')
    return value


def token_header(token):
    return token if token.startswith(('FlyV1 ', 'Bearer ')) else 'Bearer ' + token


def github_token(root, backend_env, agents_env):
    # Use the existing controller precedence, passing complete explicit input
    # paths instead of materializing secret subsets in a sparse checkout.
    result = subprocess.run(['bash', '-c',
        'source "$1"; cloudbench_resolve_controller_github_token "$2" "$3" "$4"',
        'github-preflight', str(root/'scripts/lib/cloudbench-env.sh'), str(root),
        str(backend_env), str(agents_env)], cwd=root, capture_output=True, timeout=15)
    token = result.stdout.decode().strip()
    if result.returncode != 0 or not re.fullmatch(r'[A-Za-z0-9_./+=:\-]+', token):
        raise ValueError('GitHub credential unavailable or malformed in selected controller inputs')
    return token


CANONICAL_SEED_ABSENT = 3  # seed-dump-cache.ts head: definite absence


def canonical_seed_token(root, ref):
    """The token every cloud guest restores at the bound source ref (cloudbench-campaign-seed.py)."""
    import tempfile
    with tempfile.TemporaryDirectory(prefix='canonical-seed-token-') as scratch:
        for member in ('back-end/prisma/schema.prisma', 'agents/benchmarks/seed_cache_path.py'):
            target = Path(scratch, member)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), 'show',
                                                        ref + ':' + member]))
        module = runpy.run_path(str(Path(scratch, 'agents/benchmarks/seed_cache_path.py')))
        return module['seed_cache_token'](Path(scratch, 'back-end/prisma/schema.prisma'),
                                          pg_major=os.environ.get('CLOUDBENCH_GUEST_PG_MAJOR') or '15')


def canonical_seed_head(root, token):
    """The shared cache's own bounded metadata read: 0 present, 3 absent, anything else unreadable."""
    under_test = os.environ.get('CLOUDBENCH_SEED_CACHE_CLI_UNDER_TEST')
    if under_test:
        command, cwd = [under_test, 'head', token], root
    else:
        tsx = next((str(p) for p in (root/'back-end/node_modules/.bin/tsx', root/'node_modules/.bin/tsx') if p.exists()), None)
        command, cwd = ([tsx] if tsx else ['npx', '--yes', 'tsx']) + ['scripts/seed-dump-cache.ts', 'head', token], root/'back-end'
    try:
        return subprocess.run(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.PIPE, text=True, timeout=90).returncode
    except (OSError, subprocess.TimeoutExpired):
        return None


def guest_temporal_env(root, agents_env, backend_env):
    """The guest env copies this launch expects, rendered by the canonical helper.

    Guests never receive the controller's env files: every primary and worker
    decodes the shared bench-app AGENTS_ENV_B64/BACKEND_ENV_B64 secrets, staged
    only by run-bench-cloud --refresh-secrets/--setup/image-activate, which apply
    the private guest Temporal override (.env.benchmark-temporal beside the
    selected agents env). Render the same copies here, from the same selected
    inputs and override lookup, to bind and report the guest namespace; the
    selected files themselves are only read. Returns digests and the namespace,
    never a credential. Without an override the copies are the input bytes.
    """
    import shutil
    import tempfile
    scratch = Path(tempfile.mkdtemp(prefix='original600-guest-env.'))
    try:
        result = subprocess.run(['bash', '-c',
            'source "$1"; override="$(cloudbench_guest_temporal_override_file "$2")" || exit 1; '
            '[ -n "$override" ] || exit 0; '
            'cloudbench_write_guest_temporal_env_files "$2" "$3" "$override" "$4"',
            'guest-temporal-env', str(root/'scripts/lib/cloudbench-env.sh'), str(agents_env),
            str(backend_env), str(scratch)], cwd=root, capture_output=True, timeout=30)
        if result.returncode != 0:
            raise ValueError('guest Temporal override unusable: '
                             + result.stderr.decode(errors='replace').strip()[-300:])
        namespace = result.stdout.decode().strip() or None
        rendered = {p.name for p in scratch.iterdir()}
        if namespace is None:
            if rendered:
                raise ValueError('guest Temporal override rendered copies without a namespace')
            sources = dict(agents=Path(agents_env), backend=Path(backend_env))
        else:
            if rendered != {'agents.env', 'backend.env'} or not re.fullmatch(r'[A-Za-z0-9._-]+', namespace):
                raise ValueError('guest Temporal override rendered an unexpected result')
            sources = dict(agents=scratch/'agents.env', backend=scratch/'backend.env')
        return dict(temporal_namespace=namespace, override=namespace is not None, delivery='bench-app-secrets',
                    **{key + '_env_sha256': digest(path.read_bytes()) for key, path in sources.items()})
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def facts_from(raw):
    facts = json.loads(raw)
    if (facts.get('app') != 'navi-whisper-lux-bench'
            or not isinstance(facts.get('image_ref'), str)
            or '@sha256:' not in facts['image_ref']
            or not isinstance(facts.get('protected_machines'), list)
            or len(facts['protected_machines']) < 4
            or not isinstance(facts.get('protected_volumes'), list)):
        raise ValueError('original app, immutable image and explicit protected resources required')
    return facts


def read_inventory(path):
    """Read a complete native inventory without widening small secret/intent inputs."""
    path = Path(path).absolute()
    if path.resolve(strict=True) != path:
        raise ValueError('physical private inventory required')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not (stat.S_ISREG(before.st_mode) and before.st_uid == os.geteuid()
                and not before.st_mode & 0o077 and before.st_nlink == 1
                and 0 < before.st_size <= 256 * 1024 * 1024):
            raise ValueError('private current-owner inventory required')
        raw = stream.read(before.st_size + 1)
        after = os.fstat(stream.fileno())
        fields = ('st_ino', 'st_dev', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode', 'st_uid', 'st_nlink')
        if len(raw) != before.st_size or any(getattr(before, field) != getattr(after, field) for field in fields):
            raise ValueError('native inventory changed during read')
        return raw


def image_identity(value):
    match=re.fullmatch(r'([^@\s]+)@(sha256:[0-9a-f]{64})',value if isinstance(value,str) else '')
    if not match:
        raise ValueError('immutable repository and image digest required')
    name=match[1]
    # Tags are labels, while repository plus digest identifies immutable bytes.
    if ':' in name.rsplit('/',1)[-1]:
        name=name.rsplit(':',1)[0]
    return name,match[2]


def verify_reuse_images(request, inventory, expected):
    identity=image_identity(expected)
    machines={machine['id']:machine for machine in inventory}
    for row in request['candidates']:
        current=machines.get(row['machine_id'])
        if current is None or not isinstance(current.get('config'), dict) or image_identity(current['config'].get('image')) != identity:
            raise ValueError('archived candidate image differs from the admitted immutable image')
        resolved=current.get('image_ref')
        if isinstance(resolved,dict) and resolved.get('digest') and resolved['digest'] != identity[1]:
            raise ValueError('resolved native image digest differs from the admitted image')


def observe_reuse_configs(
    api_factory, request, inventory, directory, runner, deadline, *, proof=None
):
    """Observe selected incomplete rows with bounded current GETs; never infer config."""
    rows = {row["machine_id"]: row for row in request["candidates"]}
    machines = {row["id"]: row for row in inventory}
    if len(machines) != len(inventory) or len(rows) != len(request["candidates"]):
        raise ValueError("duplicate native or candidate identity")
    missing = [
        mid
        for mid in rows
        if mid in machines and not isinstance(machines[mid].get("config"), dict)
    ]
    if not missing:
        return inventory
    if not 0 < deadline - time.time() <= 5400:
        raise ValueError("original config observation deadline expired")
    directory = Path(directory)
    directory.mkdir(mode=0o700)
    observed = {}
    phase_remaining = min(110, deadline - time.time())
    if phase_remaining <= 0:
        raise ValueError("original config observation deadline expired")
    phase_end = time.monotonic() + phase_remaining
    phase_deadline = time.time() + phase_remaining
    attempts = {mid: 0 for mid in missing}
    pending = list(missing)
    try:
        with runner["bounded"](phase_remaining):
            runner["save"](
                directory / "intent.json",
                {
                    "schema": "original600-selected-full-config-observation-v1",
                    "request_sha256": digest(
                        json.dumps(request, sort_keys=True, allow_nan=False).encode()
                    ),
                    "inventory_sha256": digest(
                        json.dumps(inventory, sort_keys=True, allow_nan=False).encode()
                    ),
                    "machine_ids": missing,
                    "original_deadline": deadline,
                    "observation_deadline": phase_deadline,
                    "observation_monotonic_end": phase_end,
                    "identity_encoding": "json-sort-keys-default-spaces",
                    "config_writes": 0,
                    "capacity_credit": 0,
                },
            )
            helper = reuse_module()
            while pending:
                if time.monotonic() >= phase_end or time.time() >= deadline:
                    raise ValueError(
                        "full native config observation remains unknown at original phase deadline"
                    )
                mid = pending.pop(0)
                listed = machines[mid]
                if listed.get("instance_id") != rows[mid][
                    "source_instance_id"
                ] or listed.get("state") not in ("created", "stopped"):
                    raise ValueError("incomplete list row version/state differs")
                out = directory / mid
                out.mkdir(mode=0o700, exist_ok=True)
                attempts[mid] += 1
                attempt = out / ("attempt-%06d" % attempts[mid])
                attempt.mkdir(mode=0o700)
                # The canonical adapter saves request/raw bytes before parsing.
                # Main-thread direct GET owns no helper subprocess to abandon.
                try:
                    with runner["bounded"](
                        min(20, phase_end - time.monotonic(), deadline - time.time())
                    ):
                        current = api_factory(attempt).request(
                            "GET", "/machines/" + mid, timeout=20, direct=True
                        )
                except runner["Deadline"]:
                    runner["save"](
                        attempt / "read-pending.json",
                        {
                            "machine_id": mid,
                            "error_type": "Deadline",
                            "operation": "GET",
                            "original_deadline": deadline,
                            "observation_deadline": phase_deadline,
                            "capacity_credit": 0,
                            "config_writes": 0,
                        },
                    )
                    if time.monotonic() >= phase_end or time.time() >= deadline:
                        raise ValueError(
                            "full native config observation remains unknown at original phase deadline"
                        )
                    pending.append(mid)
                    continue
                if time.monotonic() >= phase_end or time.time() >= deadline:
                    raise ValueError("late full native config observation")
                if (
                    not isinstance(current, dict)
                    or not isinstance(current.get("config"), dict)
                    or current.get("id") != listed["id"]
                    or current.get("instance_id") != listed["instance_id"]
                ):
                    raise ValueError(
                        "exact full native config remains unknown or changed"
                    )
                helper["same_source"](rows[mid], current)
                verify_reuse_images(
                    dict(request, candidates=[rows[mid]]),
                    [current],
                    request["image_ref"],
                )
                runner["save"](out / "observed.json", current)
                observed[mid] = current
            if time.monotonic() >= phase_end or time.time() >= deadline:
                raise ValueError("late full native config observation completion")
            runner["save"](
                directory / "complete.json",
                {
                    "schema": "original600-selected-full-config-observation-v1",
                    "machine_ids": missing,
                    "original_deadline": deadline,
                    "intent_sha256": digest(runner["read"](directory / "intent.json")),
                    "observed": {
                        mid: digest(runner["read"](directory / mid / "observed.json"))
                        for mid in observed
                    },
                    "config_writes": 0,
                    "capacity_credit": 0,
                },
            )
            completion_metadata = {
                "directory": str(directory),
                "intent_sha256": digest(runner["read"](directory / "intent.json")),
                "complete_sha256": digest(runner["read"](directory / "complete.json")),
                "observed": {
                    mid: digest(runner["read"](directory / mid / "observed.json"))
                    for mid in observed
                },
                "original_deadline": deadline,
                "config_writes": 0,
                "capacity_credit": 0,
            }
    except BaseException as error:
        runner["save"](
            directory / "failure.json",
            {
                "error_type": type(error).__name__,
                "observed_machine_ids": list(observed),
                "original_deadline": deadline,
                "config_writes": 0,
                "capacity_credit": 0,
                "unknown_rows_not_credited": True,
                "no_write_retry": True,
                "observation_deadline": phase_deadline,
            },
        )
        raise
    if time.monotonic() >= phase_end or time.time() >= deadline:
        raise ValueError("original config observation deadline expired")
    if proof is not None:
        proof["selected_full_config_observation"] = completion_metadata
    return [observed.get(row["id"], row) for row in inventory]


# Organization settings and the app list are read-only inventory: one slow or
# failed read (live proof 1792433714160918322 lost its launch to a single 20 s
# `flyctl apps list`) is retried; a persistent or non-transient failure still
# refuses. The callers' I/O alarm (a BaseException) bounds every attempt.
INVENTORY_READ_ATTEMPTS = 3
INVENTORY_RETRY_PAUSES = (2, 5)


def transient_read_error(error):
    if isinstance(error, urllib.error.HTTPError):
        return error.code == 429 or error.code >= 500
    if isinstance(error, urllib.error.URLError):
        error = error.reason if isinstance(error.reason, BaseException) else error
    if isinstance(error, (FileNotFoundError, PermissionError, ssl.SSLCertVerificationError)):
        return False  # a missing flyctl or an untrusted endpoint does not heal on retry
    return isinstance(error, (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError))


def retried_read(label, read):
    for attempt in range(1, INVENTORY_READ_ATTEMPTS + 1):
        try:
            return read()
        except Exception as error:
            if attempt == INVENTORY_READ_ATTEMPTS or not transient_read_error(error):
                raise
            print(json.dumps(dict(status='INVENTORY_READ_RETRY', read=label, attempt=attempt,
                                  error=type(error).__name__)), file=sys.stderr, flush=True)
            time.sleep(INVENTORY_RETRY_PAUSES[attempt - 1])


def capacity_snapshot(api, token, org, directory, extra, summary=False):
    started = time.time()
    query = 'query { organization(slug:' + json.dumps(org) + ') { id slug settings billingStatus } }'
    req = urllib.request.Request('https://api.fly.io/graphql', data=json.dumps({'query': query}).encode(),
                                 headers={'Authorization': token_header(token), 'Content-Type': 'application/json'})
    def read_settings():
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.load(response)
    settings = retried_read('organization settings', read_settings)
    if settings.get('errors') or not settings.get('data', {}).get('organization'):
        raise ValueError('complete organization settings required')
    organization = settings['data']['organization']
    if organization.get('slug') != org:
        raise ValueError('organization settings scope mismatch')
    limit = organization['settings']['machines_per_org_limit']
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError('measured original organization limit required')
    apps = json.loads(retried_read('organization apps', lambda: subprocess.run(
        ['flyctl', 'apps', 'list', '--org', org, '--json'], capture_output=True, text=True, timeout=20, check=True)).stdout)
    if not isinstance(apps, list) or not apps or len({a['Name'] for a in apps}) != len(apps):
        raise ValueError('fresh complete organization app inventory required')
    if 'navi-whisper-lux-bench' not in {a['Name'] for a in apps}:
        raise ValueError('capacity inventory does not include the original benchmark app')
    for app in apps:
        organization_value = app.get('Organization')
        app_org = organization_value.get('Slug') if isinstance(organization_value, dict) else organization_value
        if app_org != org:
            raise ValueError('organization app inventory scope mismatch')
    runner = runpy.run_path(str(Path(__file__).with_name('cloudbench-original600-runner.py')))
    runner['save'](directory / 'organization.private.json', settings)
    runner['save'](directory / 'apps.private.json', apps)

    native_by_app = {}
    def read_app(app):
        name = app['Name']
        if not isinstance(name, str) or not name or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in name):
            raise ValueError('invalid inventory app name')
        # A count needs no configs; summary rows are ~2 KB instead of ~200 KB.
        machines = api(name, token).api('GET', '/machines?summary=true' if summary else '/machines', timeout=20)
        if not isinstance(machines, list) or len({m['id'] for m in machines}) != len(machines):
            raise ValueError('complete native Machine inventory required')
        native_by_app[name] = machines
        path = directory / (name + '.private.json')
        runner['save'](path, machines)
        return dict(app=name, count=len(machines), path=str(path), sha256=digest(path.read_bytes()))

    # Read on the alarm-owning main thread: socket inactivity timeouts do not
    # bound a drip-fed body, and thread-pool shutdown cannot join such a worker.
    rows = [read_app(app) for app in apps]
    count = sum(r['count'] for r in rows)
    return dict(started_epoch=started, ended_epoch=time.time(), machine_limit=limit,
                billing_status=organization['billingStatus'], total_active_inventory_objects=count,
                conservative_extra_destroying_bench_objects=extra, apps=rows,
                atomic_snapshot=False, all_reads_only=True, available_slots_conservative=limit-count-extra,
                new_controller_slots=1, requested_original_primary_slots=600)


SNAPSHOT_COMPLETE = frozenset({'created', 'complete', 'completed', 'ready'})
SNAPSHOT_RETENTION_MARGIN_S = 600


class WarmSnapshotStale(ValueError):
    """The producer-proven snapshot is gone, incomplete, unpublished or expiring: a refresh fixes it."""


def warm_refresh_command(runner, ref):
    """The exact normal producer invocation for this run's donor and ref."""
    return ('CLOUDBENCH_WARM_MACHINE_NAME=%s CLOUDBENCH_WARM_VOLUME_NAME=%s CLOUDBENCH_REGION=%s '
            'CLOUDBENCH_SKIP_LOCAL_PATCH=1 bash scripts/run-bench-cloud --refresh-deps --ref %s'
            % (runner['WARM_MACHINE_NAME'], runner['WARM_VOLUME_NAME'], runner['WARM_REGION'], ref))


def warm_snapshot_preflight(fly, token, runner, warm_deps_raw, inventory_raw, protected_machines, deadline_epoch,
                            refresh=None):
    """Read-only: the snapshot the producer proof names must exist, be complete, remain the
    donor's recorded dependency proof and outlive the run deadline. Two GETs. With
    inventory_raw None the donor listing itself becomes the run's snapshot inventory."""
    import datetime
    machine_id, app = runner['WARM_MACHINE_ID'], runner['APP']
    refresh = refresh or ('refresh the donor through `scripts/run-bench-cloud --refresh-deps` and rebind '
                          'new --warm-deps/--snapshot-inventory inputs')
    try:
        proof = runner['warm_deps_proof'](warm_deps_raw)
    except ValueError:
        raise ValueError('--warm-deps is not one producer dependency proof line') from None
    fields = [proof['node'], proof['python'], str(proof['epoch']), proof['snapshot']]
    pin = proof['snapshot']
    if inventory_raw is not None:
        rows = json.loads(inventory_raw)
        rows = [r for r in rows if isinstance(r, dict) and r.get('id') == pin] if isinstance(rows, list) else []
        if len(rows) != 1 or str(rows[0].get('status') or '').lower() not in SNAPSHOT_COMPLETE or int(rows[0].get('size') or 0) <= 0:
            raise ValueError(f'--snapshot-inventory does not contain one complete row for the proven {pin}')
    if machine_id not in protected_machines:
        raise ValueError('the warm donor must remain a protected Machine')
    api = fly(app, token)
    machine = api.machine(machine_id)
    mounts = (machine.get('config') or {}).get('mounts') or []
    if machine.get('name') != runner['WARM_MACHINE_NAME'] or len(mounts) != 1 or not mounts[0].get('volume'):
        raise ValueError('warm donor identity or volume changed')
    volume_id = mounts[0]['volume']
    if not re.fullmatch('vol_[A-Za-z0-9]+', volume_id):
        raise ValueError('warm donor volume identity is invalid')
    metadata = (machine.get('config') or {}).get('metadata') or {}
    recorded = [value.split() for value in metadata.values() if isinstance(value, str)]
    recorded = [value for value in recorded if len(value) == 7 and value[:2] == fields[:2] and value[4:] == [volume_id, machine_id, app]]
    if [fields[2], pin] not in [value[2:4] for value in recorded]:
        named = sorted({value[3] for value in recorded}) or ['none']
        raise WarmSnapshotStale(f'donor dependency proof names {", ".join(named)}, not the proven {pin}; {refresh}')
    snapshots = api.api('GET', f'/volumes/{volume_id}/snapshots', timeout=20)
    match = [s for s in snapshots if isinstance(s, dict) and s.get('id') == pin] if isinstance(snapshots, list) else None
    if match is None:
        raise ValueError('donor volume snapshot listing is not a list')
    if len(match) != 1:
        raise WarmSnapshotStale(f'proven warm snapshot {pin} no longer exists on donor volume {volume_id} '
                                f'(retention expired or deleted); {refresh}')
    snapshot = match[0]
    if str(snapshot.get('status') or '').lower() not in SNAPSHOT_COMPLETE or int(snapshot.get('size') or 0) <= 0:
        raise WarmSnapshotStale(f'proven warm snapshot {pin} is not complete (status {snapshot.get("status")!r}); {refresh}')
    created = datetime.datetime.fromisoformat(str(snapshot.get('created_at') or '').replace('Z', '+00:00')).timestamp()
    if created < int(fields[2]) - 60:
        raise ValueError(f'proven warm snapshot {pin} predates its dependency proof')
    retention = snapshot.get('retention_days')
    if type(retention) is not int or retention <= 0:
        raise ValueError(f'proven warm snapshot {pin} has no measured retention')
    expires = created + retention * 86400
    if expires < deadline_epoch + SNAPSHOT_RETENTION_MARGIN_S:
        stamp = lambda value: datetime.datetime.fromtimestamp(value, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        raise WarmSnapshotStale(f'proven warm snapshot {pin} expires {stamp(expires)}, before the run deadline '
                                f'{stamp(deadline_epoch)} plus {SNAPSHOT_RETENTION_MARGIN_S}s; {refresh}')
    result = dict(snapshot_id=pin, volume_id=volume_id, created_at=snapshot['created_at'], retention_days=retention,
                  expires_epoch=expires, retention_after_deadline_s=int(expires - deadline_epoch), provider_calls=2)
    if inventory_raw is None:
        # The read-only donor listing just read is the run's authentic snapshot inventory.
        result['inventory'] = snapshots
        result['donor_machine'] = machine
    return result


# ── Input discovery: launch facts, warm proof and snapshot inventory ─────────
# The routed CLI (scripts/run-bench) supplies no private inputs: facts come
# from read-only native inventory at admission, the warm proof from the
# producer's git-common file, and the snapshot inventory from the donor listing.
# Disposable benchmark resources: task/worker clones and controller gates are
# owned by exact run tokens. Every other bench-app Machine (warm donors,
# retained controllers, WHM deploys) and its Volumes form the protected cohort.
DISPOSABLE_MACHINE_NAME = re.compile(r'cloudbench-(?:[0-9a-f]{16,40}|gate-[A-Za-z0-9_.-]+)')
PROTECTED_METADATA_PREFIXES = ('whm_deploy', 'rose_controller', 'cloudbench_protected', 'polar')


def git_common_dir(root):
    return Path(subprocess.check_output(['git', '-C', str(root), 'rev-parse', '--path-format=absolute',
                                         '--git-common-dir'], text=True, timeout=10).strip())


def committed_dependency_fingerprints(root, ref):
    """The producer's node/python fingerprints of the committed manifests at ref (sparse-checkout safe)."""
    import tempfile
    env_lib = root / 'scripts/lib/cloudbench-env.sh'
    listing = subprocess.run(['bash', '-c', 'source "$1"; printf "%s\\n" "${CLOUDBENCH_PYTHON_MANIFESTS[@]}"', 'manifests',
                              str(env_lib)], capture_output=True, text=True, timeout=30, check=True).stdout.split()
    members = ['package.json', 'back-end/package.json', 'back-end/package-lock.json', 'front-end/package.json', *listing]
    with tempfile.TemporaryDirectory(prefix='warm-fingerprint-') as scratch:
        for member in members:
            target = Path(scratch, member)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), 'show',
                                                        ref + ':' + member], timeout=30))
        result = subprocess.run(['bash', '-c', 'source "$1"; cloudbench_node_dependency_fingerprint "$2" && '
                                 'cloudbench_manifest_fingerprint "$2" "${CLOUDBENCH_PYTHON_MANIFESTS[@]}"',
                                 'fingerprints', str(env_lib), scratch], capture_output=True, text=True, timeout=60)
    values = result.stdout.split()
    if result.returncode or len(values) != 2 or not all(re.fullmatch('[0-9a-f]{64}', v) for v in values):
        raise ValueError('could not compute the producer dependency fingerprints at ' + ref + ': '
                         + result.stderr.strip()[-300:])
    return dict(node=values[0], python=values[1])


def warm_proof_paths(root, runner):
    common = git_common_dir(root)
    proof = common / ('cloudbench-warm-deps.' + runner['WARM_MACHINE_NAME'] + '.fp')
    return proof, proof.with_name(proof.name + '.ref')


def read_small(path, limit=4096):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_size > limit:
            raise ValueError('producer proof must be a small regular file owned by this operator: ' + str(path))
        return stream.read(limit + 1)


def warm_decision(root, runner, ref, fingerprints=None):
    """Local, no provider call: reuse the producer proof only when it was produced for this
    exact ref with this checkout's dependency fingerprints; otherwise refresh."""
    proof_path, ref_path = warm_proof_paths(root, runner)
    current = fingerprints or committed_dependency_fingerprints(root, ref)
    reasons, proof, raw = [], None, None
    try:
        raw = read_small(proof_path)
        proof = runner['warm_deps_proof'](raw)
    except FileNotFoundError:
        reasons.append('no producer dependency proof at ' + str(proof_path))
    except ValueError as error:
        reasons.append(str(error))
    if proof is not None:
        if (proof['node'], proof['python']) != (current['node'], current['python']):
            reasons.append('producer proof dependency fingerprints differ from the checkout at ' + ref)
        try:
            produced = read_small(ref_path).decode('ascii', 'replace').split()
        except FileNotFoundError:
            produced = None
        if produced is None:
            reasons.append('producer proof records no source ref (' + str(ref_path) + ' absent)')
        elif len(produced) != 2 or not re.fullmatch('[0-9a-f]{40}', produced[0]):
            reasons.append('producer ref receipt is malformed')
        elif produced[1] != proof['snapshot']:
            reasons.append('producer ref receipt names snapshot ' + produced[1] + ', not the proven ' + proof['snapshot'])
        elif produced[0] != ref:
            reasons.append('producer proof was produced for ' + produced[0] + ', not the run ref ' + ref)
    return dict(action='refresh' if reasons else 'reuse', reasons=reasons, proof_path=str(proof_path),
                proof_raw=raw, snapshot_id=proof and proof['snapshot'], fingerprints=current,
                refresh_command=warm_refresh_command(runner, ref))


def pushed_task_ref(root, ref, github):
    """The guest fetches only pushed commits: origin/main ancestry or a live origin branch/tag tip."""
    result = subprocess.run(['bash', '-c', 'source "$1"; cloudbench_fetchable_ref "$2" "$3" 0', 'pushed-ref',
                             str(root / 'scripts/lib/cloudbench-env.sh'), str(root), ref],
                            capture_output=True, text=True, timeout=60, env=dict(os.environ, GITHUB_TOKEN=github))
    if result.returncode or result.stdout.strip() != ref:
        raise ValueError('task ref ' + ref + ' is not a pushed commit on origin; push it first')
    return ref


def run_warm_refresh(root, runner, ref, log_path, timeout=2400):
    """Run the normal producer once (it takes the app environment lock and parks the donor)."""
    env = dict(os.environ, CLOUDBENCH_WARM_MACHINE_NAME=runner['WARM_MACHINE_NAME'],
               CLOUDBENCH_WARM_VOLUME_NAME=runner['WARM_VOLUME_NAME'], CLOUDBENCH_REGION=runner['WARM_REGION'],
               CLOUDBENCH_SKIP_LOCAL_PATCH='1')
    with open(log_path, 'xb') as log:
        child = subprocess.Popen(['bash', str(root / 'scripts/run-bench-cloud'), '--refresh-deps', '--ref', ref],
                                 cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            code = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            child.terminate()  # its own traps park the donor and release the lock
            code = child.wait(timeout=300)
            raise ValueError('warm dependency refresh exceeded %ds (see %s)' % (timeout, log_path))
    if code:
        raise ValueError('warm dependency refresh failed with exit %d (see %s)' % (code, log_path))


DONOR_IMAGE = re.compile(r'registry\.fly\.io/navi-whisper-lux-bench[^@\s]*@sha256:[0-9a-f]{64}')


def derived_facts(machines, donor, runner):
    """Launch facts from one native inventory: the donor's active immutable image and the protected cohort."""
    if not isinstance(machines, list) or any(not isinstance(m, dict) or not isinstance(m.get('id'), str) for m in machines):
        raise ValueError('complete native Machine inventory required for launch facts')
    if len({m['id'] for m in machines}) != len(machines):
        raise ValueError('duplicate native Machine identity')
    image = ((donor.get('config') or {}).get('image')) if isinstance(donor, dict) else None
    if not isinstance(image, str) or not DONOR_IMAGE.fullmatch(image):
        raise ValueError('warm donor has no digest-pinned benchmark image; run scripts/run-bench image-activate')
    protected, volumes = [], []
    for machine in machines:
        metadata = (machine.get('config') or {}).get('metadata') or {}
        marked = any(str(key).startswith(PROTECTED_METADATA_PREFIXES) for key in metadata)
        if DISPOSABLE_MACHINE_NAME.fullmatch(str(machine.get('name') or '')) and not marked:
            continue
        protected.append(machine['id'])
        for mount in (machine.get('config') or {}).get('mounts') or []:
            if isinstance(mount, dict) and isinstance(mount.get('volume'), str):
                volumes.append(mount['volume'])
    if runner['WARM_MACHINE_ID'] not in protected:
        raise ValueError('warm donor is absent from the native inventory')
    return dict(app=runner['APP'], image_ref=image, protected_machines=sorted(protected),
                protected_volumes=sorted(set(volumes)),
                discovered=dict(schema='original600-discovered-launch-facts-v1', observed_epoch=time.time(),
                                rule='bench-app Machines other than disposable cloudbench-<hex>/cloudbench-gate-* '
                                     'resources, plus any carrying protected metadata, and their mounted Volumes',
                                donor_machine=runner['WARM_MACHINE_ID'], native_machines=len(machines)))


def counted_fly(fly):
    """Count every native read issued through a Fly client factory, including failed preflights."""
    class Counted:
        calls = 0

        def __call__(self, app, token):
            api, outer = fly(app, token), self

            class Reads:
                def machine(self, machine_id):
                    outer.calls += 1
                    return api.machine(machine_id)

                def api(self, *args, **kwargs):
                    outer.calls += 1
                    return api.api(*args, **kwargs)
            return Reads()
    return Counted()


def discover_inputs(args, root, runner, token, run, fly=None):
    """Resolve facts, warm proof and snapshot inventory without private hand-made files.

    --check (run False) only reads and reports the reuse/refresh decision; --run refreshes
    through the normal producer when needed, then writes the discovered inputs privately."""
    fly = counted_fly(fly or runpy.run_path(str(root / 'scripts/cloudbench-original-volume-capture.py'))['Fly'])
    ref = bound_task_ref(args, runner)
    decision = warm_decision(root, runner, ref)
    report = dict(action=decision['action'], reasons=list(decision['reasons']), proof=decision['proof_path'],
                  refresh_command=decision['refresh_command'], fingerprints=decision['fingerprints'])
    def native():
        with runner['bounded'](110):
            machines = fly(runner['APP'], token).api('GET', '/machines', timeout=60)
        donor = next((m for m in machines if isinstance(m, dict) and m.get('id') == runner['WARM_MACHINE_ID']), None) \
            if isinstance(machines, list) else None
        return derived_facts(machines, donor, runner)

    def preflight(facts):
        warm = warm_snapshot_preflight(fly, token, runner, decision['proof_raw'], None,
                                       facts['protected_machines'], time.time() + 5400,
                                       refresh=decision['refresh_command'])
        warm.pop('provider_calls')
        return warm

    facts = native()
    warm = None
    if decision['action'] == 'reuse':
        try:
            warm = preflight(facts)
        except WarmSnapshotStale as error:
            decision['action'] = report['action'] = 'refresh'
            report['reasons'].append(str(error))
    if decision['action'] == 'refresh' and not run:
        return dict(report, provider_calls=fly.calls, facts=dict(image_ref=facts['image_ref'],
                    protected_machines=len(facts['protected_machines']),
                    protected_volumes=len(facts['protected_volumes']))), None
    parent = args.state_dir.absolute()
    directory = parent / ('inputs-' + str(time.time_ns()))
    if run:
        if parent.resolve(strict=True) != parent or parent.stat().st_uid != os.geteuid() or parent.stat().st_mode & 0o077:
            raise ValueError('private physical current-owner state directory required')
        directory.mkdir(mode=0o700)
    if decision['action'] == 'refresh':
        print(json.dumps(dict(status='WARM_SNAPSHOT_REFRESH', ref=ref, reasons=report['reasons'],
                              log=str(directory / 'warm-refresh.private.log'))), flush=True)
        run_warm_refresh(root, runner, ref, directory / 'warm-refresh.private.log')
        decision = warm_decision(root, runner, ref, decision['fingerprints'])
        if decision['action'] != 'reuse':
            raise ValueError('the producer did not prove a snapshot for ' + ref + ': ' + '; '.join(decision['reasons']))
        facts = native()
        warm = preflight(facts)  # a fresh snapshot that still fails is a hard error, not another refresh
        report.update(refreshed=True, refreshed_snapshot=warm['snapshot_id'])
    inventory, donor = warm.pop('inventory'), warm.pop('donor_machine')
    if (donor.get('config') or {}).get('image') != facts['image_ref']:
        raise ValueError('warm donor image changed between native reads')
    report.update(provider_calls=fly.calls, warm_snapshot=warm, facts=dict(image_ref=facts['image_ref'],
                  protected_machines=len(facts['protected_machines']), protected_volumes=len(facts['protected_volumes'])))
    if not run:
        return report, None
    paths = {}
    for name, value in (('facts', facts), ('snapshot_inventory', inventory)):
        paths[name] = directory / (name.replace('_', '-') + '.private.json')
        runner['save'](paths[name], value)
    paths['warm_deps'] = directory / 'warm-deps.private.fp'
    with os.fdopen(os.open(paths['warm_deps'], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stream:
        stream.write(decision['proof_raw']); stream.flush(); os.fsync(stream.fileno())
    runner['save'](directory / 'discovery.json', dict(report, inputs={k: str(v) for k, v in paths.items()}))
    return report, paths


def admission_remaining(deadline):
    remaining = deadline - time.time()
    if not 0 < remaining <= 5400:
        raise ValueError("original admission clock expired")
    return remaining


def capacity(
    api,
    token,
    org,
    directory,
    extra,
    reuse_runs=None,
    harness_ref=None,
    excluded=(),
    image_ref=None,
    unused_runs=(),
    parked_runs=(),
    expired_runs=(),
    *,
    deadline=None,
):
    deadline = time.time() + 5400 if deadline is None else deadline
    runner = runpy.run_path(
        str(Path(__file__).with_name("cloudbench-original600-runner.py"))
    )
    with runner["bounded"](min(110, admission_remaining(deadline))):
        proof = capacity_snapshot(api, token, org, directory, extra)
    with runner["bounded"](admission_remaining(deadline)):
        return capacity_from_snapshot(
            proof,
            directory,
            reuse_runs,
            harness_ref,
            excluded,
            image_ref,
            unused_runs,
            parked_runs,
            expired_runs,
        )


def capacity_from_snapshot(proof, directory, reuse_runs, harness_ref, excluded,
                           image_ref, unused_runs, parked_runs, expired_runs):
    if reuse_runs:
        helper=reuse_module()
        import secrets
        inventory_path=directory/'navi-whisper-lux-bench.private.json'
        reuse=helper['prepare_request'](reuse_runs,inventory_path,secrets.token_hex(16),harness_ref,excluded,unused_runs,parked_runs,expired_runs)
        if image_ref is not None:
            reuse['image_ref']=image_ref
        helper['validate_request'](reuse,harness_ref)
        inventory=json.loads(read_inventory(inventory_path))
        if image_ref is not None:
            verify_reuse_images(reuse,inventory,image_ref)
        eligible=helper['capacity_demand'](reuse,inventory,set())['qualified_reuse_count']
        # Eligibility is a planning result, never a native reservation or quota credit.
        proof.update(eligible_reuse_count=eligible, qualified_reuse_count=0,
                     new_machine_demand=601, qualified_ids=[], admission='ELIGIBLE_NOT_RESERVED')
        if proof['available_slots_conservative'] + eligible < 601:
            raise ValueError('insufficient capacity even if every eligible archived identity is reserved')
        save = runpy.run_path(str(Path(__file__).with_name('cloudbench-original600-runner.py')))['save']
        save(directory/'archived-reuse-request.private.json',reuse)
        save(directory/'capacity-before-reservation.private.json',proof)
        return proof
    proof.update(qualified_reuse_count=0,new_machine_demand=601,qualified_ids=[])
    if proof['available_slots_conservative'] < 601:
        raise ValueError('insufficient measured capacity for original601 new Machines')
    runpy.run_path(str(Path(__file__).with_name('cloudbench-original600-runner.py')))['save'](directory/'capacity-proof.private.json',proof)
    return proof


def admission_binding(args, runner):
    names=('facts','agents_env','backend_env','tasks','snapshot_inventory','warm_deps')
    binding = dict(source_ref=args.source_ref, org=args.org, extra=args.extra_destroying_count,
                inputs={name:dict(path=str(getattr(args,name)),sha256=digest(runner['read'](getattr(args,name)))) for name in names},
                archive_runs=[str(path.absolute()) for path in (args.archive_run or [])],
                excluded_machines=sorted(set(args.reuse_exclude_machine)))
    policy = getattr(args, 'infra_early_stop', 'enabled')
    if policy not in ('enabled', 'disabled'):
        raise ValueError('invalid infrastructure early-stop policy')
    if policy != 'enabled':
        binding['infra_early_stop'] = policy
    unused = getattr(args, 'unused_reservation_run', ())
    if unused:
        binding['unused_reservation_runs'] = [str(path.absolute()) for path in unused]
    parked = getattr(args, 'parked_reservation_run', ())
    if parked:
        binding['parked_reservation_runs'] = [str(path.absolute()) for path in parked]
    expired = getattr(args, 'expired_reservation_run', [])
    if expired:
        binding['expired_reservation_runs'] = [str(path.absolute()) for path in expired]
    return binding


def open_admission(parent, resume, binding, runner, has_archives):
    if resume:
        directory=resume.absolute()
        if directory.parent != parent or directory.resolve(strict=True) != directory or directory.stat().st_uid != os.geteuid() or directory.stat().st_mode & 0o077:
            raise ValueError('resume must select an existing private admission below state-dir')
        original=json.loads(runner['read'](directory/'admission-intent.private.json'))
        if original['binding'] != binding or not has_archives:
            raise ValueError('resume source/inputs/archives differ from the original admission')
        if (directory/'controller-launch.intent.json').exists() or (directory/'config.private.json').exists():
            raise ValueError('admission already bound; use --status and its existing controller owner')
        return directory,original['started_at_epoch']
    directory=parent/('original600-'+str(time.time_ns()))
    directory.mkdir(mode=0o700)
    started_at=time.time()
    runner['save'](directory/'admission-intent.private.json',dict(binding=binding,started_at_epoch=started_at,deadline_epoch=started_at+5400))
    return directory,started_at


def seal_expired_handoffs(request, directory, runner):
    """Give each expired admission exactly one new successor cohort."""
    for archive in request['archives']:
        old=archive.get('expired_admission')
        if old is None:
            continue
        root=Path(old['directory'])
        if root.resolve(strict=True)!=root or root.stat().st_uid!=os.geteuid() or root.stat().st_mode&0o077:
            raise ValueError('private expired admission required')
        validator=runpy.run_path(str(Path(__file__).with_name('cloudbench-reconcile-reservations.py')))
        validator['validate_handoff'](archive)
        if ((root/'controller-launch.intent.json').exists() or (root/'config.private.json').exists()
                or any(root.glob('launch-*'))):
            raise ValueError('expired admission acquired a controller')
        seal={'schema':'original600-expired-admission-handoff-v1','original_closure_sha256':archive['archive_sha256'],
              'new_admission_directory':str(directory),'new_cohort':request['cohort'],
              'new_request_sha256':digest(json.dumps(request,sort_keys=True,allow_nan=False).encode())}
        path=root/'expired-reservation-handoff.json'
        try:runner['save'](path,seal)
        except FileExistsError:pass
        if json.loads(runner['read'](path))!=seal:
            raise ValueError('expired admission already assigned to another successor')


def reservation_disk_headroom(directory, request, inventory, snapshot_directory):
    """Budget retained wire copies, observation and fresh inventories before effects."""
    fs=os.statvfs(directory)
    block=fs.f_frsize or fs.f_bsize
    def allocated(size):
        return ((size+block-1)//block)*block
    machines={row['id']:row for row in inventory}
    selected=sum(allocated(len(json.dumps(machines[row['machine_id']],sort_keys=True).encode()))
                 for row in request['candidates'])
    rows=sum(allocated(len(json.dumps(row,sort_keys=True).encode())) for row in request['candidates'])
    snapshot=sum(allocated(path.stat().st_size) for path in snapshot_directory.glob('*.private.json'))
    request_bytes=allocated(len(json.dumps(request,sort_keys=True).encode()))
    # Native, update, raw-base64 and decoded copies plus one leased observation;
    # 64 small journal files/directories per candidate cover both bounded paths.
    required=14*selected+4*rows+2*snapshot+4*request_bytes+64*block*len(request['candidates'])
    inodes=64*len(request['candidates'])+128
    if fs.f_bavail*block < required or (fs.f_files and fs.f_favail < inodes):
        raise ValueError('insufficient local disk headroom for retained reservation evidence')
    return {'required_bytes':required,'available_bytes':fs.f_bavail*block,
            'required_inodes':inodes,'available_inodes':fs.f_favail}


def reserve_reuse_capacity(api, token, args, runner, directory, snapshot_directory, cap, started_at=None):
    """Reserve existing identities before crediting them; retain journals across resume."""
    helper=reuse_module()
    request_path=directory/'archived-reuse-original.private.json'
    if not request_path.exists():
        request=json.loads(runner['read'](snapshot_directory/'archived-reuse-request.private.json'))
        request['task_names']=json.loads(runner['read'](args.tasks))
        request['image_ref']=facts_from(runner['read'](args.facts))['image_ref']
        runner['campaign_argv'](request['task_names'],time.time())
        runner['save'](request_path,dict(schema='original600-archived-admission-request-v1',request=request,
                                       sha256=digest(json.dumps(request,sort_keys=True,allow_nan=False).encode())))
    saved=json.loads(runner['read'](request_path))
    request=saved['request']
    if saved.get('schema') != 'original600-archived-admission-request-v1' or digest(json.dumps(request,sort_keys=True,allow_nan=False).encode()) != saved['sha256']:
        raise ValueError('original archived reuse request bytes changed')
    if request.get('image_ref') != facts_from(runner['read'](args.facts))['image_ref']:
        raise ValueError('reserved image differs from the admitted immutable image')
    initial_inventory=json.loads(read_inventory(snapshot_directory/'navi-whisper-lux-bench.private.json'))
    verify_reuse_images(request,initial_inventory,request['image_ref'])
    helper['validate_request'](request,args.source_ref)
    if request.get('task_names') != json.loads(runner['read'](args.tasks)):
        raise ValueError('reserved task manifest differs from original ordered200')
    if cap['available_slots_conservative'] + len(request['candidates']) < 601:
        raise ValueError('insufficient measured capacity even with every reserved candidate')
    reservation_disk_headroom(directory,request,initial_inventory,snapshot_directory)
    seal_expired_handoffs(request,directory,runner)
    # NativeAdapter owns finite per-operation deadlines and joins all reservations.
    connection=api('navi-whisper-lux-bench',token)
    def adapter(journal):
        return helper['NativeAdapter'](connection,journal/'wire')
    with joined_admission_signals():
        reserved=helper['reserve_cohort'](adapter,request,directory/'archived-reuse-reservations')
        if reserved.get('held_native_reservations'):
            if started_at is None:
                raise ValueError('original admission epoch required for held readback')
            observer=runpy.run_path(str(Path(__file__).with_name('cloudbench-reconcile-reservations.py')))
            reserved=observer['observe_acknowledged_holds'](adapter,request,reserved,
                directory/'archived-reuse-reservations'/'acknowledged-holds-observation',started_at+5400)
    refreshed=directory/('capacity-after-reservation-'+str(time.time_ns()))
    refreshed.mkdir(mode=0o700)
    with runner['bounded'](110):
        final=capacity_snapshot(api,token,args.org,refreshed,args.extra_destroying_count)
    inventory=json.loads(read_inventory(refreshed/'navi-whisper-lux-bench.private.json'))
    facts=facts_from(runner['read'](args.facts))
    inventory=observe_reuse_configs(adapter,reserved,inventory,refreshed/'selected-full-config-observation',runner,(started_at or 0)+5400,proof=final)
    verify_reuse_images(reserved,inventory,facts['image_ref'])
    demand=helper['capacity_demand'](reserved,inventory,set(facts['protected_machines']),require_reserved=True)
    final.update(demand,admission='RESERVED_NATIVE_READBACK',reservation_mutations_separate=True)
    if final['available_slots_conservative'] < final['new_machine_demand']:
        raise ValueError('fresh capacity after reserved native readback is insufficient')
    request_output=directory/'archived-reuse-request.private.json'
    if request_output.exists():
        if json.loads(runner['read'](request_output)) != reserved:
            raise ValueError('the previously reserved request changed')
    else:
        runner['save'](request_output,reserved)
    final['reservation_request_sha256']=digest(runner['read'](request_output))
    proof_path=refreshed/'capacity-proof.private.json'
    runner['save'](proof_path,final)
    return dict(final,proof_path=str(proof_path))


def prepare(args, root, pins, runner, directory, cap, started_at=None, host_operator_provenance=None,
            shard=None, runtime_env=None, sibling_controller_slots=0, scheduled_total=600, guest_env=None):
    policy = getattr(args, 'infra_early_stop', 'enabled')
    if policy not in ('enabled', 'disabled'):
        raise ValueError('invalid infrastructure early-stop policy')
    if not 0 <= time.time() - cap['ended_epoch'] < 270 or cap['available_slots_conservative'] < cap.get('new_machine_demand',601):
        raise ValueError('capacity proof expired or insufficient')
    read, save = runner['read'], runner['save']
    facts = facts_from(read(args.facts))
    tasks = json.loads(read(args.tasks))
    stamp = time.time() if started_at is None else started_at
    if not 0 <= time.time()-stamp < 5400:
        raise ValueError('original campaign clock expired during admission')
    runner['campaign_argv'](tasks, stamp, shard)  # Exact bound task-name hash and all campaign arguments.
    auth = dict(schema='cloudbench-disposable-controller-authority-v1', allowed=True, single_host=True,
                app=facts['app'], region='iad', vm_size='performance-8x', memory_mib=32768,
                workspace_size_gb=256, org_machine_limit=cap['machine_limit'],
                org_object_count=cap['total_active_inventory_objects'] + cap['conservative_extra_destroying_bench_objects'],
                verified_epoch=cap['ended_epoch'], capacity_proof=dict(path=cap.get('proof_path',str(directory/'capacity-proof.private.json')), sha256=digest(read(cap.get('proof_path',directory/'capacity-proof.private.json')))),
                protected_machines=facts['protected_machines'], protected_volumes=facts['protected_volumes'],
                source_ref=args.source_ref, output_directory=str(directory/'run/export'), env_files={})
    if sibling_controller_slots:
        auth['sibling_controller_slots'] = sibling_controller_slots
    if len(auth['protected_machines']) < 4 or not isinstance(auth['protected_volumes'], list):
        raise ValueError('explicit protected resource cohort required')
    for key, path in [('agents', args.agents_env), ('backend', args.backend_env)]:
        auth['env_files'][key] = dict(path=str(path), sha256=digest(read(path)))
    # The controller keeps the selected env bytes above; guests get the bench
    # app secrets. Bind the guest namespace those secrets must carry.
    if guest_env is None:
        guest_env = guest_temporal_env(root, args.agents_env, args.backend_env)
    guest_namespace_env = ({'CLOUDBENCH_EXPECTED_GUEST_TEMPORAL_NAMESPACE': guest_env['temporal_namespace']}
                           if guest_env['temporal_namespace'] else {})
    save(directory/'authority-template.private.json', auth)
    files = []
    for path, relative in [(args.snapshot_inventory, runner['WARM_INVENTORY_RELATIVE']),
                           (args.warm_deps, runner['WARM_DEPS_RELATIVE'])]:
        files.append(dict(source_path=str(path), relative_path=relative, sha256=digest(read(path))))
    reuse_env = {}
    if cap.get('qualified_reuse_count'):
        reuse_path=directory/'archived-reuse-request.private.json';reuse_raw=read(reuse_path);reuse_sha=digest(reuse_raw)
        relative='.git/cloudbench-archived-reuse-'+str(json.loads(reuse_raw)['cohort'])+'.json'
        files.append(dict(source_path=str(reuse_path),relative_path=relative,sha256=reuse_sha))
        reuse_env=dict(CLOUDBENCH_ARCHIVED_REUSE_REQUEST='/tmp/gate/repo/'+relative,CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256=reuse_sha)
        if 'cloudbench-reuse-index.py' in pins:
            indexer=runpy.run_path(str(root/'scripts/cloudbench-reuse-index.py'))
            index_raw=indexer['build'](reuse_raw,reuse_sha,args.source_ref,reuse_module()['validate_request'])
            index_path=directory/'archived-reuse-index.private.json'
            fd=os.open(index_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb') as stream:
                stream.write(index_raw);stream.flush();os.fsync(stream.fileno())
            fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(fd)
            finally:os.close(fd)
            index_relative=relative.removesuffix('.json')+'.index.json'
            files.append({'source_path':str(index_path),'relative_path':index_relative,'sha256':digest(index_raw)})
            reuse_env.update(CLOUDBENCH_ARCHIVED_REUSE_INDEX='/tmp/gate/repo/'+index_relative,
                             CLOUDBENCH_ARCHIVED_REUSE_INDEX_SHA256=digest(index_raw))
    config = dict(schema='original600-controller-runner-v1', allowed=True, source_root=str(root),
                  source_ref=args.source_ref, source_files=pins, tasks_path=str(args.tasks),
                  started_at_epoch=stamp, authority_template=str(directory/'authority-template.private.json'),
                  remote_files=files, remote_env=dict(CLOUDBENCH_CLONE_MAX_ATTEMPTS='5', PYTHONDONTWRITEBYTECODE='1', **reuse_env, **(runtime_env or {}),
                                  **guest_namespace_env),
                  gate_env=dict(CLOUDBENCH_APP=facts['app'], CLOUDBENCH_REGION='iad', WARM_IMAGE_REF=facts['image_ref'],
                                CLOUDBENCH_GATE_TIMEOUT_S='7200', PYTHONDONTWRITEBYTECODE='1'))
    if host_operator_provenance is not None:
        config['host_operator_provenance']=host_operator_provenance
    if guest_env['override']:
        config['guest_env'] = guest_env
    if policy != 'enabled':
        config['infra_early_stop'] = policy
    if shard is not None:
        config['shard'] = shard
    save(directory/'config.private.json', config)
    start_guest = dict(guest_temporal_namespace=guest_env['temporal_namespace']) if guest_env['override'] else {}
    save(directory/'attempt-start.safe.json', dict(scope='original200x3REAL' if shard is None else 'original600-shard',
         scheduled_total=scheduled_total if shard is None else len(shard['tasks']) * shard['runs'],
         source_ref=args.source_ref, task_ref=shard_task_ref(runner, shard), started_at_epoch=stamp,
         original_deadline_epoch=stamp+5400, config_sha256=digest(read(directory/'config.private.json')),
         status='BOUND_NOT_LAUNCHED', **start_guest))
    return directory/'config.private.json'



def selected_task_count(args, manifest):
    count = len(manifest) if args.task_count is None else args.task_count
    if not 1 <= count <= len(manifest) or not 1 <= args.repetitions <= 10:
        raise ValueError('--task-count must select 1..%d manifest tasks and --repetitions 1..10' % len(manifest))
    return count


def simultaneous_copies(args, runner):
    """Global simultaneous benches: every copy of every selected task, across all shards."""
    return selected_task_count(args, json.loads(runner['read'](args.tasks))) * args.repetitions


def bound_timeouts(args, runner):
    """The run's (--task-timeout, --e2e-timeout), within the runner's operator deadline."""
    return runner['campaign_timeouts'](getattr(args, 'task_timeout', runner['DEFAULT_TASK_TIMEOUT']),
                                       getattr(args, 'e2e_timeout', runner['RUN_DEADLINE']))


def original_manifest(manifest, runner):
    return (isinstance(manifest, list) and all(isinstance(t, str) for t in manifest)
            and runner['manifest_sha'](manifest) == runner['TASK_NAMES_SHA'])


def shard_task_ref(runner, shard):
    return runner['TASK_REF'] if shard is None else runner['shard_task_ref'](shard)


def bound_task_ref(args, runner):
    """The guest task source: the requested pushed --task-ref, or the historical pin when omitted."""
    return getattr(args, 'task_ref', None) or runner['TASK_REF']


def shard_bindings(args, runner):
    """Bound shard fields beyond the original600 defaults; empty for the original manifest and timeouts."""
    manifest = json.loads(runner['read'](args.tasks))
    task_timeout, e2e_timeout = bound_timeouts(args, runner)
    extra = {} if original_manifest(manifest, runner) else dict(manifest_sha256=runner['manifest_sha'](manifest))
    if bound_task_ref(args, runner) != runner['TASK_REF']:
        extra['task_ref'] = bound_task_ref(args, runner)
    if task_timeout != runner['DEFAULT_TASK_TIMEOUT']:
        extra['task_timeout'] = task_timeout
    if e2e_timeout != runner['RUN_DEADLINE']:
        extra['e2e_timeout'] = e2e_timeout
    return extra


def bound_shard(item, args, runner, group_id, group_total, started_at):
    """One shard's exact launch object: its tasks, global indexes, shared group and bound manifest/timeouts."""
    return dict(item, tasks_sha256=digest(('\n'.join(item['tasks']) + '\n').encode()), group_run_id=group_id,
                group_total=group_total, group_started_at=started_at, **shard_bindings(args, runner))


# LIVE acceptance (original600/polar70/live-query proofs, the operator default)
# requires >=3 correlated live LLM calls per task, so it refuses zero-spend and
# DEMO-replay tasks. An ordinary user-requested wide run (run-bench's sharded
# route) admits every task the ordinary fleet runs: ready and cloud-root runnable.
CATALOG_ELIGIBILITY = {'live': 3, 'ordinary': 0}


def catalog_ineligible_reason(root, runner, tasks, backend_env, task_ref=None, eligibility='live'):
    """None when every name is ready, Linux/cloud-root (and, for LIVE, live-query) eligible at the task ref."""
    import tempfile
    members = ('agents/benchmarks/tasks.json', 'agents/benchmarks/polar_tasks.json',
               'agents/providers/demo_cache/normalize.py', 'agents/utils/__init__.py',
               'agents/utils/oai_demo.py', 'agents/utils/oai_demo_july.py')
    with tempfile.TemporaryDirectory(prefix='manifest-catalog-') as scratch:
        ref = task_ref or runner['TASK_REF']
        for member in members:
            target = Path(scratch, member)
            target.parent.mkdir(parents=True, exist_ok=True)
            # Task refs older than the DEMO-cache rename keep the same module at its legacy path.
            sources = [member] + (['agents/providers/fast_cache/normalize.py']
                                  if member == 'agents/providers/demo_cache/normalize.py' else [])
            for index, source in enumerate(sources):
                try:
                    target.write_bytes(subprocess.check_output(
                        ['git', '--no-replace-objects', '-C', str(root), 'show', ref + ':' + source],
                        stderr=subprocess.DEVNULL if index < len(sources) - 1 else None))
                    break
                except subprocess.CalledProcessError:
                    if index == len(sources) - 1:
                        raise
        # Phone-callee assignments come from the selected backend env, as the benchmark reads them.
        Path(scratch, 'back-end').mkdir()
        Path(scratch, 'back-end/.env').symlink_to(Path(backend_env).absolute())
        pool = Path(scratch, 'manifest.json')
        pool.write_text(json.dumps(tasks))
        sys.path.insert(0, str(root / 'scripts'))
        try:
            sample = runpy.run_path(str(root / 'scripts/fleet_infra_sample.py'))
            # The canonical CLI eligibility: ready, cloud-root runnable and, for LIVE acceptance,
            # live-query capable (no zero-spend/DEMO replay).
            eligible = sample['eligible_pool'](Path(scratch), pool, require_cloud_root=True,
                                               minimum_successful_llm=CATALOG_ELIGIBILITY[eligibility])
        except ValueError as error:  # includes the unified catalog's CatalogError
            return str(error)
        finally:
            sys.path.remove(str(root / 'scripts'))
    return None if eligible == tasks else 'manifest tasks are not all %s eligible: ' % eligibility.upper() + ', '.join(sorted(set(tasks) - set(eligible)))


def task_manifest(args, root, runner):
    """The ordered --tasks manifest: the pinned original 200, or distinct catalog-eligible names; local only."""
    manifest = json.loads(runner['read'](args.tasks))
    task_timeout, e2e_timeout = bound_timeouts(args, runner)
    if original_manifest(manifest, runner):
        runner['campaign_argv'](manifest, time.time())
        return dict(sha256=runner['TASK_NAMES_SHA'], tasks=len(manifest), original=True,
                    task_timeout=task_timeout, e2e_timeout=e2e_timeout)
    if (not isinstance(manifest, list) or not manifest or any(not isinstance(t, str) or not t for t in manifest)
            or len(set(manifest)) != len(manifest)):
        raise ValueError('--tasks must be an ordered JSON list of distinct task names')
    eligibility = getattr(args, 'catalog_eligibility', 'live')
    reason = catalog_ineligible_reason(root, runner, manifest, args.backend_env, bound_task_ref(args, runner), eligibility)
    if reason:
        raise ValueError('--tasks refused at task ref ' + bound_task_ref(args, runner) + ': ' + reason)
    return dict(sha256=runner['manifest_sha'](manifest), tasks=len(manifest), original=False,
                task_timeout=task_timeout, e2e_timeout=e2e_timeout, catalog_eligible=len(manifest),
                catalog_eligibility=eligibility)


def shard_selection(args, runner):
    """Ordered task selection and shard plan for a fresh run (None = legacy single controller)."""
    manifest = json.loads(runner['read'](args.tasks))
    count = selected_task_count(args, manifest)
    # Only the pinned original manifest at its original timeouts has the legacy single-controller shape.
    legacy_shape = (count == len(manifest) and args.repetitions == 3 and original_manifest(manifest, runner)
                    and not shard_bindings(args, runner))
    if args.controllers == '1' and legacy_shape:
        return None  # explicit single controller: the original 200x3 shape
    coordinator = runpy.run_path(str(Path(__file__).with_name('cloudbench-shard-coordinator.py')))
    controllers = args.controllers if args.controllers == 'auto' else int(args.controllers)
    plan = coordinator['plan_shards'](manifest[:count], args.repetitions, controllers, args.tasks_per_controller)
    legacy = plan['controllers'] == 1 and legacy_shape
    return None if legacy else plan


PROMPT_SECRET_PLACEHOLDERS = {'{GITHUB_DISPATCH_TOKEN}': 'GITHUB_DISPATCH_TOKEN'}


def missing_prompt_secrets(root, runner, tasks, env_paths, task_ref=None):
    """Tasks whose prompt needs a secret absent from every authoritative env file."""
    catalog = json.loads(subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), 'show',
                                                  (task_ref or runner['TASK_REF']) + ':agents/benchmarks/tasks.json']))
    prompts = {row.get('name'): json.dumps(row) for row in catalog if isinstance(row, dict)}
    present = set()
    for path in env_paths:
        for line in runner['read'](path).decode().splitlines():
            key, _, value = line.partition('=')
            if value.strip().strip('"\''):
                present.add(key.strip())
    return sorted((task, key) for task in tasks for placeholder, key in PROMPT_SECRET_PLACEHOLDERS.items()
                  if placeholder in prompts.get(task, '') and key not in present)


def shared_cpu_plan(root, runner, tasks, runs, bench_rows, task_ref=None):
    """Planned and baseline shared CPU units, from the task revision's catalog and the native baseline."""
    import tempfile
    campaign = runpy.run_path(str(root / 'scripts/run-bench-campaign.py'))
    catalog = runpy.run_path(str(root / 'scripts/cloudbench_catalog.py'))
    with tempfile.TemporaryDirectory(prefix='shard-catalog-') as scratch:
        for name in ('tasks.json', 'polar_tasks.json'):
            raw = subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), 'show',
                                           (task_ref or runner['TASK_REF']) + ':agents/benchmarks/' + name])
            Path(scratch, name).write_bytes(raw)
        rows = catalog['get_task_metadata'](Path(scratch, 'tasks.json'), tasks)
    plan = campaign['stress_default_requirements'](root, rows, peak=len(tasks) * runs, baseline=bench_rows,
                                                   repetitions=runs)
    # stress_default_requirements already validated every active row; an unreachable-host
    # Machine without a config is counted with the campaign's conservative allowance.
    baseline = 0
    for m in bench_rows:
        if m.get('state') in ('stopped', 'destroyed'):
            continue
        if m.get('config') is None and m.get('host_status') == 'unreachable':
            baseline += campaign['UNREACHABLE_HOST_SHARED_CPU_ALLOWANCE']
        elif m['config']['guest'].get('cpu_kind') == 'shared':
            baseline += m['config']['guest']['cpus']
    return plan['planned_shared_cpu_units'], baseline


def summary_from_export(export):
    """The shard campaign summary from a verified controller export, or None."""
    import tarfile
    archive = Path(export) / 'originals.tar.gz'
    if not (Path(export) / 'disposable-export.verified.json').exists() or not archive.exists():
        return None
    with tarfile.open(archive, 'r:gz') as stream:
        for member in stream:
            # The controller export stores the workspace .context directory as context/.
            if member.isfile() and re.search(r'(^|/)\.?context/benchmarks/campaigns/[^/]+/summary\.json$', member.name):
                return json.loads(stream.extractfile(member).read())
    return None


def scorecard_module(root):
    return runpy.run_path(str(root / 'scripts/cloudbench-scorecard.py'))


def experiment_fields(args, plan):
    """Ledger identity for one actual sharded launch: goal, operator slice label and shape."""
    label = getattr(args, 'label', None) or os.environ.get('RUN_BENCH_EXPERIMENT_LABEL') \
        or re.sub(r'(-tasks)?(\.private)?$', '', Path(args.tasks).stem)
    return dict(goal=getattr(args, 'goal', None) or os.environ.get('RUN_BENCH_GOAL') or 'original600',
                slice=label, kind='sharded', surface='cloud', source_ref=args.source_ref,
                tasks=len({task for shard in plan['shards'] for task in shard['tasks']}),
                runs=plan['shards'][0]['runs'], scheduled_total=plan['copies'], controllers=plan['controllers'])


def native_release_audit(root, directory, token):
    """Final read-only native audit of every owned guest/volume/controller identity (never mutates)."""
    capture = runpy.run_path(str(root / 'scripts/cloudbench-original-volume-capture.py'))
    audit = runpy.run_path(str(root / 'scripts/cloudbench-native-release-audit.py'))
    return audit['run'](directory, capture['Fly']('navi-whisper-lux-bench', token))


def publish_shard_group(root, directory, args, runner, group_id, started_at, shards, outcomes=None, finished=None):
    """One Hub group for all shards: schedule first, final outcomes after every runner joined."""
    campaign = runpy.run_path(str(root / 'scripts/run-bench-campaign.py'))
    members = campaign['sharded_campaign_jobs'](shards, sum(len(s['tasks']) for s in shards))
    if outcomes is not None:
        for job in members:
            job.update(outcomes.get(job['job_id'], {}))
    group_dir = directory / 'hub-group'
    group_dir.mkdir(mode=0o700, exist_ok=True)
    state = campaign['campaign_group_state'](group_id, started_at, members, **(finished or {}))
    if 'BACKEND_API_KEY' not in os.environ and 'BENCHMARK_HUB_API_KEY' not in os.environ:
        keys = [line.split('=', 1)[1].strip().strip('"\'') for line in runner['read'](args.backend_env).decode().splitlines()
                if line.startswith('BACKEND_API_KEY=')]
        if len(keys) == 1 and keys[0]:
            os.environ['BACKEND_API_KEY'] = keys[0]
    return campaign['publish_campaign_group'](root, group_dir, state, live=outcomes is None, stop_requested=lambda: False)


def shard_group_status(merged, coordination):
    """The Hub terminal status, mirroring a single campaign: operator stop, any failure, else passed."""
    reason = coordination.get('terminate_reason') or coordination.get('abort_reason')
    if isinstance(reason, str) and reason.startswith('operator '):
        return 'cancelled'
    codes = (coordination.get('exit_codes') or {}).values()
    failed = merged['missing_jobs'] or reason or not codes or any(code != 0 for code in codes)
    return 'failed' if failed else 'passed'


def publish_final_shard_group(root, directory, args, runner, group_id, started_at, group_shards, summaries, merged,
                              coordination):
    """The operator's terminal Hub group from every joined shard summary and the coordination record.

    Once reached, an unpublished group always carries its reason: the refusal, or the last line this
    final publication appended to the publisher log (with its Hub request id).
    """
    outcomes = {job['job_id']: dict(status=job.get('status'), controller_exit_code=job.get('controller_exit_code'))
                for summary in summaries if summary for job in summary.get('jobs') or []}
    log = directory / 'hub-group' / 'hub-group-publication.private.log'
    offset = log.stat().st_size if log.is_file() else 0  # the schedule registration shares this log
    try:
        published = publish_shard_group(
            root, directory, args, runner, group_id, started_at, group_shards, outcomes,
            dict(status=shard_group_status(merged, coordination),
                 finished_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                 wall_clock_seconds=round(time.time() - started_at, 3)))
    except Exception as error:
        return dict(hub_group_final_published=False, hub_group_final_error=f'{type(error).__name__}: {error}'[:500])
    if published:
        return dict(hub_group_final_published=True)
    lines = []
    if log.is_file():
        with open(log, 'rb') as stream:
            stream.seek(offset)
            lines = [line for line in stream.read().decode(errors='replace').splitlines() if line.strip()]
    last = lines[-1] if lines else ''
    reason = last if last and not last.startswith('📤') else ' '.join(
        ['final publication was not acknowledged'] + (['after: ' + last] if last else []))
    return dict(hub_group_final_published=False, hub_group_final_log=str(log), hub_group_final_error=reason[:500])


def hub_interpreter(args):
    """Interpreter for operator-side Hub publication; checked before any provider read."""
    hub_python = str(args.hub_python.absolute()) if getattr(args, 'hub_python', None) else sys.executable
    if subprocess.run([hub_python, '-c', 'import httpx'], capture_output=True, timeout=30).returncode:
        raise ValueError('Hub publication interpreter lacks httpx; pass --hub-python <agents venv python>')
    return hub_python


def preallocation_abort(ledger, root, directory, runner, goal, error):
    """End a launch that failed before any allocation as ABORTED, never as an UNRECORDED experiment."""
    ended = time.time()
    reason = ('before allocation: %s: %s' % (type(error).__name__, error))[:300]
    try:
        runner['save'](directory / 'preallocation-abort.json', dict(ended_at=ended, reason=reason, allocated=False))
    except Exception as receipt_error:  # the ledger end below still closes the experiment
        print(json.dumps(dict(status='PREALLOCATION_ABORT_RECEIPT_WARNING', error=type(receipt_error).__name__)),
              file=sys.stderr, flush=True)
    if ledger['record']('end', directory.name, root=root, goal=goal, ended_at=ended, state='ABORTED',
                        abort_reason=reason, outcome=dict(allocated=False)) is None:
        print(json.dumps(dict(status='PREALLOCATION_ABORT_LEDGER_WARNING', experiment=directory.name)),
              file=sys.stderr, flush=True)


def sharded_run(args, root, pins, runner, github, plan, guest_env=None):
    """One fresh admission, K shard configs, then the global-barrier coordinator over K runners."""
    if guest_env is None:  # one rendering binds every shard and retry; refused before provider reads
        guest_env = guest_temporal_env(root, args.agents_env, args.backend_env)
    coordinator = runpy.run_path(str(root / 'scripts/cloudbench-shard-coordinator.py'))
    os.environ['RUN_BENCH_HUB_PYTHON'] = hub_interpreter(args)
    selected = [task for shard in plan['shards'] for task in shard['tasks']]
    missing = missing_prompt_secrets(root, runner, selected, (args.agents_env, args.backend_env), bound_task_ref(args, runner))
    if missing:
        raise ValueError('selected task prompts need secrets absent from the env files: '
                         + ', '.join(f'{task} needs {key}' for task, key in missing))
    parent = args.state_dir.absolute()
    if parent.resolve(strict=True) != parent or parent.stat().st_uid != os.geteuid() or parent.stat().st_mode & 0o077:
        raise ValueError('private physical current-owner state directory required')
    binding = admission_binding(args, runner)
    binding['shards'] = dict(controllers=plan['controllers'], copies=plan['copies'],
                             tasks=[s['tasks'] for s in plan['shards']], runs=plan['shards'][0]['runs'],
                             **shard_bindings(args, runner))
    directory, started_at = open_admission(parent, None, binding, runner, False)
    token = token_from_agents(runner['read'](args.agents_env))
    os.environ['FLY_API_TOKEN'] = token
    capture = runpy.run_path(str(root / 'scripts/cloudbench-original-volume-capture.py'))
    controllers, copies = plan['controllers'], plan['copies']
    demand = coordinator['capacity_demand'](copies, controllers, args.worker_headroom)
    print(json.dumps(dict(directory=str(directory), status='SHARDED_ADMISSION_STARTED', controllers=controllers,
                          copies=copies, copies_per_controller_bound=plan['copies_per_controller_bound'],
                          native_slots_required=demand)), flush=True)
    scorecard = scorecard_module(root)
    ledger = runpy.run_path(str(root / 'scripts/cloudbench_experiments.py'))
    fields = experiment_fields(args, plan)
    ledger['record']('launch', directory.name, root=root, run_dir=str(directory), triggered_at=started_at, **fields)
    scorecard['print_instruction'](directory)
    try:  # nothing is allocated until coordinate() spawns the first runner
        with runner['bounded'](min(110, admission_remaining(started_at + 5400))):
            cap = capacity_snapshot(capture['Fly'], token, args.org, directory, args.extra_destroying_count)
        cap.update(qualified_reuse_count=0, new_machine_demand=demand, qualified_ids=[], new_controller_slots=controllers,
                   requested_original_primary_slots=copies, worker_headroom=args.worker_headroom)
        if cap['available_slots_conservative'] < demand:
            raise ValueError('insufficient measured capacity: %d free Machine slots < %d required (%d copies + %d controllers + %d canary)'
                             % (cap['available_slots_conservative'], demand, copies, controllers,
                                coordinator['CANARY_MACHINES_PER_CONTROLLER'] * controllers))
        runner['save'](directory / 'capacity-proof.private.json', cap)
        cap['proof_path'] = str(directory / 'capacity-proof.private.json')  # every shard binds the one admission proof
        bench_rows = json.loads(read_inventory(directory / 'navi-whisper-lux-bench.private.json'))
        tasks = [task for shard in plan['shards'] for task in shard['tasks']]
        planned, baseline = shared_cpu_plan(root, runner, tasks, plan['shards'][0]['runs'], bench_rows, bound_task_ref(args, runner))
        env = coordinator['shard_runtime_env'](
            machine_limit=cap['machine_limit'], other_app_objects=cap['total_active_inventory_objects'] - len(bench_rows),
            extra_destroying=cap['conservative_extra_destroying_bench_objects'], planned_shared_cpus=planned,
            baseline_shared_cpus=baseline, controllers=controllers)
        group_id = 'original600-' + str(time.time_ns())
        shards, shard_objects = [], {}
        for item in plan['shards']:
            shard_dir = directory / ('shard-%02d' % item['index'])
            shard_dir.mkdir(mode=0o700)
            shard = bound_shard(item, args, runner, group_id, copies, started_at)
            config = prepare(args, root, pins, runner, shard_dir, cap, started_at=started_at, shard=shard,
                             runtime_env=env, sibling_controller_slots=controllers - 1, scheduled_total=copies,
                             guest_env=guest_env)
            shard_objects[item['index']] = shard
            shards.append(dict(index=item['index'], out=shard_dir / 'run', config=str(config),
                               config_sha256=digest(runner['read'](config))))
        runner['save'](directory / 'shards.private.json', dict(plan=plan, runtime_env=env, group_run_id=group_id,
                       shards=[dict(s, out=str(s['out'])) for s in shards]))
        runner['save'](directory / 'controller-launch.intent.json', dict(sharded=True, controllers=controllers,
                       shards=[dict(config_path=s['config'], config_sha256=s['config_sha256'], run_directory=str(s['out']))
                               for s in shards]))
        group_shards = [dict(tasks=s['tasks'], task_indexes=s['task_indexes'], runs=s['runs']) for s in plan['shards']]
        try:
            group_registered = publish_shard_group(root, directory, args, runner, group_id, started_at, group_shards)
        except Exception as error:  # Hub visibility is reported, never a reason to skip release or cleanup
            group_registered = False
            print(json.dumps(dict(status='HUB_GROUP_REGISTRATION_WARNING', error=type(error).__name__)), flush=True)
        print(json.dumps(dict(directory=str(directory), status='LAUNCHING_SHARDS', controllers=controllers,
                              source_ref=args.source_ref, hub_group=group_id, hub_group_registered=group_registered)), flush=True)
        runner_path = root / 'scripts/cloudbench-original600-runner.py'

        def spawn(shard):
            env_vars = dict(os.environ, GITHUB_TOKEN=github, CLOUDBENCH_GATE_NAME_SUFFIX='s%02d' % shard['index'])
            with open(Path(shard['out']).parent / 'runner.private.log', 'xb') as log:
                return subprocess.Popen([sys.executable, str(runner_path), '--config', shard['config'], '--config-sha256',
                                         shard['config_sha256'], '--output', str(shard['out'])],
                                        cwd=root, env=env_vars, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)

        def respawn(shard):
            """A fresh attempt for a shard that created nothing (or verifiably released it) before release."""
            index = shard['index']
            shard_dir = directory / ('shard-%02d' % index)
            attempt_dir = shard_dir / ('attempt-%02d' % (len(list(shard_dir.glob('attempt-[0-9]*'))) + 2))
            attempt_dir.mkdir(mode=0o700)
            bound = shard_objects[index]
            slots = coordinator['capacity_demand'](len(bound['tasks']) * bound['runs'], 1)
            with runner['bounded'](min(110, admission_remaining(started_at + 5400))):
                fresh = capacity_snapshot(capture['Fly'], token, args.org, attempt_dir, args.extra_destroying_count,
                                          summary=True)
            fresh.update(qualified_reuse_count=0, new_machine_demand=slots, qualified_ids=[], new_controller_slots=1,
                         requested_original_primary_slots=len(bound['tasks']) * bound['runs'], retry_of_shard=index)
            if fresh['available_slots_conservative'] < slots:
                raise ValueError('insufficient measured capacity for a shard retry')
            runner['save'](attempt_dir / 'capacity-proof.private.json', fresh)
            fresh['proof_path'] = str(attempt_dir / 'capacity-proof.private.json')
            config = prepare(args, root, pins, runner, attempt_dir, fresh, started_at=started_at, shard=bound,
                             runtime_env=env, sibling_controller_slots=controllers - 1, scheduled_total=copies,
                             guest_env=guest_env)
            replacement = dict(index=index, out=attempt_dir / 'run', config=str(config),
                               config_sha256=digest(runner['read'](config)))
            print(json.dumps(dict(status='SHARD_RETRY', shard=index, directory=str(attempt_dir))), flush=True)
            return replacement, spawn(replacement)
    except BaseException as error:
        preallocation_abort(ledger, root, directory, runner, fields['goal'], error)
        raise

    record = coordinator['coordinate'](shards, spawn, directory / 'coordination.json', scheduled_total=copies,
                                       infra_early_stop=args.infra_early_stop, respawn=respawn,
                                       stagger_seconds=coordinator['DEFAULT_SPAWN_STAGGER_SECONDS'])
    exports = [scorecard['export_records'](Path(s['out']) / 'export') for s in shards]
    summaries = [record['summary'] for record in exports]
    merged = coordinator['merge']([v for v in summaries if v is not None], copies)
    # Bounded per-job rows (verdict, reason, cost, timing, release) let the scorecard render without archives.
    merged['jobs'] = [row for record in exports if record['summary']
                      for row in scorecard['compact_rows'](record['summary'], record['cards'])]
    merged.update(shards_without_summary=[s['index'] for s, v in zip(shards, summaries) if v is None],
                  coordination=record, hub_group=group_id)
    merged.update(publish_final_shard_group(root, directory, args, runner, group_id, started_at, group_shards,
                                            summaries, merged, record))
    runner['save'](directory / 'result.json', merged)
    print(json.dumps(dict(directory=str(directory), status='SHARDS_JOINED', result=str(directory / 'result.json'),
                          observed_jobs=merged['observed_jobs'], missing_jobs=merged['missing_jobs'],
                          infra_failures=merged['infra_failures'])), flush=True)
    try:
        audit = native_release_audit(root, directory, token)
        print(json.dumps(dict(status='NATIVE_RELEASE_AUDIT', released=audit['released'], present=audit['present'],
                              present_volumes=audit['present_volumes'], retained_owners=audit['retained_owners'],
                              checked_guests=len(audit['checked']['guest_names']))), flush=True)
    except Exception as error:  # read-only evidence; its absence renders as an unverified release, never a pass
        print(json.dumps(dict(status='NATIVE_RELEASE_AUDIT_UNAVAILABLE', error=type(error).__name__)), flush=True)
    ledger['record']('end', directory.name, root=root, goal=fields['goal'], ended_at=record.get('finished_at'),
                     state='ABORTED' if record.get('abort_reason') or record.get('terminate_reason') else 'ENDED',
                     outcome={k: merged.get(k) for k in ('task_status', 'infra_failures', 'observed_jobs', 'missing_jobs',
                                                         'resources_released', 'lifecycle_verified')})
    scorecard['print_instruction'](directory)
    return 0 if all(code == 0 for code in record['exit_codes'].values()) and not merged['missing_jobs'] else 1


def payload_guard_failure(runner, output, evidence, original_config, original_sha, raw, receipt):
    """Import the observed 852 pre-gate size refusal without replaying a launch."""
    config=json.loads(runner['read'](original_config))
    if (receipt.get('tool_reported_exit_code')!=1 or receipt.get('gate_created') is not False
            or receipt.get('error')!='compressed launch payload too large for config transport'
            or receipt.get('source_ref')!=config['source_ref']
            or receipt.get('config_path')!=str(original_config) or receipt.get('config_sha256')!=original_sha
            or receipt.get('output_directory')!=str(output)):
        raise ValueError('unbound prelaunch payload refusal')
    known='591e49e553c227c73a02bedc65e49562e9216e0d961493c20790e1cd4c34613a'
    source=subprocess.check_output(['git','--no-replace-objects','-C',str(Path(__file__).resolve().parents[1]),'show',config['source_ref']+':scripts/cloudbench-original600-runner.py'])
    if digest(source)!=known:
        raise ValueError('unrecognized prelaunch payload operator')
    log=runner['read'](receipt['log'])
    lines=log.decode().splitlines()
    if (digest(log)!=receipt['log_sha256'] or not lines
            or lines[-1]!='ValueError: compressed launch payload too large for config transport'
            or sum('payload,payload_sha,remote_command=launch_handoff(out,remote)' in line for line in lines)!=1
            or 'line 236, in run' not in log.decode() or 'line 176, in launch_handoff' not in log.decode()):
        raise ValueError('exact pre-gate payload traceback required')
    event=json.loads(lines[1])
    if event.get('status')!='LAUNCHING_ORIGINAL600' or event.get('source_ref')!=config['source_ref'] or event.get('directory')!=str(original_config.parent):
        raise ValueError('prelaunch event binding differs')
    if output.resolve(strict=True)!=output or {p.name for p in output.iterdir()}!={'authority.private.json'}:
        raise ValueError('payload refusal output contains possible gate activity')
    info=output.stat()
    if info.st_uid!=os.geteuid() or info.st_mode&0o077:
        raise ValueError('private current-owner prelaunch output required')
    authority_raw=runner['read'](output/'authority.private.json')
    recorded=receipt['output_files']
    if set(recorded)!={'authority.private.json'} or recorded['authority.private.json']!={'bytes':len(authority_raw),'sha256':digest(authority_raw)}:
        raise ValueError('prelaunch authority bytes changed')
    authority=json.loads(authority_raw)
    if authority.get('source_ref')!=config['source_ref'] or authority.get('output_directory')!=str(output/'export'):
        raise ValueError('prelaunch authority binding differs')
    try:alive=runner['birth'](authority['cleanup_owner_pid'])==authority['cleanup_owner_birth']
    except (FileNotFoundError,ProcessLookupError,ValueError):alive=False
    if alive:raise ValueError('prelaunch owner still live')
    successor=output.parent/('run-after-prelaunch-'+digest(raw)[:16])
    if successor.exists() or successor.is_symlink() or (output/'host-launch-successor.json').exists():
        raise ValueError('prelaunch continuation already claimed')
    return dict(path=str(evidence),sha256=digest(raw),prior_output=str(output),successor_output=str(successor))


def typed_payload_failure(runner, output, evidence, original_config, original_sha, raw, receipt):
    config=json.loads(runner['read'](original_config))
    if (receipt.get('schema')!='original600-host-payload-failure-v1'
            or receipt.get('gate_created') is not False
            or receipt.get('reason')!='compressed launch payload too large for config transport'
            or receipt.get('source_ref')!=config['source_ref']
            or receipt.get('config_path')!=str(original_config) or receipt.get('config_sha256')!=original_sha
            or receipt.get('output_directory')!=str(output)):
        raise ValueError('unbound typed payload refusal')
    source=subprocess.check_output(['git','--no-replace-objects','-C',str(Path(__file__).resolve().parents[1]),'show',config['source_ref']+':scripts/cloudbench-original600-runner.py'])
    if digest(source)!='f0da1304a88459677a4f5017c7c8689c73c3441357e635fe9040450637c1ab0f' or receipt.get('host_runner_sha256')!=digest(source):
        raise ValueError('unrecognized typed payload operator')
    if output.resolve(strict=True)!=output or {p.name for p in output.iterdir()}!={'authority.private.json','launch-payload-failure.json'}:
        raise ValueError('typed refusal contains possible gate activity')
    info=output.stat()
    if info.st_uid!=os.geteuid() or info.st_mode&0o077 or runner['read'](output/'launch-payload-failure.json')!=raw:
        raise ValueError('private original typed refusal required')
    authority=json.loads(runner['read'](output/'authority.private.json'))
    if (authority.get('source_ref')!=config['source_ref'] or authority.get('output_directory')!=str(output/'export')
            or authority.get('cleanup_owner_pid')!=receipt.get('owner_pid') or authority.get('cleanup_owner_birth')!=receipt.get('owner_birth')):
        raise ValueError('typed refusal owner/authority differs')
    try:alive=runner['birth'](receipt['owner_pid'])==receipt['owner_birth']
    except (FileNotFoundError,ProcessLookupError,ValueError):alive=False
    if alive:raise ValueError('typed refusal owner still live')
    successor=output.parent/('run-after-prelaunch-'+digest(raw)[:16])
    if os.path.lexists(successor) or (output/'host-launch-successor.json').exists():
        raise ValueError('prelaunch continuation already claimed')
    return dict(path=str(evidence),sha256=digest(raw),prior_output=str(output),successor_output=str(successor))


def workspace_release_failure(
    runner, output, evidence, original_config, original_sha, raw, receipt
):
    """A joined failed create with canonical release; never a no-dispatch claim."""
    workload = "49b792dcc2ea983325c6a25801da6c982f29c206"
    host = "69aa6ff584588cfaa07d0a875fb9bdf308267c5c"

    def require(value, message):
        if not value:
            raise ValueError(message)

    require(
        output.resolve(strict=True) == output
        and evidence == output / "observed-closure.safe.json",
        "exact physical closed workspace output required",
    )
    state = output.stat()
    require(
        state.st_uid == os.geteuid() and not state.st_mode & 0o077,
        "private closed workspace output required",
    )
    hashes = {}

    def read(path):
        path = Path(path)
        info = path.lstat()
        require(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == os.geteuid()
            and info.st_nlink == 1
            and not info.st_mode & 0o077,
            "private single-link closure file required",
        )
        data = runner["read"](path)
        hashes[str(path)] = digest(data)
        return data

    def obj(path):
        return json.loads(read(path))

    config = obj(original_config)
    require(
        hashes[str(original_config)] == original_sha
        and config["source_ref"] == workload,
        "closed workspace config/source changed",
    )
    epoch = config["started_at_epoch"]
    require(0 <= time.time() - epoch < 5400, "original campaign clock expired")
    require(
        receipt.get("schema") == "original600-observed-closed-v1"
        and receipt.get("run_directory") == str(output)
        and receipt.get("original_tool_exit_code") == 1
        and receipt.get("release_observer_exit_code") == 0
        and receipt.get("caller_live") is False
        and receipt.get("supervisor_published") is False
        and receipt.get("task_attempts") == 0
        and type(receipt.get("original_session")) is int
        and type(receipt.get("release_observer_session")) is int
        and epoch <= receipt["observed_epoch"] <= time.time(),
        "positive original caller join/closure required",
    )
    require(read(evidence) == raw, "closure observation changed")
    provenance = obj(output / "host-operator-provenance.json")
    require(
        provenance == config["host_operator_provenance"]
        and provenance["host_operator_source_ref"] == host
        and provenance["workload_source_ref"] == workload
        and provenance["original_started_at_epoch"] == epoch,
        "closed workspace host provenance changed",
    )
    source_hashes = {}
    for ref, names in (
        (host, ("cloudbench-original600-runner.py", "run-cloudbench-controller-gate")),
        (
            workload,
            ("cloudbench-disposable-controller.py", "run-cloudbench-controller-gate"),
        ),
    ):
        for name in names:
            source = subprocess.check_output(
                [
                    "git",
                    "--no-replace-objects",
                    "-C",
                    str(Path(__file__).resolve().parents[1]),
                    "show",
                    ref + ":scripts/" + name,
                ]
            )
            source_hashes[ref + ":" + name] = digest(source)
    require(
        source_hashes[host + ":cloudbench-original600-runner.py"]
        == provenance["host_runner_sha256"]
        and source_hashes[host + ":run-cloudbench-controller-gate"]
        == provenance["host_gate_sha256"]
        and all(
            config["source_files"][name] == source_hashes[workload + ":" + name]
            for name in (
                "cloudbench-disposable-controller.py",
                "run-cloudbench-controller-gate",
            )
        ),
        "closed workspace producer source changed",
    )
    authority = obj(output / "authority.private.json")
    caller = obj(output / "caller.json")
    auth_sha = hashes[str(output / "authority.private.json")]
    require(
        caller["authority_sha256"] == auth_sha
        and caller["source_ref"] == authority["source_ref"] == workload
        and caller["epoch"] == epoch
        and caller["deadline"] == epoch + 5400
        and authority["output_directory"] == str(output / "export")
        and (authority["cleanup_owner_pid"], authority["cleanup_owner_birth"])
        == (caller["pid"], caller["birth"])
        and receipt["caller_pid"] == caller["pid"],
        "closed workspace caller/authority changed",
    )
    # A missing or reused original PID is checked separately from the joined
    # tool receipt. Generic proc read failures do not establish caller closure.
    if Path("/proc").is_dir():
        require(
            not Path("/proc", str(caller["pid"])).exists()
            and not Path("/proc", str(caller["gate_pid"])).exists(),
            "original caller or gate PID still present",
        )
    else:
        for pid, birth in (
            (caller["pid"], caller["birth"]),
            (caller["gate_pid"], caller["gate_birth"]),
        ):
            try:
                live = runner["birth"](pid) == birth
            except (FileNotFoundError, ProcessLookupError):
                live = False
            require(not live, "original caller or gate still live")
    export = output / "export"
    require(
        export.resolve(strict=True) == export
        and export.is_dir()
        and not export.stat().st_mode & 0o077,
        "physical private released export required",
    )
    gate_caller = obj(export / "caller.json")
    require(
        (gate_caller["pid"], gate_caller["birth"])
        == (caller["gate_pid"], caller["gate_birth"]),
        "original gate custody changed",
    )
    workspace = obj(export / "workspace-volume.ownership.json")
    workspace_intent = obj(export / "workspace-volume.intent.json")
    native = obj(export / "workspace-volume-create.private.json")
    require(
        workspace["schema"] == "cloudbench-controller-workspace-ownership-v1"
        and workspace["source_ref"] == workload
        and workspace["app"] == authority["app"] == "navi-whisper-lux-bench"
        and workspace["size_gb"] == 256
        and workspace["mount_path"] == "/tmp/gate"
        and workspace["volume_id"] == native["id"]
        and workspace["native_create"] == native
        and workspace["native_create_sha256"]
        == hashes[str(export / "workspace-volume-create.private.json")]
        and workspace["intent_sha256"]
        == hashes[str(export / "workspace-volume.intent.json")]
        and workspace_intent["caller"] == workspace["caller"] == gate_caller
        and workspace["caller_sha256"]
        == workspace_intent["caller_sha256"]
        == hashes[str(export / "caller.json")],
        "original workspace custody changed",
    )
    volume = workspace["volume_id"]
    require(
        volume not in authority["protected_volumes"]
        and native.get("attached_machine_id") is None
        and native["state"] == "created",
        "foreign or originally attached workspace",
    )
    create = obj(export / "machine-create.intent.json")
    delete = obj(export / "disposable-delete-volume.intent.json")
    require(
        create["authority_sha256"] == auth_sha
        and create["workspace_sha256"]
        == hashes[str(export / "workspace-volume.ownership.json")]
        and create["image"] == config["gate_env"]["WARM_IMAGE_REF"]
        and "@sha256:" in create["image"]
        and create["name"].startswith("cloudbench-gate-" + workload[:8] + "-")
        and delete == dict(authority_sha256=auth_sha, identifier=volume, kind="volume"),
        "original create/delete intent changed",
    )
    release = obj(export / "disposable-controller.release.json")
    require(
        release
        == dict(
            machine_id=None,
            volume_id=volume,
            volume_disposition=release["volume_disposition"],
            no_live_machine_observed=True,
            command_history_verified=False,
        )
        and release["volume_disposition"] in ("ABSENT", "pending_destroy", "destroyed"),
        "canonical workspace release required",
    )
    require(
        obj(output / "cleanup-call.intent.json")
        == dict(
            action="cleanup-workspace",
            machine=None,
            gate_joined=True,
            supervisor_joined=False,
            export_verified_file=None,
        ),
        "canonical joined workspace cleanup required",
    )
    terminal = obj(output / "terminal.json")
    require(
        terminal["status"] == "FAILED_STARTUP_WORKSPACE_RELEASED"
        and terminal["machine"] is None
        and terminal["release"] == release
        and terminal["source_ref"] == workload
        and terminal["started_at_epoch"] == epoch
        and terminal["original_deadline"] == epoch + 5400
        and terminal["gate_exit_code"] == 1
        and type(terminal["controller_cleanup_exit_code"]) is int
        and terminal["externally_reconciled_after_helper_failure"]
        == (terminal["controller_cleanup_exit_code"] != 0)
        and terminal["benchmark_success_inferred"] is False,
        "canonical released startup terminal required",
    )
    log = read(output / "gate.private.log")
    require(
        b"failed to forward request" in log
        and b"Machine ID:" not in log
        and ("GATE_WORKSPACE_VOLUME_RETAINED id=" + volume).encode() in log
        and create["name"].encode() in log,
        "exact failed startup stream required",
    )
    once_name = "authority.private.json." + auth_sha + ".once"
    require(
        obj(output / once_name)
        == dict(
            authority_sha256=auth_sha,
            driver_pid=caller["gate_pid"],
            driver_birth=caller["gate_birth"],
        ),
        "original allocation owner changed",
    )
    descriptors = obj(output / "controller-sidecars.private.json")
    sidecars = set()
    for entry in descriptors:
        path = output / ("controller-sidecar-" + entry["sha256"] + ".private.gz")
        data = read(path)
        require(
            entry["path"] == str(path)
            and entry["sha256"] == digest(data)
            and entry["bytes"] == len(data),
            "original sidecar custody changed",
        )
        sidecars.add(path.name)
    required = {
        "authority.private.json",
        once_name,
        "caller.json",
        "cleanup-call.intent.json",
        "terminal.json",
        "gate.private.log",
        "host-operator-provenance.json",
        "controller-launch-payload.private.json.gz",
        "controller-sidecars.private.json",
        "observed-closure.safe.json",
        "export",
    } | sidecars
    optional = {
        "cleanup.pending.json",
        "gate.pending.json",
        "threshold-owner.identity.private.json",
        "workspace-release-observation.log",
    }
    require(
        required <= {p.name for p in output.iterdir()} <= required | optional,
        "unknown closed workspace output artifact",
    )
    export_required = {
        "caller.json",
        "current-agents.private.env",
        "current-backend.private.env",
        "disposable-controller.release.json",
        "disposable-delete-volume.intent.json",
        "machine-create.intent.json",
        "workspace-backup.verified.json",
        "workspace-volume-create.private.json",
        "workspace-volume-create.stderr.private.log",
        "workspace-volume.intent.json",
        "workspace-volume.ownership.json",
    }
    require(
        export_required
        <= {p.name for p in export.iterdir()}
        <= export_required | {"workspace-backup.intent.json"},
        "possible controller/export activity in released workspace",
    )
    for key in ("agents", "backend"):
        require(
            digest(read(export / ("current-" + key + ".private.env")))
            == authority["env_files"][key]["sha256"],
            "original complete env custody changed",
        )
    membership = {}
    for path in sorted(output.rglob("*")):
        require(not path.is_symlink(), "closed workspace alias")
        if path == export:
            membership["export"] = "directory"
        else:
            require(path.is_file(), "unknown closed workspace directory")
            read(path)
            membership[str(path.relative_to(output))] = hashes[str(path)]
    successor = output.parent / ("run-after-workspace-release-" + digest(raw)[:16])
    require(
        not successor.exists()
        and not successor.is_symlink()
        and not (output / "host-launch-successor.json").exists(),
        "workspace continuation already claimed",
    )
    return dict(
        path=str(evidence),
        sha256=digest(raw),
        prior_output=str(output),
        successor_output=str(successor),
        stage="CANONICAL_WORKSPACE_RELEASED_AFTER_UNKNOWN_CREATE",
        creation_history_verified=False,
        inputs=hashes,
        membership=membership,
        producer_sources=source_hashes,
    )


def prelaunch_failure(runner, output, evidence, original_config, original_sha):
    """Accept the retained known pre-exec failure, never directory absence alone."""
    raw=runner['read'](evidence);receipt=json.loads(raw)
    if receipt.get('schema')=='original600-observed-closed-v1':
        return workspace_release_failure(runner,output,evidence,original_config,original_sha,raw,receipt)
    if receipt.get('schema')=='original600-host-payload-failure-v1':
        return typed_payload_failure(runner,output,evidence,original_config,original_sha,raw,receipt)
    if receipt.get('schema')=='observed-host-prelaunch-refusal-v1':
        return payload_guard_failure(runner,output,evidence,original_config,original_sha,raw,receipt)
    if receipt.get('schema') != 'observed-tool-session-join-v1' or receipt.get('tool_reported_exit_code') != 1:
        raise ValueError('positive joined Popen failure evidence required')
    if receipt.get('log_contains_synchronous_popen_errno') != 7 or receipt.get('gate_pid') != 'NOT_CREATED_BY_FAILED_POPEN':
        raise ValueError('only proven E2BIG before gate execution may continue')
    expected={'host-operator-provenance.json','authority.private.json','gate.private.log'}
    if output.resolve(strict=True)!=output or {p.name for p in output.iterdir()}!=expected:
        raise ValueError('prelaunch output contains possible gate activity')
    info=output.stat()
    if info.st_uid!=os.geteuid() or info.st_mode&0o077:
        raise ValueError('private current-owner prelaunch output required')
    recorded=receipt['run_output_files_observed']
    if set(recorded)!={str(output/name) for name in expected}:
        raise ValueError('prelaunch evidence names another output')
    for name in expected:
        data=runner['read'](output/name);entry=recorded[str(output/name)]
        if len(data)!=entry['bytes'] or digest(data)!=entry['sha256']:
            raise ValueError('prelaunch evidence bytes changed')
    if runner['read'](output/'gate.private.log'):
        raise ValueError('gate produced output')
    provenance=json.loads(runner['read'](output/'host-operator-provenance.json'))
    if provenance.get('original_config_path')!=str(original_config) or provenance.get('original_config_sha256')!=original_sha:
        raise ValueError('prelaunch original config changed')
    # Legacy import is deliberately limited to the observed version whose
    # Popen error occurred before caller publication or any gate execution.
    known='965eb3a1a70a3ccb3b20c89b3780af0a87bc709ace31633c3220e5eb9db4c988'
    host_ref=provenance.get('host_operator_source_ref','')
    source=subprocess.check_output(['git','--no-replace-objects','-C',str(Path(__file__).resolve().parents[1]),'show',host_ref+':scripts/cloudbench-original600-runner.py'])
    if digest(source)!=known or provenance.get('host_runner_sha256')!=known:
        raise ValueError('unrecognized legacy prelaunch operator')
    text=runner['read'](receipt['stderr_and_stdout_log'])
    if digest(text)!=receipt['log_sha256']:
        raise ValueError('prelaunch traceback changed')
    lines=text.decode().splitlines()
    if (not lines or lines[-1]!="OSError: [Errno 7] Argument list too long: 'bash'"
            or sum('gate=subprocess.Popen(command,cwd=root,env=env,stdout=stream,stderr=subprocess.STDOUT)' in line for line in lines)!=1
            or 'line 204, in run' not in text.decode()):
        raise ValueError('exact synchronous pre-exec traceback required')
    event=json.loads(lines[0])
    if event.get('host_operator_source_ref')!=host_ref or event.get('source_ref')!=provenance.get('workload_source_ref'):
        raise ValueError('traceback source identity changed')
    authority=json.loads(runner['read'](output/'authority.private.json'))
    config=json.loads(runner['read'](original_config))
    if (authority.get('source_ref')!=config.get('source_ref') or provenance.get('workload_source_ref')!=config.get('source_ref')
            or provenance.get('original_started_at_epoch')!=config.get('started_at_epoch')
            or authority.get('output_directory')!=str(output/'export')):
        raise ValueError('prelaunch authority/workload binding changed')
    try:alive=runner['birth'](authority['cleanup_owner_pid'])==authority['cleanup_owner_birth']
    except (FileNotFoundError,ProcessLookupError,ValueError):alive=False
    if alive:
        raise ValueError('prelaunch owner still live')
    successor=output.parent/('run-after-popen-'+digest(raw)[:16])
    if successor.exists() or successor.is_symlink() or (output/'host-launch-successor.json').exists():
        raise ValueError('prelaunch continuation already claimed')
    return dict(path=str(evidence),sha256=digest(raw),prior_output=str(output),successor_output=str(successor))


def bound_launch_plan(args, runner):
    """Verify a failed pre-effect launch without changing its workload or clock."""
    directory = args.resume_bound_launch.absolute()
    if directory.resolve(strict=True) != directory or directory.parent != args.state_dir.absolute():
        raise ValueError('bound admission must be physical and below original state-dir')
    info = directory.stat()
    if info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError('private current-owner bound admission required')
    original = json.loads(runner['read'](directory/'admission-intent.private.json'))
    binding = admission_binding(args, runner)
    binding['source_ref'] = original['binding']['source_ref']
    if binding != original['binding']:
        raise ValueError('bound launch original inputs changed')
    intent_path = directory/'controller-launch.intent.json'
    intent = json.loads(runner['read'](intent_path))
    config_path = Path(intent['config_path'])
    output = Path(intent['run_directory'])
    if (config_path.parent.parent != directory or output.parent != config_path.parent
            or output.name != 'run' or output.is_symlink()):
        raise ValueError('bound launch output must be the original absent run directory')
    raw = runner['read'](config_path)
    if digest(raw) != intent['config_sha256']:
        raise ValueError('original bound config changed')
    config = json.loads(raw)
    failure=None
    if output.exists():
        evidence=getattr(args,'prelaunch_failure',None)
        if evidence is None:
            raise ValueError('bound launch output must be the original absent run directory')
        failure=prelaunch_failure(runner,output,evidence,config_path,intent['config_sha256'])
    elif getattr(args,'prelaunch_failure',None):
        raise ValueError('prelaunch evidence requires its exact existing output')
    old_ref = original['binding']['source_ref']
    if config['source_ref'] != old_ref or config['started_at_epoch'] != original['started_at_epoch']:
        raise ValueError('original bound workload or clock changed')
    workload = Path(config['source_root'])
    if subprocess.check_output(['git','-C',str(workload),'rev-parse','HEAD'],text=True).strip() != old_ref:
        raise ValueError('original workload checkout changed')
    runner['validate_source_members'](workload, old_ref, config['source_files'])
    descriptor = next(row for row in config['remote_files'] if row['relative_path'].startswith('.git/cloudbench-archived-reuse-'))
    reserved_raw = runner['read'](descriptor['source_path'])
    if digest(reserved_raw) != descriptor['sha256']:
        raise ValueError('original bound reservations changed')
    reserved = reuse_module()['validate_request'](json.loads(reserved_raw), old_ref)
    if reserved['task_names'] != json.loads(runner['read'](args.tasks)):
        raise ValueError('original bound task manifest changed')
    return dict(directory=directory, intent_path=intent_path, intent=intent, config=config,
                original_config_path=config_path, reserved=reserved, output=Path(failure['successor_output']) if failure else output, original_binding=original['binding'], prelaunch_failure=failure)


def resume_bound_launch(args, root, runner, plan, github):
    # The old immutable workload remains the execution source. Only this host
    # operator and fresh read-only admission proof are new and separately logged.
    config = plan['config']
    current_binding = admission_binding(args, runner)
    current_binding['source_ref'] = config['source_ref']
    if current_binding != plan['original_binding']:
        raise ValueError('bound launch input changed after validation')
    if not 0 <= time.time()-config['started_at_epoch'] < 5400:
        raise ValueError('original campaign clock expired')
    continuation = plan['directory']/('bound-continuation-'+str(time.time_ns()))
    continuation.mkdir(mode=0o700)
    token = token_from_agents(runner['read'](args.agents_env))
    os.environ['FLY_API_TOKEN'] = token
    capture = runpy.run_path(str(root/'scripts/cloudbench-original-volume-capture.py'))
    with runner['bounded'](110):
        cap = capacity_snapshot(capture['Fly'], token, args.org, continuation, args.extra_destroying_count)
    inventory = json.loads(read_inventory(continuation/'navi-whisper-lux-bench.private.json'))
    facts = facts_from(runner['read'](args.facts))
    verify_reuse_images(plan['reserved'], inventory, facts['image_ref'])
    cap.update(reuse_module()['capacity_demand'](plan['reserved'], inventory, set(facts['protected_machines']), require_reserved=True))
    if cap['available_slots_conservative'] < cap['new_machine_demand']:
        raise ValueError('fresh bound-launch capacity insufficient')
    proof_path = continuation/'capacity-proof.private.json'
    runner['save'](proof_path, cap)
    authority = json.loads(runner['read'](config['authority_template']))
    authority.update(org_machine_limit=cap['machine_limit'],
                     org_object_count=cap['total_active_inventory_objects']+cap['conservative_extra_destroying_bench_objects'],
                     verified_epoch=cap['ended_epoch'],capacity_proof=dict(path=str(proof_path),sha256=digest(runner['read'](proof_path))))
    authority_path = continuation/'authority-template.private.json'
    runner['save'](authority_path, authority)
    provenance = dict(host_operator_source_ref=args.source_ref, workload_source_ref=config['source_ref'],
                      original_config_path=str(plan['original_config_path']),original_config_sha256=plan['intent']['config_sha256'],
                      original_launch_intent_sha256=digest(runner['read'](plan['intent_path'])),
                      original_started_at_epoch=config['started_at_epoch'],
                      host_runner_sha256=digest((root/'scripts/cloudbench-original600-runner.py').read_bytes()),
                      host_gate_sha256=digest((root/'scripts/run-cloudbench-controller-gate').read_bytes()),
                      prelaunch_failure=plan.get('prelaunch_failure'))
    derived = dict(config, authority_template=str(authority_path), host_operator_provenance=provenance)
    path = continuation/'config.private.json'
    runner['save'](path, derived)
    if plan.get('prelaunch_failure'):
        failure=plan['prelaunch_failure']
        # Revalidate the old immutable evidence immediately before the exclusive handoff.
        again=prelaunch_failure(runner,Path(failure['prior_output']),Path(failure['path']),plan['original_config_path'],plan['intent']['config_sha256'])
        if again!=failure:raise ValueError('prelaunch continuation changed')
        runner['save'](Path(failure['prior_output'])/'host-launch-successor.json',dict(schema='original600-host-launch-successor-v1',
            evidence=failure,config_path=str(path),config_sha256=digest(runner['read'](path)),
            original_started_at_epoch=config['started_at_epoch'],host_operator_source_ref=args.source_ref))
    print(json.dumps(dict(status='CONTINUING_ORIGINAL_BOUND_LAUNCH',admission_directory=str(plan['directory']),
                         source_ref=config['source_ref'],host_operator_source_ref=args.source_ref,run_directory=str(plan['output']),config_path=str(path))),flush=True)
    return runner['run'](path, digest(runner['read'](path)), plan['output'], github_token=github)


def incomplete_admission_plan(args, runner):
    directory=args.resume_incomplete_admission.absolute()
    if directory.parent!=args.state_dir.absolute() or directory.resolve(strict=True)!=directory:
        raise ValueError('incomplete admission must be an original private state directory')
    module=runpy.run_path(str(Path(__file__).with_name('cloudbench-incomplete-reservations.py')))
    plan=module['plan'](directory,args.incomplete_admission_failure)
    original=json.loads(runner['read'](directory/'admission-intent.private.json'))
    binding=admission_binding(args,runner)
    binding['source_ref']=original['binding']['source_ref']
    if binding!=original['binding'] or plan['source_ref']!=binding['source_ref']:
        raise ValueError('incomplete admission original inputs changed')
    oldroot=Path(plan['source_root'])
    if subprocess.check_output(['git','-C',str(oldroot),'rev-parse','HEAD'],text=True).strip()!=plan['source_ref']:
        raise ValueError('original workload HEAD changed')
    oldcli=subprocess.check_output(['git','--no-replace-objects','-C',str(oldroot),'show',plan['source_ref']+':scripts/run-original600-controller.py'])
    names=ast.literal_eval(next(node.value for node in ast.parse(oldcli).body
        if isinstance(node,ast.Assign) and any(isinstance(n,ast.Name) and n.id=='PINS' for n in node.targets)))
    if subprocess.check_output(['git','-C',str(oldroot),'status','--porcelain','--untracked-files=no']):
        raise ValueError('original workload checkout changed')
    pins={name:digest((oldroot/'scripts'/name).read_bytes()) for name in names}
    runner['validate_source_members'](oldroot,plan['source_ref'],pins)
    return module,plan,pins


def resume_incomplete_admission(args, root, runner, github):
    module,plan,oldpins=incomplete_admission_plan(args,runner)
    directory=Path(plan['directory']);deadline=plan['deadline']
    def remaining():
        value=deadline-time.time()
        if not 0<value<=5400:
            raise ValueError('original incomplete-admission clock expired')
        return min(110,value)
    lock=directory/'incomplete-admission.lock'
    fd=os.open(lock,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o077 or info.st_nlink!=1:
            raise ValueError('private incomplete admission lock required')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if incomplete_admission_plan(args,runner)[1]!=plan:
            raise ValueError('incomplete admission evidence changed')
        operator={'source_ref':args.source_ref,'source_root':str(root),
                  'original_plan_sha256':digest(json.dumps(plan,sort_keys=True,allow_nan=False).encode())}
        operator_path=directory/'incomplete-operator.intent.json'
        try:runner['save'](operator_path,operator)
        except FileExistsError:pass
        if json.loads(runner['read'](operator_path))!=operator:
            raise ValueError('incomplete admission assigned to another operator')
        token=token_from_agents(runner['read'](args.agents_env))
        os.environ['FLY_API_TOKEN']=token
        capture=runpy.run_path(str(root/'scripts/cloudbench-original-volume-capture.py'))
        before=directory/('capacity-before-recovery-'+str(time.time_ns()));before.mkdir(mode=0o700)
        with runner['bounded'](remaining()):
            initial=capacity_snapshot(capture['Fly'],token,args.org,before,args.extra_destroying_count)
        inventory=json.loads(read_inventory(before/'navi-whisper-lux-bench.private.json'))
        request=plan['request']
        helper=reuse_module()
        connection=capture['Fly']('navi-whisper-lux-bench',token)
        def adapter(journal):return helper['NativeAdapter'](connection,journal/'wire')
        retained={row['machine_id']:row for row in plan.get('retained_request',{}).get('candidates',[])}
        current_request=dict(request,candidates=[retained.get(row['machine_id'],row) for row in request['candidates']])
        inventory=observe_reuse_configs(adapter,current_request,inventory,before/'selected-full-config-observation',runner,deadline,proof=initial)
        verify_reuse_images(request,inventory,facts_from(runner['read'](args.facts))['image_ref'])
        reservation_disk_headroom(directory,request,inventory,before)
        retained_count = len(plan.get('retained_request', {}).get('candidates', []))
        if initial['available_slots_conservative']+retained_count+len(plan['classifications'])<601:
            raise ValueError('incomplete admission has insufficient possible capacity')
        if incomplete_admission_plan(args,runner)[1]!=plan:
            raise ValueError('incomplete admission evidence changed before native effect')
        remaining()
        with joined_admission_signals():
            reserved=module['reconcile'](adapter,plan,directory/'incomplete-admission-recovery',deadline)
        after=directory/('capacity-after-recovery-'+str(time.time_ns()));after.mkdir(mode=0o700)
        with runner['bounded'](remaining()):
            final=capacity_snapshot(capture['Fly'],token,args.org,after,args.extra_destroying_count)
        inventory=json.loads(read_inventory(after/'navi-whisper-lux-bench.private.json'))
        facts=facts_from(runner['read'](args.facts))
        inventory=observe_reuse_configs(adapter,reserved,inventory,after/'selected-full-config-observation',runner,deadline,proof=final)
        verify_reuse_images(reserved,inventory,facts['image_ref'])
        final.update(helper['capacity_demand'](reserved,inventory,set(facts['protected_machines']),require_reserved=True))
        if final['available_slots_conservative']<final['new_machine_demand']:
            raise ValueError('fresh incomplete-admission capacity insufficient')
        proof=after/'capacity-proof.private.json';runner['save'](proof,final)
        final['proof_path']=str(proof)
        if incomplete_admission_plan(args,runner)[1]!=plan:
            raise ValueError('incomplete admission evidence changed before launch')
        remaining()
        launch=directory/('launch-'+str(time.time_ns()));launch.mkdir(mode=0o700)
        runner['save'](launch/'archived-reuse-request.private.json',reserved)
        provenance={'host_operator_source_ref':args.source_ref,'workload_source_ref':plan['source_ref'],
            'original_started_at_epoch':plan['started_at'], 'incomplete_admission':operator,
            'host_runner_sha256':digest((root/'scripts/cloudbench-original600-runner.py').read_bytes()),
            'host_gate_sha256':digest((root/'scripts/run-cloudbench-controller-gate').read_bytes())}
        config_observations={name:value['selected_full_config_observation'] for name,value in (('before',initial),('after',final)) if 'selected_full_config_observation' in value}
        if config_observations:
            provenance['selected_full_config_observations']=config_observations
        oldargs=copy.copy(args);oldargs.source_ref=plan['source_ref']
        config=prepare(oldargs,Path(plan['source_root']),oldpins,runner,launch,final,
                       started_at=plan['started_at'],host_operator_provenance=provenance)
        runner['save'](directory/'controller-launch.intent.json',{'config_path':str(config),
            'config_sha256':digest(runner['read'](config)),'run_directory':str(launch/'run')})
        print(json.dumps({'status':'CONTINUING_ORIGINAL_ADMISSION','admission_directory':str(directory),
            'source_ref':plan['source_ref'],'host_operator_source_ref':args.source_ref,
            'config_path':str(config),'run_directory':str(launch/'run')}),flush=True)
        return runner['run'](config,digest(runner['read'](config)),launch/'run',github_token=github)
    finally:
        os.close(fd)


def preparation_plan(args, runner):
    module = runpy.run_path(
        str(Path(__file__).with_name("cloudbench-prepare-admission.py"))
    )
    return module, module["plan"](args, runner)


def prepare_admission_request(args, root, runner):
    """Publish the first request; the original operator still owns reservation and launch."""
    module, plan = preparation_plan(args, runner)
    directory = Path(plan["directory"])
    lock = directory / "pre-reservation-preparation.lock"
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_mode & 0o077
            or info.st_nlink != 1
        ):
            raise ValueError("private preparation lock required")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if module["plan"](args, runner) != plan:
            raise ValueError("pre-reservation evidence changed")
        journal = directory / "pre-reservation-preparation"
        journal.mkdir(mode=0o700)
        runner["save"](
            journal / "intent.json",
            {
                "schema": "original600-pre-reservation-preparation-v1",
                "operator_ref": args.source_ref,
                "operator_root": str(root),
                "plan": plan,
            },
        )
        oldroot = Path(plan["source_root"])
        old = runpy.run_path(str(oldroot / "scripts/run-original600-controller.py"))
        oldrunner = runpy.run_path(
            str(oldroot / "scripts/cloudbench-original600-runner.py")
        )
        token = token_from_agents(runner["read"](args.agents_env))
        os.environ["FLY_API_TOKEN"] = token
        api = runpy.run_path(
            str(oldroot / "scripts/cloudbench-original-volume-capture.py")
        )["Fly"]
        snapshot = journal / "capacity"
        snapshot.mkdir(mode=0o700)
        function = old["capacity"]
        namespace = function.__globals__
        native_snapshot = namespace["capacity_snapshot"]

        def bounded_snapshot(*values):
            with runner["bounded"](min(110, admission_remaining(plan["deadline"]))):
                return native_snapshot(*values)

        namespace["capacity_snapshot"] = bounded_snapshot
        try:
            with (
                joined_admission_signals(),
                runner["bounded"](admission_remaining(plan["deadline"])),
            ):
                old["capacity"](
                    api,
                    token,
                    args.org,
                    snapshot,
                    args.extra_destroying_count,
                    args.archive_run,
                    plan["source_ref"],
                    args.reuse_exclude_machine,
                    facts_from(runner["read"](args.facts))["image_ref"],
                    args.unused_reservation_run,
                    args.parked_reservation_run,
                    args.expired_reservation_run,
                )
        finally:
            namespace["capacity_snapshot"] = native_snapshot
        request = json.loads(
            oldrunner["read"](snapshot / "archived-reuse-request.private.json")
        )
        request["task_names"] = json.loads(oldrunner["read"](args.tasks))
        request["image_ref"] = old["facts_from"](oldrunner["read"](args.facts))[
            "image_ref"
        ]
        oldrunner["campaign_argv"](request["task_names"], plan["started_at"])
        old["reuse_module"]()["validate_request"](request, plan["source_ref"])
        if module["plan"](args, runner) != plan:
            raise ValueError("pre-reservation evidence changed before publication")
        admission_remaining(plan["deadline"])
        envelope = dict(
            schema="original600-archived-admission-request-v1",
            request=request,
            sha256=digest(
                json.dumps(request, sort_keys=True, allow_nan=False).encode()
            ),
        )
        envelope_sha = digest(
            (json.dumps(envelope, sort_keys=True, allow_nan=False) + "\n").encode()
        )
        runner["save"](
            journal / "ready.json",
            {
                "status": "READY_FOR_REQUEST_PUBLICATION",
                "request_sha256": envelope_sha,
                "source_ref": plan["source_ref"],
                "operator_ref": args.source_ref,
                "original_started_at_epoch": plan["started_at"],
                "deadline_epoch": plan["deadline"],
            },
        )
        admission_remaining(plan["deadline"])
        oldrunner["save"](directory / "archived-reuse-original.private.json", envelope)
        if (
            digest(
                oldrunner["read"](directory / "archived-reuse-original.private.json")
            )
            != envelope_sha
        ):
            raise ValueError("published preparation request changed")
        print(
            json.dumps(
                dict(
                    status="REQUEST_PREPARED",
                    directory=str(directory),
                    source_ref=plan["source_ref"],
                    operator_ref=args.source_ref,
                    request_sha256=envelope_sha,
                    started_at_epoch=plan["started_at"],
                    deadline_epoch=plan["deadline"],
                )
            ),
            flush=True,
        )
        return 0
    finally:
        os.close(fd)


def main():
    if sys.argv[1:2] == ['--status']:
        status = runpy.run_path(str(Path(__file__).with_name('original600-status.py')))
        return status['main'](sys.argv[2:])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='perform fresh capacity reads, then allocate and own one original600 controller')
    parser.add_argument('--source-ref', required=True)
    parser.add_argument('--infra-early-stop', choices=('enabled', 'disabled'), default='enabled', help='Automatic infrastructure threshold stop policy; failure accounting and all time limits remain unchanged')
    for name in ['state-dir', 'agents-env', 'backend-env', 'tasks']:
        parser.add_argument('--'+name, required=True, type=Path)
    # Omit all three to discover them: facts from read-only native inventory, the warm
    # proof from the producer's git-common file (refreshed for this ref when stale) and
    # the snapshot inventory from the donor listing. Historical runs pass them explicitly.
    for name in ['facts', 'snapshot-inventory', 'warm-deps']:
        parser.add_argument('--'+name, type=Path)
    parser.add_argument('--task-ref', help='pushed guest task source commit (default: the historical original600 pin)')
    parser.add_argument('--archive-run', action='append', type=Path, help='Verified predecessor run directory; preserve IDs/volume using a clean task generation before fresh creation')
    parser.add_argument('--unused-reservation-run', action='append', default=[], type=Path, help='Closed admission whose fully archived, never-assigned reservations may pass to this new cohort')
    parser.add_argument('--parked-reservation-run', action='append', default=[], type=Path, help='Closed admission: validate untouched and positively proven parked claims for a new cohort')
    parser.add_argument('--expired-reservation-run', action='append', default=[], type=Path, help='Expired never-launched admission: validate retained reservations for a new cohort')
    parser.add_argument('--reuse-exclude-machine', action='append', default=[], help='Conservatively exclude a changed/pilot Machine from archived reuse')
    parser.add_argument('--prelaunch-failure',type=Path,help='Retained positive no-child E2BIG evidence for an existing bound output')
    parser.add_argument('--resume-bound-launch', type=Path, help='Continue an original absent-output bound launch using a verified host operator and fresh capacity')
    parser.add_argument('--resume-admission', type=Path, help='Reconcile the same prelaunch archived-reservation state; never restart a bound controller')
    parser.add_argument('--resume-incomplete-admission',type=Path,help='Continue a proven joined pre-controller failure without rewriting its partial journals')
    parser.add_argument('--incomplete-admission-failure',type=Path,help='Positive source-bound joined admission failure receipt')
    parser.add_argument('--prepare-admission-request', type=Path, help='Prepare only the first request for a joined pre-reservation admission; preserve its original operator and clock')
    parser.add_argument('--pre-reservation-failure', type=Path, help='Positive joined pre-reservation failure receipt')
    parser.add_argument('--org', choices=['personal'], default='personal')
    parser.add_argument('--extra-destroying-count', type=int, default=1)
    parser.add_argument('--controllers', default='auto', help="'auto' (copies one controller handles easily) or an explicit controller count; 1 = single controller")
    parser.add_argument('--tasks-per-controller', type=int, help='explicit tasks per controller (all repetitions of a task share one controller)')
    parser.add_argument('--task-count', type=int, help='run only the first N manifest tasks (diagnostic ladder)')
    parser.add_argument('--repetitions', type=int, default=3, help='copies per task (default 3)')
    parser.add_argument('--task-timeout', type=int, default=1200, help='per-task execution window, seconds (default 1200)')
    parser.add_argument('--e2e-timeout', type=int, default=5400,
                        help='whole-campaign budget from the admission clock, seconds (default 5400, the operator deadline)')
    parser.add_argument('--worker-headroom', type=int, default=0, help='extra native Machine slots to require for autoscaled workers')
    parser.add_argument('--hub-python', type=Path, help='interpreter with the agents dependencies (httpx) for Hub group publication')
    parser.add_argument('--goal', help='experiments-ledger goal for numbering and experiments/day (default original600)')
    parser.add_argument('--label', help='operator slice label for the scorecard (default: tasks file name)')
    parser.add_argument('--catalog-eligibility', choices=sorted(CATALOG_ELIGIBILITY), default='live',
                        help="'live' (default): LIVE acceptance refuses zero-spend/DEMO-replay tasks; "
                             "'ordinary': a user-requested wide run admits every cloud-runnable ready task, as the ordinary fleet does")
    args = parser.parse_args()
    if args.controllers != 'auto' and not re.fullmatch('[1-9][0-9]{0,2}', args.controllers):
        raise ValueError("--controllers must be 'auto' or a positive integer")
    os.umask(0o077)
    root = Path(__file__).resolve().parents[1]
    pins = source(root, args.source_ref)
    runner = runpy.run_path(str(root/'scripts/cloudbench-original600-runner.py'))
    runner['validate_source_members'](root, args.source_ref, pins)
    preflight = runpy.run_path(str(root/'scripts/cloudbench-operator-preflight.py'))
    explicit = [name for name in ('facts', 'snapshot_inventory', 'warm_deps') if getattr(args, name) is not None]
    if explicit and len(explicit) != 3:
        raise ValueError('pass all of --facts/--snapshot-inventory/--warm-deps, or none to discover them')
    discover = not explicit
    if args.task_ref is not None:
        if not re.fullmatch('[0-9a-f]{40}', args.task_ref):
            raise ValueError('--task-ref must be a full 40-hex commit')
        if args.task_ref == runner['TASK_REF']:
            args.task_ref = None  # the historical pin is encoded by absence
    if discover and bound_task_ref(args, runner) != args.source_ref:
        raise ValueError('discovered inputs bind the warm snapshot to this checkout: --task-ref must equal --source-ref')
    for name in ['agents_env', 'backend_env', 'tasks'] + ([] if discover else ['facts', 'snapshot_inventory', 'warm_deps']):
        path = getattr(args, name).absolute()
        preflight['private_input'](path)
        setattr(args, name, path)
    args.archive_run=[path.absolute() for path in (args.archive_run or [])]
    args.unused_reservation_run=[path.absolute() for path in args.unused_reservation_run]
    args.parked_reservation_run=[path.absolute() for path in args.parked_reservation_run]
    args.expired_reservation_run=[path.absolute() for path in args.expired_reservation_run]
    if (args.unused_reservation_run or args.parked_reservation_run or args.expired_reservation_run) and not args.archive_run:
        raise ValueError('reservation recovery requires its original predecessor archives')
    recovery=args.unused_reservation_run+args.parked_reservation_run+args.expired_reservation_run
    if len(set(recovery))!=len(recovery):
        raise ValueError('same admission cannot use multiple reservation recovery modes')
    for archive in args.archive_run + recovery:
        if archive.resolve(strict=True) != archive or not archive.is_dir():
            raise ValueError('original archive run must be a physical directory')
    manifest = task_manifest(args, root, runner)
    if (not manifest['original'] or shard_bindings(args, runner)) and (
            args.archive_run or recovery or args.resume_bound_launch or args.resume_admission
            or args.resume_incomplete_admission or args.prepare_admission_request or args.prelaunch_failure):
        raise ValueError('archived reuse and continuations run the original 200-task manifest at its original timeouts only')
    # Every mode (--check, --run and continuations) admits all copies at once:
    # refuse a width above the provider rate-limit cap before any credential,
    # Fly CLI or provider read.
    copies = simultaneous_copies(args, runner)
    capacity = runpy.run_path(str(root/'scripts/cloudbench-provider-capacity.py'))
    # Provider-scoped limits (the Tilion pilot) bind only fleets on that provider;
    # the selected backend env names it. A missing or unknown value binds all rows:
    # a nonempty unknown value makes resolve_browser_provider return None instead of
    # falling through to CLOUDBENCH_BROWSER_PROVIDER or the repo back-end/.env.
    browser_provider = (capacity['dotenv_value'](Path(args.backend_env), 'BROWSER_PROVIDER')
                        or 'unset-in-backend-env')
    try:
        refused = capacity['check'](copies, browser_provider=browser_provider)
        registry = capacity['for_browser_provider'](
            capacity['load_registry'](), capacity['resolve_browser_provider'](browser_provider))
    except capacity['RegistryError'] as error:
        raise ValueError(str(error)) from None
    if refused:
        print(json.dumps(dict(status='REFUSED_PROVIDER_RATE_LIMITS', source_ref=args.source_ref, copies=copies,
                              max_concurrent_benches=registry['cap'], provider_calls=0)))
        return refused
    if not discover:
        facts_from(runner['read'](args.facts))
    token_from_agents(runner['read'](args.agents_env))
    github = github_token(root, args.backend_env, args.agents_env)
    if args.task_ref is not None:
        pushed_task_ref(root, args.task_ref, github)
    guest_env = guest_temporal_env(root, args.agents_env, args.backend_env)  # unusable override refuses before provider reads
    if args.extra_destroying_count < 1:
        raise ValueError('conservative unlisted/destroying allowance must be at least one')
    subprocess.run([sys.executable, '-I', '-B', str(root/'scripts/cloudbench-operator-preflight.py'), '--require-flyctl'], check=True)
    version = subprocess.check_output(['flyctl', 'version'], text=True, timeout=5)
    if not re.search(r'flyctl v0\.4\.115\b', version):
        raise ValueError('original controller requires the pinned Fly CLI v0.4.115')
    if args.prelaunch_failure and not args.resume_bound_launch:
        raise ValueError('--prelaunch-failure requires --resume-bound-launch')
    if sum(bool(v) for v in (args.resume_bound_launch,args.resume_admission,args.resume_incomplete_admission,args.prepare_admission_request))>1:
        raise ValueError('select one continuation mode')
    if bool(args.resume_incomplete_admission)!=bool(args.incomplete_admission_failure):
        raise ValueError('incomplete admission requires its explicit failure receipt')
    if args.resume_incomplete_admission:
        incomplete_admission_plan(args,runner)
    if bool(args.prepare_admission_request) != bool(args.pre_reservation_failure):
        raise ValueError('request preparation requires its explicit joined failure receipt')
    if args.prepare_admission_request:
        preparation_plan(args, runner)
    bound = bound_launch_plan(args, runner) if args.resume_bound_launch else None
    if discover and (args.archive_run or recovery or bound or args.resume_admission or args.resume_incomplete_admission
                     or args.prepare_admission_request):
        raise ValueError('archived reuse and continuations bind their original explicit inputs')
    # Every guest restores this canonical base before its stack starts. A missing key
    # otherwise surfaces only after the warm refresh and every controller boot.
    seed_token = canonical_seed_token(root, args.source_ref)
    seed = canonical_seed_head(root, seed_token)
    if seed == CANONICAL_SEED_ABSENT:
        print(json.dumps(dict(status='REFUSED_CANONICAL_SEED_MISSING', source_ref=args.source_ref, token=seed_token)))
        print('❌ Missing canonical base fixture for cloud guests: ' + seed_token + '\n'
              '   This source ref\'s back-end/prisma/schema.prisma has no published PG15 base. Publish it as\n'
              '   CLAUDE.md describes: migrate the reviewed canonical fixture in an isolated PG15 database,\n'
              '   validate with scripts/validate-canonical-seed-dump.sh, save with scripts/save-seed-dump.sh,\n'
              '   put it with back-end/scripts/seed-dump-cache.ts and verify a restore/read-back.', file=sys.stderr)
        return 2
    if seed != 0:
        print('⚠️  canonical base fixture ' + seed_token + ' is unverified (cache read failed); guests still fail closed on a miss',
              file=sys.stderr)
    # Last local refusal precedes this; it is the first provider read for every mode.
    if discover:
        discovery, paths = discover_inputs(args, root, runner, token_from_agents(runner['read'](args.agents_env)), args.run)
        warm = dict(discovery.get('warm_snapshot') or {}, provider_calls=discovery['provider_calls'])
        for name, path in (paths or {}).items():
            setattr(args, name, path)
    else:
        discovery = None
        warm = warm_snapshot_preflight(runpy.run_path(str(root/'scripts/cloudbench-original-volume-capture.py'))['Fly'],
                                       token_from_agents(runner['read'](args.agents_env)), runner,
                                       runner['read'](args.warm_deps), runner['read'](args.snapshot_inventory),
                                       facts_from(runner['read'](args.facts))['protected_machines'], time.time() + 5400)
    if not args.run:
        check = dict(status='CHECKED_NOT_LAUNCHED', source_ref=args.source_ref, task_ref=bound_task_ref(args, runner),
                     uid=os.geteuid(), provider_calls=warm.pop('provider_calls'),
                     warm_snapshot=warm, infra_early_stop=args.infra_early_stop,
                     guest_temporal_namespace=guest_env['temporal_namespace'], guest_env_delivery=guest_env['delivery'])
        if discovery is not None:
            # --check never refreshes: it reports the path --run takes (reuse or refresh) and why.
            check['input_discovery'] = {k: v for k, v in discovery.items() if k not in ('warm_snapshot', 'provider_calls')}
        check.update(manifest=manifest)
        plan = None if (args.archive_run or args.resume_admission) else shard_selection(args, runner)
        if plan is not None:
            first = bound_shard(plan['shards'][0], args, runner, 'original600-check', plan['copies'], time.time())
            argv = runner['campaign_argv'](json.loads(runner['read'](args.tasks)), first['group_started_at'], first)
            check.update(shard_campaign_options=argv[2:argv.index('--e2e-started-at')], shard_bindings=shard_bindings(args, runner))
            # Each controller's volume placement: fresh-only unless it runs a snapshot-backed simulate task.
            check.update(shard_placement=[
                dict(index=item['index'], simulate_tasks=runner['shard_simulate_tasks'](root, dict(item, **shard_bindings(args, runner))),
                     **runner['shard_placement_env'](root, dict(item, **shard_bindings(args, runner))))
                for item in plan['shards']])
            check.update(controllers=plan['controllers'], copies=plan['copies'],
                         copies_per_controller_bound=plan['copies_per_controller_bound'],
                         native_slots_required=runpy.run_path(str(root/'scripts/cloudbench-shard-coordinator.py'))['capacity_demand'](
                             plan['copies'], plan['controllers'], args.worker_headroom))
        print(json.dumps(check))
        return 0
    if bound is not None:
        return resume_bound_launch(args, root, runner, bound, github)
    if args.resume_incomplete_admission:
        return resume_incomplete_admission(args,root,runner,github)
    if args.prepare_admission_request:
        return prepare_admission_request(args, root, runner)
    plan = None if (args.archive_run or args.resume_admission) else shard_selection(args, runner)
    if plan is not None:
        return sharded_run(args, root, pins, runner, github, plan, guest_env=guest_env)
    if args.task_count is not None or args.repetitions != 3 or args.controllers not in ('auto', '1'):
        raise ValueError('archived reuse and continuations run the original single-controller 200x3 shape only')
    parent = args.state_dir.absolute()
    if parent.resolve(strict=True) != parent or parent.stat().st_uid != os.geteuid() or parent.stat().st_mode & 0o077:
        raise ValueError('private physical current-owner state directory required')
    directory,started_at=open_admission(parent,args.resume_admission,admission_binding(args,runner),runner,bool(args.archive_run))
    if not 0 <= time.time()-started_at < 5400:
        raise ValueError('original campaign clock expired; retained reservations are not new launch permission')
    token = token_from_agents(runner['read'](args.agents_env))
    os.environ['FLY_API_TOKEN'] = token
    capture = runpy.run_path(str(root/'scripts/cloudbench-original-volume-capture.py'))
    snapshot=directory/('capacity-before-reservation-'+str(time.time_ns())) if args.archive_run else directory
    if snapshot != directory: snapshot.mkdir(mode=0o700)
    print(json.dumps(dict(directory=str(directory),source_ref=args.source_ref,status='ADMISSION_STARTED',resume_option='--resume-admission '+str(directory))),flush=True)
    try:
        if (directory/'archived-reuse-original.private.json').exists():
            with runner['bounded'](min(110, admission_remaining(started_at + 5400))):
                cap=capacity_snapshot(capture['Fly'],token,args.org,snapshot,args.extra_destroying_count)
        else:
            cap=capacity(capture['Fly'],token,args.org,snapshot,args.extra_destroying_count,args.archive_run,args.source_ref,args.reuse_exclude_machine,
                         facts_from(runner['read'](args.facts))['image_ref'],args.unused_reservation_run,args.parked_reservation_run,args.expired_reservation_run,
                         deadline=started_at + 5400)
        admission_remaining(started_at + 5400)
        if args.archive_run:
            cap=reserve_reuse_capacity(capture['Fly'],token,args,runner,directory,snapshot,cap,started_at)
            launch_directory=directory/('launch-'+str(time.time_ns()))
            launch_directory.mkdir(mode=0o700)
            runner['save'](launch_directory/'archived-reuse-request.private.json',json.loads(runner['read'](directory/'archived-reuse-request.private.json')))
        else:
            launch_directory=directory
        config = prepare(args, root, pins, runner, launch_directory, cap,started_at=started_at,guest_env=guest_env)
    except BaseException as error:
        print(json.dumps(dict(directory=str(directory),status='ADMISSION_PENDING',controller_started=False,
                             action=('Keep this state and use the same command with --resume-admission; never discard native reservation intents.'
                                     if args.archive_run else 'Preserve this failed admission; no controller was started.'))),file=sys.stderr,flush=True)
        if isinstance(error,AdmissionInterrupted):
            raise SystemExit(128+error.signum)
        raise
    runner['save'](directory/'controller-launch.intent.json',dict(config_path=str(config),config_sha256=digest(runner['read'](config)),run_directory=str(launch_directory/'run')))
    print(json.dumps(dict(directory=str(launch_directory),admission_directory=str(directory), source_ref=args.source_ref, status='LAUNCHING_ORIGINAL600')), flush=True)
    return runner['run'](config, digest(runner['read'](config)), launch_directory/'run', github_token=github)


if __name__ == '__main__':
    raise SystemExit(main())
