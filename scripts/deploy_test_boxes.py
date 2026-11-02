#!/usr/bin/env python3
"""Staged adapter over an existing, prepared boxes.dev worker thread.

One request sends one exact deploy_test_worker.py invocation to a prepared
muted thread (`dvb-onbox threads send`, idempotency key = request token) and
collects the byte-exact native DEPLOY_GATE_RESULT document from that same turn.
The thread's model cannot summarise, waive or reshape a result: only bytes that
hash to the worker's own sha256sum are parsed. Anything else is UNVERIFIED.
This adapter never allocates devboxes, threads or services.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import time

from deploy_test_cycle import ROOT, digest, exclusive, read, write
from deploy_test_process import CANCEL, cancellation_handlers
from deploy_test_result import MAX_RECEIPT_BYTES, validate as validate_result

TRANSPORT = 'boxes-thread'
LIST_ARGV = ['threads', 'list', '--all', '--json']  # every page; the first page alone omits older threads
CLI = 'dvb-onbox'
MAX_PROMPT_BYTES = 32 * 1024  # `threads send --prompt-file` bound; the result side is bound by its sha256 only
PERMISSION_CODES = ('disabled', 'denied')
INLINE_FALLBACK_BYTES = 16 * 1024  # the worker inlines result.json only below this; attachments carry the rest
ATTACHMENTS_ROOT = Path.home() / '.devbox/desktop-attachments'  # <root>/<box>/<recipient thread>/<name>--<hash16>.<ext>
TERMINAL = {'completed', 'complete', 'done'}
PENDING = {'running', 'active', 'pending', 'queued', 'timeout', 'timed_out', 'starting'}
HEADER = 'DEPLOY_GATE_REQUEST'
BEGIN, END = 'DEPLOY_GATE_RESULT_JSON_BEGIN', 'DEPLOY_GATE_RESULT_JSON_END'
ERR_BEGIN, ERR_END = 'DEPLOY_GATE_STDERR_BEGIN', 'DEPLOY_GATE_STDERR_END'
EXIT_LINE, SHA_LINE, PGID_LINE = 'DEPLOY_GATE_WORKER_EXIT', 'DEPLOY_GATE_RESULT_SHA256', 'DEPLOY_GATE_WORKER_PGID'


def run_cli(argv, *, timeout):
    """The only dvb-onbox call site; tests put a fake executable on PATH."""
    binary = shutil.which(CLI)
    if binary is None:
        raise ValueError('dvb-onbox CLI is not available on PATH')
    done = subprocess.run([binary, *argv], capture_output=True, timeout=timeout, check=False)
    return done.returncode, done.stdout, done.stderr


def default_python(worker_root):
    return str(Path(worker_root) / 'agents/venv/bin/python')


def remote_python_ok(python, worker_root):
    return (isinstance(python, str) and python.startswith('/') and '..' not in Path(python).parts
            and Path(worker_root) in Path(python).parents)


def remote_directory(worker_root, token):
    return f'{worker_root}/.context/deploy-boxes/{token}'


def build_prompt(request, binding):
    token, root = request['token'], binding['worker_root']
    remote = remote_directory(root, token)
    body = json.dumps(request, sort_keys=True, separators=(',', ':'))
    script = '\n'.join([
        'set -eu; umask 077',
        f'cd {shlex.quote(root)} && mkdir -p {shlex.quote(remote)} && cd {shlex.quote(remote)} '
        '|| {{ echo "DEPLOY_GATE_WORKER_EXIT 3"; exit 3; }}'.replace('{{', '{').replace('}}', '}'),
        f'printf %s {shlex.quote(body)} > request.json',
        'echo "DEPLOY_GATE_WORKER_PGID $$"',
        f'DEPLOY_GATE_REQUEST="$PWD/request.json" DEPLOY_GATE_RESULT="$PWD/result.json" '
        f'DEPLOY_GATE_TOKEN={shlex.quote(token)} DEPLOY_LANE_SCOPED_REUSE=0 DEPLOY_CYCLE_FRESH=1 '
        f'{shlex.quote(binding["python"])} {shlex.quote(root + "/scripts/deploy_test_worker.py")} '
        f'--root {shlex.quote(root)} '
        '> stdout.log 2> stderr.log && rc=0 || rc=$?; echo "DEPLOY_GATE_WORKER_EXIT $rc"',
        'sum=$(sha256sum result.json | cut -d" " -f1); echo "DEPLOY_GATE_RESULT_SHA256 $sum"',
        f'dvb-onbox threads message --to {shlex.quote(binding["coordinator_thread"])} '
        '--attach "$PWD/result.json" --attach "$PWD/stderr.log" '
        f'--message "DEPLOY_GATE_RESULT token={token} sha256=$sum exit=$rc" '
        f'--idempotency-key {shlex.quote(token + "-result")} --json || true',
        f'if [ "$(wc -c < result.json)" -le {INLINE_FALLBACK_BYTES} ]; then echo {BEGIN}; cat result.json; echo {END}; fi',
        f'echo {ERR_BEGIN}; cat stderr.log; echo {ERR_END}',
    ])
    return '\n'.join([
        f"{HEADER} token={token} gate={request['gate']} head={request['source']['head']} "
        f"host={binding['worker_host']} root={root}",  # informational; identity is platform-authored
        'Run the script below exactly once on this devbox, unchanged. Do not edit, retry, '
        'summarise, interpret or waive anything.',
        '```sh', script, '```',
        'Final reply: the complete stdout of that script, verbatim. Nothing else.', ''])


def _status(data):
    value = data.get('status')
    return value if isinstance(value, str) else None


def _turn(data):
    value = data.get('turnId')
    return value if isinstance(value, str) and value else None


def cli_error(out, err):
    """Typed dvb-onbox failure: {"ok":false,"error":{"code":…,"message":…}} on stdout or stderr."""
    for raw in (out, err):
        try:
            payload = json.loads(raw.decode())
        except (ValueError, UnicodeDecodeError):
            continue
        if isinstance(payload, dict) and payload.get('ok') is False:
            error = payload.get('error') if isinstance(payload.get('error'), dict) else payload
            return str(error.get('code') or error.get('status') or ''), raw.decode(errors='replace')
    return '', (out + err).decode(errors='replace')


def _envelope(stdout):
    """dvb-onbox --json: {"schemaVersion":1,"ok":true,"data":{...}}; data is the only payload."""
    payload = json.loads(stdout.decode())
    if not isinstance(payload, dict) or payload.get('ok') is not True or not isinstance(payload.get('data'), dict):
        raise ValueError('CLI did not return an ok JSON envelope')
    return payload['data']


def _send_envelope(stdout, binding):
    """Control mutations return top-level receipts, unlike read/result APIs."""
    payload = json.loads(stdout.decode())
    if (not isinstance(payload, dict) or payload.get('ok') is not True
            or payload.get('operation') != 'send'
            or payload.get('threadId') != binding['worker_thread']
            or payload.get('disposition') not in {'started', 'queued'}):
        raise ValueError('CLI did not accept the send for the bound worker thread')
    return payload


def _same_host(data, binding):
    if data.get('executionInstanceId') != binding['worker_host']:
        raise ValueError('platform reports a different devbox than the isolation binding')
    return data


def resolve_host(entries, binding):
    """threads list --json: data.threads[] rows bind clientThreadId to executionInstanceId."""
    rows = [t for t in entries.get('threads', []) if isinstance(t, dict)
            and t.get('clientThreadId') == binding['worker_thread']]
    if len(rows) != 1:
        raise ValueError('prepared worker thread is not listed exactly once')
    if rows[0].get('executionInstanceId') != binding['worker_host']:
        raise ValueError('prepared worker thread runs on a different devbox than the isolation binding')
    return rows[0]


def _find_turn(value, token):
    """Locate the saved assignment message for this exact token in a transcript."""
    if isinstance(value, dict):
        marker = f'{HEADER} token={token} '
        if any(isinstance(v, str) and marker in v for v in value.values()):
            turn = _turn(value)
            if turn:
                return turn
        for child in value.values():
            found = _find_turn(child, token)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_turn(child, token)
            if found:
                return found
    return None


def parse_reply(text):
    """Framing lines are transport only; the bytes between the JSON markers must hash exactly."""
    lines = text.split('\n')
    fields = {}
    for line in lines:
        for key in (EXIT_LINE, SHA_LINE, PGID_LINE):
            if line.startswith(key + ' ') and key not in fields:
                fields[key] = line[len(key) + 1:].strip()
    if BEGIN in lines and END in lines and lines.index(BEGIN) < lines.index(END):
        segment = '\n'.join(lines[lines.index(BEGIN) + 1:lines.index(END)])
    else:
        segment = None
    if ERR_BEGIN in lines and ERR_END in lines and lines.index(ERR_BEGIN) < lines.index(ERR_END):
        stderr = '\n'.join(lines[lines.index(ERR_BEGIN) + 1:lines.index(ERR_END)])
    else:
        stderr = None
    declared = fields.get(SHA_LINE, '')
    if len(declared) != 64 or any(c not in '0123456789abcdef' for c in declared):
        raise ValueError('reply lacks the worker-computed result sha256')
    exact = None
    for candidate in ([] if segment is None else (segment, segment + '\n', segment.rstrip('\n') + '\n')):
        if hashlib.sha256(candidate.encode()).hexdigest() == declared:
            exact = candidate
            break
    if EXIT_LINE not in fields or not fields[EXIT_LINE].isdigit():
        raise ValueError('reply lacks the native worker exit code')
    pgid = fields.get(PGID_LINE)
    return (exact, int(fields[EXIT_LINE]), declared, stderr,
            int(pgid) if pgid and pgid.isdigit() else None)


def attachment_directories(binding):
    root = Path(os.environ.get('DEPLOY_BOXES_ATTACHMENTS_ROOT') or ATTACHMENTS_ROOT)
    return sorted(p for p in root.glob('*/' + binding['coordinator_thread']) if p.is_dir())


def find_attachment(binding, declared, not_before):
    """First delivered copy whose bytes hash to the worker-declared sha256; never trimmed or repaired."""
    for directory in attachment_directories(binding):
        # Native attachment delivery retains the stem, not the extension:
        # result.json becomes result--<id>.json. Keep the former spelling as
        # a compatibility input; the full content hash remains authoritative.
        candidates = set(directory.glob('result--*.json')) | set(directory.glob('result.json--*.json'))
        for path in sorted(candidates):
            try:
                if path.stat().st_mtime < not_before - 1 or path.stat().st_size > MAX_RECEIPT_BYTES:
                    continue
                data = path.read_bytes()
            except OSError:
                continue
            if hashlib.sha256(data).hexdigest() == declared:
                return path, data
    return None, None


def parse_terminal(data, binding):
    _same_host(data, binding)
    if _status(data) not in TERMINAL:
        raise ValueError('thread result is not terminal')
    output = data.get('output') if isinstance(data.get('output'), dict) else {}
    if output.get('truncated') is True:
        raise ValueError('thread result payload is truncated')
    text = output.get('text')
    if not isinstance(text, str):
        raise ValueError('thread result has no final text')
    return parse_reply(text)


def collect_result(data, binding, *, not_before, deadline_at, poll, directory):
    inline, native_exit, declared, stderr, pgid = parse_terminal(data, binding)
    while True:
        path, raw = find_attachment(binding, declared, not_before)
        if raw is not None:
            exact, source = raw, 'attachment:' + str(path)
            break
        if inline is not None:
            exact, source = inline.encode(), 'inline-markers'
            break
        if CANCEL.is_set() or time.time() >= deadline_at:
            raise ValueError('attachment_missing')
        time.sleep(poll)
    if len(exact) > MAX_RECEIPT_BYTES:
        raise ValueError('worker receipt exceeds transport limit')
    copy = directory / 'native-result.json'
    copy.write_bytes(exact)  # byte-exact copy before any validation
    document = json.loads(exact.decode())
    if not isinstance(document, dict):
        raise ValueError('native result is not a JSON object')
    return document, native_exit, declared, stderr, pgid, source


def unverified(request, binding, state, reason, *, stderr=None, cleanup_owner=None, pgid=None):
    result = {k: request[k] for k in ('token', 'source', 'gate')}
    result.update(cases=dict.fromkeys(request['checks'], 'UNVERIFIED'), complete=False,
                  cleanup_complete=False, reused=False, evidence={}, reason=reason,
                  worker_stderr=stderr, transport_receipt=receipt(binding, state, None, None, None))
    if cleanup_owner:
        result['cleanup_owner'] = {'worker_thread': binding['worker_thread'], 'worker_host': binding['worker_host'],
                                   'worker_root': binding['worker_root'], 'request_token': request['token'],
                                   'message_id': state.get('message_id'), 'turn_id': state.get('turn_id'),
                                   'remote_dir': remote_directory(binding['worker_root'], request['token']),
                                   'pgid': pgid}
    return result


def receipt(binding, state, native_sha, canonical_sha, native_exit, source=None):
    return {'transport': TRANSPORT, 'worker_thread': binding['worker_thread'],
            'worker_host': binding['worker_host'], 'worker_root': binding['worker_root'],
            'remote_python': binding['python'], 'coordinator_thread': binding['coordinator_thread'],
            'request_token': state['token'], 'idempotency_key': state['idempotency_key'],
            'message_id': state.get('message_id'), 'turn_id': state.get('turn_id'),
            'native_sha256': native_sha, 'canonical_sha256': canonical_sha, 'native_exit': native_exit,
            'result_source': source, 'stderr_log': state.get('stderr_log'), 'cli_log': state.get('cli_log')}


def execute(request, root, binding, deadline_seconds):
    if (type(deadline_seconds) not in (int, float) or not math.isfinite(deadline_seconds)
            or deadline_seconds <= 0):
        raise ValueError('boxes-thread transport requires its existing gate deadline')
    checks = request['checks']
    if not checks or len(set(checks)) != len(checks) or set(checks) & set(request.get('skips', {})):
        raise ValueError('invalid boxes-thread case inventory')
    if request.get('worker_root') != binding['worker_root'] or 'worker_recipe' not in request:
        raise ValueError('request is not bound to the prepared worker root and recipe')
    if not remote_python_ok(binding['python'], binding['worker_root']):
        raise ValueError('remote python must be an absolute interpreter inside the prepared worker root')
    directory = root / '.context/deploy-boxes' / hashlib.sha256(request['token'].encode()).hexdigest()
    prompt = build_prompt(request, binding)
    prompt_sha = hashlib.sha256(prompt.encode()).hexdigest()
    poll = float(os.environ.get('DEPLOY_BOXES_POLL_SECONDS', '5'))
    with exclusive(directory):
        log = (directory / 'cli.log').open('ab')
        state_path = directory / 'state.json'
        state = read(state_path) if state_path.exists() else {
            'token': request['token'], 'idempotency_key': request['token'], 'prompt_sha256': prompt_sha,
            'thread': binding['worker_thread'], 'host': binding['worker_host'],
            'worker_root': binding['worker_root'], 'deadline_at': time.time() + deadline_seconds,
            'sent_attempted_at': None, 'turn_id': None, 'message_id': None,
            'cli_log': str(directory / 'cli.log'), 'stderr_log': str(directory / 'stderr.log')}
        (directory / 'prompt.txt').write_text(prompt)
        try:
            with cancellation_handlers():
                result = _drive(request, binding, state, state_path, prompt, prompt_sha, log, poll, directory)
        finally:
            log.close()
        write(directory / 'result.json', result)
        return result


def _cli(argv, state, log, timeout):
    log.write((shlex.join(argv) + '\n').encode())
    code, out, err = run_cli(argv, timeout=timeout)
    log.write(out + b'\n')
    if err:
        with open(state['stderr_log'], 'ab') as stream:
            stream.write(err)
    return code, out, err


def _drive(request, binding, state, state_path, prompt, prompt_sha, log, poll, directory):
    thread, token = binding['worker_thread'], request['token']
    if (state['token'], state['thread'], state['worker_root']) != (token, thread, binding['worker_root']):
        return unverified(request, binding, state, 'saved transport state belongs to a different binding')
    if state['prompt_sha256'] != prompt_sha:
        return unverified(request, binding, state, 'prompt changed under an already attempted request token')
    if len(prompt.encode()) > MAX_PROMPT_BYTES:
        return unverified(request, binding, state, f'prompt exceeds the {MAX_PROMPT_BYTES} byte send bound')
    def remaining():
        return state['deadline_at'] - time.time()
    try:
        if state.get('turn_id') is None:
            code, out, err = _cli(LIST_ARGV, state, log, max(1, remaining()))
            if code != 0:
                return unverified(request, binding, state, f'threads list exited {code}',
                                  stderr=err.decode(errors='replace'))
            inventory = _envelope(out)
            pagination = inventory.get('pagination')
            if isinstance(pagination, dict) and pagination.get('complete') is False:
                # Never resolve a host from a partial page: an old worker thread may sit on page 2.
                return unverified(request, binding, state, 'thread_inventory_incomplete')
            resolve_host(inventory, binding)
        while state.get('turn_id') is None and state.get('sent_attempted_at') is not None:
            # Indeterminate earlier send: only adopt the existing turn; never start another attempt.
            code, out, _ = _cli(['threads', 'read', '--thread', thread, '--turns', '100', '--json'],
                                state, log, max(1, remaining()))
            if code == 0:
                state['turn_id'] = _find_turn(_same_host(_envelope(out), binding), token)
                write(state_path, state)
            if state.get('turn_id') is None:
                if CANCEL.is_set() or remaining() <= 0:
                    return unverified(request, binding, state, 'send_indeterminate_unadopted', cleanup_owner=True)
                time.sleep(min(poll, max(0, remaining())))
        if state.get('turn_id') is None:
            if state.get('sent_attempted_at') is None:
                state['sent_attempted_at'] = time.time()
                write(state_path, state)  # persisted BEFORE the CLI call
            code, out, err = _cli(['threads', 'send', '--thread', thread, '--prompt-file',
                                   str(directory / 'prompt.txt'), '--delivery', 'next',
                                   '--idempotency-key', state['idempotency_key'], '--json'],
                                  state, log, max(1, remaining()))
            if code != 0:
                typed, text = cli_error(out, err)
                denied = any(word in typed.lower() for word in PERMISSION_CODES)
                result = unverified(request, binding, state,
                                    'transport_permission_denied' if denied else f'threads send exited {code}',
                                    stderr=err.decode(errors='replace'))
                result['transport_receipt']['cli_error'] = {'code': typed, 'text': text}
                return result
            payload = _send_envelope(out, binding)
            state['message_id'] = payload.get('messageId') or payload.get('requestId')
            state['turn_id'] = _turn(payload)
            write(state_path, state)
            if state['turn_id'] is None:
                code, out, _ = _cli(['threads', 'read', '--thread', thread, '--turns', '100', '--json'],
                                    state, log, max(1, remaining()))
                state['turn_id'] = _find_turn(_same_host(_envelope(out), binding), token) if code == 0 else None
                write(state_path, state)
            if state['turn_id'] is None:
                return unverified(request, binding, state, 'delivered send has no locatable turn',
                                  cleanup_owner=True)
        while True:
            if CANCEL.is_set():
                return unverified(request, binding, state, 'adapter cancelled while the turn ran',
                                  cleanup_owner=True)
            if remaining() <= 0:
                return unverified(request, binding, state, 'original deadline passed before a terminal turn',
                                  cleanup_owner=True)
            code, out, err = _cli(['threads', 'wait', thread, '--turn', state['turn_id'], '--timeout',
                                   f'{max(1, int(min(remaining(), 300)))}s', '--json'],
                                  state, log, max(1, remaining()) + 30)
            status = _status(_same_host(_envelope(out), binding)) if code == 0 else None
            if status in TERMINAL:
                break
            if code != 0 or status in PENDING or status is None:
                time.sleep(min(poll, max(0, remaining())))
                continue
            return unverified(request, binding, state, f'turn ended without a result: {status}',
                              stderr=err.decode(errors='replace'), cleanup_owner=True)
        code, out, err = _cli(['threads', 'result', thread, '--turn', state['turn_id'], '--json'],
                              state, log, max(1, remaining()) + 30)
        if code != 0:
            return unverified(request, binding, state, f'threads result exited {code}',
                              stderr=err.decode(errors='replace'), cleanup_owner=True)
        document, native_exit, native_sha, stderr, pgid, source = collect_result(
            _envelope(out), binding, not_before=state['sent_attempted_at'] or 0,
            deadline_at=state['deadline_at'], poll=poll, directory=directory)
        if stderr:
            with open(state['stderr_log'], 'a') as stream:
                stream.write(stderr)
        validate_result(document, request, native_exit)
        if document.get('worker_root') != binding['worker_root']:
            raise ValueError('worker execution root differs from its isolation binding')
        document['transport_receipt'] = receipt(binding, state, native_sha, digest(document), native_exit, source)
        document['transport_receipt']['pgid'] = pgid
        return document
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        return unverified(request, binding, state, str(error),
                          cleanup_owner=state.get('sent_attempted_at') is not None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--thread', required=True)
    parser.add_argument('--host', required=True)
    parser.add_argument('--worker-root', required=True)
    parser.add_argument('--python', required=True, help='remote interpreter inside the worker root')
    parser.add_argument('--coordinator-thread', required=True, help='this control thread; receives result.json attachments')
    parser.add_argument('--deadline-seconds', type=float)
    args = parser.parse_args()
    try:
        if args.deadline_seconds is None:
            raise ValueError('boxes-thread transport requires its existing gate deadline')
        binding = {'worker_thread': args.thread, 'worker_host': args.host,
                   'worker_root': args.worker_root, 'python': args.python,
                   'coordinator_thread': args.coordinator_thread}
        result = execute(read(Path(os.environ['DEPLOY_GATE_REQUEST'])), args.root.resolve(), binding,
                         args.deadline_seconds)
        write(Path(os.environ['DEPLOY_GATE_RESULT']), result)
        return 0 if all(v == 'PASS' for v in result['cases'].values()) else 1
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'DEPLOY_BOXES BLOCKED: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
