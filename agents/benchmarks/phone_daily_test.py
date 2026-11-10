"""Offline owning evidence checks. No device, account or OTP values in reports."""
import copy

import pytest

from benchmarks.phone_daily import evaluate_phone_daily


def evidence(kind):
    return {
        'kind': kind, 'source': 'owned-persisted-phone-v1', 'userId': 'u',
        'rootAgentId': 'r', 'deviceId': 'd', 'actor': 'agent', 'current': True,
        'operationIds': ['read', 'act', 'verify'], 'attentionCount': 0,
        'boot': {'requirementsVersion': 6, 'current': True, 'configurationReady': True,
                 'securityDisposition': 'authorized_google_exception', 'freshProviderResetVerified': True, 'agentPerformedBoot': True, 'savedCredentialSafetyVerified': True,
                 'checks': {name: {'status': 'confirmed', 'current': True} for name in
                            ['apple_account', 'icloud_messages', 'icloud_keychain', 'icloud_contacts', 'imessage', 'receive_address', 'portrait_lock', 'gmail', 'google_passcode_exception']}},
        'challenge': {'challengeId': 'challenge', 'accountMatches': True, 'recipientMatches': True,
                      'fresh': True, 'unused': True, 'taskMatches': True, 'ordered': True,
                      'receivedOnCloudPhone': True, 'agentInputSucceeded': True,
                      'targetContinuationVerified': True},
        'messages': {key: True for key in ['approvedIntentMatches', 'durableSentReceipt', 'independentRecipientReceipt', 'independentIncomingReceipt', 'uniqueRunMarkerMatches', 'ordered']},
        'google': {'freshBrowser': True, 'currentChallengeMatches': True,
                   'cloudApprovalSucceeded': True, 'browserContinuationVerified': True,
                   'authenticatedAccountMatches': True},
    }


@pytest.mark.parametrize('kind', ['boot', 'sms', 'google', 'messages'])
def test_daily_requires_real_scoped_evidence(kind):
    proof = evidence(kind)
    assert evaluate_phone_daily(kind, proof, user_id='u', root_agent_id='r', device_id='d')['passed']
    for field, value in [('source', 'fixture'), ('userId', 'foreign'), ('rootAgentId', 'foreign'), ('deviceId', 'foreign'), ('actor', 'user'), ('current', False), ('attentionCount', 1), ('operationIds', [])]:
        bad = copy.deepcopy(proof)
        bad[field] = value
        assert not evaluate_phone_daily(kind, bad, user_id='u', root_agent_id='r', device_id='d')['passed']


def test_sms_stale_unrelated_and_unverified_continuation_fail():
    for field in evidence('sms')['challenge']:
        if field == 'challengeId':
            continue
        bad = evidence('sms')
        bad['challenge'][field] = False
        result = evaluate_phone_daily('sms', bad, user_id='u', root_agent_id='r', device_id='d')
        assert result == {'passed': False, 'error': 'phone_daily_evidence_invalid'}
        assert '654321' not in str(result)


def test_google_operator_approval_and_saved_session_do_not_pass():
    for field in evidence('google')['google']:
        bad = evidence('google')
        bad['google'][field] = False
        assert not evaluate_phone_daily('google', bad, user_id='u', root_agent_id='r', device_id='d')['passed']


def test_boot_all_required_current_checks_and_truthful_exception():
    for target in evidence('boot')['boot']['checks']:
        bad = evidence('boot')
        bad['boot']['checks'][target]['current'] = False
        assert not evaluate_phone_daily('boot', bad, user_id='u', root_agent_id='r', device_id='d')['passed']
    bad = evidence('boot')
    bad['boot']['requirementsVersion'] = 5
    assert not evaluate_phone_daily('boot', bad, user_id='u', root_agent_id='r', device_id='d')['passed']
    positive = evidence('boot')
    positive['boot']['securityDisposition'] = 'passcode_enabled'
    positive['boot']['checks'].pop('google_passcode_exception')
    positive['boot']['checks']['device_passcode'] = {'status': 'confirmed', 'current': True}
    assert evaluate_phone_daily('boot', positive, user_id='u', root_agent_id='r', device_id='d')['passed']


