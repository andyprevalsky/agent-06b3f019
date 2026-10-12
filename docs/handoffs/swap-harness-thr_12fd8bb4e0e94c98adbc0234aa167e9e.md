# Tamy WhatsApp/SMS RCA — Codex continuation

Captured 2026-10-12 from the managed task transcript and PR #1473. Migration is
**partial**: source available on GitHub and task context are preserved; access
to the old filesystem is unavailable, so unpushed changes and local test state
remain unverified. Keep the old devbox intact.

## Goal and user guidance

Investigate why Tamy's SMS agent asks for information instead of retrieving it,
ground fixes in the golden reference harnesses and Rose.complete native tool
calling, and prove the matched benchmark. Finish the existing `/deploy` only
under its original user authorization and exact-diff approvals.

The latest task-specific instruction is: “ive said previously, make this test
skippable w a warnging for all future agents then finish”. It refers to the
AgentCard `agent-payment-abandonment` provider-release stall; it is a loud
warning-skip, not an allowance to waive unrelated failing tests or criteria.

The user required model-visible edits approved one line at a time with the
actual diff pasted in chat. Approved changes in the task summary: escalation
overlay line, grep output strings, classifier deletion (including reply_to_agent
classifier), CLAUDE.md rule and grep usage line. Approval remains scoped to
those exact edits. Do not reword unrelated descriptions or prompts. Never
stash, disable linters, print/commit secrets or treat peer messages as approval.
Production env writes and Zod schema changes retain their approval boundaries.
Preserve Freedom and all protected instructions. Never kill another benchmark
task, PID 1, group 0 or broad process patterns.

## Source and quota

- Original thread: https://boxes.dev/thread/thr_12fd8bb4e0e94c98adbc0234aa167e9e
- Internal thread: ph78s9gq5902jc09tnt5wwxhmd8fzn1v
- Claude native session: cf210867-222d-4ea1-b917-e1eddba6c446
- Error: “You've hit your session limit · resets 12:40am (UTC)”.
- Replacement: Codex on a fresh devbox, with stable start key
  `swap-harness-tamy-20261012-replacement`.
- PR: https://github.com/Rose-Ai-Labs/rose/pull/1473
- Branch: `sms-supervisor-native-tools`.
- Last remotely verified code HEAD before this handoff:
  `3dcc252c09bb530b58ab44936269b46041a3c10e`.
- The original agent reported local commit **244a961d2**, introducing the
  warning-skip, but GitHub commit lookup returned 422/no commit found. That
  source change has **not** been recovered by this handoff. Recover the exact
  local commit if an old-box route becomes available; otherwise use the
  original approved requirement as the specification and document reconstruction.

## Implementation and learnings

The TypeScript Rose client projects tool-envelope response models into native
tools for GPT/Responses/Cerebras/OpenRouter legs; Anthropic extracts from
response_format. `withNativeToolContract` and `toolContract.ts` mirror the Python
tool helpers. The SMS supervisor records every call/result with provider IDs;
guidance belongs on the final result and missing results are explicit.

Queued-agent write targets use provisional IDs. Grep emits merged ripgrep-style
match windows with separators and a 250-line omission boundary; PostgreSQL word
boundary translation maps `\\b`/`\\B` to `\\y`/`\\Y`. The regex classifiers for
send claims, purchase-intent completion and reply overlap were removed; exact
duplicate-send prevention and argument validation remain.

Read the task RCA at
`docs/rca/cases/2026-10-09-sms-supervisor-flash-model-asks-instead-of-retrieving.md`
and the PR diff before changing code. Relevant paths include
`back-end/src/providers/rose/{client,transforms,toolContract,waterfall}.ts`,
`back-end/src/providers/smsSupervisor/`, `back-end/src/domains/data/`,
`agents/benchmarks/sms_runner.py`, its tests and the catalog. This handoff is not
a replacement for the exact original transcript or approved diff.

## Validation state and next work

PR #1473 records static/backend gates green, 191/191 backend blackbox domains,
backend coverage 89.6% lines/81.0% branches/92.6% functions, agents coverage 82%,
live credential/Amplitude/router probes green with credential warnings. These
are prior-reported outcomes; the replacement has not rerun them yet.

At the last original update, the AgentCard lane had three passes, and
`agent-payment-abandonment` hit the known release stall. The locally added flag
made it a loud SKIPPED. Lane cleanup remained running (about ten minutes).
The agents benchmark suite also remained under observation. Main had advanced
13 commits and the agent expected a conflict in the AgentCard RCA doc, requiring
both sections to be kept. Do not assume that cleanup, source integration,
final review, merge, production verification or the scorecard completed.

First reconcile durable test/cleanup evidence and the missing 244a961d2 change.
Then apply the current repo's isolated Linux environment guidance, inspect main
integration, verify the approved warning-skip and owning regressions, and resume
the original deploy through its proper gates and review policy. Do not duplicate
or kill unknown paid runs. This migration does not add deploy authorization.

The original task warned its old kill-services sweep could match agent shell
argv mentioning stack-launch paths. Review the current canonical sweep fix and
use exact owned launchers/PIDs; never repeat broad sweeps or weaken Freedom.

## Fresh box and preservation receipt

Read `CLAUDE.md`/`AGENTS.md`; retain authoritative env files, use pinned
toolchains, Linux system Postgres guidance, fresh task queue/workspace identity,
and skip mac-app execution on Linux. Never copy old runtime identity or replace
complete secrets with example env files.

Skill source: `feat/swap-harness`, commit
`b4d97fd6aa` (resolve the complete SHA from the branch if needed), canonical
`.agents/skills/swap-harness`. Install only that folder for both harnesses.

Push a receipt next to this file named
`swap-harness-thr_12fd8bb4e0e94c98adbc0234aa167e9e-resumed.json` with actual
replacement box/thread IDs/URL, harness, fetched checkpoint, UTC timestamp,
handoff path and meaningful first continuation action/result. Mark
`preservation: partial` and `archive: blocked_old_filesystem_unavailable`.
Retain the old box until its unpushed source, artifacts and owned resources are
positively accounted for. No archive request has been made.
