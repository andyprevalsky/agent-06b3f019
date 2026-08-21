# Canonical Human Approval Request Format

This file is the single source of truth for human approval requests emitted by
`/RCA`, `/deploy`, and `/descend`. Read it completely immediately before
composing any approval request. Do not replace it with a shorter free-form
summary, and do not rename, reorder, or omit its six required sections
(TL;DR, Evidence, Detail, Before Behavior, After Behavior, Downstream
Implications).

Use one approval ID per snapshot-scoped decision. Group hunks only when one
decision necessarily covers them together. Include clickable file-and-line links
for every code, prompt, instruction, test, configuration, or migration hunk in
scope.

## TL;DR

Open with a `## TL;DR` section: exactly one sentence stating, in plain language,
what the human is approving and its single most important consequence. It must
let the reader decide without reading further; the sections below justify it.
Never omit it, never exceed one sentence, and never hide a cost, risk, or
irreversibility here that the later sections reveal — if it is in Downstream
Implications, its headline belongs in the TL;DR.

## Evidence

Put the inspectable artifacts here, before the argument. Render this exact
shape — labeled lines, not a prose paragraph. Do not bury these in Detail.
Each field is required; when a field does not apply, keep the label and write
`Not applicable — <reason>`. Inventing a URL or omitting the reason is invalid.

**What failed:** When <the agent doing the task goal>, <it reached this step or site>, the LLM called `<tool>` to <attempt>, and <this broke, with the measured result>.

This is the sentence a human reads first. It must frame the failure inside the
agent's goal, not as a free-floating metric. Required beats, in order: the task
the agent was doing, the step in the trajectory (spawn, site, page), the exact
tool the LLM called (backticked name from the dump — `rotate_ip`, not a paraphrase
like "tried to rotate proxies"), what that tool was for, and how it failed.

Example:

> When the browser agent spawned to buy the three named products and hit /test_payment, the LLM called `rotate_ip` to rotate proxies, and /api/browser-session/rotate-proxy returned HTTP 400 so the session never started.

Invalid if deleting the task goal still leaves a grammatical sentence (`proxy
generation returned HTTP 400` is the smell). Invalid if the attempt is described
without the tool name. Do not paraphrase the tool; copy it from the dump. If the
LLM never called a tool, write `no tool call — the LLM <what it did instead of
the expected tool>`. Do not start from the bug; start from the goal.

**FE link:** [Open agent](<frontend-agent-url>) — <verification status>

The URL must open the concrete agent run that proves the reported failure or
outcome, not a generic dashboard. Prefer the durable always-on deep link
`https://www.roselabs.ai/open-agent?agent-id=<id>` (Hub-archive rehydrate). Do
**not** cite an ephemeral localhost / ngrok / trycloudflare FE as the approval
Evidence link — those die when the isolated stack tears down. Before presenting
approval, run `python3 scripts/publish_evidence_links.py --run-json <run.json>
--agent-id <id>` (or confirm the run was dual-written to the durable Hub) and
probe agent detail until messages are present. Check the link immediately before
presenting the approval and report `verified rendered`, `verified reachable`
(when only an HTTP and agent-data probe is available), or `expired/unreachable`
honestly. Never omit the FE link, substitute a run JSON path, or imply that a
dead localhost viewer works. If the workflow can restore an archived viewer without rerunning a gated action, restore it before requesting approval.

**LLM dump:** [Open rendered dump](<rendered-html-url>) — last call `<call_site>` on `<agent_id>`

Render the last LLM call in the entire trajectory — root agent plus every
spawned sub-agent. Collect `.llm-dumps/<agent_id>/*.json` for all of those
ids, sort by the millisecond prefix in the filename, and publish with
`python3 scripts/publish_evidence_links.py --agent-id <id>` (or
`python3 scripts/render_llm_dump.py <dump> -o /opt/cursor/artifacts/rca_evidence/<agent_id>/last_llm_call.html --no-open`).
Link the **Cursor artifact path** under `/opt/cursor/artifacts/…` (multi-day
reachability in the agent UI). Never link `file://…/.context/rendered-llm-dumps/…`
alone — those are workspace-local and are not the durable Evidence URL. Never
pick an earlier failing call, a directory listing, or raw JSON. If there was no
LLM call, write `**LLM dump:** Not applicable — <reason>`.

