# Background agents + agent-to-agent messages + tree feedback routing

## Goal

1. `spawn_agent` runs in the background by default (`run_in_background`, default `true`).
   The tool returns immediately with an address; completion arrives later as a
   notification row in the parent's conversation (Claude Code `<task-notification>` pattern).
2. Agents can message each other (`send_message_to_agent`) by Codex-style task path. The root sees its
   running agents in the environment block; explore agents can browse the tree with `list_agents`.
   Explore and browser agents (which run inside activities) can also receive messages.
3. A user message sent to the root mid-run is routed by the model, through
   task path + `send_message_to_agent`, down to the subtree it concerns.
4. Benchmark `tree-feedback-routing` proves 3: feedback lands while three levels
   of agents are active and must reach the outreach subtree only.

## System context

```
 user ──msg──▶ backend routeUserMessage ──signal receive_user_response──▶ ROOT workflow
                                                                         │ send_message_to_agent  
                                    backend POST /api/agents/:id/agent-messages (same tree only)
                                         │                         │
                                  DB row on target agent      parent-owned inbox row
                                  + signal receive_user_response   (explore/browser task address)
                                         ▼                         ▼
                              GP child workflow (poll)     explore/browser activity polls inbox
                                         │                 at each loop step
                                  spawn_agent(background) ──▶ grandchildren …
 completion ──child_completed signal / bg task done──▶ parent posts agent_notification row
            (excludeFromFrontend chip, model-visible USER row with notification metadata)
```

## Design decisions

- Background execution reuses the existing tool executors unchanged, run as a workflow
  asyncio task under the spawn's OWN tool-call id T (FE-neutral, 2026-10-19 user decision).
  The "started" row under T is `{runInBackground, hidden}`: the model's tool_result for T
  forever, hidden from the FE. Every executor row under T (or T:<n>) is `excludeFromModel`:
  the workflow stamps its own posts (`_background_row_metadata`), and the backend stamps
  activity-side writers under T's lifecycle lock when T already has a runInBackground row
  (`withBackgroundExecutionStamp`). The FE therefore sees exactly a foreground spawn's rows
  and the cached prefix never rewrites. Completion is a single new appended notification row.
- Planned (DAG) spawns start in the background through the same path (same "started" row,
  hidden bg rows, one notification). The DAG task completes when the child does
  (`_await_dag_background_spawn`), and dependents read the polled notification. A mid-plan
  user/agent message stops new tasks and returns needs_llm (no resume): background spawns
  keep running; an in-flight call_phone_number, message_person (approval) or
  send_message_to_user question keeps running and reports normally; every other in-flight
  task is cancelled immediately with a paired ERROR "interrupted" row.
  Fast Mode / simulate keep planned spawns in the foreground. Older snapshots with DAG
  "adoption" routes are converted on restore.
- Generation handoff / continue_as_new: background tool records park and resume in the
  background; general-purpose children are durable via `pending_children` + `child_completed`.
