# Canonical Human Approval Request Format

This file is the single source of truth for human approval requests emitted by
`/RCA`, `/deploy`, and `/descend`. Read it completely immediately before
composing any approval request. Do not replace it with a shorter free-form
summary, and do not rename, reorder, or omit its seven required sections
(Before Behavior, After Behavior, How, TL;DR, Evidence, Detail, Downstream
Implications). Present them exactly as described in Presentation below.

Every approval request first passes the Golden-reference adversarial review at
the end of this file. A `GROUNDED` verdict clears change approvals without the
user; only the other verdicts reach the user.

Use one approval ID per snapshot-scoped decision. Group hunks only when one
decision necessarily covers them together. Include clickable file-and-line links
for every code, prompt, instruction, test, configuration, or migration hunk in
scope.

**Prompt / LLM-visible text approvals MUST paste the exact diff inline.** A
`path:line` link alone is not enough for prompt, instruction, skill, command,
tool-description, or other LLM-visible text. In Detail, inside the approval
code block, show the precise unified diff or before/after text the human is
approving — every added/removed line as `+`/`-` lines — so they can review it
without opening the file. Saying "see the file" or linking the path without the
diff body is invalid for prompt-scoped approvals.

## Presentation

Render each approval ID as one fenced `text` code block, followed immediately
by a short Links list. The block keeps alignment and line breaks readable in a
terminal; it does not render Markdown, so write every field as a plain label
(`What failed:`, not bold) and never put headings, tables, or Markdown links
inside it. The sections below show field labels in bold only to define them.

Use the same visual styling as `/deploy` Step 15 and the benchmark scorecard:
64-column `━` outer borders, `─` section separators, a `🔐 APPROVAL` header,
the approval ID/subject, and `⏳ AWAITING DECISION`. Keep the seven required labels
and their order exactly; the frame is decoration, not another content section.
Apply this styling to every approval from `/RCA`, `/deploy`, `/descend`, or other
skills that reference this file. Use one approval block per snapshot decision.
Show actual start/block timestamps and elapsed ages when reporting a pending
approval in the parent benchmark card. Continue independent authorized work;
presentation does not create additional approval gates.

Inside the frame, `Before:` and `After:` are always the first two content items,
followed by `How:`, `TL;DR:`, `Evidence:`, `Detail:`, `Downstream:`, and the response
syntax. The whole message for one approval has exactly this shape (the outer
four-backtick fence only delimits the example):

````markdown
### <approval-id> · <one-line subject>

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 🔐 APPROVAL <approval-id> · ⏳ AWAITING DECISION
 <one-line subject>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before:
  <observable behavior before the change or action>
────────────────────────────────────────────────────────────────
After:
  <the same trigger and ordering after the change or action>
────────────────────────────────────────────────────────────────
How:
  <one concise sentence naming how the fix or action is implemented>
────────────────────────────────────────────────────────────────
TL;DR:
  <exactly one sentence>
────────────────────────────────────────────────────────────────
Evidence:
  What failed: When <the agent doing the task goal>, <it reached this step or
    site>, the LLM called `<tool>` to <attempt>, and <this broke, with the
    measured result>.
  FE link: <verification status> — see Links
  LLM dump: last call `<call_site>` on `<agent_id>` — see Links
  Local repro (<wall-clock>):
    Tests: <one sentence naming the actual assertion>
    1. <copy-paste command>
    2. <next step>
    Pre-fix: <measured wrong value>
    Post-fix: <measured passing value>
  Golden reference: <reference-repo>/<path>:<line> — <what the reference
    harness does>; this change <converges on it | diverges from it because
    <reason>>.
  Golden review: <NOT_GROUNDED | HUMAN_REQUIRED> by `<reviewer agent id>` @
    <snapshot> — <blocking findings or operational reason>
  Environment:
    Evaluators: `<id>` — <how checked>: <what is checked>. Catalog:
      `<method>` / `<check.type or judge>`
    Fixtures: base `<image>`; db `<db_fixtures or none>`; live overlay
      `<live_fixtures or none>`
    Task prompt:
      <full exact task.prompt with every line and character preserved>
────────────────────────────────────────────────────────────────
Detail:
  <why the change is needed, first-bad boundary, unchanged test before/after>
  Snapshot: <approval snapshot ID or Git SHA>
  Scope: <path:line> — <hunk summary>   (one line per in-scope hunk)
  <exact diff of every prompt / LLM-visible hunk, as +/- lines>
────────────────────────────────────────────────────────────────
Downstream:
  Severity: <🟢 LOW | 🟡 MODERATE | 🟠 HIGH | 🔴 CRITICAL> — <effect>
  Future prod trajectories affected: <estimated % or range> — <basis>
  Risk: <🟢 LOW | 🟡 MODERATE | 🟠 HIGH | 🔴 CRITICAL> — <reason>
  <users, agents, services, data, cost, security, rollback, 10k-agent impact>
