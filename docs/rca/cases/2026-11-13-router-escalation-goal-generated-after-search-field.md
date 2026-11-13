---
id: 2026-11-13-router-escalation-goal-generated-after-search-field
date: 2026-11-13
title: Chat router schema put the web_search queries slot before the escalation goal, so the GLM failover wrote the re-plan brief into queries and the stale first request into goal
surface: back-end
component: chat-router structured-output schema
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/chat/routerDecisionJsonSchema.ts ROUTER_JSON_SCHEMA — property order reasoning, action, queries, goal, mode, grep made `queries` the first free-text slot after an escalation decision
symptoms:
  - "the re-plan goal's first sentence does not name 88 Harlow"
  - "Find the best hot yoga class I can take this weekend near me"
  - start_superintelligence decision with a non-empty queries array
  - escalation goal restates the original request and drops the user's correction
tags:
  - chat-router
  - structured-output
  - schema-key-order
  - openrouter
  - glm
  - live-probe
  - flaky
sources:
  - PR #1972 (deploy live-probes FLAKY occurrence 6a3ec2af295d4367864df3f052dc4985 on f93b9ad17fb1; GitHub Actions run 43360572640, artifact 14008875106, chat_router LLM dump of agent 333708a5-ab23-49e1-98dc-c1ca151d4f41)
  - commit dd4b27a38 (quarantine marker)
  - agent 333708a5-ab23-49e1-98dc-c1ca151d4f41 (failing live-probe chat_router call)
repro: back-end/src/tests/blackbox/chat-router-stream.blackbox.ts ("deadline recovers an escalation cut off inside queries") and back-end/src/tests/blackbox/chat-router-phase-sync.blackbox.ts (schema order); outcome check back-end/src/tests/blackbox/chat-router-failover.blackbox.ts live case (CHAT_ROUTER_FAILOVER_LIVE=1); mechanism replay of the captured call pinned to Wafer, brief in queries 38/148 before vs 0/148 after
status: fixed
---

## Problem

The live chat-router-failover probe (Cerebras stalled, real OpenRouter
`z-ai/glm-5.3-flash` the only serving path) failed once in the PR #1972 deploy
live-probes gate and passed on its automatic rerun:

`AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: + "the re-plan goal's first sentence does not name 88 Harlow\b: Find the best hot yoga class I can take this weekend near me"`

The turn escalated on its first attempt (host Wafer, first content 1355 ms), so
routing and timing were healthy; only the started workflow's goal was wrong. It
restated the original request and dropped the user's correction ("wrong
address, its the 88 harlow one").

The gate artifact kept the exact router call (`chat_router` LLM dump, 31
messages, `router_decision` schema). Its recorded output:

- `reasoning`: "The user corrected the location anchor: they are at 88 Harlow St, Apt 1000, San Francisco, CA 94105 …"
- `action`: `start_superintelligence`
- `queries`: seven strings — a full self-contained brief ("Find the best hot yoga class for Alex Testerson this weekend — … near 88 Harlow St …") plus "Task 1" … "Task 6"
- `goal`: "Find the best hot yoga class I can take this weekend near me"

The router itself understood the correction. It wrote the escalation brief into
`queries`, a web_search-only field the runtime ignores for
`start_superintelligence`, and then filled `goal` with a restatement of the first
request.

## Diagnosis

1. `ROUTER_JSON_SCHEMA` is one flat object for all four actions; its declared
   order was `reasoning, action, queries, goal, mode, grep`. The 2026-10-28 RCA
   (router-fallback-host-ignores-schema-key-order) established that
   order-keeping hosts generate fields in declared order and that the router
   contract depends on it.
2. Emitted key order per host, recorded from replays of this call: Wafer (the
   failing host) keeps declared order (149/149 old-order rows
   `reasoning,action,queries,goal,mode,grep`; 148/148 new-order rows
   `reasoning,action,goal,mode,queries,grep`). Modal, which served most
   unpinned replays, emits keys alphabetically (`action,goal,grep,mode,queries,reasoning`),
   so on Modal `goal` already follows `action`; the schema order does not reach
   it. This is why ~280 unpinned replays never reproduced the failure (they
   also held 25 Wafer rows, one of them #87 with a brief in `queries` and a
   still-correct goal).
