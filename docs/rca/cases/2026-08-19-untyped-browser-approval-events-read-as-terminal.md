---
id: 2026-08-19-untyped-browser-approval-events-read-as-terminal
date: 2026-08-19
title: Untyped browser approval-resume events matched the legacy terminal shape, so the live panel and chip closed mid-run
surface: front-end
component: terminal-derivations
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py:9538 ("Payment card ready") and :9043 ("✓ Write permission granted") yield workflow-scope spawn_browser_agent events with no action_type, which front-end/src/features/terminal/hooks/derivations.ts:138-144 (isBrowserTaskTerminalMessage legacy branch) reads as a browser-task terminal
symptoms:
  - browser agent shows as completed after the user approves the payment card
  - live browser panel disappears after "Payment card ready" and never comes back; Open Browser button does nothing after a persistent BrowserSession task is reused
  - "Payment card ready" carries toolName spawn_browser_agent, task_id, toolStatus FINISHED and no action_type
  - "✓ Write permission granted" closes the browser panel on write-lock approval
  - Task Incomplete - Max Steps Reached after "Resuming from write lock approval"
tags:
  - browser-agent
  - front-end
  - chip-lifecycle
  - message-scope
  - payment-approval
  - write-lock
sources:
  - agent 7f354640-ffab-4098-b7ae-041ddf246c6f
  - commit e5f87f9a4
  - PR #791
  - agent 3392bb69-807b-4ef9-a671-2e5eeb92efa7
repro: front-end/src/tests/blackbox/browser-panel-derivations.blackbox.ts (describe 'browser panel survives approval-resume handoffs')
status: open
---

## Problem

Prod agent `7f354640-ffab-4098-b7ae-041ddf246c6f` (SMS, 2026-08-19, Blue Bottle
pickup order) reached checkout on `order.online`, called `request_payment_card`,
and the user approved the $17.31 card at 18:11:00Z. From that moment the UI
showed the browser agent as **completed** and the live browser panel vanished,
so the run read as stalled.

The browser task was in fact still running. Runtime evidence from
`GET /api/agents/<id>` plus `observability.fly_logs`:

| time (Z) | evidence |
| --- | --- |
| 18:10:17 | `action_type=request_payment_card`, `task_id=ba744d18`, FINISHED "Payment card requested ($17.31)" |
| 18:10:40 / 18:11:00 | `request_user_approval` requested / received |
| 18:11:02.859 | `title="Payment card ready"`, `toolName=spawn_browser_agent`, `task_id=ba744d18`, `toolStatus=FINISHED`, **no `action_type`, no `subAgentId`** |
| 18:11:02.950 | worker log `{"event":"Resuming from write lock approval","step_count":32}`, `{"is_resume":true,"task_id":"ba744d18…"}` |
| 18:11:10 | `action_type=session_init` FINISHED "Browser session ready" — **same** `task_id`, **same** Steel session `645c47ec` |
| 18:11:10 → 18:15:47 | 18 further browser steps (screenshots, evaluate, card/ZIP entry) on the same task |
| 18:15:47 | worker log `{"event":"Max iterations reached: 50"}` |
| 18:16:12 | "Task Incomplete - Max Steps Reached"; parent spawned a fresh browser agent (`00681a23`, new session `915dfa6c`) which found **2 items in cart** |

So the panel was blank for ~5m10s of genuinely live browser work, and the run
then died at the step ceiling and restarted from scratch on a duplicated cart.

## Diagnosis

**Why 1 — the panel disappeared.** `computeActiveBrowserPanels`
(`front-end/src/features/terminal/hooks/derivations.ts:230-244`) computes
`hasTerminalTaskMessage = taskMessages.some(isBrowserTaskTerminalMessage)` and
emits no panel when it is true. The check is an unordered `.some()`, so
terminality is permanent — a later `session_init` cannot revive it.

**Why 2 — a progress event satisfied the terminal predicate.**
`isBrowserTaskTerminalMessage` (`derivations.ts:132-145`) has a legacy branch
that infers terminality *structurally*: `toolName === 'spawn_browser_agent' &&
subAgentId == null && (action_type == null || 'system') && toolStatus ∈
{FINISHED, ERROR}`. "Payment card ready" (`handler.py:9535-9551`) is exactly
that shape. It is the only untyped terminal-shaped message for task `ba744d18`
in the whole transcript, and removing the `action_type == null` clause makes the
checked-in prod fixture keep the panel alive until the legitimate
`task_complete` at 18:16:12 (verified by toggling the clause and re-running the
repro).

