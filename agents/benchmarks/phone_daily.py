"""Daily phone acceptance contracts; no credentials, device allocation or live calls.

Only a trusted persisted-record collector may construct input evidence. This pure
checker is not an attestation verifier and must never consume model/task JSON.
Unimplemented challenge/transport collectors fail closed in the probe.
"""
from typing import Any

TASK_KINDS = {
    'phone-daily-full-boot': 'boot',
    'phone-daily-sms-challenge': 'sms',
    'phone-daily-google-approval': 'google',
    'browser-auth-doordash-cloud-iphone': 'google',
    'phone-daily-message-roundtrip': 'messages',
}
CONFIG_TARGETS = ('apple_account', 'icloud_messages', 'icloud_keychain', 'icloud_contacts',
                  'imessage', 'receive_address', 'portrait_lock', 'gmail')


def evaluate_phone_daily(kind: str, proof: Any, *, user_id: str, root_agent_id: str, device_id: str) -> dict:
    """Return only constant public verdicts; never echo private observation/code data."""
    def invalid():
        return {'passed': False, 'error': 'phone_daily_evidence_invalid'}
    if kind not in TASK_KINDS.values() or not isinstance(proof, dict):
        return invalid()
    if not all((user_id, root_agent_id, device_id)) or any(proof.get(k) != value for k, value in
            [('kind', kind), ('source', 'owned-persisted-phone-v1'), ('userId', user_id),
             ('rootAgentId', root_agent_id), ('deviceId', device_id), ('actor', 'agent')]):
        return invalid()
    if proof.get('current') is not True or proof.get('attentionCount') != 0:
        return invalid()
    ids = proof.get('operationIds')
    if not isinstance(ids, list) or not ids or any(not isinstance(i, str) or not i for i in ids) or len(ids) != len(set(ids)):
        return invalid()
    if kind == 'boot':
        boot = proof.get('boot')
        if not isinstance(boot, dict) or boot.get('requirementsVersion') != 6 or boot.get('current') is not True or boot.get('configurationReady') is not True:
            return invalid()
        checks = boot.get('checks')
        if not isinstance(checks, dict):
            return invalid()
        def confirmed(target):
            value = checks.get(target)
            return isinstance(value, dict) and value.get('status') == 'confirmed' and value.get('current') is True
        disposition = boot.get('securityDisposition')
        alternative = 'device_passcode' if disposition == 'passcode_enabled' else 'google_passcode_exception' if disposition == 'authorized_google_exception' else None
        if alternative is None or not all(confirmed(t) for t in (*CONFIG_TARGETS, alternative)):
            return invalid()
        # A retained-state audit is never evidence of a fresh unattended boot.
        if boot.get('freshProviderResetVerified') is not True or boot.get('agentPerformedBoot') is not True or boot.get('savedCredentialSafetyVerified') is not True:
            return invalid()
    else:
        section = proof.get({'sms': 'challenge', 'google': 'google', 'messages': 'messages'}[kind])
        if not isinstance(section, dict):
            return invalid()
        required = {
            'sms': ('accountMatches', 'recipientMatches', 'fresh', 'unused', 'taskMatches', 'ordered', 'receivedOnCloudPhone', 'agentInputSucceeded', 'targetContinuationVerified'),
            'google': ('freshBrowser', 'currentChallengeMatches', 'cloudApprovalSucceeded', 'browserContinuationVerified', 'authenticatedAccountMatches'),
            'messages': ('approvedIntentMatches', 'durableSentReceipt', 'independentRecipientReceipt', 'independentIncomingReceipt', 'uniqueRunMarkerMatches', 'ordered'),
        }[kind]
        if any(section.get(field) is not True for field in required):
            return invalid()
        if kind == 'sms' and not isinstance(section.get('challengeId'), str):
            return invalid()
    return {'passed': True, 'error': None}


class PhoneDailyConfigurationError(RuntimeError):
    """No paid execution until trusted live fixture/collector contracts exist."""


