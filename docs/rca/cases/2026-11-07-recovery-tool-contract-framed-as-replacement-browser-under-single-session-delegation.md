---
id: 2026-11-07-recovery-tool-contract-framed-as-replacement-browser-under-single-session-delegation
date: 2026-11-07
title: Browser skipped recover_from_challenge on hotels.com DataDome because the tool contract described recovery as a replacement machine while the delegation forbade a replacement browser
surface: agents
component: rose-browser-use-tool-contract
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/browser_use.py BROWSER_USE_TOOLS["recover_from_challenge"] (+ browser_tools/schemas.py auth_cookies_are_preserved) described in-session recovery as moving to a "replacement machine" / exploring "machines" / searching other "browsers", so the browser LLM at browser_use_step_5/6 read it as the "replacement browser" its delegated goal forbade and chose wait/evaluate/attempt_completion instead
symptoms:
  - "Bot or Not?"
  - "If blocked, diagnose within this browser session and report the failure; do not spawn a replacement browser."
  - "I think we should only need a browser session."
  - "recover-challenge spans: 0; requested staged challenge recovery: 0"
  - "Expected payment_approval attention request (to ignore) but none was triggered"
tags:
  - browser-agent
  - recover-from-challenge
  - anti-bot
  - datadome
  - hotels-com
  - tool-description
  - delegation-contract
  - single-browser-session
  - payment-boundary
sources:
  - agent 917bf579-a615-4264-a637-024e706ae301 (browser-hotel-booking r2, e20 r002-j0013, fleet run 20261107-220205-156225; descend H-31 triage card 9)
  - agent 20695cc9-1712-4736-83f3-93fc09211998 (browser-hotel-booking e2 r002-j0038, fleet run 20261106-174349-2675487; triage card 4)
  - agent 414ea570 (browser-hotel-booking e20 r1 PASS, fleet run 20261107-212636-3543856; contrast)
  - fleet run 20261106-181714-26175 (challenged hotel copy that recovered after the same single-session hesitation)
  - fleet run 20261106-140015-2490081 (challenged hotel copy that recovered after the same single-session hesitation)
  - fleet run 20261107-212636-3543856 (e20 r1 pass; reasoning names the single-session conflict)
  - commit 05c2a73ec3 (payment-boundary suffix "Do not spawn a second browser agent if the first fails — report the failure instead.")
repro: agents/tests/blackbox/rose_browser_use.blackbox.py::test_recover_from_challenge_contract_stays_in_the_delegated_browser_session
status: open
---

## Problem

`browser-hotel-booking` e20 r2 (agent `917bf579`) timed out at 1125 s without
the expected `payment_approval`. The browser child's first `read_browser_state`
(22:13:55Z) already showed `https://www.hotels.com/ - Bot or Not?` with the
DataDome "Verification system" iframe; the direct Hotel-Search URL returned the
same page (HTTP 429 document, `/botOrNot/initial-validate` 403). The browser
then took `screenshot`, `read_network_requests`, `wait 20000`,
`read_browser_state`, `evaluate`, and `attempt_completion` (22:15:20Z) with a
blocked report. It never called `recover_from_challenge`: backend.log has 0
recover-challenge spans and worker.log has 0 "Browser agent requested staged
challenge recovery" / `antibot.episode` lines. The root then looped on 50%
verifier scores until timeout (separate cluster H-32). e2 r002-j0038 (agent
`20695cc9`) followed the identical path on the same page.

The tool was available: every browser call's tool list contained
`recover_from_challenge` (27 tools; `available_actions` includes it). No
classifier or gate ran: the challenge classifier runs only inside recovery,
which was never requested. The page state was unambiguous.

Exact decision inputs (extracted from the inline `llm.context.dumped`
gzip payloads in the runtime-evidence worker.log; archived as
`trace-archive/917bf579-.../llm/<dump_id>.json.gz.enc`):

