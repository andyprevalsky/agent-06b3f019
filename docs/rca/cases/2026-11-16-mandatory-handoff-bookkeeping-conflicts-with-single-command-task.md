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

The repair separates worker-owned result instructions with an explicit marker.
Only native Codex with a supported strict output schema replaces that section
with transport-owned persistence instructions. Its existing host writer creates
and validates the declared handoff from the final structured response. The
original task, native thread goal, model, schema and root verifier stay intact.
Unsupported schemas and other transports retain their existing file protocol;
this case does not claim to solve their restricted-action incompatibility.

A new task clears stale previous-task results. Goal continuations retain the
last result only through successfully completed commentary-only continuations.
Explicit commentary is excluded even when its text is JSON or schema-shaped.
A failed/interrupted continuation clears the prior result before recovery; an
unparseable new final also clears it. A parseable invalid final replaces the
old value and the unchanged worker JSON Schema validator rejects it, rather
than silently returning an earlier success. Missing final text cannot become
a null result. Native strict output constrains final responses upstream; the
worker validates the persisted handoff downstream. No duplicate validator is
introduced into the sandbox adapter. Goal state follows native
notifications; an acknowledgment cannot overwrite a newer completion. Existing
backend respawn owns schema changes, so speculative steering/schema mutation
was removed. The smoke waiter combines completion only with the current turn's
end. These are capability and lifecycle repairs, not YC string exceptions.

The shared backend system prompt and version headers match main. An intermediate
candidate offered transport persistence to legacy Claude, causing a real
missing-handoff flake; that change was removed. See the separate
2026-11-16 shared-handoff-prompt case. The native task section supplies the
capability-specific protocol while the shared file-exists condition remains.

### Causal and local verification

The final native regression was run unchanged against an isolated main adapter
and the repaired adapter:
`node --test --test-name-pattern='native handoff honors task constraints' e2b-templates/codex-code/app-server.test.mjs`.
Before: exit 1, native persistence instruction absent (0.194s). After: exit 0
(0.170s). Real reader controls cover complete/blocked/failed, invalid and missing
results. Additional controls cover stale prior tasks, valid result retention
through commentary continuations and native goal ordering. The original private
`replay.py --acceptance` was a historical diagnostic with contradictory fixed
wire assertions; it is not used as red/green evidence.

The first full live candidate erased a valid result 17–20ms after a goal
continuation began. Both ordinary and restricted smokes failed. Captured logs
and a delayed-close local regression isolated the new per-continuation reset;
removing that reset fixed the defect without changing model output. Another
review found acknowledgment ordering and speculative steering changes; those
were removed before the final native writer revision.

On candidate 546e44015464, the full unchanged local command
`CODE_SMOKE_PARENT_MODEL=rose-labs/rose-1-ultra CODE_SMOKE_SPEED=standard bash scripts/run-blackbox-tests.sh codex-code`
passed 34/34, no skips, in 94.255s. The restricted task issued exactly one
`yc me --json`, observed missing CLI exit 127, returned that truthful allowed
outcome, completed its native goal and delivered a valid handoff. Ordinary
smoke passed too. Served model: GPT-6.1 Sol/xhigh/standard through ChatGPT OAuth.
Both owned sandboxes were terminated. This proves the code-session contract,
not original production's successful account lookup or full-root completion.

The first deploy wave's smoke fleet passed 7/7 and released all seven fleets.
Its new-test stability gate exposed a pre-existing listener-registration race,
reproduced on main as well as candidate. The existing PR1874 repair was imported
with provenance, covering both native Codex and Claude listeners. A new waiter
test also violated the fixed-sleep ratchet; an event barrier replaced the timer.
Both independent causes have separate RCA cases. Final local checks after these
repairs passed 48/48 native transport tests, 13/13 backend regression cases and
15/15 condition-wait checks. Deployment-wide reruns and production proof remain
required; the case stays open until shipping.

The 546e44015464 local post-harness eval completed a Collatz root in 149.7s;
its card remains INCOMPLETE because the eval route omitted lifecycle ownership
receipts. It is supporting outcome evidence, not final deployment acceptance.
After restoring the shared prompt to main, the same live codex-code domain
passed 34/34, no skips (88.441s): ordinary 56.017s, restricted 30.871s, same
served model/effort/speed. The full legacy Claude domain with BLACKBOX_SMOKE=1
passed 59/59, no skips (26.100s). All five owned sandboxes across these fresh
runs were terminated. The initial combined run had BLACKBOX_SMOKE unset and
therefore did not execute Claude's real smoke; it is not live-Claude evidence.
The helper is executed by the registered codex-code blackbox root, while native
and owning Python regressions each map directly to their deploy lanes.

A fresh adversarial review of candidate 1b7611ed found that JSON commentary
could replace a prior valid result, and that unsuccessful continuations retained
that result. Its NOT_GROUNDED verdict was honored. A new event/real-reader
regression reproduced both on that candidate. The repair distinguishes native
message phases and invalidates results on failed/interrupted or unusable-final
outcomes. Eight continuation controls flow through the actual worker validator:
JSON and schema-shaped commentary retain the valid result; failed/interrupted
and unparseable finals return missing; null, wrong-shape and invalid-enum finals
are rejected by the worker. Existing completed/blocked/failed/new-task controls
remain. The complete local native suites pass57 assertions; the full owning
worker suite passes190 checks, including all eight actual validator receipts.
The full live Codex domain passed34/34, no skips, in102.365s on the bounded
retention revision and terminated both owned sandboxes. Renewed grounding and
deployment-wide verification remain required.

The original paused root has never been resumed or changed. Open PR1636 must
retain the capability-specific invariant if later merged.

## Human feedback

The user reported noncompletion after 24 hours with status PAUSED and required
classification as input stall, harness failure, or justified progress. Standing
human instructions prohibit treating pause as the root cause, changing models
or trajectories to speed up, and weakening task constraints or validators.
Cost work must consider cache/planner memory first. Approval and deployment are
owned by the coordinating parent. No user approval has been requested here.

## Reusable lesson

Keep mandatory handoff bookkeeping compatible with the user's permitted actions, and diagnose repeated correct rejection upstream of the verifier.
