---
id: 2026-10-01-publisher-chromium-host-libraries-were-not-installed
date: 2026-10-01
title: Fresh-browser publication failed because Chromium host libraries were absent
surface: harness
component: Linux durable-evidence-publisher environment
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Native Chromium loader could not resolve libnspr4.so before the signed-link verifier created a browser
symptoms:
  - "browserType.launch: Target page, context or browser has been closed"
  - "error while loading shared libraries: libnspr4.so"
tags:
  - chromium
  - playwright
  - linux
  - shared-libraries
  - durable-evidence
sources:
  - PR #1299
  - commit f7b31fb086a25338cf28510c32e3202cf931bd8f
repro: scripts/verify_benchmark_share_link.cjs
status: fixed
---

## Problem

The canonical signed-link publisher preflight failed after 3.019 seconds on the
owned Linux controller. Chromium had been downloaded for the backend's declared
Playwright 1.61.1 package, but browser creation still failed. The publisher's
bounded error excerpt reported `browserType.launch: Target page, context or
browser has been closed`; its native launch details were truncated.

Original preflight artifacts remain under `/data/proof87-publisher-preflight`.
Its exact wrapper and publisher were retired before diagnosis. No benchmark or
model call was launched to investigate this failure.

## Diagnosis

The path was canonical publication → signed-link Node verifier → declared
backend Playwright → Chromium's native loader. An isolated direct launch with
the same package and unchanged browser options retained complete stderr and
failed in 0.470 seconds. The first loader error was the missing `libnspr4.so`;
`ldd` then enumerated fourteen missing shared libraries on Debian 12. The binary
existed, so downloading it again or changing page/launch deadlines would not
repair this boundary.

Archive searches used `libnspr4.so Chromium error while loading shared libraries`
and `Playwright browser launch missing Linux system dependencies`. The related
[Auto-RCA Chromium hydration case](2026-07-25-auto-rca-runner-never-installed-playwright-chromium.md)
installed both browser and host dependencies in its GitHub workflow. Its owning
workflow is separate from this controller setup; this controller had installed
the binary without the runtime libraries. The bounded identifier and module
resolution integration repair is also separate from this host loader failure.

## Solution

Install only the thirteen Debian packages mapping to the actual missing loader
set, plus their seven new dependencies. The package names are also present in
the installed Playwright CLI's host-dependency list. Refresh apt metadata, reject
any existing-package upgrade/removal in the install plan, install without
recommendations or upgrades, and compare all preexisting package versions.

All 445 preexisting package versions were preserved. Twenty packages were newly
installed; the complete original loader set then resolved. The Chromium binary,
Node/Playwright versions, tracked source, browser options and publication bounds
were unchanged. Each owned operation was bounded, reaped, and verified to have
an empty native session. The installer worker was also absent afterward.

Future Linux setup guidance must include host dependencies as well as the
matching browser binary. This is a host-configuration correction; no production
code, secret rotation, benchmark definition or evaluator changed.

## Reproduction and validation

The private deterministic direct-launch script loads the declared backend
Playwright package, launches headless Chromium with the canonical
`--no-sandbox` option and executable selection, and immediately closes it:

```bash
cd /data/proof-controller/rose-pr1299
/data/toolchains/node22/bin/node /data/proof87-publisher-preflight/chromium-launch-rca/direct-launch.private.cjs
```

That identical script, SHA-256
`93b33de33fc6fb0907850ecefa698c7c40fda94966e4bde2ed175488c386e178`,
failed before package installation with return code 1 in 0.470 seconds and
passed afterward with return code 0 in 0.607 seconds. Its complete failure output,
package plan, before/after versions, loader inventories and exact process owners
are retained privately. An initial diagnostic quoting error and a package-plan
guard that misread architecture brackets are separately preserved and excluded
from the causal proof; neither installed packages.

The parent then ran the unchanged canonical publisher against the same retained
run and dump, with only isolated artifact output paths changed. It passed in
7.0136 seconds with 42 messages and `fe_verified=verified in fresh browser`.
The existing signed API, visible transcript, refresh, terminal and recording
checks remained active. Its manifest SHA-256 is
`e5b6435726d0e63be0bf7af08390e45370c484b33dbdde025cc48961e0c86c3b`.
The exact wrapper and publisher sessions were empty afterward. This was an
evidence-only preflight, with no new model/benchmark requests and zero
acceptance credit; it does not retarget an earlier failed slice.

Native evidence is under
`/data/proof87-publisher-preflight/chromium-launch-rca/` and locally under
`.context/acceptance/proof87-chromium-host-libs-rca/`. The canonical green receipt
is `/data/proof87-publisher-preflight-green/receipt.private.json`, with its local
safe copy `proof87-publisher-green.latest.private.json`. The production verifier
is the existing publication entrypoint; no new verification stage was added.

## Human feedback

The user required zero infrastructure failures while allowing genuine task
failure and requested focused verification instead of massive reruns. The
investigation preserved the original preflight, captured the actual loader
failure, repaired only required controller libraries, and reran the unchanged
publication path without paid benchmark or model calls.

## Reusable lesson

Hydrate the declared Playwright package's host libraries as well as its browser binary before relying on fresh-browser evidence verification.
