"""Prompt for spawn_agent tool."""

PROMPT = """Use this tool to launch a new agent to handle complex, multi-step tasks autonomously. Each sub-agent gets its own isolated context, toolset, and runtime container.

Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
- sub_agent: A general-purpose agent for executing multi-step, cross-domain tasks. This agent is constructed in the exact same way you are, and can be spawned in either the PLAN or the EXECUTE phase. A sub_agent can spawn more agents underneath it, which is a unique privilege for this agent type alone.
- explore: A read-only agent specialized in extracting information from the environment you are in. When you need concrete facts or load-bearing pieces of information, use this agent type to retrieve that information. It has tools to search the internet, user data, and more. This is the default choice for information gathering tasks.
- browser: An agent specialized for browser use. It should primarily be used for stateful web trajectories, or for reading data that cannot be obtained from an explore agent due to authorization requirements.
- code: An agent specialized in executing code commands. It lives in an ephemeral E2B sandbox and uses Anthropic's Claude Code. It syncs results to a GitHub repo initialized to this agent network after completion. Sandboxes are short-lived, so the task should be tightly scoped and self-sufficient.
- for_each: An agent orchestrator that fans out one templated sub_agent per item from a list or CSV. If you need to spawn more than 5 sub_agents in one turn, strongly consider using for_each; it is optimized for spawning many agents at once.

## Writing the agent's goal

Brief the agent like a smart colleague who just walked into the room; it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Terse command-style prompts produce shallow, generic work.

Cost Structure:
- explore << code < browser < sub_agent < for_each
If you can accomplish a task with a single instance of a cheaper agent, you should.

Usage:
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses or the for_each agent type."""
