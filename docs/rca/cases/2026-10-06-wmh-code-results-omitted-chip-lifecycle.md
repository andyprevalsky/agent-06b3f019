---
id: 2026-10-06-wmh-code-results-omitted-chip-lifecycle
date: 2026-10-06
title: Simulated code results omitted the viewer code-chip lifecycle
surface: cross
component: spawn-agent WMH boundary / ClaudeCodeChip
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_agent/handler.py _spawn_world_model_specialized posted generic code events without task_id or task_complete
symptoms:
  - Claude Code Spinning up...
  - Code agent complete
  - Finished simulated code result appears separately from the spinning code chip
  - Expanding a simulated code completion cannot fetch a real code session
tags:
  - wmh
  - code-chip
  - task-complete
  - transcript-replay
sources:
  - plan:.context/deploy-rejected-caps-20261015/rca-review-code-chip
  - agent 67885bdc-fd0f-4023-aa65-d3687df7f2ec
  - fleet run 22da47fc-6ac7-4ab2-8cb7-ac2a3ca57b5f
  - plan:docs/plans/active/wmh-local-continuation-20261006.md
repro: agents/tests/blackbox/spawn_agent.blackbox.py test_simulated_code_posts_code_chip_lifecycle; front-end/src/tests/blackbox/wmh-code-chip.blackbox.tsx
status: open
---

## Problem

The user's screenshot shows a stuck code spinner above a separate generic
completion. The archived API transcript contains three rows for tool call
`fbc00b72-2e82-41dd-81ff-6626c0e3127d`: an outer
`spawn_claude_code_agent` IN_PROGRESS, then two simulated `spawn_agent` code
rows. The simulated task is `857fa645-414a-4967-9f02-3be72bd1e0c3`.
The last row is FINISHED and reports SUCCESS, but has only camel-case `taskId`
and no `action_type`.

## Diagnosis

The specialized WMH path intentionally predicts a whole tool result without
allocating a real code session. It reused generic spawn-agent message metadata
rather than the code viewer's lifecycle contract. Dedupe keys include tool name,
so the generic result could not replace the outer code anchor. Chip derivation
requires task-scoped terminal metadata; it therefore stayed spinning. Even a
correctly scoped completion would try to fetch a nonexistent physical session
instead of displaying its predicted output.

Archive searches for `Claude Code Spinning up Code agent complete` and
`WMH no verified contact submission route absent` were performed. This is a
relative of `2026-08-31-claude-code-chip-stuck-spinning-up-on-pause`, not a
recurrence of that cancellation producer: the new WMH producer omitted the
same consumer contract.

## Solution

The WMH code producer now emits the actual code tool name, `task_id`, provider,
and terminal `task_complete`/success metadata for successful, failed, and
exceptional results. The viewer displays the persisted simulated result and
skips fetching a physical code session. A narrowly guarded, idempotent legacy
normalizer restores that contract for old explicitly marked WMH code messages
before filtering, deduplication, routing, and task scoping. Modern and real
code messages retain their existing behavior. This also covers other simulated
code tasks, including research utilities, without changing their predictions.

Executed unchanged red/green evidence in the isolated continuation worktree:

- `cd agents; source venv/bin/activate; python scripts/run_blackbox_tests.py spawn-agent`:
  new lifecycle assertion failed on missing `toolName`, then the full domain
  passed in 3.7 seconds. Final rerun passed in 3.0 seconds.
- `cd front-end; npx vitest run src/tests/blackbox/wmh-code-chip.blackbox.tsx`:
  predicted output was absent before the hook fix; the legacy routing fixture
  subsequently failed to find the completed chip before normalization and
  passed unchanged afterward. Latest fixture includes the original outer
  starting-code anchor; focused chip/root-filter tests pass, 39 tests / 5.79s.
- Full FE coverage: 149 files, 2,629 passed / 3 skipped, 68.55s;
  statements 80.83%, branches 72.97%, functions 80.96%, lines 83.19%.
  TypeScript and focused ESLint passed (no lint errors).
- Local browser loaded the real archived shared-agent response through HTTP
  200, rendered one completed chip, expanded the recorded four-file result,
  and showed neither old spinner nor generic completion. No page errors.

Detailed logs and screenshot are local `.context/wmh-code-chip-*` artifacts.
The permanent tests run in the normal agent blackbox and FE coverage deploy
gates. Work per transcript remains linear; the repair adds no network request.
This status describes the local code correction, not production rollout.
The broader WMH branch remains undeployed and its fundraiser still fails.

## Human feedback

The user supplied the failure screenshot, explicitly authorized fixing this
card, and separately asked for a trace-backed contact diagnosis without
preemptive prediction changes. Existing recorded cards must be covered; merely
fixing future emitted messages would leave their screenshot unrepaired.

## Reusable lesson

Preserve specialized tool lifecycle and output contracts in simulated producers and replay their original persisted messages through the full viewer pipeline.

## October 15 deployment recurrence

The same persisted simulated-result/viewer lifecycle contract regressed when a later cancellation row became the latest completion message. Its absent simulated marker re-enabled real-session fetching and hid the earlier recorded body. Legacy lifecycle normalization also needed to be applied consistently before the hook derived output. This is a continuation of the existing simulated code-chip contract, not proof that the simulator predicted a correct task outcome.

The actual six-test frontend file had 3 failures / 3 passes before and 6 passes after. Owning Vitest walls were 7.79s and 7.62s. The applied hook retains recorded simulated output across later lifecycle rows and normalizes legacy rows once; the ordinary real-session fetch control remains passing. Original hook/test snapshots and both logs are preserved under the private handoff. No source/provider/model replay was introduced.

The historical component fix and its original checks above remain recorded. This recurrence reopens the case pending unchanged normal final-source gates and production verification. The fundraiser and full deployment remain unproved; an expandable simulated result is not an external execution receipt.
