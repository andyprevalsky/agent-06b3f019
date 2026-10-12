---
id: 2026-10-12-image-retry-reused-tag-after-unbounded-depot-stream-silence
date: 2026-10-12
title: Silent Depot publisher attempt held the image build for 16 minutes, then its retry read the abandoned attempt's tag
surface: infra
component: cloudbench-image-publication
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: build_warm_image retried a remote side-effecting publication under one shared mutable tag, and cloudbench_image_publish waited on the publisher with no no-output bound
symptoms:
  - "failed to receive status: rpc error: code = Unavailable desc = error reading from server: EOF"
  - "error releasing builder: deadline_exceeded: context deadline exceeded"
  - Registry tag manifest does not match the published digest
  - Published output has no verified registry handoff; original build retained without rebuilding.
  - uncached Depot image build stalls with pushing layer and no done line for 16 minutes
tags:
  - cloudbench
  - image-build
  - depot
  - buildkit
  - registry-handoff
  - retry-isolation
  - no-output-watchdog
sources:
  - benchmark run daily-live50 20261012-191951-t1
  - benchmark run daily-live50 20261012-215230-t2
  - commit 989ffdbdd
repro: agents/benchmarks/cloudbench_image_cli_test.py::test_cold_image_stalled_publisher_attempt_retries_under_its_own_tag
status: open
---

## Problem

Two of the last three uncached Depot image builds
(`scripts/run-bench image-build --builder depot --no-cache`) lost about 20
minutes of the 5,400-second LIVE50 whole-run budget, which starts at the image
build.

- **Trial 1** (`.context/daily-live50/20261012-191951-t1`): attempt 1 began at
  about 19:54:48Z. Its private log stopped at
  `#22 51.83 Installing collected packages: ...`, which is about 19:56:52Z by the
  attempt 2 cadence. It ended at 20:13:25Z with
  `error releasing builder: deadline_exceeded: context deadline exceeded` and
  `failed to receive status: rpc error: code = Unavailable desc = error reading from server: EOF`.
  Attempt 2 used the same label and succeeded in about 4.5 minutes. Its handoff
  saw HTTP 404 for the tag for 22 seconds after the push, then a match.
- **Trial 2** (`.context/daily-live50/20261012-215230-t2`): attempt 1's log last
  grew at 21:57:08Z. The last line was `#25 pushing layer` for three layers
  (`75fa45e0` 266 MB, `7bced0c9` 552 MB and `7d0d0050` 187 MB) that never
  printed `done`. After 973 silent seconds, at 22:13:21Z, it failed with the
  same two lines. Attempt 2 reused label
  `cloudbench-warm-20261012-215247-2323369` and pushed manifest
  `sha256:b567cf1f…` at about 22:17:50Z. The handoff GET at 22:17:53Z
  (`Fly-Request-Id 01M4S334TPYBZ08Q579PFWRSF1-sjc`) returned 200 with body
  `sha256:81a55a3f…`, which was the manifest attempt 1 had exported (attempt 1
  log line 1412). The handoff raised
  `Registry tag manifest does not match the published digest`, and the run
  exited with `STAGE image-build FAILED rc=74` 25 minutes after the image start.

A later read-only check at 22:20:05Z resolved the tag to `sha256:b567cf1f…`.
Both digests were still readable by digest.

## Diagnosis

Critical path: `build_warm_image` attempt loop → `cloudbench_image_publish` →
pinned flyctl v0.4.112 `deploy --depot=true --build-only --push` → Depot
BuildKit solve and status stream → remote export and registry push → private
log → `cloudbench_image_verify_handoff`, which GETs the exact tag and compares it
with the digest in the publisher log.

1. **The remote builder kept working after the client stopped hearing from it.**
   In trial 2, attempt 1's manifest `81a55a3f` was in the registry under the
   shared tag, although its client never saw the three pending layer pushes or
   the manifest push finish. The BuildKit status stream had stopped delivering
   while the remote export and push completed.
2. **Nothing on our side bounded that silence.** In flyctl v0.4.112,
   `internal/build/imgsrc/depot.go:154` applies a 5-minute context only to
   provisioning. Its comment says, "we can only have the provisioning part in
   this context." `buildImage` → `buildkitClient.Solve` runs on the root context
   with no deadline. depot-go v0.5.3 dials plain TCP with no gRPC keepalive.
   `cloudbench_image_publish` ran the child in the foreground, redirected to the
   log, with no progress bound. The attempt therefore lasted until the remote
   side closed the connection (EOF after 973 seconds in trial 2 and about 990 in
   trial 1). The release error comes from `build.Finish`, which captured that
   expired 5-minute provisioning context: depot-go `build/build.go:69`. It is a
   symptom of any attempt that outlives provisioning by more than 5 minutes,
   not the cause.
3. **The retry reused the abandoned attempt's output name.** `IMAGE_LABEL` was
   computed once, before the three-attempt loop, so every attempt pushed to the
   same mutable tag. The handoff binds by digest correctly, but it resolves the
   tag and treats a mismatch as terminal. Fly's registry serves a tag write
   after a delay (22 seconds of 404 in trial 1; the previous value 3 seconds
   after the PUT in trial 2), so attempt 2 read attempt 1's manifest.
   - The coordinator's hypothesis that a zombie push landed after attempt 2 and
     overwrote the tag is refuted for this incident: the final tag value is
     attempt 2's digest, so attempt 1's write came first.
   - The same shared tag does allow that late overwrite whenever the abandoned
     remote push is still running during the retry. An earlier no-output
     cutoff makes that more likely, so the bound and per-attempt isolation must
     ship together.

