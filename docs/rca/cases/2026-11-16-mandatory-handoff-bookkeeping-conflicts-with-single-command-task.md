---
id: 2026-11-16-mandatory-handoff-bookkeeping-conflicts-with-single-command-task
date: 2026-11-16
title: Mandatory code-agent handoff bookkeeping violated a single-command task and trapped completion in repeated rejection
surface: agents
component: spawn_claude_code_agent handoff contract
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py handoff_task_text appends mandatory file-writing and shell-validation instructions to a task forbidding extra commands
symptoms:
  - not completed 24h after start status PAUSED
  - Verifier score: 50%
  - Additional shell commands were used for that bookkeeping
  - printing the written file and validating it against that schema with a command
tags:
  - code-agent
  - handoff
  - constraint-conflict
  - repeated-verification
sources:
  - agent 118fff32-2388-4636-ae74-fec935326548
  - commit e54032c7fba36b09b58b5a83fef7754f89df716f
  - PR #1636
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py::test_native_handoff_preserves_single_command_task
status: open
---

## Problem

The root was asked to spawn one cloud code agent, run exactly `yc me --json`
and nothing else, and report success and account name. Production root/tree
API, raw Agent/Message/AgentAttentionRequest/ToolUsage/ClaudeCodeSession rows,
and 4,899 retained worker log lines were captured privately under
`/tmp/rca-118fff32`. Never commit those traces or their credential-bearing dumps.

Created 2026-11-15 02:42:54.465 UTC; command returned exit 0 at 02:43:52.692
(58.227 seconds). The first child then ran three bookkeeping Python shell
commands and wrote the handoff. Its completion explicitly acknowledged those
extra commands. The verifier rejected at 02:47:48.008. A second spawn ran the
command again; seven more completion checks correctly rejected the irreversible
original violations. Last task message: 02:54:39.500. At the raw DB capture,
2026-11-16 02:59:42.724, elapsed was 87,408.259 seconds (24h16m48.259s).
Status PAUSED; ownCostCents 26.51315, treeCostCents 26, priceLimitCents 1000.
No attention requests or waiting-for-user tool flags were present.

## Diagnosis

Classification: harness failure, not input/price/feedback stall or justified
continued progress. The wire task assembled by `handoff_task_text` contains the
parent's prohibition and the contradictory mandatory instruction to print and
validate the handoff using a command. A local replay calls the real builder with
the captured spawn arguments and reproduces the production wire byte-for-byte.
The production child expressly identifies this instruction as why it made the
extra calls. The later verifier is constraint-correct: a compliant retry cannot
undo the first violation or the second spawn.

The mandatory handoff contract delegates bookkeeping to the agent without
reconciling it with the task's action restrictions. Source e54032c7 also contains
a Codex adapter that can write the final structured result itself. A separate
local replay of the actual CodexAppServer, production schema and captured output
writes one valid handoff without shell execution RPCs. This proves an existing
local mechanism, not which template revision ran in production. Open PR #1636
(head f3fa8a7a59e6d970bc82ca5e20010ede48972229) removes that native writer and
requires agent-written handoffs. Its body and exact source were inspected; it
retains the general file-writing conflict. Do not infer a deployed template
revision from local tests or revert its intended contract without review.

The pause signal arrived at 02:54:21.111429 (686.646429 seconds after creation)
while the final verifier was running. Later logs show only preserved pause
handling across code updates; no task progress or LLM calls after the final
verdict. User pause is not the cause of the earlier failure. The 24h status age
is not 24h of useful computation. Verifier spans total 187.362 seconds for eight
checks; ten execute-loop call spans total 131.178 seconds, max 60.433 seconds.

Other hypotheses tested against captured evidence: missing CLI/auth rejected by
exit-zero JSON; cost limit rejected by actual cost versus limit; input wait
rejected by empty attention rows and metadata; provider outage rejected as the
primary cause by successful completion spans and available results. Eight
execute-loop direct GPT attempts returned 400 and fell through to Kimi, adding
latency but occurring after the first contract violation. Their precise 400
cause is not established and is not this case's root cause. Cache diagnostic:
19 calls, 122,747 cache-read tokens, 94 cache-write tokens, 53% aggregate hit
rate; late execute-loop hits reached 93–96%. No model or context speed change
is justified by this incident.

Archive searches before hypothesis: `PAUSED 24 hours waiting feedback` and
`request_feedback stalled input long running`; then `code handoff command only
verifier` and `attempt_completion verifier repeated rejection code agent handoff`.
The 2026-10-24 handoff-schema-description case is a relative: explicit transport
contracts matter, but descriptions were intact here. The 2026-10-18 auth-handoff
score case is a relative only; these verdicts are consistent, not ambiguous.
No same-cause archived case found.

## Solution

The initial diagnosis applied no production changes. A local repair candidate now
exists; no deployment or live outcome proof has occurred, so the case remains open. The parent owns contract decisions,
independent review, approvals and deployment. A coherent repair must preserve
user action restrictions and declared output validation, covering the worker,
system instructions and actual deployed provider transport together; it cannot
special-case YC strings or make the verifier accept violated constraints.

Private local commands (run from the repo root):

- `source agents/venv/bin/activate && python /tmp/rca-118fff32/replay.py`: exit 0;
  reproduces wire conflict and validates captured structured output through the
  real handoff reader.
