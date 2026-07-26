# Canonical Human Approval Request Format

This file is the single source of truth for human approval requests emitted by
`/RCA`, `/deploy`, and `/descend`. Read it completely immediately before
composing any approval request. Do not replace it with a shorter free-form
summary, and do not rename, reorder, or omit its four required sections.

Use one approval ID per snapshot-scoped decision. Group hunks only when one
decision necessarily covers them together. Include clickable file-and-line links
for every code, prompt, instruction, test, configuration, or migration hunk in
scope.

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

An approval is invalid if any required section or in-scope file link is
missing. Approval remains snapshot-scoped: if an in-scope hunk changes, issue a
new approval ID and present all four sections again.
