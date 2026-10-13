---
id: 2026-10-13-browser-auth-persist-fixture-dropped-failed-init-custody
date: 2026-10-13
title: Live browser auth fixture lost allocation custody when init failed before its response
surface: back-end
component: browser-provider-auth-persist-fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: browser-provider.auth-persist.live.ts tracked allocations only after successful init and cascaded away the failed user's recovery identity
symptoms:
  - "FAIL live Kernel/Steel auth persist"
  - "AgentPhone agent creation is uncertain; reconciliation failed"
  - "AgentPhone reconciliation failed: HTTP 502"
tags:
  - fixture-cleanup
  - browser-profile
  - agentphone
  - failed-init
  - custody
sources:
  - commit 342dea89fcc0f2d222ee9b440680417ead4bdfa8
  - PR #1485
repro: back-end/src/tests/blackbox/browser-provider.blackbox.ts
status: open
---

## Problem

The merged cancellation tree's backend coverage attempt passed 191 of 192
blackbox domains and all 266 unit-test files. The live auth-persistence case
failed its first browser init at 2026-10-13T00:35:37Z with an AgentPhone
reconciliation HTTP 502. It had not reached the cookie or local-storage
persistence assertions. The original agent-create error was masked by the
reconciliation wrapper; its status is not established by the 502 message.

The application's failure handler closed the exact newly created Kernel
browser. The fixture's allocation list was still empty, however, so its
profile-deletion loop never saw the newly created persistent profile. Its
local cleanup then deleted the context and User, cascading away the profile
binding and AgentPhone recovery identity. Native read-only checks later found
the browser absent and the profile still present. The profile's ID and creation
time matched the failed request's recorded allocation.

## Diagnosis

The production uncertain-write guard behaved correctly: an unknown AgentPhone
create followed by failed reconciliation must remain a failure. The owned
defect was fixture accounting. Cleanup depended on receiving a successful init
response even though init had already created native resources. A second
defect in that cleanup boundary destroyed the database evidence needed to
recover an uncertain external write. Swallowed native cleanup errors could
also turn an unreaped fixture into apparent cleanup success.

Independent review identified the exact browser/profile pair from the preserved
request and database spans. The deleted test User UUID was subsequently
recovered from retained local Postgres WAL, with independent CRC32C validation:
one bounded Agent INSERT record contained the failed Agent ID, User UUID and
first-agent goal. Private byte copies and their derived logical WAL alias were
retained; no database was restored or altered to manufacture this identity.

A bounded read-only traversal of 126 AgentPhone pages observed 12,529 unique
IDs, a stable total, and no match for that exact recovered provisioning marker.
This is a current observation, not proof that the historical POST was never
accepted. No AgentPhone object was deleted by name or timestamp. The exact
owned Kernel profile was removed using the canonical helper and its subsequent
GET returned 404. Primitive's exact source creates virtual catch-all routing
keys without provisioning a per-inbox resource.

Archive search also found the distinct earlier fixture-dependency cause in
`2026-09-04-auth-options-blackboxes-entered-live-minting`. It is a lead for
isolating unrelated phone minting, not authority to suppress a real backend
error or skip the live browser assertions.

## Solution

The draft fixture correction writes a private atomic custody journal before
setup and init, records a positive User-create receipt, and discovers sessions
and provider profiles from the owned database context before cleanup. It closes
known browsers before deleting their profiles, surfaces cleanup failures, and
retains ownership and phone-recovery evidence when uncertainty is detected
before destructive cleanup. A final journal-write failure surfaces an error
but cannot restore rows already removed. Failed setup never grants authority over an
existing same-ID User. Cleanup is dependency-injected for native-free failure
controls; all live Kernel→Steel→Kernel cookie/local-storage assertions remain.

A separate real guard cookie now isolates unrelated phone minting. The fixture
requires its exact enabled bundle, actual browser injection, no minted identity,
and absence of both target states before writing them. The guard cannot satisfy
the original sign-in cookie or local-storage assertions. Saved-auth suppression
fails preflight instead of changing environment policy.

The focused controls and TypeScript check passed on the initial custody draft. Full exact-source
deploy validation is still pending, so this case remains open. Production auth
failure semantics and provisioning caps are unchanged. The correction scales
per fixture's owned resources and does not scan or mutate a shared provider
account from the test cleanup path.

Golden reference: `claude-code-src/src/tasks/LocalShellTask/LocalShellTask.tsx:200`
registers cleanup before publishing the task state, and
`claude-code-src/src/utils/cleanupRegistry.ts:14` and `:24` retain and await
registered cleanup independently of task success. This fixture applies that
ownership-before-completion pattern with a private atomic journal; atomic replacement does not claim power-loss durability.

## Human feedback

The original task requires preserving authentic outcomes, secrets, resource
ownership and clocks, and permits verifier retry. No gate-specific human waiver
or permission to weaken uncertain-write handling was requested or recorded.

## Reusable lesson

Record ownership before provider-capable work, and preserve it through failed
initialization until native cleanup is positively confirmed.
