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
status: fixed
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


## October 18 qualification: unchanged task outcome recovered

On source `12c3f4b55e60a291ce6902b47e88fb2f1acc9307`, the unchanged
`browser-auth-member-discount-purchase` passed in 257.8 seconds (reported as
258 seconds), 98 messages, root `322fb545-94a9-4278-a67b-418cf1b92e21`,
run `310997cf-3812-4560-97e0-b5f607d7794a`. Root and benchmark statuses are
COMPLETED/PASSED with no failure reason. The complete regular run is 13 passed,
zero failed; the separate mass run is one passed. This actual funded outcome
supplements the prior owning callbacks and recorded-parameter controls; it
does not replace them or erase the original C10 interruption or C13 recurrence.

The exact complete regular body is 64,920,341 bytes, SHA-256
`8077283486ffa9ee2c4940d50d72caad7304ef717454b4d5ff9a7dd85478ed10`,
retained in the C14 observer originals at `635178fb0c398506/bytes`.
At `/tasks/8/logs/messages/61`, `/62` and `/63`, the metadata path
`requestUserApproval/requestPaymentCard/lineItems/0/imageUrl` contains the
original public Canvas Tote URL `https://placehold.co/320x220/png?text=Canvas+Tote`.
Both declared runtime and outcome evaluators scored 1.0 and passed. The saved
shop report contains placed order `ORD-26978392`, total 1,960 cents, joined to
purchase `c717a3d8-9561-4f32-8946-56d41e874735`. Native saved lifecycle joins
that purchase, TEST Stripe PI `pi_3URhuvJyWRw3Eb951EnFfuJD`, closed zero-balance
card `card_68bc3246b54f0b1513060ab5` and consumed transfer
`owt_98b66ceb093bc4bafa12770e`; this is completed purchase fulfillment, not a
refund obligation or LIVE billing claim.

The same-source full Group3 result has all 14 stage exits zero. Its actual
agents coverage log, SHA-256
`7226918c32f38d8fad089494050bee48973f2af11bb325057c479ba8625d83bf`,
reports 110 blackbox domains passed, zero failed, including world-model-harness
in 86.52 seconds. ROOT also retains the current native40/pytest224 and complete
controller/cold-seed receipts; the historical native-runtime installation
receipt is not substituted for current native execution evidence.

Saved cleanup for this root records a sealed/deleted final tree, no unsealed
agents, no cleanup errors and its exact owned Kernel session
`o93kmykch3ynjjthr7nuucem` returning native404. Browser recording metadata is
present at messages12/66 (`recording_path`) and60/90 (`recording_view_url`,
`recording_started_at`). Signed provider replay URLs are locators, not durable
FE verification. The root carries encrypted trace-archive manifest pointers,
but neither the regular nor mass canonical body embeds an authenticated Hub
publication receipt, a durable `www.roselabs.ai/?agent-id=` verification receipt,
or a published last-LLM-dump receipt. Absence in these bodies is not proof that
publication failed; separate actual ROOT evidence may satisfy those duties.
No offline inference upgrades a pointer to fetched/authenticated content.

At that body-only review, this case remained OPEN for durable evidence and final
deployment qualification. The actual publication follow-up below resolves the
durable evidence gap for this root. The funded receipt outcome is now proven on the repaired source;
publication, complete archive authentication, final source review and production
are separate obligations. The explicit current user instruction to skip
AgentCard tests applies to the separate isolated startup failure, not this
successful smoke result or financial liabilities. Original failures, clocks,
standing sandbox cleanupFalse and the separate retrospective production warning
remain unchanged.


## October 18 durable publication follow-up

The canonical publisher ran against the exact current regular and mass bodies.
Both initial actual invocations failed fresh-browser launch because sudo selected
an empty root Playwright cache; original Hub uploads, renderer artifacts and
exit1 outputs remain preserved. The only retry environment change selected the
already installed matching1248 browser cache with PLAYWRIGHT_BROWSERS_PATH.
There was no browser install, source change, skip flag or assertion change.

Both canonical publishers then exited0 and were joined. Receipt root
`322fb545-94a9-4278-a67b-418cf1b92e21` rendered98messages in a fresh browser;
mass root `235d16af-ac3d-44a7-a408-618d1e101329` rendered263. The normal
publisher uploaded their original Hub bundles, recovered authenticated archived
LLM calls, rendered/uploaded last-call HTML to R2 HTTPS, validated browser
termination/recording metadata and checked the shared transcript in a fresh
browser including reload. No skip-fe-verify or local-only artifact supplied
acceptance credit. Exact FE share links and seven-day HTTPSdump URLs are retained
in each root's publisher manifest, rather than committing expiring bearer tokens.

Actual publication packet:
`/run/rose-whm-deploy-evidence-20261018/c14-durable-evidence-publication-v1`.
Result SHA-256:
`ae8112c32e2f8a18e3f902d141c1b47063b6a4c03de4a1f4cb5863b43d8abc22`.
Complete packet-manifest SHA-256:
`979bdfea7ecf9e0898d3abed45bec87486189736c00bbe212dc101a5c8078684`.
Exact source12c3, publisher-script bytes and original regular/mass run SHA-256
values were rechecked unchanged after publication. Original failed attempts and
recovered archive originals remain in that packet. This qualifies representative
durable evidence for these two roots, not every root's FE publication.

The unchanged funded receipt outcome, owning causal controls, full source
coverage and this root's durable evidence now qualify. Case remains OPEN pending
ROOT's already-required final preservation, owned cleanup and final source
acceptance. No C3, merge, production, LIVE billing or financial-cleanup completion
is claimed. The separate user-skipped AgentCard startup1 and sandbox8792cleanupFalse
remain unchanged; the private port fix is not part of this deployment.


## ROOT acceptance of the repaired receipt boundary

The exact unchanged funded member task, owning causal controls, full current-source
coverage, durable publication and captured tree/browser cleanup qualified on
`12c3f4b55e60a291ce6902b47e88fb2f1acc9307`. ROOT preserved 5,059 closed original
files (3,520,519,866 bytes) under encrypted archive key
`whm-preservation/e9afcffd/deploy-20261015-C14-20261018T014841Z-final-g1-03491aecd838`.
Upload/self read-back, the independent original HOST verifier and guest stock
comparison each completed with exit0. The authenticated manifest SHA-256 is
`7d9597ee7bc9a7bc7171e6a5e3a93a8d617821ec11744add1bd382cdffd8d010`.
Expired pytest paths were bound to their exact saved originals with explicit
custody records; their old paths and the failed selection remain preserved.

Canonical service cleanup completed before preservation. Native Machine
`820224f7e069e8` was confirmed stopped at 2026-10-18T02:07:33.009796Z,
before its unchanged deadline; its volume was retained and the exact watchdog
exited naturally without signals. ROOT accepts this receipt defect as fixed.
The final administrative batch preserves all historical row multiplicities and
contains only these documentation updates and actual generated histories;
behavioral source and exercised contracts remain unchanged. This RCA acceptance
does not claim a completed C3, merge or production deployment. Original failures,
the user-overridden AgentCard startup exit1, the separate open private port
follow-up and historical financial liabilities remain unchanged.
