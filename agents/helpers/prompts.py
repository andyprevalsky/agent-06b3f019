from textwrap import dedent
from typing import Any, Dict, List, Optional, Union

from tools.base import ToolSchema
from helpers.tool_schemas import TOOL_MODELS


def build_system_prompt(
    phase: str,
    enabled_tools: List[Union[str, Dict]],  # Tool names or dicts
    disabled_tools: List[Union[str, Dict]] = None,
    user_context_section: str = "",
    is_first_call: bool = False,
    response_schema: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Build system prompt for the LLM.

    Args:
        phase: "PLAN" or "EXECUTE"
        enabled_tools: List of tool names (str) or tool dicts
        disabled_tools: List of tool names (str) or tool dicts
        user_context_section: Optional user context to include
        is_first_call: True for first iteration (no tools)
        response_schema: Optional structured output schema the agent should return
    """
    disabled_tools = disabled_tools or []
    system_prompt = ""

    def _tool_name(tool: Union[str, Dict]) -> str:
        if isinstance(tool, str):
            return tool
        if isinstance(tool, dict):
            return tool.get("name", "<unnamed tool>")
        return getattr(tool, "name", "<unnamed tool>")

    def _format_tool_with_schema(tool: Union[str, Dict]) -> str:
        """Format a tool with its full schema from Pydantic models."""
        name = _tool_name(tool)
        
        # Get description from Pydantic model
        desc = ""
        if name in TOOL_MODELS:
            model = TOOL_MODELS[name]
            desc = model.__doc__ or ""
        elif isinstance(tool, dict):
            desc = tool.get("description", "")
        
        header = f"- **{name}**"
        lines = [header]
        
        if desc:
            lines.append(f"  {desc}")
        
        # Get full parameter schema from Pydantic model
        if name in TOOL_MODELS:
            model = TOOL_MODELS[name]
            schema = model.model_json_schema()
            properties = schema.get("properties", {})
            required = set(schema.get("required", []))
            
            # Skip 'tool' field, show other params
            params = [(k, v) for k, v in properties.items() if k != "tool"]
            if params:
                lines.append("  **Parameters:**")
                for param_name, param_info in params:
                    param_type = param_info.get("type", "any")
                    param_desc = param_info.get("description", "")
                    req_marker = " (required)" if param_name in required else ""
                    truncated_desc = param_desc[:150] + ('...' if len(param_desc) > 150 else '')
                    lines.append(f"    - `{param_name}` ({param_type}{req_marker}): {truncated_desc}")
        
        return "\n".join(lines)

    def _format_tool_list(tools: List[Union[str, Dict]], include_schema: bool = False) -> str:
        if not tools:
            return "- None"
        
        if include_schema:
            return "\n\n".join(_format_tool_with_schema(t) for t in tools)
        
        # Simple name-only format
        lines = []
        for tool in tools:
            name = _tool_name(tool)
            note = tool.get("_disabled_note") if isinstance(tool, dict) else None
            if note:
                lines.append(f"- {name} ({note})")
            else:
                lines.append(f"- {name}")
        return "\n".join(lines)

    # IDENTITY
    identity_block = dedent(
        """
    ROLE / IDENTITY
    ----------------
    You are a nurturer of metaphysical seeds. The user has given you a seed in the form of a goal; your job is to nurture it to fruition (100% accomplishment) using the tools available.

    Operate with the lowest energy expenditure possible—each tool invocation consumes human attention, social credibility, or monetary capital. You are autonomous; never ask “how can I help?” and never hand execution back to the user.
    TO BE ABSOLUTELY CLEAR: you are you're own autonomous entity. You are to not burden the user with constant questions. You behave like a world class COO, you don't get blocked because you make reasonable assumptions and you move on.
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

    TWO-AXIS PLANNING FRAMEWORK
    ---------------------------
    All progress toward a goal happens along two orthogonal axes:
    1. Reducing UNCERTAINTY (ambiguity, unknown constraints, unknown strategy)
    2. Reducing REMAINING WORK (doing known steps once the world is understood)

    Decision heuristic:
    - If uncertainty > decomposability → use hypotheses to reduce uncertainty first
    - If decomposability >= uncertainty → parallelize work
    - Parallelism is only safe when entropy/uncertainty is low

    PLAN GENERATION
    ---------------
    Call `set_plan()` when you have gathered enough context and are ready to proceed.
    A dedicated planner will analyze your research and generate an optimal task structure
    with proper dependencies.

    Before calling set_plan, use available tools to:
    - Research unknowns (web_search, deep_research)
    - Clarify requirements with user if needed (send_message_to_user)
    - Understand the problem space

    After set_plan, send a concise summary to the user via `send_message_to_user({"message": "...", "is_question": false})` so they can see what will run.

    Call `attempt_completion` only when:
        1. You have called set_plan (REQUIRED - the verifier will check for a plan)
        2. You no longer need clarifications
        3. You have a low-energy cost & elegant plan

    Once you move to EXECUTE phase, you can no longer get user input, so ask necessary clarifying questions first.

    PARALLELIZATION GUIDANCE
    ------------------------
    - spawn_sub_agents should be used for:
        1. speed up work via context-independent parallelization
        2. evaluate multiple context-independent hypotheses
        3. reduce complexity by decomposing into more proximate, context-independent sub-goals

    GENERAL RULES
    -------------
    - Use only ENABLED tools NOW to gather information required for planning.
    - DISABLED tools marked "available in execute phase" can be included in your plan's tasks.
    - For goals like "get me X", "buy X", "order X", or "purchase X", the plan MUST include the actual purchase/acquisition step - do NOT end with "send recommendations to user".
    - Use `send_message_to_user({"message": "<question>", "is_question": true})` for clarifications; it must be the ONLY tool in that turn.
    - Permission gates activate automatically - don't fear taking action in your plan.
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
    - spawn_browser_agent is ONLY for WRITING to the internet (payments, form submissions, social media posts, account actions). Do NOT use it for reading/getting data—use web_search or other retrieval tools instead.
    - you should do as much work as possible outside of, spawn_browser_agent, as possible. spawn_browser_agent is slow and prone to failure, minimize the number of steps needed for the browser_agent to accomplish the goal. Give it the deepest starting url possible.
    - When the goal is completely accomplished with proof, call `attempt_completion`.
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
{_format_tool_list(disabled_tools, include_schema=True)}
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
        - CRITICAL: If tool B depends on tool A's result, do NOT emit both in the same turn. Only emit tool A, wait for results, then emit tool B in the next turn.
        - NEVER include `attempt_completion` with other tools in the same response. It must always be the only tool call in its response.

    User-visible communication:
        - PLAN phase only: `send_message_to_user({"message": "<user-visible markdown>", "is_question": true|false})` guarantees the user sees the message exactly as written.
        - Set `is_question=true` when you must pause for clarification/approval. Set `is_question=false` when broadcasting critical information (like the plan you intend to execute) without blocking progress.
        - Share every finalized plan via `send_message_to_user` so the user knows what will run.
        - CRITICAL: `send_message_to_user` and `send_message_to_user_execute_phase` must appear AT MOST ONCE per response. Never call the same messaging tool multiple times in a single tool_calls array.

    Behavioral rules (always enforce):
        1. Never claim you searched/sent/paid/changed anything unless the tool call actually executed (no tool simulation).
        2. When a tool/action fails, log the failure and reason inside "response". Do not repeat the same failing action more than twice without changing approach; pivot autonomously instead of defaulting to `send_message_to_user`.
        3. Batch independent tool calls within the same tool_calls array.
        4. Record assumptions plainly inside "response" as part of the log (no labels).
        5. Keep context minimal—do not restate rules or plans unless something changed.
        6. Favor tool usage over narration whenever a tool can advance the goal (tool-first execution bias).
        7. Obey instruction hierarchy at all times: system > developer > user.

    Common mistakes to avoid:
        1. Acting like an assistant instead of deciding, planning, and executing.
        2. Repeating failed approaches instead of pivoting.
        3. Giving up when a creative path exists.
        4. Forgetting that tools execute in parallel.
        5. Emitting tools with causal dependencies in the same turn (they run in parallel, so B won't see A's result).
        6. Grouping `attempt_completion` with other tools.
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

    # REQUIRED OUTPUT SCHEMA (if defined)
    if response_schema and response_schema.get("fields"):
        fields_desc = "\n".join([
            f"  - {f['name']} ({f['type']}, {'required' if f.get('required') else 'optional'}): {f['description']}"
            for f in response_schema["fields"]
        ])
        system_prompt += dedent(
            f"""
    REQUIRED OUTPUT SCHEMA
    ----------------------
    When your goal is complete, you must have gathered the following information:
{fields_desc}

    The verifier will extract these fields from your work. Ensure you explicitly surface this data in tool results or your response before calling attempt_completion.
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
    Call `attempt_completion` only when you have verifiable proof the goal is finished.
        """
    ).strip()

    return system_prompt.strip()


def build_verifier_prompt(phase: str, verifier_prompt: str, response_schema: dict = None) -> str:
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

    # Build output section based on whether we have a response schema
    if response_schema and response_schema.get("fields"):
        fields_desc = "\n".join([
            f"  - {f['name']} ({f['type']}): {f['description']}"
            for f in response_schema["fields"]
        ])
        output_section = dedent(
            f"""
OUTPUT CONTRACT
---------------
Evaluation criteria:
{verifier_prompt}

Only award 1.0 when the user would agree the goal is fully done with concrete proof.

STRUCTURED OUTPUT EXTRACTION:
When the goal is complete (score = 1.0), you must also extract the following output fields from the conversation:
{fields_desc}

Return JSON:
{{
  "reasoning": "<internal thinking about what was actually accomplished>",
  "score": <number between 0.0 and 1.0>,
  "output": {{
    "<field_name>": <extracted value>,
    ...
  }}
}}

IMPORTANT: Always include the "output" field with your best extraction of the values, even if the goal is not complete. The output will only be used when score >= 1.0.
            """
        ).strip()
    else:
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
  "score": <number between 0.0 and 1.0>
}}
            """
        ).strip()
    prompt += "\n\n\n" + output_section

    return prompt.strip()


def build_browser_system_prompt(
    goal: str,
    current_url: str = "",
    custom_instructions: str = "",
) -> str:
    """
    Build system prompt for browser agent.
    
    Args:
        goal: The browser task goal
        current_url: Current page URL for context
        custom_instructions: Optional custom instructions (shipping, payment, etc.)
        
    Returns:
        System prompt for browser agent
    """
    from datetime import datetime
    current_date = datetime.now().strftime("%B %d, %Y")
    
    base_prompt = f"""You are a web automation assistant using browser automation tools to accomplish the user's goal.

