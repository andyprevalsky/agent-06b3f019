---
id: 2026-08-21-descendant-tool-writes-default-to-generation-one
date: 2026-08-21
title: Header-less descendant TOOL writes default to generation 1, so live browser/explore steps are converted into "Tool interrupted by deployment"
surface: back-end
component: agents-message-generation-fence
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/agents/routes.messages.ts — an internal TOOL write with no X-Agent-Workflow-Generation header is defaulted to `req.params.id` (i.e. generation 1) instead of being treated as unattributed
symptoms:
  - "Tool interrupted by deployment"
  - "new code version deployed, retry this tool"
  - "DEPLOY_INTERRUPTED"
  - "wall of red tool chips after a deploy while the browser agent is still running and succeeds"
  - "one workflow replacement produces dozens of interruption chips"
tags:
  - workflow-generation
  - deployment-cutover
  - deployment-fence
  - spawn-browser-agent
  - spawn-agent
  - descendant-writes
sources:
  - agent 219dd80e-c2ed-4dc1-a40e-b2b9ea7e0a87
repro: back-end/src/tests/blackbox/agents-cutover-subagent-close.cases.ts + agents-messages.cases.ts — "POST /:id/messages — a header-less descendant TOOL write is never fenced as a stale deployment"
status: fixed
---

## Problem

Prod agent `219dd80e-c2ed-4dc1-a40e-b2b9ea7e0a87` (roselabs.ai, SMS-sourced Blue
Bottle pickup order) rendered a wall of red chips reading **"Tool interrupted by
deployment" / "new code version deployed, retry this tool"**. 105 such rows were
written between 17:12 and 18:43 UTC, in bursts every 15–35 seconds — a cadence no
deploy schedule can explain.

**Those 105 rows are TWO different defects, not one.** Partitioning them by
writer fingerprint (`save_browser_action_message` stamps `action_type` /
`browser_url` / `task_id`; `post_agent_message` does not) splits them cleanly:

| rows | writer | span | verdict |
| ---- | ------ | ---- | ------- |
| 71 `spawn_agent` | header-sending (`post_agent_message`) | 17:13:34 → 18:43:01 | fence working **correctly** — reporting defect B |
| 33 `spawn_browser_agent` + 1 `browser_session_auth` | headerless (`spawn_browser_agent_v3/repo.py`) | 17:12:45 → 18:37:00 | defect A — mislabel |

The cutover was at 17:13:27. **71 rows carry 71 distinct `toolCallId`s spread
across the following 90 minutes.** A finalizer pass emits at most one row per
`(agentId, generation, toolCallId)` and cannot invent new call ids minutes later,
so this is not a sweep — it is a **generation-1 worker that kept issuing live
`spawn_agent` tool calls for 90 minutes after it was replaced**. Every one of
those writes was correctly converted, because the worker genuinely was stale.

Corpus-wide over 14 days the same partition gives **3,983 rows / 81 agents** for
the headerless browser writer (defect A) and **1,297 rows / 445 agents** for
header-sending writers (defect B). Defect A dominates row count; defect B touches
5× more agents.

The decisive counts, from the prod DB:

- The agent has exactly **two** workflow generations that ever wrote a TOOL row:
  the original `219dd80e-…` (339 rows) and one replacement
  `219dd80e-…:replacement:fc59affd-7cbf-4415-829e-93d9e8e7891a` (250 rows).
  **One replacement produced 105 interruption chips.**
- In the 18:30–18:37 window, 21 of those chips were `spawn_browser_agent`, all
  carrying `subAgentId 0ef82edd-f6f2-41c7-8f8c-6ecec90e0c04`, and **each had a
  different `toolCallId`** shaped like an LLM provider id (`call_KtNppoASRLtuNM1nOlVCTaRF`,
  `toolu_01Xcf1…`, plus one `browser-diagnostics:0ef82edd-…`).
- The tool was never actually interrupted. `call_KtNppoASRLtuNM1nOlVCTaRF` was
  written `IN_PROGRESS` at 18:30:13 and `FINISHED` **"✅ SUCCESS"** at 18:36:59,
  both in the `:replacement:` generation. The browser agent ran for seven more
  minutes and completed the order; only its chips were rewritten into errors.
