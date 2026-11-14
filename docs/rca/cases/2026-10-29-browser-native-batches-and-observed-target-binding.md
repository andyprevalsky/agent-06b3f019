---
id: 2026-10-29-browser-native-batches-and-observed-target-binding
date: 2026-10-29
title: Preserve ordered browser tool batches and bind same-turn observed targets
surface: agents
component: browser-native-action-dispatch
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: Native browser response normalization retained only the first ordinary tool call
symptoms:
  - You must call exactly one available browser action tool
  - Actual native response lost later calls before ordinary dispatch
  - Unstarted coalesced handoff recorded a,b,a,b instead of a,b
tags:
  - r48
  - browser-batch
  - observed-target
sources:
  - commit 85d37fc8ab8e284459977debdef34348d825ef84
  - agent ph78kfk10r8j8fpxxcp5tc43xd8h2x6q review R48-ORDERED-BROWSER-BATCH-V2 patch 7b1f3b50438a590d85b7198f9f2795dc56037a579da1f9278e2712f06a4fd299
repro: agents/benchmarks/browser_action_batch_test.py
status: fixed
---

## Problem

The user explicitly requested browser tool batches and prompt guidance, then
required observing a Pay button and clicking its returned reference without a
second model turn. Phase began 2026-10-29 at 02:39 UTC. This is a capability
request, not a diagnosis that any original benchmark would have passed.
Tokens UNMETERED. Original benchmark outcomes and source clocks are unchanged.

## Diagnosis

Exact85 `providers/rose/browser_use.py` instructed exactly one action and
returned the first call except for narrow printable-typing coalescing.
`RoseClient.complete_browser_use` and native streaming similarly retained the
first call. The permanent test using the actual client and mocked native
response of three ordinary calls fails at that normalization boundary on
original85. No model or browser call is required to reproduce the loss.

Dependent observation had no typed result-reference contract. Guessing the
next index or matching a model description would not establish native target
identity. A returned reference needs exact source-call and selector custody.

## Solution

The native client validates/preserves ordered calls and their original IDs.
A small ephemeral queue sends each action through the existing real activity
loop, retaining its user-control, credential, privacy, observation, approval,
error and cleanup gates. One actor response can execute two same-page input
fields and a click. ReadBrowserState can name exact role/name targets and a
subsequent Click can reference its observation ID and target key. Only a unique
visible entry present in the projected observation can bind; native document,
node, session, URL, credential and user-state identity are rechecked before
continuation and dispatch. Native results identify the originating observation.

Navigation, arbitrary evaluation, scroll, failure, interception or changed
ownership ends the sequence. Unexecuted calls get explicit skipped results.
Pause discards pending authority before serialization; completed calls are not
replayed. Native stream statuses are per call. Coalesced typing keeps original
IDs with explicit shared-operation result attribution. Cached tails and unsafe
simulated indexed tails are skipped rather than assuming target custody.

Independent V1 review found a duplicate discard expansion: the queue looped
native IDs while the ordinary transcript writer also expanded coalesced calls.
The same permanent actual-activity handoff test fails on V1 with a,b,a,b.
V2 invokes the existing expansion once and passes with a,b, each marked skipped.
The reviewer verified all nine source hashes and returned GROUNDED for exact
V2, with no remaining substantive blocker. The other seven V1 files were
unchanged. This isolated branch applies only those exact reviewed nine paths.

Postapply actual-checkout owning tests: 36 passed in 2.34 seconds on pinned
Python3.11. Exact off-tree registered14 and collateral10 also passed; independent
review verified the affected9 and inherited unchanged checks by file identity.
The ordinary Pay now purchase-approval executor still stops before dispatch.
Bare Pay has a different existing classifier result; no classifier change or
universal payment-detection claim is made. An attempted system-Python all-file
compile segfaulted; it is not a passing gate. Changed files compiled with the
pinned interpreter, and the actual-checkout suite imports the complete handler.

Personally opened primary implementations: browser-use0.13.11
agent/service.py2730–2849 and system_prompt.md155–181 (serial actions and stop
rules); Codex core tools/parallel.rs139–240 and code-mode runtime callbacks.rs15–74,
module_loader.rs66–104 (per-call cancellation and returned-value binding);
Hermes tool_call_batches.py and prompt_builder.py404–430 (ordinary routing and
batch guidance); OpenClaw browser/pw-tools-core.interactions.execution.ts299–410
(navigation epoch and abort). No exact named browser-reference protocol was
found. Those references do not prove arbitrary DOM atomicity; the authored
binding contract has its own controls. Hermes code execution excludes browser
calls, and browser-use's captured selector map is not a general fingerprint
check. Exact excerpts and hashes are in the retained review packet.

## Human feedback

The user required actual batches and specifically same-turn observe then click,
not prompt-only advice or only printable-key coalescing. Parent required normal
per-action approval and identity gates and no parallel same-page mutation.
Independent review rejected V1 for duplicated coalesced skipped results; V2
adds an actual handoff regression and fixes that exact boundary. No task prompt,
rubric, time budget, model route, provider, environment or live source changed.

## Reusable lesson

Preserve every native call identity while serializing browser mutations through
ordinary gates, and bind dependent targets to the actual observed native state.

## Limits

This is representability and dispatch proof with mocked model/browser leaves,
not real-model adherence, measured performance or original task PASS. Identity
checks are not an atomic DOM transaction; existing executor behavior governs
races after the final check. Public old index arguments remain supported.
Simulated runs cannot claim native selector custody. Deployment, root/owner
integration and a new benchmark were not performed by this branch.
