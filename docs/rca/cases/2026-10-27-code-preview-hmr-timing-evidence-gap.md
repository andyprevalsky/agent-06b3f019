---
id: 2026-10-27-code-preview-hmr-timing-evidence-gap
date: 2026-10-27
title: Code preview exceeded its HMR DOM budget without retained hop timings
surface: back-end
component: code-preview-hmr
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: Unresolved between local agent file write and browser MutationObserver receipt; only their aggregate duration was retained
symptoms:
  - HMR took 3375 ms (budget 3000 ms)
  - Rose-in-Rose HMR: an agent write to the Rose front-end reaches the preview DOM in ≤ 3 s
  - write→DOM latency ms: 681, 3375, 584, 593, 468
sources:
  - commit e8e8cff1f26e97aceb8ea87740a0e775e13c1c9a
  - plan:.context/deploy-fresh-20261027/code-preview-batch3-failure.log
  - plan:.context/code-preview-rca-20261027/HANDOFF.md
tags:
  - code-preview
  - vite
  - hmr
  - chromium
  - latency
repro: none-recorded
status: open
---

## Problem

The canonical backend run recorded one failure among this domain's 16 cases.
All five writes reached the preview DOM, and each passed the existing no-reload
sentinel. The second edit exceeded the unchanged 3000 ms latency budget at
`back-end/src/tests/blackbox/code-preview.blackbox.ts:426`: 3375 ms. The case
lasted 42632.298 ms. Its retained latencies were 681, 3375, 584, 593, and 468 ms.

## Diagnosis

The relevant path is `localSandboxFs.writeFile` (mkdir then write) → Vite file
watch → HMR update publication → browser module request → Vite transformation
and response → React refresh/DOM mutation → MutationObserver's browser
`performance.timeOrigin + performance.now()` → the test's receipt. The native
latency subtracts Node `Date.now()` taken before the write from that browser
mutation timestamp; it does not simply measure the polling wait.

The original artifacts retain aggregate timings but no correlated watch,
transform, send/receive, DOM, or clock-calibration trace. Raw V8 coverage gives
executed functions, not those event durations. Host-pressure snapshots do not
attribute this particular delay. The first bad internal boundary is unproven.

Archive searches used the exact HMR title, `HMR took`, and behavioral terms
`code preview HMR agent write DOM latency browser watch compile`. Read both
Solution and Human feedback in the related September 10 browser-CDP timing-gap
case and October 21 private-realtime preview case. Neither proves this cause;
the latter addresses Supabase channel authorization, not this local HMR path.

A clean local fixture initially lacked required public Supabase settings and
was stopped; that setup attempt is excluded from outcome evidence. With
placeholder settings pointing to the owned loopback backend, the unchanged
native code-preview domain at the frozen SHA passed 16/16 with V8 enabled:
274, 239, 220, 280, 226 ms; case 13777.048 ms; wrapper 32.986 s. This pass does
not reproduce, diagnose, or repair the original failure.

A second native run validated optional scratch diagnostics only: 16/16 passed,
291, 232, 225, 223, 225 ms; case 13657.498 ms; wrapper 37.281 s. It retained
33 Node/browser events and 39 Vite events, zero dropped. This healthy trace
shows where a future failing edit can be separated; it is not causal evidence
for the historical failure. No corrected-green or adversarial repair claim is
made because a causal red was not reproduced.

## Solution

No product fix is proposed. Keep this case open and retain the exact 3000 ms
assertion, five real writes, DOM observation, reload sentinel, and existing
startup/request/cleanup deadlines. An opt-in two-file diagnostic proposal is
in `.context/code-preview-rca-20261027/diagnostic-proposal.patch`, for parent
review only. It instruments only the private copied Vite project and native
HMR fixture. It retains timestamps before native cleanup and catches diagnostic
save failure so native cleanup/outcome proceeds. It does not retry or replace
acceptance results. Source, case, INDEX and full-gate application remain owned
by the parent.

The diagnostic uses an additional pre-edit clock round trip and metadata
callbacks; its effect is not zero. One unrandomized native/observer pair cannot
estimate causal overhead. The Vite send wrapper preserves receiver, arguments
and return value; browser receive means the Playwright/CDP observation, not a
packet capture. Transform pre/post hooks bracket user plugins and do not claim
to span all Vite internals. Retention caps are 256 events per side and a 512 KiB
Vite log tail. Capture gaps and limits must be checked on a future failing run.

The isolated database was dropped after verifying zero remaining other
connections; native backend/preview processes were stopped and the owned
backend port closed. The aborted attempt's known session home and empty native
fixture directory were removed. Scratch snapshots/logs are retained.

## Coordinator constraints

The coordinator prohibited widening 3000 ms, skipping HMR/DOM, counting an unchanged
pass as a repair, retrying until green, or attributing the failure to coverage
or host load without proof. The RCA methodology requires the original causal red and the same
native command green before a repair claim, exact proposal before shared
application, owned local fixtures and cleanup, and an honest open outcome if
unreproduced. Shared source/Git/cases/INDEX/dependencies and live services remain
outside this independent lane; Freedom must be preserved.

## Reusable lesson

Capture correlated file-write, Vite, transport, browser mutation and clock timings before assigning the cause of an aggregate HMR latency failure.

## Human feedback

No additional user feedback was recorded for this HMR failure. The original 3000 ms acceptance remains in force.

## Applied diagnostic revision 2

The coordinator applied the independently accepted revision2 diagnostic patch af3debf7d97ee088d1f1bc5e7c999e26d26602789afc3280a6d49d8bb0d04716 before the next combined gate. It selects matching update identities, bounds parsing and retained metadata, records ambiguous/lost capture and gates the calibration await when disabled. All88 original assertions,3000ms budget,fivewrites,10000ms DOM wait and no-reload sentinel remain. The revision2 native attempt on the frozen pre-merge copy stopped at Prisma freshness before any fixture started; it is not a pass. The full merged-source backend gate will validate this optional observer. Its scheduling overhead is unmeasured, and the original failure remains unresolved.

The max-lines verifier required moving existing armMarkerWatch and readBody into the existing code-preview.support.ts fixture helper. Their executable function bodies and call sites remain unchanged; no line-limit override was added. Final full-source ESLint mutator passed after this extraction.
