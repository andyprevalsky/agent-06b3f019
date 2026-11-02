---
id: 2026-11-02-tilion-screenshot-preflight-assumed-rest-exclusion
date: 2026-11-02
title: Tilion screenshot preflight rejected a supported read beside the attached CDP client
surface: back-end
component: browser-provider.tilion-live.support.ts assertLiveTilionVendorContract
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Original screenshot HTTP 200 violated the unchanged 409 assertion before backend init; its missing body and post-response CDP state prevent retrospective attribution, while a captured local recurrence proves the current screenshot expectation is stale
symptoms:
  - "REST screenshot while CDP attached: HTTP 200"
  - "second CDP client closeCode 4409 followed by screenshot HTTP 200"
tags:
  - tilion
  - browser-provider
  - cdp
  - screenshot
  - vendor-contract
sources:
  - PR #1580 release 6ff4bcae6d0da979e8c6feb24c011f2698935108
  - commit a3c4929f3bbd296766013a7545439b682015a6ef
  - agent thr_11a122c55dd54e1599d206740c56128b independent repair
  - agent thr_11a122c55dd54e1599d206740c56128b capture back-end/src/tests/fixtures/tilion-contract-observations.json
  - agent thr_11a122c55dd54e1599d206740c56128b capture back-end/src/tests/fixtures/tilion-attached-screenshot.json
repro: back-end/src/tests/blackbox/browser-provider.tilion-contract.support.ts assertTilionCapturedScreenshotContract
status: open
---

## Problem

The original full backend coverage shard reported `REST screenshot while CDP
attached: HTTP 200` at 2026-11-02 18:25:17Z. The assertion required HTTP 409 with
`detail.error=session_driven_by_client`. The preceding second-client check had
passed with close code 4409, and the first client had remained connected and
read the Example Domain title before the request. Cleanup of session
`sess_a651ef5e1f3545b5b685f58c325365d5` returned 204 at 18:25:17.880Z.

Gate: NOT_INTRODUCED. The entire native fixture, cross-provider runner,
browser-provider entrypoint, helper and Tilion client are byte-identical between
pinned main and release. The native preflight runs before user/context creation
and backend `/init`. PR1580 continues independently; neither this repair nor its
review is a release gate. Other native parity results remain unchanged. This is
not evidence of a provider outage, exhausted credits or a platform routing bug.

## Diagnosis

Critical path: browser-provider domain -> runLiveCrossProviderCases ->
runLiveTilionProviderParity -> direct vendor POST /v1/session with
`{idle_timeout:120,ttl:600}` -> Playwright at returned connect_url -> example.com
-> second raw CDP rejected with 4409 -> POST /v1/session/<id>/screenshot `{}` ->
assertion -> disconnect and exact-owned session release.

At 18:41:26-18:41:32Z, the unchanged main fixture reproduced the same assertion
failure locally. Captured native evidence identifies REST origin
`https://back.tilion.dev`, CDP origin `wss://oregon.back.tilion.dev`, screenshot
request ID `de39a7dd7df94226`, HTTP 200, `ok=true`, `beside_client=true`, a JPEG,
and the expected page URL. Its returned tab ID was retained; independent CDP target identity was measured only by the patched run. The first client was still connected and read
Example Domain after the response. It disconnected in the fixture's finally;
DELETE then returned 204. This rules out a dropped first client for this local
recurrence and bypasses Rose routing entirely.

A safe GET /openapi.json on the same REST origin returned 200. Its screenshot
operation describes a viewport read of the client's page while a client is
attached. The snapshot hash and native response metadata are retained in
`tilion-contract-observations.json`; the exact screenshot response is the replay
fixture. These establish a **test bug for the current native behavior**: the
assertion conflated exclusive CDP/drive ownership with exclusion of a supported
read. They do not establish when the vendor changed or recover the original
missing response. Therefore this original incident remains OPEN/classification
unresolved, even though the stale expectation is repaired and verified.

What: a supported screenshot is rejected. Where: the native screenshot
assertion. Why: its 409-only condition contradicts the captured response and
current vendor operation description. Proof: the unchanged native call fails;
the exact captured response replay fails before and passes after the repair.
Problem class for that proven repair: logical inconsistency in a harness contract (stale vendor expectation). The
historical incident's remaining class is missing response/state evidence.

The next ownership rung is vendor deployment history, which Rose does not own.
Do not infer a vendor outage, permanent rollout date, or first-socket race for
the original event. The 4409 multiplexer archive case is a relative, not a
recurrence: no Rose multiplexer participates here. Archive searches were
`session_driven_by_client 4409 screenshot` and `Tilion REST CDP ownership contract`;
read the regional-host multiplexer case and the RCA process feedback.

## Solution

