---
id: 2026-10-06-semantic-deploy-amplitude-probe-failure-dropped-its-output
date: 2026-10-06
title: The semantic-deploy live Amplitude contract check invoked broken npx and dropped the fail-closed credential message
surface: harness
component: semantic-deploy-gate
classification: our-bug
problem_class: other
first_bad_boundary: "scripts/tests/semantic-deploy-gate.test.sh invoked admin-health via npx tsx; /exec-daemon/npx (npm 11.19.1) crashes with minipass-flush Class extends undefined before tsx starts"
symptoms:
  - "FAIL: /deploy live Amplitude probe must explain its fail-closed credential contract"
  - "npm error Class extends value undefined is not a constructor or null"
  - "failed deploy structural gates: semantic-deploy"
tags:
  - deploy-gate
  - semantic-deploy
  - amplitude
  - diagnostic-retention
  - npx
sources:
  - PR #1416
  - PR #1436
repro: scripts/tests/semantic-deploy-gate.test.sh
status: fixed
---

## Problem

During the PR #1416 Test Loop rerun on 2026-10-06, and again on the
2026-10-07 photo-display deploy (`20261007-202927-10987`), the Step 4s
structural runner reported `semantic-deploy: exit=1`. The gate stopped at
its live Amplitude credential check. The probe exited nonzero, as required,
but its output lacked
`ADMIN_HEALTH_LIVE_ONLY=1 requires AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY`.

The 2026-10-06 run discarded that output. The 2026-10-07 recurrence printed
the last 40 lines and named the cause:

```
npm error Class extends value undefined is not a constructor or null
```

## Diagnosis

`semantic-deploy-gate.test.sh` launched
`npx tsx src/tests/blackbox/admin-health.blackbox.ts`. On Cursor Cloud the
`npx` on PATH is `/exec-daemon/npx` (npm 11.19.1). That wrapper crashes
during load (`minipass-flush`: Class extends value undefined) and never
executes the workspace `tsx`. The credential contract never runs, so the
fail-closed message is absent.

The same crash aborted `back-end/scripts/run-coverage.sh` at
`npx prisma db push` until PATH preferred `/workspace/node_modules/.bin/*`.
`npx --version` still reports 11.19.1, so a version check cannot detect the
breakage. Isolated `node_modules/.bin/tsx` and `node_modules/.bin/prisma`
work.

The 2026-10-06 "flake under load" theory was a missing-output gap: without
the probe bytes, host pressure was the only remaining story. Load was
coincidental. This is the same evidence-loss pattern as
`2026-09-11-semantic-deploy-fixture-failure-lost-inner-evidence`.

## Solution

The Amplitude contract check and the Group 4 credential-health live probe
now exec the workspace `tsx` binary (`node_modules/.bin/tsx`) instead of
`npx`. The owning assertions remain
`scripts/tests/semantic-deploy-gate.test.sh` (fail-closed credential
message) and
`scripts/tests/deploy-live-probes.test.py` (`credential-health` argv is
workspace tsx, not npx).

### 2026-10-08 relative: same FAIL line, message present, check itself failed

During the quick-launcher deploy (`20261008-001746-55996`) the same line failed
once, with eight structural suites and two coverage lanes running (load average
40–50). This time the retained output held the fail-closed message as its first
line, so the probe was correct and the assertion was wrong. The suite passed
when re-run alone with the same PATH and Node.

The assertion was `printf '%s\n' "$OUTPUT" | grep -Fq '<message>'` under
`set -o pipefail`. Two facts, each reproduced locally:

- Bash line-buffers builtin output. Redirecting the same 11-line `printf` to
  `/dev/udp/127.0.0.1/<port>` produced 11 datagrams, one `write()` per line, on
  both `/bin/bash` 3.2 and Homebrew bash 5.3.
- `{ printf 'match line\n'; sleep 0.2; printf 'more\n'; } | grep -Fq match`
  under `pipefail` exits 141: grep matched and exited, the writer took SIGPIPE.

The message is line 1, so `grep -q` exits after the first write and the other
ten race it. Unloaded, 3000 iterations never lost the race; the failure needs
the writer descheduled between writes, which is what the load provided. It was
not reproduced naturally — the proof is the mechanism plus the retained output.

Fix: both checks on that output now read a here-string
(`grep -Fq '<message>' <<<"$OUTPUT"`), which has no writer process to signal.
Classification for this relative: test-bug.

## Human feedback

None.

## Reusable lesson

Never invoke a workspace-local binary through `npx` on Cloud/Linux. Prefer
`node_modules/.bin/<cmd>`. A wrapper assertion about a child's output must
retain that output on failure; otherwise a tool crash is misread as load. Under
`pipefail`, never assert with `printf ... | grep -q`; match a here-string.
