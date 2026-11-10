#!/usr/bin/env python3
"""Private owned-source environment capsules. No provider access or ambient adoption."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time

MODE = 'owned-capsule-v1'
SCHEMA = 'cloudbench-owned-env-capsule-v1'
CAPSULE_ROOT = '/data/.cloudbench-private/env'
PROVENANCE_PATHS = ('/cloudbench-execution-provenance.json', '/data/cloudbench-execution-provenance.json')
ENV_KEYS = {'AGENTS_ENV_B64', 'BACKEND_ENV_B64'}
PROVIDERS = {'tilion', 'kernel', 'steel', 'browser-use'}
BINDING_KEYS = {'owner_token', 'create_nonce', 'source_ref', 'image_ref', 'node_fingerprint', 'python_fingerprint'}
MAX_BYTES = 4 * 1024 * 1024


class CapsuleError(ValueError):
    """Payload-free refusal; never include input values in diagnostics."""


def need(condition, label):
    if not condition:
        raise CapsuleError(label)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def unique(pairs):
    value = {}
    for key, item in pairs:
        need(key not in value, 'duplicate JSON field')
        value[key] = item
    return value


def parse(raw):
    return json.loads(raw, object_pairs_hook=unique)


def hex_digest(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def read_regular(path, *, uid=None, mode=None):
    """Open every path component without following symlinks; read one stable FD."""
    path = Path(path)
    need(path.is_absolute() and '..' not in path.parts, 'absolute physical file required')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for member in path.parts[1:-1]:
            child = os.open(member, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            need(stat.S_ISREG(before.st_mode) and before.st_size <= MAX_BYTES, 'regular bounded file required')
            need(uid is None or before.st_uid == uid, 'file owner mismatch')
            need(mode is None or stat.S_IMODE(before.st_mode) == mode, 'private file mode required')
            chunks = []
            remaining = MAX_BYTES + 1
            while remaining:
                block = os.read(fd, min(65536, remaining))
                if not block:
                    break
                chunks.append(block)
                remaining -= len(block)
            after = os.fstat(fd)
            attributes = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
            need(all(getattr(before, key) == getattr(after, key) for key in attributes), 'file changed during read')
            raw = b''.join(chunks)
            need(len(raw) == before.st_size, 'file size mismatch')
            return raw
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def descriptor(value, *, private=False):
    need(isinstance(value, dict) and set(value) == {'path', 'sha256'} and hex_digest(value['sha256']), 'file descriptor required')
    raw = read_regular(value['path'], uid=os.geteuid() if private else None, mode=0o600 if private else None)
    need(sha(raw) == value['sha256'], 'descriptor bytes changed')
    return raw


def descriptor_shape(value):
    need(isinstance(value, dict) and set(value) == {'path', 'sha256'}
         and isinstance(value['path'], str) and Path(value['path']).is_absolute()
         and hex_digest(value['sha256']), 'invalid private evidence descriptor')


def dotenv_values(raw):
    values = {}
    for line in raw.decode().splitlines():
        match = re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$', line)
        if not match:
            continue
        key, value = match.groups()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '\"\'':
            value = value[1:-1]
        need(key not in values, 'duplicate dotenv assignment')
        values[key] = value
    return values


def validate_binding(value):
    need(isinstance(value, dict) and set(value) == BINDING_KEYS, 'capsule binding fields')
    for key, size in (('owner_token', 32), ('create_nonce', 32), ('source_ref', 40),
                      ('node_fingerprint', 64), ('python_fingerprint', 64)):
        need(isinstance(value[key], str) and re.fullmatch('[a-f0-9]{' + str(size) + '}', value[key]), 'capsule binding format')
    need(isinstance(value['image_ref'], str)
         and re.fullmatch(r'registry\.fly\.io/navi-whisper-lux-bench[^\s]*@sha256:[a-f0-9]{64}', value['image_ref']), 'immutable capsule image')


def validate_capsule(raw, manifest, source_ref=None):
    value = parse(raw)
    keys = {'schema', 'binding', 'env', 'guest_env_sha256', 'decoded_sha256', 'providers', 'temporal',
            'approved_inputs', 'projection', 'provider_proof'}
    need(isinstance(value, dict) and set(value) == keys and value['schema'] == SCHEMA, 'capsule schema')
    validate_binding(value['binding'])
    need(type(manifest.get('version')) is int and manifest['version'] == 2 and manifest.get('lease_protocol') == 'cloudbench-source-lease-v1'
         and manifest.get('guest_env_mode') == MODE and hex_digest(manifest.get('guest_env_capsule_sha256'))
         and sha(raw) == manifest['guest_env_capsule_sha256'], 'owned capsule mode/hash required')
    binding = value['binding']
    need(manifest.get('guest_env_capsule_binding') == binding, 'attested capsule binding required')
    source_ref = binding['source_ref'] if source_ref is None else source_ref
    need(binding['owner_token'] == manifest['owner_token'] and binding['create_nonce'] == manifest['creation_nonce']
         and binding['source_ref'] == source_ref and binding['image_ref'].rsplit('@', 1)[1] == manifest['image_digest']
         and all(binding[key] == manifest[key] for key in ('node_fingerprint', 'python_fingerprint')), 'capsule source binding differs')
    for key in ('env', 'guest_env_sha256', 'decoded_sha256'):
        need(isinstance(value[key], dict) and set(value[key]) == ENV_KEYS, 'capsule environment fields')
    need(value['guest_env_sha256'] == manifest['guest_env_sha256'], 'capsule expected environment differs')
    decoded = {}
    for key in ENV_KEYS:
        encoded = value['env'][key]
        need(isinstance(encoded, str) and encoded and hex_digest(value['guest_env_sha256'][key])
             and sha(encoded.encode()) == value['guest_env_sha256'][key], 'capsule encoded environment changed')
        decoded[key] = base64.b64decode(encoded, validate=True)
        need(decoded[key] and hex_digest(value['decoded_sha256'][key])
             and sha(decoded[key]) == value['decoded_sha256'][key], 'capsule decoded environment changed')
    providers = value['providers']
    need(isinstance(providers, dict) and set(providers) == {'backend', 'worker'}
         and all(item in PROVIDERS for item in providers.values()), 'capsule providers')
    envs = {key: dotenv_values(raw_env) for key, raw_env in decoded.items()}
    need(envs['AGENTS_ENV_B64'].get('BROWSER_PROVIDER') == providers['worker']
         and envs['BACKEND_ENV_B64'].get('BROWSER_PROVIDER') == providers['backend'], 'capsule provider projection differs')
    temporal = value['temporal']
    need(isinstance(temporal, dict) and set(temporal) == {'namespace', 'address_sha256', 'api_key_sha256', 'override_sha256'}
         and isinstance(temporal['namespace'], str) and temporal['namespace']
         and all(hex_digest(temporal[key]) for key in ('address_sha256', 'api_key_sha256', 'override_sha256')), 'capsule Temporal contract')
    for env in envs.values():
        need(env.get('TEMPORAL_ADDRESS') and env.get('TEMPORAL_API_KEY')
             and re.fullmatch(r'[A-Za-z0-9.-]+:[0-9]+', env['TEMPORAL_ADDRESS'])
             and env.get('TEMPORAL_NAMESPACE') == temporal['namespace']
             and sha(env.get('TEMPORAL_ADDRESS', '').encode()) == temporal['address_sha256']
             and sha(env.get('TEMPORAL_API_KEY', '').encode()) == temporal['api_key_sha256'], 'capsule Temporal values differ')
    need(isinstance(value['approved_inputs'], dict) and set(value['approved_inputs']) == ENV_KEYS, 'approved input fields')
    for item in value['approved_inputs'].values():
        descriptor_shape(item)
    need(isinstance(value['projection'], dict) and set(value['projection']) == {'projected', 'temporal_override', 'env_helper'}, 'projection evidence fields')
    need(set(value['projection']['projected']) == ENV_KEYS, 'projected input fields')
    for item in value['projection']['projected'].values():
        descriptor_shape(item)
    for key in ('temporal_override', 'env_helper'):
        descriptor_shape(value['projection'][key])
    descriptor_shape(value['provider_proof'])
    return value


def metadata(capsule, raw_sha):
    temporal = {key: value for key, value in capsule['temporal'].items() if key != 'namespace'}
    temporal['namespace_sha256'] = sha(capsule['temporal']['namespace'].encode())
    return dict(schema=SCHEMA, guest_env_mode=MODE, guest_env_capsule_sha256=raw_sha,
                binding=capsule['binding'], guest_env_sha256=capsule['guest_env_sha256'],
                decoded_sha256=capsule['decoded_sha256'], providers=capsule['providers'], temporal=temporal)


def guest_manifest(environ):
    env = environ
    path = env.get('CLOUDBENCH_SOURCE_MANIFEST_FILE', '')
    expected = env.get('CLOUDBENCH_SOURCE_MANIFEST_SHA256', '')
    candidates = [p for p in PROVENANCE_PATHS if os.path.lexists(p)]
    selected = env.get('CLOUDBENCH_EXECUTION_PROVENANCE_FILE', '')
    if selected in PROVENANCE_PATHS:
        need(selected in candidates, 'selected fixed execution provenance missing')
        candidates = [selected]
    else:
        need(len(candidates) <= 1, 'unambiguous fixed execution provenance required')
    provenance = parse(read_regular(candidates[0], uid=0)) if candidates else None
    if candidates:
        need(isinstance(provenance, dict) and isinstance(provenance.get('config'), dict)
             and isinstance(provenance['config'].get('values'), dict), 'fixed execution provenance object required')
    values = provenance['config']['values'] if candidates else {}
    markers = ('CLOUDBENCH_SOURCE_GUEST_ENV_MODE', 'CLOUDBENCH_SOURCE_GUEST_ENV_CAPSULE_SHA256')
    declared = values.get('base_source_guest_env_mode', 'none')
    owned = declared not in ('none', '') or any(env.get(key) not in (None, '', 'none') for key in markers)
    if not owned:
        if path:
            need(os.path.isabs(path) and hex_digest(expected), 'trusted ambient source handoff required')
            raw = read_regular(path)
            need(sha(raw) == expected, 'ambient source manifest changed')
            manifest = parse(raw)
            need(not any(key in manifest for key in ('guest_env_mode', 'guest_env_capsule_sha256', 'guest_env_capsule_binding')), 'owned mode downgrade')
        return None
    need(os.geteuid() == 0 and candidates, 'owned capsule loader requires root/provenance')
    need(path in ('/cloudbench-source-manifest.json', '/data/cloudbench-source-manifest.json')
         and hex_digest(expected) and env.get('CLOUDBENCH_SOURCE_LEASE_PROTOCOL') == 'cloudbench-source-lease-v1', 'trusted manifest handoff required')
    need(values['base_source_manifest_sha256'] == expected
         and values['base_source_lease_protocol'] == 'cloudbench-source-lease-v1'
         and declared == MODE and env.get(markers[0]) == MODE
         and values['base_source_guest_env_capsule_sha256'] == env.get(markers[1])
         and hex_digest(env.get(markers[1])), 'provenance source binding differs')
    raw_manifest = read_regular(path, uid=0)
    need(sha(raw_manifest) == expected, 'captured source manifest changed')
    manifest = parse(raw_manifest)
    need(manifest.get('guest_env_mode') == MODE and manifest.get('guest_env_capsule_sha256') == env.get(markers[1]), 'owned manifest mode differs')
    return manifest


def load_guest(environ=None):
    env = os.environ if environ is None else environ
    manifest = guest_manifest(env)
    need(manifest is not None, 'explicit owned capsule required')
    root = Path(CAPSULE_ROOT)
    for parent in (root.parent, root):
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'private capsule directory required')
    path = root / (manifest['guest_env_capsule_sha256'] + '.json')
    raw = read_regular(str(path), uid=0, mode=0o600)
    capsule = validate_capsule(raw, manifest)
    return capsule, metadata(capsule, sha(raw))


def effective_env(capsule, environ):
    env = dict(environ)
    env.update(capsule['env'])
    env.update({key.replace('_B64', '_SHA256'): value for key, value in capsule['decoded_sha256'].items()})
    env.update(CLOUDBENCH_BROWSER_PROVIDER=capsule['providers']['backend'],
               CLOUDBENCH_WORKER_BROWSER_PROVIDER=capsule['providers']['worker'])
    env['CLOUDBENCH_SOURCE_ENV_EXECUTED'] = MODE
    return env


def check_effective(environ=None):
    env = os.environ if environ is None else environ
    if guest_manifest(env) is None:
        return None  # Existing ambient/V1 guard retains its unchanged checks.
    capsule, result = load_guest(env)
    expected = effective_env(capsule, {})
    need(all(env.get(key) == value for key, value in expected.items()), 'effective owned environment differs')
    return result


def exec_guest(argv, environ=None):
    need(argv and os.path.isabs(argv[0]), 'absolute executable required')
    env = dict(os.environ if environ is None else environ)
    capsule, _ = load_guest(env)
    os.execve(argv[0], argv, effective_env(capsule, env))


def enter(argv, environ=None):
    env = os.environ if environ is None else environ
    if guest_manifest(env) is None:
        return 0
    if env.get('CLOUDBENCH_SOURCE_ENV_EXECUTED') == MODE:
        check_effective(env)
        return 0
    load_guest(env)
    return 42  # The calling shell must exec the loader; never launch a child runner.


def build(request_path, request_sha256, output):
    request_raw = read_regular(str(Path(request_path).absolute()), uid=os.geteuid(), mode=0o600)
    need(hex_digest(request_sha256) and sha(request_raw) == request_sha256, 'builder request bytes changed')
    request = parse(request_raw)
    need(set(request) == {'schema', 'binding', 'approved_inputs', 'projected_inputs', 'temporal_override',
                          'env_helper', 'provider_proof', 'not_before_epoch'}
         and request['schema'] == 'cloudbench-owned-env-build-v1', 'builder request schema')
    validate_binding(request['binding'])
    need(set(request['approved_inputs']) == ENV_KEYS and set(request['projected_inputs']) == ENV_KEYS, 'builder env descriptors')
    originals = {key: descriptor(item, private=True) for key, item in request['approved_inputs'].items()}
    projected = {key: descriptor(item, private=True) for key, item in request['projected_inputs'].items()}
    override = descriptor(request['temporal_override'], private=True)
    helper = descriptor(request['env_helper'])
    proof = parse(descriptor(request['provider_proof'], private=True))
    need(set(proof) == {'schema', 'observed_epoch', 'backend', 'worker', 'evidence'}
         and proof['schema'] == 'cloudbench-production-browser-proof-v1'
         and type(request['not_before_epoch']) is int and type(proof['observed_epoch']) is int
         and request['not_before_epoch'] <= proof['observed_epoch'] <= int(time.time())
         and proof['backend'] in PROVIDERS and proof['worker'] in PROVIDERS, 'current production browser proof required')
    need(set(proof['evidence']) == {'backend', 'worker'}, 'production proof evidence')
    for evidence in proof['evidence'].values():
        descriptor(evidence, private=True)
    with tempfile.TemporaryDirectory(prefix='owned-source-env-') as temporary:
        temporary = Path(temporary)
        for key, name in (('AGENTS_ENV_B64', 'agents.env'), ('BACKEND_ENV_B64', 'backend.env')):
            target = temporary / name
            target.write_bytes(originals[key])
            target.chmod(0o600)
        browser = temporary / 'browser'
        browser.mkdir(mode=0o700)
        destination = temporary / 'projected'
        destination.mkdir(mode=0o700)
        helper_path = temporary / 'env-helper.sh'
        helper_path.write_bytes(helper)
        helper_path.chmod(0o600)
        override_path = temporary / 'temporal.env'
        override_path.write_bytes(override)
        override_path.chmod(0o600)
        result = subprocess.run(['/bin/bash', '-euc', 'source "$1"; cloudbench_write_guest_browser_env_files "$2" "$3" "$4" "$5" "$6"; '
                                 'cloudbench_write_guest_temporal_env_files "$6/agents.env" "$6/backend.env" "$7" "$8"',
                                 'owned-source-env', str(helper_path), str(temporary / 'agents.env'),
                                 str(temporary / 'backend.env'), proof['backend'], proof['worker'], str(browser),
                                 str(override_path), str(destination)],
                                env={'PATH': '/usr/bin:/bin', 'HOME': os.environ.get('HOME', '/')},
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=False)
        need(result.returncode == 0, 'approved browser/Temporal projection refused')
        for key, name in (('AGENTS_ENV_B64', 'agents.env'), ('BACKEND_ENV_B64', 'backend.env')):
            need(read_regular(str(destination / name), uid=os.geteuid(), mode=0o600) == projected[key], 'projection changes unapproved bytes')
    agents = dotenv_values(projected['AGENTS_ENV_B64'])
    encoded = {key: base64.b64encode(value).decode() for key, value in projected.items()}
    value = dict(schema=SCHEMA, binding=request['binding'], env=encoded,
                 guest_env_sha256={key: sha(item.encode()) for key, item in encoded.items()},
                 decoded_sha256={key: sha(item) for key, item in projected.items()},
                 providers=dict(backend=proof['backend'], worker=proof['worker']),
                 temporal=dict(namespace=agents['TEMPORAL_NAMESPACE'], address_sha256=sha(agents['TEMPORAL_ADDRESS'].encode()),
                               api_key_sha256=sha(agents['TEMPORAL_API_KEY'].encode()), override_sha256=sha(override)),
                 approved_inputs=request['approved_inputs'], projection=dict(projected=request['projected_inputs'],
                    temporal_override=request['temporal_override'], env_helper=request['env_helper']), provider_proof=request['provider_proof'])
    raw = canonical(value)
    manifest = dict(version=2, lease_protocol='cloudbench-source-lease-v1', guest_env_mode=MODE,
                    guest_env_capsule_sha256=sha(raw), guest_env_sha256=value['guest_env_sha256'],
                    guest_env_capsule_binding=value['binding'],
                    owner_token=value['binding']['owner_token'], creation_nonce=value['binding']['create_nonce'],
                    image_digest=value['binding']['image_ref'].rsplit('@', 1)[1],
                    node_fingerprint=value['binding']['node_fingerprint'], python_fingerprint=value['binding']['python_fingerprint'])
    validate_capsule(raw, manifest, value['binding']['source_ref'])
    output = Path(output).absolute()
    parent = output.parent.lstat()
    need(output.parent.resolve() == output.parent and stat.S_ISDIR(parent.st_mode)
         and parent.st_uid == os.geteuid() and stat.S_IMODE(parent.st_mode) == 0o700, 'private output directory required')
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return metadata(value, sha(raw))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest='mode', required=True)
    builder = modes.add_parser('build')
    builder.add_argument('--request', required=True)
    builder.add_argument('--request-sha256', required=True)
    builder.add_argument('--output', required=True)
    modes.add_parser('validate')
    modes.add_parser('check-effective')
    modes.add_parser('mode')
    entry = modes.add_parser('enter')
    entry.add_argument('command', nargs=argparse.REMAINDER)
    execute = modes.add_parser('exec')
    execute.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        if args.mode == 'build':
            result = build(args.request, args.request_sha256, args.output)
        elif args.mode == 'validate':
            _, result = load_guest()
        elif args.mode == 'check-effective':
            check_effective()
            return 0
        elif args.mode == 'mode':
            if guest_manifest(os.environ) is None:
                print('none')
            else:
                load_guest()
                print(MODE)
            return 0
        else:
            command = args.command[1:] if args.command[:1] == ['--'] else args.command
            if args.mode == 'enter':
                return enter(command)
            else:
                exec_guest(command)
            return 0
        print(json.dumps(result, sort_keys=True))
        return 0
    except (CapsuleError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print('owned source environment refused', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
