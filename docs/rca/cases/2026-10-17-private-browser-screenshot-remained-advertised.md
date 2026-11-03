---
id: 2026-10-17-private-browser-screenshot-remained-advertised
date: 2026-10-17
title: Private browser screenshot remained advertised after capture became forbidden
surface: harness
component: browser-action-capability-continuity
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: _call_browser_use_with_rotation advertised screenshot despite the same DOMService secret_values_used policy forbidding its execution
symptoms:
  - Screenshot withheld because this browser contains private credentials
  - Observed tool failure spawn_browser_agent status ERROR despite later completed purchase
  - An action omitted from the actual request tools still normalizes for dispatch
tags:
  - browser-tools
  - credential-privacy
  - capability-consistency
  - model-output-validation
  - native-tool-lifecycle
sources:
  - commit e7fdc991fab067d1b1f0349c6c14f71d2bf8aafb
  - commit 7f6d3c23227f0e90417c2c0e07adac33399bf559
  - agent fdd61ebf-600b-4c34-aecc-6382f0f4d30e
  - agent ab570abc-77d9-40bd-ac9a-997824035b12
  - benchmark run 18619a22-fa17-4246-b3df-b6c2177f2bc5
  - plan:.context/auth-deploy/repair-native-original30-e7fdc99-20261017/signup-purchase-failure-rca/capability-owning-red/final-proof.json
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py private_raster_policy_matches_actual_advertised_browser_tools in the unapplied private candidate
status: open
---

## Problem

The unchanged e7 original30 `browser-auth-signup-purchase` recorded native
FAIL212.4s. Its runtime evaluator found a real child ERROR under
`spawn_browser_agent` call_U5GnS1r7gAjaAMsCJK7jJChd, despite the later completed
purchase. The global screenshot schema was still offered after the same browser
privacy owner made raster capture unavailable. The executor correctly denied it;
strict `no_tool_failures` correctly retained that failure. Neither is an error
to suppress or relabel. Task definitions, evaluators, expected behavior, deadlines,
models and budgets remain unchanged.

A second exact native instance is
`browser-auth-session-expires-at-checkout`, FAIL436.3s,
root ab570abc-77d9-40bd-ac9a-997824035b12. Screenshot call_2Bo0yOgG9tkycM8JPwIoSKOU
at step14 followed private password entry at step6. Its step15 TOOL result
reported the same privacy denial. Both original failures stay failures.

## Diagnosis

For signup-purchase, retained request
1792216363179-c4f6ab33ceb3-browser_use_step_17.json advertised screenshot among25
tools and returned the exact screenshot call with empty arguments. The next
step18 TOOL for that call reports `success:false` and the literal withheld error.
Worker line197916 at05:52:43.235644UTC publishes `Action screenshot failed`,
statusERROR, for child task a6fa800f-a7df-5cbb-a0fe-7200e6a51c22. The evaluator's
toolName is the browser action's persisted namespace, not proof of a failed
parent spawn. Actual business completion is counterevidence to a terminal crash:
the browser then commits the order, final verifier1792216376421 scores1.0,
and root status becomes COMPLETED at05:53:25.223904UTC. It does not erase the error.

The checkout-expiry decision1792216797684-372d529a88bc has the same offered
screenshot and private-entry history. Worker210364 at05:59:57.743467UTC records
its exact call/task bb68ff31-ff6e-5de2-9dc2-94a717c2bdc9 as ERROR. Its final browser
verifier also scores1.0; root COMPLETED at06:04:54.660285UTC remains counterevidence,
not a clean-tool verdict. The independent read-only finding is hash-bound at
`checkout-expiry-failure-rca/owning-boundary/finding.json` (f56dec4c prefix).

`service_actions._execute_screenshot`4238-43 denies raster when the authoritative
`DOMService.secret_values_used` is exactlyTrue. `mark_secret_used` is sticky and
its existing encrypted continuation restores it. This policy is correct.
However handler3002 passed static AVAILABLE_ACTIONS into the real client; its
native tool builder still advertised screenshot. Captured browser_state was
empty and the preceding transcript did not communicate this screenshot denial,
so page-text/snapshot heuristics cannot establish the execution policy.
Main decisions, auth rotations and notification forks use the same helper and
DOM owner. The simulated caller has no native DOM owner; no private state is
invented for it.

There is a sibling contract gap: even when a request explicitly offers only
read_browser_state, valid native or legacy JSON screenshot output previously
normalized for dispatch against the global catalog. Merely hiding one tool would
leave stale/unadvertised calls executable. The deeper owned class is consistency
between authoritative active capability, actual request grammar and accepted
completed response. It does not require a new privacy policy, task classifier,
state service or semantic prompt directive.

Two actual archive searches used `spawn_browser_agent status ERROR signup
purchase` and `browser purchase complete activity failed write lock`; a subsequent
literal privacy search and immutable-source grep identified the related
[credential/payment privacy case](2026-10-14-payment-fill-included-background-tabs.md).
Its Solution and Human feedback were reread for the final draft; the recheck
searches were `Screenshot withheld private credentials capability tools` and
`offered unavailable action native response restricted allowlist`. They require
ordinary model-chosen placeholder entry
and raster withholding after private entry. That guard held here; this is a
new advertisement/acceptance boundary relative, not evidence to weaken it or
rewrite the earlier case as fixed. The prior evaluate-recovery strict-error
case is a symptom relative, not this screenshot cause.

