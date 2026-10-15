---
id: 2026-10-14-payment-fill-included-background-tabs
date: 2026-10-14
title: Payment autofill wrote into a background checkout while reporting success on the active login page
surface: agents
component: browser-payment-fill
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/service_actions.py _iter_payment_fill_targets accepted every get_all_frames target without proving ancestry under the focused page
symptoms:
  - Auto-filled payment refs on handoff page
  - Built secret refs for type interception
  - Cross-origin handoff page
  - Submit the payment form on THIS page now.
  - approved payment-card fill changed the background checkout while the login tab was focused
tags:
  - payment-card
  - browser-agent
  - oopif
  - tab-ownership
  - agentcard
sources:
  - agent 389d96c6-4c8b-4729-a201-bbc73499f662
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_payment_ref_fill_isolated_to_focused_page_and_child_frames
status: open
---

## Problem

The user asked why card credentials were not returned while upgrading a newly
created ChatGPT account. The checkout amount was $500. The root is an ordinary
production agent (`isBenchmark=false`), archived at 17:57 UTC on October 14.
All 916 database messages, both approval-window worker logs and original
encrypted browser-resume artifacts were inspected. Private evidence stays in
the workspace; real passwords, PANs, cookie values and signed headers are not
fixtures in this case.

Credentials actually reached the browser. At 15:35:25.981012 and
16:30:40.026281 the worker logged `Browser payment card minted` with
`card_id=rose-agent-card-static`, last four 1372. Both resumed activities logged
`Built secret refs for type interception` with `card_refs_count=4`. Raw values
are intentionally held privately; the model receives `card_number`,
`card_name`, `card_expiry`, `card_cvv` reference names and a last-four summary.

In the second resume, successful PAN/expiry/CVV fills were logged against
CDP target 3C39EDD5B156 while the handler's current URL was the
platform.openai.com login page reached from a synthetic origin-storage URL.
At 16:31:16.875209 the handler logged successful autofill on
`handoff_host=platform.openai.com`. Its injected message attributed the fill to
that login page and instructed submission there. At 16:31:21 the browser
identified the mismatch: checkout was in another tab. The later return to
checkout observed `/auth/logout`.

## Diagnosis

Critical path: approval -> backend card result -> private resume card refs ->
semantic browser fill target discovery -> field mutation -> success result ->
current-page handoff message -> browser's next action.

The private card result is correct. The first proven incorrect owned boundary
is target discovery: browser-use `get_all_frames()` enumerates all top-level
page targets when cross-origin iframe support is enabled. Rose treated that
inventory as the current page's frame tree, so a matching field on another tab
was eligible for mutation. The result retained only filled reference names,
and the handoff handler attributed them to the current URL. The deepest proven
gap is missing page ownership when admitting frame targets, not missing card
credentials or model capability.

The real-Chromium permanent test focuses a login page and exposes a separate
checkout with an actual cross-site OOPIF plus an unrelated payment tab. It uses
real CDP frame ownership and production fill JavaScript. Before the repair it
changed the background PAN field to a synthetic test number and returned
success. It also covers an orphan iframe whose parent is absent, and verifies
the legitimate focused checkout's OOPIF remains fillable via CDP afterward.

Initial identical reproduction command (from `agents/`):

```bash
/usr/bin/time -p venv/bin/python -c 'import asyncio, runpy, sys; sys.path.insert(0, "tests/blackbox"); asyncio.run(runpy.run_path("tests/blackbox/spawn_browser_agent_v3.blackbox.py")["test_payment_ref_fill_isolated_to_focused_page_and_child_frames"]())'
```

Pre-fix: exit 1, 1.87 seconds, `AssertionError: approved payment-card fill
changed the background checkout while the login tab was focused; background
value length=16, reported success=True`. Post-fix: exit 0, 2.82 seconds, both
background/orphan checks passed and the legitimate payment field filled. The
test was subsequently strengthened to require CDP for the positive case;
separate final-test baseline/current artifacts preserve that stronger proof.