3. On Wafer, after deciding `start_superintelligence`, the first free-text
   slot is `queries`, another action's payload. Discriminating replays of the
   exact failing call (captured messages and production body, fresh
   `session_id`, pinned to Wafer, 150 per arm):
   - production config (temperature 0): the escalation brief (a `queries`
     string over 200 chars) was written into `queries` in 38/148 old-order
     escalations and 0/148 new-order escalations (Fisher p < 1e-10). Goal
     anchor failures 0/148 and 0/148. Unparsed 1 old and 2 new, all
     degenerate long grep/queries output running to the token limit; the
     production `finalizeRouterDecisionFromStream` recovers every one of the
     three as `start_superintelligence` with an anchored goal (no regenerate).
   - temperature 1.0 (both arms): brief in `queries` 39/149 old vs 1/146 and
     1/145 new (two runs); the old arm also produced one goal whose first
     sentence does not name the address ("Re-run the hot yoga search with the
     corrected location. Anchor: 88 Harlow …"); new arms 0/146 and 0/145.
     Unparsed rose at temperature 1: 1/150 old vs 4/150 and 5/150 new (pooled
     2/300 vs 11/450 across all Wafer arms, Fisher p≈0.09). In the 5 with
     captured content: two whitespace loops and one grep-argument loop, all
     after a closed goal, recovered by the production partial path with an
     anchored goal; two stream cut-offs mid-reasoning/mid-goal (order
     independent) would regenerate. At production temperature this did not
     appear (above).
   The prod failure is the tail of this behavior: with the brief already
   spent in `queries`, the model filled `goal` with a restatement of message 1
   ("find me the best hot yoga class I can take this weekend near me"). The
   replays reproduce the mechanism at a 26% rate on the failing host and show
   the reorder removes it; the stale-goal tail itself was not re-observed in
   ~300 Wafer replays, so its exact rate stays unmeasured.
4. Assistant prefill (forcing the failing prefix and measuring the goal that
   follows) was attempted on 12 GLM hosts; none continues an assistant prefix,
   so that more direct test is not available.
5. Live probe on unchanged main: 13/13 passes (the failure is intermittent).

Deepest owned cause: the router's escalation payload was not adjacent to the
decision that consumes it on order-keeping hosts. The flat schema interleaved
another action's field between them, so the model could spend its brief in the
wrong field, and the runtime (which ignores `queries` on escalation) silently
kept whatever `goal` followed. `ROUTER_SEARCH_BUDGET_SPENT_JSON_SCHEMA` already
declared `reasoning, action, goal, mode`; the two stage schemas disagreed.

Step 5b climb (the fix changes LLM-visible schema order):

- Stopped at: "the escalation payload is generated after another action's
  payload in the flat router schema".
- Next deeper class tried: "an action-multiplexed schema lets any action's
  payload land in another action's field". Fixes at that level: a per-action
  discriminated schema (top-level `anyOf`) or rejecting decisions whose unused
  fields are non-empty. Not coherent here: strict structured output needs a
  root object across the providers this router races (the flat design comment
  records why), and rejection would regenerate 29% of Wafer escalations (non-empty
  `queries`, nearly all with a correct goal) at the cost of a router attempt,
  without recovering a misplaced brief.
- A `goal` description edit ("carry every correction") does not target the
  measured defect: the model's text was correct in the observed failure; it
  was placed in the wrong field. With the description unchanged, the reorder
  alone took brief placement from 38/148 to 0/148.

Trade-off: no flat order puts every action's payload next to `action`. Web
search now writes `goal` (the model fills it with ~60 chars despite "empty
string for other actions"; median 59 chars both orders) and `mode` before
`queries`, about 20 tokens before the first query is detectable (roughly
0.1-0.2 s on the GLM failover, negligible on Cerebras). Web_search routing was
unchanged in 40/40 replays per order (action counts only; those rows score as
"not escalated" in the replay script). Escalation is the action whose payload
is long free text and whose misplacement is silent, so it gets the slot.

## Solution

Declare `goal` and `mode` directly after `action` in `ROUTER_JSON_SCHEMA`
(`reasoning, action, goal, mode, queries, grep`), the order the
search-budget-spent schema already used, so every stage shares one order and an
escalation writes its goal in the first slot after deciding on order-keeping
hosts. `grep` stays last (cut-off recovery of the string fields is unchanged).
No runtime parsing changed: `RouterDecisionSchema`, partial recovery and early
query detection are order-independent.

Regressions (each fails on the old schema and passes on the fix, 5/5
consecutive runs):

- `chat-router-stream.blackbox.ts` "deadline recovers an escalation cut off
  inside queries": a decision serialized in the schema's declared order and
  cut inside `queries` must still recover `start_superintelligence` with its
  goal through the production `finalizeRouterDecisionFromStream`.
- `chat-router-phase-sync.blackbox.ts`: every router stage schema declares
  `reasoning, action, goal, mode` first, with `required` in the same order.

Outcome check: the live probe itself (`CHAT_ROUTER_FAILOVER_LIVE=1`, run by
/deploy live-probes) passed 15/15 on the fix (13/13 on main before), with the
wire body confirmed to carry the new order. At the observed failure rate that
is a regression check, not a rate measurement; the discriminating evidence is
the Wafer replay above. Its quarantine marker is removed in the same deploy.
`chat-search-escalation`'s request-hash recordings were re-recorded through
`CHAT_SEARCH_ESCALATION_RECORD=1` because the router request bytes changed.
Record mode resets `calls` before recording, so no stale hashes remain; the
production search snapshot is unchanged. The re-recorded scenarios still
exercise their intent: first turn replied with the title ("Uwasa no
Midori-kun"), the pinned no-match follow-up searched again and escalated
after 3 routes, and the two-part question fanned out and answered once.
Replay passed 3/3. Logs of the new regressions (5/5 passes, and failures on
the old schema) are retained in the repair evidence archive.

Sibling failures prevented: an escalation on an order-keeping host writing its
brief into `queries` (first route and after search; the budget-spent stage
already had this order). A stream cut off inside a long `queries` list now
still recovers an escalation's goal, where the old order lost it.

Open observation (not fixed here): Modal, now most of the GLM failover's
traffic, emits keys alphabetically, so `reasoning` comes last there, after
`action`. The 2026-10-28 RCA excluded a host for not keeping declared order;
Modal's effect on decision quality is unmeasured.

10k-agent behavior: no new requests, state, channels or queries; the schema is
a constant reordered in place. The router fast-cache content key changes once.

Golden reference: claude-code-src/src/utils/permissions/yoloClassifier.ts
(classifier schema: thinking, then the decision, then its reason) and
codex/codex-rs/ext/guardian-reviewer/src/assessment.rs (decision followed by
its rationale) order reasoning, decision, then that decision's payload;
codex/codex-rs/protocol/src/models.rs `WebSearchAction` tags each action with
only its own fields. Review record: deploy PR body.

## Human feedback

None recorded.

## Reusable lesson

In a flat structured-output schema, declare each action's payload directly after the decision field it serves; a different action's free-text field in between becomes where the model writes it.
