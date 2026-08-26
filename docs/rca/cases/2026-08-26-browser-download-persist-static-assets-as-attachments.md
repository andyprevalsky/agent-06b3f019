---
id: 2026-08-26-browser-download-persist-static-assets-as-attachments
date: 2026-08-26
title: Browser download persister treats static SVG/PNG/JSON page assets as attachments and dumps them into chat
surface: agents
component: spawn_browser_agent_v3 / download_persist
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/download_persist.py — looks_like_download_url / is_browser_attachment_download classifies bare .svg/.png/.json/.jpg Fetch/XHR URLs as downloads without Content-Disposition
symptoms:
  - cart-fill.svg
  - "[BrowserAgent] Posting output files as ASSISTANT messages"
  - "[DownloadPersist] Saved attachment to session downloads"
  - sprite.json
  - random assets in chat after spawn_browser_agent
tags:
  - browser
  - download-persist
  - file-pointer
  - kernel
  - spawn-browser-agent
  - static-assets
sources:
  - agent 59f35244-d66d-4fc5-bada-5134e37e0816
  - agent f4cc61ef-5484-4e82-9dbc-01b21f07b5d9
repro: none-recorded
status: open
---

## Problem

**What failed:** When SMS agent `59f35244-d66d-4fc5-bada-5134e37e0816` ordered Blue Bottle Coffee via `spawn_browser_agent`, the browser task completed successfully, then the harness posted **29 ASSISTANT `file_pointer` messages** into chat — DoorDash/Blue Bottle UI chrome (`cart-fill.svg`, `add-circle-line.svg`, `card-visa-color.svg`, Mapbox `sprite.json` / `sprite.png`, etc.), not order receipts or intentional downloads.

Sibling DoorDash agent `f4cc61ef-5484-4e82-9dbc-01b21f07b5d9` posted **70** such file messages (59 `.svg`).

**FE:** https://www.roselabs.ai/?agent-id=59f35244-d66d-4fc5-bada-5134e37e0816 — verified reachable (119 messages, 29 with `file_pointer`).

**Local repro (0.28s):** Classifier asserts static assets without `Content-Disposition` must not be downloads — **6/6 FALSE_POSITIVES** on current code (`cart-fill.svg`, `add-circle-line.svg`, `sprite.json`, `sprite.png`, `clear.png`, product `.jpg`). Real downloads with disposition or `/download|/export` paths remain True (0 false negatives in the same script).

## Diagnosis

**Critical path:** page Fetch/XHR for `.svg`/`.png`/`.json` → `BrowserDownloadPersister` (`is_browser_attachment_download`) → write under `/tmp/downloads` → `extract_session_files` on completion → handler yields `AssistantEvent(file_pointer=…)` for every session file → chat fills with random assets.

**First-bad boundary:** `looks_like_download_url` treats extensions including `svg`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `json` as downloads. `is_browser_attachment_download` then returns True for Fetch/XHR/Document/Other **even with empty response headers** (no `Content-Disposition: attachment`). SPAs load icon SVGs and map sprites via Fetch → every one is materialized and later posted to chat.

**Not the root cause (downstream):** posting `output_files` as ASSISTANT messages is the intended sink for real downloads; the data is already wrong when it enters `/tmp/downloads`.

**Archive searches:** `random assets in chat`, `browser output_files svg sprite chat`, `extract_session_files downloaded assets`, `DownloadPersist Content-Disposition attachment false positive`, `looks_like_download_url svg png` — **no prior case on this boundary** (novel). Related only loosely: image-handling explore-before-attachment (different boundary).

**Classification:** novel `our-bug` / `logical-inconsistency-in-harness-contracts`.

## Solution

**Proposed (pending approval — not implemented):**

1. Narrow `looks_like_download_url` extension allowlist: drop image/svg/json extensions from the no-disposition path. Keep document/archive/media extensions that are not typical page chrome (`pdf`, `zip`, `csv`, `xlsx`, …). Image/svg/json downloads still qualify when `Content-Disposition: attachment` is present or when the URL path contains `/download`, `/downloads`, `/export`, `/attachment`.

2. Cement blackbox: `test_is_browser_attachment_download_rejects_static_ui_assets_without_disposition` using the DoorDash/Mapbox/Blue Bottle false-positive URLs; keep TinyPNG + disposition positives.

3. 10k-agent behavior: O(1) per network response (stricter predicate); fewer FS writes and fewer ASSISTANT rows per browser completion — scales down chatter, no new fan-in.

## Human feedback

None recorded.

## Reusable lesson

When chat fills with site chrome SVGs/sprites after a browser run, check `is_browser_attachment_download` — bare image/svg/json Fetch URLs without Content-Disposition must not enter `/tmp/downloads`.
