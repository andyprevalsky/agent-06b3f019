---
id: 2026-11-15-tilion-files-fetch-challenge-409-untyped-500
date: 2026-11-15
title: Tilion files/fetch 409 unsupported_subresource_challenge failed download-by-URL as an untyped HTTP 500 (and a detach-lag busy 409 would refuse it as a 409)
surface: back-end
component: tilion-session-io
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/browser/tilionSessionIo.ts readTilionSessionFile — made one files/fetch and threw Tilion's 409 unsupported_subresource_challenge (Cloudflare challenged the session's exit for the file) as an untyped TilionApiError, so the files/content route answered 500; it also treated the 409 session_driven_by_client a just-closed CDP client leaves for ~0.1 s as final
symptoms:
  - "FAIL live Tilion provider parity: Tilion download by URL did not match: HTTP 500 285/6121 bytes"
  - "Tilion request method=POST path=/v1/session/<id>/files/fetch status=409"
  - "unsupported_subresource_challenge"
  - "session_driven_by_client"
  - "a CDP/Playwright client is attached; drive the session from one place, or close the client"
tags:
  - tilion
  - files-fetch
  - cloudflare-challenge
  - cdp-detach-lag
  - download-by-url
  - flaky
  - observability-gap
sources:
  - PR #2005 (live-probes FLAKY occurrence ba2764a3; GitHub Actions run 43669374714, browser-provider.log lines 1793 and 1811, Tilion request 5d8f147e430e4130)
  - commit 47eeada6ba5180d76ca86c811a42e6beac80a05f (failed source)
repro: back-end/src/tests/blackbox/browser-provider.tilion-file-fetch.support.ts
status: fixed
---

## Problem

In the live-probes deploy gate, the browser-provider domain's `live Tilion provider parity` case failed once and passed on its rerun:
`Tilion download by URL did not match: HTTP 500 285/6121 bytes`. The backend logged only `POST .../files/fetch status=409 durationMs=871 requestId=5d8f147e430e4130`. The vendor's error body was never logged, and Tilion offers no lookup by request id.

## Diagnosis

- The route `GET /api/browser-session/:id/files/content` maps only `TilionSessionBusyError` (409 `session_driven_by_client`) to a typed 409. Any other Tilion 409 reaches the fixture server's error handler as `{"error": <message>}` with HTTP 500.
- Live Tilion probes on 2026-11-15 (challenge requests 0d73dce971c94d67 and 459581246b444a58) captured Tilion's files/fetch answer for a challenge-fronted file: `409 {"detail":{"error":"unsupported_subresource_challenge","status":403,"network_error":null,"size":null,"limit":33554432}}`. That detail has no `message`, so `parseTilionErrorBody` uses its JSON as the message. For the CI session and request ids, the resulting 500 body is exactly **285 bytes**. The busy refusal would give 246 bytes and a typed 409, not a 500.
- w3.org (the test's download host) is served by Cloudflare with bot management (`__cf_bm`). The 871 ms duration matches a real page fetch on a freshly rotated residential exit (the passing rerun took 873 ms). Busy refusals answer in about 25 ms. Cloudflare challenged that exit for the file. The rerun ran on a new session and exit and passed.
- Why this was possible: `readTilionSessionFile` made exactly one files/fetch, while Tilion documents a challenge as cleared in-session by `navigate` (probe: navigate reported `js.cloudflare_challenge_page: cleared`, and the next files/fetch returned 200).
- Same-class site, reproduced live: for about 0–90 ms after `browser.close()`, Tilion still answers files/fetch with 409 `session_driven_by_client`. The parity case calls files/fetch about 70–100 ms after its worker-path CDP client closes, so it can land in that window. The client classified the busy refusal as final.
- Observability gap: `tilionRequest` logged the status line only, so a gate log could not tell busy, challenge and no_tab refusals apart.

## Solution

- `tilionErrorFromResponse` types 409 `unsupported_subresource_challenge` as `TilionDownloadChallengedError`.
- `readTilionSessionFile` (back-end/src/providers/browser/tilionSessionIo.ts) handles that error by calling Tilion `POST /v1/session/{id}/navigate {url}`, which clears the challenge inside the session and moves the session's open tab to the file URL. It refetches once only when navigate reports `status: ok`.
- `respondToTilionRefusal` answers a challenge Tilion could not clear as a typed 409 `download_challenged`, not a 500.
- files/fetch retries `TilionSessionBusyError` within the client's existing 3 attempts (250/500 ms backoff). This is a sibling cause reproduced live, not the cause of the CI failure. A client that stays attached still surfaces as the typed 409. No timeout changed.
- `tilionRequest` logs every refused call's slug and redacted vendor body (`Tilion request refused`).

Regression: `browser-provider.tilion-file-fetch.support.ts`, registered in the hermetic `backend-blackbox browser-provider` unit. It drives the real files/content route against the captured vendor answers.
- On unfixed source it fails with the byte-identical `HTTP 500 285/6400 bytes`. With only the challenge fix applied, the busy scenario fails with `HTTP 409`.
- Negative controls:
  - a still-attached client gets a typed 409 after exactly 3 calls;
  - a challenge navigate could not clear gets a typed 409 `download_challenged` with no refetch;
  - `no_tab` gets one call and no navigate.

Independent review agreed that the 285-byte challenge body is the first bad boundary and that the busy race did not cause this failure. Its requests (type the uncleared challenge, refetch only after an `ok` navigate, log the vendor body, frame the busy retry as a sibling) are applied. The tab move is kept deliberately: Tilion documents clearance as bound to the tab that earned it, so clearing in another tab is unproven.

10k behavior: a challenge adds one navigate and at most one refetch per affected download; a busy refusal adds at most two retries in about 0.75 s per call. There is no shared state, fan-in or polling.

## Human feedback

None recorded.

## Reusable lesson

Before attributing a vendor 4xx, reconstruct the error body from its byte count and duration, and handle each documented, in-session recoverable refusal (a challenge, a client-detach lag) at the provider client instead of letting it surface untyped.
