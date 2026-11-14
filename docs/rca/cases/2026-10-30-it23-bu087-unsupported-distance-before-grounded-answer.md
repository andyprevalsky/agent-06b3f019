---
id: 2026-10-30-it23-bu087-unsupported-distance-before-grounded-answer
date: 2026-10-30
title: BU087 gives a grounded shop name after an unsupported distance claim
surface: agents
component: browser-actor-evidence
classification: unresolved
problem_class: other
first_bad_boundary: Original actor reasoning asserts branch distances without recorded route evidence before later Maps evidence grounds the final answer
symptoms:
  - "The original El Moro location is a bit farther at 9 km."
  - "polar perfect-score failed (3/4 rubrics)"
tags:
  - polar
  - bu087
  - it23
  - c3
  - sourcing
sources:
  - commit fc00b583e7df7b94d05fdb3442bddd23cd21be8b
  - agent 9286e7cf-df0a-4ff8-b0e7-0f3a1ec6b9f1
  - plan:.context/r92/proof.json
repro: none-recorded
status: open
---

## Problem

It23 BU087r1/r001-j0007 asks for a specialty food shop with a Mexico location
7.8km walking from the specified McDonald's and a California location inside
a market with a November2023 floral class. NativeCOMPLETED711.1s/progress1
returns Churrería El Moro. The declared evaluator passes C1/C2/C4 but fails C3
for an earlier unsupported distance assertion. CanonicalFAILED/producerinfraFALSE
and the original grades remain unchanged.

## Diagnosis

All seven original normal files independently match manifest
dd28a13acb4ba9aa52bae2958e03d454eb6dd4e700eae075a19188c13812864b.
Archive SHA d923705d0fb47855788a15a75c8607f27c9f5be80ecd6c97756618905a908603;
run SHA ef7cb40133c754cbe64aa38276bbdcca98da7eb74b33393a5d586c3257034277.
Execution provenance binds sourcefc00b583e7df7b94d05fdb3442bddd23cd21be8b,
patch none. No live page lookup or model replay was used.

Worker line6681 retains the original browser_use_step_9 input and output,
dump320e0a0a2645, decoded payload SHA
5bc331805d626a387be8a3056f10f2ab7ceb3ec5d768004e024d1596e98c4f9a.
All27 listed messages are present. Its output thinking/reasoning says El Moro
Condesa and Roma are7.8km from the McDonald's and the original location is9km.
The same wording appears in persisted assistant message39 at00:32:27.797Z.
The following tool call merely extracts the Northgate vendor page; it does
not measure a route. The claim was authored in the model output, not inserted
by the renderer or converted from a tool result.

The captured input before that output contains no9km assertion, Condesa/Roma
route result, or Maps directions. The7.8km value occurs in the user's clue.
The immediate prior observation is Northgate's vendor-list page. This does
not establish an internal reason for the model's claim, but it binds the
unsupported assertion to its actual authoring context rather than relying
only on judge prose.

Later original evidence establishes the requested shop: the Los Angeles Times
article dated November22,2023 names Churrería El Moro in Mercado González,
the official locations page supplies the Mexico and Costa Mesa addresses,
and the floral-class event is retained. The final Maps DOM and native-verifier
input show walking selected with7.8km and an8.0km alternative to El Moro Centro.
The verifier explanation uses that later evidence and accepts the shop name;
the structured child output and final answer retain Churrería El Moro.
No historical-distance guarantee beyond the original evidence is inferred.

C3's declared failure concerns the earlier9km claim, while C1/C2/C4 accept the
completed answer. The later supported result does not erase the earlier
statement or alter the criterion. There is no demonstrated evidence-window,
field-conversion or final-output transport defect. The raw actor context is
hash-verified; the final native-verifier input is a persisted projection, not
a separately claimed byte-for-byte native request dump.

Archive searches covered unsupported early claims followed by corrected final
answers. The BU072/R81 C3 case and receipt-identity case were read as comparators.
They show why earlier claims and later success must remain distinct, but do not
prove an identical model-internal cause or authorize changing this grade.

## Solution

OPEN; no deterministic general runtime repair established. No answer override,
prompt nudge, hidden reasoning deletion, rubric change, model replay, budget
change or synthetic regression test was introduced. Further work would require
a concrete general mechanism that prevents unsupported assertions without
rewriting original history or weakening the requested evidence standard.

The normal cleanup receipt independently records Tilion session
sess_c3d0eb3fbb284427847d48307e7d415b DELETE204, root deleted and tree sealed.
No positive operational infrastructure failure was established. Incidental
navigation recovery and an earlier session-cleanup message do not override
final normal cleanup evidence or the C3 failure.

## Human feedback

The coordinator required raw actor/request evidence before accepting the judge's
attribution, preservation of native completion versus benchmark failure, and a
bounded decision without assuming an older family or manufacturing a patch.

## Reusable lesson

A correct grounded final answer can coexist with an earlier unsupported claim.
Bind that claim to the actual model input and output before diagnosing transport,
and preserve the separate trajectory criterion even after later evidence arrives.
