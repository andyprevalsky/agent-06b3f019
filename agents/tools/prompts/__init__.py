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
from tools.prompts.display import PROMPT_ROSE_DESKTOP as display_rose_desktop_prompt
from tools.prompts.google_workspace_run import PROMPT as google_workspace_run_prompt
from tools.prompts.grep import PROMPT as grep_prompt
from tools.prompts.inspect_code import PROMPT as inspect_code_prompt
from tools.prompts.kill_agent import PROMPT as kill_agent_prompt
from tools.prompts.message_person import PROMPT as message_person_prompt
from tools.prompts.people_search import PROMPT as people_search_prompt
from tools.prompts.reasoning import PROMPT as reasoning_prompt
from tools.prompts.send_message_to_user import PROMPT as send_message_to_user_prompt
from tools.prompts.send_message_to_user_execute_phase import (
    PROMPT as send_message_to_user_execute_phase_prompt,
)
from tools.prompts.set_plan import PROMPT as set_plan_prompt
from tools.prompts.spawn_agent import PROMPT as spawn_agent_prompt
from tools.prompts.spawn_agent import PROMPT_ROSE_DESKTOP as spawn_agent_rose_desktop_prompt
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
    "kill_agent": kill_agent_prompt,
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


# Rose Desktop accounts (utils.rose_desktop) read these instead of the stock
# fragments: display adds pinned questions, spawn_agent's `code` line adds the
# rose_user_ui and inline views.
ROSE_DESKTOP_TOOL_PROMPTS: dict[str, str] = {
    "spawn_agent": spawn_agent_rose_desktop_prompt,
    "display": display_rose_desktop_prompt,
}


def tool_prompts_for(*, rose_desktop: bool = False) -> dict[str, str]:
    """TOOL_PROMPTS for one account group; the default is the stock set."""
    return {**TOOL_PROMPTS, **ROSE_DESKTOP_TOOL_PROMPTS} if rose_desktop else dict(TOOL_PROMPTS)


def get_tool_prompts(*, rose_desktop: bool = False) -> dict[str, str]:
    """TOOL_PROMPTS for injection, honoring ROSE_DISABLE_API_REQUEST."""
    from utils.kill_switches import api_request_disabled

    prompts = tool_prompts_for(rose_desktop=rose_desktop)
    if not api_request_disabled():
        return prompts
    return {name: prompt for name, prompt in prompts.items() if name != "api_request"}


__all__ = ["ROSE_DESKTOP_TOOL_PROMPTS", "TOOL_PROMPTS", "get_tool_prompts", "tool_prompts_for"]
