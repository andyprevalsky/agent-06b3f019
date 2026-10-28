---
id: 2026-10-28-pngtree-challenge-recovery-cause-unresolved
date: 2026-10-28
title: PNGTree task returned historical assets after live challenge recovery failed
surface: agents
component: browser-challenge-recovery
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: first observed failure is live PNGTree challenge and rejected recovery; no owned causal first-bad boundary is established
symptoms:
  - "No stable browser configuration cleared the challenge"
  - "ReadTimeout"
  - "The archived substitute therefore does not establish end-to-end completion of the requested browser task."
tags:
  - polar
  - pngtree
  - challenge-recovery
  - classifier
  - historical-substitution
sources:
  - commit 4c6861dcd2a9aacf22e3937cea27fae904727349
  - agent f5837978-46a6-4542-95e6-6a05a540eb98
  - agent 0221da1b-b005-4d0b-9f55-23f21f9c283d
  - fleet run 20261028-000611-2855684
  - fleet run 20261028-000611-2855770
  - benchmark run campaign-20261028-000553-2852420
repro: none-recorded
status: open
---

## Problem

Iteration 6's polar-bu-023 r1 took 2003.0 seconds and failed C1, scoring 2/3.
The task asks for the formats of the first ten assets in PNGTree's Text Effect
section at pngtree.com. Initial navigation encountered a Cloudflare challenge.
Three recovery actions ended in ReadTimeout, unsuccessful fresh-cookie search,
and unsuccessful authenticated-state search. The browser then used a November
27, 2023 Wayback snapshot of the site's free-fonts page. Step 174 explicitly
records that source and ten PNG assets. This is real historical evidence but
does not demonstrate completion on the requested live site.

The same-source r2 passed in 620.6 seconds. Its first recovery also failed. A
second fresh-cookie recovery selected steel_fixed; it then browsed the live
Text Effect section and extracted PNG and PNG-and-Vector formats.
Neither run had an infrastructure result or cleanup failure.

The immutable fleet bundles have SHA256
1319dcd843a02125b0ce7ebdf7ba2df23e4978b093a6319884faa74808c6f8c7 (fail) and
310cd996ca1a6b73e495a8b63177dca9490af7a876148304c445bfc553b01f37 (pass).
The task attachment matches the source catalog exactly; canonical JSON digest
1b4157b6a9f78f38f7fb2b0a0337229bd8db425e1f6cb945115d0040ec299abb.
No task, rubric, deadline, step limit or recovery policy changed.

## Diagnosis

Path: live navigation -> challenge detection -> provider solver/cookie and
configuration probes -> actor continuation -> historical extraction -> browser
verifier -> final Polar rubric judgment.

The available trace supports the original failure. C1 cites the uncleared
challenge and historical substitution. C2/C3 accept the output's format and
its grounding in the explicitly identified archive; they do not establish live
completion. The browser verifier accepted the historical data, but no task
correction or verifier policy edit is justified from this one example.

An offline replay through build_polar_trajectory/run_polar_evaluator matched all
three original encrypted judge requests byte-for-byte and replayed their exact
saved raw responses, reproducing 2/3. History is 39904 characters, SHA256
0aef46533d3a2952bb6a3d6afe68f36cf838b7c17462ac9ca7fbf7d8b0576252; no screenshots
were sent in either original judgment. All failed recovery and archive-source
text was present. Thus this evidence does not support evaluator text loss.
This is a recorded-output replay, not an LLM rerun or causal red/green fix proof.

The deeper recovery cause remains open. Backend candidate classifier logs show
26 decisions in r1: 18 rejected with a PNGTree title and >9000 characters of DOM,
eight rejected with smaller challenge-like content; all recorded HTTP403.
The passing run has six similar rejections followed by two clean classifications
also carrying 403. These are candidates for investigating mixed-time evidence
or classifier interpretation, not proof of either. Large DOM/title alone do
not establish usable task controls. Page screenshots and complete network
observations are needed before calling a rejection false.

Source probeCandidateBrowser captures DOM/network before waitForProviderSolver,
which settles the page before capturing title/screenshot; it also passes the
original navigation response's status. This can present observations from
different times, but these logs cannot prove that happened in the failing
candidate or that changing it would complete the task. Do not remove 403,
weaken challenge verification or force-promote a candidate on this evidence.

