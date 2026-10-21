---
id: 2026-10-20-kernel-proxy-ladder-ignored-provider-health
date: 2026-10-20
title: Kernel proxy ladder ignored provider health after a mobile-state proxy rejection
surface: back-end
component: kernel-proxy
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: createSessionOnKernelProxyLadder classified a browsers.create rejection by message text instead of the managed proxy's provider-owned health status
symptoms:
  - "400 Proxy is marked unavailable from the last health check"
  - "400 Proxy health check failed: transport error: proxy connection failed"
  - "FAIL live Kernel provider parity: /rotate-proxy 500"
tags:
  - kernel
  - proxy
  - browser-provider
  - health-check
  - rotation
sources:
  - agent a9de3902c4ed3aeb1
  - commit 857211a277f369ea5acf378bb38d5cd5db9ce664
repro: back-end/src/tests/blackbox/browser-provider.blackbox.ts
status: open
---

## Problem

The live provider-parity smoke rotated from residential to mobile at a different
US state. Kernel rejected the state proxy during its health check; the refunded
retry reused the same cached ID and failed immediately. The owning ladder did
not advance to the country-level mobile candidate.

Recovered original runs (under the parent checkout, read only):

- `.context/test-runs/1792537384-2286669-1896`: IL, first failure at
  2026-10-20T23:04:28.846Z, cached retry at 23:04:29.846Z.
- `.context/test-runs/1792537992-2432492-29424`: FL, first failure at
  2026-10-20T23:14:43.083Z, cached retry at 23:14:44.080Z.
- `.context/test-runs/1792538592-2600390-12039`: WA, first failure at
  2026-10-20T23:24:48.182Z, cached retry at 23:24:49.170Z.

In each `backend.log`, lines 592/596 select the mobile state proxy, line 598
records the health-check failure, and lines 609/612/614 repeat the same state
and record the marked-unavailable rejection. Each `browser-provider.log` line
301 records the failed live parity outcome. The recovered provider retrieval
receipt identifies IL/FL/WA proxies as `status: unavailable`, with `last_checked`
matching those first failures. These are prior observations, not new live proof.

Secret-filtered excerpts and source hashes are retained in the resumed worktree
at `.context/rca-kernel-proxy/recovered-live-evidence.txt`; the prior retrieval
receipt is `live-retrieve-status.log`. The original interrupted transcript is
`/home/boxes/.claude/projects/-home-boxes-rose/eb5f782a-f208-4428-89be-c22ce449cc06/subagents/agent-a9de3902c4ed3aeb1.jsonl`.

## Diagnosis

