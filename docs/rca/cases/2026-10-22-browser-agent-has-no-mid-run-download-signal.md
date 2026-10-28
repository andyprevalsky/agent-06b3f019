---
id: 2026-10-22-browser-agent-has-no-mid-run-download-signal
date: 2026-10-22
title: The browser agent never sees a file it downloaded mid-run, so a run that tries to confirm the download times out
surface: agents
component: browser-observation-downloads
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: agents/providers/rose/browser_use.py format_browser_state_for_tool and the handler's per-step observe_page_state carry no downloaded-file information; BrowserDownloadPersister materialises the file (Tilion ledger / session downloads) but nothing feeds it to the agent until the verifier and completion extraction
symptoms:
  - "[DownloadPersist] Materialized Chrome download into session downloads"
  - "only public HTTP(S) pages may be opened"
  - browser-file-upload-tinypng timed out after the compressed file was downloaded
tags:
  - downloads
  - browser-state
  - tinypng
  - tilion
  - observation
sources:
  - agent 85ec29b8-0ba3-48bf-be40-5628d1a2f94e
repro: live local fixture through the single-CDP mux (provider tilion) with real DOMService and BrowserDownloadPersister; script kept by lane A1, regression handed to lane C for agents/tests/blackbox/browser_tilion.blackbox.py
status: open
---

## Problem

Lane F's tinypng rerun on Tilion (35d65d3e5): both uploads succeeded and the worker logged
`Materialized Chrome download into session downloads` twice, so the compressed file was in
the Tilion worker ledger. The browser agent never learned that. It tried
`chrome://downloads` (refused), waited, ran evaluate and read_logs, and timed out.

## Diagnosis

Code read on 35d65d3e5: no provider gives the browser agent a mid-run download signal. There
is no files tool (only `upload_file` via `available_file_paths`), the per-step observation and
`read_browser_state` have no downloads section, the humanized click returns no download info,
and `chrome://downloads` is refused by our own navigation guard
(`_non_public_navigation_reason`: only public HTTP(S)), not by Tilion. Session files are
listed only for the browser verifier and for completion extraction, both through
`_session_files_for_listing`, which already reads the Tilion ledger. So a run passes when the
agent clicks and calls done, and fails when it tries to confirm the download first.

Local repro (real Chromium behind the real mux, provider tilion, real DOMService and
BrowserDownloadPersister, Playwright clicks a local download link): the ledger holds
`rs.png` (1108 bytes) while the formatted browser state the agent reads does not list it.
Run evidence (lane F, agent 85ec29b8): the download click's tool result was
`{"success":true,"message":"","action_step":14}`; the step context had no downloads section
and no `tilion-download` path; `chrome://downloads/` was refused at 01:12:42 with
"Refusing unsafe navigation ... only public HTTP(S) pages may be opened"; the file had been
persisted and uploaded (149852 bytes) at 01:11:28. Kernel history for this task is 1/4 passes
(2026-08-20, no transcripts), consistent with a provider-neutral gap. Side finding: each
download was materialised and uploaded twice (two `Materialized` lines per guid), because the
guid dedupe key is added only after the awaits, so near-simultaneous events race.

## Solution

Proposed (lane C files; LLM-visible, queued for approval at deploy):
BrowserDownloadPersister keeps a bounded name+size list of the files it materialised (all
providers, no extra I/O; the same basename replaces); the handler attaches it to each step's
observation; `read_browser_state` keeps it on re-fetch; the formatter renders
`Downloaded files (this browser session):` with one line per file. The repro then lists the
file exactly once, 5/5. 10k agents: in process per activity, at most 20 entries, no
backend call per step.

## Human feedback

None recorded.

## Reusable lesson

When an agent action produces an artifact, put that artifact in the agent's own observation; a file the harness only shows to the verifier is invisible to the agent.
