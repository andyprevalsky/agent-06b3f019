"""Export the original screenshot tool results with descriptive capture context."""
from typing import Any, Callable

from browser_tools.dom_service import ActionHistory
from helpers.screenshot_history import screenshot_message, redact_with_screenshots
from tools.base import MessageStatus


async def persist_terminal_visual_evidence(*, action_history: ActionHistory, dom_service: Any,
                                           session_id: str, task_id: str, agent_id: str,
                                           redact: Callable[[Any], Any]) -> dict:
    """Persist captures already in this history; never load another session's files."""
    from domains.spawn_browser_agent_v3.repo import save_browser_action_message

    messages = [message for entry in action_history.get_entries()
                if (message := screenshot_message(entry)) is not None]
    persisted = 0
    for message in messages:
        metadata = redact_with_screenshots(message['metadata'], redact)
        saved = await save_browser_action_message(
            agent_id=agent_id, task_id=task_id,
            title='Screenshot tool result', message=redact(message['text']),
            status=MessageStatus.FINISHED, action_type='screenshot',
            tool_call_id=metadata.get('toolCallId'),
            tool_name_override='screenshot', extra_metadata=metadata,
        )
        if saved is not True:
            return {'status': 'failed', 'persisted': persisted, 'eligible': len(messages)}
        persisted += 1
    return {'status': 'persisted' if persisted else 'unavailable',
            'persisted': persisted, 'eligible': len(messages)}
