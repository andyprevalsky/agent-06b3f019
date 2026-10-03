---
id: 2026-10-02-hub-plain-json-upload-rejected-before-render
date: 2026-10-02
title: A durable Hub JSON upload was rejected upstream while lossless gzip reached the same route
surface: harness
component: benchmark-hub-upload
classification: third-party-failure
problem_class: other
first_bad_boundary: "POST /api/benchmarks/runs returned HTTP 403 before the request reached Render application logging"
symptoms:
  - "HubVisibilityError: benchmark Hub upload failed: HTTP Error 403: Forbidden"
  - "durable_failed"
tags:
  - benchmark-hub
  - durable-evidence
  - gzip
  - http-error-correlation
sources:
  - PR #1299
  - fleet run 20261002-083414-9201
  - agent 715ec05f-c47f-4115-8e0e-0beb8f6930b2
repro: agents/tests/blackbox/benchmark.blackbox.py::test_hub_upload_gzip_preserves_live_and_final_bundles_across_retry
status: mitigated
---

## Problem

The first proof106 slice finished its canonical runner, but only nine of ten
durable publications passed. The `polar-bu-045` publisher received HTTP 403 in
277 ms while uploading a 9,069,319-byte JSON bundle. It never reached fresh-browser
verification. The entire slice remained rejected; separate message-persistence
timeouts in another task are not resolved by this case.

## Diagnosis

Archive searches for `benchmark Hub upload failed HTTP Error 403 Forbidden`,
`durable evidence publication auth upstream rejected bundle`, and
`Hub HTTP 403 Forbidden edge upload` found the September 10 ambiguous-commit
case, September 11 Steel client-identity case, September 30 publisher-observation
case, and August 12 wrong-Hub-target case. These are related boundaries, not
evidence that a forbidden upload should be retried or accepted.

Complete retained Render queries showed matching application/request records for
all nine sibling uploads, each HTTP 201, but no matching record for the rejected
POST. The successful bodies ranged from 0.288 to 15.006 MB, used the same urllib
client identity and source IP, and reached one deployed backend instance. Thus
neither a simple body-size limit nor a blanket urllib client rejection explains
the failure. Production had no deployment transition during publication.

After original evidence was sealed, separate zero-credit diagnostics replayed the
same immutable input through the actual publisher. The uncompressed JSON hash
remained `513358b7d87540f71dc4a5ffbb9eac2fe4a6f9dbeda3ba11ac5693d8190c844b`.
Two plain-body replays and one truthful application User-Agent control reproduced
403. Bounded response classification retained only byte counts, fingerprints and
fixed flags: HTML, `Server: cloudflare`, a validated CF-Ray, no Render/backend
request IDs, and no recognized challenge/1010/1020/1015 marker. No response body,
credential, cookie, or trajectory content was logged. The exact upstream policy
or rule remains unknown; a Cloudflare response header alone does not identify it.

Changing only standard HTTP content encoding to deterministic gzip produced a
1,886,828-byte wire body with the identical decoded JSON. The same endpoint and
credentials returned 201 in 3.042 seconds, now with Render/backend request IDs.
A read-only fetch of the stored object was deeply equal to the entire submitted
bundle, including all task fields, 130 root messages and the complete tree.
The full publisher then passed fresh-browser verification in 14.600 seconds.
All diagnostic owners and sessions retired; original proof106 files remained
unchanged. This establishes a wire-representation-sensitive rejection and a
lossless transport mitigation, not the name of the upstream rule.

Private original/replay/native/readback receipts are under
`.context/acceptance/proof106-hub403-rca/`. The original failed slice archive and
each diagnostic are retained separately. None receives acceptance credit.

## Solution

The shared Hub uploader uses deterministic gzip plus `Content-Encoding: gzip`
for both live registration and final publication. The existing JSON parser
inflates this standard encoding. Timeout derivation still uses the original
uncompressed size; authentication, request identity, retry/reconciliation policy,
task results and full transcript contents are unchanged. A 403 remains terminal.

The owning real-HTTP blackbox failed on original source because the wire body was
not encoded, then passed unchanged against the candidate. It checks live and
final decoded deep equality, authentication, deterministic bytes across a real
503 retry, and unchanged size-derived deadlines. Existing wire registration and
ambiguous-commit fixtures now decode standard content encoding. All 19 adjacent
Hub tests pass. One old 1-KiB timeout assertion incorrectly expected exactly
30 seconds although the September 7 implementation has always added the byte
allowance; the assertion now matches that unchanged formula.

A separate registered real-HTTP rejection test cements the observed diagnostic
gap: allowlisted response identifiers and static header classes survive the
exception, arbitrary headers/body/key stay private, 403 makes exactly one POST,
and its response closes without another body read. This observation repair does
not itself resolve the upstream rejection. Independent review passed the
lossless transport and response-metadata changes. The final affected agents gate
passed the benchmark blackbox domain, 19 Hub units and the canonical coverage
tail; 103 unchanged domains were carried with exact source bindings. Final source
fleet validation remains required.

At 10,000 agents, this adds compression work per existing upload, reduces its
wire size and adds no request, service, credential or shared admission mechanism.

## Human feedback

The user accepts genuine evaluated task failure, requires zero infrastructure
errors and full durable evidence, and asked to avoid unnecessary resets or a
large new verification framework. The original rejected slice stays rejected;
diagnostic recovery cannot count toward the fresh 100-task gate.

## Reusable lesson

Localize a forbidden upload with upstream correlation and same-input controls.
Preserve complete data with standard transport encoding; never reinterpret a
403, trim evidence, or infer an upstream rule from an HTML response alone.
