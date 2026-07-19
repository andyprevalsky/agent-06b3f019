---
description: "Root-cause a bug the RIGHT way: read the RCA methodology, then produce a LOCAL REPRO that fails on the bug and a fix that makes it pass — never return with a theory."
---

# /RCA

Use this whenever you are diagnosing ANY bug, flake, regression, or "why did X happen".

## Step 0 — READ THE METHODOLOGY (mandatory, every time)

Read `docs/root-cause-analysis.md` in full before forming any hypothesis. It is
the source of truth for how RCA is done in this repo (evidence first, trace the
critical path, binary-search to the first-bad boundary, reproduce, cement).

Then follow it exactly. Do not skip Step 0 (gather runtime evidence) and do not
reason from code alone when logs/DB/HTTP evidence exists.

## The hard gate — you may NOT report a diagnosis without BOTH:

1. **A LOCAL REPRODUCTION that you actually ran** and observed FAIL on the buggy
   code — with the exact command and the failure output recorded.
2. **A FIX that makes that same reproduction PASS** — re-run the identical
   command and show it green, without weakening the assertion.

If you cannot reproduce it, you do NOT have an RCA — you have "preliminary
findings + an observability gap". Say so, add the missing capture, keep it open.
Never present a theory, a code read, a production correlation, or a
third-party-state explanation as a completed RCA.

**Never come back to the user with "I think it's X" or "it's probably load / a
race / a 404". Come back with: here's the repro that failed, here's the fix,
here's the repro now passing.** A hypothesis is not a deliverable.

## What "done" means (RCA completion gate)

- Deterministic repro artifact exists locally and was executed (record the command + output).
- It exercises the same first-bad boundary the runtime evidence identified.
- After the fix, the SAME artifact passes unchanged (no weakened assertion).
- The repro is promoted to the permanent checked-in blackbox suite that owns the
  first-bad boundary (see the table in `docs/root-cause-analysis.md`), and
  `/deploy` runs that suite for the affected surface.
- Common trap: running a test the wrong way (e.g. wrong `DATABASE_URL`, missing
  env, stale services, leftover processes) produces FAKE failures. Verify the
  repro is valid before diagnosing — reproduce the harness's real conditions.

## Output

When RCA-only: present (a) the evidence, (b) the one-sentence root cause at the
first-bad boundary, (c) the exact local repro command + its recorded failure,
(d) the proposed generalizable fix. Then stop for agreement before implementing.

When fixing too: implement, re-run the identical repro command, and report the
pre-fix failure AND the post-fix pass side by side.