@pytest.mark.parametrize('field', ['freshProviderResetVerified', 'agentPerformedBoot', 'savedCredentialSafetyVerified'])
def test_retained_or_operator_boot_never_passes(field):
    proof = evidence('boot')
    proof['boot'][field] = False
    assert not evaluate_phone_daily('boot', proof, user_id='u', root_agent_id='r', device_id='d')['passed']


def test_outbound_prose_or_self_receipt_is_not_independent_roundtrip():
    for field in evidence('messages')['messages']:
        proof = evidence('messages')
        proof['messages'][field] = False
        assert not evaluate_phone_daily('messages', proof, user_id='u', root_agent_id='r', device_id='d')['passed']


@pytest.mark.parametrize('name', [
    'phone-daily-full-boot', 'phone-daily-sms-challenge',
    'phone-daily-google-approval', 'phone-daily-message-roundtrip',
])
def test_unimplemented_live_collector_cannot_be_enabled_by_fixture_json(name, monkeypatch):
    from benchmarks.phone_daily import PhoneDailyConfigurationError, evaluate_daily, preflight_daily
    monkeypatch.setenv('PHONE_DAILY_PROOF', '{"passed":true}')
    with pytest.raises(PhoneDailyConfigurationError, match='configuration_unavailable'):
        preflight_daily(name, 'http://127.0.0.1:3100', 'synthetic-user')
    with pytest.raises(PhoneDailyConfigurationError):
        evaluate_daily(name, evidence('sms'))


def test_controlled_phone_sms_scenario_is_registered_without_minted_identity():
    from benchmarks.auth_test_site import SCENARIO_LADDERS, validate_manifest
    assert SCENARIO_LADDERS['phone_sms_otp'] == (0, False, 0, 0)
    validate_manifest('phone_sms_otp', {'siteId': 'synthetic-site', 'entryUrl': 'https://fixture.test', 'scenario': 'phone_sms_otp', 'savedPasswordUsernames': [], 'authOptionsPreview': {'passwordUsernames': [], 'mintedEmail': None, 'passkeyCount': 0, 'savedSessionCount': 0}})


def test_daily_catalog_additive_and_discovered():
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.phone_daily import TASK_KINDS
    for name in TASK_KINDS:
        task = get_task_by_name(name)
        assert task.group == 'daily' and task.status == 'ready'
        assert task.demo_cache == 'off' and 'LIVE' in task.tags
    assert get_task_by_name('phone-daily-sms-challenge').environment['auth_test_site']['scenario'] == 'phone_sms_otp'
    assert get_task_by_name('browser-cloud-iphone-settings').group == 'incomplete'


def test_daily_membership_uses_normal_resolver():
    from argparse import Namespace

    from benchmarks.phone_daily import TASK_KINDS
    from benchmarks.run_benchmark import resolve_tasks
    args = Namespace(task=None, tasks=None, suite='daily', prod=False, exclude_task=[])
    selected = {task.name for task in resolve_tasks(args)}
    assert set(TASK_KINDS) <= selected


def test_existing_catalog_rows_unchanged():
    import json
    import subprocess
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    old = json.loads(subprocess.check_output(['git', 'show', '06416c4f9f50ecec4f5d2678620e20dc3c0fd3d0:agents/benchmarks/tasks.json'], cwd=root, text=True))
    current = json.loads((root / 'agents/benchmarks/tasks.json').read_text())
    # Quarantine is validated deploy metadata, not an executable task change.
    from benchmarks.long_horizon import validate_task_quarantine
    for rows in (old, current):
        for row in rows:
            validate_task_quarantine(row, row['name'])
            row.pop('quarantine', None)
            if 'deploy_quarantine' in row:
                assert row['name'] == 'test-mass-agent-run-0'
                assert row.pop('deploy_quarantine') == (
                    'User-directed indefinite exclusion from all deploys (2026-11-10, PR1682): '
                    'flaky mass-agent test. Keep explicit benchmark execution and historical '
                    'failures; do not count this omission as PASS.'
                )
    # Sync retains every row from the reviewed main snapshot; phone tasks append only.
    assert current[:len(old)] == old


def test_private_boot_collector_rejects_production_before_subprocess(monkeypatch):
    from benchmarks.phone_daily import PhoneDailyConfigurationError, collect_boot_audit
    with pytest.raises(PhoneDailyConfigurationError):
        collect_boot_audit('https://api.roselabs.ai', 'u', 'r', 'postgresql://private/production')