def preflight_daily(task_name: str, base_url: str, user_id: str) -> None:
    """Runner hook BEFORE any agent/fixture allocation. Never reads secrets.

    No env value, model output or signed-looking JSON can activate an absent
    collector. This deliberate gate is removed per task only with owning tests
    for an actual independent issuer/reset/receipt integration.
    """
    from urllib.parse import urlsplit
    if task_name not in TASK_KINDS:
        raise PhoneDailyConfigurationError('Unknown daily phone task')
    url = urlsplit(base_url)
    if url.hostname not in {'localhost', '127.0.0.1'} or url.username or url.password or not user_id:
        raise PhoneDailyConfigurationError('Daily phone requires isolated owned backend')
    gaps = {
        'boot': 'fresh provider-reset attestation and private setup-profile provisioning',
        'sms': 'independent challenge issuer and persisted target continuation',
        'google': 'multi-realm fresh browser and persisted approval-to-target binding',
        'messages': 'independent recipient/inbound receipt and durable run marker',
    }
    if TASK_KINDS[task_name] in {'google', 'messages'}:
        import os
        if os.environ.get('BENCHMARK_ISOLATED_RUN', '').lower() in {'1', 'true'} and os.environ.get('PHONE_HARNESS_DEVICE_ID'):
            return
    raise PhoneDailyConfigurationError('phone_daily_configuration_unavailable: ' + gaps[TASK_KINDS[task_name]])


def evaluate_daily(task_name: str, base_url: str = "", user_id: str = "", root_agent_id: str = "", database_url: str = "") -> tuple[bool, str, dict]:
    """Fail closed if called without the not-yet-implemented private collector.

    Deliberately does NOT accept a proof argument. A future collector must query
    owned rows itself; pure evaluate_phone_daily is only its internal checker.
    """
    if not all(isinstance(value, str) for value in (task_name, base_url, user_id, root_agent_id, database_url)):
        raise PhoneDailyConfigurationError('Caller proof is not a collector configuration')
    if task_name not in TASK_KINDS:
        raise PhoneDailyConfigurationError('Unknown daily phone task')
    if TASK_KINDS[task_name] in {'google', 'messages'}:
        proof = collect_boot_audit(base_url, user_id, root_agent_id, database_url, mode=TASK_KINDS[task_name])
        return proof.get('passed') is True, None if proof.get('passed') is True else 'phone_daily_persisted_evidence_missing', proof
    return False, 'phone_daily_configuration_unavailable', {
        'passed': False, 'kind': TASK_KINDS[task_name], 'unexercised': True,
        'reason': 'trusted_live_collector_unavailable',
    }


def collect_boot_audit(base_url: str, user_id: str, root_agent_id: str, database_url: str, *, mode: str = "boot") -> dict:
    """Runnable private DB adapter; retained audit does not pass fresh-boot task."""
    import json
    import os
    import subprocess
    from pathlib import Path
    from urllib.parse import urlsplit

    from benchmarks.logs import load_env_var
    if urlsplit(base_url).hostname not in {"localhost", "127.0.0.1"}:
        raise PhoneDailyConfigurationError("Daily collector requires isolated local backend")
    url = urlsplit(database_url)
    if url.hostname not in {"localhost", "127.0.0.1"} or not url.path.startswith("/victoria_bench_"):
        raise PhoneDailyConfigurationError("Daily collector requires owned benchmark DB")
    root = Path(__file__).resolve().parents[2]
    env = dict(os.environ)
    env.update(DATABASE_URL=database_url, DIRECT_URL=database_url,
               PHONE_BENCH_USER_ID=user_id, PHONE_BENCH_AGENT_ID=root_agent_id, PHONE_BENCH_MODE=mode)
    env.pop("PHONE_HARNESS_API_KEY", None)
    key = load_env_var("CLAUDE_CREDENTIAL_DECRYPTION_KEY", root / "back-end/.env")
    if not key:
        raise PhoneDailyConfigurationError("Private collector envelope key unavailable")
    env["CLAUDE_CREDENTIAL_DECRYPTION_KEY"] = key
    result = subprocess.run(["node", "--import", "tsx", str(root / "agents/benchmarks/phone_daily.probe.ts")],
                            cwd=root / "back-end", env=env, capture_output=True, text=True, timeout=30, check=False)
    if result.returncode:
        raise PhoneDailyConfigurationError("Private daily collector failed")
    return json.loads(result.stdout)


