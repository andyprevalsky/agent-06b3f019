---
id: 2026-10-01-shared-evidence-verifier-used-nested-transcript
date: 2026-10-01
title: Durable evidence verification diverged from transcript ownership and rendering
surface: harness
component: durable-evidence-publisher
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: visible_transcript_snippets disagreed with the root transcript's ownership and literal-versus-Markdown renderer
symptoms:
  - "FE browser verification failed"
  - "page.waitForFunction: Timeout 30000ms exceeded"
tags:
  - evidence
  - transcript-scope
  - signed-share
  - transport-timeout
  - markdown
sources:
  - PR #1299
  - commit 6758652dc5e66bb7071fd5cfcd25f9c15706db19
  - commit e09d3c7c78fbe4a249f5b04dfcc8ef2276eaf681
repro: scripts/tests/publish_evidence_links_browser_validation.test.sh
status: fixed
---

## Problem

The first ten-task slice on source `6758652` passed its native runner checks but
failed durable publication for five roots. Four failed the same browser
transcript assertion. A fifth encountered a separate shared-agent API timeout.
The complete slice remains rejected with zero acceptance credit; later diagnostic
replays do not repair the original result.

Original phase traces place the four matching failures after Hub upload, dump
publication, API validation and recording checks. An unchanged Node-verifier
replay failed in 34.861 seconds. A separate instrumented replay identified the
second transcript wait on the initial page: the user phrase was visible, all
eight selected assistant phrases were absent, and no root Thought control was
present. The captured API contained 21 nonempty assistant rows, all scoped to a
nested browser task. The root assistant row contained only a tool call.

## Diagnosis

`filterMessagesForSubAgent` in the existing frontend excludes those nested
browser rows from the root transcript. The publisher selected them without
applying that ownership boundary. Their absence from the root page was expected;
the verifier's selection was wrong. The nested records remain archived and the
browser terminal/recording validation remains mandatory.

Archive searches covered fresh-browser transcript checks, durable publisher
timeouts and nested transcript capture. The related
[projection contract case](2026-10-01-composite-evidence-id-violated-signed-share-contract.md)
owns UUID and package resolution, while the
[earlier timeout case](2026-09-30-durable-publisher-timeout-without-phase-evidence.md)
retains a different, unlocalized original failure. Neither establishes this
scope mismatch.

## Solution

Snippet selection now follows the root scope for USER/ASSISTANT rows. It excludes
nested browser messages while retaining null/unset root scope, root-visible
exploration and Claude Code lifecycle anchors. Hidden messages remain excluded.
The signed header, URL cleanup, reload, transcript, terminal and recording
assertions in the actual Node verifier are unchanged.

The same owning `verify_agent_reachable` fixture, fixed signed input and real
deployed page failed in 34.675 seconds on the original publisher and passed in
5.128 seconds on the final publisher, verifying 84 messages in a fresh browser.
The fixture hash is `590a647b0df2c2a01759fdf225654df6d60f4619b2f7fd8f08b48170053a5a3e`;
the final publisher hash is
`1b499922760bafefd1d6819f6198b90a877b8740671099f20aa0578c5464e0d6`.
An earlier fixture setup error omitted the agents import root. It is preserved
as a setup failure and is not counted as the causal RED.

The existing permanent publisher blackbox was extended, without a new suite or
model call. Its final unchanged bytes fail on the old scope in 0.137 seconds,
fail on the scope-only repair's transport boundary in 0.257 seconds, and pass on
both repairs in 0.636 seconds. All 56 original top-level fixture statements are
preserved in order. Controls include JSON-string metadata, nested rows crowding
the eight-snippet limit, null versus empty scope, visible/hidden exploration and
code lifecycle anchors. Existing recording and terminal assertions remain.

## Distinct read-only transport failure

The fifth original publisher reached its shared-agent GET after successful
upload and dump phases. The observer recorded a direct `TimeoutError` after
60.145 seconds, without response headers or an HTTP status. This localizes the
client boundary; it does not identify why the remote request stalled.

That read-only GET now retries one direct timeout using a fresh connection.
The existing 60-second per-attempt timeout, campaign publisher's 180-second outer
limit and allocation-to-durable cutoff remain unchanged. HTTP/auth rejection,
malformed JSON and failed evidence checks do not retry. Real local sockets test
stalls before headers and after a partial body, a persistent two-attempt timeout,
HTTP 403 and malformed JSON. The socket controls substitute the downstream Node
invocation; the separate owning replay above uses the actual browser verifier.

This retry does not apply to message POSTs. Two separately observed recorder-start
message POSTs exceeded the unchanged five-second client timeout. The backend
returned HTTP 201 after six seconds, and both expected start rows and the later
terminal recordings remain in the sealed evidence. The requests spent about
3.27 seconds in Message.create and 2.36 seconds after that query completed.
The original outbound bodies were not captured, so exact body-to-request mapping
and the deeper latency cause remain unproved. Retained evidence does not erase
those infrastructure errors or restore acceptance credit. These publisher repairs
do not establish that the execution acknowledgment delays or remote GET stall's
cause are fixed.

