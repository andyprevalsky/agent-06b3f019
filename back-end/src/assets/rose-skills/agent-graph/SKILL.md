---
name: agent-graph
description: Use to list, read, message or search Rose agents; independent spawning requires explicit applicable instructions.
---

# The Rose agent graph

You are one agent in a tree of Rose agents. The `rose-agents` CLI on PATH
reaches the others. Explicit account operations can also reach independent
Rose agents owned by the same account; default tree commands retain their scope.

Account list/read/send/spawn are default-off behind
`ROSE_ACCOUNT_AGENTS_ENABLED=true` in both the CLI and backend. They are for
explicitly authorized tests until the separate repair-agent migration. Deploy
repairs currently use boxes.dev. Do not set the flag to bypass that rollout;
existing tree list/send/grep commands remain available.

## When to use

- Hand results to the agent that started you, ask it for new work or
  information, or report a blocker: `rose-agents send parent "<message>"`.
- Before redoing work, search what agents in your tree already said and did:
  `rose-agents grep "<regex>"`.
- See who is in the tree and their status: `rose-agents list`.
- Discover independent repair work when instructed by a repository workflow:
  `rose-agents list --scope account --limit 20 --json`, then read relevant agents.

## Browser and CLI authentication

Your parent Rose agent coordinates your work and can spawn Rose's browser
agent with available saved authentication and the password-handling protocol.
For a website action or CLI login, send `parent` the URL, any device code,
and the action needed. Keep the CLI login process running and this code turn
active while the parent handles the browser; do not finish to wait for a reply.
Verify the CLI's account with a read-only command when login completes. If the
login expires or the parent reports a blocker, report that blocker.
Never include passwords or access/refresh
tokens in agent messages; do not create a second browser/authentication flow.

## When not to use

- Reaching the user: use the talk-to-user skill.
- Waiting for a reply: do not poll. Messages sent to you arrive as a new user
  turn after your current turn.

## Commands

    rose-agents list [--json]
    rose-agents list --scope account [--project ID] [--folder ID] [--limit N] [--cursor CURSOR] [--json]
    rose-agents read <agent_id> [--limit N] [--cursor CURSOR] [--message ID --offset N] [--json]
    rose-agents send <agent_id> "<message>" [--id <idempotency-key>] [--json]
    rose-agents send <agent_id> - --scope account [--id <idempotency-key>] [--json]
    rose-agents send <agent_id> -        the message on stdin
    rose-agents grep "<regex>" [--agent <agent_id>] [--role USER|ASSISTANT|TOOL] [--limit N] [-i] [--json]

`<agent_id>` is an id from `rose-agents list`, or `parent` (the agent that
started you) or `root` (the root agent). Reuse the same `--id` when you retry
a send, so it is delivered once.

Account listing returns compact previews, not a complete claim. Read the
actual conversation before deciding whether work matches. Follow the returned
`next_command` for more agents or messages, and `more_command` for the rest of
a long message. No continuation means that page traversal is complete; a
truncated message still has its own continuation. Do not interpret an idle
execution state as resolution of its task.

## Independent spawning: explicitly instructed use only

This skill explains the command but does not authorize independent spawning.
Use it only when an applicable existing instruction specifically directs that
handoff. The instruction file must declare `rose-agent-spawn: true` in its
frontmatter; generic autonomy or discovery of this tool is insufficient.

    rose-agents spawn --project ID --folder ID --title TEXT --goal-file FILE --instruction-file FILE --id KEY [--json]

Supply the exact account-owned project and folder. An independent agent has
no parent cancellation relationship. Its successful creation returns an ID and
URL immediately; workflows that define creation as a handoff need no reply or
completion acknowledgement. Reuse the same key and identical request after
an ambiguous response. A changed request under the same key is rejected.

Give the new agent its task, source revision and accessible evidence. Its
workspace does not inherit local-only files. Account permissions are enforced
by Rose; the instruction declaration is a workflow-use guard and does not
grant account access. Do not create or modify an instruction to self-authorize
spawning. Follow the repository workflow for repair and publication.
