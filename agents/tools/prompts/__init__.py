"""Tool description prompt fragments - system-prompt-level usage notes for each tool.

Each fragment is a brief prose note (when/why to use, exclusivity, common mistakes).
Pydantic Field(description=...) on the tool model in `agents/utils/tool_schemas.py`
is the canonical source for parameter-level documentation; these prompt fragments
do NOT restate the schema and complement (not duplicate) the Pydantic descriptions.
"""

from tools.prompts.api_request import PROMPT as api_request_prompt
from tools.prompts.attempt_completion import PROMPT as attempt_completion_prompt
from tools.prompts.attempt_completion_with_result import (
    PROMPT as attempt_completion_with_result_prompt,
)
from tools.prompts.call_phone_number import PROMPT as call_phone_number_prompt
from tools.prompts.display import PROMPT as display_prompt
from tools.prompts.grep import PROMPT as grep_prompt
from tools.prompts.inspect_code import PROMPT as inspect_code_prompt
from tools.prompts.google_workspace_run import PROMPT as google_workspace_run_prompt
from tools.prompts.message_person import PROMPT as message_person_prompt
from tools.prompts.people_search import PROMPT as people_search_prompt
from tools.prompts.reasoning import PROMPT as reasoning_prompt
from tools.prompts.send_message_to_user import PROMPT as send_message_to_user_prompt
from tools.prompts.send_message_to_user_execute_phase import (
    PROMPT as send_message_to_user_execute_phase_prompt,
)
from tools.prompts.set_plan import PROMPT as set_plan_prompt
from tools.prompts.spawn_agent import PROMPT as spawn_agent_prompt
from tools.prompts.wait_for import PROMPT as wait_for_prompt
from tools.prompts.web_fetch import PROMPT as web_fetch_prompt
from tools.prompts.web_search import PROMPT as web_search_prompt

TOOL_PROMPTS: dict[str, str] = {
    # Agent tools
    "spawn_agent": spawn_agent_prompt,
    "reasoning": reasoning_prompt,
    # Communication
    "send_message_to_user": send_message_to_user_prompt,
    "send_message_to_user_execute_phase": send_message_to_user_execute_phase_prompt,
    "display": display_prompt,
    "message_person": message_person_prompt,
    "call_phone_number": call_phone_number_prompt,
    # Research
    "grep": grep_prompt,
    "inspect_code": inspect_code_prompt,
    "google_workspace_run": google_workspace_run_prompt,
    "web_search": web_search_prompt,
    "people_search": people_search_prompt,
    "web_fetch": web_fetch_prompt,
    "api_request": api_request_prompt,
    # Workflow
    "set_plan": set_plan_prompt,
    "attempt_completion": attempt_completion_prompt,
    "attempt_completion_with_result": attempt_completion_with_result_prompt,
    "wait_for": wait_for_prompt,
}


def get_tool_prompts() -> dict[str, str]:
    """TOOL_PROMPTS for injection, honoring ROSE_DISABLE_API_REQUEST."""
    from utils.kill_switches import api_request_disabled

    if not api_request_disabled():
        return dict(TOOL_PROMPTS)
    return {name: prompt for name, prompt in TOOL_PROMPTS.items() if name != "api_request"}


__all__ = ["TOOL_PROMPTS", "get_tool_prompts"]
