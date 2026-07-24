"""Prompt for spawn_agent tool."""

PROMPT = """Use this tool to launch a new agent for complex, multi-step tasks. Each agent gets an isolated context, toolset, and runtime container.

Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
- general_purpose: A general-purpose agent for executing multi-step, cross-domain tasks. This agent is constructed in the exact same way you are, and can be spawned in either the PLAN or the EXECUTE phase. A general_purpose agent can spawn more agents underneath it, which is a unique privilege for this agent type alone.
- explore: The agent for information retrieval and discovery. Use it before another agent whenever that agent needs public facts, targets, or routes not already provided.
- browser: A stateful web executor. It may read pages while carrying out a known trajectory, or access data requiring browser-only authorization. Public research, target discovery, and route discovery belong in explore first. This agent has the user's connected accounts, credentials, saved address, and stored payment (auto-pays up to a limit); don't ask the user for address or payment.
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
