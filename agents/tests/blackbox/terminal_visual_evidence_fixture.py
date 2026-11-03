"""Native capture through terminal persistence and the ordinary Polar consumer."""
import asyncio
import base64
import copy
import importlib.util
import inspect
import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, patch

from benchmarks.polar_evaluator import build_polar_trajectory
from browser_visual_receipt_fixture import capture, png, setup
from domains.spawn_browser_agent_v3 import service_actions


def original_image():
    source = os.environ.get('R72_ORIGINAL_IMAGE')
    return base64.b64encode(Path(source).read_bytes()).decode() if source else png()


def asset_rows(saved):
    return [{'role': 'TOOL', 'text': row['message'], 'metadata': row['extra_metadata']} for row in saved]


async def test_terminal_capture_reaches_polar():
    root = Path(os.environ.get('ROSE_TEST_SOURCE_ROOT', Path(__file__).resolve().parents[3]))
    path = root / 'agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py'
    spec = importlib.util.spec_from_file_location('r72_actual_activity', path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    image = original_image()
    saved = []
    class Multiplexer:
        async def disconnect_confirmed(self, disconnect):
            await disconnect()
            return True
    class DOM(m._FakeDomService):
        single_cdp_client = True
        cdp_multiplexer = Multiplexer()
        async def capture_viewport_png(self):
            return image
        def get_parked_page_identity(self):
            return {'url': 'https://example.com/login', 'target_id': 'original-target'}
    async def execute(*args, **kwargs):
        return await service_actions._execute_screenshot(
            session=None, dom_service=args[0], action_history=args[1],
            thinking='', session_id=kwargs['session_id'], config=None)
    async def save(**kwargs):
        assert DOM.last_instance.disconnect.await_count == 0, 'Evidence persisted after disconnect'
        saved.append(kwargs)
        return True
    with (patch.object(m, '_FakeDomService', DOM),
          patch('domains.spawn_browser_agent_v3.handler.execute_action', new=execute),
          patch('domains.spawn_browser_agent_v3.repo.save_browser_action_message', new=save),
          patch('domains.spawn_browser_agent_v3.tilion_worker.stage_upload', return_value={'path': '/files/screenshot.png'}),
          patch('domains.spawn_browser_agent_v3.handler.JEVSession.schedule'),
          patch('socket.socket.connect', side_effect=AssertionError('No network'))):
        actor, _ = await m._exercise_browser_resume_user_input(actor_responses_override=[
            {'action': {'action': 'screenshot', 'params': {}}, 'usage': {}},
            {'action': {'action': 'attempt_completion', 'params': {'reasoning': 'done'}}, 'usage': {}},
        ])
    text, assets = build_polar_trajectory({'messages': asset_rows(saved)})
    assert assets == [{'b64': image, 'mime': 'image/png'}], 'Original trusted capture absent from independent evaluator'
    assert 'not current state or completion authority' in text
    assert saved[0]['extra_metadata']['excludeFromModel'] is True
    assert actor.await_count == 2


async def export(history, dom, **kwargs):
    from domains.spawn_browser_agent_v3.service_visual_evidence import persist_terminal_visual_evidence
    saved = []
    async def save(**row):
        saved.append(row)
        return True
    with patch('domains.spawn_browser_agent_v3.repo.save_browser_action_message', new=kwargs.pop('save', save)):
        result = await persist_terminal_visual_evidence(
            action_history=history, dom_service=dom, session_id=kwargs.pop('session_id', 'owned-session'),
            task_id=kwargs.pop('task_id', 'owned-task'), agent_id='owner', redact=lambda x: x, **kwargs)
    return result, saved


async def test_terminal_privacy_identity_and_restore():
    for kind in ('secret', 'session', 'task', 'dom', 'restore'):
        dom, history = setup()
        await capture(dom, history, png())
        opts = {}
        if kind == 'secret': dom.mark_secret_used()
        if kind == 'session': opts['session_id'] = 'foreign'
        if kind == 'task': opts['task_id'] = 'foreign'
        if kind == 'dom': dom = setup()[0]
        if kind == 'restore': history.restore_entries(history.get_entries())
        result, saved = await export(history, dom, **opts)
        assert not saved and result['status'] == 'withheld', kind


async def test_terminal_invalid_receipts_fail_closed():
    mutations = [
        {'sha256': '0' * 64}, {'screenshot_b64': 'not-base64'}, {'bytes': 1}, {'pixels': 1},
        {'task_id': 'foreign'}, {'session_id': 'foreign'}, {'step': 100}, {'target_id': ''},
        {'url': 'file:///secret'}, {'screenshot_b64': 'A' * 1_398_105},
    ]
    for mutation in mutations:
        dom, history = setup()
        await capture(dom, history, png())
        history._screenshot_evidence[0].update(mutation)
        assert not (await export(history, dom))[1], mutation.keys()
    from io import BytesIO
    import random
    from PIL import Image
    for kind in ('count', 'bytes', 'pixels', 'body'):
        dom, history = setup()
        image = png()
        count = 21
        if kind == 'bytes':
            buffer = BytesIO()
            Image.frombytes('RGB', (512, 512), random.Random(17).randbytes(512 * 512 * 3)).save(buffer, format='PNG')
            image, count = base64.b64encode(buffer.getvalue()).decode(), 6
        elif kind == 'pixels':
            image, count = png(size=(2048, 1536)), 6
        elif kind == 'body':
            count = 1
        await capture(dom, history, image)
        row = history._screenshot_evidence[0]
        history._screenshot_evidence = [copy.deepcopy(row) for _ in range(count)]
        if kind == 'body':
            history._screenshot_evidence[0]['url'] = 'https://example.com/' + 'x' * 1_500_000
        assert not (await export(history, dom))[1], kind
    dom, history = setup()
    await capture(dom, history, png())
    # A look-alike object cannot turn public/model-authored rows into native custody.
    from types import SimpleNamespace
    fake = SimpleNamespace(_dom_service=dom, screenshot_evidence=history.screenshot_evidence)
    assert not (await export(fake, dom))[1]


async def test_terminal_failed_write_cancel_and_revocation():
    dom, history = setup()
    await capture(dom, history, png())
    failed, saved = await export(history, dom, save=AsyncMock(return_value=False))
    assert failed == {'status': 'failed', 'persisted': 0, 'eligible': 1}
    try:
        await export(history, dom, save=AsyncMock(side_effect=asyncio.CancelledError()))
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError('Cancellation swallowed')
    await capture(dom, history, png((1, 2, 3)))
    writes = []
    async def revoke(**row):
        writes.append(row)
        dom.mark_secret_used()
        return True
    result, _ = await export(history, dom, save=revoke)
    assert len(writes) == 1 and result == {'status': 'withheld', 'persisted': 1, 'eligible': 2}


async def test_terminal_body_budget_and_no_authority():
    dom, history = setup()
    for n in range(22):
        dom._runtime_current_url = f'https://example.com/{n}'
        await capture(dom, history, png((n, n, n)))
    result, saved = await export(history, dom)
    assert len(saved) == 20 and result['persisted'] == 20
    assert all(len(json.dumps(row).encode()) < 1_500_000 for row in saved)
    assert all(not row.get('is_completion_message') and not row.get('output_schema') for row in saved)
    assert all(row['extra_metadata']['excludeFromModel'] for row in saved)
    assert len(build_polar_trajectory({'messages': asset_rows(saved)})[1]) == 20
