"""Reset protocol tests use no provider or real account."""
import asyncio

import pytest

from benchmarks import phone_boot_reset as reset


@pytest.fixture(autouse=True)
def journal_key(monkeypatch):
    monkeypatch.setattr(reset, '_key', lambda: b'synthetic-journal-key')


def test_reset_current_journal_requires_transition_and_provider_followup(tmp_path):
    path = tmp_path / 'reset.json'
    states = iter(['available', 'resetting', 'available'])
    calls = []
    async def provider(action, device):
        calls.append(action)
        return {'state': next(states)} if action == 'observe' else {'accepted': True}
    async def run():
        await reset.start(path, 'device', 'owner', 'device', call=provider)
        with pytest.raises(reset.ResetBlocked):
            reset.validate_for_boot(path, 'device', 'owner', 'run')
        await reset.observe(path, call=provider)
        assert (await reset.observe(path, call=provider))['phase'] == 'awaiting_provider_passcodes'
    asyncio.run(run())
    reset.report_provider_ready(path)
    assert reset.validate_for_boot(path, 'device', 'owner', 'run', claim=True)['claimedBy'] == 'run'
    with pytest.raises(reset.ResetBlocked):
        reset.validate_for_boot(path, 'device', 'owner', 'other')
    with pytest.raises(reset.ResetBlocked):
        reset.validate_for_boot(path, 'device', 'foreign', 'run')
    assert calls.count('reset') == 1


def test_uncertain_reset_is_never_replayed_or_available_assumed_fresh(tmp_path):
    path = tmp_path / 'reset.json'
    calls = []
    async def provider(action, device):
        calls.append(action)
        if action == 'reset':
            raise reset.ResetBlocked('uncertain')
        return {'state': 'available'}
    async def run():
        with pytest.raises(reset.ResetBlocked):
            await reset.start(path, 'device', 'owner', 'device', call=provider)
        with pytest.raises(reset.ResetBlocked):
            await reset.start(path, 'device', 'owner', 'device', call=provider)
        assert (await reset.observe(path, call=provider))['phase'] == 'unknown'
    asyncio.run(run())
    with pytest.raises(reset.ResetBlocked):
        reset.report_provider_ready(path)
    assert calls.count('reset') == 1


def test_reset_refuses_in_use_device_and_wrong_confirmation(tmp_path):
    async def provider(action, device):
        assert action == 'observe'
        return {'state': 'in_use'}
    async def run():
        for confirmation in ['other', 'device']:
            with pytest.raises(reset.ResetBlocked):
                await reset.start(tmp_path / 'reset.json', 'device', 'owner', confirmation, call=provider)
    asyncio.run(run())
    assert not (tmp_path / 'reset.json').exists()


def test_reset_journal_tamper_fails_closed(tmp_path):
    path = tmp_path / 'reset.json'
    reset.save(path, {'phase': 'unknown'})
    path.write_text(path.read_text().replace('unknown', 'ready'))
    with pytest.raises(reset.ResetBlocked):
        reset.load(path)


def test_boot_preflight_requires_scoped_unused_verified_reset(tmp_path, monkeypatch):
    from benchmarks import phone_daily
    monkeypatch.setattr(phone_daily, 'load_daily_profile', lambda: {'allowGooglePasscodeException': False})
    path = tmp_path / 'reset.json'
    now = __import__('time').time()
    reset.save(path, {'version': 1, 'deviceId': 'device', 'userId': 'owner', 'submittedAt': now - 20,
                      'resettingObservedAt': now - 15, 'availableAt': now - 5, 'phase': 'ready',
                      'providerPasscodesReportedRestored': True, 'claimedBy': None})
    monkeypatch.setenv('BENCHMARK_ISOLATED_RUN', '1')
    monkeypatch.setenv('BENCHMARK_CONTEXT_DIR', 'run-a')
    monkeypatch.setenv('PHONE_DAILY_RESET_JOURNAL', str(path))
    monkeypatch.setenv('PHONE_HARNESS_DEVICE_ID', 'device')
    phone_daily.preflight_daily('phone-daily-full-boot', 'http://localhost:4411', 'owner')
    reset.validate_for_boot(path, 'device', 'owner', 'run-a', claim=True)
    monkeypatch.setenv('BENCHMARK_CONTEXT_DIR', 'run-b')
    with pytest.raises(phone_daily.PhoneDailyConfigurationError):
        phone_daily.preflight_daily('phone-daily-full-boot', 'http://localhost:4411', 'owner')
    with pytest.raises(phone_daily.PhoneDailyConfigurationError):
        phone_daily.preflight_daily('phone-daily-full-boot', 'http://localhost:4411', 'foreign')


def test_boot_catalog_requires_judge_and_separates_provider_preparation():
    from benchmarks.benchmark_tasks import get_task_by_name
    task = get_task_by_name('phone-daily-full-boot')
    assert task.enforce_declared_evaluators
    assert 'Do not reset or erase' in task.prompt
    assert 'passcode before Gmail' in task.prompt
    assert task.evaluators


def test_benchmark_preparation_resets_once_then_stops_at_provider_gate(tmp_path):
    path = tmp_path / 'reset.json'
    calls = []
    states = iter(['available', 'resetting', 'available'])
    async def provider(action, device):
        calls.append(action)
        return {'state': next(states)} if action == 'observe' else {'accepted': True}
    async def sleep(_):
        pass
    async def run():
        with pytest.raises(reset.ResetBlocked, match='provider must re-enable passcodes'):
            await reset.prepare(path, 'device', 'owner', 'device', 'run', call=provider, sleep=sleep)
        assert reset.load(path)['phase'] == 'awaiting_provider_passcodes'
        reset.report_provider_ready(path)
        assert (await reset.prepare(path, 'device', 'owner', 'device', 'run', call=provider))['claimedBy'] == 'run'
    asyncio.run(run())
    assert calls.count('reset') == 1


def test_authorized_google_exception_resumes_boot_without_false_passcode_report(tmp_path):
    path = tmp_path / 'reset.json'
    calls = []
    states = iter(['available', 'resetting', 'available'])
    async def provider(action, device):
        calls.append(action)
        return {'state': next(states)} if action == 'observe' else {'accepted': True}
    async def sleep(_):
        pass
    data = asyncio.run(reset.prepare(path, 'device', 'owner', 'device', 'run', call=provider,
                                     sleep=sleep, allow_google_exception=True))
    assert data['claimedBy'] == 'run'
    assert data['providerPasscodesReportedRestored'] is False
    assert data['googleExceptionAuthorized'] is True
    assert calls.count('reset') == 1
    with pytest.raises(reset.ResetBlocked):
        reset.validate_for_boot(path, 'device', 'owner', 'run')
    assert reset.validate_for_boot(path, 'device', 'owner', 'run', allow_google_exception=True)


def test_prepare_observes_uncertain_reset_instead_of_aborting_or_resubmitting(tmp_path):
    path = tmp_path / 'reset.json'
    calls = []
    states = iter(['available', 'resetting', 'available'])
    async def provider(action, device):
        calls.append(action)
        if action == 'reset':
            raise reset.ResetBlocked('lost reset response')
        return {'state': next(states)}
    async def sleep(_):
        pass
    data = asyncio.run(reset.prepare(path, 'device', 'owner', 'device', 'run', call=provider,
                                     sleep=sleep, allow_google_exception=True))
    assert data['phase'] == 'ready'
    assert calls.count('reset') == 1