────────────────────────────────────────────────────────────────
Approve: <approval-id> approve
Reject:  <approval-id> reject: <reason>
Edit:    <approval-id> edit: <instruction>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

- **FE link:** [Open agent](<frontend-agent-url>) — <verification status>
- **LLM dump:** [Open rendered dump](<rendered-html-url>) — last call `<call_site>` on `<agent_id>`
- **Scope:** [`<path>:<line>`](<path>#L<line>) — one clickable link per in-scope hunk, matching Detail's Scope lines
````

Rules:

- The Links list sits immediately below the block because only Markdown
  outside the block is clickable.
- Hard-wrap prose inside the block at about 80 characters and indent
  continuation lines, so nothing scrolls sideways. Never reflow the task prompt
  or diff lines; copy them verbatim.
- When block content itself contains three backticks, fence the block with
  four or more backticks so it cannot close early.
- Every URL and file link must appear in the Links list. A link that exists
  only inside the block is not clickable and does not count as present.
- Outside the block and Links list, add only the one heading line naming the
  approval. Do not restate the block in prose.
- Omit the `Edit:` line when the owning workflow does not support edits.

## Before Behavior

`Before:` is the first item in the block. Describe the observable behavior
before the proposed change or action. State the triggering conditions,
ordering, failure mode, and user-visible result. Avoid implementation-only
shorthand.

## After Behavior

`After:` comes second. Describe the observable behavior after the proposed
change or action. State the same triggering conditions and ordering so the
human can compare it directly with Before Behavior. Call out what is
intentionally unchanged.

## How

`How:` comes immediately after After: and immediately before TL;DR: exactly
one concise sentence explaining how the fix was made or the action will be
performed. Name the actual mechanism, such as runtime harness injection,
prompt or schema editing, application logic, configuration, or an operational
command, and what it changes. For runtime harness injection, say what enters
the agent's context and where; identify synthetic context when injected.
Describe the mechanism in plain language, keeping exact diffs and detailed
implementation reasoning in Detail.

## TL;DR

`TL;DR:` follows How: exactly one sentence stating, in plain language,
what the human is approving and its single most important consequence. Together
with Before, After, and How it must let the reader decide without reading further;
the sections below justify it.
Never omit it, never exceed one sentence, and never hide a cost, risk, or
irreversibility here that the later sections reveal — if it is in Downstream
Implications, its headline belongs in the TL;DR.

## Evidence

Put the inspectable artifacts here, before the argument. Render this exact
shape inside the block — labeled lines, not a prose paragraph — with each URL
repeated as a clickable entry in the Links list. Do not bury these in Detail.
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
outcome, not a generic dashboard. Prefer the durable always-on viewer
`https://www.roselabs.ai/?agent-id=<id>` (Terminal deep link; hub archive
fallback `https://roselabs.ai/?agent-id=<id>`) — never a
localhost, ngrok, trycloudflare, or ephemeral hub URL that dies when the stack
tears down. Check it immediately before presenting the
approval and report `verified rendered`, `verified reachable` (when only an HTTP
and agent-data probe is available), or `expired/unreachable` honestly.
FE link validation also requires every `spawn_browser_agent` task on that agent to be terminated (`action_type=task_complete`) with a correctly attached recording (`recording_view_url` or `recording_file_pointer` on a FINISHED recording message) — `publish_evidence_links.py` fails closed when either is missing.
Never omit the FE link, substitute a run JSON path, or imply that a dead localhost
viewer works. Do not link undeployed `/open-agent` paths that render the SPA
NotFound copy (`Oops! Page not found`) while HTTP stays 200 — use
`https://www.roselabs.ai/?agent-id=<id>` instead. Before requesting approval,
run `python3 scripts/publish_evidence_links.py --agent-id <id>` so the FE link
and last-call LLM dump are durable for multi-day review. Never link `file://…/.context/rendered-llm-dumps/…` without the HTTPS URL the publisher prints. If the workflow can restore an archived viewer without rerunning a
gated action, restore it before requesting approval.

**LLM dump:** [Open rendered dump](<rendered-html-url>) — last call `<call_site>` on `<agent_id>`

Render the last LLM call in the entire trajectory — root agent plus every
spawned sub-agent. Collect `.llm-dumps/<agent_id>/*.json` for all of those
ids, sort by the millisecond prefix in the filename, and render the latest
file with `python3 scripts/render_llm_dump.py <dump> --no-open`. Link the
**HTTPS URL** the renderer prints on stdout (R2 presigned when `R2_*` is
configured). Never link a VM-local path such as `/opt/cursor/artifacts/*.html`,
`vscode-remote://…`, or `file://…` — those open blank/broken pages for remote
reviewers in Cursor Browser. The HTML must be self-contained (browser recording
frames inlined as data URIs; never `file://` frame paths). If frames are missing
or unreadable, omit the recording player entirely — never attach an
invalid/broken recording section. As a secondary check, also embed a screenshot
of the rendered dump via an `<img src="/opt/cursor/artifacts/…">` tag when
available. Never pick an earlier failing call, a directory listing, or raw JSON.
If there was no LLM call, write `**LLM dump:** Not applicable — <reason>`.

**Local repro (<wall-clock>):**

Tests: <one sentence naming the actual assertion — the behavior or value under test, not the file name>

Numbered, copy-pasteable steps a human can run unchanged. `<wall-clock>` is the
actual time you measured running this owning-boundary repro (for example
`1m 42s`), not an estimate and not the full benchmark duration. Then:

- Pre-fix: <measured wrong value>
- Post-fix: <measured passing value>

Do not replace the measurement with “the test failed” or “the test passed.”
Do not omit `Tests:`; a command list without saying what is asserted is invalid.

**Golden reference:** `<reference-repo>/<path>:<line>` — <what the reference harness does in this situation, in one sentence>; this change <converges on it | diverges from it because <reason>>.

Name the implementation in a reference harness that handles the same problem:
`claude-code-src/` (vendored), `openclaw/`, `hermes-agent/`, `codex/`, or
`kimi-code/` (run
`bash scripts/sync-reference-repos.sh` when a clone is missing). Cite a real
`path:line` you opened in this session, one line per repo that has an analog,
and say for each whether the proposed change moves Rose toward it. These
harnesses are heavily tested, so the default fix is the one that brings Rose
closer to them; a change that moves away from all of them must say why their
approach does not fit. Look the references up before designing the fix, not
after the request is questioned. When no reference repo has an analog, write
`Not applicable — <which repos you searched and for what>`. Never cite a
reference from memory, and never cite only the repo name.

**Golden review:** `<NOT_GROUNDED | HUMAN_REQUIRED>` by `<reviewer agent id>` @ `<snapshot>` — <every blocking finding, or the operational reason a human must decide>.

The verdict of the Golden-reference adversarial review below. A `GROUNDED`
packet never reaches the user, so this line says why this one did.

**Environment**

- **Evaluators:** one line per catalog evaluator, in this shape:
  `<id>` — **<how checked>**: <what is checked>. Catalog: `<method>` / `<check.type or judge>`.
  `<how checked>` must be one of `semantic`, `exact string`, `regex`, `count`,
  or `status`. Map `single_turn_llm_judge` and `agentic_llm_judge` to
  `semantic`. For `static_check`, name the real mechanism of each `checks[].type`
  (exact string, regex, count, status) — never stop at the method name.
- **Fixtures:** base `<image>`; db `<db_fixtures or none>`; live overlay
  `<live_fixtures or none>`
- **Task prompt:** indented under the label in the block:

  <full exact task.prompt with every line and character preserved>

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
Then list the complete scope as `Scope:` lines in the block and as clickable
file-and-line links in the Links list.

When any in-scope hunk is prompt / LLM-visible text, also paste that hunk's
**exact diff inline** in this section (unified diff or explicit before→after)
inside the block. The human must be able to read the full approved text change
in the approval message itself; file links are additive context, not a
substitute for the diff.

## Downstream Implications

Start with these three labeled lines, in this order:

- `Severity:` an emoji and level describing the consequence for an affected
  production trajectory: 🟢 LOW (minor/reversible effect), 🟡 MODERATE (meaningful
  degradation or recovery), 🟠 HIGH (task failure or major service/data impact),
  🔴 CRITICAL (broad outage, irreversible loss or severe security/privacy impact).
  Give a brief concrete effect; severity is distinct from the scope of exposure.
- `Future prod trajectories affected:` the estimated percentage or range of
  future real product trajectories whose behavior this change would affect,
  whether positively or negatively. State the affected path/cohort and basis
  (production usage sample and window, or source/route coverage). Use all future
  product trajectories as the denominator; exclude benchmarks, tests and synthetic runs.
  Label projections as estimates; this is exposure, not a predicted failure rate.
  Do not invent a percentage or infer it from benchmark pass rates. If evidence
  cannot support a numeric estimate, write `— unknown: <reason and measurement
  needed>`. Use 0% only when the unchanged production boundary is demonstrated.
- `Risk:` an emoji and level (🟢 LOW, 🟡 MODERATE, 🟠 HIGH, 🔴 CRITICAL)
  describing the likelihood and consequence of regression from this specific
  change, with its evidence, uncertainty and mitigation/rollback. Do not equate
  a large affected percentage with high risk or a passing test with zero risk.

When severity or risk cannot be assessed, use `⚪ UNKNOWN — <reason>` instead
of guessing. Keep all three labels even when their values are unknown.

Describe affected users, agents, services, data, costs, security/privacy,
retries, compatibility, and operational rollback or recovery. Explicitly state
when an area has no known impact. For hot agent paths, include the 10k-agent
implication.

End the block with unambiguous response syntax, one line each:

- `Approve: <approval-id> approve`
- `Reject:  <approval-id> reject: <reason>`
- `Edit:    <approval-id> edit: <instruction>` when the owning workflow
  supports edits

An approval is invalid if downstream severity, the estimated future production
trajectory percentage/basis (or explicit unknown reason), or emoji risk level is
missing. An approval is invalid if it is not one code block followed by the Links list,
if Before: and After: are not its first two items, or if any required section,
Evidence field, in-scope file
link, **What failed:** task-framed sentence, concrete FE agent link, last-call
rendered LLM dump, local-repro `Tests:` sentence plus steps and measured
wall-clock, **Golden reference:** citation, or Environment triple (evaluators
with how they are checked, fixtures, task prompt) is missing, or if it reaches
the user without its **Golden review:** verdict. For prompt / LLM-visible
text approvals it is also invalid if the
exact diff body is omitted or replaced by a file link alone. `Not applicable — <reason>` counts as present; a blank field does
not. Approval remains snapshot-scoped: if an in-scope hunk changes, issue a new
approval ID and present all seven sections again.

## Golden-reference adversarial review

Every approval request passes this review before it reaches the user. Draft
the complete packet first; the reviewer reads the packet, not a summary.

Scope: only the hunks inside the mandatory user-approval section, meaning the
hunks a gate flagged for human approval (deploy Steps 0p/0b/0c, Zod schema
changes, `/RCA` or `/descend` harness-fix packets). Never ground the rest of
the diff: ordinary code, tests and UI changes outside that scope need no
golden citation and are not reviewed here.

1. **Reviewer.** Fire a fresh sub-agent that did not author the change. It
   inherits the parent's model, reasoning effort and speed (CLAUDE.md
   Sub-agent delegation), works read-only in an existing checkout, and is told
   to refute the grounding, not to confirm it. Give it the approval ID,
   snapshot, exact diff of every in-scope hunk and the drafted packet.
