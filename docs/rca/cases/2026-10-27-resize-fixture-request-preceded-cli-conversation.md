---
id: 2026-10-27-resize-fixture-request-preceded-cli-conversation
date: 2026-10-27
title: Resize fixture reported a CLI request before the initial CLI conversation existed
status: fixed
surface: agents
component: code-sessions native blackbox fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the resize fixture returned its initial create response before the scripted CLI tool/conversation existed, allowing its second keepalive to fabricate a CLI-originated resize too early
symptoms:
  - "timed out waiting for the resumed CLI to start"
  - "Resume transcript not found; starting a new conversation"
tags:
  - resize
  - test-fixture
  - readiness
  - native-cli
  - code-session
sources:
  - commit e8e8cff1f26e97aceb8ea87740a0e775e13c1c9a
  - plan:.context/deploy-fresh-20261027/rca-code-session-resize/RESULT.txt
repro: agents/tests/blackbox/code_sessions.blackbox.py::test_resize_request_waits_for_initial_cli_tool_start
---

## Problem

The original code-sessions domain passed15 cases and failed only resize_request_moves_session_and_reattaches. The activity said it continued in task-resized at02:28:39, then the existing20s helper failed waiting for the second CLI journal entry. The retained activity log shows only the server's session event before resize, with no initial CLI init/tool event observed. The original per-home ws-server log and journal were deleted by native cleanup, so their exact historical contents are not recoverable; no original host-load or scheduling attribution is made.

## Diagnosis

The fake backend injects resize_requested on keepalive2, independent of whether the scripted CLI has started. Under the unchanged2000x clock the activity can reach that keepalive before the CLI answers initialization and writes its session transcript. The fixture then stops the old ws-server, starts a new one with a resume ID that has no transcript, and the production server correctly logs that it starts a fresh conversation. The fresh CLI creates only one journal entry; the unchanged len(runs)>=2 assertion times out.

A bounded2.2s delay of only the first local scripted CLI startup reproduced this exact assertion on unchanged source. Recorded events show keepalive2 with runs=[] and notes=false; the native resumed server logs missing transcript; cleanup records exactly one CLI run with no --resume. The isolated baseline without delay passed. This proves the fixture race, not that the historical host incurred exactly2.2s or that load caused it.

A rejected guard-only candidate deferred resize_requested until a tool-start marker but still returned create before the tool existed. Under the unchanged virtual clock the activity paused as idle before the delayed CLI started. That failed native result is retained; it is not counted as green.

## Solution

The coordinator applied the reviewed correction to the test file. The scripted CLI records a tool_started marker immediately after emitting its initial tool-use event. For a resize fixture's initial create only, the fake backend waits for that actual milestone with the existing20s readiness helper before returning. The original second-keepalive resize stimulus and activity code remain unchanged. A permanent new native case invokes all the existing resize assertions with a2.2s first-CLI startup delay.

All20 original resize assertions, the20s readiness helper,30s completion bounds, and virtual-clock implementation remain byte/AST-identical. The prior first-keepalive/cancel+join case remains byte-identical. Candidate SHA2568e83a17a83e3b309a35bf30a20ea9105f2c23e2113efca38c28658e0f2f3e314; exact patch SHA2565d4dfb192d0a8fcc69f58927ebd2ab158279e1a6e73e324113934133fe83b210.

## Validation

Canonical pinned Python3.11 coverage runner, owning code-sessions domain, loopback production ws-server and scripted CLI; no provider/DB/auth calls.

- Original isolated resize baseline PASS2.5s.
- Original source with controlled initial CLI startup delay: exact original resumed-CLI assertion FAIL22.1s.
- Permanent delayed-start regression with the readiness correction absent: same assertion FAIL22.2s; with correction PASS4.5s.
- Four additional delayed-start repetitions PASS4.5/4.6/4.6/4.5s (five permanent-regression passes total).
- Full owning native domain including new regression:17/17 PASS18.9s; all prior16 cases retained.
- Wrong resume-ID negative: original --resume argv assertion FAIL2.2s.
- Missing tool-start marker negative: existing20s readiness fails, total21.7s. No request is silently blessed.

Native warnings about coverage's unimported config.py module remain in logs. Ruff was not available in the pinned environment or current PATH and was not installed; no lint success is claimed. Syntax/AST invariants and actual native execution passed. All49 observed ws-server process groups had no remaining members; all29 observed fixture homes were removed. Native owning proof is retained; combined full coverage and deployment remain pending.

## Archive relationship and references

Searched the literal error and behavioral resize/resume/session-home/WS vocabulary. The nearby2026-10-27-code-session-fixture-observed-before-attachment is a related readiness/ownership defect in another case; its first-test correction remains intact and passes. The2026-10-21 resize-RLS case and2026-10-24 Codex version-skew case have different first-bad boundaries. This is a distinct resize fixture issue, not evidence those runtime or DB fixes failed.

Read local golden references: codex/sdk/python/tests/app_server_harness.py174-188 waits on actual observed requests; openclaw/src/music-generation/runtime.resources.test.ts167 waits for provider start before lifecycle assertions; hermes-agent/tests/agent/test_deadline.py375-396 joins the owner and its cancellation; kimi-code/packages/klient/test/ipc.test.ts103-108 and claude-code-src/src/services/mcp/client.ts1565-1568 close resources in finally. They support observable readiness and joined cleanup, not changed runtime budgets.

## Coordinator constraints

No shared source, Git, case, INDEX, dependencies, services, production or Freedom changes; no new agents/worktrees. The coordinator scoped that independent lane to bounded native local fixtures and scratch proposals. No deadlines, assertion, virtual clock, acceptance or provider behavior was widened.

Final command identity proof: `bash .context/deploy-fresh-20261027/rca-code-session-resize/run-exact.sh` was run on both sides with identical environment and selected regression. Only the scratch caller file changed to add the initial fixture readiness gate. The red fails the original resumed-CLI assertion; green passes. See exact-red.log/exact-green.log. Final cleanup receipt:49 ws processes/groups and29 homes, none remaining.

## Human feedback

No additional user feedback was recorded. The standing constraints preserve Freedom, original acceptance rules and exact owned cleanup.

## Reusable lesson

Inject a CLI-originated lifecycle request only after observing that CLI conversation and its in-flight tool; retain a delayed-start regression and the original completion assertions.

## Combined native verification

At af4cde045 the complete agents coverage command passed with84% aggregate coverage in679.9s, including the original and permanent delayed resize cases. The coordinator joined its actual exit0 receipt. This verifies the owning corrections on that combined source; later source changes and deployment have separate acceptance. The original scheduling delay remains unmeasured.
