---
id: 2026-10-01-persisted-kernel-proxy-tier-ignored-on-resume
date: 2026-10-01
title: Kernel resume recreated a mobile browser on a residential proxy
surface: back-end
component: browser-provider-kernel
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/browser/kernel.ts recreateKernelSession omitted the persisted proxyTier from createRemoteSession options
symptoms:
  - FAIL live Kernel provider parity
  - resume did not preserve the current mobile proxy tier and location
tags:
  - kernel
  - browser-provider
  - proxy-rotation
  - resume
sources:
  - commit a738ac963ec9c9b37fd9a154bdb90e3905c1fefb
repro: back-end/src/tests/blackbox/browser-provider.live.support.ts
status: fixed
---

## Problem

The live browser-provider blackbox rotated a Kernel session from residential to
mobile, paused it, and resumed the same task. The resume response failed the
comparison against the mobile proxy source and location; the assertion did not
capture which field differed. Rotation wrote `proxyTier=mobile` to the
task row, and resume did not overwrite that field. The pre-fix run in
`.context/test-runs/1790874645-92731-17880/` failed with
`resume did not preserve the current mobile proxy tier and location`. Its backend
log records rotation 2 with `proxyType=mobile` at 17:11:58 UTC, pause at 17:12:15,
and resume at 17:12:18. The run stopped at the metadata assertion before reaching
the remote proxy ID assertion. An earlier run used an invalid old assertion that
compared the resumed proxy ID to the initial residential ID after the test had
already rotated to mobile; its failure is not evidence for this defect. The logs
do not print the actual proxy source or ID; the failing metadata comparison and
code trace establish the boundary.

## Diagnosis

Critical path: `/rotate-proxy` selected mobile → `rotateKernelSession` stored
`proxyTier=mobile` → `/close` paused the browser → `/resume` called
`resumeKernelSession` → `recreateKernelSession` read the task but called
`createRemoteSession` without the stored tier → Kernel's default managed-proxy
selection began with residential. The first bad boundary was the recreation
call, before the response serializer. The deeper owned problem was that the
proxy type selected by rotation or challenge recovery was written on the task
row but not consumed by the shared lifecycle recreation path. Initial sessions
with a null tier still use their configured default. The code also has stored
ISP, direct, and exact geographic recovery modes that this live reproduction did
not exercise.

Archive searches used the literal resume assertion and the behavioral phrases
`Kernel mobile proxy resume residential proxy id` and
`proxyTier resume mobile residential Kernel`. No case had this first bad boundary;
this is a novel incident.

## Solution

`recreateKernelSession` now derives its remote proxy options from `proxyTier`
whenever rotation does not explicitly request a new type. It restores the
recorded managed type, exact recovery specificity, or direct mode; these sibling
modes are supported by the code path but were not verified by this live run.
Rotation's explicit type still wins. No per-agent cache or additional provider
request is added. At 10k agents, resume reads the same task row and uses the
recorded managed-proxy tier for rotated sessions. It does not guarantee a unique
exit IP or preserve an unrecorded resolved fallback specificity.

The unchanged local reproduction command, run before and after the fix, was:

```bash
python3 - <<'PY'
import os, subprocess
from pathlib import Path
key = next((line.split('=',1)[1].strip().strip('"\'') for line in Path('agents/.env').read_text().splitlines() if line.startswith('BROWSER_USE_API_KEY=')), None)
env = dict(os.environ, BROWSER_USE_API_KEY=key)
raise SystemExit(subprocess.call(['bash','back-end/scripts/run-blackbox-tests.sh','browser-provider'], env=env))
PY
```

It failed before the fix (`0 passed, 1 failed`) and passed after the fix
(`PASS browser-provider (95082ms); 1 passed, 0 failed`) in
`.context/test-runs/1790874856-47744-5830/`. The assertion was not relaxed.
After the fix, the live test reached and passed its remote Kernel proxy ID
assertion and the subsequent cross-provider rotation ladder.

## Human feedback

None recorded.

## Reusable lesson

Reapply the recorded rotation or recovery proxy tier when recreating a paused browser.
