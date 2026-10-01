---
id: 2026-10-01-shared-evidence-verifier-used-nested-transcript
date: 2026-10-01
title: Durable evidence verification selected nested browser reasoning for the root transcript
surface: harness
component: durable-evidence-publisher
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: visible_transcript_snippets included subAgentId messages that the root MessageList excludes
symptoms:
  - "FE browser verification failed"
  - "page.waitForFunction: Timeout 30000ms exceeded"
tags:
  - evidence
  - transcript-scope
  - signed-share
  - transport-timeout
sources:
  - PR #1299
  - commit 6758652dc5e66bb7071fd5cfcd25f9c15706db19
repro: scripts/tests/publish_evidence_links_browser_validation.test.sh
status: fixed
---

## Problem and runtime evidence

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

## Repair and unchanged reproduction

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

The user requested compact regression coverage and waived routine speedup
reviews below 20 minutes E2E. Correctness, durable evidence and exact teardown
remain required. Verify the visible transcript's actual ownership scope, and
distinguish replay-safe reads from ambiguous writes.
