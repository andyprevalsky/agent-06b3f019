# Canonical Human Approval Request Format

This file is the single source of truth for human approval requests emitted by `/RCA`, `/deploy`, and `/descend`. Read it completely immediately before composing any approval request.

## General

- Never replace this format with a shorter free-form summary, and never rename, reorder or omit its seven required sections (Before Behavior, After Behavior, How, TL;DR, Evidence, Detail, Downstream Implications); present them exactly as in Presentation.
- Every approval request first passes the Golden-reference adversarial review (last section); a `GROUNDED` verdict clears change approvals without the user, and only the other verdicts reach the user.
- Use one approval ID per snapshot-scoped decision; group hunks only when one decision necessarily covers them together.
- **Approvals MUST show the key visible strings, never code diffs.** The human judges the wording that ships, not the code around it.
- Key strings are every user- or model-visible string the change adds, changes or removes: prompt, instruction, skill, command and tool-description text, tool results and errors, user-facing messages and handoff text, including text built at runtime; quote each in Detail, inside the approval code block.
- Format each for reading: the verbatim string, who sees it (the user or the model) and the conditions under which it appears (trigger, phase, call site).
- For schema or API changes, list the new or changed fields in plain English: name, type, required or optional, and what each means.
- Never paste a unified diff, code or `+`/`-` lines. Saying "see the file" or linking the path without the strings themselves is invalid.
- Include clickable file-and-line links for every code, prompt, instruction, test, configuration, or migration hunk in scope; they are additive context in the Links list and never replace the content.
- Continue independent authorized work while an approval is pending; presentation creates no additional approval gates.
- When the parent benchmark card reports a pending approval, show its actual start/block timestamps and elapsed ages.

## Presentation

- Render each approval ID as one fenced `text` code block followed immediately by a short Links list, in exactly the shape below (the outer four-backtick fence only delimits the example).
- The block does not render Markdown: write every field as a plain label (`What failed:`, not bold) and never put headings, tables or Markdown links inside it; the sections below show labels in bold only to define them.
- Style it like the `/deploy` and benchmark scorecards (64-column `━` outer borders, `─` section separators, a `🔐 APPROVAL` header with the approval ID/subject, `⏳ AWAITING DECISION`) for every approval from `/RCA`, `/deploy`, `/descend` or any skill that references this file; the frame is decoration, not another content section.
- Inside the frame, `Before:` and `After:` are always the first two items, followed by `How:`, `TL;DR:`, `Evidence:`, `Detail:`, `Downstream:` and the response syntax; keep these labels and their order exactly.

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
  Key strings:
    <New | Changed | Removed> · seen by <the user | the model> when
      <condition: trigger, phase or call site>
      "<the exact visible string, verbatim>"
      Was: "<the previous wording>"   (Changed only)
  Schema/API fields:
    <field> — <type, required or optional>: <plain-English meaning>
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

- The Links list sits immediately below the block because only Markdown outside the block is clickable; every URL and file link must appear there, and a link that exists only inside the block does not count as present.
- Hard-wrap prose inside the block at about 80 characters and indent continuation lines so nothing scrolls sideways; never reflow the task prompt or a quoted key string, copy them verbatim.
- When block content itself contains three backticks, fence the block with four or more backticks so it cannot close early.
- Outside the block and Links list, add only the one heading line naming the approval; never restate the block in prose.
- End the block with the `Approve:`, `Reject:` and `Edit:` response lines, one each; omit `Edit:` when the owning workflow does not support edits.

## Before Behavior

- `Before:` is the first item: the observable behavior before the proposed change or action, with its triggering conditions, ordering, failure mode and user-visible result, and no implementation-only shorthand.

## After Behavior

- `After:` comes second: the observable behavior after the change or action under the same triggering conditions and ordering, so the human can compare it directly with Before, calling out what is intentionally unchanged.

## How

- `How:` comes immediately after `After:` and immediately before `TL;DR:`: exactly one concise, plain-language sentence explaining how the fix was made or the action will be performed.
- Name the actual mechanism, such as runtime harness injection, prompt or schema editing, application logic, configuration, or an operational command, and what it changes.
- For runtime harness injection, say what enters the agent's context and where, and identify synthetic context when injected.
- Keep the key strings and detailed implementation reasoning in Detail.

## TL;DR

- `TL;DR:` follows `How:`: exactly one plain-language sentence stating what the human is approving and its single most important consequence; never omit it or exceed one sentence.
- Together with Before, After and How it must let the reader decide without reading further; the later sections justify it.
- Never hide a cost, risk or irreversibility that a later section reveals: if it is in Downstream Implications, its headline belongs in the TL;DR.

## Evidence

