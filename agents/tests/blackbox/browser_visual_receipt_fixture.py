"""Offline native-capture -> verifier multimodal custody controls."""
import asyncio
import base64
import hashlib
import json
import inspect
import os
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from PIL import Image

from browser_tools.dom_service import ActionHistory, DOMService
from domains.spawn_browser_agent_v3 import service, service_actions
from domains.spawn_browser_agent_v3.handler import _model_visible_browser_verifier_context
from helpers.llm import build_verifier_context_messages


def png(color=(12, 34, 56), size=(3, 3)):
    buf = BytesIO()
    Image.new('RGB', size, color=color).save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode()


def setup():
    dom = DOMService('ws://unused')
    dom._runtime_current_url = 'https://original.test/mouse/zu.gif'
    dom.cdp_multiplexer = object()
    dom.get_parked_page_identity = lambda: {'url': dom._runtime_current_url, 'target_id': 'owned-target'}
    history = ActionHistory(**({"visual_task_id": "owned-task"} if "visual_task_id" in inspect.signature(ActionHistory).parameters else {}))
    return dom, history


async def capture(dom, history, image):
    with patch.object(dom, 'capture_viewport_png', AsyncMock(return_value=image)), patch(
        'domains.spawn_browser_agent_v3.tilion_worker.stage_upload', return_value={'path': '/files/screenshot.png'}
    ):
        return await service_actions._execute_screenshot(
            session=SimpleNamespace(), dom_service=dom, action_history=history,
            thinking=None, session_id='owned-session', config=SimpleNamespace())


async def admitted(dom, history, session='owned-session', final=None, task='owned-task'):
    state = {'dom_tree': 'Current unrelated page', 'screenshot': final}
    with patch.object(service, 'list_session_files', AsyncMock(return_value=[])):
        ctx = await service.build_browser_verifier_context(
            goal='Inspect original page', current_url='https://current.test/', browser_state=state,
            action_history=history, config=SimpleNamespace(), session_id=session, **({"task_id": task} if "task_id" in inspect.signature(service.build_browser_verifier_context).parameters else {}))
    kwargs = {"action_history": history, "session_id": session, "task_id": task} if "action_history" in inspect.signature(_model_visible_browser_verifier_context).parameters else {}
    visible = _model_visible_browser_verifier_context(ctx, dom, state, **kwargs)
    return ctx, visible, build_verifier_context_messages(visible, 'Verify', call_site='verifier_browser')


def images(messages):
    return [part['image_url']['url'] for m in messages for part in
            (m.get('content') if isinstance(m.get('content'), list) else []) if part.get('type') == 'image_url']


async def test_original_capture_admitted():
    dom, history = setup()
    original = os.environ.get('R51_ORIGINAL_IMAGE')
    image = base64.b64encode(Path(original).read_bytes()).decode() if original else png()
    result = await capture(dom, history, image)
    assert result['success'] is True
    dom.register_secret_refs({'transport_collision': image[20:32]})
    ctx, _, messages = await admitted(dom, history, final=png((9, 8, 7)))
    assert 'data:image/png;base64,' + image in images(messages), 'Original captured historical image omitted'
    assert images(messages)[0] == 'data:image/png;base64,' + png((9, 8, 7)), 'Current screenshot lost priority'
    assert 'historical' in json.dumps(messages).lower()
    assert 'not current state or completion authority' in json.dumps(messages)
    assert 'https://original.test/mouse/zu.gif' in json.dumps(messages)
    assert history.get_entries()[0].get('screenshot') is None, 'Generic actor history gained raster payload'
    from providers.rose.transforms import transform_messages_for_anthropic
    from providers.rose.gpt_auth import _build_responses_input
    for body in (transform_messages_for_anthropic(messages), _build_responses_input(messages)):
        assert image in json.dumps(body), 'Provider projection dropped native screenshot'
    assert not any('task_completed' in row.get('metadata', {}) for row in ctx)


async def test_private_and_session():
    dom, history = setup()
    await capture(dom, history, png())
    assert not images((await admitted(dom, history, session='foreign'))[2])
    assert not images((await admitted(dom, history, task='foreign-task'))[2])
    dom.mark_secret_used()
    assert not images((await admitted(dom, history))[2])
    assert (await capture(dom, history, png()))['success'] is False