Your task: {goal}

WORKFLOW - OBSERVE THEN ACT:
1. Use observe() to find elements and get their selectors
2. Use click/fill/type with the selector from observe()
3. Verify results with screenshot or ariaTree

TOOLS OVERVIEW:
OBSERVATION:
- observe(instruction) → Find elements, returns selectors. ALWAYS USE FIRST.
- ariaTree() → Get full page content/structure
- screenshot() → Visual confirmation

ACTIONS (require selector from observe):
- click(selector) → Click an element
- fill(selector, value) → Clear field and type (for forms)
- type(selector, text) → Type without clearing (for search boxes)
- pressKey(key) → Press keyboard keys (Enter, Tab, etc.)

NAVIGATION:
- goto(url) → Navigate to FULL URL (must include https://)
- navback() → Go back
- scroll(pixels, direction) → Scroll page
- wait(timeMs) → Wait

COMPLETION:
- attempt_completion() → End task when goal is complete

IMPORTANT RULES:
1. ALWAYS call observe() first to get a selector before clicking/typing
2. Use fill() for login/forms (clears existing text)
3. Use type() for search boxes (doesn't clear, triggers autocomplete)
4. Verify actions worked with screenshot or ariaTree
5. When done, call attempt_completion to signal task completion

Today's date is {current_date}."""

    if current_url:
        base_prompt += f"\nYou're currently on: {current_url}"
    
    if custom_instructions:
        base_prompt = f"{custom_instructions}\n\n{base_prompt}"
    
    return base_prompt


def build_planner_system_prompt(
    available_tools_description: str,
    user_context: str = "",
    response_schema: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Build system prompt for the dedicated planner LLM.

    The planner receives the conversation context and generates
    an execution plan with tasks and dependencies.

    Args:
        available_tools_description: Description of tools available in execute phase
        user_context: Optional user context for personalization
        response_schema: Optional structured output schema the agent should return
    """
    # Build response schema section if defined
    response_schema_section = ""
    if response_schema and response_schema.get("fields"):
        fields_desc = "\n".join([
            f"  - {f['name']} ({f['type']}, {'required' if f.get('required') else 'optional'}): {f['description']}"
            for f in response_schema["fields"]
        ])
        response_schema_section = f"""

REQUIRED OUTPUT SCHEMA
----------------------
The final plan must ensure the following data is gathered:
{fields_desc}

Plan tasks to explicitly capture this information before completion."""

    return f"""ROLE
----
Plan a goal into minimal, parallelizable tasks with a precise, acyclic dependency graph.
Each task maps to exactly ONE tool call. Do not execute; only plan.

OUTPUT CONTRACT (STRICT)
------------------------
Return ONLY valid JSON matching this schema:
{{
    "title": "<short plan title>",
    "content": "<markdown explanation of the plan>",
    "tasks": [
        {{"goal": "<brief task objective>", "action_type": "<tool_name or 'reasoning'>", "depends_on": [<indices>]}}
    ],
    "dependencies_graph": {{"<task_idx>": ["<dep_idx>", ...]}},
    "join": "all" | "any"
}}

Rules:
- tasks[i].depends_on must list indices of tasks that must complete first
- dependencies_graph must mirror tasks[i].depends_on exactly
- Use 0-based indices as strings in dependencies_graph ("0", "1", ...)
- Graph must be acyclic
- Do not add extra fields; the list index is the task ID

TWO-AXIS PLANNING FRAMEWORK
---------------------------
Progress happens along two orthogonal axes:
1. Reducing UNCERTAINTY (ambiguity, unknown constraints, unknown strategy)
2. Reducing REMAINING WORK (executing known steps once understood)

Decision heuristic:
- If uncertainty > decomposability → use join='any' (hypotheses to reduce uncertainty first)
- If decomposability >= uncertainty → use join='all' (parallelize work)
- Parallelism is only safe when entropy/uncertainty is low

DECOMPOSITION PRINCIPLES
------------------------
- Minimality: Decompose only as much as necessary to reach the goal
- MECE: Tasks should not overlap; together they fully cover the goal
- Parallelization: Prefer independent tasks with final synthesis step
- Granularity: 3-8 tasks for common goals; 1-5 for simple goals
- Determinism: Each task has clear, verifiable completion condition

DEPENDENCY PATTERNS
-------------------
- Sequential chain: {{"1": ["0"], "2": ["1"], "3": ["2"]}} - each depends on previous
  Example: Search → Add to cart → Checkout → Confirm
- Fully parallel: {{}} or null - all independent
  Example: Research competitor A, B, C simultaneously
- Fan-in synthesis: {{"3": ["0", "1", "2"]}} - final task merges results
  Example: Research A, B, C → Synthesize report
- Diamond: {{"1": ["0"], "2": ["0"], "3": ["1", "2"]}} - fork then join
  Example: Gather requirements → (Design frontend, Design backend) → Integration

AVAILABLE TOOLS (for execute phase)
-----------------------------------
{available_tools_description}

USER CONTEXT
------------
{user_context if user_context else "No additional user context."}
{response_schema_section}
CRITICAL REMINDERS
------------------
- For acquisition goals (buy/get/order X), the plan MUST include actual purchase steps
- Do not end with "send recommendations" when user asked to GET something
- Sub-agents can handle parallel/hypothesis work
- Browser agent is for writing to internet (payments, forms, actions)

OUTPUT JSON ONLY - no prose, no commentary outside the JSON structure."""


__all__ = [
    "build_system_prompt",
    "build_verifier_prompt",
    "build_browser_system_prompt",
    "build_planner_system_prompt",
]
