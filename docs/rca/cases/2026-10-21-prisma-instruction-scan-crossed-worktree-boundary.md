---
id: 2026-10-21-prisma-instruction-scan-crossed-worktree-boundary
date: 2026-10-21
title: Prisma safety instruction scan treated nested worktree history as active instructions
surface: infra
component: prisma-local-push-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: prisma-local-push.test.sh recursively discovered .claude/worktrees despite evaluating paths relative to the current workspace
symptoms:
  - "instruction docs tell agents to run a bare prisma db push; use npm run prisma:push:local"
  - ".claude/worktrees/agent-a9de3902c4ed3aeb1/docs/rca/"
  - "backend-structural exit=1"
tags:
  - prisma
  - safety
  - worktree
  - discovery
sources:
  - commit 351db6bbe
  - agent a9de3902c4ed3aeb1
repro: back-end/scripts/prisma-local-push.test.sh
status: fixed
---

## Problem

The parent's structural gate failed while scanning instructions. The original
receipt is `/home/boxes/rose/.context/stuck-report/resume-static.log`, lines
1790-1807. It flags historical examples in this independent worktree's copied
`docs/rca` and `docs/rca/process-feedback.md`. These are not active parent
instructions. No unsafe parent instruction needs to be exempted to fix this.

## Diagnosis

The scanner starts at `CLAUDE.md`, `AGENTS.md`, `.claude`, and `docs`, but descends
into `.claude/worktrees`. Existing `docs/rca/*` and `docs/plans/*` exclusions are
relative to the scan root; prefixed child-worktree paths no longer match them.
The deepest owned defect is discovery crossing the workspace ownership boundary,
not the Prisma URL validator or the rule rejecting bare schema pushes.

The isolated fixture uses the same scanner and rejection function as the real
workspace check. It fails before the change with nested historical and copied
instruction paths, including `.claude/worktrees/archived/docs/rca/history.md`.
Only the discovery expression changes between the retained baseline and candidate;
the final fixture and assertions are identical. The baseline script also matches
the scanner in parent main `351db6bbe` before factoring it into the test function.

Archive searches: `prisma local push instruction worktree scanner` and
`nested worktree archived docs false positive`. The June 27 remote schema-push
case explains the safety rule and its regression; this is a distinct test
ownership defect, not a recurrence of an actual remote push. The October 6
nested generated-state context case is related discovery-boundary guidance.

## Solution

Keep the scanner and rejection policy in a reusable function in the existing
owning test. Prune the exact `.claude/worktrees` subtree before visiting files.
Preserve the existing canonical history exclusions and the unchanged AWK rule
requiring both database URLs to be local. No skip flag, new suite, helper file,
or protected-instruction edit is introduced.

The permanent fixture proves:

- Canonical historical docs and nested worktree historical/copied instruction
  files do not fail the current workspace's instruction scan.
- Bare pushes in active `CLAUDE.md`, `AGENTS.md`, `.claude/commands/setup.md`,
  `docs/guides/setup.md`, and `.claude/worktrees-guide.md` are individually rejected
  with the offending path. The last path prevents an overbroad prefix exclusion.
- A multiline command with both explicit local URLs remains accepted.
- Existing DATABASE_URL and DIRECT_URL remote-target guards, normalizer remote
  guard, and real scratch-Postgres normalization/idempotence checks still run.

Exact command from the worktree root:

```bash
bash back-end/scripts/prisma-local-push.test.sh
```

Evidence is retained in `.context/rca-prisma-scan/`: `pre-fix.log`,
`post-fix-1.log` through `post-fix-5.log`, `baseline-with-regression.sh`, and
`verification.json` with command, exits, wall times, and source hashes.
Baseline exits 1 on the ownership assertion. The unchanged final regression
passes five consecutive candidate runs in 2.726, 2.542, 2.481, 4.325, and
2.137 seconds (all exit 0); baseline failed in 0.183 seconds (exit 1). Each
candidate run includes the real scratch DB SQL check. The fixture's temporary directory is cleaned in its subshell EXIT trap;
the existing scratch database cleanup trap remains intact.

Registration remains `back-end/package.json` → `test:structural` → this script.
No parent checkout, shared DB, live session, runtime code, or Kernel bytes change.
At 10k agents this is a static structural gate, not an agent runtime path; pruning
avoids recursively multiplying scan cost by local worktree count. Each independent
worktree validates its own active instructions when its gate runs.

