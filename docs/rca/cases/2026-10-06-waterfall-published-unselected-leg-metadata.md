---
id: 2026-10-06-waterfall-published-unselected-leg-metadata
date: 2026-10-06
title: Recoverable waterfall legs exposed model metadata before selection
surface: agents
component: rose-waterfall
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: waterfall_complete forwarded parser metadata before its leg could fail and fall through
symptoms:
  - normalized waterfall stream contains two metadata chunks after a preproductive stall
  - first metadata actual_model identifies the failed leg rather than the selected leg
  - rose.complete.waterfall.done chunk_counts metadata 2
sources:
  - commit f04b845f9642bf0cc724b5d65a01b4cb3255f353
  - PR #1299 review finding 4203414270
  - plan:.context/provider-metadata-rca/owning-red.safe.json
  - plan:.context/provider-metadata-rca/owning-green.safe.json
tags:
  - waterfall
  - streaming
  - metadata
  - fallback
repro: agents/tests/blackbox/rose.blackbox.py:test_client_waterfall_stalled_leg_uses_existing_fallback
status: open
---

## Problem

The Python client promises one metadata event first in a successful normalized
stream. On f04, a metadata-only first waterfall leg could fail under the existing
per-leg guard, then the configured next leg could complete. The caller received
the failed leg's metadata and the selected leg's metadata. The owning offline
control uses the real RoseClient, HTTPX MockTransport, production transport,
production OpenAI SSE parser and unchanged 590/90/120-second budgets. The first
leg exposes headers at virtual 10.5 seconds then stalls; the selected leg emits
one reasoning chunk. The baseline stream's metadata count is two.

## Diagnosis

The critical path is RoseClient → configured waterfall → HTTPX transport →
parse_openai_sse → per-leg client guard → waterfall forwarding → consumer.
The parser correctly emits its own leg metadata before reading response bytes.
The guard correctly lets a preproductive stall enter the existing next leg.
The first bad boundary is forwarding: metadata was committed to the consumer
before the waterfall knew whether that leg would produce a selected response.
The same gap affects a normally empty upstream stream and a transport failure
while raw tool arguments are still buffered inside the parser.

The deepest proven owned cause is inconsistent attempt commitment. Direct-auth
wrappers already withhold metadata until the first nonmetadata chunk and discard
it on pre-output fall-through; waterfall forwarding did not. Archive searches
were `waterfall metadata first failed leg` and
`fallback stream response identity duplicate metadata`. The client-stream-guard
case is a relative: it repairs recovery placement, while this case repairs the
identity emitted by that newly reachable recovery. Its original provider-silence
and exact failed-input attribution remain open. This repair provides no new
benchmark outcome proof or retroactive LIVE acceptance.

The unchanged five-control command runs the registered owning test functions:
`/Users/andyprevalsky/Developer/rose-live50-streak-20261006/agents/venv/bin/python
.context/provider-metadata-rca/run-owning.private.py <label>`.
The source-backed local interpreter is reused without installation. Valid RED
records two failures and three passing inverses in 0.753 seconds; unchanged
GREEN records five passes in 0.806 seconds. An initial import without the
required authoritative dotenv was a setup error and is explicitly excluded.
Private logs, exact hashes, measured epochs and native owner births accompany
the packet. The ordinary `scripts/run_blackbox_tests.py rose rose-browser-use
llm` command passes 213 Rose, 97 browser-use and 225 LLM controls (535 total)
in 180.645 measured seconds; its root is reaped and its original birth is absent.
The changed Python files pass Ruff lint and formatting, and the 803-case archive
validates. No provider network request is made: all transport requests are
handled by the explicit local MockTransport.

Golden reference: `agents/providers/rose/client.py:_try_claude_auth` is the exact
local metadata-commitment pattern. The checked-in Claude Code reference at
`claude-code-src/src/query.ts:895` clears failed-attempt assistant messages and
at line 909 discards pending tool results before fallback. This is the related
attempt-isolation principle, not a claim of an identical metadata API. Searches
of retained OpenClaw configured-fallback/stream files and Hermes stream monitor,
retry state and stream diagnostics found no identical normalized metadata-first
contract. A Codex reference was unavailable locally; no reference was fetched
for this offline assignment.

## Solution

Keep one pending metadata chunk local to each existing waterfall leg. Discard
it if that leg fails before yielding any nonmetadata chunk. Flush it before the
first selected-leg chunk, including usage or done, so a successful normalized
empty response does not place metadata after its terminal events. A metadata-only
successful seam is also flushed on normal exhaustion. Productive payloads and
raw tool argument fragments are never queued by this repair. The parser's
context-local progress callback and existing per-leg guard remain untouched.

The permanent Rose suite extends its existing real-client stalled-leg control
with exact metadata count, order and selected model assertions. Its related
parser control covers empty upstream and buffered-tool transport failure. A
small actual-waterfall seam inverse supplies a successful normalized
metadata/usage/done response and verifies that order. Production parser empty
streams still fail and fall through. The unchanged whole590 deadline and
postproductive idle120 controls retain terminal exceptions and exact response
closure. Existing real parser progress, sibling isolation and cancellation
controls run through the ordinary Rose, rose-browser-use and LLM command.

At 10,000 concurrent requests, each active leg holds at most one existing small
metadata chunk; no whole-fleet structure, polling, timer, shared state, lock,
connection or additional provider attempt is added. The repair changes no pool,
model, provider order, request input, prompt, task, evaluator or deadline. It
unifies metadata commitment with the direct-auth path without restructuring the
other provider wrappers. The candidate remains isolated and undeployed pending
independent review and Root/Tank composition; this case remains open accordingly.

## Human feedback

The owner required a real-client and HTTPX production-parser RED/GREEN, unchanged
590/90/120 budgets, intact buffered-tool progress, and no live/provider calls.
They rejected flushing pending metadata only after the loop, because usage and
done on a successful empty seam must follow metadata. They required a separate
sparse workspace and left integration/deployment to Tank.

## Reusable lesson

Commit one selected attempt's metadata before its payload and discard metadata
from recoverable attempts that produced no selected payload.
