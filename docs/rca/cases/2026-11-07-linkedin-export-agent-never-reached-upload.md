---
id: 2026-11-07-linkedin-export-agent-never-reached-upload
date: 2026-11-07
title: LinkedIn export agent never reached its upload: realm-mismatched reattach, a leaked Tilion CDP slot, dropped blob downloads and a 0-contact "success"
surface: cross
component: spawn-browser-agent-v3 (session init, parallel setup, download persistence) + integrations LinkedIn upload
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/download_persist.py _materialize_chrome_download_once — only http(s) Chrome download URLs were materialized, so LinkedIn's blob: archive download never became a file; plus handler.py init realm and parallel-setup teardown, and routes.upload.ts accepting an archive without Connections.csv"
symptoms:
  - "Credential payload for google.com is missing passkey material"
  - "connect() timed out after 15s — CDP connection to ws://127.0.0.1:38239/devtools/browser/rose-single-cdp is too slow or unresponsive"
  - "Completed download missing http(s) URL; cannot materialize"
  - "Failed - Insufficient permissions"
tags:
  - linkedin
  - integrations
  - downloads
  - blob
  - tilion
  - cdp
  - credentials
  - passkeys
sources:
  - agent d8e2f764-ecd4-4eaf-b74c-31142adcf0eb (prod, 2026-10-28, archive ready but never downloaded)
  - agent ae7983a2-1636-4eed-b908-69bd4dd6f470 (local live run 2026-11-07, failed then completed after the fixes)
  - agent 339695ba-f08e-495e-9f4d-965eb8e8ba39 (local blob-download → Claude Code handoff check, sha256 matched)
  - PR #1749
repro: agents/tests/blackbox/browser_tilion.blackbox.py::test_tilion_blob_download_is_read_from_the_page_with_one_request
status: fixed
---

## Problem

LinkedIn connect spawns an export agent that requests the archive on
`/mypreferences/d/download-my-data`, waits, downloads the ZIP and has a Claude
Code agent `curl` it to `/api/integrations/linkedin/upload`. No prod run had
ever uploaded. Run d8e2f764 (Oct 28) saw the archive ready by 07:28Z but spent
33 hours on "Insufficient permissions" downloads, `chrome://downloads`
refusals, LinkedIn's "Fuse limit exceeded" after repeated retries, and browser
resume failures.

The live local run ae7983a2 (Nov 7, Tilion) hit three more defects in sequence:

1. Its Gmail check died at start: "Credential payload for google.com is missing
   passkey material" (three google.com passkey IDs).
2. Every later browser start then failed: "connect() timed out after 15s",
   with `[CdpMux] Provider reports the session busy (4409 ...)` in the worker
   log, and backend close returned 500 ("another client is attached").
3. Once those were fixed, the download produced no file.

## Diagnosis

1. **Realm.** The agent's logical browser was last on linkedin.com.
   `/browser-session/init` reattached it and returned task-info material
   (`auth_realm: linkedin.com`, no google passkeys, no `auth_options`). The
   worker took its realm from the new start URL (google.com) and fetched
   google.com options with three enabled passkeys.
   `build_realm_credential_state` then refused the mismatched pair. The resume
   path already used the response's `auth_realm`; the init path did not.
2. **CDP slot.** That error was raised in `_process_data()` while
   `_setup_browser()` had already attached DOMService and Playwright through
   the loopback multiplexer. `asyncio.gather` propagated the data error and
   dropped the browser result, so teardown received `dom_service=None`. The
   multiplexer keeps Tilion's single upstream socket open while any downstream
   client is connected. Its "Upstream CDP socket attached" at 23:55:18 has no
   matching "released", whereas the successful 23:43 run released its socket.
3. **Blob.** LinkedIn's button XHRs the archive (200, `application/zip`,
   `Content-Disposition: attachment`) and saves it from
   `blob:https://www.linkedin.com/...` (d8e2f764's downloads list shows exactly
   these URLs). `_materialize_chrome_download_once` returned early for any
   non-http(s) URL ("missing http(s) URL; cannot materialize"), so the agent
   could never hand the ZIP on.
4. **False success.** An archive without `Connections.csv` is LinkedIn's first
   installment (d8e2f764: 8.6 KB of Profile/Registration/...). It imported as
   0 contacts, marked LinkedIn CONNECTED and answered "LinkedIn data imported
   successfully".

## Solution

- `handler.py` init uses `_resume_context_from_session_info(session_data, ...)`.
  The initial state is the realm its material belongs to, and the first step's
  realm transition prepares google.com and reloads.
- `handler.py` parallel setup still raises exactly what `asyncio.gather` raises.
  On that exit it cancels the unfinished side and waits for it within the
  terminal disconnect bound. A finished browser side's DOMService and Playwright
  handles become the activity's, and the existing except/finally cleanup
  releases them.
- `download_persist.py` accepts `blob:` URLs. It reads them in the page that
  created them, under Chrome's suggested filename, with no second request to
  LinkedIn's rate-limited endpoint. It logs in-page fetch failures instead of
  returning silently.
- `/linkedin/upload` refuses an archive without `Connections.csv` with 422
  before any write. The message names the first installment and the download
  page.

Verified live (local stack, Tilion): ae7983a2 completed. It downloaded
`Basic_LinkedInDataExport_11-06-2026.zip.zip` (170,039 bytes) from a blob URL.
Claude Code uploaded it (HTTP 200), and the import wrote all 227 named
connections plus 480 messages. Integration: CONNECTED.

## Human feedback

- Andy, 2026-10-20: validation means the spawned agent actually finishes the export, download and upload, and the integration shows connected.
- Andy, 2026-11-06 (`/goal`): iterate with a live agent until the LinkedIn connection agent works completely, pacing runs because LinkedIn rate-limits.

## Regression tests

- `spawn_browser_agent_v3.blackbox.py`: `test_reattached_browser_session_starts_in_the_realm_its_credentials_belong_to` (fails with the exact passkey error on the old code), `test_credential_setup_failure_disconnects_the_connected_browser_clients` (DOMService disconnect never awaited on the old code), `test_activity_cancelled_mid_setup_releases_the_connected_browser_clients` (activity cancelled after the browser side connected: client never released on the old code).
- `browser_tilion.blackbox.py`: `test_tilion_blob_download_is_read_from_the_page_with_one_request` (real Chromium behind the fake Tilion gateway; asserts one archive request).
- backend `integrations` blackbox: `POST /linkedin/upload first installment without Connections.csv -> 422` (200 / `contacts: 0` on the old code).

## Reusable lesson

A setup step that runs two coroutines in `gather` must own the success side's
resources when the other side fails. A download persister must cover the URL
shapes real sites use for saved files, `blob:` included.