- delegated goal (root `spawn_agent`, 22:13:43Z): "Use exactly this one browser
  agent for the entire browser task; ... If blocked, diagnose within this browser
  session and report the failure; do not spawn a replacement browser." The root
  derived it from the harness payment-boundary suffix (commit 05c2a73ec3):
  "Use exactly one browser agent for the entire task. Do not spawn a second
  browser agent if the first fails — report the failure instead."
- `recover_from_challenge` description: "... Set auth_cookies_are_preserved=true
  when the current session is logged in and the replacement machine must keep
  that authenticated state. Set auth_cookies_are_preserved=false to explore
  machines with a fresh cookie state ... searches ... Kernel residential, Kernel
  mobile, Kernel ISP, and Steel managed/fixed-IP browsers in parallel ...";
  parameter schema: "the new machine must maintain ...".
- browser reasoning at step 5 (dump `e1b85de30cef`, chose `wait`): "I wonder if
  we can use an automatic solver before just stopping ... I think we should only
  need a browser session."

## Diagnosis

Critical path: benchmark goal suffix -> root `spawn_agent` goal -> browser
system prompt + tool contract -> browser LLM decision -> `recover_from_challenge`
handler -> staged recovery. Data is correct through the browser state (challenge
visible, tool offered). It first goes wrong at the browser LLM decision, whose
inputs contain a contradiction: the delegation forbids a replacement/second
browser, and the only recovery tool describes itself as switching to a
replacement machine and searching other browsers. From the system's own
definition, recovery is in-session: the browser task id is unchanged, the
evaluator's `browser_agent_session_count` counts browser tasks, and recovery
returns to the current URL with storage preserved. The tool contract never said
so.

Reasoning in the challenged hotel copies that did recover shows the same
conflict resolved the other way: "conflicting situation where the user is
prohibited from opening another browser session" (e20 r1), "since the user
disallows handing off to another browser, automatic switching isn't an option.
Should I avoid calling?" (20261106-140015), "It seems I'm not allowed to spawn a
recovery myself" (20261106-181714). Across 9 challenged copies, 7 recovered and
2 reported failure.

Controlled replay (same messages, screenshots, tools, sampling params and
`xhigh` effort; `scripts/replicate_llm_dump.py --repeat`; served by
`openai/gpt-6.1-sol`, because the local Foundry leg returned RoseServerError,
whereas production served `gpt-6.1-sol` on Foundry; both arms used the same
path):

| decision call | arm | decisions (8 replays) |
| --- | --- | --- |
| step 6 (`db8c539f5261`) | recorded contract | evaluate 4, attempt_completion 2, goto 1, recover_from_challenge 1 |
| step 6 | fixed contract, delegation unchanged | recover_from_challenge 8 |
| step 5 (`e1b85de30cef`) | recorded contract | wait 7, recover_from_challenge 1 |
| step 5 | fixed contract, delegation unchanged | recover_from_challenge 8 |
| step 5 | recorded contract, only the delegated "If blocked ... replacement browser." sentence removed | recover_from_challenge 8 |

The last row shows that the trigger is the delegated failure/no-replacement
sentence interacting with the tool contract. The fixed-contract rows show that
stating recovery's session identity in the tool contract resolves it with the
delegation unchanged.

Step 5a ladder: Why 1, the browser reported failure instead of recovering ->
it read recovery as the forbidden replacement browser (replay rows above). Why
2, the tool contract described the internal machine/provider swap but not the
agent-observable effect: same browser agent, same task, same session. The
contract has no session-identity statement (grep: no other prompt or tool
defines it). Why 3 would be "user/benchmark delegations restrict browser count".
That is legitimate user input we must not rewrite, and a benchmark contract
(rule 25). Stop at Why 2.