The final unchanged test was also run with the original helper compiled from
`git show b784977b0bf699c56bc67b063ae849a9cf5150fb:agents/domains/spawn_browser_agent_v3/service_actions.py`, then
with the repaired helper, through the identical command
`cd agents && /usr/bin/time -p venv/bin/python ../.context/run-payment-fill-repro.py`.
The scratch runner replaces only `_iter_payment_fill_targets` with the selected
source snapshot and invokes the permanent test. Baseline: the same assertion,
exit 1, 1.94 seconds. Repair: exit 0, 2.07 seconds, with valid CDP filling.
Both runs record the same test SHA-256
`d0200d5b29c74280d208fa35bd9b6a12f246b13dc5eafbcf2ebed03d48a0f5c3`.
Thus the strengthened positive assertion was not substituted for causal proof.

Archive searches: `payment_card_ready secret refs card_number card_expiry
card_cvv`; `card credentials missing browser resume payment handoff`; and
`cookie bundle re-injection overwrites new login browser realm switch`.
Related cases are the October 2 shadow-index fill and October 3 empty-selector
resume cases. Neither diagnosed admission of unrelated top-level frame targets;
this is a relative, not a proven recurrence.

Golden reference: OpenClaw's
`extensions/browser/src/browser/pw-tools-core.interactions.actions.ts:252`
types through a locator on the selected target, while `:228` resolves native
insertion through `getPageForTargetId`. Hermes
`tools/browser_tool.py:1126` binds evaluation to a concrete tab ID. Searches of
Claude Code and Codex browser/iframe/fill references did not find an analogous
payment-frame subsystem. Restricting our CDP inventory converges on target
binding rather than merchant-specific filters.

Coverage/routing distinction: the canonical production env reader returned
`AGENTCARD_MINT_ENABLED = false`. Ordinary traffic therefore used the shared
company-funded Brex card, whose metadata cap is $50/week, for this $500 request.
Benchmark agents explicitly bypass the cutoff and exercise real AgentCard.
The production abandonment gate last passed October 13 at 23:02 UTC, but it
asserts readiness and financial compensation, not checkout field delivery.
Old CDP tests supplied a single frame without competing page ownership; the
handoff test inspected source strings. These coverage gaps cannot be repaired
by claiming the live lifecycle test proves all checkout handoffs.

Scope limits: this test proves the background CDP fill and false current-page
attribution mechanism. It does not prove why the first browser lost checkout
after a ten-hour approval wait, why a storage/login tab became current, or why
the later checkout lost authentication. Those are unresolved observations.
Changing providers would not fix target discovery. Caller-supplied Playwright
page binding and focus changes during an action remain separate contracts.

## Solution

Target discovery now builds parent-frame adjacency, starts at roots matching
`session.agent_focus_target_id`, and admits only reachable descendants before
opening CDP sessions. Unrelated roots and orphaned frames stay excluded.
Existing caller-bound Playwright filling and valid cross-origin descendants
are preserved. No prompt, trajectory injection, timeout, provider routing,
production setting or real card configuration was changed.

This unifies CDP discovery around one page-ownership invariant. Deleting CDP
iframe support would break legitimate hosted widgets; ownership cannot be
inferred from a matching merchant hostname or field name. The repair also
prevents unrelated payment-tab mutation and detached/orphan-frame admission.
At 10,000 agents it adds only per-session O(frames) adjacency and iterative
traversal, with no shared state or additional browser/database/network calls.

The existing `spawn-browser-agent-v3` blackbox domain discovers the registered
test. Its full official runner passed 690 cases in 55.53 seconds (exit 0).
Deploy Step 4g executes that runner under agent coverage for changes to this
production surface. Two old CDP fixtures gained realistic focused-root and
parent metadata without weakening their assertions. Independent adversarial
review passed the narrowly stated diagnosis and repair.