**Why 3 — the producer omits `action_type` on exactly two of its
approval-resume events.** Commit `e5f87f9a4` (2026-07-12, "Keep browser panel
active across auth handoff") added the `(actionType == null || LEGACY…)`
narrowing for this same failure and typed the auth-handoff events
(`handler.py:9568/9595/9638` → `action_type="auth_assistance"`). Every other
sibling resume event was typed too — `write_lock_rejected` (:9069),
`agentcard_user_*` (:9267/:9335), `purchase_cancelled` / `purchase_blocked` /
`purchase_funding_delayed` (:9388/:9403/:9433/:9447/:9460). Only
`"✓ Write permission granted"` (:9043) and `"Payment card ready"` (:9538) were
missed. This is therefore an **incompletely-applied fix recurring**, not a new
bug: the guardrail was a per-event convention with no invariant enforcing it,
and the consumer's default for an untyped event is fail-dangerous (terminal).

**Deepest owned cause:** browser-task terminality has no single source of truth.
The producer decides it by *omitting* a field and the consumer decides it by
*guessing* from message shape, so any future untyped workflow-scope
`spawn_browser_agent` event silently closes the panel.

**Sibling failures the same gap produces (enumerated, not speculative):**

- `handler.py:9043` `"✓ Write permission granted"` — identical shape, fires on
  **every** write-lock approval resume, so ordinary purchase/write approvals
  close the panel the same way. (Predicted from the shape; agent 7f354640
  contains no such message, so this specific sibling is *not* directly observed
  in this transcript — the repro pins it synthetically.)
- `handler.py:9662-9704` `"Browser automation complete"` — also untyped
  (observed in this run at 18:16:23 with no `task_id`); today it is a *real*
  terminal detected only by the legacy branch, so it must be retyped before the
  branch can be deleted.

**Two further defects surfaced by the same incident** (recorded here, each needs
its own fix decision):

1. **Step budget is not extended across a user-blocking handoff.**
   `handler.py:4963` `resume_step_count = write_lock_resume_state["step_count"]`
   → `:5926` `iteration = resume_step_count` → `:6117`
   `while iteration < MAX_ITERATIONS` with `config.py:14 MAX_ITERATIONS = 50`.
   Resuming at 32 left 18 steps to enter a card; the run exhausted them and
   died, after which a fresh browser agent restarted on a cart that already
   held the items. The handoff does not *consume* budget, it fails to
   *extend/refund* it.
2. **`session_init` is not a recognised init action.** `BROWSER_INIT_ACTION_TYPES`
   (`derivations.ts:119`) is `{browser, system, session_started}`; the resumed
   activity's init event uses `session_init`. A resumed panel is therefore
   revivable only because the *original* init message is still in the hydrated
   transcript.

**Not the cause (hypothesis closed):** the payment pause does run the full
activity teardown — `finish_tools(status="FINISHED")` (`handler.py:8313`), the
`finally:` block at `:8694`, `_finalize_browser_diagnostics_for_fe`, and
`_schedule_browser_cleanup`. But `_schedule_browser_cleanup` never closes the
Steel session (session `645c47ec` is reused after resume, confirmed by the
`browser_url` on every post-resume message), and `diagnostics` / `recording` /
`network_recording` are explicitly excluded from panel selection
(`derivations.ts:120, 227`) and are non-terminal. The teardown is noisy, not
causal.

## Solution

Terminality is now **declared by the producer**, never inferred from a missing
field. Landed in five parts:

1. **Producer typed every event** (`agents/domains/spawn_browser_agent_v3/handler.py`):
   `"Payment card ready"` → `action_type="payment_card_ready"`,
   `"✓ Write permission granted"` → `action_type="write_lock_granted"`,
   `"Starting up a browser"` → `action_type="session_starting"`, and the two real
   terminals `"Browser automation complete"` / `"Browser automation failed"` →
   `action_type="task_complete"`.
2. **Consumer stopped guessing** (`front-end/src/features/terminal/hooks/derivations.ts`):
   `isBrowserTaskTerminalMessage` now requires an explicit
   `action_type ∈ {task_complete, session_paused}`. The untyped fallback is
   narrowed to **tool-call scope only** (`task_id == null`) so historical
   transcripts — including already-persisted prod messages that predate the
   contract — still close their chips. The `LEGACY_TERMINAL_BROWSER_ACTION_TYPES`
   `'system'` entry is deleted: `'system'` is the *verifier-progress* type
   (`handler.py` "⚖️ Verifying completion" / "⚖️ Progress: N%"), it was never a
   terminal, and it was simultaneously listed as an init type.
3. **Transcript chip got the same rule**
   (`.../message-bubble/useMessageRouting.ts`): a task-scoped message must
   declare a terminal `action_type` to render as a finished browser chip. This is
   the consumer that produced the literal reported symptom ("completed").
4. **`session_init` added to `BROWSER_INIT_ACTION_TYPES`** so a resumed activity
   can re-open its own panel instead of depending on the original init message
   surviving in the hydrated transcript.
5. **Invariant cemented** — `agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::
   test_browser_tool_events_declare_action_type` AST-scans `handler.py` and fails
   if any `spawn_browser_agent` event metadata omits `action_type`, or if any
   `is_completion_message=True` call site omits a terminal `action_type`. This is
   the guardrail whose absence let `e5f87f9a4` be applied incompletely. Registered
   in the suite runner, so `/deploy` runs it.

`MAX_ITERATIONS` was raised 50 → 60 (`config.py`) with explicit user approval,
because a user-blocking approval handoff resumes the same task at its prior step
count, so the checkout half of a purchase runs on whatever budget the
pre-approval half left. This is a mitigation, not the structural fix: the budget
still is not refunded or extended across a handoff, so a long pre-approval phase
can still exhaust it. That remains open.

**Sibling failures prevented:** `"✓ Write permission granted"` closing the panel
on every write-lock approval; any future untyped workflow-scope browser event
doing the same (now impossible — the invariant test fails the build).

**Pre-fix / post-fix, identical command, unweakened assertions:**

```
cd front-end && npx vitest run src/tests/blackbox/browser-panel-derivations.blackbox.ts -t 'approval-resume'
# before: 4 failed  — "expected [] to include 'ba744d18-063f-40be-aa23-1f20cd7ce4ff'"
# after:  4 passed
```

Full suites green: front-end 116 files / 2254 tests passed; agents
`spawn_browser_agent_v3.blackbox.py` `ALL_PASSED: True`. Two pre-existing ruff
errors in `handler.py` (I001, F541) were fixed in passing.

**10k-agent behavior:** pure per-message derivation plus one extra metadata key
per event. No new channels, subscriptions, queries, or shared state; cost is O(1)
per message and independent of agent count.

## Human feedback

Approved the proposed fix as presented, and additionally authorised raising
`MAX_ITERATIONS` 50 → 60 ("u can increase max_iter -> 60 instead of 50 that is
fine, but the rest of the fixes are approved"). Note this is an explicit,
scoped exception to the no-cap-relaxation rule — do NOT treat it as standing
permission to raise browser step/timeout ceilings in future RCAs.

## Reusable lesson

Never infer that a UI element is terminal from the *absence* of a field —
require an explicit terminal marker on the producer and enforce it with an
invariant, or the next untyped progress event will silently close a live
session.


### 2026-10-27 recurrence: a completed invocation hid its reused persistent browser

Agent `3392bb69-807b-4ef9-a671-2e5eeb92efa7` completed the browser invocation
`6e6fb277-6aa9-4ca3-a314-631b7666dbed` at 02:37–02:38 UTC, then started
`dbf27293d` on the same persistent BrowserSession task
`e62f18ac-84fd-51c5-90d4-a2abf4c4eb09` at 02:39:03 UTC. The new invocation
requested authentication assistance at 02:44:39 UTC. A read-only live-view GET
returned HTTP 200, ACTIVE and live=true. The captured transcript still produced
zero panels: the all-history `.some(isBrowserTaskTerminalMessage)` retained the
previous invocation's legitimate completion forever. With no BrowserStatusBar
mounted, the real Open Browser handler dispatched an event with no listener and
the drawer stayed closed. This is the same irreversible terminal projection
recorded above, reached through persistent resource reuse rather than an untyped
progress event. The prior fix typed events but left this consumer assumption.

The candidate replaces first-init plus any-ever-terminal scanning with one
persisted-order lifecycle reduction. Explicit browser/session starts reopen the
resource; the current outer invocation owns terminality. Internal session-init
call IDs do not replace that ownership, and late previous-call terminal events
do not close the new invocation. Verifier/recording/diagnostic events never
reopen a closed panel. The regression fixture retains seven causal metadata
messages with example viewer URLs and no credentials, goals or account data.

Executed unchanged permanent reproduction:
`cd front-end && bash scripts/run-blackbox-tests.sh browser-reopened-session`.
Original production source: four failures in 5.41 seconds, including expected
panel versus `[]` and the actual clicked drawer remaining `data-state=closed`.
Candidate: four passes in each of five consecutive runs (6.37, 8.04, 9.28, 8.18,
6.31 seconds). The complete front-end blackbox runner passed 223 files / 2,979
tests in 167.19 seconds. TypeScript, scoped formatting and lint also passed.
The file is auto-discovered by the existing blackbox runner and `/deploy`
front-end coverage invokes that runner. These are local causal/UI proofs;
production deployment and live-click verification remain pending.

Archive searches: `Open Browser navi-open-browser`, `browser button does nothing
auth assistance`, and `browser panels terminal reused task`. Related retry case:
`2026-07-22-browser-chips-keyed-by-task-render-twice-on-retry`.
Golden analogs inspected: `openclaw/ui/src/pages/chat/chat-gateway.ts:357`
fences updates by the current run; `codex/codex-rs/tui/src/chatwidget/protocol.rs:89`
starts current turn state; `claude-code-src/src/Task.ts:108` represents current
execution state. No reference embeds Rose's provider viewer. The candidate
converges on explicit current-execution lifecycle state.

10k-agent behavior: O(M log M + T) for the selected transcript and T tasks,
replacing repeated per-task scans; zero added queries, subscriptions, channels,
locks or polling. A 70,000-event / 10,000-task local reduction yielded 10,000
panels in 253.42 ms. This is a reducer measurement, not a production load test.
No new human correction was recorded. User requested the button RCA and the
independent login/provider timeline; original purchasing task was not resumed.