- The agent ended `COMPLETED` with a success `statusMessage`, never `FAILED` with
  `RECONCILED_STATUS_MESSAGE`, which excludes
  `workflowLivenessReconciler.sealAgent` (the other writer of this exact
  title/text/errorCode) as the source.

Population impact, last 14 days: **5,280 `DEPLOY_INTERRUPTED` rows across 502
agents**. Among rows whose stored generation equals the plain agent id, the
toolName distribution is `spawn_browser_agent` 3,880, `cloud_agent` 403,
`spawn_agent` 239, `agent_init` 52, `browser_session_auth` 25,
`request_user_approval` 16, `spawn_claude_code_agent` 8. A join that requires the
same `toolCallId` to be **simultaneously live in a different generation** — an
unambiguous mislabel — yields **378 rows across 19 agents**.

`cloud_agent` and `agent_init` are written by `agents/workflows/agent_workflow.py`
through `post_agent_message`, which *does* send the generation header; those rows
are a genuinely superseded root worker being fenced correctly and are **not** this
bug.

**The browser path recovered; the explore path did not.** Filtering the fabricated
chips out of the 18:29–18:37 window leaves a clean storyline in the
`:replacement:` generation:

```
18:29:55  wait_for            ERROR       Checked every 3 minutes for 18 minutes…
18:30:12  ASSISTANT
18:30:13  spawn_browser_agent IN_PROGRESS   <- the replacement agent re-spawns it
18:36:59  spawn_browser_agent FINISHED      **Status**: ✅ SUCCESS
18:37:10  attempt_completion  FINISHED
18:37:18  completion_summary  FINISHED
```

The replacement LLM re-spawned the browser agent 18 seconds after its `wait_for`
gave up, and it completed the order. That half of the user's question — "shouldn't
the browser agent just immediately restart?" — resolves to *it did*, buried under
fabricated chips.

The explore half does not. `cleanupNonterminalDescendantWorkflows` runs inside
`sealClaimedReplacement` (`agentRestartService.ts`), but it only reaches descendant
**Agent rows**; an in-flight Temporal **activity** and its backend browser session
are invisible to it, and Temporal `TERMINATE` does not synchronously stop a running
activity — it keeps stepping until its heartbeat / start-to-close timeout. And when
cleanup *does* reach a descendant, `workflowDescendantCleanup.ts`
(`completeDescendantCleanup`) marks it `status: 'FAILED'` with
`DEPLOY_INTERRUPTED_TOOL_MESSAGE` — descendants are **killed permanently, never
restarted**. Only the root gets a replacement. Re-issuing the interrupted child work
is left entirely to LLM discretion; there is no deterministic re-spawn anywhere in
`agents/` or `back-end/`. Browser-resume machinery already exists
(`spawn_browser_agent_v3/handler.py`, `fetch_session_info(validate_live=True)` +
`resume_browser_session`) and nothing invokes it on replacement.

So the 71 zombie `spawn_agent` writes are a **cost and resource leak**, not
cosmetics: a replaced generation kept driving LLM calls and paid browser sessions
for 90 minutes.

## Diagnosis

Critical path: browser sub-agent step → `save_browser_action_message` →
`POST /api/agents/:id/messages` → `routes.messages.ts` → `agentMessageService.postMessage`
→ `createWorkflowMessageGroup` → `persistLockedToolLifecycleMessage` → Message row
→ Supabase broadcast → FE chip.

Where the data first goes wrong — the generation attached to the write:

1. `back-end/src/domains/agents/routes.messages.ts:67-70` reads
   `req.header('x-agent-workflow-generation') ?? req.params.id` for internal
   requests. A missing header becomes the agent id. The same silent default is
   repeated at `routes.status.ts:70`, `routes.ts:207`, and
   `domains/tool-usage/routes.ts:96` — four sites, not one. The correct
   fail-closed pattern already exists in this codebase at `routes.status.ts:21-23`,
   which **400s** when the header is absent.
2. `back-end/src/domains/agents/agentMessageService.ts` repeats the same fallback
   (`const generation = workflowGeneration ?? agentId`).