What: mobile rotation stops with HTTP 500 despite a remaining country candidate.
Where: the backend managed-proxy ladder catches the Kernel SDK 400.
Why: its availability/sticky-cache phrase lists recognize neither the initial
health-check message nor `Proxy is marked unavailable from the last health check`.
Proof: the actual SDK error class and captured messages reproduce the failure in
the permanent browser-provider blackbox, while the provider status controls the
fixed ladder. The test checks returned source/key, one relaxation, evicted failed
row, preserved remote proxy, and cached country result.
Problem: a second, text-derived source of truth disagrees with the provider's
structured resource health. Kernel owns the failing upstream pool; Rose owns
whether a proven-unusable managed candidate advances through its existing ladder.
The next deeper issue (why Kernel's state pool cannot reach its health-check URL)
is outside Rose's ownership and is not claimed repaired here.

Archive searches: `Proxy is marked unavailable from the last health check` and
`kernel mobile proxy rotation health`. This is related to
`2026-07-20-transient-proxy-init-failure-classified-fatal` (agent-layer retry
classification) and `2026-10-01-shared-kernel-geo-proxy-deleted-downgraded-resume`
(deleted-ID refresh). Neither diagnoses this status-versus-message boundary;
this is a distinct backend cause, not evidence that those fixes regressed.

## Solution

Candidate only, pending parent approval and live outcome proof. For a resolved
managed proxy rejected with the SDK's `BadRequestError`, retrieve its provider
status with a 10-second deadline and no SDK retries. Only `unavailable` supplies
new health-based permission to evict the failed cached ID and advance. Remove
the two competing unavailable-text fragments. Existing inventory/timeout and
one-time deleted-ID refresh behavior remains covered by existing tests.

Cache deletion matches provider + proxy key + failed proxy ID, so a concurrently
written replacement survives. Never delete the shared Kernel resource. Failed
health retrieval preserves the original error rather than reporting success.
Tests also cover a healthy proxy, misleading unavailable text, unknown health,
non-400 responses, final-candidate failure, and bounded lookup options.

Simplification decision: unify the unavailable decision on provider status,
removing its two duplicate text classifiers. Removing the entire established
inventory/deleted-resource ladder is not justified by this incident.

Golden references: searched `claude-code-src`, `openclaw`, `hermes-agent`, and
`codex` read-only copies for `@onkernel`, Kernel proxy handling, and proxy
unavailable/health-check mechanisms. No exact managed Kernel health analog was
found. `codex/codex-rs/http-client/src/outbound_proxy.rs:364-376` is a narrower
conceptual analog: it matches typed `SystemProxyDecision::Unavailable` before
choosing an alternate route. This candidate converges on structured-state
routing; that code does not establish Kernel semantics or prove this fix. Other
opened near matches were `claude-code-src/src/upstreamproxy/upstreamproxy.ts:76`
(local relay initialization), `openclaw/src/secrets/egress-proxy/proxy-worker.ts:139`
(certificate-status query), and `hermes-agent/agent/proxy_sources/iron_proxy.py:693`
(local listener readiness). None implements managed geo-proxy health recovery.
The search receipt is `.context/rca-kernel-proxy/golden-search.log`.

At 10k agents: successful creation adds zero lookups. Each rejected resolved
400 adds at most one 10-second/no-retry provider GET per attempted candidate,
plus one indexed conditional cache deletion if health is unavailable. There
are at most three geo candidates and two attempts per candidate (the existing
not-found refresh), hence a conservative six extra GETs per ladder invocation.
No new polling, background task, global cache, subscription, or broadcast is
introduced. Same-location agents already share the cache row; conditional
matching prevents deleting a replacement but does not eliminate existing
same-key contention. A correlated 10k failure can still produce a provider
request burst; no load/rate-limit proof is claimed.

### Reproduction and validation

The same final test artifact is run against baseline runtime
`857211a277f369ea5acf378bb38d5cd5db9ce664` and the candidate. Only the runtime file
is temporarily swapped; it is restored in a `finally` block. Tests and assertions
are unchanged across all six runs. Exact retained wrapper invocation:

```bash
bash /home/boxes/rose/.claude/worktrees/agent-a9de3902c4ed3aeb1/.context/rca-kernel-proxy/run-repro.sh final-repro
```

The wrapper's reproducible command (from `back-end/`) is:

```bash
env -u FLY_APP_NAME -u TEST_BASE_URL -u RUN_BROWSER_USE_LIVE -u RUN_BROWSER_USE_HANDOFF_LIVE \
  ROSE_USE_SYSTEM_PG=true \
  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_agent-a9de3902c4ed3aeb1 \
  DIRECT_URL=postgresql://postgres:postgres@localhost:5432/victoria_agent-a9de3902c4ed3aeb1 \
  timeout 280 npx tsx src/tests/blackbox/browser-provider.blackbox.ts
```

The database belongs only to this worktree. No parent/shared database, live
browser session, or production write is part of this command. Test-cache
operations are replaced with the in-memory map at the diagnosed boundary.

Final baseline: exit 1, 38.3s, `FAIL Kernel proxy marked unavailable by its health
check relaxes location and drops the cached row: 400 Proxy health check failed...`.
Final candidate results and file SHA-256s are retained in
`.context/rca-kernel-proxy/final-verification.json`; final fail/pass logs are
`final-pre-fix.log` and `final-post-fix-{1,2,3,4,5}.log`. All five final
candidate runs passed 29 checks, exit 0, in 36.3, 36.1, 36.4, 38.0, and 37.3
seconds respectively. The manifest verifies all four code/test file hashes
remained unchanged throughout the fail/pass sequence.

Registration: the test is called by `browser-provider.blackbox.ts`, automatically
discovered by `back-end/src/tests/blackbox/run.ts` via `*.blackbox.ts`.
The actual current deploy gate is Step 4a, `npm run test:coverage` ->
`back-end/scripts/run-coverage.sh` -> `run-blackbox-tests.sh` -> the domain runner.
The methodology's older Step 5a label refers to this backend gate.
Focused unit, format, lint, typecheck, registration, archive-validation, and
normal domain-runner receipts are retained alongside the fail/pass logs.
The normal runner also passed `browser-provider` (1 domain, 0 failures,
37054ms); its domain log records the same 29 passing checks. This is an
offline domain run, not a claim that the full backend coverage gate passed.

### Adversarial review

Read-only reviewer `ph74px7m8vn2gs8skwfsh5z9a58gm3aj` passed the local proposal
with limitations; its receipt is retained as `adversarial-review.txt` and JSON
in the evidence directory. The review confirmed source depth, conditional
invalidation, negative coverage, and registration. It inspected the first
strengthened candidate pass; the final five-run manifest is verified separately.

The reviewer noted that an unrelated 400 can coincide with an unavailable proxy.
The policy then permits geo relaxation because that proxy cannot serve the
session; unavailable status is not proof that it caused every 400. Preservation
of unrelated 400s is proven when health is available or unknown, not universally.
This limitation is part of the approval decision. During a sustained regional
outage, subsequent callers may create fresh proxies for the unhealthy location
after eviction; this change adds no shared cooldown or admission control and
claims no sustained-outage load proof.

### Remaining proof and approval boundary

Status stays **open**: causal replay is not live provider-parity outcome proof.
After parent approval, rerun the unchanged live Kernel provider-parity smoke
against this exact candidate on an isolated stack and retain HTTP/metadata and
terminal receipts. Verify real country fallback, rotation accounting, and
subsequent resume. No catalog benchmark task or LLM prompt is implicated in
these provider-contract runs, so catalog evaluator/prompt and LLM dump are N/A.
No new verified durable FE evidence was produced. Full backend coverage and
live acceptance are not claimed. Parent deploy #1562's separate Steel 402 billing
blocker is not repaired or bypassed by this change.

## Human feedback

The user directed the resumed worker to preserve all four candidate files,
work only on this branch/worktree, recover the exact prior repro first, add
regression coverage, run five consecutive unchanged tests, commit locally,
archive through the canonical tool, and stop at approval. No push, PR, deploy,
parent cherry-pick, live paid sessions, shared database, other-process kills,
external messages, or weakened tests are authorized. Preserve Freedom and its
protected instructions. Budget is 45 minutes; narrow early if blocked.

## Reusable lesson

Use provider-owned structured health to decide whether a managed resource can serve a request, and invalidate only the exact failed cached identity.