- Same command with `--acceptance`: exit 1, assertion that native-output-capable
  providers must not be told to execute redundant bookkeeping. No after-fix pass
  claimed; this remains a diagnostic acceptance probe, not a shipped regression.
- `node /tmp/rca-118fff32/native-replay.mjs`: exit 0; real adapter writes captured
  schema-valid result once with no shell RPC.
- `node --test --test-name-pattern='handoff' e2b-templates/codex-code/app-server.test.mjs`:
  3/3 pass.
- Existing handoff goal and reader blackbox cases: 2/2 pass, explicitly partial.

The first replay attempt had a diagnostic-script null-metadata error; corrected
before causal assertions ran. The first full local latency import used the
wrong working directory; corrected with agents cwd. Neither is production
failure evidence. No new consistently-run regression or before/after fix proof
exists yet. This case stays open rather than claiming a fix.

### Local repair candidate (not deployed)

The worker now separates its own handoff instructions with an explicit protocol
marker. Only the Codex adapter with a supported strict output schema replaces
that section with transport-owned persistence instructions. The original goal,
native thread goal, model, and output schema remain. The generic backend system
prompt defers to that task-specific contract; its file output paths and code-session
skill requirement remain. Claude/exec/unsupported-schema instructions are unchanged.

The adapter tracks native goal continuations, resets stale result state at each
new task/continuation and writes their final JSON through its existing writer.
Missing final text no longer becomes a `null` handoff. The worker's validation
is unchanged. A new native suite is wired to the deploy structural registry;
the owning Python blackbox invokes the native controls and validates filesystem
reader receipts, with valid complete/blocked/failed and invalid/missing controls.

The selector stability runner passed four units five consecutive times under
eight CPU load slots: owning Python controls, backend prompt blackbox, handoff
unit tests and all 37 native adapter tests. A wrapper-aware focused plan was
used for the Python suite; its registered run_all_tests wrapper defeats static
case narrowing. Test-root hashes were unchanged. An extra final Python five-run
check also passed. Ruff lint and JavaScript/TypeScript formatting passed; whole
Python-file formatting would reformat unrelated existing code and was not applied.

The final new native tests were run unchanged against an isolated baseline
source: two failures (old bookkeeping prompt and stale result retained), then
pass on the candidate. This is local mechanism proof, not proof that a real
model stopped doing extra work. The live restricted-command smoke is registered
in the existing Codex blackbox path and remains for parent execution. Open
PR #1636 must retain this capability-specific invariant if later merged.

## Human feedback

The user reported noncompletion after 24 hours with status PAUSED and required
classification as input stall, harness failure, or justified progress. Standing
human instructions prohibit treating pause as the root cause, changing models
or trajectories to speed up, and weakening task constraints or validators.
Cost work must consider cache/planner memory first. Approval and deployment are
owned by the coordinating parent. No user approval has been requested here.

## Reusable lesson

Keep mandatory handoff bookkeeping compatible with the user's permitted actions, and diagnose repeated correct rejection upstream of the verifier.

### Live follow-up on committed candidate 2d3adc093aba

The first real full codex-code gate failed both generic and restricted smokes:
no handoff file at close. Captured checkpoint CLI logs show valid final JSON,
then a goal continuation beginning 17–20 ms later. The candidate's per-turn
reset removed the file. Gate attribution: INTRODUCED versus main bd35eaed,
which has no such reset. The local delayed-close regression reproduces missing
versus present without changing model output. Fix: keep a task's last result
through its goal continuations; only initialize a new task clears prior data.

Independent candidate review also reproduced acknowledgment overwriting a
newer goal completion and schema mutation before failed steering. The extra
ack assignment and deliver schema handling were deleted, restoring the original
steering owner; production respawns restart the CLI for a new output schema.
No new active-schema lifecycle was added. A waiter regression now requires the
currently started turn to finish before combining its result with goal completion.

The first follow-up live run was stopped by exact owned runner PID when the
review arrived; its single owned sandbox was confirmed torn down. It is not a
pass. The next full live run is recorded separately in private artifacts.

### Final local live gate

The unchanged full command `CODE_SMOKE_PARENT_MODEL=rose-labs/rose-1-ultra
CODE_SMOKE_SPEED=standard bash scripts/run-blackbox-tests.sh codex-code` passed
34/34, no skips, in 94.255 seconds (run 1794799399-937600-24822).
Generic smoke passed in 63.160s and restricted-command smoke in 28.007s.
Both served GPT-6.1 Sol, xhigh, standard, through user ChatGPT OAuth. The
restricted run issued exactly one `yc me --json`, observed missing CLI exit127,
returned a truthful missing result, completed its native goal and delivered a
valid handoff. The task explicitly permits missing/unauthenticated outcomes.
Both owned sandboxes were terminated by the runner. This establishes the
restricted code-session contract, not that original production's successful
account lookup was reproduced or its paused root was resumed. Deployment and
root-verifier live proof remain parent-owned; keep the case open.

The immediately prior full gate passed the generic smoke but rejected the
restricted command's equivalent `/bin/bash -c` wrapper. That was a smoke assertion
bug: its payload was exactly the requested command. The final assertion accepts
`-c` and `-lc` with that literal payload only; negative controls reject appended
commands. No production goal, timeout or evaluator was weakened.
