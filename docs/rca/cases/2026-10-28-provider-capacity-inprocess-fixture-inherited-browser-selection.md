---
id: 2026-10-28-provider-capacity-inprocess-fixture-inherited-browser-selection
date: 2026-10-28
title: In-process provider-capacity fixture inherited Tilion selection while asserting Kernel limits
surface: harness
component: cloudbench-provider-capacity-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The in-process runpy refusal calls bypassed the existing clean_env scope and selected the ambient Tilion cap instead of the fixture's Kernel cap
symptoms:
  - test_provider_capacity_campaign_simultaneous_width
  - "AssertionError: 78 != 0"
  - "requested 70 concurrent benches, maximum 16."
tags:
  - provider-capacity
  - fixture-environment
  - runpy
  - kernel
  - tilion
sources:
  - commit 27c2559b99565d7b038ee854d827933947a9e0a6
  - commit 82428a9d5a9db7f8c6780ddc32e3ad56c0e5c3f9
  - plan:.context/deploy-fresh-20261027/rca-provider-capacity-440/RESULT.json
  - plan:.context/deploy-fresh-20261027/main-sync8-readonly/native-plan/joined.json
repro: agents/venv/bin/python scripts/tests/cloudbench-provider-capacity.test.py
status: fixed
---

## Problem

The full command-structural gate failed in
test_provider_capacity_campaign_simultaneous_width because refusal(70)
returned78 instead of0. Captured stderr stated that the active Tilion provider
allowed16 concurrent benches. The test intended to exercise the existing
Kernel fixture, which accepts70 and refuses71. Production enforcement
correctly refused the ambient provider's excessive request.

The original full command reported native exit1 and outer exit143. The cause
of that outer termination is unknown; it is not attributed to memory pressure.

## Diagnosis

The subprocess helpers already use clean_env() to pin the fixture's provider
premise. Two runpy-loaded in-process calls did not enter that scope, so they
read the calling process's browser selection and credentials. This made one
fixture combine Kernel expectations with the real Tilion limit.

Literal searches for test_provider_capacity_campaign_simultaneous_width and
refusal(70) found no matching case. Behavioral searches for fixture environment,
inherited provider and capacity found related environment-ownership incidents.
The Solution and Human feedback of
2026-10-06-archive-mock-controls-restored-local-storage were read. That case is
a relative, not this consumer's recurrence: its archive fixtures restored local
storage; this test bypassed its own existing provider environment helper.

The unchanged direct native16-case file failed in9.747s. The private snapshot
loader executes the real unittest __main__, retaining canonical __file__/ROOT
and selecting only original versus candidate test bytes. Its identical command
was:

    agents/venv/bin/python .context/deploy-fresh-20261027/rca-provider-capacity-440/run.py

Original:16tests/1failure, exit1,8.824s. Candidate:16tests/0failures,
exit0,8.860s. All99 assertion ASTs and all16 test names are identical.
An earlier loader setup discovered zero tests and is retained but excluded
from proof.

## Solution

Use unittest.mock.patch.dict(os.environ, clean_env(), clear=True) around the
existing in-process refusal calls. The scope restores the incoming environment
on exit. The calls still execute the real provider-capacity helper; the result
is not mocked. Preserve70/71 Kernel limits, actual16/17 Tilion controls, all
30/60/120s bounds and every existing assertion. The runtime helper, provider
registry and campaign implementation are unchanged.

Exact patch SHA:
27e649f81a4dee9a19a0fddc83c96f2ba919dc22c6520d2b56645019451e98da.
Independent review was GROUNDED, report SHA:
655914d579ab3d61d3665f18d3ba6996a4af87df32496e8906ca7cd0b7b04c64.

The fix is committed in82428a9d. The complete canonical provider-capacity owner
then passed all16 cases in9.046s; native owner88670 exited0 and was joined.
The other71 passing command registry owners remain explicit carried receipts.
That composition does not relabel the original failed full command or prove
a new full-command execution.

All native processes were joined. Subprocess helpers wait synchronously and
existing unittest cleanup removes its temporary directories. An exact original
temporary-path inventory was not emitted and is not claimed. No provider,
model, database or financial action was performed by this fixture repair.
The coordinator required the original provider limits, assertions and source
freeze to remain intact; these are coordination constraints, not new direct
human feedback.


### November 2, 2026 recurrence — import binding lost during merge

The integration preserved this fixture's explicit clean_env()/clear=True scope
but selected `from unittest import mock` alongside main's new `patch.dict`
setUp call. Three of16 canonical cases errored with NameError before assertions.
Gate: INTRODUCED against main a3c4929f3: main's matching import passes16/16,
merged6ff fails3 setup cases, and qualifying that same call as mock.patch.dict
passes16/16. Native private times:8.901s red,10.117s main,10.245s green.
Root applied the one-line change and canonical owner again passed16/16 in
10.463s. All limits, policy inputs, assertions and deadlines remain unchanged.
Evidence: .context/deploy-boxes-default-20261102/command-rca/. No provider, DB
or model call was made; native children were joined and temporary trees retired.

## Human feedback

None recorded for this fixture.

## Reusable lesson

Enter the fixture's explicit environment scope before an in-process helper reads provider selection.
