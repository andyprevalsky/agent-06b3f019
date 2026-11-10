---
id: 2026-11-10-root-delegation-added-unrequested-address-proof
date: 2026-11-10
title: Root delegation added an unconditional address-proof obligation to a generic purchase
surface: agents
component: root spawn_agent goal and required output selection
classification: unresolved
problem_class: other
first_bad_boundary: earliest observed obligation expansion is raw root model spawn_agent output; the deeper cause and mitigation effectiveness remain unproven
symptoms:
  - delivery_summary requirement remains unverifiable
  - required use of the supplied delivery address remains unverifiable
  - Timeout after 1204s
  - PAUSED
tags:
  - browser-agent
  - delegation
  - purchase
  - completion-verifier
  - required-output
sources:
  - agent e774239e-a967-4ca6-b1bf-06e6bddcd1a5
  - benchmark run d8a675a0-c7e6-48c0-854b-250b5dc3ffc8
  - commit f61b9e9394b0e6cf0bd51f929d682c2ee57a5497
  - plan:.context/agentcard-e2e/stability-proof-20261109/round05-signup-trajectory-rca/receipt.json
repro: none-recorded
status: open
---

## Problem

The unchanged `browser-auth-signup-purchase` case asked: "Buy me a Canvas Tote
from {auth_test_site_url}". In partial11 round05, root
`e774239e-a967-4ca6-b1bf-06e6bddcd1a5` delegated the purchase to browser task
`68b59ca8-937d-55b3-a1f7-c95762ff42e3`. The root's own required output had only
the product URL and order confirmation ID. Its raw model response added six
required child fields, including `delivery_summary`, and instructed the child
to use the supplied profile delivery address unconditionally.

The browser created the verified account, placed order `ORD-79829271`, and
reached the paid confirmation. The owning financial evidence recorded one
purchase/card/funding/provider transfer, zero unlinked transfers,
`CLEARED`/`CONSUMED` for 2123 sandbox cents, Stripe received2123/capturable0,
and zero remaining card balance. This is a used payment, not an unused-card
stall or a reason to reclaim funds.

Eight completion attempts scored0.5 because the supplied destination could
not be verified. The original task timeout was1200s; the driver observed
timeout1204s and native duration1220.5s. The canonical result is
`passed:false`, `benchmark_status:FAILED`, root `PAUSED`. Payment success does
not make this native task a pass.

Canonical evidence is
`agents/benchmarks/runs/20261110_025057_d8a675a0-c7e6-48c0-854b-250b5dc3ffc8_browser-auth-signup-purchase.json`.
The retained worker/backend/driver and recording locations are indexed in
`.context/agentcard-e2e/stability-proof-20261109/round05-failed-root-artifact-index.json`.
The operator published and verified the225-message failed trajectory and
correct-owner recording. Its durable viewer and entire-trajectory last dump
are retained in the private approval packet and publication manifest, rather
than copying expiring signed URLs into this source archive.

## Diagnosis

Raw root request `1c609225`, served by `gpt-6.1-sol-foundry`, already contains
the unconditional goal and all eight required child fields. Those arguments
match the persisted spawn call, background payload and browser start. Neither
the adapter nor the separate response-schema generator introduced them.

All eight captured verifier outputs ground the paid purchase but reject the
same destination obligation. Their actual input contains the delegated goal
and schema. The verifier does not independently invent the unconditional
address-use requirement. Billing ZIP and a shipping charge do not establish
the delivery destination. No verifier relaxation or field deletion is justified.

The merchant fixture exposes payment fields and Billing ZIP, but no delivery
address input or order destination record. The browser repeatedly inspected
the existing confirmation, account and checkout rather than buying again.
The original user request and native task contract do not require destination
proof. Earlier same-case passes in rounds02..04 used conditional profile
inputs or returned delivery details only when shown. These observations locate
the earliest semantic expansion; they do not prove an intrinsic source defect
or a controlled model-capability limitation.

The root continued waiting for its browser child and never attempted its own
completion. The first pause followed the driver timeout: backend POST pause
at02:50:18.346Z, worker pause signal at02:50:18.669Z and browser cancellation
at02:50:25.080Z. The pause is cleanup's consequence, not an earlier human
interruption or evidence of scheduler loss.

