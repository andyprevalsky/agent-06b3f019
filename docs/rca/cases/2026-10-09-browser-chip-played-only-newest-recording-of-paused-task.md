---
id: 2026-10-09-browser-chip-played-only-newest-recording-of-paused-task
date: 2026-10-09
title: Browser chip played only the newest recording of a task split by an auth-assistance pause
surface: front-end
component: browser-agent-chip
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/terminal-component-group/components/BrowserAgentChip.tsx recordingSource scanned task messages newest-first and returned only the latest recording message's source (Kernel view URLs alone merged, and only for an unchanged browser_url)
symptoms:
  - 60 steps, but all i saw was it navigate like 3 links in the recording
  - Recording (60) plays only the last few steps
  - two "Browser recording saved" messages for one task_id, FE plays only the second
  - pre-approval / pre-auth-assistance browser steps missing from the replay
tags:
  - browser-recording
  - browser-agent-chip
  - auth-assistance
  - approval-resume
  - replay
  - recording-segments
  - pause-resume
sources:
  - agent 8b4d4592-c5da-4889-8a01-52824db125d1
  - commit 85712e655
  - commit 907d2fc09
repro: front-end/src/tests/blackbox/browser-agent-chip-recording-parts.blackbox.tsx "plays every recording of a task split by an auth-assistance pause, earliest first"
status: fixed
---

## Problem

Prod agent `8b4d4592` ran one DoorDash refund browser task (`e264ec23`) for 60
trajectory steps. The chip header read `Done · 60 steps`, but its Recording tab
showed only `/orders` → `/orders/4b0bf11b…` → `about:blank`.

Runtime evidence (prod `GET /api/agents/:id`, both recording artifacts, Fly
worker logs in ClickHouse):

- The task paused for auth assistance at 2026-10-08T18:32:07Z and resumed at
  2026-10-09T20:34:10Z in a new activity. Each activity saved its own FINISHED
  `Browser recording saved` message for the same task_id.
- Part 1 (`8bb1bcd7…`, 6,915,407 bytes) is a screenshot player. Its Kernel
  prefix video (`prefixVideoUrls`, still HTTP 200, 427.3 s MP4) covers steps
  1–32 and its 98 frames cover steps 33–50.
- Part 2 (`4efb6ec2…`, 17,933,443 bytes) has 117 frames for steps 53–60 only.
  Its three tab URLs are exactly what the user saw.
- The chip loaded only part 2. The FE link was
  `https://www.roselabs.ai/?agent-id=8b4d4592-c5da-4889-8a01-52824db125d1`.

## Diagnosis

`BrowserAgentChip.recordingSource` walked task messages newest-first and
returned the first recording source it found. The only multi-message merge was
Kernel `recording_view_url`s sharing the latest message's `browser_url` (added in
85712e655 for approval-split Kernel replays). This task's parts were HTML
screenshot players across Kernel `fib74k81` → Steel `f26ee1ab` → (pause) →
refreshed Steel `201b22cb` → Kernel mobile, so part 1 was discarded.

Step 5a ladder:

1. The chip discarded part 1 because it selected one source.
2. A single task legitimately saves several recordings. The recorder lives
   inside one Temporal activity. Each of these ends the activity and saves its
   recording, then restarts the same task (stable task_id) from its next step
   in a new activity with a fresh recorder: an approval or auth-assistance
   pause (here the user returned 26 hours later), a deploy-drain or
   session-expiry yield (`BROWSER_DRAIN_YIELD_STATUS` → `_drain_resume_state`).
   Within one activity, `BrowserAgentRecorder.transition_browser` already keeps
   one timeline across challenge-recovery sessions.