- Put the inspectable artifacts here, before the argument, as the labeled lines of the template, not a prose paragraph and never buried in Detail.
- Every field is required; when one does not apply, keep its label and write `Not applicable — <reason>`. Inventing a URL or omitting the reason is invalid.
- **What failed:** When <the agent doing the task goal>, <it reached this step or site>, the LLM called `<tool>` to <attempt>, and <this broke, with the measured result>.
  - This is the sentence a human reads first: frame the failure inside the agent's goal, never as a free-floating metric, and start from the goal, not the bug.
  - Required beats, in order: the task the agent was doing, the step in the trajectory (spawn, site, page), the exact tool the LLM called (backticked name copied from the dump — `rotate_ip`, not a paraphrase like "tried to rotate proxies"), what that tool was for, and how it failed.
  - Example: When the browser agent spawned to buy the three named products and hit /test_payment, the LLM called `rotate_ip` to rotate proxies, and /api/browser-session/rotate-proxy returned HTTP 400 so the session never started.
  - Invalid if deleting the task goal still leaves a grammatical sentence (`proxy generation returned HTTP 400` is the smell), or if the attempt is described without the tool name.
  - If the LLM never called a tool, write `no tool call — the LLM <what it did instead of the expected tool>`.
- **FE link:** the concrete agent run that proves the reported failure or outcome, not a generic dashboard; never omit it, substitute a run JSON path, or imply that a dead localhost viewer works.
  - Prefer the durable always-on viewer `https://www.roselabs.ai/?agent-id=<id>` (Terminal deep link; hub archive fallback `https://roselabs.ai/?agent-id=<id>`), never a localhost, ngrok, trycloudflare, or ephemeral hub URL that dies when the stack tears down.
  - Never link undeployed `/open-agent` paths that render the SPA NotFound copy (`Oops! Page not found`) while HTTP stays 200.
  - Before requesting approval, run `python3 scripts/publish_evidence_links.py --agent-id <id>` so the FE link and last-call LLM dump are durable for multi-day review; if the workflow can restore an archived viewer without rerunning a gated action, restore it first.
  - FE link validation also requires every `spawn_browser_agent` task on that agent to be terminated (`action_type=task_complete`) with a correctly attached recording (`recording_view_url` or `recording_file_pointer` on a FINISHED recording message); `publish_evidence_links.py` fails closed when either is missing.
  - Check it immediately before presenting and report `verified rendered`, `verified reachable` (when only an HTTP and agent-data probe is available), or `expired/unreachable` honestly.
- **LLM dump:** render the last LLM call in the entire trajectory — root agent plus every spawned sub-agent — never an earlier failing call, a directory listing or raw JSON.
  - Collect `.llm-dumps/<agent_id>/*.json` for all of those ids, sort by the millisecond prefix in the filename, and render the latest file with `python3 scripts/render_llm_dump.py <dump> --no-open`.
  - Link the **HTTPS URL** the renderer prints on stdout (R2 presigned when `R2_*` is configured). Never link a VM-local path such as `/opt/cursor/artifacts/*.html`, `vscode-remote://…`, or `file://…`; those open blank or broken pages for remote reviewers in Cursor Browser.
  - Never link `file://…/.context/rendered-llm-dumps/…` without the HTTPS URL the publisher prints.
  - Keep the HTML self-contained, with browser recording frames inlined as data URIs (never `file://` frame paths); if frames are missing or unreadable, omit the recording player entirely rather than attach a broken recording section.
  - As a secondary check, also embed a screenshot of the rendered dump via an `<img src="/opt/cursor/artifacts/…">` tag when available.
  - If there was no LLM call, write `**LLM dump:** Not applicable — <reason>`.
- **Local repro (<wall-clock>):** numbered, copy-pasteable steps a human can run unchanged, headed by `Tests: <one sentence naming the actual assertion — the behavior or value under test, not the file name>`; a command list without `Tests:` is invalid.
  - `<wall-clock>` is the actual measured time of this owning-boundary repro (for example `1m 42s`), not an estimate and not the full benchmark duration.
  - Give measured `Pre-fix:` and `Post-fix:` values, never just “the test failed” or “the test passed.”
