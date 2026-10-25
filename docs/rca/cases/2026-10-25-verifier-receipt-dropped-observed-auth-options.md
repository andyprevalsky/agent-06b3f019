---
id: 2026-10-25-verifier-receipt-dropped-observed-auth-options
date: 2026-10-25
title: Browser verifier graded a saved-password sign-in as "a different account" because the read receipt dropped the observed Auth Options
surface: agents
component: browser-action-history-verifier-receipt
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/dom_service.py ActionHistory.attach_observed_result copied url/title/formatted_state but not auth_context onto the receipt that build_browser_verifier_context grades from
symptoms:
  - "Tool 'spawn_browser_agent' exceeded its exact root call limit during execution: expected 1, got 2."
  - "It does not establish the optional member_number for the user's stated account, so that field is omitted."
  - "Target account not authenticated; member number for a@roselabs.ai unverified."
  - browser-auth-stale-session-password root spawns a second browser to "Verify Rose Shop membership number"
tags:
  - browser-verifier
  - auth-options
  - double-spawn
  - expected-tool-counts
sources:
  - agent 0c3d6aa4-ddfa-4eca-9ba9-e3365b54d4cf (descend-full69-20261023 r002-j0050 on 016fca859)
  - commit dddce7ad8 (branch rca/STALE-double-browser)
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_observed_sign_in_options_reach_verifier_receipt
status: mitigated
---

## Problem

browser-auth-stale-session-password failed one of two copies with
`spawn_browser_agent` expected 1, got 2. The two spawns had distinct tool_call_ids
(`call_dfb765…`, `call_d075a4…`), so this was not a Temporal activity retry. The
first browser was told by the root "the user's account email is a@roselabs.ai"
(the root restated the profile; replay of that call: 2/10). The browser correctly
followed Auth Options: expired cookie rejected, then the saved password for
`andy.prevalsky.a678ef35ee35@example.com` signed in and the account page showed
RS-33987668 (auth-test-site trail: session rejected → password signed_in). The
browser verifier (dump 7a10832ada02) then omitted `member_number`: "associates it
with Andy Prevalsky at a different email address". The root received
"Target account not authenticated; member number for a@roselabs.ai unverified"
and spawned a second browser to verify.

## Diagnosis

The browser agent's read_browser_state result carried `auth_context.auth_options`
listing that saved password as this site's account (seen in browser dumps
a223c8ea2221 / 62482b54a333). `execute_action` attaches that context only after
the action is recorded, then calls `ActionHistory.attach_observed_result`, which
copied url/current_url/title/formatted_state and dropped `auth_context`. The
verifier builds its whole evidence set from those receipts, so it graded with
less evidence than the actor had and saw only a goal-stated email that disagreed
with the signed-in email. Deeper rung: verifier evidence is a projection of
receipts, and any harness-observed field not copied to the receipt is invisible
to grading; auth_context was the field that legitimises a sign-in identity. Next
"why" (the root restating the profile despite BROWSER_GOAL_PROFILE_NOTE) is model
behaviour against an existing instruction, not the first bad data.

Replay of the exact verifier call, 15 trials each: buggy context withheld the
member number 8/15; the fixed context (action log rendered by the fixed code) 2/15.
Replay of the root's follow-up call with the bad result: 1/5 re-spawn.

## Solution

`attach_observed_result` now copies the observed `auth_context` (through
`model_visible_value`) onto the exact receipt, storing it only when it differs
from the latest recorded inventory, so the verifier's action log shows the same
sign-in options the agent saw without repeating ~1.2 KB on every read. No prompt
or tool text changed. Also fixes the same omission for resumed browsers that
restore receipts. 10k-agent behaviour: per-browser in-memory receipt field; no
shared state. Known edge: an inventory recorded more than 30 receipts earlier
ages out of the verifier's window.

Golden reference: claude-code-src/src/tools/AgentTool/built-in/verificationAgent.ts:132
passes the verifier the original task and the approach taken, so it grades with
the implementer's context; this fix converges on that. Respawn vs continue:
claude-code-src/src/tools/AgentTool/prompt.ts:267 (continue a spawned agent via
SendMessage); not changed here because the respawn followed a false negative.

Status is `mitigated`, not `fixed`. The failure needs three links together: the
root restates the profile email in the browser goal (2/10 replays, despite
BROWSER_GOAL_PROFILE_NOTE), the verifier withholds the number (8/15 before, 2/15
after), and the root re-spawns on that result (1/5). Roughly 2%/run before and
0.5%/run after; 8/15 vs 2/15 is p~0.05. The root's restatement is a separate open
cause (an approval-gated prompt question), and outcome proof (exact task failing
on the buggy revision) was not reproduced at that rate.

## Human feedback

None recorded.

## Reusable lesson

When a verifier rejects work the actor did correctly, diff the verifier's evidence against the actor's tool results and copy every harness-observed field the decision depends on onto the receipt.