3. `back-end/src/providers/messages.ts` `createWorkflowMessageGroup` then
   **overwrites** `metadata.workflowGeneration` with that header-derived value for
   every `role: 'TOOL'` write. The agents-side `stamp_tool_workflow_generation()`
   is not dead code (`helpers/messages.py` stamps *and* sends the header, asserted
   by `agents/tests/blackbox/messages.blackbox.py`) — but it is unconditionally
   clobbered, so it can never repair a missing header.
4. `back-end/src/providers/toolLifecycleMessages.ts` computes
   `staleWorkerWrite = Agent.temporalWorkflowId !== identity.workflowGeneration`
   and, when true, replaces the write wholesale via `deploymentInterruptedParams()`
   — text `new code version deployed, retry this tool`, title
   `Tool interrupted by deployment`, `toolStatus: 'FINISHED'`, `error: true`,
   `errorCode: 'DEPLOY_INTERRUPTED'`.

Because the agent id *is* the first generation's workflow id, "no header" and
"generation 1" are indistinguishable. Before any replacement that alias is
harmless. After one, it is always wrong.

Five agents-side TOOL writers never send the header (a sixth,
`save_browser_assistant_message`, posts role ASSISTANT and is not a TOOL writer):
`agents/domains/spawn_browser_agent_v3/repo.py` (`save_browser_action_message`,
`save_browser_credential_ref_message`), `agents/domains/spawn_agent/repo.py`
(`save_explore_message`), `agents/domains/spawn_claude_code_agent/repo.py`,
`agents/domains/call_phone_number/repo.py`. Only
`agents/helpers/messages.py::post_agent_message` sends it. Each browser step mints
a fresh provider `tool_call_id` (`_browser_action_tool_call_id` in
`spawn_browser_agent_v3/handler.py`, sourced from the streamed chunk id in
`streaming.py`), which is why one live sub-agent produced ~20 distinct red chips
rather than one.

Step 5a ladder:

- **Why 1** — six descendant writers omit the generation header. *Evidence: zero
  `workflow_generation_headers` occurrences in those four `repo.py` files against
  10 `stamp_tool_workflow_generation` call sites.*
- **Why 2** — omitting it is silently survivable because the route fabricates
  `req.params.id`. A missing attribution is promoted to a real, wrong generation
  rather than rejected. *Evidence: `routes.messages.ts` `?? req.params.id` and the
  duplicate `?? agentId` in `agentMessageService.ts`.*
- **Why 3** — two mechanisms carry the same fact (a metadata stamp and a header)
  and the backend silently lets the header win, so the stamp cannot fail loudly.
  *Evidence: the unconditional metadata overwrite in `messages.ts`.*
- **Why 4** would be "the fence was designed without a required attribution
  contract" — a design decision whose repair already lives at Why 2/3. **Stop.**

Deepest owned cause: **"no generation supplied" is silently aliased to
"generation 1" instead of being treated as unattributed.**

Archive searches run: `new code version deployed, retry this tool Tool
interrupted by deployment workflow replacement sub-agent not restarted`; `agent
does not retry interrupted tool after replacement stalls thinking no progress`;
`workflow replacement unresolved tool results terminal error browser sub-agent
orphaned`. Nearest hits were
`2026-08-21-chat-escalation-overwrites-workflow-generation` and
`2026-08-04-scheduled-wait-for-not-preserved-across-deploy-workflow-replacement`.
Both are **relatives, not recurrences**: those cases corrupt or mis-scope the
Agent row's generation, whereas here the Agent row is correct and the *incoming
write* is mis-attributed.

## Solution

Shipped. Both defects, verified by `222 passed, 0 failed` in the agents blackbox
domain — the three captured failures flip to pass with their assertions unchanged.

**Defect B — the cutover never closed the sub-agent.** `sealClaimedReplacement`
now calls `releaseAgentBrowserSessions(agentId)` after sealing, so the replaced
generation's rented browsers are closed instead of orphaned. Failure is logged,
never fatal: a browser-provider outage must not block a cutover.
`completeDescendantCleanup` had the same hole from the other side — it marks a
child FAILED with a raw `tx.agent.updateMany`, bypassing `updateAgentStatus` and
therefore `releaseTerminalBrowserSessions` — so a compensating release was added
there too, mirroring `workflowLivenessReconciler`.