The narrower problem is model-selected extra delegation obligations. The
next deeper class considered was faithful decomposition of the original task.
A broad constraint-provenance validator, new handoff mechanism or fixture
shipping UI was not supported by this capture and was not implemented.
Existing static delegation guidance is the selected general mitigation
boundary. Its effect remains unproven; classification therefore stays
`unresolved`, rather than claiming a source-contract contradiction or model
intelligence limitation without the required controlled proof.

The related August3 generic provider-order-ID and authorized-blocker cases
changed schema-generation/normalization contracts. Here the additional
obligation was in raw root output, so those downstream repairs are not the
owning boundary.

## Solution

The parent applied the reviewed general mitigation in
`agents/utils/tool_schemas.py`, extending `BROWSER_GOAL_PROFILE_NOTE`:
keep the child goal and required output fields limited to the requested
outcome and evidence needed to establish it, while preserving user
constraints and necessary correct execution. It changes static tool guidance,
not verifier acceptance, schema shape, terminal behavior or native criteria.

Exact patch SHA256 is
`c8513f401ac4d9d7e15746a42e289c44c05c9469736096c6a550afddcac73e1c`;
the resulting source SHA256 is
`e434304562a619d9d2577c281fedeaf3e9e36d09583338e6bf5b473fd0e43872`.
Independent reviewer `ph7afnee3j0dm6axgjd98jq3tn8htpgr` returned `GROUNDED`
for `signup-bounded-delegation-general-mitigation-v2`, packet SHA256
`6b43b8980b29e2a0ab41b87ad42f5a174c34ec391837319a3e605313cf9e5ee9`.
Directly inspected references include Hermes
`tools/delegate_tool.py:708-723` (self-contained goal/context and only required
fields the parent needs), Codex `multi_agents_spec.rs:747-752` (bounded concrete
needed output), Claude Code `AgentTool/prompt.ts:257-269` (clear expected work),
and OpenClaw `subagent-completion-instructions.ts:1-4` (original requested
outcome and in-scope blockers). Rose retains its strict evidence verifier.

The profile-specific alternate patch `e8577bde` remained `NOT_GROUNDED`, was
never applied, and was not presented as a user approval request.

Offline request reconstruction matched all11 captured tools exactly before
the change, and only the reviewed description differed afterward. The planned
private diagnostic allocation was three exact-root samples plus two labelled
semantic controls per variant. Its first before attempt stopped before any
model send: the current native client selected an OpenAI API-key route,
whereas the captured call used Foundry. The endpoint guard refused the changed
route. Actual model POSTs were0 before and0 after, completed exact/control
samples were0, and no model before/after result exists. Original root/child
dumps and canonical result passed the byte-identity audit. No keys, cooldowns
or routes were changed to force a replay; the parent stopped further model-only
work. This replay fidelity gap is separate from the native failure's cause.

The existing `llm` and `tool-schemas` registered blackbox suites own projection,
original-goal custody and boundary checks; parent-reported passes do not prove
the model's delegation choice. The unchanged native
`browser-auth-signup-purchase` case is the existing behavioral regression.
No new paid CI, description-string test, prompt nudge, retry or timeout change
was added. Native after-run proof is pending. Any affected same-source streak
must restart after this prompt change: all11 scenarios still require five
consecutive full passes, including financial assertions, recordings and exact
cleanup. A standalone pass would not satisfy that55-pass acceptance bar or
the separate production requirements. This case remains OPEN.

## Human feedback

Preserve the real failure, all eight rejections and the successful paid order.
Do not fabricate address evidence, loosen required user/site constraints,
weaken native assertions, add shipping UI to satisfy an invented subgoal,
raise timeouts or inject trajectory nudges. Explicit requested addresses,
wrong merchant destinations and necessary execution checks remain strict.
The parent alone owns commits, native launches, cleanup and deployment.

## Reusable lesson

Keep delegated obligations tied to the requested outcome and necessary
correctness evidence. A reviewed general prompt mitigation still needs native
outcome proof; successful payment and downstream verifier consistency are
different facts from task completion.