- attempt_completion is never rejected for pending background agents: it goes through the
  normal verifier, whose evidence ends with a factual "still running" status block (only when
  non-empty, so the verifier's cached prefix is unchanged). If the verifier accepts, the
  finishing parent (`_mark_complete` / `_mark_failed`) stops every pending agent: activity-backed
  tasks are cancelled, general_purpose/for_each children get `parent_finished` and stop as
  orphaned (a finished parent's `parent_state_query.is_finished` backs this up), and late
  `child_completed` signals are ignored. A rejection is ordinary verifier feedback. A turn with no
  tool calls gets the normal no-tool handling even while agents run; the model waits with
  `wait_for(agents=[...])` (2026-10-19 user decision: no idle/blocking wait).
- Environment context: a persisted `<environment>` USER row (metadata `environmentContext`,
  hidden) with date/timezone, own path/parent and running agents, appended only when it
  differs from the last one in the model context (so it is re-emitted after compaction),
  plus an unsaved `<environment-status>` tail (time to the minute, per-agent status/activity)
  appended after the cached prefix on every workflow LLM call (`helpers/environment_context.py`).
- Idle waits do not poll the cutover pointer. After a pointer flip the deploy
  (`broadcast-generation-handoff.ts`, run by `worker_pool_cutover.py` DRAINING and
  existing-process activation) signals `generation_handoff_available` to running
  AgentWorkflows on the old queue; parks wake, confirm via one pointer read and
  continue as new. Lost signals: 20-minute safety re-check. A background task that
  parks for handoff wakes the parent's wait_for the same way.
- Before a generation-handoff continue_as_new, in-flight background browser/code/explore
  tasks get a bounded settle (180s) to park/finish. Context overflow defers
  continue_as_new (keeps the compressed context in-run) while they run, until
  history pressure (30k events / 30 MB) forces a settle + continue.
- No classifier routing: the model decides where feedback goes (CLAUDE.md 25b).
- Scale (10k agents): per-agent signals and rows only; inbox polls are bounded `since` reads of
  one agent's rows; tree listing is one indexed query per call on the caller's root.

## Verification (automated)

- Agents blackbox: background spawn returns immediately; notification row appended once;
  completion reaches the verifier with the pending status; verifier accept stops pending agents; a tool-less turn gets normal no-tool handling (wait_for(agents) waits); environment block diff/re-emit + unsaved tail with byte-identical prefix; handoff parks/resumes background tools; explore inbox
  delivery; message rows never change response schema.
- Backend blackbox: agent-messages endpoint (same-tree auth, cross-tree 403, idempotency key),
  tree listing, inbox poll.
- Benchmark `tree-feedback-routing` (catalog, static checks + judge) via
  `scripts/run-bench --local tree-feedback-routing`.
- Benchmarks `explore-agent-mid-run-message` and `browser-agent-mid-run-message`: a NORMAL user chat
  message sent to the root mid-run (no special steering UI, no message addressed to the sub-agent) is
  routed by the root to the running explore / browser agent and steers it (inbox row before completion,
  browser steps after it), and its result reflects the message. The explore agent's `list_agents` showing explore/browser
  tasks is cemented in the agents blackbox (`background-agents`), not as a benchmark requirement.
- DAG (`dag-executor`, `background-agents`): mid-plan user/agent message breaks out to the execute loop
  promptly; background children keep running and notify once; blocking steps are cancelled immediately
  with paired rows; phone calls and pending approvals/questions are never cancelled.
- Waits (`wait-for`): every wait mode wakes on user message, agent message, agent notification and abort
  (kill / parent finished); `wait_for(agents)`
  wakes on listed agents only, honours `timeout_seconds`, parks/resumes across handoff.
- Later, with phone agents (not implemented in this PR): **Phone agents survive cutover** (`spawn_agent(type="phone")`, owning suites `background-agents` +
  `deploy-resume-e2e` with real Temporal): a generation handoff mid-call (1) never dials a second call —
  the relaunched poller re-initiates with the same idempotency key `agentId:toolCallId` and receives the
  same `call_id` (backend blackbox asserts the vapi initiate endpoint is idempotent on that key);
  (2) resumes polling and posts exactly one notification with the call result/transcript; (3) the cutover
  never waits on the call (handoff completes while the call is still in progress). Each case is written
  to fail first (repro) before the fix.
- All of the above run in the `/deploy` gates (agents blackbox domains, backend blackbox, structural);
  registration in the gate runners is verified, not assumed.

## Next pass (agreed with user 2026-10-19; prompt text pre-approved)

- Every wait wakes on user messages, agent messages, agent notifications and aborts (wait_for all modes).
- (Superseded 2026-10-19: no idle wait while awaiting a reply; wait_for(agents=["parent"]) instead.)
- `wait_for(agents: [paths] | "any", timeout_seconds)`: `timeout_seconds` only valid with `agents`
  (default 600, min 10, max 3600, Codex bounds); exclusive with `condition`. Returns what woke it +
  listed agents' status.
- (Superseded 2026-10-19: no `get_agent` tool. Status of running agents is in the environment block;
  other agents' history is read by an explore agent with `list_agents` + grep over agent_trajectories.)
- `send_message_to_agent` to a finished agent wakes it with the message as its next task (no followup tool).
- `kill_agent(to)`: kill target + subtree. A kill is a normal failure (FAILED, error_reason
  "Killed by <killer>"; descendants "Killed by <killer> (parent <p> was killed)"); no separate status. `interrupt_agent` was removed from the
  toolset (2026-10-19); redirect with send_message_to_agent instead.
- One shared "Working with other agents" prompt section (paths, waking, messaging, asking the parent);
  sub-agent question auto-reply explains asking the parent via send_message_to_agent + wait_for(agents=["parent"]).
- Later: port tree browsing to the SMS agent's `get_environment`.
- Later (not implemented in this PR): phone calls become `spawn_agent(type="phone")` (background by
  default, path, notification with transcript, environment block/banner, kill_agent hangs up). Same implementation underneath: the
  existing call_phone_number handler/activities/approval/simulate path, only routed through spawn_agent.
  Planner alias + row toolName: `spawn_phone_call_agent` (like spawn_browser_agent). Benchmarks counting
  `call_phone_number` keep working via runner name normalization (legacy name → new). send_message_to_agent to a
  live call: later (unsupported error for now). A mid-plan DAG break-out never cancels an in-flight call.

## Agent-to-agent content in the model context (Codex, 2026-10-19)

```
 stored USER row {agentMessage: raw text + fromAgentPath/toAgentPath/messageType}
            or   {agentNotification: rendered body}
   ──▶ build_llm_messages / convert_context_to_messages / planner
       {"role": "assistant", "content": InterAgentText(body)}       (never merged into a model turn)
   ──▶ _ensure_tool_result_pairing: inter-agent messages ride with the turn's non-tool content,
       AFTER that turn's tool results (never between a tool_use and its tool_result)
   ──▶ RoseClient.complete / planner builder: a TRAILING inter-agent message is sent as user
       role (every transport strips trailing assistant messages as prefill)

 body:  Message Type: MESSAGE | NEW_TASK | FINAL_ANSWER | FAILED
        Task name: <recipient path>
        Sender: <sender path>
        Payload:
        <text>      (FAILED payload capped Codex-style: 900 tokens head+tail,
                     "…N tokens truncated…"; FINAL_ANSWER uncapped)
```

The backend stores `messageType` (NEW_TASK when the send wakes a finished agent, else MESSAGE) and `toAgentPath`; the inbox endpoint returns `to_agent_path` / `message_type`.
Verifier: notifications are factual TOOL_RESULT evidence (same budget as spawn results);
agent messages are excluded (like the agent's own assistant turns). Storage stays USER rows, so
"not user authority" checks (response-schema feedback, real user instruction, DAG
break-out by metadata, planner goal, browser instruction sync) keep keying off metadata.

## Agent-to-agent control (implemented 2026-10-19)

```
 send_message_to_agent(to, message) ──▶ backend stores row ─┬─ target running  → signal receive_agent_message
                                                    └─ target finished → wake: CAS terminal→ACTIVE, Agent.goal = message,
                                                       start `<agent>:wake:<message id>` (execute, same tree launch config)
        target: the message only wakes it (wake kind "agent_message": waits end, a DAG breaks out to the
        execute loop); it is read at the next step. In-flight tools, background tasks and children are
        never cancelled by a message.   own activity task → inbox row (read at its next step)
 kill_agent(to) ──own task──▶ activity task cancelled + finished failed / durable child signaled `kill`
                └─else──▶ POST /:self/kill-agent (descendants only) ──▶ signal `kill` {by_agent_id, by_agent_path}
        target: _kill_request + _abort_run → _mark_failed(reason "Killed by K") → its background agents and
        children stop (parent_finished {killed_by, killed_parent} cascade); parent gets child_completed
        {status: failed, error_reason "Killed by K"} and one FAILED notification.
 rewoken child finishes again ──▶ parent appends a NEW <agent-notification> (original spawn result untouched)
```

No `get_agent` / `interrupt_agent` tools (removed 2026-10-19): running agents' status is in the
environment block; history is read by an explore agent (`list_agents` + grep over agent_trajectories).
Kill reuses the existing failure path: no separate killed status anywhere (agents, backend, FE all show
FAILED with error_reason "Killed by …"). Pause reuses the existing pause path: the agent goes PAUSED,
children get the pause cascade, in-flight background activities are cancelled and notify FAILED.

Semantics: only descendants and own background tasks can be stopped (not self, parent, ancestors or other
branches). Prompt: one shared
"Working with other agents" section at the end of MAIN_SYSTEM_PROMPT (static, cached prefix).
Tests: agents `agent-control` blackbox domain; backend `agents-agent-control.cases.ts`.

## Guards, inbox at scale, PLAN foreground, pause parity (2026-10-19)

```
 send_message_to_agent ──▶ backend sendAgentMessage ──▶ guardAgentMessage (agentMessageGuardService.ts)
        same idempotency key already stored ──▶ allowed (retries spend nothing)
        recipient unread ≥ 20 ──▶ 429 "<to> has 20 unread messages; wait for it to catch up …"
        sender GCRA bucket (burst 3, +1/s; Agent.agentMessaging.rateTatMs, one PK UPDATE) empty
                                 ──▶ 429 "Message rate limit: wait a moment before messaging <to> again."
 unread = agent messages to the recipient after its read mark; the mark advances when the
 recipient's own read returns them (worker poll GET /:id?since= → readAt; task inbox read:
 GET agent-inbox, explore post {inbox} → pending_inbox, browser read ?browserToolCallId → taskReadAt[address])

 explore step ── POST /:owner/messages {inbox:{task_id, since}} ──▶ pending_inbox (stashed, delivered next step)
               no answered read for 30s ──▶ one GET agent-inbox (fallback)
 browser step ── existing instruction read already returns the owner's USER rows ──▶ only
               agentMessage rows with recipientTaskId == own address become agent messages (no inbox GET)
```

- PLAN-phase spawns always run in the foreground (`_spawn_runs_in_background`); the PLAN schema
  has no `run_in_background`.
- Pause / cost limit cancel in-flight background explore/browser/code activities through the same
  `tool_stop_requested` check as foreground spawns; the notification reports FAILED (no separate status). Children get
  the existing pause / resume / cost_limit_reached cascade. Delete terminates the workflow, whose
  activities (background or not) are cancelled at their next heartbeat; child agents are deleted
  recursively.
- `wait_for(agents)`: `timeout_seconds` below 10 is clamped to 10 with a note in the result (Codex
  wait floor); above 3600 is rejected.
- Tests: agents `background-agents`, `spawn-agent`, `spawn-browser-agent-v3`, `wait-for`,
  `agent-control`; backend `agents-agent-message-guard.cases.ts`.

## Waking finished explore/browser/code tasks (user decision 2026-10-20)

```
 send_message_to_agent(to=<finished own task path>)
   ──▶ store the row on the finished run's inbox (backend guards: rate + unread cap, NEW_TASK)
   ──▶ _wake_background_task (workflow, deduped by message id): same task id / path / task_name,
       run n+1, inbox `<id>.run<n+1>` (earlier runs' rows are never re-read), goal =
       message + previous goal + previous result (capped head+tail), launched like any
       background task; refused while the owner is paused / killed / finishing / at its cost limit
   ──▶ rows carry `backgroundRun` (workflow stamp; backend copies it onto activity rows)
       → FE dock shows it running again, the trajectory gets a chip per run
   ──▶ new FINAL_ANSWER / FAILED notification (idempotency key `…:run<n>`)
 another agent's send (backend path resolution) ──▶ owner signal receive_agent_message
       {message_id, wake_task_id, message} ──▶ same wake (loop not woken)
```

- Agent.backgroundTasks keeps running tasks plus the owner's 10 newest finished ones
  (completed/failed), so list_agents, grep `trace_path` and send_message_to_agent resolve a
  finished task's path; a terminal owner lists only finished ones. The workflow keeps wake
  context (args + previous result) for its 10 newest finished tasks.
- Tests: agents `agent-control` (wake, dedupe, refusals, signal), `background-agents`
  (persisted finished entries); backend `agents-agent-address.cases.ts`,
  `data-agent-task-path.cases.ts`; front-end `background-agents.blackbox.tsx`.
