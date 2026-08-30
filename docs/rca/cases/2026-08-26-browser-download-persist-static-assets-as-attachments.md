---
id: 2026-08-26-browser-download-persist-static-assets-as-attachments
date: 2026-08-26
title: Browser download persister treats static SVG/PNG/JSON page assets as attachments and dumps them into chat
surface: agents
component: spawn_browser_agent_v3 / download_persist
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/download_persist.py — Network.responseReceived heuristic classified bare .svg/.png/.json Fetch/XHR as downloads and wrote them into /tmp/downloads
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
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py (attachment_download_rejects_static_ui_assets + browser_download_persister_ignores_network_fetch)
status: open
---

## Problem

**What failed:** When SMS agent `59f35244-d66d-4fc5-bada-5134e37e0816` ordered Blue Bottle Coffee via `spawn_browser_agent`, the browser task completed successfully, then the harness posted **29 ASSISTANT `file_pointer` messages** into chat — DoorDash/Blue Bottle UI chrome (`cart-fill.svg`, `add-circle-line.svg`, `card-visa-color.svg`, Mapbox `sprite.json` / `sprite.png`, etc.), not order receipts or intentional downloads.

Sibling DoorDash agent `f4cc61ef-5484-4e82-9dbc-01b21f07b5d9` posted **70** such file messages (59 `.svg`).

**FE:** https://www.roselabs.ai/?agent-id=59f35244-d66d-4fc5-bada-5134e37e0816 — verified reachable (119 messages, 29 file dumps).

**Local repro:** Classifier asserted static assets without `Content-Disposition` must not be downloads — **6/6 FALSE_POSITIVES** on buggy Network-heuristic path. Real downloads with disposition or `/download|/export` paths remained True.

## Diagnosis

**Critical path:** page Fetch/XHR for `.svg`/`.png`/`.json` → `BrowserDownloadPersister` Network sniff → write under `/tmp/downloads` → `extract_session_files` on completion → handler yields `AssistantEvent(file_pointer=…)` for every session file → chat fills with random assets.

**First-bad boundary:** Network heuristic treated ordinary browsing as Chrome downloads. Product intent is: only files Chrome would put in Downloads.

**Archive searches:** novel — no prior case on this boundary.

## Solution

**Implemented (CDP-only / Chrome Downloads):**

1. Rewrote `BrowserDownloadPersister` to listen only to `Browser.downloadWillBegin` /
   `Browser.downloadProgress`. Removed `Network.responseReceived` heuristic sniffing.

2. On `downloadProgress` `completed`: if Kernel already has the file in
   `/tmp/downloads`, do nothing; otherwise materialize via credentialed page
   fetch of the *Chrome-download URL only*.

3. Kept goto `ERR_ABORTED` navigation fallback and narrowed `looks_like_download_url`
   so bare image/svg/json extensions no longer qualify without disposition /
   download-path markers.

4. Cemented blackbox: static UI asset rejection; Chrome download event
   materialization; Network.register not used.

**10k-agent behavior:** O(1) per real Chrome download event; fewer FS writes and
ASSISTANT rows per browser completion — no new fan-in.

## Human feedback

User directed: only return assets that would appear in Chrome downloads, not
anything fetched during normal browsing; prefer CDP download folder over URL
heuristics. Implement and verify `browser-file-upload-tinypng` still passes.

## Reusable lesson

When chat fills with site chrome SVGs/sprites after a browser run, stop sniffing
Network Fetch for download-looking URLs — only materialize files Chrome reports
via `Browser.download*` (or true navigation ERR_ABORTED downloads).
