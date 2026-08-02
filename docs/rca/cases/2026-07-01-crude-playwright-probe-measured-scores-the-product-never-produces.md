---
id: 2026-07-01-crude-playwright-probe-measured-scores-the-product-never-produces
date: 2026-07-01
title: A crude Playwright-mouse probe reported anti-detect scores the production humanizer never produces, in both directions
surface: agents
component: browser-agent
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: fcaptcha_probe.py — used naive page.mouse.move delivery instead of the production humanizer transport
symptoms:
  - 'naive bezier gives totalPoints=0 and a false "invisible pass" of 0.071'
  - 'real movement model over the crude transport gives 0.314 with cdp 0.8 "never coalesced"'
  - probe verdicts disagree with real agent runs
tags:
  - browser-agent
  - anti-detect
  - fcaptcha
  - probe-fidelity
  - test-harness
sources:
  - memory:project_fcaptcha_score_decomposition
repro: agents/tests/e2e/fcaptcha_humanizer_probe.py
status: fixed
---

## Problem

`fcaptcha_probe.py`, the fast iteration tool for anti-detect work, produced scores that
the real product never produces — and wrongly in both directions. A naive bezier path
yielded `totalPoints=0` and a false "invisible pass" of 0.071, while feeding the real
movement model through the probe's crude transport yielded 0.314 with `cdp 0.8
"never coalesced"`.

## Diagnosis

The probe drove the page with naive `page.mouse.move` calls. Production does not: the
real path is `browser_tools/input_synthesis.py`'s Sigma-Lognormal (Atlas/MIMIC) model
plus `humanizer.py`'s coalescing CDP fire-and-drain transport (enabled by default via
the `BROWSER_AGENT_HUMAN_*` env vars, all defaulting to True).

Because the detector scores _delivery characteristics_ — point density, coalescing —
and not just the geometric path, a probe that substitutes the transport measures a
different system. Hence both error directions: the naive path delivered so few events
that the detector saw nothing at all (false pass), and the real model delivered through
an uncoalesced transport looked maximally synthetic (false fail).

This is a fidelity defect in measurement, and it is the expensive kind: five behavioral
hypotheses (VM contention, PoW, screenshot CPU, mouse velocity, fingerprint) were each
disproven by live runs at roughly 6 minutes and $0.50 apiece, while an offline replay of
the vendor's own scorer over the captured payload gave the exact decomposition in ~3
minutes and predicted the post-fix score to five decimals.

## Solution

Deleted `fcaptcha_probe.py` (2026-07-01, unreferenced and giving false scores) and
standardized on `agents/tests/e2e/fcaptcha_humanizer_probe.py`, which drives the **real**
`BrowserHumanizer` plus injection through Steel and prints per-verification signals and
detections (~60s versus ~7min for a full agent run).

Two measurement facts cemented alongside it. First, the ratchet gates the
**form-submit** score, not the checkbox verify:
`run_benchmark.py::_evaluate_webdecoy_biometrics_result` (`WEBDECOY_RISK_RATCHET=0.163`)
uses `_webdecoy_exact_score_from_network_log`, which filters to `action == "form_submit"`
and takes the **last** entry — so the form-submit number is the one to report
(0.129 no-proxy / ~0.163 with the prod managed proxy), and the checkbox score (0.039) is
informational only. Second, `approachPoints` / `clickPrecision` are absent from the
payload, so Go's `getFloat` defaults them to 0 and two `vision_ai` rules always fire —
a client-side floor of 0.0946 that is not agent-specific. Also verified inert for the
score: a dedicated IP and `useStealthBrowser` (0.152 → 0.154).

## Human feedback

None recorded.

## Reusable lesson

Measure anti-detect behavior only through the production transport — a probe that
substitutes naive `page.mouse.move` for the real humanizer gives false passes and false
failures alike.
