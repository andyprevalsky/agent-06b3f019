---
id: 2026-11-02-cloud-smoke-admitted-inconsistent-provider-contract
date: 2026-11-02
title: Mandatory cloud smoke admitted an inconsistent injected provider contract
surface: infra
component: cloudbench-provider-contract
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The preflight equated independent backend session-default and worker fallback authorities, then passed one backend marker to both guest checks
symptoms:
  - "FATAL: benchmark worker env does not match production: local=kernel prod=tilion"
  - "FATAL: production browser provider drift: backend=tilion worker=kernel"
  - "infra canary preflight FAILED (exit=1)"
tags:
  - cloudbench
  - smoke
  - environment
  - provider-parity
sources:
  - PR #1662
  - commit bf92cbd98ab436af20f9a8d647c32e748c67e93a
  - commit c13dc65fa03083ac6c4490f0c572ae21c439f8da
  - fleet run 20261102-223815-205225
  - task c4e854294a2a469a8b86566800350e2c
repro: /var/tmp/pr1662-c13-provider-env-rca/validator-proof.json and base-head-authority-control.json
status: open
---

## Problem

The c13 focused smoke request e9b5ca1b6f094b909065f3f3645f5038 selected all17 original checks. Native campaign cd414120063b1646c24f9674044b4d06557f8417a52dc513afeb6329de0eeb4b completed PG15 seed preflight and one dependency refresh;15 sibling controllers explicitly reused its verified snapshot. The new failure was j0005's native N2 infrastructure canary, run20261102-223815-205225. Both canary guests verified checkout c13 and injected env digests (agents892f4393e0e2, backendf93cd450921b), then failed worker kernel versus expected marker tilion before stack or task execution. Both exited1 with cleanup_ack1. Campaign stopped on one confirmed infra job of original17 at22:47:18.091466Z;15 started siblings received TERM143 and the seventeenth never started. Every original smoke outcome remains UNVERIFIED.

## Diagnosis

The original native canary checks checkout c13 and injected digests, then passes CLOUDBENCH_BROWSER_PROVIDER twice into cloudbench_validate_browser_provider_contract. Its prod=tilion text names one injected backend expectation marker, not an independent worker authority. The controller validator also required prod_backend == prod_worker. Both checks conflate separate production roles.

Runtime source proves why the distinct values are valid: agents/domains/spawn_browser_agent_v3/repo.py init_browser_session sends user/agent/start/task fields to backend without a provider override; the backend chooses its configured default, returns provider metadata, and worker browser logic consumes that per-session provider rather than choosing the provider from the worker fallback. The inspected normal route needs the Tilion vendor key in backend, not workers. Production Render tilion and Fly kernel fallback therefore do not establish an inconsistent session-selection contract. The previous production-drift diagnosis and all-tilion operational proposal are withdrawn; original measured values and reports remain preserved as evidence of distinct roles.

Native read at22:51:52Z returned Render tilion and production Fly config kernel, both exit0 without fallback. One parent-authorized exact started production worker811d190a176358 printed effective kernel at22:57:00Z. These observations are retained with their timing/single-worker limits; they are not a reason to mutate production. A later names-only app listing found BROWSER_PROVIDER present and TILION_API_KEY absent; this is only the inspected secret-name listing, not an audit of every effective worker environment, and does not establish a missing runtime key on the backend-owned vendor-key path.

The five native route/helper sources are byte-identical bf92->c13. The invalid equality check was already present. Gate: NOT_INTRODUCED for the native equality and double-backend-marker defect, established by identical before-source code and the same valid distinct-surface reproduction failing on bf92 and c13. Gate: INTRODUCED remains scoped to the newly mandatory cloud integration exposing this unprepared contract boundary: bf92 documented a local smoke default while PR1662's template forces cloud and its binding. No claim is made that PR1662 changed production values or created the historical equality assertion. Independent attribution review retains that distinction.

Identical new owning regressions execute the actual helper and native --refresh-secrets CLI against private, captured-shape authority fixtures with no live network. On c13, the correct Tilion/backend and Kernel/worker pair is rejected before staging. The private candidate accepts that same pair, stages distinct markers, preserves full blob digests and guest Temporal isolation, updates only stopped warm/declared stopped pool targets, and skips active pool targets. Wrong backend, wrong worker, missing/invalid authority, absent marker and absent backend Tilion key remain refused. Production authorization failure now fails closed instead of allowing a local backend file to become its own authority. The backend/session marker remains Tilion and capacity code is unchanged. No original task definition, evaluator, per-task assertion, timeout, concurrency or threshold changes.

Cleanup remains the original measured outcome: one infra-canary failure,15 started sibling cancellations and one unstarted row; all17 smoke UNVERIFIED. All16 controller PIDs are absent in recorded local inspection. Native N2 sealed teardown records both created machine pairs and the failed-attempt volume as destroyed-provider-retained, not exact absence; both guests acknowledged cleanup, and the viewer remains retained-exact-owner-transfer-required. Original cleanup_completefalse and lingering_grouptrue are not rewritten.

Archive searches used the literal worker-env error and cloud provider environment secret parity preflight. PATH preparation and shared-preflight ordering cases are relatives, not causal substitutes. Golden reference: not applicable (no approval-gated runtime/prompt/schema hunk proposed).

## Solution

OPEN pending deployed execution: private candidate supplies independently verified backend-default and worker-fallback markers through explicit staging, required secret names, manifest fields and all three guest contract calls. Each local env is compared to its own production role, while valid provider enumeration, wrong-value refusal, backend Tilion-key enforcement and source-authority independence remain strict. It removes the false cross-role equality without weakening per-surface parity. The old marker remains the backend/session selection and capacity marker; no production configuration flip is needed.

The parent integrates the reviewed private patch and runs unchanged explicit --refresh-secrets under the existing controller/app-env locks at a safe terminal/stopped-warm boundary. Native transaction still stages full blobs/digests/GitHub token/guest namespace, activates stopped owned targets with --skip-start, and allocates nothing. The added marker must be present before any subsequent run. Native N2 and all17 original smoke tasks remain execution-required on the final frozen source; private diagnostics are not task passes or waivers. No live staging, source edits in the parent, provider sessions, production writes or retries were executed by this investigator.

## Human feedback

The user retains source/deployment ownership in the parent, requires Freedom preservation, and prohibits independent full gates or assertion/budget waivers. The parent prohibited shared/global env changes, production writes, provider retries and allocations in this investigation, and requested exact native cleanup plus a private repair/preparation packet. After source review, the parent withdrew the unnecessary production-flip question and explicitly requested separate per-surface parity markers with no original task/assertion/budget changes.

## Reusable lesson

Compare each environment value to the production surface that owns its meaning, and carry independent authorities independently through staging and guest validation.