async def collect_sms_evidence(base_url: str, user_id: str, root_agent_id: str,
                             database_url: str, manifest: dict, headers: dict) -> tuple[bool, str | None, dict]:
    """Fetch the trusted internal issuer report; never accept a caller proof/report."""
    import json
    import os
    import subprocess
    from pathlib import Path

    # Validate loopback DB/backend before fetching anything or loading envelope key.
    from urllib.parse import urlsplit

    from benchmarks.auth_test_site import fetch_report
    from benchmarks.logs import load_env_var
    if urlsplit(base_url).hostname not in {'localhost', '127.0.0.1'} or urlsplit(database_url).hostname not in {'localhost', '127.0.0.1'} or not urlsplit(database_url).path.startswith('/victoria_bench_'):
        raise PhoneDailyConfigurationError('Daily SMS requires isolated owned backend')
    if manifest.get('scenario') != 'phone_sms_otp' or not manifest.get('siteId'):
        raise PhoneDailyConfigurationError('Daily SMS trusted site fixture missing')
    report = await fetch_report(base_url, headers, manifest['siteId'])
    root = Path(__file__).resolve().parents[2]
    env = dict(os.environ)
    env.update(DATABASE_URL=database_url, DIRECT_URL=database_url, PHONE_BENCH_USER_ID=user_id,
               PHONE_BENCH_AGENT_ID=root_agent_id, PHONE_BENCH_MODE='sms')
    env.pop('PHONE_HARNESS_API_KEY', None)
    for key in ('CLAUDE_CREDENTIAL_DECRYPTION_KEY', 'BACKEND_API_KEY'):
        value = load_env_var(key, root / 'back-end/.env')
        if not value:
            raise PhoneDailyConfigurationError('Daily SMS private collector configuration missing')
        env[key] = value
    result = subprocess.run(['node', '--import', 'tsx', str(root / 'agents/benchmarks/phone_daily.probe.ts')], cwd=root / 'back-end', env=env,
                            input=json.dumps(report), text=True, capture_output=True, timeout=30, check=False)
    if result.returncode:
        return False, 'phone_daily_private_collector_failed', {'passed': False}
    proof = json.loads(result.stdout)
    return proof.get('passed') is True, None if proof.get('passed') is True else 'phone_daily_sms_evidence_missing', proof


async def apply_daily_fixture(task_name: str, base_url: str, user_id: str, backend_key: str, database_url: str = "") -> dict:
    """Bind dedicated phone only after normal live overlay and explicit preflight."""
    import os

    import httpx
    preflight_daily(task_name, base_url, user_id)
    async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
        response = await client.put(base_url.rstrip('/') + '/api/iphone/device',
            headers={'X-API-Key': backend_key, 'X-User-Id': user_id},
            json={'providerDeviceId': os.environ['PHONE_HARNESS_DEVICE_ID']})
    if response.status_code not in (200, 201):
        raise PhoneDailyConfigurationError('Daily dedicated phone binding rejected')
    # Existing profile must be provisioned by the trusted fixture owner; this
    # adapter never overwrites an account profile or resets its revision blindly.
    # Fresh initial bindings cannot silently proceed with invented identities.
    async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
        capability = await client.get(base_url.rstrip('/') + '/api/iphone/capability', headers={'X-API-Key': backend_key, 'X-User-Id': user_id})
    if capability.status_code != 200 or capability.json().get('enabled') is not True or capability.json().get('configured') is not True:
        raise PhoneDailyConfigurationError('Daily phone profile/device configuration unavailable')
    await configure_daily_profile(base_url, user_id, backend_key, database_url)
    return {'configured': True, 'kind': TASK_KINDS[task_name]}


async def cleanup_daily_phone(base_url: str, user_id: str, root_agent_id: str,
                              database_url: str, backend_key: str) -> dict:
    """Exact-root release, confirmation required. Raises to retain DB on failure."""
    import asyncio
    import json
    import os
    import subprocess
    import time
    from pathlib import Path
    from urllib.parse import urlsplit

    import httpx
    if urlsplit(base_url).hostname not in {'localhost', '127.0.0.1'} or urlsplit(database_url).hostname not in {'localhost', '127.0.0.1'} or not urlsplit(database_url).path.startswith('/victoria_bench_'):
        raise PhoneDailyConfigurationError('Daily cleanup requires owned isolated backend')
    env = dict(os.environ)
    env.update(DATABASE_URL=database_url, DIRECT_URL=database_url, PHONE_BENCH_USER_ID=user_id,
               PHONE_BENCH_AGENT_ID=root_agent_id, PHONE_BENCH_MODE='cleanup')
    env.pop('PHONE_HARNESS_API_KEY', None)
    root = Path(__file__).resolve().parents[2]
    deadline = time.monotonic() + 90
    async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
        while time.monotonic() < deadline:
            result = await asyncio.to_thread(subprocess.run, ['node', '--import', 'tsx', str(root / 'agents/benchmarks/phone_daily.probe.ts')], cwd=root / 'back-end', env=env, capture_output=True, text=True, timeout=20, check=False)
            if result.returncode:
                raise PhoneDailyConfigurationError('Daily cleanup ownership probe failed; retain database')
            proof = json.loads(result.stdout)
            if proof.get('foreignLive'):
                raise PhoneDailyConfigurationError('Foreign phone custody; retain database')
            leases = proof.get('leases', [])
            if proof.get('idle') and all(lease['status'] not in {'ACTIVE', 'WAITING'} for lease in leases):
                return {'clean': True}
            for lease in leases:
                response = await client.post(base_url.rstrip('/') + '/api/iphone/leases/' + lease['id'] + '/release', headers={'X-API-Key': backend_key, 'X-User-Id': user_id}, json={})
                if response.status_code != 200:
                    raise PhoneDailyConfigurationError('Daily phone release failed; retain database')
            await asyncio.sleep(0.5)
    raise PhoneDailyConfigurationError('Daily provider cleanup unconfirmed; retain database')