def test_sms_live_entrypoint_never_accepts_a_caller_proof():
    import inspect

    from benchmarks.phone_daily import evaluate_sms_daily
    assert list(inspect.signature(evaluate_sms_daily).parameters) == ['base_url', 'user_id', 'root_agent_id', 'database_url', 'manifest', 'headers']


def test_private_sms_window_allows_old_attention_and_user_observation():
    import subprocess
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    script = """
import {userIntervened,inChallengeWindow} from '../agents/benchmarks/phone_daily.window.ts';
const issued='2026-10-21T12:00:00Z', consumed='2026-10-21T12:01:00Z';
if(inChallengeWindow('2026-10-21T11:00:00Z',issued,consumed))throw Error('old attention');
if(userIntervened({actor:'user',operation:'screen.frame',createdAt:issued},issued,consumed))throw Error('observer is not input');
if(!userIntervened({actor:'user',operation:'input.tap',createdAt:issued},issued,consumed))throw Error('manual tap allowed');
if(!userIntervened({actor:'user',operation:'input.text',createdAt:consumed},issued,consumed))throw Error('manual input allowed');
"""
    result = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-e', script], cwd=root / 'back-end', capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize('name', ['phone-daily-google-approval', 'phone-daily-message-roundtrip'])
def test_runnable_daily_semantics_require_declared_judge(name):
    from benchmarks.benchmark_tasks import get_task_by_name
    task = get_task_by_name(name)
    assert task.enforce_declared_evaluators is True
    assert task.evaluators[0]['method'] == 'single_turn_llm_judge'
    assert 'actual tool/receipt evidence' in task.evaluators[0]['judge_prompt']


@pytest.mark.parametrize('payload', [None, {}, {'expectedAppleIdentity': 'apple@example.test', 'expectedGoogleIdentity': 'google@example.test', 'password': 'CANARY'}, {'expectedAppleIdentity': 'apple@example.test', 'expectedGoogleIdentity': 'google@example.test', 'allowGooglePasscodeException': 'true'}])
def test_private_daily_profile_rejects_missing_or_secret_fields(tmp_path, monkeypatch, payload):
    import json

    from benchmarks.phone_daily import PhoneDailyConfigurationError, load_daily_profile
    path = tmp_path / 'profile.json'
    path.write_text(json.dumps(payload))
    monkeypatch.setenv('PHONE_DAILY_PROFILE_FILE', str(path))
    with pytest.raises(PhoneDailyConfigurationError, match='missing or invalid'):
        load_daily_profile()