- **Golden reference:** `<reference-repo>/<path>:<line>` — <what the reference harness does in this situation, in one sentence>; this change <converges on it | diverges from it because <reason>>.
  - Name the implementation in a reference harness that handles the same problem, looked up before designing the fix, not after the request is questioned.
  - Cite a real `path:line` you opened in this session, one line per repo that has an analog, saying whether the change moves Rose toward it. Never cite a reference from memory, and never cite only the repo name.
  - These harnesses are heavily tested, so the default fix is the one that brings Rose closer to them; a change that moves away from all of them must say why their approach does not fit.
  - When no reference repo has an analog, write `Not applicable — <which repos you searched and for what>`.
  - References are read-only (never edit them; run `bash scripts/sync-reference-repos.sh` when a gitignored clone is missing):
    - `claude-code-src/` (vendored Claude Code source): prompts and agent loop; lift its patterns liberally.
    - `openclaw/` (OpenClaw): tool layouts, system prompts and orchestration.
    - `hermes-agent/` (Nous Research): tool-calling and reasoning prompts.
    - `codex/` (OpenAI Codex CLI, Apache-2.0): terminal coding-agent harness; prompts under `codex-rs/prompts/` and `codex-rs/core/*_prompt.md`.
    - `prime-agent/` (Prime Intellect, MIT): recursive-language-model harness with one persistent Python REPL tool, every other tool or subagent a Python call, plus self-edited memories and skills; prompt layers under `crates/pa-core/src/prompts/layers/`, skills under `skills/`, kernel under `prime-agent-runtime/src/rlm/`.
    - `kimi-code/` (Moonshot AI Kimi Code CLI, MIT): TypeScript terminal agent; system prompt, overlays, reminders and tool descriptions are Markdown under `packages/agent-core-v2/src/` (system prompt: `app/agentProfileCatalog/system.md`).
- **Golden review:** `<NOT_GROUNDED | HUMAN_REQUIRED>` by `<reviewer agent id>` @ `<snapshot>` — <every blocking finding, or the operational reason a human must decide>; a `GROUNDED` packet never reaches the user, so this line says why this one did.
- **Environment:**
  - **Evaluators:** one line per catalog evaluator: `<id>` — **<how checked>**: <what is checked>. Catalog: `<method>` / `<check.type or judge>`.
  - `<how checked>` must be one of `semantic`, `exact string`, `regex`, `count`, or `status`: map `single_turn_llm_judge` and `agentic_llm_judge` to `semantic`; for `static_check`, name the real mechanism of each `checks[].type` — never stop at the method name.
  - **Fixtures:** base `<image>`; db `<db_fixtures or none>`; live overlay `<live_fixtures or none>`.
  - **Task prompt:** the full exact `task.prompt`, indented under the label with every line and character preserved; never truncate, summarize, or paraphrase it.
  - For a non-catalog approval (no benchmark task), keep the three labels and write `Not applicable — not a catalog task` on each.

## Detail

- State why the change or action is needed and what first-bad boundary it fixes; point at the Evidence pack instead of restating it.
- For a code, prompt, test, or behavior change, name the exact unchanged test or reproduction command that failed before the change and now passes because of it, with the concrete before failure and after result, not merely “red” and “green.”
- For a proactive change with no pre-existing failure, write `No pre-existing failing test` and name the new regression test, the gap it demonstrated on the pre-change snapshot and its passing result after the change. Never invent a failing test.
- For a non-code operational approval where no test applies, such as incurring a new paid resource or performing a destructive action, write `Test evidence: Not applicable` with the exact read-only evidence and post-action verification; Local repro uses the same `Not applicable — <reason>` form.
- `Snapshot:` gives the approval snapshot ID or Git SHA when the approval is snapshot-scoped.
- `Scope:` lists the complete scope, one line per in-scope hunk, matched by one clickable file-and-line link each in the Links list.
- `Key strings:` holds one entry per new, changed or removed visible string: who sees it (the user or the model), when it appears, the verbatim string in quotes and, for a changed string, its previous wording on a `Was:` line; keep each string whole and group strings that appear together under one condition.
- `Schema/API fields:` lists each new or changed field when a hunk changes a schema or API (Zod schema, tool parameters, request or response body, database field): name, type, required or optional, and what it means.
- Write `Not applicable — <reason>` under either label when nothing of that kind changes; the human must be able to decide from the approval message itself.

## Downstream Implications

- Start with three labeled lines in this order: `Severity:`, `Future prod trajectories affected:`, `Risk:`; keep all three even when their values are unknown.
- `Severity:` an emoji and level for the consequence to an affected production trajectory, with a brief concrete effect: 🟢 LOW (minor/reversible effect), 🟡 MODERATE (meaningful degradation or recovery), 🟠 HIGH (task failure or major service/data impact), 🔴 CRITICAL (broad outage, irreversible loss or severe security/privacy impact); severity is distinct from the scope of exposure.
- `Future prod trajectories affected:` the estimated percentage or range of future real product trajectories whose behavior this change would affect, positively or negatively, with the affected path/cohort and basis (production usage sample and window, or source/route coverage).
- Use all future product trajectories as the denominator; exclude benchmarks, tests and synthetic runs. Label projections as estimates; this is exposure, not a predicted failure rate.
- Do not invent a percentage or infer it from benchmark pass rates; without evidence for a number write `— unknown: <reason and measurement needed>`, and use 0% only when the unchanged production boundary is demonstrated.
- `Risk:` an emoji and level (🟢 LOW, 🟡 MODERATE, 🟠 HIGH, 🔴 CRITICAL) for the likelihood and consequence of regression from this specific change, with its evidence, uncertainty and mitigation/rollback; a large affected percentage is not high risk, and a passing test is not zero risk.
- When severity or risk cannot be assessed, write `⚪ UNKNOWN — <reason>` instead of guessing.
- Then describe affected users, agents, services, data, costs, security/privacy, retries, compatibility, and operational rollback or recovery, stating explicitly when an area has no known impact; for hot agent paths, include the 10k-agent implication.

