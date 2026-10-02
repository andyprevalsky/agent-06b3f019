---
id: 2026-10-01-large-benchmark-bundle-uncompressed-post-tls-eof
date: 2026-10-01
title: Large benchmark bundle failed durable Hub upload as plain JSON
surface: harness
component: agents/benchmarks/hub_upload.py
classification: our-bug
problem_class: other
first_bad_boundary: hub_upload._post_run_bundle sent a 21.5 MB benchmark bundle without compression
symptoms:
  - "hub upload failed (non-fatal): <urlopen error [SYS] unknown error (_ssl.c:2427)>"
  - "EOF occurred in violation of protocol (_ssl.c:2396)"
tags:
  - benchmark-hub
  - evidence
  - upload
  - gzip
sources:
  - benchmark run 3bc264f6-8b89-4b46-b7fe-6048df42127f
  - agent c61081ca-7fb4-4775-b1eb-3f7226bffed8
repro: agents/benchmarks/hub_upload_test.py::test_large_bundle_uploads_with_gzip
status: fixed
---

## Problem

The local `/deploy` smoke run completed at 6/7 tasks passed; its production
Benchmark Hub mirror failed with a TLS write error. The saved JSON run bundle was 22 MB on disk and
21.5 MB after preparation for upload. The in-app local Hub accepted it, but the
production mirror did not. `publish_evidence_links.py` retried the same plain
POST four times; each connection ended with `ssl.SSLEOFError` while writing the
request body. This left the durable FE link unverified during the RCA.

## Diagnosis

The request path was saved benchmark run → `prepare_run_bundle_for_upload` →
`_post_run_bundle` → production `/api/benchmarks/runs` → FE rehydration. The
first bad boundary was `_post_run_bundle`: it serialized and sent the full
21.5 MB body without compression, despite supporting benchmark runs much
larger than this. The backend parser accepts gzip JSON. Compressing this exact
prepared body reduced it to 1.1 MB, and a one-off POST with
`Content-Encoding: gzip` returned HTTP 201. The plain request repeatedly lost
its TLS connection, while the compressed request to the same endpoint with the
same credential succeeded. The exact network hop closing the plain connection
is unknown. Compression fixes this observed transport failure without weakening
the run bundle or dropping agent transcripts.

The uploader test also had a small-payload inconsistency: its timeout test
required 30 seconds for a 1 KB request, while the implementation returned
30.001953125 seconds. The timeout derivation now grows in half-megabyte steps,
preserving its large-bundle budget and exact small-payload floor.
The Step 5a bucket is `other`; a more specific future bucket would be
large-payload transport encoding.

## Solution

The uploader gzips prepared JSON bodies at 8 MB or above and sets
`Content-Encoding: gzip`; smaller requests retain the existing plain POST.
The focused test sends a threshold-crossing bundle to a local HTTP server and
checks that the server decodes the complete body. With the original uploader
restored, the unchanged test failed because `Content-Encoding` was absent
(`.context/hub-upload-red.log`). With the fix restored, it passed
(`.context/hub-upload-green.log`), and the full uploader suite passed 20/20.

The production upload of the original 21.5 MB prepared bundle then succeeded.
`publish_evidence_links.py` verified the failed agent's production FE link in a
fresh browser with 180 messages and published its final LLM call. The upload
does not change agent runtime or benchmark assertions. Compression uses CPU
once per large bundle; live snapshots below 8 MB are unchanged.
The separate `parallel-tool-calls` smoke timeout remains open in its own RCA;
`status: fixed` here applies only to the Hub upload.

## Human feedback

None recorded.

## Reusable lesson

Keep large trace bundles intact, but compress the Hub transport and verify
durable rehydration on the same saved run.