**Defect A — live writes mislabeled as generation 1.** `routes.messages.ts` no
longer defaults a missing generation header to `req.params.id`; the header is
passed through as `undefined` and `agentMessageService` attributes the write to
the agent's live generation via `repo.currentAgentWorkflowGeneration`. All four
agent-side domain writers (`spawn_browser_agent_v3`, `spawn_agent`,
`spawn_claude_code_agent`, `call_phone_number`) now send
`workflow_generation_headers()`, so attribution is explicit rather than inferred.

**Still open — deterministic restart.** The sub-agent is now closed, but nothing
re-issues it: re-spawning remains the replacement LLM's decision, and the browser
resume machinery (`fetch_session_info(validate_live=True)` + `resume_browser_session`)
is still only reachable from the write-lock/payment path. The same silent
`?? agentId` default also survives at `routes.status.ts`, `routes.ts`, and
`domains/tool-usage/routes.ts` — untouched here because their fence semantics
differ and no test covers them yet.

Candidate fixes, in Step 6a order:

1. **Unify (preferred).** Make the generation attribution single-sourced and
   mandatory for internal TOOL writes: drop the `?? req.params.id` /
   `?? agentId` fallbacks, delete the now-dead `metadata.workflowGeneration`
   stamp path, and have every agents-side writer send
   `workflow_generation_headers()`. An unattributed internal TOOL write then
   fails loudly instead of being converted into a fabricated terminal error.
2. **Guard (narrower).** Add `**workflow_generation_headers()` to the six
   descendant writers only. This fixes the observed instance but leaves the
   silent default in place for the next writer that forgets.

Sibling failures option 1 also prevents: explore sub-agent chips
(`save_explore_message`), Claude Code sub-agent chips, phone-call chips,
`credential_ref` outcomes being discarded as deploy errors, and — most
seriously — `closeInterruptedAttentionRequest` auto-answering a pending
`request_user_approval` with "new code version deployed, retry this tool" (16
such rows in 14 days).

10k agents: strictly reducing. Today every mis-attributed write costs a
`fenceLatestTerminal` candidate scan plus a junk Message row plus a realtime
broadcast; one agent generated 105 of them from a single replacement. Removing
the mislabel removes that per-step write amplification. The change is per-request
header handling with no new fan-in, shared state, or per-agent polling.

## Open — deterministic restart, and the sibling default sites

Closing the sub-agent is shipped and tested. **Restarting** it is not: there is
still no deterministic re-issue of an interrupted browser/explore tool call
(`_resume_interrupted_wait` covers `wait_for` timestamps only). Proving the
in-flight activity actually stops also needs a live-worker e2e — no DB artifact
exists for an orphaned activity, so the blackbox cannot see it.

## Human feedback

The user identified the defect class before the investigation did — "shouldn't the
browser agent or explore agent just immediately restart? this seems hella janky?
**the conversion seems wrong**". Both halves of that sentence turned out to name a
real, *separate* defect: the conversion is wrong (A) **and** the agents genuinely
do not restart (B).

An adversarial review pass corrected this RCA mid-flight and its objections are
recorded here because they were load-bearing:

- The first draft claimed all 105 chips were mislabels. **Falsified** — 71 were the
  fence working correctly. `workflowGeneration == agentId` is ambiguous between
  "header missing → defaulted" and "correctly stamped by a live generation-1
  worker", because generation 1's Temporal workflow id *is* the agent id
  (`providers/temporal.ts` `params.workflowId ?? params.agentId`). The writer
  fingerprint partition is what disambiguates; run it before attributing.
- The first draft concluded "recovery was never broken, this is a UI artifact."
  **Wrong**, and it would have shipped a cosmetic fix while a 90-minute cost leak
  stayed live.
- "Dead code", "six of seven writers", and "descendant" were all imprecise; see the
  corrections inline above.

No fix approach has been rejected yet.

## Reusable lesson

When an identifier's "absent" value is spelled the same as a real value (here, "no
generation header" defaults to the agent id, which *is* generation 1), every
forgotten attribution silently becomes a confident wrong answer — and it also
destroys your ability to attribute the resulting rows, so partition by writer
fingerprint before blaming a mechanism.
