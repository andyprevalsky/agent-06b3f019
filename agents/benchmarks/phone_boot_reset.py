"""Explicit, journaled provider reset for the fresh-phone boot benchmark.

Never called by the model or ordinary DAILY task selection. A reset erases apps,
accounts and data. A journal already submitted is observed, never resubmitted.
"""
import argparse
import asyncio
import fcntl
import hashlib
import hmac
import json
import os
import subprocess
import time
from pathlib import Path


class ResetBlocked(RuntimeError):
    pass


def _key():
    from benchmarks.logs import load_env_var
    key = load_env_var('BACKEND_API_KEY', Path(__file__).resolve().parents[2] / 'back-end/.env')
    if not key:
        raise ResetBlocked('Private reset journal key unavailable')
    return key.encode()


def _signature(data):
    return hmac.new(_key(), json.dumps(data, sort_keys=True, separators=(',', ':')).encode(), hashlib.sha256).hexdigest()


def save(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as output:
        os.chmod(temporary, 0o600)
        json.dump({'data': data, 'signature': _signature(data)}, output)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def load(path):
    try:
        envelope = json.loads(Path(path).read_text())
        data = envelope['data']
        if not hmac.compare_digest(envelope['signature'], _signature(data)):
            raise ValueError()
        return data
    except (OSError, KeyError, ValueError, TypeError):
        raise ResetBlocked('Reset journal missing or invalid') from None


async def provider(action, device):
    """Use the existing backend provider client, never expose provider output."""
    root = Path(__file__).resolve().parents[2]
    proc = await asyncio.create_subprocess_exec(
        'node', '--import', 'tsx', str(root / 'agents/benchmarks/phone_boot_reset.provider.ts'),
        cwd=root / 'back-end', stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        stdout, _ = await asyncio.wait_for(
            proc.communicate(json.dumps({'action': action, 'deviceId': device}).encode()), timeout=150,
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise ResetBlocked('Provider exchange timed out; observe without resubmitting') from None
    if proc.returncode:
        raise ResetBlocked('Provider reset/observation failed; do not repeat reset')
    marker = b'PHONE_RESET_RESULT:'
    if marker not in stdout:
        raise ResetBlocked('Provider reset receipt missing; observe without resubmitting')
    return json.loads(stdout.rsplit(marker, 1)[1])


async def start(path, device, owner, confirmation, *, call=provider, now=time.time):
    if confirmation != device or not device or not owner:
        raise ResetBlocked('Explicit erasure confirmation for this device is required')
    if Path(path).exists():
        raise ResetBlocked('Reset journal already exists; observe it instead of resetting again')
    state = await call('observe', device)
    if state.get('state') != 'available':
        raise ResetBlocked('Phone is not available; end its owned session first')
    data = {'version': 1, 'deviceId': device, 'userId': owner, 'submittedAt': now(),
            'phase': 'submitting', 'resettingObservedAt': None, 'availableAt': None,
            'providerPasscodesReportedRestored': False, 'claimedBy': None}
    # Durable intent precedes the non-idempotent request. A crash/timeout cannot
    # authorize another erasure, even if no response was recorded.
    save(path, data)
    try:
        await call('reset', device)
    except Exception:
        data['phase'] = 'unknown'
        save(path, data)
        raise
    data['phase'] = 'waiting_for_resetting'
    save(path, data)
    return data


async def observe(path, *, call=provider, now=time.time):
    data = load(path)
    state = (await call('observe', data['deviceId'])).get('state')
    if state == 'resetting':
        data['resettingObservedAt'] = data['resettingObservedAt'] or now()
        data['phase'] = 'resetting'
    elif state == 'available' and data['resettingObservedAt'] is not None:
        data['availableAt'] = data['availableAt'] or now()
        data['phase'] = 'ready' if data['providerPasscodesReportedRestored'] else 'awaiting_provider_passcodes'
    # Available without observed reset is not proof that the erasure happened.
    save(path, data)
    return data


def report_provider_ready(path):
    data = load(path)
    if data['phase'] != 'awaiting_provider_passcodes' or data['availableAt'] is None:
        raise ResetBlocked('Observe completed reset before reporting provider restoration')
    data['providerPasscodesReportedRestored'] = True
    data['phase'] = 'ready'
    save(path, data)
    return data


def validate_for_boot(path, device, owner, run_id, *, claim=False):
    if claim:
        with Path(path).with_suffix('.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            data = validate_for_boot(path, device, owner, run_id)
            data['claimedBy'] = run_id
            save(path, data)
            return data
    data = load(path)
    if not run_id or data.get('version') != 1 or data['deviceId'] != device or data['userId'] != owner or data['phase'] != 'ready' or data.get('providerPasscodesReportedRestored') is not True:
        raise ResetBlocked('Fresh boot reset/provider prerequisite does not match this run')
    if data['availableAt'] is None or data['resettingObservedAt'] is None:
        raise ResetBlocked('Reset transition was not observed')
    if not data['submittedAt'] <= data['resettingObservedAt'] <= data['availableAt'] <= time.time() or time.time() - data['availableAt'] > 86400:
        raise ResetBlocked('Reset observation is stale or out of order')
    if data['claimedBy'] not in (None, run_id):
        raise ResetBlocked('Reset belongs to a different benchmark run')
    return data


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['start', 'observe', 'provider-ready'])
    p.add_argument('--journal', type=Path, required=True)
    p.add_argument('--device', default=os.environ.get('PHONE_HARNESS_DEVICE_ID'))
    p.add_argument('--owner', default=os.environ.get('BENCHMARK_RUN_USER_ID'))
    p.add_argument('--confirm-erases-device')
    args = p.parse_args()
    args.journal.parent.mkdir(parents=True, exist_ok=True)
    with args.journal.with_suffix('.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'start':
            result = asyncio.run(start(args.journal, args.device, args.owner, args.confirm_erases_device))
        elif args.action == 'observe':
            result = asyncio.run(observe(args.journal))
        else:
            result = report_provider_ready(args.journal)
    if result['phase'] == 'awaiting_provider_passcodes':
        request = args.journal.with_suffix('.provider-request.txt')
        request.write_text(f"Hi Shawn, cloud iPhone {result['deviceId']} has completed its API reset and is available again. Please re-enable passcodes so we can validate fresh Gmail setup. Thanks.\n")
        request.chmod(0o600)
    print(json.dumps({'phase': result['phase'], 'resetObserved': result['resettingObservedAt'] is not None,
                      'providerPasscodes': 'operator_reported' if result['providerPasscodesReportedRestored'] else 'pending',
                      'note': 'Provider restoration is not proof of an enabled device passcode; boot must verify actual Settings.'}))


if __name__ == '__main__':
    try:
        main()
    except (ResetBlocked, BlockingIOError) as error:
        raise SystemExit(str(error)) from None