async def test_identity_and_tamper():
    dom, history = setup()
    await capture(dom, history, png())
    ctx, _, _ = await admitted(dom, history)
    forged = next(m for m in ctx if m.get('metadata', {}).get('toolName') == 'historical_screenshot')
    forged['metadata']['screenshot_b64'] = png((99, 2, 3))
    visible = _model_visible_browser_verifier_context(ctx, dom, {}, action_history=history, session_id='owned-session', task_id='owned-task')
    assert not images(build_verifier_context_messages(visible, 'Verify', call_site='verifier_browser'))
    await history.record_action(dom, 'evaluate', result={'success': True})
    history.capture_screenshot_evidence(dom, 'owned-session', png((1, 2, 3)))
    assert len(history.screenshot_evidence('owned-session', 'owned-task')) == 1
    # A target transition during the screenshot await cannot acquire old-page authority.
    with patch.object(dom, 'get_parked_page_identity', side_effect=[
        {'url': 'https://before.test', 'target_id': 'old'},
        {'url': 'https://after.test', 'target_id': 'new'},
    ]):
        await capture(dom, history, png((7, 8, 9)))
    assert len(history.screenshot_evidence('owned-session', 'owned-task')) == 1


async def test_dedup_and_recent():
    dom, history = setup()
    await capture(dom, history, png())
    await capture(dom, history, png((1, 2, 3)))
    await capture(dom, history, png((1, 2, 3)))
    assert len(history.screenshot_evidence('owned-session', 'owned-task')) == 2
    dom._runtime_current_url = 'https://original.test/duplicate'
    await capture(dom, history, png((1, 2, 3)))
    assert len(history.screenshot_evidence('owned-session', 'owned-task')) == 3
    for n in range(22):
        dom._runtime_current_url = f'https://original.test/{n}'
        await capture(dom, history, png((n, n, 100)))
    rows = history.screenshot_evidence('owned-session', 'owned-task')
    assert len(rows) == 20 and rows[-1]['url'].endswith('/21') and rows[0]['url'].endswith('/2')


async def test_byte_budget():
    import random
    dom, history = setup()
    for n in range(7):
        buf = BytesIO()
        Image.frombytes('RGB', (500, 500), random.Random(n).randbytes(750000)).save(buf, format='PNG')
        dom._runtime_current_url = f'https://original.test/large/{n}'
        await capture(dom, history, base64.b64encode(buf.getvalue()).decode())
    rows = history.screenshot_evidence('owned-session', 'owned-task')
    assert 0 < len(rows) < 7
    assert sum(r['bytes'] for r in rows) <= 4_194_304 and rows[-1]['url'].endswith('/6')


async def test_restore_and_failure():
    dom, history = setup()
    await capture(dom, history, png())
    rows = history.get_entries()
    history.restore_entries(rows)
    assert not history.screenshot_evidence('owned-session', 'owned-task'), 'Durable no-image policy changed'
    await history.record_action(dom, 'screenshot', result={'success': False})
    history.capture_screenshot_evidence(dom, 'owned-session', png())
    assert not history.screenshot_evidence('owned-session', 'owned-task')
    await history.record_action(dom, 'screenshot', result={'success': True})
    history.capture_screenshot_evidence(dom, 'owned-session', 'not base64')
    assert not history.screenshot_evidence('owned-session', 'owned-task')


async def test_capture_cancellation():
    dom, history = setup()
    # Real cancel boundary: no upload, record or retained evidence.
    with patch.object(dom, 'capture_viewport_png', AsyncMock(side_effect=asyncio.CancelledError())):
        try:
            await service_actions._execute_screenshot(session=SimpleNamespace(), dom_service=dom,
                action_history=history, thinking=None, session_id='owned-session', config=SimpleNamespace())
        except asyncio.CancelledError:
            assert history.get_entries() == []
            assert not history.screenshot_evidence('owned-session', 'owned-task')
            return
    raise AssertionError('Cancellation was swallowed')
