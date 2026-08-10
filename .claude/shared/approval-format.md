# Canonical Human Approval Request Format

This file is the single source of truth for human approval requests emitted by
`/RCA`, `/deploy`, and `/descend`. Read it completely immediately before
composing any approval request. Do not replace it with a shorter free-form
summary, and do not rename, reorder, or omit its five required sections
(TL;DR, Detail, Before Behavior, After Behavior, Downstream Implications).

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

## Detail

State why the change or action is needed and what first-bad boundary it fixes.
For a code, prompt, test, or behavior change, name the exact unchanged test or
reproduction command that failed before the change and now passes because of
it. Include the concrete before failure and after result—not merely “red” and
“green.”

If the change is proactive and there was no pre-existing failing test, say
`No pre-existing failing test` and name the new regression test, the gap it
demonstrated on the pre-change snapshot, and its passing result after the
change. Never invent a failing test.

For a non-code operational approval where a test cannot apply—such as writing
an environment variable, incurring a new paid resource, or performing a
destructive action—say `Test evidence: Not applicable` and provide the exact
read-only evidence and post-action verification instead.

List the approval snapshot ID or Git SHA when the approval is snapshot-scoped.
Then list the complete scope as clickable file-and-line links.

Every approval must include a dedicated line in this exact form:
`**FE link:** [Open agent](<frontend-agent-url>) — <verification status>`.
The URL must open the concrete agent run that proves the reported failure or
outcome, not a generic dashboard. Check it immediately before presenting the
approval and report `verified rendered`, `verified reachable` (when only an HTTP
and agent-data probe is available), or `expired/unreachable` honestly.
Never omit the FE link, substitute a run JSON path, or imply that a dead localhost
viewer works. If the workflow can restore an archived viewer without rerunning a
gated action, restore it before requesting approval.

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

An approval is invalid if any required section, in-scope file link, or concrete
FE agent link is missing. Approval remains snapshot-scoped: if an in-scope hunk
changes, issue a new approval ID and present all four sections again.
