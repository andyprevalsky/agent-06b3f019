---
id: 2026-11-06-captcha-indicator-claimed-solving-from-widget-presence
date: 2026-11-06
title: The in-page "Auto-solving CAPTCHA" chip claimed solving because a challenge widget was present, without any solver evidence
surface: cross
component: captcha-solve-indicator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: resolveCaptchaAutoSolveActive (back-end/src/providers/browser/captchaSolveIndicator.ts) and its Python mirror resolve_captcha_auto_solve_active / poll_captcha_indicator_phase (agents/browser_tools/captcha_solve_indicator.py) returned solving for Kernel (and Tilion in TS) whenever the CAPTCHA_WIDGET_PRESENT_SCRIPT probe matched, although neither provider reports in-flight solver state
symptoms:
  - "Auto-solving CAPTCHA"
  - "Injected CAPTCHA auto-solve live-view indicator"
  - "rose-captcha-auto-solve-chip"
  - "auto-solving might need 1 to 2 minutes"
  - browser agent waits on a CAPTCHA that no provider solver is working on
tags:
  - captcha
  - live-view
  - kernel
  - tilion
  - truthful-tool-results
  - descend-h-35b
sources:
  - agent 17890db0-0ad7-4397-92c2-3625edd39efd (anti-bot-proton-signup r001-j0011, campaign-20261106-185145-1109152)
  - task anti-bot-proton-signup (H-35 primary cause case 2026-11-06-proton-proprietary-drag-captcha-no-solver-misleading-autosolve-chip)
repro: agents/tests/blackbox/challenge_recovery.blackbox.py::test_captcha_widget_without_solver_evidence_is_not_auto_solving; back-end/src/tests/unit/captcha-solve-indicator.test.ts::testWidgetPresenceIsNotSolverEvidence
status: open
---

## Problem

On Proton's Human Verification step, the browser agent's DOM contained Rose's
injected chip "Auto-solving CAPTCHA". The agent waited 180 s in total ("auto-solving might
need 1 to 2 minutes"). The step 54 capture still showed the chip, and the
run ended with captcha_completed=false. The worker logged "Injected CAPTCHA
auto-solve live-view indicator" twice and no Kernel `captcha_solve_result`
event. No provider solver was working on that challenge. Tilion has no solver
for it (T96: captcha_solves=0), and Kernel reported nothing.

## Diagnosis

Path: provider telemetry (`GET /api/browser-session/:task/captcha-telemetry`)
→ `poll_captcha_indicator_phase` → `resolve_captcha_indicator_phase` → CDP
`setPhase('solving')` → chip in page DOM → agent DOM extraction → LLM.

Kernel telemetry has `isSolving: null` by construction. The Kernel SDK
exposes only the terminal `captcha_solve_result` event and no in-flight event.
Tilion telemetry is hard-coded `isSolving: null`. In that case the resolvers
substituted `CAPTCHA_WIDGET_PRESENT_SCRIPT`, a DOM probe that matches vendor
hosts and any iframe whose title contains "captcha", as a stand-in for
"solver is engaged". This was true for Kernel in Python and for Kernel and
Tilion in TypeScript. The widget probe proves only that a challenge exists. It
says nothing about whether a solver supports or is working on that challenge.
It is also true when Kernel stealth (the solver) is disabled, for Tilion
(cdp_observe is off by default and solved neither reCAPTCHA v2 nor
Turnstile), and for unsupported families (Proton's puzzle, DataDome, Arkose).

Deepest owned cause: the indicator contract ("telemetry-driven, not DOM-only"
per its own test) had a heuristic exception that turned challenge presence into
a solving claim. The chip is in-page DOM, so this claim reached the model as a
fact. Next rung: "Rose overlays should never be visible to the agent". That
rung also covers truthful terminal chips, and the user-visible live view needs
the chip in the page. That is a design decision, not this defect.

Repro (red on 3271548804, the pre-fix base):
`cd agents && python tests/blackbox/challenge_recovery.blackbox.py` →
`❌ captcha_widget_without_solver_evidence_not_auto_solving: AssertionError: kernel: widget presence claimed 'solving' without solver evidence`;
`cd back-end && npx tsx src/tests/unit/captcha-solve-indicator.test.ts` →
`AssertionError: back-end/src/providers/browser/captchaSolveIndicator.ts still treats widget presence as solver evidence`.

## Solution

Deleted the widget-presence stand-in. "solving" now requires the provider's own
in-flight flag (`isSolving === true`, Steel only). Kernel shows the chip only
for a fresh terminal `captcha_solve_result`, as "CAPTCHA solved" or "CAPTCHA
solve failed". Tilion never shows it. Removed `CAPTCHA_WIDGET_PRESENT_SCRIPT`
(TS and Python), the `kernelChallengeWidgetsPresent` and
`kernel_challenge_widgets_present` options, `DOMService.probe_captcha_widgets_present`,
and the compute-grants watcher probe. This deletes one CDP evaluate per Kernel
or Tilion poll and closes the TS/Python drift where only TS covered Tilion.
Both repro commands pass unchanged after the fix; the Python repro is
byte-identical. Sibling failures prevented: stealth-off Kernel, Tilion, and
unsupported challenge families no longer show a false "Auto-solving" claim.
Live-view users no longer see a spinner during real Kernel solves; they see the
terminal outcome. Behaviour at 10k agents: one fewer CDP Runtime.evaluate per
poll per Kernel or Tilion session, and no new shared state.

Golden reference: not applicable (no approval-gated hunk changed in source;
the effect on agent-visible DOM is reviewed by the parent).

Exact benchmark outcome: not runnable to green. anti-bot-proton-signup is
blocked by the missing Proton solver (see the related case). This fix removes
only the false signal. Outcome-proof gap retained.

Contract conflict (reported, not changed): the `drag` tool description
(agents/providers/rose/browser_use.py:95) says to use it for "CAPTCHA / 'Bot or
Not' slide-to-verify widgets". The challenge rule
(agents/utils/browser_auth_contract.py:22,32) and the `recover_from_challenge`
and `screenshot` descriptions (browser_use.py:247,493) say "Do not drag
sliders". Resolving this is a prompt change and needs approval.

## Human feedback

None recorded.

## Reusable lesson

Never let a heuristic (such as a widget being present) stand in for a provider's solver state in any model-visible indicator; show "solving" only on the provider's own in-flight evidence.