Step 5b climb. Stopped class C: an LLM-visible tool contract describes an
in-session capability through its internal resource swap, so an
agent-observable delegation constraint (one browser agent/session, no
replacement browser) appears to forbid it. Next-deeper class tried, C+1:
delegations and tools share no single harness definition of the delegated unit
(browser session). Its fix would be a separate global "browser session"
definition in the browser system prompt or root spawn contract, kept in sync with
every tool. That is not coherent as a separate fix. The only harness-owned
statement of what a tool does to the session is that tool's own contract, so a
second definition duplicates it and becomes a second source of truth that must
agree with each tool (Step 6a). Rewriting the root's or the user's delegation
text instead edits legitimate user/benchmark input. The other deeper option
(harness auto-invokes recovery whenever a page looks challenged) needs a
page-challenge string classifier driving actions plus trajectory injection,
which CLAUDE.md 25a/25b and the recorded harness design call (truthful tool
results + model-called recovery) reject.

## Solution

On branch `rca/h-31-20261107`, not yet deployed:

- `agents/providers/rose/browser_use.py` `recover_from_challenge` description:
  added "Recovery is part of your current browser session: you stay the same
  browser agent on the same task, and it never starts another browser agent or
  a second browser session." Replaced "the replacement machine must keep that
  authenticated state" / "explore machines with a fresh cookie state" with
  session-relative wording ("must keep that authenticated state through
  recovery" / "allow a fresh cookie state"), and stated that the configuration
  search "moves this session onto it" and that "Successful recovery returns this
  session to the current URL". All stage, cost and when-not-to-use guidance is
  unchanged.
- `agents/browser_tools/schemas.py` `auth_cookies_are_preserved` field (the
  input_schema the model sees) and the model docstring use the same in-session
  wording.
- Regression: `test_recover_from_challenge_contract_stays_in_the_delegated_browser_session`
  in `agents/tests/blackbox/rose_browser_use.blackbox.py`, run by
  `python scripts/run_blackbox_tests.py rose-browser-use` and agent coverage.
  It builds the provider tools for the exact captured `available_actions` and
  asserts the session-identity statement and that no description or schema
  text says "replacement machine" / "new machine" / "explore machines". It
  failed on 268e9550b0 and passes on the fix. `phone_off_matches_prephone_bytes`
  is re-pinned: only the recovery-enabled tools hash changed.
- Tooling: `scripts/replicate_llm_dump.py` now supports `--repeat` panels for
  browser_use dumps, `--current-tools` (send this checkout's tool contract for
  the dump's recorded actions, messages unchanged), and `--expect NAME:MIN`
  (exit 2 below the minimum), covered by
  `scripts/tests/replicate-llm-dump-panel.test.py`.

Siblings: all 20 `success_on_payment_card_request` tasks get the same
single-browser/report-failure suffix, including every `anti-bot-*` task whose
purpose is challenge recovery. Any user delegation limiting browser count
collides the same way. 10k-agent behavior: static text only, with no added
calls, state or channels per agent.

Golden reference (`claude-code-src/src/tools/BashTool/prompt.ts:357`): the tool
contract states the agent-observable persistence ("The working directory
persists between commands, but shell state does not") rather than how the
process is hosted. `claude-code-src/src/services/compact/prompt.ts:345`: after
an internal context replacement the model is told "This session is being
continued", so continuity is stated, not inferred. `codex/codex-rs/core/src/tools/handlers/shell_spec.rs:148`:
"Writes characters to an existing unified exec session", which names session
identity in the tool contract. `hermes-agent/tools/browser_tool.py:800` reports
bot detection as an observation with options and has no in-session recovery
tool, so it is not an analog for identity. The fix converges on the shared
pattern: describe a tool's effect on the agent's own session in agent-observable
terms. Golden-reference adversarial review is pending with the parent.

Outcome proof (exact benchmark rerun) is pending with the descend parent, and
the prompt hunk awaits golden review. Status stays `open` until both land.

## Human feedback

None recorded.

## Reusable lesson

When an in-session tool swaps internal resources, state in its contract that the agent stays in the same session and task, so delegations limiting agent or session count cannot read it as forbidden.