An existing no-network blackbox control also passes: the real HTTP503 codec
and recovery orchestrator preserve the exhausted-search error rather than
labeling it a selected browser, while a valid HTTP200 winner stays accepted.
This rejects the October1 result-mislabeling recurrence hypothesis; it is not
a red/green for the current recovery cause.

The full original actor requests were recovered from SHA-verified compressed
worker payloads. The root encrypted R2 manifest and missing judge/verifier
dumps were fetched read-only and integrity-checked. They contain no original
backend candidate-classifier multimodal requests. The launch owner independently searched the failed fleet and its devbox for
backend dumps/candidate probe screenshots and confirmed none remain after
normal guest teardown. Backend llmDump.ts disables
those dumps on Fly/production; the trace therefore lacks the relevant candidate
screenshots, full DOM/network inputs, and complete model output. No exact
classifier-call repro, model-only comparison, or task outcome replay was run.
A passing sibling is not proof that stochastic model behavior caused the miss.

Archive searches: `security challenge could not be cleared PNG Wayback` and
`browser recovery archived substitute live website`. The October2 classifier
POST-evidence case and August5 Eventim case are relatives; their first-bad
boundaries are not established here. October1 config-search-result mislabelling
is also a relative: this run correctly reports no stable configuration, rather
than a nonexistent successful selection.

## Solution

No runtime fix is justified yet. Preserve the original FAIL and all task
criteria. The next useful discriminator is the original candidate request and
settled document identity/network/DOM/screenshot timeline. Backend production
capture is a known evidence gap; an observability patch alone would not resolve
this RCA and is not presented as the solution.

The private reproducibility packet is `.context/polar-r4`: original archives,
verified worker dumps, encrypted-manifest downloads, exact judge inputs and raw
responses, candidate-log summaries, and replay.py/replay.log. The replay command
is `PYTHONPATH=agents agents/venv/bin/python .context/polar-r4/replay.py`.
It verifies evidence transport only. Canonical unchanged-task red/green and any
causal fix remain unperformed. Independent reviewer ph74rex3pescaywbxyjn3njr158h3pp9 opened the condensed
original histories and source recovery/capture paths and agreed with the
bounded evidence-only disposition: preserve C1 FAIL; no runtime fix justified.
The reviewer did not independently decrypt all raw bundles or run the replay,
and no strong-GROUNDED runtime approval is claimed. Missing original candidate
calls prevent an independently verified causal boundary.

## Human feedback

The parent requested a bounded R4 investigation, preserved genuine failure,
forbade challenge bypass, task/rubric/timeout/step changes, new paid runs,
browser/provider writes, deployment, and changes to Freedom. Any protected
runtime candidate requires independent exact-snapshot strong grounding first.

## Reusable lesson

Distinguish a well-grounded task failure from an unproven recovery cause, and
retain the complete candidate observations before changing challenge gates.

## It8 R11a: distinct captured challenge/proxy-timeout path

Source ca562dd8b9a259800980bbdc2205d873bc657d5e; BU023 run2,
agent e1b7f546-e70d-4043-8f32-2479ebcbcc96, fleet20261028-051014-17505.
Normal shard01 export SHA256
9ecd2ac44e3602f13b5958239c967b0c775c17c876285e2c19f229790837966d.
Run JSON SHA256d5770f4f5889cf6822f48aa77ac32926ab4e20105e93bbc9f1fd58bddd9b30a3;
worker SHA256a1bca91e716dd8d73c48673f7f9bbdc47addb4d107dd400c3fcfe777912e462a.

This run has repeated challenge/recovery work and a captured upstream502
(upstream_timeout) from the browser proxy for m.pngtree.com at05:26:43Z.
Recovery failures occur at05:21:54,05:33:06 and06:03:56. It continues navigation
until the native browser activity reaches StartToClose at06:06:40.769427Z,
then the task isFAILED after3020.1s. A later06:07:28 pause notification is cleanup
after that terminal error; it is not evidence the user caused the failure.
The run1 sibling reaches the live TextEffect page and passes in1680.2s.

The matching site is an archive lead, not proof of the same earlier cause.
No captured first-bad local mutation or causal offline control establishes why
this run failed recovery while its sibling succeeded. Status remains open,
with no runtime patch, retry, deadline relaxation or task reclassification.
OriginalFAILED/infrafalse is preserved. Existing local artifacts were read;
no new browser, provider or paid task calls were made.