Replace the obsolete 409-only screenshot assertion with the currently documented
side-read contract. Require HTTP 200, `ok=true`, `beside_client=true`, the original
CDP target and URL, default viewport JPEG envelope/base64 consistency and strict pixel decoding,
and an unchanged viewport plus usable original client after the request. A bare
200, old refusal, missing/false marker, wrong target, malformed image (including
a self-consistent non-image with JPEG markers), lost client or viewport mutation
fails. Keep second-CDP 4409, detached screenshot, DELETE 204/204/410, session cleanup,
75-second HTTP deadline, 60-second attach deadline and 15-second second-client
window unchanged. No production adapter, recording behavior, credential, quota,
provider choice or Rose account-spawn setting changes.

Independent review demonstrated that JPEG markers alone accepted a six-byte
non-image (`/9j/AP/Z`). The permanent negative reproduces that failure before
strict decoding and passes after the decoder is added.

The permanent replay uses the captured response, a loopback second-CDP refusal,
and controlled HTTP/Playwright boundaries. It invokes the same native assertion
function. It verifies original create/screenshot inputs, disconnect/release on
success and failure, and idempotent release checks. Its scope is assertion and
cleanup logic; native evidence separately proves real vendor ownership behavior.
The existing browser-provider blackbox domain registers both replay cases.
No extra runtime state, requests or cost is added to production at 10k agents.
Golden reference: not applicable (no approval-gated hunk).

Reproduction commands from repository root:

```sh
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tilion_contract_unused node --import tsx -e 'require("./back-end/src/tests/blackbox/browser-provider.tilion-contract.support").assertTilionCapturedScreenshotContract().catch(e=>{console.error(e);process.exitCode=1})'
```

Before the assertion change: exit 1, `REST screenshot while CDP attached: HTTP 200`.
After: exit 0, `PASS live Tilion vendor contract (4409, screenshot beside CDP,
DELETE 204/204/410)`. The replay and captured response were unchanged.

The same native preflight ran before/after through a capture wrapper, retaining
request/response metadata and post-response CDP liveness in the observations
fixture. Before: exit 1 at 18:41:32Z. After: exit 0 at 18:43:34Z with HTTP 200
beside the client, then a detached HTTP 200 and DELETE 204/204/410. To run the
owning native function without the capture wrapper, from back-end/ with the
existing TILION_API_KEY in .env:

```sh
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tilion_contract_unused node --import tsx -e 'require("dotenv").config(); require("./src/tests/blackbox/browser-provider.tilion-live.support").assertLiveTilionVendorContract().catch(e=>{console.error(e);process.exitCode=1})'
```

The final run with strict JPEG decoding also passed. All three captured
sessions were independently confirmed GET 410 at 18:48:10Z. A fourth native
invocation without the capture wrapper passed its own DELETE 204/204/GET 410
assertions.

The function allocates one session with the original bounds and releases only
that session. Do not run broad cleanup or attach to somebody else's session.

Offline permanent-domain runner, from back-end/ after creating a disposable
local database and applying the current Prisma schema (no live parity claimed).
The recorded setup commands were:

```sh
PGPASSWORD=postgres createdb -h 127.0.0.1 -U postgres tilion_contract_20261102_1847
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tilion_contract_20261102_1847 PRISMA_CLI_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tilion_contract_20261102_1847 ../node_modules/.bin/prisma db push --schema prisma/schema.prisma --skip-generate
```

Then:

```sh
env -u TEST_BASE_URL RUN_TILION_HARVEST_LIVE=0 RUN_BROWSER_USE_LIVE=0 RUN_BROWSER_USE_HANDOFF_LIVE=0 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tilion_contract_20261102_1847 node --import tsx src/tests/blackbox/run.ts browser-provider
```

Final domain result: 1 passed, 0 failed, 0 not run (39.592 seconds), including
both newly registered cases and all nine negative controls. Backend typecheck,
touched-file ESLint, Prettier and RCA archive validation pass. An earlier domain
attempt against a nonexistent database was a setup failure, not evidence of the
reported bug; it is superseded by this configured run, not relabeled PASS.

Full original backend coverage and other provider live cases are not reclassified
by this narrow proof. The original incident remains open pending its missing
native response/socket evidence or vendor-side request trace. The fix does not
silently mark original failed parity PASS.

## Human feedback

The user required independent NOT_INTRODUCED ownership on a separate devbox and
branch, no parent-devbox edits or competing original release/cutover, full RCA
causal proof, preserved cleanup/recording/bounds, no assertion weakening just to
make green, and a truthful open archive if the original cause remains unknown.
No unrelated quota, credential, paid top-up or Rose account-spawn changes were
authorized. Preserve Freedom. Successful creation completes the original handoff;
PR1580 does not wait for acknowledgement, status or completion here.

## Reusable lesson

Distinguish exclusive CDP drive ownership from supported read-only vendor operations, and retain response plus post-call owner state before assigning a contract mismatch's cause.