**Local repro (<wall-clock>):**

Tests: <one sentence naming the actual assertion — the behavior or value under test, not the file name>

Numbered, copy-pasteable steps a human can run unchanged. `<wall-clock>` is the
actual time you measured running this owning-boundary repro (for example
`1m 42s`), not an estimate and not the full benchmark duration. Then:

- Pre-fix: <measured wrong value>
- Post-fix: <measured passing value>

Do not replace the measurement with “the test failed” or “the test passed.”
Do not omit `Tests:`; a command list without saying what is asserted is invalid.

**Environment**

- **Evaluators:** one bullet per catalog evaluator, in this shape:
  `<id>` — **<how checked>**: <what is checked>. Catalog: `<method>` / `<check.type or judge>`.
  `<how checked>` must be one of `semantic`, `exact string`, `regex`, `count`,
  or `status`. Map `single_turn_llm_judge` and `agentic_llm_judge` to
  `semantic`. For `static_check`, name the real mechanism of each `checks[].type`
  (exact string, regex, count, status) — never stop at the method name.
- **Fixtures:** base `<image>`; db `<db_fixtures or none>`; live overlay
  `<live_fixtures or none>`
- **Task prompt:**

> <full exact task.prompt with every line and character preserved>

Never truncate, summarize, or paraphrase the task prompt. For a non-catalog
approval (no benchmark task), keep the three labels and write
`Not applicable — not a catalog task` on each.

## Detail

State why the change or action is needed and what first-bad boundary it fixes.
For a code, prompt, test, or behavior change, name the exact unchanged test or
reproduction command that failed before the change and now passes because of
it. Include the concrete before failure and after result—not merely “red” and
“green.” Do not restate the Evidence pack here; point at it.

If the change is proactive and there was no pre-existing failing test, say
`No pre-existing failing test` and name the new regression test, the gap it
demonstrated on the pre-change snapshot, and its passing result after the
change. Never invent a failing test.

For a non-code operational approval where a test cannot apply—such as writing
an environment variable, incurring a new paid resource, or performing a
destructive action—say `Test evidence: Not applicable` and provide the exact
read-only evidence and post-action verification instead. Local repro in
Evidence uses the same `Not applicable — <reason>` form.

List the approval snapshot ID or Git SHA when the approval is snapshot-scoped.
Then list the complete scope as clickable file-and-line links.

## Before Behavior

Describe the observable behavior before the proposed change or action. State
the triggering conditions, ordering, failure mode, and user-visible result.
Avoid implementation-only shorthand.

## After Behavior

Describe the observable behavior after the proposed change or action. State
the same triggering conditions and ordering so the human can compare it
directly with Before Behavior. Call out what is intentionally unchanged.

## Downstream Implications

Describe affected users, agents, services, data, costs, security/privacy,
retries, compatibility, and operational rollback or recovery. Explicitly state
when an area has no known impact. For hot agent paths, include the 10k-agent
implication.

End with one explicit approval question and unambiguous response syntax:

- **Approve:** `<approval-id> approve`
- **Reject:** `<approval-id> reject: <reason>`
- **Request an edit** when the owning workflow supports edits:
  `<approval-id> edit: <instruction>`

An approval is invalid if any required section, Evidence field, in-scope file
link, **What failed:** task-framed sentence, concrete FE agent link, last-call
rendered LLM dump, local-repro `Tests:` sentence plus steps and measured
wall-clock, or Environment triple (evaluators with how they are checked,
fixtures, task prompt) is missing. `Not applicable — <reason>` counts as present; a blank field does
not. Approval remains snapshot-scoped: if an in-scope hunk changes, issue a new
approval ID and present all six sections again.
