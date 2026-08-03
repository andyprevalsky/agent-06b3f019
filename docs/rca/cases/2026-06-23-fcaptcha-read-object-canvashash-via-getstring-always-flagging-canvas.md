---
id: 2026-06-23-fcaptcha-read-object-canvashash-via-getstring-always-flagging-canvas
date: 2026-06-23
title: FCaptcha's server read an object `canvasHash` via `getString()`, so "Canvas blocked" fired for every client and floored our score
surface: agents
component: browser-agent
classification: third-party-failure
problem_class: other
first_bad_boundary: FCaptcha server-go — client sends canvasHash as {hash,dataLength,supported}; server getString() yields "" and always flags
symptoms:
  - 'fingerprint 0.4 "Canvas blocked" on every run (+0.032 to the score)'
  - browser-biometrics-webdecoy score never drops below a ~0.071 floor
  - canvas spoofing changes nothing about the flag
tags:
  - fcaptcha
  - anti-detect
  - browser-agent
  - vendor-bug
  - benchmark-floor
sources:
  - memory:project_fcaptcha_score_decomposition
repro: agents/tests/e2e/fcaptcha_humanizer_probe.py
status: fixed
---

## Problem

The `browser-biometrics-webdecoy` FCaptcha score had a hard floor around 0.071 that no
amount of client-side work could beat. Part of that floor was
`fingerprint 0.4 "Canvas blocked"`, contributing about +0.032, which fired on
**every** run regardless of what the browser did.

## Diagnosis

Decomposing the score against the vendor's own scorer showed the flag was a vendor
bug, not a detection of us: the FCaptcha client sends `canvasHash` as an **object**
`{hash, dataLength, supported}`, while the Go server reads it with `getString()`,
which yields `""` — so the server concludes canvas is blocked for every client that
ever calls it. Canvas spoofing cannot beat it because the value never reaches the
comparison.

The rest of the floor was infrastructure, also not code-fixable: three proxy headers
added by Steel's **managed** proxy (`x-forwarded-for`, `x-real-ip`,
`cf-connecting-ip`, `bot 0.3` each, ≈ +0.039). Only a clean high-anonymity BYOP proxy
(`STEEL_PROXY_SERVER`) removes them, which would drop the floor to ~0.032; none was
configured as of 2026-06-23.

The scoring model, for future decompositions: final score = Σ categoryScore · weight,
capped at 1.0, with weights behavioral 0.18, vision_ai 0.15, headless 0.15, bot 0.13,
cdp 0.12, automation 0.08, fingerprint 0.08; a category is `1 − Π(1 − strength)`;
"allow" is below 0.3.

## Solution

No client-side fix exists — the correct action was to stop attributing the flag to our
browser and to bound the achievable score accordingly, spending effort only on the
code-fixable flags. The vendor bug was later observed fixed: on a 2026-07-01 probe the
real `canvasHash "-491fa4a0"` was sent as a string, `fingerprint` scored 0, and the
floor dropped from ~0.071 to ~0.039, leaving the three Steel proxy headers as the only
residual.

Method that produced this: clone the vendor and run its own scorer offline over the
captured payload (`server-go/scoring.go`, `detection.go`). Signals live in the
`/api/score` **request** body (the response is a bare number), captured via
`recording.py`'s `BrowserNetworkRecorder`.

## Human feedback

None recorded.

## Reusable lesson

Before tuning against a third-party detector, run its own scorer offline over the
captured payload — a flag that fires identically on every run is usually the vendor's
bug, not your behavior.
