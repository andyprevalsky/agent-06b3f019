/goal Fix the backend-coverage-blackbox shard server heap growth driven by the report-bug blackbox fixture, make the original failing command pass reliably on a long-lived devbox, and finish /deploy through merge, production verification, cleanup and a completed deploy scorecard.

Set this thread's title to start with `--ai--` (for example `--ai-- Test repair: backend blackbox shard heap growth`) as soon as you start, and verify it.

Failed test: backend-coverage-blackbox shard 2. These blackbox domains all failed with "fetch failed" after the shard-2 test server died: benchmarks-hub, benchmarks-test-prompts, browser-provider, code-preview, codex-code, send-sms, tool-usage, tools, vapi, vcard, waitlist, webhooks, x402. The coverage threshold was therefore unverified.
Command: the deploy backend coverage gate (`cd back-end && npm run test:coverage:sharded`, through scripts/deploy_test_backend.py in an isolated worker root with CONDUCTOR_WORKSPACE_NAME=backend-coverage-blackbox).
Scope:
- The isolated blackbox backend's memory, and the report-bug blackbox fixture's data hygiene across runs.
- Keep test intent, assertions and timeouts unchanged. Do not raise --max-old-space-size or watchdog limits (CLAUDE.md rule 25).
- Root causes found by the originating RCA:
  1. `back-end/src/tests/blackbox/report-bug.blackbox.ts` creates ANDY_USER_ID chat-mode agents (goal 'report-bug blackbox fixture'). Each runs a live LLM chat that greps "blackbox fixture" across that user's trajectories. Deleting an agent only archives it, and the shard databases (victoria_<workspace>_s1/_s2) persist between runs. So each grep returns all earlier runs' grep output: the largest LLM dump grew 17 KB -> 0.2 MB -> 1 MB -> 7.8 MB -> 28.7 MB over about 8 runs on one devbox.
  2. Test fetch capture retains every request body for the server's lifetime: `captures[].requestBody` in fetchCapture, and `NonBlockingFileCache.mem/generations/invalidated` keyed by the full replay key.
  3. A product-side risk worth checking: a chat grep over agent_trajectories returns earlier grep tool results whole, with no per-match size bound. Production chats could compound the same way (the RCA saw a 2.68M-token estimate and "Compaction did not reduce context"). Fixing that is a harness change and needs the normal approval path.
- Starting point: branch `followup/backend-blackbox-heap-growth` (RCA patch that keys the cache's in-memory maps by the sha256 digest, plus a unit regression in non-blocking-fetch-cache.test.ts). The RCA measured that it halves retention but does not stop the fixture compounding. Verify it, then fix the fixture (create it without a live chat, or scope and clean its trajectories per run) and decide on the grep result bound.
Exact error: `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` in back-end/coverage/server-shard2.log at 2026-11-07T13:29Z (native stack in node::crypto Hash Decode / String::WriteUtf8 / SlowFlatten). Earlier, at 11:37:18Z, the devbox memory watchdog SIGTERMed the same shard server at 4.67 GB RSS (/run/boxes-memory-terminations.jsonl). All later shard-2 requests failed with "fetch failed".
Failure evidence: the logs are on the originating devbox and not durable. Reproduce instead: run the backend coverage gate repeatedly against one persistent workspace database, or use the RCA's repro script (fetchCapture in replay mode with 16M-character LLM bodies; about 64 MB retained per call before the patch, 32 MB after). It is described above, so recreate it.
Failed source: 79e007df49786d17071719477a283cbe8ed7b446 (PR #1749 head after the main merge); also seen on 56bf43fe2.
Originating merge: 3e770c9e10be3ee23f6cf0a2ad4a523b1241789e (PR #1749, merged 2026-11-07T14:24:58Z)
Originating devbox: ed7a3716-f3df-4537-8207-8058623127e1

Read CLAUDE.md and follow /RCA. Work autonomously from current main;
before repair work, verify this is a different devbox and its project-folder
membership is Bugs using the boxes-devbox-folders skill. Keep this /goal and
all deployment coordination here; never depend on the originating box staying
open. Retain every needed artifact here or in accessible durable storage.
Do not ask questions or depend on human replies. Resolve implementation
choices using the existing instructions and evidence. Prove the assigned
test passes, then carry the fix through /deploy to its completed scorecard.
An OPEN diagnosis, observability report, draft PR or stopped investigation
does not complete this goal. Do not waive or re-delegate the assigned test
as a substitute for fixing it. Preserve test intent, assertions, timeouts
and existing permissions; never fabricate success. Keep working until
the goal is achieved, including ordinary review and production work.
