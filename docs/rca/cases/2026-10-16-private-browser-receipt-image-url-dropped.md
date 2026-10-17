---
id: 2026-10-16-private-browser-receipt-image-url-dropped
date: 2026-10-16
title: Private browser media filtering removed a model-provided payment receipt image URL
surface: agents
component: private browser action service and payment activity receipt projection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: service_actions.py execute_action.visible invokes DOMService.model_visible_action_result and drops typed payment_request line-item image_url before the activity return
symptoms:
  - Canvas Tote imageUrl mismatch
  - Agent status ACTIVE expected COMPLETED
  - typed receipt URL lost at owning activity return
tags:
  - browser
  - payment
  - privacy
  - receipt
  - temporal
sources:
  - agent ef735c8a-524c-4eec-bfa1-d64d5db425af
  - benchmark run 1108b4ad-f5f1-434f-bf2d-9d9df4af1d88
  - task browser-auth-member-discount-purchase actor dump7867fddc4326 span a4613e8f529a request c2d1455c419f
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_private_browser_pause_urls_use_protected_continuity
status: open
---

## Problem

The unchanged `browser-auth-member-discount-purchase` attempt on source
`4c2c8ac708ba95c79e6c5e40fad687e98a59d181` failed after 157.1 seconds and
75 messages. Its receipt validator expected the visible Canvas Tote image URL
but received `None`; the root was still ACTIVE. The remaining smoke tasks
continued. A later, separate user instruction stopped the benchmark cluster
while the batch was active. The last observed report card was eight passed,
one failed, one running and one queued. This is an interrupted campaign,
not a final run result or a runtime failure caused by the stop.

The saved stdout prefix identifies the full failed root and the first
receipt error. With the Machine kept stopped, canonical read/decrypt/validate
helpers recovered 37 existing encrypted trace artifacts, retaining original
ciphertext, metadata and verified plaintext. The archive manifest is explicitly
not finalized; no missing terminal, final TaskResult or cleanup receipt is
manufactured. The original failure and outstanding financial qualifications
remain unchanged.

## Diagnosis

Critical path: model tool arguments -> browser action validation -> payment
request -> activity result projection -> workflow payment normalization ->
attention receipt -> benchmark receipt validator.

The actual actor dump's action and raw `request_payment_card` tool arguments
both contain the exact expected public image URL. The notification fork also
contains it. The preceding captured DOM/evaluate result exposes that URL as
visible text. Missing model context and model omission are therefore refuted
for this field.

The action service validates the request and returns the original parameters.
Before returning to the workflow, `_visible_activity_result` applies
`_redact_activity_value` to `payment_request`. After private credential entry,
the underlying DOM privacy projection removes every dictionary field named
`image_url`, including this typed receipt string. The workflow consequently
receives an incomplete receipt. Redacted private action history also omits
the field, but that history projection is expected behavior and is not itself
the defect. No direct archived activity-return wire packet was recovered;
the causal proof below exercises the actual activity return boundary.

The existing registered privacy callback was extended with a public receipt
URL, a secret-bearing URL, nested screenshot/data-image negatives, and the
schema-supported `lineItems` alias. It runs the production activity through
Temporal's `ActivityEnvironment`, with existing browser/model/storage mocks
and denied socket/HTTPX connections. The new assertions were installed in the
permanent suite before editing the production handler.

Identical command before and after the repair:

```text
/home/boxes/rose-wmh-deploy-20261015/agents/venv/bin/python -B /dev/shm/rose-whm-deploy-gates-20261015/root-rca-cycle4/run-c10-member-permanent-owner-case.py
```

Before: exit1 in3.160seconds, `typed receipt URL lost at owning activity
return`. After: exit0 in3.472seconds. Both runs use the same test SHA
`fa2868dbb01f32506c719c2da874014ea205899e032534f06b9200bf407621f8`.
An independent review found that the first candidate missed the supported
`lineItems` alias; the same final callback failed on that intermediate candidate
and passed after preserving the schema's alias precedence. A separate replay
of the actual captured receipt and private policy also fails before and passes
after; that extracted-boundary replay supplements the full activity callback.

