---
id: 2026-11-16-setup-completion-verifier-demanded-unrequested-operational-health
date: 2026-11-16
title: Setup completion verifier demanded operational health despite confirmed standard setup
surface: agents
component: browser completion verifier
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: captured verifier interpretation added operational-health requirement; local causal reproduction remains open
symptoms:
  - Step 229 establishes configuration readiness and a confirmed runtime check
  - operationalStatus and runtime sync/activation values remain unknown
  - existing_account_iphone_connected
  - Verifier score: 50%
tags:
  - iphone
  - verifier
  - readiness
sources:
  - agent 20440423-026a-584f-aed1-dbd59d6dc693
  - memory: verifier dump cca48286a06e
  - commit 16e079f926f8e69c716c20070561d3ed23344d5e
repro: none-recorded
status: open
---

## Problem

The standard existing-iPhone setup browser task received successful native
setup verification at step229, then released its lease at step230. The
06:02:33Z completion verifier returned 50%, explicitly acknowledging current
configurationReady=true and confirmed sign-in/settings checks while requiring
operational connection because runtime sync/activation remained unknown.
The browser continued checking settings until its 250-step cap. The terminal
phone lease omission is separately recorded in
2026-11-16-terminal-browser-activity-retained-phone-custody.

## Diagnosis

Captured source-to-sink: original user setup request -> caller-generated browser
goal/output schema -> actual phone setup receipts -> build_browser_verifier_context
-> check_progress -> gpt-6.1-sol-gpt response -> rejected attempt_completion.
The original field asks whether the existing account iPhone connected through
the normal supported setup and verification flow, not for confirmed message
sync, active cellular service or delivery. Backend connectionDto deliberately
uses current configurationReady and bound provenance; operationalStatus is a
separate health contract. The captured rejecting judgment added an operational
requirement. It did receive the decisive evidence, so this is not the b82/RCA98
canonical-history-loss defect.

Archive searches: `configurationReady operationalStatus unknown verifier` and
`browser capped phone lease release`. Actual related owner evidence and the
October19 identity/configuration readiness and October18 missing phone results
cases were read, including Solution and Human feedback. Their separation of
configuration and transient health applies; their fixes do not establish a
new deterministic verifier defect here.

Two production requests had identical messages. The first (2997719e6aa7)
timed out after about180s. The second (cca48286a06e) produced the rejecting
judgment in84.367s. Its base SHA256 is
c3987c2ff5c42dc6df08d57517862bd9f8c310c8515e52c23e651e5cdfeef1b1.
The messages SHA256, using sorted-key JSON, is
0b1814b1919467d208b3c80248281256a8287384e691fceaf61c9e4c675012e1.

Local exact-request replay preserved all five messages, screenshot, strict
response schema, model, user GPT-auth path, call site verifier_browser,
rose-1-ultra pool, xhigh effort, temperature0.3, max16000, deadline180s,
TTFT60s and idle90s. The native response model was rebuilt and equality-checked
against both captured direct_auth_tools and response_format. First local
attempt timed out180.19s and omitted archive identity; it is not a semantic red.
Two subsequent bound exact replays returned1.0/true in106.544s and165.475s.
Thus the reported semantic failure has not been reproduced locally and no
causal product fix is established.

A controlled generic scope-of-assurance appendix returned1.0/true twice
(89.394s and84.587s), but unchanged baselines also passed. An explicit
operational-health goal, with the same evidence/model/schema, correctly
returned0.5/false both without and with that appendix (133.627s and110.401s).
These negative controls support keeping the health distinction, but do not
prove improvement from the candidate instruction. No prompt was changed.
All completed calls reported gpt-6.1-sol-gpt/user GPT authentication. No
lineage lease was returned; the corrected replay helper releases any returned
lineage in finally. Original and replay failures remain retained privately.

## Solution

No verifier repair or model-intelligence diagnosis is claimed. The fixed
criterion/response mismatch is an observed incident, with a stochastic causal
reproduction gap. The exact-request replay and finite controlled sample ruled
out a presently deterministic absence of setup evidence and did not justify a
prompt patch. A stronger future repro must show the same first bad semantic
boundary failing before and passing after a general fix, with the explicit
operational-health negative control unchanged. Model upgrades were not tested.

Private evidence: /tmp/rca204-replay-matrix.json, exact base/update records
inside the independently verified526-call archive, and per-trial output/logs.
No private account data, images, tokens or phone operations are committed.
Parent owns evidence publication and any later continuation; this case stays
open and does not label the original browser result as successful.

## Human feedback

The user prohibited live phone operations, including tests or cleanup. Only
read-only logs/database and recorded LLM replay were authorized. The parent
required the exact rejecting request, unchanged schema/model/transport,
negative control for explicitly requested operational health and no prompt
edits without general abstraction and demonstrated improvement.

## Reusable lesson

Distinguish the requested completion outcome from stronger operational claims,
and do not claim a verifier repair when the unchanged exact request already passes.