3. The consumer had no contract for "a task's recording is the ordered sequence
   of every saved part". It used per-kind heuristics instead: newest wins, from
   a July 1 WIP rationale that earlier sessions are "frozen/splash attempts",
   plus one Kernel same-session patch. That rationale no longer has a producer:
   - activity retries are disabled (`MAX_ACTIVITY_ATTEMPTS = 1` since
     f69857572, 2026-07-23);
   - challenge recovery stays inside one recorder;
   - the simulated recorder saves once at the end.
   Every remaining extra part continues real work. Runs from before 2026-07-23
   may show an early retry part first. Rung 4 would be the pause/resume
   activity design itself, which is deliberate.

Part order is not save order. A background cleanup task can save the pre-pause
part after a short resumed part. Before this fix, nothing recorded which
activity a saved recording covered.

Local repro (fails on the buggy chip, passes after the fix, assertion unchanged):
`cd front-end && npx vitest run src/tests/blackbox/browser-agent-chip-recording-parts.blackbox.tsx -t "auth-assistance pause"`
failed with `expected last "vi.fn()" call to have been called with [ 'agent-1', 'fp-part-1', … ]`
/ received `fp-part-2`, and passed after the fix.

## Solution

**Producer.** Each saved recording now carries `recording_started_at`, the
recorder's wall-clock start (`_recording_part_metadata`, both the Kernel and
screenshot finalizers).

**Consumer.**
- `browser-agent-chip/recordingSegments.ts` `buildRecordingSegments` derives
  one deduplicated segment list from every task message.
  - Each message contributes its best source: stitched `video/*` pointer, then
    `recording_view_urls`, then `recording_view_url`, then the HTML pointer.
  - Parts are ordered and placed by `recording_started_at`. Older rows use the
    latest unclaimed "Browser recording started" message.
- The chip plays the earliest segment first and auto-advances `<video>`
  segments. Numbered part buttons and "Next part" reach every segment,
  including HTML players, which can't signal their own end.
- `partPlayheadSec` / `partSeekTarget` place each part at its own start, so the
  live trajectory stays aligned across a pause. A click on a step in another
  part sets a pending seek that the part's video applies on `loadedmetadata`,
  after downloading first if it has to.
- `useRecordingSegmentLoads` selects the playing segment by key and loads
  pointer parts lazily. It keeps loaded parts when a later part arrives,
  dedupes in-flight loads, and revokes Blob URLs on removal or unmount,
  including a load that lands after unmount.
- This deletes the newest-wins scan and the Kernel same-`browser_url` special
  case.

**Evidence publisher.** `scripts/publish_evidence_links.py` requires every
attached part, and every Kernel segment URL, to be reachable, not just one.

**Regressions.** `browser-agent-chip-recording-parts.blackbox.tsx` covers:
- incident replay;
- Kernel→screenshot advance;
- start-ordering;
- alignment across a two-hour pause;
- seeking into an undownloaded part;
- part arrival while open;
- download landing after unmount.

The five new chip tests failed on the first-pass fix. Also:
`recording-trajectory-sync.blackbox.ts`,
`publish_evidence_links_browser_validation.test.sh` (fails on the old
publisher), and `test_browser_recording_finalizer_stamps_each_part_start`.

**Siblings covered:** approval-split HTML or Kernel parts, including a resume
on a refreshed session; deploy-drain/session-expiry restarts; a Kernel part
followed by a screenshot part.

**Golden reference.** No reference harness records browser sessions across
pauses. The closest pattern is Codex
`codex/codex-rs/core/src/session/rollout_reconstruction.rs:208`
(`reconstruct_rollout`), which rebuilds a resumed session from its whole
append-only rollout, not the newest segment. This fix converges on that.

**10k-agent behavior.** Client-side derivation over already-loaded task
messages: no new subscriptions or server work. Each additional pointer part is
one signed-URL request plus one download (7–18 MB here), made only when the
viewer selects that part. Kernel parts stream from their hosted URLs.

## Human feedback

None recorded.

## Reusable lesson

When one logical task can produce several artifacts across pause/resume boundaries, present the ordered sequence of all of them rather than selecting the newest.