Step 5a ladder:

- **Why could a retry observe another attempt's output?** The retry loop
  assumed that a failed local client means a finished attempt with no further
  side effects. A remote builder violates that, proven by `81a55a3f`.
- **Why was that assumption never checked?** No test modeled remote work
  continuing after the client stopped receiving its status.
- **Next rung stopped:** making Depot or Fly cancel remote work on client loss
  is third-party behavior we do not own.

Sibling failures prevented by per-attempt tags:

- this stale read;
- a genuine late overwrite;
- the native post-push `deploy --image <tag>` resolution resolving an orphan's
  manifest through the same shared tag.

Classification: our bug in the publisher retry contract and liveness bound,
exposed by third-party stream loss. The cause of the remote close after about
16 minutes (Depot builder, proxy, or a middlebox giving up on TCP
retransmission) is not observable from the retained evidence and is not owned.
The stall is not tied to a layer or a phase: trial 1 stalled during dependency
installation, before any push. It is not tied to registry auth expiry either:
the same session's attempt 2 succeeded, and trial 1's stall needed no registry
credentials. No retained native-builder log shows a stall.

Searches run:

- `rca_archive.py search` for the literal EOF/release error strings and for
  "image build push stall hang no output watchdog publisher depot registry";
- grep of `docs/rca` for `error reading from server`, `releasing builder` and
  `pushing layer`.

These found related image-publication cases (2026-10-05 post-push rebuild and
2026-10-07 registry handoff), but no prior stalled stream or reused tag. This
incident is novel. It is related to the handoff case, whose digest binding
correctly refused the ambiguous tag.

Golden references (Step 6b):

- `claude-code-src/src/services/api/claude.ts:1868-1925` aborts a stream that
  delivers no chunks for `STREAM_IDLE_TIMEOUT_MS`, because the SDK's request
  timeout covers only the initial fetch.
- `codex/codex-rs/model-provider-info/src/lib.rs:66,512-516` applies a default
  300-second `stream_idle_timeout` to streaming responses.

Both use a no-progress bound that resets on every received chunk, kept separate
from the total wall-clock limit, and fail the attempt into the existing retry.
The registry-tag isolation has no analog because neither harness publishes
images.

Step 7 note: this parallel lane had no sub-agent tool, so the adversarial
review was a self-review. A separate adversarial review remains a follow-up.

## Solution

- `scripts/lib/cloudbench-image-publisher.sh`: `cloudbench_image_publish_watched`
  runs the publisher as an owned job, with its complete output in the private
  log. If the log does not grow for `CLOUDBENCH_IMAGE_PUBLISH_IDLE_SECONDS`
  (default 360), it terminates the exact process tree with the existing
  birth-checked `cloudbench_terminate_tree_and_wait`. It then appends the reason
  to the retained log, prints it, and returns 124 so the existing retry runs.
  - The bound is a liveness check, not a wall-clock budget, and no task timeout
    changed.
  - Rationale for 360 seconds: the longest silent operation in a retained
    healthy attempt was the 81-second layer export, and flyctl's own silent
    waits (Depot provisioning, Docker daemon readiness) are bounded at 300
    seconds, so its specific errors still surface first.
  - An invalid bound fails before launching any provider.
  - Caller cancellation still owns the whole tree.
- `scripts/run-bench-cloud` `build_warm_image`: every attempt gets a fresh
  `cloudbench-warm-<UTC>-<pid>` label, guaranteed distinct within the build, in
  the format the handoff and post-push validators already require. An abandoned
  attempt's remote push can therefore never satisfy, contradict or overwrite a
  later attempt's handoff.
- Unchanged: build contents, the digest-bound handoff, its terminal treatment of
  mismatches, rc 74 handling, receipts, the retry count and the inter-attempt
  delay.

Expected effect: trial 2 would have retried at about 22:03Z under a new tag
instead of failing at 22:17Z. A stall costs about 6 minutes plus one healthy
attempt, instead of about 16.5 minutes or a terminal rc 74.

10k-agent note: this is one controller-local image build per campaign. The
change adds no per-agent channels, rows or fan-in.

Not fixed (third party): flyctl v0.4.112 calls `FinishBuild` with the expired
provisioning context, so Depot is not told that a build longer than 5 minutes
finished.

Verification:

- Repro command:
  `cd agents && PATH=<agents venv>/bin:$PATH python -m pytest -q benchmarks/cloudbench_image_cli_test.py -k stalled_publisher_attempt`.
- On the buggy revision:
  - `remote-eof` failed with the trial 2 signature: the same label for attempts
    1 and 2, `Registry tag manifest does not match the published digest`, and
    rc 74;
  - `silent-stall` held the build until the 90-second fixture deadline;
  - `invalid-bound` launched the provider;
  - `slow-progress` (control) passed.
- On the fixed revision, all four pass. The scenarios run inside the existing
  `benchmark-live-results` deploy gate through its `cold_image` selector.
- Live confirmation on the next uncached build is still pending, which is why
  this case stays open.

## Human feedback

Coordinator, mid-RCA: include the reused-tag "zombie push" failure in the root
cause and fix, by confirming or refuting it with evidence. Evidence refuted the
literal late-overwrite ordering for trial 2 but confirmed the shared-tag cause.

## Reusable lesson

Give every retry of a remote side-effecting operation its own output identity,
and bound its silence, because a failed local client does not prove the remote
work stopped.
