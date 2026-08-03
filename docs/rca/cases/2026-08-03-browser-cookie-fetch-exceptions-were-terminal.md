---
id: 2026-08-03-browser-cookie-fetch-exceptions-were-terminal
date: 2026-08-03
title: Browser cookie snapshot uploads treated transient fetch exceptions as terminal
surface: mac-app
component: uploader
classification: our-bug
problem_class: other
first_bad_boundary: "mac-app/main/domains/uploader/runtime.ts: Uploader.uploadData caught the first browser-cookie fetch exception and immediately returned a terminal UploadResult failure"
symptoms:
  - "[BatchUploader] Upload failed for chrome: fetch failed"
  - BrowserStateSync localStorage and IndexedDB retries recovered from fetch failed while cookie upload did not retry
tags:
  - mac-app
  - browser-cookies
  - fetch-failed
  - transport-retry
sources:
  - commit ce2c146fd
repro: mac-app/tests/blackbox/batch-uploader.blackbox.ts
status: fixed
---

## Problem

After a fresh Uber login, Chrome snapshot uploads reported `fetch failed` on two
scheduled cycles. In the 21:43 cycle, localStorage batch 4 and the IndexedDB
batch hit the same error and recovered through their existing retries. Cookie
uploads had no equivalent recovery and surfaced the first thrown fetch as a
terminal failure.

## Diagnosis

Uploader resolved browser integrations to the complete cookie snapshot endpoint,
called fetch once, and caught every thrown transport exception in
`Uploader.uploadData`, converting it directly to `{ success: false }`. Complete
cookie snapshot processing is idempotent, but that semantic fact was not encoded
in the transport policy. The transient network exception itself is an external
trigger whose deeper cause was not observed; the first bad owned boundary is the
terminal exception mapping in Uploader.

The missing policy maps to a problem-taxonomy candidate:
`idempotent-operation-retry-policy-gap`.

The runtime evidence falsifies a deterministic cookie-count cutoff, not every
possible size contribution: at 21:53 one 10,054-cookie Chrome request failed
while its identical peer succeeded, and a 4,657-cookie Atlas request failed in
the same cycle. Payload bytes or processing duration may still affect failure
susceptibility under load and require separate controlled evidence.

## Solution

Uploader's service layer now gives only idempotent browser-cookie snapshots up
to three attempts with 1s and 2s exponential backoff after thrown transport
exceptions. HTTP rejection responses are not retried, and non-cookie strategies
remain one-shot. The owning blackbox proves recovery after one exception, exact
three-attempt exhaustion with the original error, one-shot cookie HTTP rejection,
one-shot non-cookie transport failure, and one-shot pre-transport encryption
failure. This policy adds bounded work only when a client encounters a cookie
transport exception; it adds no per-agent state or fan-out.

## Human feedback

None recorded.

## Reusable lesson

Encode retry permission at the operation's idempotency boundary, and separately cement success, exhaustion, HTTP rejection, and excluded-operation behavior.
