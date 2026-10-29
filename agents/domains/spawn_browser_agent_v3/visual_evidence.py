"""Terminal export of task-owned public screenshots, without completion authority."""
import base64
import hashlib
import json
from io import BytesIO
from typing import Any, Callable

from PIL import Image

from browser_tools.dom_service import ActionHistory
from tools.base import MessageStatus


def _terminal_receipts(history: ActionHistory, dom: Any, session_id: str, task_id: str) -> list[dict]:
    # Never accept a caller/model supplied receipt collection. The native sidecar
    # remains the authority, including its private-use and durable-resume gates.
    if type(history) is not ActionHistory or history._dom_service is not dom or dom is None:
        return []
    receipts = history.screenshot_evidence(session_id, task_id)
    if len(receipts) > 20:
        return []
    total_bytes = total_pixels = 0
    steps = {e['step']: e for e in history.get_entries()}
    for row in receipts:
        try:
            entry = steps.get(row['step'], {})
            if (type(row['step']) is not int or row['step'] <= 0
                    or row['session_id'] != session_id or row['task_id'] != task_id
                    or entry.get('action') != 'screenshot' or entry.get('result', {}).get('success') is not True
                    or not isinstance(row['target_id'], str) or not row['target_id']
                    or not isinstance(row['url'], str) or not row['url'].startswith(('http://', 'https://'))
                    or not isinstance(row['screenshot_b64'], str) or len(row['screenshot_b64']) > 1_398_104):
                return []
            raw = base64.b64decode(row['screenshot_b64'], validate=True)
            if not raw or len(raw) > 1_048_576 or len(raw) != row['bytes']:
                return []
            if hashlib.sha256(raw).hexdigest() != row['sha256']:
                return []
            with Image.open(BytesIO(raw)) as image:
                pixels = image.width * image.height
                if image.format != 'PNG' or pixels > 4_000_000 or pixels != row['pixels']:
                    return []
                image.verify()
            total_bytes += len(raw)
            total_pixels += pixels
        except (KeyError, TypeError, ValueError, OSError, SyntaxError, Image.DecompressionBombError):
            return []
    return receipts if total_bytes <= 4_194_304 and total_pixels <= 16_000_000 else []


async def persist_terminal_visual_evidence(*, action_history: ActionHistory, dom_service: Any,
                                           session_id: str, task_id: str, agent_id: str,
                                           redact: Callable[[Any], Any]) -> dict:
    """Run once at successful finalization, before disconnecting the native DOM.

    Each request holds at most one 1-MiB PNG (under 1.5 MiB encoded JSON), below
    the ordinary messages endpoint's 100-MiB body limit. Existing sidecar count,
    byte and pixel budgets stay unchanged. No retry or durable image hydration.
    """
    from domains.spawn_browser_agent_v3.repo import save_browser_action_message

    receipts = _terminal_receipts(action_history, dom_service, session_id, task_id)
    persisted = 0
    for row in receipts:
        # Recheck after each awaited write; privacy/session revocation cannot
        # authorize a subsequent write using the earlier snapshot.
        if row not in _terminal_receipts(action_history, dom_service, session_id, task_id):
            return {'status': 'withheld', 'persisted': persisted, 'eligible': len(receipts)}
        metadata = {
            'excludeFromModel': True,
            'browser_action_step': row['step'],
            'historical_screenshot': {
                'session_id': session_id, 'task_id': task_id, 'target_id': row['target_id'],
                'url': redact(row['url']), 'sha256': row['sha256'],
            },
            'screenshot_media_type': 'image/png',
            'screenshot_b64': row['screenshot_b64'],
        }
        # This check is on the actual visible payload, not only decoded pixels.
        if len(json.dumps(metadata, ensure_ascii=True).encode()) > 1_500_000:
            return {'status': 'withheld', 'persisted': persisted, 'eligible': len(receipts)}
        saved = await save_browser_action_message(
            agent_id=agent_id, task_id=task_id,
            title='Recorded historical browser screenshot',
            message='Historical native screenshot; not current state or completion authority.',
            status=MessageStatus.FINISHED, action_type='historical_screenshot',
            tool_name_override='historical_screenshot', extra_metadata=metadata,
        )
        if saved is not True:
            return {'status': 'failed', 'persisted': persisted, 'eligible': len(receipts)}
        persisted += 1
    return {'status': 'persisted' if persisted else 'withheld', 'persisted': persisted, 'eligible': len(receipts)}