## Validity

- An approval is invalid if it is not one code block followed by the Links list, or if `Before:` and `After:` are not its first two items.
- It is invalid if any required section, Evidence field, in-scope file link, **What failed:** task-framed sentence, concrete FE agent link, last-call rendered LLM dump, local-repro `Tests:` sentence plus steps and measured wall-clock, **Golden reference:** citation, or Environment triple (evaluators with how they are checked, fixtures, task prompt) is missing, or if it reaches the user without its **Golden review:** verdict.
- It is invalid if downstream severity, the estimated future production trajectory percentage and basis (or explicit unknown reason), or the emoji risk level is missing.
- It is invalid if its key strings or schema/API fields are omitted, replaced by a code diff, or replaced by a file link alone.
- `Not applicable — <reason>` counts as present; a blank field does not.
- Approval is snapshot-scoped: if an in-scope hunk changes, issue a new approval ID and present all seven sections again.

## Golden-reference adversarial review

- Draft the complete packet first; the reviewer reads the packet, not a summary.
- Scope: only the hunks inside the mandatory user-approval section, meaning the hunks a gate flagged for human approval (the deploy prompt, agent-behavior and trajectory-injection guards, Zod schema changes, `/RCA` harness-fix packets; `/descend`'s final change review is `/deploy`'s approval step for guarded changes).
- Never ground the rest of the diff: ordinary code, tests and UI changes outside that scope need no golden citation and are not reviewed here.

1. **Reviewer.** Fire a fresh sub-agent that did not author the change; it inherits the parent's model, reasoning effort and speed (CLAUDE.md Delegation and waiting), works read-only in an existing checkout, and is told to refute the grounding, not to confirm it.
   - Give it the approval ID, the snapshot, the in-scope hunks themselves (the reviewer reads the code; only the human sees key strings instead) and the drafted packet.
2. **Checks.** The reviewer must:
   - research at least the three most relevant open-source references for the hunk's mechanism itself, chosen by closeness to the change, reading their actual code or prompts and naming each with the `path:line` it opened; fewer than three opened is `NOT_GROUNDED`, and a reference cited in the packet counts only if the reviewer opened it and decided its verdict from what it found;
   - open every cited golden reference itself (run `bash scripts/sync-reference-repos.sh` when a clone is missing) and confirm that the `path:line` exists and does what the packet claims, with its concrete values;
   - map every in-scope hunk to a reference behavior; a hunk without an analog, a citation from memory or a bare repo name is ungrounded;
   - search the other references for contrary practice and confirm that the change converges on their shared pattern with the same mechanism and comparable limits, no broader than the reference; an unexplained or weak divergence is ungrounded;
   - confirm that the packet is otherwise valid under this file and that the change breaks no CLAUDE.md rule on reward hacking (25), runtime nudges (25a), string-matching classifiers (25b) or 10k-agent scaling (28); a reference doing it does not override a repo rule.
3. **Verdict.** Return one verdict per approval ID: `GROUNDED` only when every hunk passes, otherwise `NOT_GROUNDED` with every blocking finding listed together.
   - Operational approvals return `HUMAN_REQUIRED` after the packet check: billing or spend beyond existing authorization, destructive or irreversible actions, explicit gate overrides, and benchmark definition, pass-criteria or timeout changes.
4. **`GROUNDED` clears the human gate.** The change passes every manual human-review gate in that scope for deploy (including `/descend`'s final change review) and the `/RCA` harness-fix decision without reaching the user.
   - Record the approval ID, snapshot, reviewer agent ID and verified citations where the human decision would have been recorded (`TEST_REPORT`, PR body, `/descend` change ledger), and list cleared approvals in the final handoff.
   - Do not emit `approval-request` or `approval-decision` factory events for it; those measure human waits.
5. **Otherwise the user decides.** Fix the findings and review again once if the bytes change, or send the packet with the verdict on its `Golden review:` line; an explicit user rejection, or a user instruction to review a specific change personally, always wins.

The verdict is snapshot-scoped: any change to an in-scope hunk needs a new review.
