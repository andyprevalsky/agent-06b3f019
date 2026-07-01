"""Prompt for spawn_agent tool."""

PROMPT = """Use this tool to launch a new agent for complex, multi-step tasks. Each agent gets an isolated context, toolset, and runtime container.

Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
- general_purpose: Executes multi-step, cross-domain tasks. It is constructed like you, can run in PLAN or EXECUTE, and can spawn more agents underneath it.
- explore: Read-only information gathering across web, user data, and related sources. Use it for concrete facts and load-bearing evidence. Focus its goal; for unrelated facts, spawn multiple explore agents at once.
- browser: An agent specialized for browser use. It should primarily be used for stateful web trajectories, or for reading data that cannot be obtained from an explore agent due to authorization requirements. This agent has access to connected user accounts, credentials & passwords in order for it to take actions on behalf of the user.
- code: An agent specialized in executing code commands. It lives in an ephemeral E2B sandbox and uses Anthropic's Claude Code. It syncs results to a GitHub repo initialized to this agent network after completion. Sandboxes are short-lived, so the task should be tightly scoped and self-sufficient.
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
