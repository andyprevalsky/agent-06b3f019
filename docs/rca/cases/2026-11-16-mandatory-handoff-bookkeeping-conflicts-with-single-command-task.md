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
  - PR #2290
  - commit cc7a39b2846aa385320386bbb1374e74c989e6a4
  - agent df99c21a-058b-4f70-955c-adade7d530bd
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py::test_native_handoff_preserves_single_command_task
status: fixed
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

### Related captured occurrence and secondary transport evidence

A separately investigated root, `30030a75-a650-404e-89ce-3c41f8f5f5d8`, has the
same first bad boundary. Its Context7 resolution returned `/vercel/next.js` at
2026-11-15 06:55:43.202 UTC. The child then followed mandatory handoff commands
through four shell invocations, violating the explicit no-shell constraint.
The verifier correctly rejected at 50%; the actual pause arrived at
06:57:58.678738 and the last substantive message was 204.698 seconds after
creation. Cost was 5 cents against a 1,000-cent cap, with no requested feedback
or user-input wait. This is an additional captured occurrence, not a fresh
post-repair result. Its original root was not resumed. The complete private
investigator report and source hashes are preserved in the D05 archive.

Read-only inspection of all eight original 118fff32 failing-request dumps also
found paired 88-character `completed-child-attempt-completion-...` identifiers
in actual tool-call and tool-result fields. The related investigation isolated
the same generated-ID shape through its original client: provider validation
rejected an 88-character call ID against a 64-character maximum, while a paired
control that shortened only the IDs succeeded. That causal replay belongs to
root 30030a75. For root 118fff32, no new model replay was made and the historical
provider error bodies remain unavailable. The captured invalid identifiers
corroborate a separate transport defect downstream of the first handoff
violation; they do not replace the primary diagnosis or turn its historical
400 responses into directly observed provider-body evidence. The separate open
case is recorded by the related RCA owner; this repair does not change IDs.

## Solution

The repair separates worker-owned result instructions with an explicit marker.
Only native Codex with a supported strict output schema replaces that section
with transport-owned persistence instructions. Its existing host writer persists
the final structured response as the declared handoff. The
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
The earlier recorded run returned exit 1, native persistence instruction absent
(0.194s), then exit 0 (0.170s). The final unchanged-test capture is recorded
below with its separate measured timings. Real reader controls cover
complete/blocked/failed, invalid and missing
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
15/15 condition-wait checks. At that historical checkpoint, deployment-wide
reruns and production proof remained required; the case was still open.

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
retention revision and terminated both owned sandboxes. At that checkpoint,
renewed grounding and deployment-wide verification remained required; the
later landed proof is recorded below.

The required post-harness eval on runtime 2a2c99 completed its Collatz root in
136.5 seconds, one attempt, with its verifier confirming 111 steps and 112
sequence values. Actual parent: Claude Opus 5.5 through OAuth; child: legacy
Claude Code with exact model/effort/speed unrecorded. This is compatibility
measurement, not a native restricted-task outcome or a speed comparison. The
native card remains INCOMPLETE because the eval route lacks lifecycle ledger
receipts, despite independently verified cleanup. Its optional mirror reported
a read timeout; readback and the normal publisher later verified the original
write committed, the FE rendered 54 messages and the final dump was reachable.
No duplicate upload or extra agent run was made. Full private receipts retain
all cost, cache, timing and publication qualifications.

The original paused root has never been resumed or changed. Open PR1636 must
retain the capability-specific invariant if later merged.

### Landed repair and exact-goal production proof (2026-11-16)

PR #2290 landed as `cc7a39b2846aa385320386bbb1374e74c989e6a4` after
all 17 native gates passed on source `96d12280d3438f764b0c098ab4f9547eb763b3fd`,
including the corrected full 285-check backend inventory. Golden review 3's
NOT_GROUNDED result above was preserved; Golden review 4 was GROUNDED after
those defects were repaired. CodeRabbit was skipped because of the confirmed
organization usage cap: the PR merged unreviewed by CodeRabbit, not with a
claimed successful review. The identical final native regression's recorded
before/after exits were 1/0 and wall times 0.187059649/0.159985798 seconds;
test SHA256 `2dd7df04c9d73bd36ab6cf7c93385d033efb1a76dd00e6a5f8e94a96bf2d07ab`.

A separately authorized fresh normal production root,
`df99c21a-058b-4f70-955c-adade7d530bd`, used the exact original goal and settings
(request SHA256 `65048d98ed23b06ef5032fca370b09f5fcda06971ec5586b50c421dc2d71b5b7`).
It was created at 17:38:50.418 UTC. The verified code-session checkpoint and
complete root transcript show exactly one cloud code spawn and one actual
CommandExecution: `yc me --json`, represented by `/bin/bash -c`, exit 0 in
3.352491091 seconds. Output identifies Andy Prevalsky, username
`andyprevalsky`. The CLI's token refresh was internal to this allowed command;
no model-issued install, login, retry or bookkeeping shell command occurred.
A second native tool call completed the goal without executing a shell.
The native adapter persisted the result; strict provider output and the
unchanged worker reader supplied schema validation. The root's first
completion attempt received verifier score 100%. Final answer was recorded
159.757 seconds after creation, and terminal status persisted after 168.698
seconds. These are distinct clocks, not interchangeable durations.

The child actually served GPT-6.1 Sol, xhigh, standard, CLI 0.169.0. The
requested parent model and task/goal/schema/verifier semantics were not changed
by this repair. The exact image ID and per-sandbox server-file hash were not
recorded by this audit; runtime provenance additionally uses the live deployed
source's byte-identical handoff files and the native transport goal transcript.
The root's recorded own cost was 0.227 cents; tree cost 0 is a separate meter,
not a zero-cost claim.

This closes the targeted handoff defect, not the entire deployment. Full
production was still NOT SHIPPED: Fly verification remained blocked by the
separately owned PR #2407 multiline-JSON parser defect, with workflow-migration
and semantic lanes blocked on Fly. The main agent authorized the targeted
check from independent verified runtime evidence; it did not count as a pass
of those blocked production lanes.
The original `118fff32` root remains paused and was never resumed or modified.
The fresh result's code task is CLOSED; its persistent application sandbox is
normally retained PAUSED with verified checkpoint 1, not described as released.
All benchmark fleets were released separately. The production repository and
checkpoint are retained user assets, not abandoned local test resources.

Private proof is in `/tmp/rca-118fff32-root-outcome/audit/` and the unchanged-test
receipt in `/tmp/rca-118fff32-parent-test-repair/candidate4-native-receipt.json`.
The canonical last-verifier publication was HTTPS GET/hash verified, with
signed URL and raw data kept private. The case includes no signed link and
makes no fresh FE browser-render claim. Historical failed attempts and the
initial diagnosis-ready outcome remain intact above.

## Human feedback

The user reported noncompletion after 24 hours with status PAUSED and requested
classification as input stall, harness failure, or justified progress. For an
input stall, the user requires speeding up without changing the model or using
prompts/context injection to alter its trajectory. For a price limit, use cache
hits or planner memory before prompt changes. All approval requests belong to
the main agent. The observed pause was preserved; evidence, rather than a user
instruction about causality, establishes that failure preceded the pause.
RCA118-HANDOFF-4 received a GROUNDED review without a human approval request.

## Reusable lesson

Keep mandatory handoff bookkeeping compatible with the user's permitted actions, and diagnose repeated correct rejection upstream of the verifier.
