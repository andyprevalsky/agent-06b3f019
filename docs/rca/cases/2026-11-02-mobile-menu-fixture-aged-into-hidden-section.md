---
id: 2026-11-02-mobile-menu-fixture-aged-into-hidden-section
date: 2026-11-02
title: Fixed completed-agent timestamps aged the mobile menu fixture into the intentional old-agent section
surface: front-end
component: mobile-pwa-chrome-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: mobile-pwa-chrome.blackbox.tsx makeAgent used a fixed October 27 updated_at with a real November 2 sidebar clock
symptoms:
  - 'Unable to find an element by: [data-testid="rose-agent-row-row-1"]'
  - mobile-pwa-chrome.blackbox.tsx four menu longpress and rename tests fail
  - frontend coverage 250 files 4062 tests passed and one file four tests failed
tags:
  - front-end
  - mobile
  - fixture
  - clock
  - old-agents
sources:
  - commit 05449cd2d44b879ec883cfd24aa2a9430da8a811
  - plan:.context/deploy-runs/20261102-pr1634-approved/g3/logs/frontend-coverage-blackbox.log
repro: front-end/src/tests/blackbox/mobile-pwa-chrome.blackbox.tsx
status: fixed
---

## Problem

Four existing mobile drawer menu/longpress/Rename cases could not find row-1.
The original full coverage log is preserved byte-for-byte in the artifact packet,
SHA256 e37512c1cb727e3e892caa48c5e44098679abc8f7c00ed22adbf9fa341054b85.
The printed DOM stops during New project because Testing Library truncates it;
that excerpt alone does not establish that Home or the old-agent control is absent.

## Diagnosis

Critical path: makeAgent → TerminalHeader → MobileAgentDrawer → sidebar search
→ RoseMobileAgentList → grouping into Home → RoseAgentGroups → splitOldAgents
→ isOldAgent → hidden old row → lookup fails before the menu interaction.

The fixture supplies COMPLETED, unpinned, unselected row-1 with updated_at
2026-10-27T00:00:00Z. The sidebar intentionally hides done agents last active
more than four days ago. The actual helper probe measured age 583205310ms
against cutoff 345600000ms and classified this fixture old. The same helper
classified recent, exactly-four-day, running, pinned and selected controls as
not old, and one millisecond past the cutoff as old. No project scope was bypassed:
missing project_id still takes the normal Home grouping path.

Deepest proven owned cause: the menu fixture encoded a calendar date rather
than its necessary relative recency. As wall time advanced, its initial visible
state ceased to match its menu assertions. The documented old-agent policy is
intentional and is the stopping boundary; altering it would repair the wrong layer.

Archive literal search: rose-agent-row-row-1|mobile-pwa-chrome|mobile-agent-list.
Behavior search: mobile.*(folder|project|agent)|scope.*sidebar|project.*agent.*list.
The prior PWA geometry and mobile poll-unmount cases are relatives with different
first-bad boundaries. Their Solution and Human feedback were read; this is not
proof of either product defect recurring. The review-budget clock case is also
a relative involving fixture dependence on host time.

## Solution

Artifact-only candidate: derive one fresh ISO timestamp inside makeAgent and
use it for created_at and updated_at, retaining all fixture overrides. This
removes the expiring calendar assumption for every consumer of this helper.
No runtime code, grouping, assertions, timeout or threshold changes. No fake
list, pin, selected-agent exemption or old-agent-policy bypass.

Exact owning command, private front-end cwd, both sides:
`/home/boxes/rose/node_modules/.bin/vitest run src/tests/blackbox/mobile-pwa-chrome.blackbox.tsx --maxWorkers=1`
with NODE_OPTIONS=--max-old-space-size=2300.
Before: exit1, four failures and twelve passes, outer monotonic45.341907s.
After: exit0, sixteen passes, outer monotonic25.740087s.
All68 assertion statements and16 test names have identical normalized payload
hash2dc25c847315bc451604287322b392646c488dd746adb6a148673aba76e610c0.
An initial omitted attention-scope import produced zero tests; its22.269586s
setup failure is retained separately and receives no causal-proof credit.

Patch SHA256 ffbc84e7097a8d7c0505dd93c7a6d97ff9374e1abae8f4da063904c88a6f0599.
The existing test is already discovered by the Vitest blackbox glob and deploy
Step4b coverage command. Existing old-agent tests pin Date and preserve policy
boundary coverage; inspected, not rerun. Golden reference: not applicable
(no approval-gated hunk). No additional runtime work at10000 agents.

OPEN pending parent application, archive integration/validation and affected
full gates. The root remains clean at05449; no release/deploy-green claim.
No child review was created under the user's explicit prohibition. Local
adversarial checks verified assertion identity, source hashes and normal scope.
The isolated workspace used source/dependency symlinks and a private Vite cache,
but the Vite bundled config loader briefly wrote and removed generated config
files in shared node_modules/.vite-temp. This isolation exception is preserved;
strict filesystem read-only isolation is not claimed. No package source was changed.

## Human feedback

The user required artifact-only work while root05449 is frozen and G3 agents
are active; one bounded focused file, one worker, heap2300, no providers/DB/live
browser or extra agents, unchanged assertions/timeouts/thresholds, and parent
application only after all G3 terminal. Freedom must remain preserved.

## Reusable lesson

Express a visible recent-agent fixture relative to the test clock instead of allowing its calendar timestamp to expire into an intentionally hidden section.


Integrated validation on 2026-11-02: backend typecheck and scoped lint passed; mobile owning suite passed all 16 tests; the full run-deploy-pipeline owning regression suite passed after both fixture-input repairs. Full release gates and production verification remain separate requirements. Original failures and focused evidence are retained under `/project/rose-speed-comparison-20261028/`.
