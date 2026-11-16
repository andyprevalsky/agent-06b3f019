"""Prompt for spawn_agent tool.

``PROMPT`` is the stock prompt. ``PROMPT_ROSE_DESKTOP`` (Rose Desktop accounts,
``utils.rose_desktop``) differs only in the ``- code:`` line, which also says
the code sandbox holds the user's rose_user_ui and ships viewable work as an
inline view. Both code lines end with ``CODE_VIDEO_SENTENCE``: video generation
and editing go to a code agent (the sandbox ``rose video`` tool + ffmpeg).
"""

CODE_VIDEO_SENTENCE = "Send video generation or editing to a code agent; tell it to make real footage with `rose video` and edit with ffmpeg."
CODE_LINE = (
    "- code: An agent specialized in executing code commands. It lives in a persistent E2B sandbox and uses "
    "Anthropic's Claude Code. After completion it syncs results to its project's repo (github_repo_ref), or "
    "without one to a repo created for this agent tree. The task should be tightly scoped and "
    "self-sufficient. " + CODE_VIDEO_SENTENCE
)
CODE_LINE_ROSE_DESKTOP = (
    "- code: A Claude Code or Codex CLI agent in a persistent sandbox holding the user's Rose app UI; give it "
    "all code writing except one HTML page you can write yourself, such as a chart or scorecard, which you "
    "show with display html. For a game or app the user asked to play or use, "
    "have it show it in Agent Display using rose display and return the display receipt. "
    "A final file path alone does not display the result. Keep the task tightly "
    "scoped and self-sufficient. " + CODE_VIDEO_SENTENCE
)

_PROMPT_TEMPLATE = """Use this tool to launch a new agent for complex, multi-step tasks. Each agent gets an isolated context, toolset, and runtime container.

Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
- general_purpose: A general-purpose agent for executing multi-step, cross-domain tasks. This agent is constructed in the exact same way you are, and can be spawned in either the PLAN or the EXECUTE phase. A general_purpose agent can spawn more agents underneath it, which is a unique privilege for this agent type alone. DO NOT use this agent type or assign it a goal unless that goal is sufficiently distinct from the goal you are tasked with. Each general_purpose sub-agent's task complexity must be strictly less than half of your issued task complexity; otherwise do the work yourself. Be wary of infinite recursion: general_purpose sub-agents can also spawn sub-agents. When using one as an intelligent retry for a faulty tool, instruct it not to spawn more general_purpose sub-agents; otherwise it will likely spawn another general_purpose to retry the same faulty tool after the first error.
- explore: The agent for information retrieval and discovery. Use it before another agent whenever that agent needs public facts, targets, or routes not already provided. Give it a code_session_id to ask about a code agent's code.
- browser: A stateful web executor. It may read pages while carrying out a known trajectory, or access data requiring browser-only authorization. Public research, target discovery, and route discovery belong in explore first. This agent has the user's connected accounts, credentials, saved address, and stored payment (auto-pays up to a limit); don't ask the user for address or payment.
{code_line}
- for_each: An agent orchestrator that fans out one templated general_purpose agent per item from a list or CSV. If you need to spawn more than 5 general-purpose agents in one turn, strongly consider using for_each; it is optimized for spawning many agents at once.

Parameter wording:
- Required when type='X' means the field must be supplied for that agent type.
- Optional when type='X' means the field applies to that agent type, but should only be supplied when grounded by the task.
- Ignored for type='X' means do not supply the field for that agent type.

## Writing the agent's goal

Brief the agent like a smart colleague who just walked into the room; it has not seen this conversation or why the task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Terse command-style prompts produce shallow, generic work.

Cost Structure:
- explore << code < browser < general_purpose < for_each
If you can accomplish a task with a single instance of a cheaper agent, you should.

Usage:
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses or the for_each agent type."""

PROMPT = _PROMPT_TEMPLATE.replace("{code_line}", CODE_LINE)
PROMPT_ROSE_DESKTOP = _PROMPT_TEMPLATE.replace("{code_line}", CODE_LINE_ROSE_DESKTOP)
