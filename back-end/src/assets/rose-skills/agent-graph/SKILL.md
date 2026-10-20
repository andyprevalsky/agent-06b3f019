---
name: agent-graph
description: Use to list, message or search the other agents in your tree (the agent that started you, the root agent, siblings, children).
---

# The Rose agent graph

You are one agent in a tree of Rose agents. The `rose-agents` CLI on PATH
reaches the others.

## When to use

- Hand results to the agent that started you, ask it for new work or
  information, or report a blocker: `rose-agents send parent "<message>"`.
- Before redoing work, search what agents in your tree already said and did:
  `rose-agents grep "<regex>"`.
- See who is in the tree and their status: `rose-agents list`.

## When not to use

- Reaching the user: use the talk-to-user skill.
- Waiting for a reply: do not poll. Messages sent to you arrive as a new user
  turn after your current turn.

## Commands

    rose-agents list [--json]
    rose-agents send <agent_id> "<message>" [--id <idempotency-key>] [--json]
    rose-agents send <agent_id> -        the message on stdin
    rose-agents grep "<regex>" [--agent <agent_id>] [--role USER|ASSISTANT|TOOL] [--limit N] [-i] [--json]

`<agent_id>` is an id from `rose-agents list`, or `parent` (the agent that
started you) or `root` (the root agent). Reuse the same `--id` when you retry
a send, so it is delivered once.
