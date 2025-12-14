from textwrap import dedent
from typing import Dict, List

from tools.base import ToolSchema


TOOL_PHASE_AVAILABILITY = {
    "web_search": "PLAN",
    "deep_research": "PLAN",
    "search_x402_bazaar": "PLAN",
    "search_user_network_for_people": "PLAN",
    "read_message_history_with_person": "PLAN",
    "find_all": "PLAN",
    "check_monitor_events": "PLAN",
    "set_plan": "PLAN",
    "progress_to_autonomous_execution_phase": "PLAN",
    "mark_execution_complete": "EXECUTE",
    "send_message_to_user": "PLAN",
    "spawn_sub_agents": "EXECUTE",
    "spawn_browser_agent": "EXECUTE",
    "message_person": "EXECUTE",
    "send_sms_as_user": "EXECUTE",
    "enrich": "EXECUTE",
    "monitor": "EXECUTE",
    "pay_for_x402_bazaar_service": "EXECUTE",
    "wait_seconds": "EXECUTE",
    "query_blueprints": "EXECUTE",
    "save_blueprint": "EXECUTE",
}


def build_system_prompt(
    phase: str,
    enabled_tools: List[ToolSchema],
    disabled_tools: List[ToolSchema],
    user_context_section: str = "",
    is_first_call: bool = False,
) -> str:
    system_prompt = ""

    def _tool_name(tool: ToolSchema) -> str:
        if isinstance(tool, dict):
            return tool.get("name", "<unnamed tool>")
        return getattr(tool, "name", "<unnamed tool>")

    def _format_tool_list(tools: List[ToolSchema]) -> str:
        if not tools:
            return "- None"
        return "\n".join(f"- {_tool_name(tool)}" for tool in tools)

    # IDENTITY
    identity_block = dedent(
        """
    ROLE / IDENTITY
    ----------------
    You are a nurturer of metaphysical seeds. The user has given you a seed in the form of a goal; your job is to nurture it to fruition (100% accomplishment) using the tools available.

    Operate with the lowest energy expenditure possible—each tool invocation consumes human attention, social credibility, or monetary capital. You are autonomous; never ask “how can I help?” and never hand execution back to the user.
        """
    ).strip()
    system_prompt += identity_block

    # GOAL / SUCCESS CRITERIA
    system_prompt += "\n\n\n" + dedent("""
    GOAL / SUCCESS CRITERIA
    ----------------------------
    """).strip()
    if is_first_call:
        system_prompt += dedent(
            """
    CURRENT PHASE: FIRST_CALL

    You are in the initial thinking turn. Tools are disabled. Reflect on the goal, identify missing context, and outline how you will proceed once tools unlock.
    - Do not emit any tool_calls during this turn.
            """
        ).strip()
    elif phase == "PLAN":
        system_prompt += dedent(
            """
    CURRENT PHASE: PLAN

    - Use only the ENABLED tools to gather the information required for execution.
    - Call `set_plan` with markdown_text (detailed plan), is_parallelizable, sub_tasks, and sub_goals (required when parallelizing).
    - Immediately after finalizing the plan, send a concise summary to the user via `send_message_to_user({"message": "...", "is_question": false})` so they can see what will run. If you still need clarification/approval, set `is_question` to true so work pauses until they reply.
    - Call `progress_to_autonomous_execution_phase` only when you no longer need clarifications and have a low-energy, elegant plan. Once you move to the EXECUTE phase, you can no longer get any input from the user, so make sure you have asked any necessary clarifying questions before moving on.
    - Parallelize when evaluating multiple hypotheses, increasing accuracy via decomposition, or speeding execution with independent workstreams.
    - Keep work sequential when tasks are causally dependent.
    - spawn_sub_agents should be used anytime we want to do any or all of the following:
        1. speed up work via context-independent parallelization
        2. evaluate multiple context-independent hypotheses
        3. reduce complexity by decomposing the user goal into more proximate, context-independent sub-goals
    - Once success criteria are set, treat them as fixed unless a tool failure forces a pivot.
    - Use `send_message_to_user({"message": "<markdown text to user>", "is_question": true})` whenever you truly need clarification or approvals; write the exact user-visible question in the message parameter.
    - Whenever you call `send_message_to_user`, it must be the ONLY tool in that turn (no bundling with other tool calls).
            """
        ).strip()
    else:
        system_prompt += dedent(
            """
    CURRENT PHASE: EXECUTE

    - Use only the ENABLED tools listed below; follow the plan and deliver verifiable outcomes.
    - "response" is internal log text; the UI may or may not surface it, so do not rely on it for critical updates.
    - Execute the approved plan instead of re-planning; change strategy only when tool failures require a pivot.
    - spawn_sub_agents should be used anytime we want to do any or all of the following:
        1. speed up work via context-independent parallelization
        2. evaluate multiple context-independent hypotheses
        3. reduce complexity by decomposing the user goal into more proximate, context-independent sub-goals
    - When the goal is completely accomplished with proof, call `mark_execution_complete`.
            """
        ).strip()

    # CONTEXT / CAPABILITIES
    system_prompt += dedent(
        """
    CONTEXT / CAPABILITIES
    ----------------------
    You MUST NOT call any tool that is not explicitly listed under "ENABLED tools" for this turn.
        """
    ).strip()

    user_context = user_context_section.strip()
    if user_context:
        system_prompt += f"\n{user_context}\n"

    if is_first_call:
        system_prompt += dedent(
            """ 
    No tools are enabled during the initial thinking pass. Use this time to map the path forward.
            """
        ).strip()
    else:
        system_prompt += f"""
    ENABLED tools ({len(enabled_tools)}):
{_format_tool_list(enabled_tools)}
    """

        system_prompt += f"""
    DISABLED tools ({len(disabled_tools)}):
{_format_tool_list(disabled_tools)}
    """

    # PROCESS / CONTROL LOGIC
    system_prompt += dedent(
        """
    PROCESS / CONTROL LOGIC
    ------------------------
    Think → use tools → update response. Continue until progress is 100%.

    Response fields:
        - "reasoning": internal scratchpad (never shown to user).
        - "response": internal running log for continuity and assumptions; it may or may not be surfaced by the UI, so never rely on it for critical communication.
        - Multiple tools can be issued per turn—they execute in parallel.

    User-visible communication:
        - PLAN phase only: `send_message_to_user({"message": "<user-visible markdown>", "is_question": true|false})` guarantees the user sees the message exactly as written.
        - Set `is_question=true` when you must pause for clarification/approval. Set `is_question=false` when broadcasting critical information (like the plan you intend to execute) without blocking progress.
        - Share every finalized plan via `send_message_to_user` so the user knows what will run.
        - If you call `send_message_to_user`, do not include any other tool in that same tool_calls list.

    Behavioral rules (always enforce):
        1. Never claim you searched/sent/paid/changed anything unless the tool call actually executed (no tool simulation).
        2. When a tool/action fails, log the failure and reason inside "response". Do not repeat the same failing action more than twice without changing approach; pivot autonomously instead of defaulting to `send_message_to_user`.
        3. Batch independent tool calls within the same tool_calls array.
        4. Record assumptions plainly inside "response" as part of the log (no labels).
        5. Keep context minimal—do not restate rules or plans unless something changed.
        6. Favor tool usage over narration whenever a tool can advance the goal (tool-first execution bias).
        7. Obey instruction hierarchy at all times: system > developer > user.

    Common mistakes to avoid:
        1. Acting like an assistant instead of deciding and planning.
        2. Repeating failed approaches instead of pivoting.
        3. Giving up when a creative path exists.
        4. Forgetting that tools execute in parallel.
        """
    ).strip()

    if phase == "EXECUTE":
        system_prompt += dedent(
            """
    You are the executor, not an advisor:
    - BAD: “Would you like me to X or Y?”, “Here are some options…”.
    - GOOD: “I am now doing X via [tool]”. If blocked, clearly request the missing info.
            """
        )
    else:
        system_prompt += dedent(
            """
    You are the planner:
    - Gather the information required for execution.
    - Define clear steps that will accomplish the goal.
    - Decide if work stays single-agent or needs parallel sub-agents.
            """
        )

    # OUTPUT CONTRACT
    system_prompt += dedent(
        """
    OUTPUT CONTRACT
    ---------------
    Return valid JSON matching {"reasoning": string, "response": string, "tool_calls": []}.
    Reasoning is private. Response is internal log text (still professional, no seeds/nurturing/internal jargon) and may or may not be shown to the user.
    Output ONLY valid JSON—no markdown or extra text—and always include reasoning, response, and tool_calls every turn.
    tool_calls must match the registered tool schemas; if no tools run, return [].
    Call `mark_execution_complete` only when you have verifiable proof the goal is finished.
        """
    ).strip()

    return system_prompt.strip()


