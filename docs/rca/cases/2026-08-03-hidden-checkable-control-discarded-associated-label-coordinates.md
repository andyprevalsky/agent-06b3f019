---
id: 2026-08-03-hidden-checkable-control-discarded-associated-label-coordinates
date: 2026-08-03
title: Hidden checkable controls discarded their visible associated-label coordinates
surface: agents
component: browser-agent
classification: our-bug
problem_class: other
first_bad_boundary: agents/browser_tools/dom_service.py::DOMService.get_element_rect returned no coordinates for a hidden checkbox without resolving its visible associated label
symptoms:
  - AMC seat E11 was identified as the exact auditorium center but its indexed click returned no coordinates
  - the browser agent recovered only by evaluating JavaScript against the visible E11 label
  - the strict movie-ticket runtime evaluator rejected the otherwise recovered trajectory because the click tool failed
tags:
  - browser-agent
  - humanization
  - coordinates
  - checkbox
  - label
  - amc
sources:
  - agent b1e04ed4-cff8-4f41-ab96-a150dc06032f
  - agent 8d6fd488-575b-4693-b1ab-7c4972271ce6
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_dom_service_hidden_checkbox_coordinates_use_visible_associated_label
status: open
---

## Problem

The strict AMC rerun identified E11 as the available seat exactly at the
horizontal and vertical center of the auditorium. The DOM exposed the seat as a
hidden checkbox with a visible associated label. Clicking checkbox index 10438
at step 12 failed with `Cannot humanize click ... no coordinates available`.
The agent recovered at the next step by evaluating JavaScript against the label,
but the unchanged runtime contract correctly rejected the recorded tool error.

A second diagnostic run reached the same boundary at checkbox index 8341. That
run later reached the $23.68 payment approval only because a provisional
evaluator relaxation ignored the failed click; it is reproduction evidence, not
accepted outcome proof. Archive searches for `Cannot humanize click`, `hidden
checkbox associated label`, and `seat click coordinates` found no prior case at
this first-bad boundary.

## Diagnosis

The path was `indexed click -> _execute_click -> get_click_coordinates ->
get_element_rect -> CDP Runtime.callFunctionOn`. Before the fix the click path
used the generic coordinate resolver, which measured only the target node's own
`getBoundingClientRect()`. A visually hidden checkbox has zero visible area even
when its standards-defined `labels` collection points to the visible,
user-clickable seat label. The method therefore returned `None`, and
`_execute_click` correctly refused an unhumanized browser-use fallback.

The permanent causal regression represents a hidden checkbox whose associated
label occupies a 44 by 36 pixel viewport rectangle. Before the fix, the exact
test logged that the element had no visible viewport intersection and failed on
`coords is not None`. This separates the coordinate-resolution defect from the
strict evaluator and from the humanizer's fail-closed policy.

## Solution

`DOMService.get_click_coordinates` now keeps the target's own visible rectangle
as the first choice. For clicks only, when the target is an enabled checkbox or
radio input without a visible rectangle, it walks the target's standards-defined
`labels` collection. A label is accepted only when it has positive viewport
geometry, is not hidden, transparent, or `pointer-events:none`, and remains the
top hit target at the center and across the complete six-pixel humanization
jitter ring. The existing bounded off-center jitter and humanized mouse path
then operate on that proven label rectangle. Generic element coordinates remain
unchanged, so text input, upload, and history consumers cannot acquire label
coordinates for a hidden checkable control.

The unchanged focused regression and a real-CDP hidden-checkbox fixture are
green. The real browser proves that generic coordinates remain absent, the
click-specific coordinates toggle the checkbox through its label, and a
non-hit-testable label fails closed. Base and strict Ruff, Python compilation,
and the full `spawn-browser-agent-v3` blackbox domain are green. Removing the
three pre-existing lint suppressions from the touched click dispatcher also
split its action, navigation, click, and text-input paths into bounded helpers;
the domain suite verifies the behavior-preserving cleanup.
The exact AMC rerun remains gated on harness-fix approval and must pass the
original strict evaluator before this case is marked fixed.

## Human feedback

No additional human correction was required for this boundary. The standing
constraint is to preserve humanized interaction and the strict no-tool-failures
runtime contract.

## Reusable lesson

Resolve hidden checkbox and radio clicks through visible associated labels before declaring that a humanized indexed click has no coordinates.