async def evaluate_sms_daily(base_url: str, user_id: str, root_agent_id: str,
                             database_url: str, manifest: dict, headers: dict) -> tuple[bool, str | None, dict]:
    """Carrier evidence required; canonical benchmark SMS mock cannot prove LIVE."""
    return await collect_sms_evidence(base_url, user_id, root_agent_id, database_url, manifest, headers)


def load_daily_profile() -> dict:
    """Runtime-only private file; never returns it in public fixture artifacts."""
    import json
    import os
    from pathlib import Path
    source = os.environ.get('PHONE_DAILY_PROFILE_FILE')
    try:
        if not source:
            raise ValueError()
        value = json.loads(Path(source).read_text())
        if not isinstance(value, dict) or set(value) - {'expectedAppleIdentity', 'expectedGoogleIdentity', 'allowGooglePasscodeException'}:
            raise ValueError()
        for key in ('expectedAppleIdentity', 'expectedGoogleIdentity'):
            if not isinstance(value.get(key), str) or not value[key].strip() or len(value[key]) > 512:
                raise ValueError()
        if 'allowGooglePasscodeException' in value and not isinstance(value['allowGooglePasscodeException'], bool):
            raise ValueError()
        return {**value, 'allowGooglePasscodeException': value.get('allowGooglePasscodeException', False)}
    except (OSError, ValueError, TypeError):
        raise PhoneDailyConfigurationError('Private daily setup profile missing or invalid') from None


async def configure_daily_profile(base_url: str, user_id: str, backend_key: str, database_url: str, *, client=None) -> dict:
    import asyncio
    import json
    import os
    import subprocess
    from pathlib import Path
    from urllib.parse import urlsplit

    import httpx

    from benchmarks.logs import load_env_var
    if urlsplit(base_url).hostname not in {'localhost', '127.0.0.1'} or urlsplit(database_url).hostname not in {'localhost', '127.0.0.1'} or not urlsplit(database_url).path.startswith('/victoria_bench_'):
        raise PhoneDailyConfigurationError('Private profile requires owned isolated backend')
    profile = load_daily_profile()
    root = Path(__file__).resolve().parents[2]
    env = dict(os.environ)
    env.update(DATABASE_URL=database_url, DIRECT_URL=database_url, PHONE_BENCH_USER_ID=user_id,
               PHONE_BENCH_AGENT_ID='profile', PHONE_BENCH_MODE='profile')
    env.pop('PHONE_HARNESS_API_KEY', None)
    key = load_env_var('CLAUDE_CREDENTIAL_DECRYPTION_KEY', root / 'back-end/.env')
    if not key:
        raise PhoneDailyConfigurationError('Private profile envelope key unavailable')
    env['CLAUDE_CREDENTIAL_DECRYPTION_KEY'] = key
    result = await asyncio.to_thread(subprocess.run, ['node', '--import', 'tsx', str(root / 'agents/benchmarks/phone_daily.probe.ts')], cwd=root / 'back-end', env=env, input=json.dumps(profile), capture_output=True, text=True, timeout=20, check=False)
    if result.returncode:
        raise PhoneDailyConfigurationError('Private profile ownership probe failed')
    state = json.loads(result.stdout)
    if state.get('matches') is True:
        return {'configured': True}
    if client is None:
        async with httpx.AsyncClient(timeout=15, trust_env=False) as owned:
            response = await owned.put(base_url.rstrip('/') + '/api/iphone/device/setup-profile', headers={'X-API-Key': backend_key, 'X-User-Id': user_id}, json={'expectedProfileRevision': state['profileRevision'], **profile})
    else:
        response = await client.put(base_url.rstrip('/') + '/api/iphone/device/setup-profile', headers={'X-API-Key': backend_key, 'X-User-Id': user_id}, json={'expectedProfileRevision': state['profileRevision'], **profile})
    if response.status_code != 200:
        raise PhoneDailyConfigurationError('Private profile CAS rejected')
    return {'configured': True}