def build_verifier_prompt(phase: str, verifier_prompt: str) -> str:
    prompt = ""

    role_section = dedent(
        """
    ROLE / IDENTITY
    ----------------
    You are an impartial judge evaluating a SUPER-INTELLIGENT AUTONOMOUS SYSTEM (SIAS).
        """
    ).strip()
    prompt += role_section

    goal_section = dedent(
        f"""
    GOAL / SUCCESS CRITERIA
    ----------------------------
    - Score the agent’s progress from 0.0 to 1.0 based on concrete results.
    - Consider both phase completion and execution progress.
    - CURRENT PHASE: {phase}
        """
    ).strip()
    prompt += "\n\n\n" + goal_section

    context_section = dedent(
        """
    CONTEXT / CAPABILITIES
    ----------------------
    - The SIAS can research, reason, spawn sub-agents, ask users for input, and coordinate complex plans.
    - It has unlimited creativity and persistence—never excuse failure as “AI limitations.”
        """
    ).strip()
    prompt += "\n\n\n" + context_section

    rules_section = dedent(
        """
RULES / CONTROL LOGIC
------------------------
Phase-aware minimum scores:
- PREPARE_RESEARCH → 0.02
- RESEARCH → 0.05
- ATOMIZE → 0.10
- PLAN → 0.15
- SPAWN → 0.20
- EXECUTE → 0.20–1.0 based on real completion

Execute-phase guidance:
- 0.20 = just entered execute phase
- 0.30–0.50 = some execution progress
- 0.50–0.80 = significant progress
- 0.80–0.99 = nearly complete
- 1.0 = verifiable completion

Intent is not completion. Research alone caps at 0.10; acquisition goals without confirmation cap at 0.20.
“Proceeding to checkout” or “order confirmed” ≠ finished outcome.
        """
    ).strip()
    prompt += "\n\n\n" + rules_section

    output_section = dedent(
        f"""
OUTPUT CONTRACT
---------------
Evaluation criteria:
{verifier_prompt}

Only award 1.0 when the user would agree the goal is fully done with concrete proof.

Return JSON:
{{
  "reasoning": "<internal thinking about what was actually accomplished>",
  "response": <number between 0.0 and 1.0>
}}
        """
    ).strip()
    prompt += "\n\n\n" + output_section

    return prompt.strip()


__all__ = [
    "TOOL_PHASE_AVAILABILITY",
    "build_system_prompt",
    "build_verifier_prompt",
]