Archive searches included the literal `Canvas Tote imageUrl mismatch got
None`, the behavior `browser member discount purchase request_payment_card
receipt image missing ACTIVE`, and two further privacy/receipt transport
queries. The September29 approved-request verifier case and October14
payment-fill/private-browser case were read with their solution and human
feedback. They are relatives with different first-bad boundaries. Earlier
privacy tests covered URL masking, raster suppression, routing and schemas
but did not assert preservation of a typed receipt image URL at this consumer.

Golden comparisons: Claude Code's `secretScanner.ts` preserves surrounding
structure while replacing secret spans; OpenClaw's `config-redaction.ts`
applies policy at a model-visible projection boundary. Codex's
`thread_resume_redaction.rs` explicitly separates response-only redaction
from persisted/model history. None is a direct payment-receipt implementation.
The local authoritative contracts remain secret masking, suppression of
post-entry raster content, and the existing typed payment schema.

## Solution

The activity retains the original payment request while applying the existing
generic outward projection. It then preserves only HTTP(S) `image_url` strings
in recognized receipt line items, passing each string through the same secret
redactor. `line_items` takes precedence when present, otherwise `lineItems`,
matching the existing schema. Secret-bearing URLs remain masked. Screenshots,
data-image payloads, arbitrary nested media and model-visible history remain
under the existing policy.

The repair adds no prompt, schema, model action, retry, timeout, evaluator,
provider routing, automatic payment entry or extra network request. It adds
one local pass over the receipt items, with no shared state or new periodic
work. The existing test registration and normal `spawn-browser-agent-v3`
domain remain the deploy regression route.

The complete canonical `spawn-browser-agent-v3` blackbox domain passed with
the integrated handler and unchanged extended test in64.0seconds. The normal
registered runner was invoked through a loopback-only Python transport guard;
the owning privacy regression separately denied all socket/HTTPX connections.
Raw Ruff0.17.0 also passed both complete changed Python files. These checks
qualify the local transport repair, not the funded task outcome.

The exact unchanged funded task has not passed on the repair. Its prompt,
evaluator, fixtures and timeout remain unchanged. Full deployment qualification,
durable final task evidence, resource cleanup and final review remain open
because the later cluster-stop instruction is still in force. Passing the
owning regression does not close this benchmark case.

## Human feedback

Existing user instructions require agent-selected credential entry, secret
masking and suppression of private raster content. They reject fabricated
browser guidance, trajectory injection, evaluator weakening and timeout
changes. This repair preserves those instructions and restores a typed field
that the model already supplied. It does not lift the separate held schema,
guest-policy or clock proposals.

The newer instruction to stop all Machines in this benchmark cluster overrides
earlier test-compute operation. The exact existing Machine, volume and root
filesystem are protected from donor reuse/deletion and remain stopped. A
restart or funded validation must receive a coordinated exception; none is
inferred from the offline repair.

## Reusable lesson

Keep privacy projections scoped to their consumer. A raster-suppression rule
must not silently delete typed text fields from an operational receipt; retain
the field's protocol shape while applying the same secret-value policy.


## October 17 recurrence: earlier service projection

This appendix corrects the first-bad-boundary diagnosis above without rewriting
its original clocks, failed attempt, C10 repair or historical stop instruction.
On source `66702e8a4abe202d883e633a56ddbc38f863d6b4`, which includes that
repair, the same unchanged task failed again: the smoke report was ten passed
and one failed. Failed root `fff04cac-e9f8-4268-b703-507e90b67c62`, run
`e8703cc1-b2d3-4c0c-959e-07788e593379`, browser task
`0ef16271-baa8-5d3c-be94-16987c64d979` retained the Canvas Tote imageUrl
mismatch and ACTIVE-versus-COMPLETED error after 182.9 seconds and 83 messages.
This is an actual recurrence, not a waived outcome.