@pytest.mark.parametrize('matches', [True, False])
def test_private_profile_cas_matches_no_reset(tmp_path, monkeypatch, matches):
    import asyncio
    import json
    import subprocess
    from types import SimpleNamespace

    import httpx

    from benchmarks import logs, phone_daily
    path = tmp_path / 'profile.json'
    path.write_text(json.dumps({'expectedAppleIdentity': 'apple@example.invalid', 'expectedGoogleIdentity': 'google@example.invalid'}))
    monkeypatch.setenv('PHONE_DAILY_PROFILE_FILE', str(path))
    monkeypatch.setattr(logs, 'load_env_var', lambda *args: 'synthetic-key')
    monkeypatch.setattr(subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout=json.dumps({'matches': matches, 'profileRevision': 7})))
    bodies = []
    def handle(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await phone_daily.configure_daily_profile('http://127.0.0.1:3100', 'synthetic-user', 'synthetic-backend', 'postgresql://postgres:postgres@127.0.0.1:5432/victoria_bench_synthetic', client=client)
            assert result == {'configured': True} and 'apple@example.invalid' not in str(result)
    asyncio.run(run())
    assert len(bodies) == (0 if matches else 1)
    if not matches:
        assert bodies[0]['expectedProfileRevision'] == 7
        assert bodies[0]['allowGooglePasscodeException'] is False


@pytest.mark.parametrize('name', ['phone-daily-full-boot', 'phone-daily-sms-challenge'])
def test_normal_runner_checks_unavailable_daily_prerequisite_before_agent_creation(name, monkeypatch):
    import asyncio

    from benchmarks import run_benchmark as runner
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.phone_daily import PhoneDailyConfigurationError

    created = []
    async def unexpected_create(*args, **kwargs):
        created.append(True)
        raise AssertionError('Unavailable prerequisite allocated an agent')
    monkeypatch.setattr(runner, 'create_agent', unexpected_create)
    with pytest.raises(PhoneDailyConfigurationError, match='configuration_unavailable'):
        asyncio.run(runner._run_single_task_as_run_user(
            'http://127.0.0.1:3100', get_task_by_name(name), False,
            None, 'message-index', None, None, None,
        ))
    assert created == []


def test_private_profile_authorizes_exception_only_after_identity_cas(tmp_path, monkeypatch):
    import asyncio
    import json
    import subprocess
    from types import SimpleNamespace

    import httpx

    from benchmarks import logs, phone_daily
    path = tmp_path / 'profile.json'
    path.write_text(json.dumps({'expectedAppleIdentity': 'apple@example.invalid', 'expectedGoogleIdentity': 'google@example.invalid', 'allowGooglePasscodeException': True}))
    monkeypatch.setenv('PHONE_DAILY_PROFILE_FILE', str(path))
    monkeypatch.setattr(logs, 'load_env_var', lambda *args: 'synthetic-key')
    monkeypatch.setattr(subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout=json.dumps({'matches': False, 'profileRevision': 7})))
    bodies = []
    def handle(request):
        body = json.loads(request.content)
        bodies.append(body)
        if len(bodies) == 1 and body['allowGooglePasscodeException']:
            return httpx.Response(409, json={'error': 'Configure Google identity before authorizing an exception'})
        assert body['expectedProfileRevision'] == 6 + len(bodies)
        return httpx.Response(200, json={'setup': {'profileRevision': 7 + len(bodies)}})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            assert await phone_daily.configure_daily_profile('http://127.0.0.1:3100', 'synthetic-user', 'synthetic-key', 'postgresql://postgres:postgres@127.0.0.1:5432/victoria_bench_synthetic', client=client) == {'configured': True}
    asyncio.run(run())
    assert [b['allowGooglePasscodeException'] for b in bodies] == [False, True]


async def test_batch_cleanup_accepts_only_proven_precreation_failure():

    from benchmarks import run_benchmark as runner
    from benchmarks.results import TaskResult

    def result(metadata):
        return TaskResult(name='browser-auth-doordash-cloud-iphone', passed=False, agent_id='', status='ERROR', progress_score=0, duration_seconds=0, cost_cents=0, message_count=0, failure_reason='fixture failed', stop_metadata=metadata)
    proven = result({'root_creation_attempted': False})
    proven.graded_root_creation_outcome = 'not_started'
    proven.root_creation_attempted = False
    await runner._finalize_owned_cloud_batch('http://127.0.0.1:3100', [proven], {})
    for metadata in ({}, {'root_creation_attempted': True}):
        with pytest.raises(RuntimeError, match='unknown root creation'):
            await runner._finalize_owned_cloud_batch('http://127.0.0.1:3100', [result(metadata)], {})


def test_phone_sms_environment_requires_live_without_weakening_synthetic_auth():
    import json
    from pathlib import Path

    from benchmarks.long_horizon import validate_task_contract

    tasks = json.loads(Path(__file__).with_name('tasks.json').read_text())
    if isinstance(tasks, dict):
        tasks = tasks['tasks']
    phone = next(t for t in tasks if t['name'] == 'phone-daily-sms-challenge')
    validate_task_contract(copy.deepcopy(phone))
    for change in ('synthetic', 'missing_live_tag'):
        invalid = copy.deepcopy(phone)
        if change == 'synthetic':
            invalid['environment']['mode'] = 'synthetic'
            invalid['environment']['live_fixtures'] = []
        else:
            invalid['tags'] = [t for t in invalid['tags'] if t != 'LIVE']
        with pytest.raises(ValueError):
            validate_task_contract(invalid)
    ordinary = next(t for t in tasks if t.get('environment', {}).get('auth_test_site') and t['name'] != phone['name'])
    invalid = copy.deepcopy(ordinary)
    invalid['environment']['mode'] = 'live'
    with pytest.raises(ValueError, match='synthetic'):
        validate_task_contract(invalid)
