---
id: 2026-07-03-fetchcapture-replaced-non-string-bodies-with-a-placeholder
date: 2026-07-03
title: The fetch-capture wrapper serialized non-string request bodies to the literal "[non-string body]" and sent that to the real API
surface: back-end
component: fetch-capture
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "back-end/src/providers/fetchCapture.ts — FormData/Blob bodies were stringified for the capture key and the stringified placeholder was what got sent"
symptoms:
  - '"[non-string body]" reaches the real upstream API instead of the multipart payload'
  - multipart outbound calls fail only when running under blackbox capture
tags:
  - fetch-capture
  - multipart
  - formdata
  - blackbox
  - request-body
sources:
  - commit d126a992e
  - memory:project_sms_mms_media_support
repro: none-recorded
status: fixed
---

## Problem

`back-end/src/providers/fetchCapture.ts` corrupted non-string request bodies: a
`FormData` or `Blob` body became the literal string `"[non-string body]"`, and that
placeholder — not the multipart payload — was sent to the real API. Any outbound
multipart call (for example the speech-to-text upload added with inbound MMS support)
therefore failed under blackbox capture while working in production.

## Diagnosis

The capture layer needs a serializable representation of the request to key its cache,
and that serialization was applied to the request itself rather than only to the cache
key. The result is a test-harness-only mutation of production traffic: the wrapper is
transparent for JSON bodies and silently destructive for every body type it cannot
stringify.

## Solution

Non-serializable bodies now pass through to real `fetch` UNCACHED, with a record-only
capture entry so the call is still visible in the capture log. Consequence to keep in
mind: multipart outbound calls work under blackbox capture but never replay from the
fast-forward cache.

## Human feedback

None recorded.

## Recurrence (2026-08-20) — response bodies

Same wrapper, opposite direction: `FetchReplayClient.request` always called
`response.text()` before reconstructing the `Response`. Under benchmark stacks
(`BLACKBOX_TEST_CAPTURE_OUTBOUND=1` default in `scripts/run.sh`), Supabase
`image/jpeg` attachment downloads were UTF-8-decoded with U+FFFD replacement
(207364 → 369851 bytes) and then written into Claude Code E2B sandboxes —
`files-in-sub-agents` failed with Pillow `UnidentifiedImageError`.

Fix: detect binary `Content-Type`s, serialize as base64 with
`x-rose-fetch-capture-body-encoding: base64`, decode when reconstructing.
Cemented in `back-end/src/tests/unit/fetch-capture.test.ts`.

## Recurrence (2026-08-21) — Fast Mode over OpenRouter + missing Content-Type

Fleet `files-in-sub-agents` (`20260821-002517-708451`) still failed after the
binary Content-Type fix:

1. **Fast Mode tee-proxy won over OpenRouter.** Local stacks often skip Fast Mode
   because `FAST_MODE_ANTHROPIC_PROXY_URL` is loopback-unreachable, so the funded
   OpenRouter `ANTHROPIC_BASE_URL` sticks. Fleet proxies are public, so Fast Mode
   overwrote the gateway URL; the proxy forwarded OpenRouter keys to
   `api.anthropic.com` → repeated HTTP 403, 0 Claude Code interactions. Stale
   Fast Mode cache hits also replayed prior corrupted-run outcomes
   (`Agentic loop finished: 0 interactions` + SUCCESS/FAILED).
2. **Missing/unknown Content-Type still used `response.text()`.** Allowlist text
   types only; treat null/empty/unknown as binary. Guard
   `downloadFromStorage` with `looksLikeUtf8ReplacementCorruption` so a corrupted
   buffer never reaches E2B.

Fix: `shouldPreferSandboxAnthropicBaseUrlOverFastMode` — funded non-Anthropic
bases skip Fast Mode proxy/flags; text-only capture decoding; attachment
fingerprint in Fast Mode traces. Cemented in fetch-capture + credential unit
tests.

### Recurrence (2026-08-21 fleet2) — guest env lacks OpenRouter base

Fleet `20260821-005824-741456` still showed `fast_mode: true` and Anthropic
billing-fatal / 0-interaction Fast Mode cache hits despite the host-side
OpenRouter preference. Guests decode `BACKEND_ENV_B64` (have `OPENROUTER_API_KEY`)
but do not inherit controller `ANTHROPIC_BASE_URL` / `CLAUDE_CODE_ANTHROPIC_API_KEY`,
and the shared Anthropic key is often **not** on cooldown — so the cooldown-only
OpenRouter fallback never fired and Fast Mode still claimed the session.

**Fix:** when Fast Mode would be active, pass `preferOpenRouterGateway` into
`resolveClaudeCodeSandboxApiKey` so OpenRouter wins without requiring host base
or cooldown. Dedicated `sk-or-*` keys also infer the OpenRouter base URL.

### Recurrence (2026-08-21 fleet3/4) — Andy write-through + Fast Mode cache

Benchmark user `1f85ff25-…` is in `FAST_MODE_WRITE_THROUGH_USER_IDS`, so
`shouldWriteFastModeCacheForUser` forces Fast Mode on every Claude Code session
even when `BENCHMARK_FAST_MODE_CACHE` is unset. Fleet4 still showed
`0 interactions` + HTTP 403 cache hits for red/yellow while green escaped via a
live Wikipedia download. Preferring OpenRouter alone was insufficient when the
tee-proxy/flags still engaged.

**Fix:** `shouldEnableClaudeCodeFastMode` returns false whenever
`OPENROUTER_API_KEY` is set — no `CLAUDE_CODE_FAST_MODE` flags, no proxy inject.


### Recurrence (2026-08-21 k=5 t5) — opt-in gate did not block tee injection

Fleet trial `20260821-025529-889656` / agent `bd4cd666-…` timed out at soft
cap ~900s (`Agent status: ACTIVE`) with red/yellow lineages PAUSED mid-recovery.
Transcripts showed repeated `HTTP 403` / `Agentic loop finished: 0 interactions`
plus classic `369,851`-byte UTF-8-corrupted attachment narratives (stale Fast
Mode cache fingerprints). Blue+green completed; yellow eventually recovered via
external download; red never joined before the soft timeout.

`shouldEnableClaudeCodeFastMode` correctly returned false without
`CLAUDE_CODE_FAST_MODE_ENABLED=1`, but `createClaudeCodeSession` still called
`buildFastModeAnthropicEnv(...)` whenever `preferSandboxBase` was false — Andy
write-through / `fast_mode_cache_enabled` alone re-injected the public tee-proxy
and stale cache hits. Separately, a dedicated `sk-or-*` key with
`ANTHROPIC_BASE_URL=https://api.anthropic.com` kept the Anthropic host (403) and
flipped `preferSandboxBase` false.

**Fix:** `shouldInjectClaudeCodeFastModeProxy` — tee/flags only when opt-in Fast
Mode is active AND not on a funded non-Anthropic base; `sk-or-*` keys always get
the OpenRouter base. Cemented in `code-agent-credential-redaction.test.ts` +
`fast-cache-code-agent.test.ts`.

## Reusable lesson

A capture/replay wrapper may serialize a request to build its cache key, but must
never substitute that serialization for the request — pass unserializable bodies
through untouched and mark them uncacheable. The same rule applies to **response**
bodies: never force binary through `text()` / UTF-8; preserve bytes (e.g. base64)
or pass the original `Response` through. Prefer an allowlist for text decoding.
Funded gateway transports must not be overwritten by a Fast Mode proxy that
forwards to a different host. Write-through Fast Mode allowlists must not defeat
funded-gateway recovery paths.
