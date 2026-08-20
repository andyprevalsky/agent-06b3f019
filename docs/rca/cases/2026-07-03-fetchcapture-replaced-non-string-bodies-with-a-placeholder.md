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

## Reusable lesson

A capture/replay wrapper may serialize a request to build its cache key, but must
never substitute that serialization for the request — pass unserializable bodies
through untouched and mark them uncacheable. The same rule applies to **response**
bodies: never force binary through `text()` / UTF-8; preserve bytes (e.g. base64)
or pass the original `Response` through.
