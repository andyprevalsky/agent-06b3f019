"""Tool description prompt fragments - system-prompt-level usage notes for each tool.

Each fragment is a brief prose note (when/why to use, exclusivity, common mistakes).
Pydantic Field(description=...) on the tool model in `agents/utils/tool_schemas.py`
is the canonical source for parameter-level documentation; these prompt fragments
do NOT restate the schema and complement (not duplicate) the Pydantic descriptions.
"""

from tools.prompts.attempt_completion import PROMPT as attempt_completion_prompt
from tools.prompts.call_phone_number import PROMPT as call_phone_number_prompt
from tools.prompts.grep import PROMPT as grep_prompt
from tools.prompts.message_person import PROMPT as message_person_prompt
from tools.prompts.reasoning import PROMPT as reasoning_prompt
from tools.prompts.send_message_to_user import PROMPT as send_message_to_user_prompt
from tools.prompts.send_message_to_user_execute_phase import (
    PROMPT as send_message_to_user_execute_phase_prompt,
)
from tools.prompts.set_plan import PROMPT as set_plan_prompt
from tools.prompts.spawn_agent import PROMPT as spawn_agent_prompt
from tools.prompts.spawn_browser_agent import PROMPT as spawn_browser_agent_prompt
from tools.prompts.spawn_code_agent import PROMPT as spawn_code_agent_prompt
from tools.prompts.spawn_explore_agent import PROMPT as spawn_explore_agent_prompt
from tools.prompts.spawn_sub_agent import PROMPT as spawn_sub_agent_prompt
from tools.prompts.spawn_sub_agent_for_each import PROMPT as spawn_sub_agent_for_each_prompt
from tools.prompts.wait_for import PROMPT as wait_for_prompt
from tools.prompts.web_fetch import PROMPT as web_fetch_prompt
from tools.prompts.web_search import PROMPT as web_search_prompt

TOOL_PROMPTS: dict[str, str] = {
    # Agent tools
    "spawn_agent": spawn_agent_prompt,
    # Planner aliases (decomposed spawn_agent types)
    "spawn_explore_agent": spawn_explore_agent_prompt,
    "spawn_browser_agent": spawn_browser_agent_prompt,
    "spawn_code_agent": spawn_code_agent_prompt,
    "spawn_sub_agent": spawn_sub_agent_prompt,
    "spawn_sub_agent_for_each": spawn_sub_agent_for_each_prompt,
    "reasoning": reasoning_prompt,
    # Communication
    "send_message_to_user": send_message_to_user_prompt,
    "send_message_to_user_execute_phase": send_message_to_user_execute_phase_prompt,
    "message_person": message_person_prompt,
    "call_phone_number": call_phone_number_prompt,
    # Research
    "grep": grep_prompt,
    "web_search": web_search_prompt,
    "web_fetch": web_fetch_prompt,
    # Workflow
    "set_plan": set_plan_prompt,
    "attempt_completion": attempt_completion_prompt,
    "wait_for": wait_for_prompt,
}

__all__ = ["TOOL_PROMPTS"]