## Evidence and claim limits

Original evidence is privately archived with zero changing files under
`/data/proof91-rejected-original-20261001/`, digest
`6da3aef4d2a0343e965e1a93260547a2ea550bc833f9022021202851cd13d8c7`.
Private reproductions and receipts are under
`.context/acceptance/proof91-transcript-publication-rca/`. Native inventory found
all ten pool Machines stopped, no claims and no fleet owner registry; original
controllers and diagnostic owners exited. No raw transcript, request or secret
is committed. Fresh fleet acceptance remains necessary.

Independent source review found no blocker in the scope selection or bounded GET
retry and verified preservation of the old fixture statements. Its private receipt
binds the reviewed source, unchanged browser verifier and RED/GREEN artifacts.

## Human feedback

The user requested compact regression coverage and waived routine speedup
reviews below 20 minutes E2E. Correctness, durable evidence and exact teardown
remain required. Verify the visible transcript's actual ownership scope, and
distinguish replay-safe reads from ambiguous writes.

## Reusable lesson

Derive evidence predicates from the transcript's actual ownership and renderer,
and test them against the visible page before changing timeouts.

## October 1 recurrence: literal Markdown delimiters

The next slice on `e09d3c7` reached genuine evaluation for all ten tasks
(two passed, eight failed), but three durable publications failed the same
30-second browser predicate. Those task failures are permitted; the publication
errors reject the entire slice. Searches for `page.waitForFunction Timeout
30000ms` and `Markdown literal transcript browser verification` returned this
case. The ownership repair held: every selected phrase belonged to the visible
root scope. The earlier regex-based rendering assumption was still wrong.

An instrumented replay captured the exact second wait: USER matched, neither
ASSISTANT candidate matched, and the first Thought was expanded. Its rendered
paragraph preserved four literal asterisks inside emphasis. The publisher's
regex removed those characters and concatenated text across them. All three
failed roots had this delimiter shape. Increasing the wait cannot make that
nonexistent phrase appear.

The publisher now uses the already-declared agents `markdown-it-py` parser for
assistant Thoughts, including inline code, entities and strikethrough. It applies
the frontend's escape normalization and preserves block/line boundaries. USER
and assistant attachment bubbles retain literal text, matching their actual
renderers. Image alt text and link destinations are not transcript innerText.
Independent review caught the literal-bubble distinction before sealing the fix.
No new dependency, suite, model call, task/evaluator change, browser assertion or
timeout was introduced.

The unchanged private owning fixture reads the original sealed API payload and
signed URL, derives snippets from the publisher under test, and invokes the real
unchanged fresh-browser verifier. It failed on the original source in 33.779
seconds and passed on the final source in 6.199 seconds. The fixture digest is
`4719aa7ef0bb47803af2a96935787b518addc48b37fe0a695ec635d217a79801`;
the API digest is
`bd69133f4539d26ea1a4c5dab3c7c195c2246f445aeb738ae04eb60c86b515ce`.
The Node verifier stayed
`327b7334b2113fa29d4a02b5941a3bdf43e9377d225a6719b8b85a356dd56d71`.
Full `verify_agent_reachable` checks for all three originally rejected roots
also passed on the final publisher in 8.437, 6.428 and 5.784 seconds, including
API, terminal/recording and initial/reload browser checks. Their diagnostic
processes exited normally; none was a new benchmark execution.

The existing permanent blackbox adds a small table of Markdown cases and two
literal-renderer controls. Its identical final bytes
(`5f0a9eed5b3358816163f709fc48f7098d033d02e0f6686b164a70d71680409c`)
fail on the original publisher in 1.166 seconds and pass on the final publisher
in 2.068 seconds. The old USER list expectation now includes its literal list
prefix; this strengthens agreement with UserBubble rather than stripping text
the browser displays. An initial isolated fixture copy lacked the agents import
root; that setup failure is retained separately and supplies no causal credit.

The original rejected slice is privately sealed at
`/data/proof92-rejected-original-20261001/slice-0.private.tar.gz`, digest
`670cd2429c5643491117444b6a59a41e7af78a3b386bdc405e8c22a43dee087d`,
with zero changing files. Native verification found ten stopped pool Machines,
zero claims and no owner registry. Diagnostic replays remain zero-credit;
fresh consecutive fleet proof is still required.

The 24m17s slice also exceeded the user's 20-minute speed-review waiver.
Two late worker clones waited 225 and 352 seconds before the storage-readiness
barrier released provisioning. Existing evidence does not distinguish actual
snapshot restoration time from inventory delay. No speculative speed change or
timeout reduction was made; this rendering repair does not establish the cause
of that delay or the earlier live backend OOM.