The narrow CDP ownership repair was merged by
[PR #1512](https://github.com/Rose-Ai-Labs/rose/pull/1512) at
`1d77217cbe8136029400cc794cd7386039024c19`. Production verification confirmed
Fly generation `274914954ab9 → be53b25fc65a`, zero forced migrations, retirement
of all eight old machines, and 45/45 cold migration assertions including fixture
cleanup. Vercel's production alias and signed/notarized Mac release `v1.1.218`
were verified against that merge. The explicit production semantic workflow
[38634981287](https://github.com/Rose-Ai-Labs/rose/actions/runs/38634981287)
passed six UI tests (two existing local-fixture guards) and all five latency
tests/20 lifecycle samples; all four paths had smoothness 1.000. Local semantics
separately passed all eight UI tests, including the local-only login and browser
control fixtures.

The broader deployment remains incomplete because its separate strict $1 live
AgentCard abandonment task failed after 580.9 seconds. The card closed with
zero balance, but the same live organization transfer remained consumed with
100 cents transferred and zero released; Stripe refund is behind that release
boundary. The original failure and cleanup failure are retained, and recovery
is confined to idempotent reconciliation of that same allocation. The ongoing
financial state and exact receipts are tracked in the deployment evidence and
the existing [AgentCard release case](2026-10-02-agentcard-abandonment-closed-card-transfer-never-released.md).

This case stays open for the unresolved checkout and authentication
observations; the original purchase has not been replayed or proven to
complete. The documented production mint cutoff remains unchanged. Changing that
configuration requires explicit approval.

The user-directed follow-up removes automatic payment entry completely. The
agent now chooses an ordinary action and target for each field. A shared action
boundary copies the model's arguments, resolves explicit `{{secret:<ref>}}`
placeholders privately in every browser tool, and safely escapes JavaScript
literals. Legacy whole-value references remain accepted for paused tasks.
The shared boundary masks all four card values and password bindings in results,
history, and errors. Activity-scoped logging also covers already-running browser
event handlers, and retained prior-realm bindings protect later observations.
Private resume bindings always use verified encrypted storage. Screenshots and
media are withheld after private entry because text masking cannot validate
raster contents. Trusted routing and geometry remain exact; page-controlled
readbacks are still redacted. This implements the requested credential contract
without selecting fields or injecting fabricated progress messages.

Three permanent public-dispatch regressions cover ordinary text/key/evaluate
resolution without mutating model arguments, all-card result/history/error
redaction, and real Chromium field/tab selection with hostile JavaScript
literal values. The same final tests fail on the pinned pre-change
`32947aee57006a63d9232f77daf7725af70f32ff` source and pass with the follow-up.
Additional owning-domain tests cover the absence of handoff mutation before the
model's first decision, formatted and serialized readbacks, prior-realm secrets,
prestarted browser-event logging, numeric metadata collisions, password origins,
and encrypted resume failures. The new archive searches were `secret_refs
evaluate input_text runtime replacement` and `autofill payment handoff automatic
secrets model`; this is a deeper repair to the same incident following explicit
human feedback, rather than a separate incident.

The pre-review public regressions use test-file SHA-256
`1c4d5aab20b7fc262613d70ae40751411bcc154440d80ca7b4c2491f909e5f2e`:
the pinned baseline fails all three in 1.790 seconds, while the repaired source
passes all three in 1.890 seconds. Independent review also found a literal
credential error could bypass ordinary results through credential-outcome
classification and the Temporal failure delivered to the parent model. The
unchanged full-activity regression fails against `235ff2cd6` in 0.570 seconds
and passes with the additional boundary repair in 0.611 seconds. Propagation
requests, responses, and diagnostics now redact private values, and sanitized
Temporal failures retain their type and retry policy without retaining a raw
cause chain. Activity-scoped fallback redaction also covers private hydration
before DOM binding and errors raised during cleanup.
The logging policy also preserves trusted agent/session/workflow identifiers:
a synthetic CVV matching digits in an agent UUID previously detached its logs
from their owner. The unchanged owning credential test fails against `66bd51637`
and passes after preserving only those identity fields; nested payloads and
exception text still redact the same digits.


PR review found three additional contract edges. JavaScript literals naming
card fields are selectors unless they contain explicit opaque references;
legacy `pwd:` literals remain unambiguous. Purely numeric secret forms now
match complete digit sequences, preserving a DOM index such as `[1234]` when
the synthetic CVV is `234`, while still redacting `cvv234`, the exact numeric
value, and encoded echoes. Non-numeric short passwords retain substring
masking. Browser routing uses a private observed URL, independently of the
redacted URL presented to the model, including when replaying an approved
write action. Finally, the activity recognizes the advertised
`{{secret:pwd:new}}` form when saving a successfully entered minted password.
The unchanged full-activity persistence regression fails before that guard
repair in 1.253 seconds and passes after it in 0.771 seconds. Registered owning
credential regressions separately reproduce selector corruption, numeric
collisions, and loss of the private URL across approved-action preparation.
The requested all-tool resolution contract remains in place; restricting entry
to an action allowlist would contradict the explicit human instruction and
would not establish network-egress isolation for JavaScript evaluation.

The combined coverage run also exposed a false positive in the new history
assertions: they stringified the private `dom_service` dependency, including
arbitrary mock memory addresses. Those digits are not serialized into an
`ActionHistoryEntry`. A deterministic private metadata value of `17390`
reproduces both failures with the synthetic CVV `739`; the assertions now
exclude only that dependency, verify its object identity separately, and still
inspect every supplied history payload field, returned value, and error/log
argument. The three public-dispatch regressions pass in 1.308 seconds with that
collision present. Runtime masking is unchanged by this test correction.
The final test file has SHA-256
`928b285a618c15e581f315681a373eb72843eafbf01d0684aa05f853b5082c56`;
all three unchanged public-dispatch tests still fail on pinned baseline
`32947aee57006a63d9232f77daf7725af70f32ff` in 1.846 seconds and pass on the
repaired source in 2.082 seconds.

### 2026-10-15: minted-password persistence across ordinary tools

A focused audit of frozen `ca2a9fa6446a67b6753b34662ce7534efa0ea657`
(runtime surface `c3a63eeb954c`) reproduced successful private `evaluate`
execution with zero minted-password save calls. Archive searches were
`minted password evaluate persistence` and
`credential input_text only save minted account password`. The searches,
`git log --all` and source inspection found the earlier canonical-reference
repair, but no general successful-use persistence mechanism. Completed plans
`browser-auth-credential-model`, `rotate-ip-tool` and `agentcard-integration`
were checked for the credential, dispatch and target-ownership contracts.
This is a relative extension of this case's all-tool credential contract;
it does not establish another failure of the original merchant checkout.

Critical path: advertised minted reference -> shared parameter/JavaScript
resolver -> authorized native action -> action success -> minted-password
save. The resolver already knew which registered references it actually
consumed. The first incorrect boundary was the activity's save condition:
it inspected only an `input_text` action's raw `text` value. Successful
`evaluate` and other ordinary tools therefore never reached persistence.

The public dispatcher now reports successful consumed reference names through
an optional private per-action set. That set is cleared on entry and populated
only after successful execution, never added to a tool result, history or model
metadata. The activity's existing common action wrapper creates a new set for
each invocation and saves the minted password when that exact reference was
consumed. It captures the authorized source URL before execution: navigation
or realm refresh must not save the old realm's password under the new realm.
The existing idempotent backend save and warning-only save failure behavior
remain; success means credential use, not confirmed account creation.
There is no tool allowlist, field selection, raw-substring classifier, prompt,
schema, timeout, provider or trajectory change.

The existing permanently registered
`test_activity_saves_minted_password_after_canonical_or_legacy_entry` now runs
actual public dispatch and resolution, replacing its former mocked dispatcher.
It preserves canonical and legacy input cases and exercises JavaScript entry
and ordinary navigation. Controls cover ordinary text, another registered
password, unresolved references, JavaScript comments, a CDP JavaScript failure,
a native typing failure, and password-origin denial. All browser/provider,
model and persistence transports are synthetic; no live signup is claimed.
The common realm fixture's existing redirect, privacy, assistance and fatal
error checks also pass unchanged.

Exact red/green command, from the isolated repair checkout:

```bash
PYTHONDONTWRITEBYTECODE=1 /home/boxes/rose/.context/deploy-private-browser-credentials/agents/venv/bin/python -B .context/run-minted-password-regression.py
```

The runner invokes the checked-in registered test directly using synthetic
configuration and the existing Temporal activity environment. Final unchanged
test-file SHA-256:
`096980e9bca0f9ced85d06a80ece3a792bd25dad1f556406b71efff6684ab9c2`.
On the frozen buggy runtime: exit 1, test wall time 1.554 seconds,
`minted password persistence mismatch: action=evaluate, should_save=True, failure=False, denied=False, saves=[]`.
On the repair: exit 0, `REGRESSION PASS wall_s 2.358`.
These test wall clocks exclude module import. Original and final red/green
logs are preserved in the repair checkout's ignored `.context` directory.
Fourteen relevant existing credential/realm blackbox checks pass in 3.467
seconds through `.context/run-minted-password-focused.py`. The original copied
synthetic scratch reproduction also passes in 3.892 seconds, reporting
`PRIVATE_EVALUATE_EXECUTION_CONFIRMED=True` and `MINTED_PASSWORD_SAVE_CALLS=1`.
Its modified-fixture-source technique remains supplemental only; the permanent
test uses normal fixture parameters and no source execution.

Registration remains in `spawn_browser_agent_v3.blackbox.py::run_all_tests`,
which `run_blackbox_tests.py` discovers as `spawn-browser-agent-v3` and the
existing agent coverage/deploy lane invokes. Full coverage and deploy gates
are parent-owned after integration; they were deliberately not rerun here.
At 10,000 agents this adds one short-lived set per active action, containing
reference names only, with no shared state, lock, subscription or periodic
query. Only successful minted-reference use invokes the existing idempotent
save once; unrelated, failed and denied actions add zero persistence requests.

## Human feedback

The user rejected the automatic payment-entry layer after the narrow tab
ownership repair shipped. Their intended contract is ordinary agent-selected
credential entry: the model receives obfuscated references, and the harness
privately replaces them in any chosen browser tool, including JavaScript
evaluation. The model must never receive the underlying credential values.

This feedback changes the repair scope. Restricting automatic discovery to the
focused page fixes one ownership bug but preserves the unwanted automatic
actions. The follow-up removes the synthetic fill, retries, multi-field fill,
and fabricated submit-this-page message. It moves resolution and output
redaction to the shared action boundary, preserving the agent's chosen target.
New observations also cover all four card fields, errors, history, earlier
realm credentials, and secret-bearing screenshots. The original checkout loss
and authentication observations remain unresolved.

## Final verification stabilization

Verification stabilization (2026-10-15): the second automated review found two masking transport defects. Registered numeric credentials could corrupt otherwise permitted PNG base64 before private entry and replace numeric targets in prior assistant tool calls. Both owning registered regressions failed unchanged before repair, then passed after cfa726852 (PNG 0.058s; prior target 0.091s). Only trusted screenshot action output transport and recognized action-schema numeric target metadata are restored; page text, nested/evaluate result data remain redacted, and media remains withheld after private entry. Nine neighboring credential cases and the full agent coverage gate passed. These repairs do not establish the original merchant/auth checkout loss or change the separate auth-decline exception into a passing verdict.

The complete final-runtime verification passed agent/backend coverage, all twelve controller commands, live probes, eight UI checks, the real E2B smoke, ten effective smoke tasks, all four sandbox card lifecycles without skips, and all five latency tests. Only the separate auth-decline smoke case was excluded under the specific one-release user exception; its earlier native failures remain failures. All fourteen current benchmark roots have fresh canonical FE/recording and latest-whole-tree-call HTTPS evidence. Exact-owned test processes, ports and isolated databases retired; current-campaign payment cleanup is clear. This does not settle older release follow-ups or establish an original-merchant checkout repair.

## Reusable lesson

Keep private credential resolution independent of the agent's tool and target choice. A credential reference must never trigger unrequested field selection, additional writes, or fabricated progress. Redact every downstream model boundary, including observations and fatal failures.
