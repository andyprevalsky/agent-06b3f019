---
id: 2026-11-03-composer-render-published-uncommitted-action-owner
date: 2026-11-03
title: A suspended composer render redirected the visible agent controls to an uncommitted selection
surface: front-end
component: composer-agent-context
classification: our-bug
problem_class: other
first_bad_boundary: ComposerAgentProvider render assignment current.current = agents mutates the committed action owner before React commits the candidate selection
symptoms:
  - visible agent A composer sends and pauses agent B during a suspended transition
  - typing still editing A calls B setMessageInput while A remains visible
  - removing the render assignment alone leaves committed B showing A draft and model
tags:
  - react
  - suspense
  - concurrent-render
  - composer
  - agent-isolation
sources:
  - PR #1670
  - commit 11c6e07269b47a3db1f6b096a8779453e109ce9d
repro: front-end/src/tests/blackbox/composer-concurrent-ownership.blackbox.tsx
status: fixed
---

## Problem

The visible committed composer belongs to agent A. React starts a transition to
agent B and renders the composer provider, but a later sibling suspends. A's
existing DOM, input and event handlers remain visible while the transition is
pending. Clicking Send or Pause or editing the draft nevertheless invokes B's
actions. The real React18 owning-boundary reproduction demonstrates all three
wrong-target calls, both normally and under StrictMode.

## Diagnosis

Gate: INTRODUCED. The performance release introduced the provider and its
render-time write to the shared action-owner ref. The first-bad boundary is
inside the provider render, before React commits the B tree. A's already mounted
handlers dereference the same mutable ref that B's speculative render overwrote.

The exact permanent three-test regression on the clean merged 7e51f7e9 source
reports two failures and one positive pass. The earlier private packet also
includes two passing existing host-history controls. A's Send, edit and Pause call counts are all zero; B has
one of each despite A's unchanged visible label and input. The event sinks are
the actual useComposerActions functions and the provider is the production
module. A newly committed B view, scalar-bound async refresh origin, unmount
retirement, persistent-input draft/focus and closed-history host-property checks
are the positive controls.

The deepest owned gap is sharing one mutable cell between render data and
committed event ownership. Every control that dereferences that cell can target
the uncommitted selection. Merely deleting the render assignment prevents the
wrong event target but fails the positive control: a completed B commit still
renders A's draft/model because render consumers read the previous ref.

Archive searches were `ComposerAgentProvider abandoned render current.current
actions` and `concurrent transition visible agent draft submit wrong agent ref`.
The September03 agent-isolation case is related: it also forbids publishing
speculative ownership and scopes asynchronous writes. This incident has a new
first-bad boundary in the retained composer action provider, rather than the
old realtime subscription boundary. The prior case's solution/human feedback
were read; no matching composer occurrence was found.

Golden reference: not applicable (no approval-gated hunk).

## Solution

The production ComposerAgentProvider and composerAgentContext now separate the
current-render AgentSlice context from the stable committed-owner ref context.
Render consumers use their own render's data; action callbacks capture only the
stable ref and the selected agent ID scalar. The provider publishes the ref in
the layout commit effect and clears it on unmount.

The permanent regression is registered in the normal frontend blackbox glob.
Running `npx vitest run src/tests/blackbox/composer-concurrent-ownership.blackbox.tsx`
in front-end before the production change fails both suspended-transition tests
and passes the completed-switch control. The identical test file passes all
three cases on five consecutive runs after the change. Seven existing related
composer, history ownership, agent isolation, new-agent action and terminal
header suites also pass all 27 tests. Focused ESLint and formatting checks pass.
These are local causal and compatibility results; full combined release gates
and production verification remain owned by the existing deploy coordinator.

This removes speculative mutation without adding a cache, history cap, render
retry, timer or per-action special case. Context providers add no host DOM.
The existing memory boundary is preserved: persistent input handlers retain
only the ref/scalars, and closed histories are absent from retained host props.
Fresh normal resource/semantic gates must validate the coordinated final source;
these local passes do not claim a new production deployment or universal leak
freedom.

## Human feedback

The user requires completing the existing mobile performance release, preserving
functionality, appearance and full accessible history, without competing deploy
ownership or repeating a new ad hoc browser matrix. No specific implementation
feedback on this composer repair is recorded.

## Reusable lesson

Keep speculative React render data separate from the committed owner used by persistent event handlers.
