---
id: 2026-10-29-it19-bu079-thousand-hours-unit-selection
date: 2026-10-29
title: BU079 returned hours in a thousand-hours field despite retaining both units
surface: agents
component: browser-semantic-completion-verifier
classification: unresolved
problem_class: other
first_bad_boundary: The actor chose17000 for thousand_hours after calculating17; the verifier retained both values but explicitly accepted17000
symptoms:
  - Native task COMPLETED while benchmark C4 failed
  - Early tool result distinguished17000hours from17thousandhours
  - Final required integer thousand_hours was17000
tags:
  - r66
  - it19
  - units
  - semantic-verdict
sources:
  - commit d1b1062cfd420832467d4e2b7e10c770a0318157
  - agent c2cc8579-8514-4d80-9350-2d81c0bd1401
  - fleet run 20261029-175440-3819614
repro: Original encoded verifier request and response; no new model call
status: open
---

## Problem

Original It19 jobr001-j0009, polar-bu-079 run1, completed natively but failed
one of four declared rubrics. C1/C2/C3 passed and C4 required exactly17.
The task asks how many thousand hours Kipchoge would need to run the Moon's
minimum-perigee distance at his record marathon pace, rounding to the nearest
1000hours. The returned field was17000. Original benchmarkFAILED, passedfalse,
infraFALSE and nativeCOMPLETED remain distinct and unchanged.

## Diagnosis

Archive SHA256
`cb5342aa2004a46349c79859505df7ce491e758214611e9bf7d3c62aafccb8f7`;
all seven normal members independently match manifest
`d0a90fc48de97e736049ff2627b7e77ec7cffb2e0293e58920465c588e1cfb7b`.
Run JSON SHA256
`ddca98acf8ef8a8f0e4d4797a89b53e5fabca268a47bcc0f2c563573905a7099`.
The exact generated schema requires integer thousand_hours, described as the
number of thousand hours with the task's rounding instruction. No transport
field is missing or coerced from a different type.

Persisted message27 records successful JavaScript calculation:
rounded_hours17000 and thousand_hours17, from356400km,42.195km and2:01:09.
The actor subsequently reasons about the schema's units and chooses17000.
Message40 records a later JavaScript expression assigning
Math.round(timeHours/1000)*1000 to thousand_hours. This is the first observed
wrong-unit output, not a later formatter mutation.

The actual encoded verifier_browser request is captured in worker line6268,
payload SHA256
`7b4ef16470906fd34d27caa96643c88344ec6d82635fa2279c38eec55a0c6a8c`.
It retains the earlier17 and later17000 tool results. The corresponding response
update at line6886, payload SHA256
`f98a877e18076bf4c0b6eb21e25888f9bf93010bc5704425edefed964ca131db`,
explicitly returns output={thousand_hours:17000}, task_completed=true,
score=1.0. Its reasoning chooses hours rather than thousands of hours.
Thus this is not inferred from a progress label or an uncaptured boolean.

The child structured result, root notification51, root verifier54 and completion
summary56 all retain17000. Source check_progress uses the completed child's
structured result for the root shortcut; it does not convert17 to17000.
The declared C4 reasoning rejects that same final value. Raw judge HTTP request
parity was not separately established, and no grader-defect claim is made.

Two archive searches followed inspection: units/thousand hours and structured
output/unit conversion. The disabled-verifier completeness case and prior
retained-conflict semantic case were read. Neither matches a proven missing
field, absent completion flag or dropped evidence here.

## Solution

No safe general deterministic runtime repair is established. Matching the field
name, inserting an expected17, rewriting rounding instructions, changing the
rubric or adding a unit-specific prompt would not prove a general repair.
Both actor and verifier received the relevant distinction and selected the wrong
representation. The exact task wording's rounding clause is part of the original
contract, not permission to alter its ground truth or regrade the result.
The semantic unit-selection mechanism remains OPEN. No code, model route,
timeout, task, schema, evaluator or budget was changed; no new model call ran.

## Human feedback

The coordinator required original encoded evidence before grouping with old
families, preserving native completion versus benchmark failure and avoiding
speculative task-specific fixes. The investigation used local originals only.
Tokens UNMETERED.

## Reusable lesson

Preserved evidence and an explicit completion flag do not guarantee correct
unit selection. Bind the original calculation, schema, actual response and final
value before blaming formatting or transport, and retain the genuine failure.