2. **Checks.** The reviewer must:
   - research at least the three most relevant open-source references for
     the hunk's mechanism itself, choosing by closeness to the change and
     reading their actual code or prompts, and name each with the `path:line`
     it opened. Fewer than three opened is `NOT_GROUNDED`; a reference cited
     in the packet does not count unless the reviewer opened it and decided
     its verdict from what it found;
   - open every cited golden reference itself (run
     `bash scripts/sync-reference-repos.sh` when a clone is missing) and
     confirm that the `path:line` exists and does what the packet claims,
     with its concrete values;
   - map every in-scope hunk to a reference behavior; a hunk without an
     analog, a citation from memory or a bare repo name is ungrounded;
   - search the other references for contrary practice and confirm that the
     change converges on their shared pattern with the same mechanism and
     comparable limits, and is no broader than the reference; an unexplained
     or weak divergence is ungrounded;
   - confirm that the packet is otherwise valid under this file and that the
     change breaks no CLAUDE.md hard rule (reward hacking, runtime nudges,
     string-matching classifiers, 10k-agent scaling). A reference doing it does
     not override a repo rule.
3. **Verdict.** Return one verdict per approval ID: `GROUNDED` only when every
   hunk passes, otherwise `NOT_GROUNDED` with every blocking finding listed
   together. Operational approvals return `HUMAN_REQUIRED` after the packet
   check: writing env vars or credentials, billing or spend beyond existing
   authorization, destructive or irreversible actions, explicit gate overrides,
   and benchmark definition, pass-criteria or timeout changes.
4. **`GROUNDED` clears the human gate.** The change passes every manual
   human-review gate for deploy (`/deploy` Steps 0p, 0b and 0c, Zod schema
   changes) and the `/RCA` or `/descend` harness-fix decision without reaching
   the user. Record the approval ID, snapshot, reviewer agent ID and verified
   citations where the human decision would have been recorded (`TEST_REPORT`,
   PR body, `/descend` ledger), and list cleared approvals in the final
   handoff. Do not emit `approval-request` or `approval-decision` factory
   events for it; those measure human waits.
5. **Otherwise the user decides.** Fix the findings and review again once if
   the bytes change, or send the packet with the verdict on its
   `Golden review:` line. An explicit user rejection, or a user instruction to
   review a specific change personally, always wins.

The verdict is snapshot-scoped: any change to an in-scope hunk needs a new
review.