## Solution

The private candidate copies the existing action allowlist and excludes screenshot
only when the same DOM privacy bit forbids capture. Public/default/no-owner
behavior and every other action remain unchanged. The global schema/catalog and
executor denial remain intact. This does not restrict which ordinary tools can
resolve private credentials: evaluate, text, keys and every other permitted
entry action keep the user-directed all-tool resolution contract. The client then checks the canonical actual first
native provider call against actual built request tools, or the canonical
selected legacy action. It uses the existing completed-model-output validation,
privacy, accounting, dump and feedback owner; it never fabricates an execution,
FINISHED status, human requirement or replacement for the original childERROR.

The first private implementation checked the normalized implementation action,
which rejected the existing printable press_key batch normalized into input_text
when only press_key was advertised. A real registered regression reproduced
that defect. The corrected implementation reuses the existing single-call
normalizer for declared first-call identity. Existing aliases, printable batch
coalescing and historical mixed/stateful first-call behavior remain unchanged.
No copied alias classifier or special screenshot success path was introduced.

Exact patch5358e19373cb0e2ee4bc489691e9e09ea114ac49c83c6d4a2063bac40af71a0b is
based on private404e40cc tree (explicit7f6 plus the separately reviewed task-scoped
park measurement code). Only handler/client have runtime changes. Registered
new fixtures use actual DOM privacy state, real handler/client and BOTH actual
Anthropic/Responses request builders; final collect/provider edges are fake.
The before-code three owning assertions failed. Exact final controls on the
original runtime are4FAIL1PASS; same final controls on candidate5PASS0FAIL.
Normal public tools remain25 and private tools24. Restored privacy, independent
public session, global/default tools, actual private execute_action denial with
provider capture never called, typed args, cancellation, Seal, real transport
identity, notification fork locality/cache/AUTO, aliases and mixed batches pass.

Frozen full owning results: Rose99/0, handoff15/0, auth20/0 and browser809/0;
all exit0, browser129.09s. Structural4/0 exit0. All original3354browser,
441Rose and137auth assertion ASTs are identical; payment, catalog, evidence-layer
and park measurement bytes are retained. Physical private _test_utils/handler/
client/DOM imports are asserted. Independent source peer accepted exact5358;
it did not execute tests. Seven nonowned PythonDNS attempts were denied; three
owned loopback ports closed. No provider/model/API/DB/native calls were made by
these tests. Chromium OS background egress was not independently instrumented.
Actual module/receipt hashes are in final-proof.json SHA
5e74fb0bf49eae8b3fb790abd86b97315c6ab7922caa3e661974d48512b06e72.

The exact local command uses the existing read-only donorvenv with
PYTHONDONTWRITEBYTECODE=1 from the physical private source/agents directory:
`python <packet>/run-registered-final-selected.py` before/after,
`python <packet>/run-full-final.py`, and
`python tests/structural/structural.py`. All owned commands joined normally.
Setup attempts (registrar variable and fake wait seconds rather than real time_ms),
all owning REDs and the derived-action predecessor failure remain in their logs.
Selected launcher wording FULL_DOMAIN is historical; only the separate full
runner proves the complete domain totals. Dict-return runner counts were
independently checked, not inferred from dictionary truthiness.

At10kagents the change adds a copied25-name list and bounded local first-call
parse/validation. It adds no network operation, global state, browser allocation,
polling or resume schema. No actual token/cost or model-choice comparison was
run. Static generic screenshot advice remains: there is no whole-input/prompt/
cache parity claim. Private request tools and unavailable-response handling do
change effective inputs. AUTO, models, MAX5 genuine API failures, MAX250 decision
bound, retry clocks and notification attempt count are unchanged. A private-state
race or out-of-band direct execution can still hit the truthful executor guard;
this is not universal race/replay elimination. Repeated invalid outputs can still
exhaust existing bounds.

The parent's terminal card reports the original30 result as27PASS/3FAIL, with
failed subset in original order: all-options assistance, signup-purchase and
session-expires-at-checkout. That card is not independently attested controller,
resource-cleanup, publication or post-fix evidence in this draft.

The case remains OPEN: both native failures and all earlier attempts are retained;
no unchanged canonical native after-run has passed this candidate. The local
mechanism proof is not task outcome, full G3, integration or deployment proof.
The separate last-served/park measurement failure has its own diagnosis and case.
No terminal-promotion prototype, evaluator exemption or deadline change is adopted.

## Human feedback

The user instructed: "dont ask me to aprove prompt changes unless they prove it passes, u only need approval at the deploy step". This authorizes private engineering and proof; it is not deployment approval or permission to weaken validators.

The parent required preserving the privacy guard and every genuine childERROR;
fixing capability continuity must not launder terminal/status outcomes. The parent
also required preserving real printable-key normalization and BOTH provider
transforms. The derived-action predecessor was rejected and corrected with the
same registered failure. Freedom and protected instructions remain untouched.

## Reusable lesson

Derive offered capabilities from their execution owner and validate completed actions against the actual request grammar while preserving existing normalization semantics.