Golden references: N/A for this repository-specific Prisma instruction gate.
Targeted `prisma-local-push|assert_safe_instruction_docs` searches in
`claude-code-src`, `openclaw`, `hermes-agent`, and `codex` found no matching gate;
the receipt is `golden-search.log`. Local analogous discovery/ownership guidance
was reviewed in the archive.
The canonical safety contract is the existing Prisma wrapper and this same test,
not an external harness. Adversarial review passed with no blocking findings; its receipt is retained
as `review.txt` alongside evidence. Bash syntax and whitespace checks passed;
archive validation and the archive structural gate passed with 1,076 cases.

## Human feedback

The parent explicitly narrowed work to this scanner, required unsafe active
instructions and remote DB guards to remain strict, prohibited edits to protected
instructions and Kernel runtime, and authorized local commit without a generic
production-code approval gate. No push, deploy, paid session, or shared DB reset.

## Reusable lesson

Prune independent workspace trees at the discovery boundary before applying root-relative instruction policies.

## Follow-up: diagnostic assertion SIGPIPE during full deploy

The parent's full structural run on `d240f75d9` reproduced a test-only race:
`instruction scanner did not identify unsafe active file: docs/guides/setup.md`.
Under `set -o pipefail`, `printf '%s\n' "$output" | grep -Fq "$active:1:"`
can return 141 when grep exits on its first match before printf finishes writing
the remaining diagnostic. The scanner had correctly rejected the unsafe file;
the assertion misreported its own broken pipe as a missing path.

The exact two-line diagnostic replay failed at iteration 37. A permanent large
diagnostic fixture in the same existing test makes this deterministic: the
baseline fails before SQL setup, while the candidate passes the unchanged
fixture. Use `grep -Fq "$active:1:" <<< "$output"` to remove the pipe producer;
all five active-file checks and remote URL guards remain unchanged. No runtime
or protected-instruction changes are involved. Evidence:
`.context/stuck-report/scanner-pipe/{pre-fix,pre-fix-full,post-fix-full}.log` and
`final-verification.json`; the latter records five full-script passes.


## Follow-up: exact host and command scope (PR 1562 review)

Review of `ebe268215f366199ee0df4d753b149951f437298` exposed a separate
weakness in the preserved line-wide AWK policy: `localhost.evil.example` passed
as localhost, and local assignments on a prior command could authorize a bare
push later on the line. One scoped push also hid a second unscoped push.
The final unchanged regression adds seven rejected forms, including interior
backtick and `$()` substitutions. On the baseline all seven were accepted;
the script exits 1 with each unsafe instruction in the diagnostic.

The same reusable scanner now discovers owned files with stdlib `os.walk`,
retaining exact worktree/history pruning. It checks every push with `shlex`
command boundaries and requires literal DATABASE_URL and DIRECT_URL assignments
on that command. `urlsplit` must identify the exact localhost or 127.0.0.1 host.
Only a complete outer Markdown backtick pair is presentation; interior command
substitution fails closed. This is intentionally a limited accepted grammar,
not a full shell interpreter. Supported positive forms include multiline,
`env`, a preceding `cd &&`, and outer inline-code delimiters.

Reproduction remains `bash back-end/scripts/prisma-local-push.test.sh`.
Final test bytes were held constant while only the scanner function was
replaced with the pre-fix version. Retained receipts in
`.context/stuck-report/review-fixes/` are `scanner-baseline-frozen.log`
(exit 1), `scanner-final-bytes.sh`, `scanner-frozen-pass-1.log` through
`scanner-frozen-pass-5.log`, and `scanner-frozen-five.json`. All five final runs
exit 0 in 2.715, 2.744, 2.756, 2.825, and 2.742 seconds. Remote DB wrapper guards
and scratch DB normalization still run; no real remote schema push occurs.
The script SHA256 is
`7a93f44077c6e459c42fd7c434535698c650df87864c7c5f2a9c3d120fd137ea`.

Archive searches `localhost.evil prisma instruction scope` and
`Prisma remote hostname local shell assignment` identify this scanner case as
the owner. Exact golden-reference implementation remains N/A: none of the
four reference repositories owns this repository-specific instruction policy.
At 10k agents the gate remains static, with no agent runtime or database cost.
Parent independent review specifically requested rejection of interior shell
substitutions and preservation of real remote-DB safety checks.

Parent independent review of the final scanner found no new blocking issue;
it confirmed conservative parsing and retention of active-file safety. Final
backend structural verification passed with 1,081 archive cases.