Root captured all 34 original model dumps (6,074,077 bytes), each bound by
SHA-256, size and original metadata in
`/dev/shm/rose-whm-deploy-gates-20261015/root-c13-member-discount-rca-v1/original-byte-index.json`.
The step-20 original
`1792271785736-6166ca41786b-browser_use_step_20.json` has SHA-256
`7b2ad06d93f2dd0f4e1c184ca32e8142b209b67ca4a4a4f162691482439228f4`.
Its `/output/action/params/line_items/0/image_url` is exactly
`https://placehold.co/320x220/png?text=Canvas+Tote`; the decoded arguments at
`/output/tool_calls/0/arguments` equal those action parameters. The notification
fork original, SHA-256
`3a2323b1cd9374dde816ad986f73b6a745da397a6ad3fb94dfff58691d21bf20`,
also contains the URL. The separately captured, read-only root GET in that
same evidence directory, `agent-get.original.json`, instead has null at
`/messages/82/metadata/requestUserApproval/requestPaymentCard/lineItems/0/imageUrl`.
Its merchant RoseShop, total 1960 cents and root identity match the model
request. No archived activity-wire packet is claimed.

The real `service_actions.execute_action` calls
`DOMService.model_visible_action_result` before returning the action result.
After private credential entry, its generic media projection removes the
snake-case `image_url` from the operational `payment_request`. The handler
projects the result again before the existing C10 late restoration can see
it. The final payment normalizer then produces camel-case `imageUrl: null`.
Action-history redaction is a separate copied projection and remains
intentional. The actual model supplied the field; omission by the model is
refuted. Camel-case support is controlled separately, not asserted as the
cause of this recorded snake-case failure.

The earlier registered activity test passed because its FakeDOM omitted the
real action-result projection and its mocked execute path returned a payment
request under a different action. It proved the late repair, but bypassed the
earlier production boundary. The original C10 callback still passes on the
broken baseline and is retained as a false-green control.

The component repair preserves only existing HTTP(S) `image_url` strings in
typed `request_payment_card` receipt items at the first DOM action-result
projection. Each string passes through the same secret redactor. It preserves
schema list-alias precedence and repeated-projection behavior; generic media,
raster, history, prompts, schemas, evaluator, bounds and timeouts stay unchanged.
No field is synthesized and no extra network request is introduced.

Frozen causal evidence is in
`/dev/shm/rose-whm-deploy-gates-20261015/task-private/c13-member-transport-rca-01a136f6`.
The exact same strengthened registered callbacks gave baseline two failures
and three passes, then candidate five passes. A real-service replay of the
recorded parameters failed on the baseline and passed all 21 candidate controls,
including repeated projections, normalization, aliases, immutability and
secret/non-HTTP/media negatives. The owning activity callback exercises the
actual handler; supplementary extracted-boundary replay is not substituted
for it. Socket, DNS and HTTPX access were denied in these HOST-only tests.

Independent review in
`/home/boxes/rose-wmh-resumed/.context/deploy-rejected-caps-20261015/c13-typed-receipt-independent-review-01a136f6`
reran the five callbacks, 21 recorded-receipt controls and two existing
privacy/screenshot callbacks: all passed. No existing assertion was removed;
all other DOM methods were AST-identical. The reviewed two-file candidate diff
SHA-256 is `f05c75a1f3d6f7976e915f40136a731cc206b2bb1d4d61f176d66116503ef4a7`.
Root reports exact application of those component bytes to the worktree.
This is component qualification only: the same funded benchmark outcome and
new full coverage remain OPEN. The original failure, financial liabilities
and cleanup qualifications are retained; no LIVE billing or cleanup pass is
inferred from these hermetic tests.

The stop statement above records the earlier campaign's instruction. Current
explicit authorization to finish deployment permits necessary testing within
the coordinated protected-820 scope; it does not rewrite the old stop clock
or authorize this RCA worker to operate the VM. Root retains operational
custody. No additional allowance question is introduced. Case status remains
OPEN until the unchanged task and deployment requirements actually qualify.
