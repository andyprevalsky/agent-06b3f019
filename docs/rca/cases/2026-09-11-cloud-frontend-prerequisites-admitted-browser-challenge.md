---
id: 2026-09-11-cloud-frontend-prerequisites-admitted-browser-challenge
date: 2026-09-11
title: Cloud frontend bootstrap omitted ngrok and curl readiness admitted a browser-only tunnel challenge
surface: harness
component: cloudbench-public-frontend
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/cloudbench-run.sh bundled frontend stack bootstrap omitted the ngrok prerequisite; wait_for_benchmark_frontend_url probed as curl rather than a browser
symptoms:
  - "ngrok fallback unavailable: ngrok is not installed."
  - "Failed to load resource: the server responded with a status of 511 (Network Authentication Required)"
  - "Timeout after 300s (wall-clock backstop=300s)"
  - "Expected gate kyc but none was observed"
tags:
  - cloudbench
  - ngrok
  - localtunnel
  - readiness
  - client-identity
sources:
  - PR #1299
  - commit 1c1a9aab036a98e813d9d825d3e8a3e3b751fa43
  - fleet run 20260911-043116-80032
  - agent 4fb8335f-19ba-4ff8-bad6-85ee815e35ad
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: open
---

## Problem

The exact `gate-kyc-card-mint` cloud retry on `1c1a9aab0` reached the task
execution boundary, then exhausted the temporary 300-second backstop without
observing its KYC gate. It made 11 LLM calls and recorded 71 messages. The final
323.1-second duration includes cooperative pause and browser recording after the
execution cutoff. The task's generic benchmark status was `FAILED`, but the
infrastructure defect below disqualifies this run from the zero-infrastructure
stability proof.

The original guest log explicitly reported that ngrok was absent. Cloudflare's
edge had failed; the stack selected localtunnel, and its browser navigation to
`/test_payment` received HTTP 511. The browser searched for challenge recovery
instead of reaching the fixture. Its 11:42:04 message records the 511, and the
final failure reason records the missing KYC gate.

All 17 guest evidence files were preserved with SHA-256 hashes (28,664,224
bytes). Cleanup completed: independently read terminal state for the exact one
Kernel session, one Fly Machine and one volume; verified the sealed ownership
audit and retired live registry. The failed run's recording and 26 root LLM dumps
were published and verified at
<https://www.roselabs.ai/?agent-id=4fb8335f-19ba-4ff8-bad6-85ee815e35ad>.

## Diagnosis

The critical path was: warm image prerequisites -> real bundled-frontend stack
bootstrap -> tunnel selection -> public URL readiness -> remote browser -> KYC
fixture. Two owned contracts failed along that path:

1. `Dockerfile.cloudbench-warm` and the compatibility bootstrap provided
   cloudflared, but omitted the ngrok executable used by the existing fallback.
   The Fly benchmark app already had an `NGROK_AUTHTOKEN` secret; missing
   authentication was not the first failure. `cloud-init.sh` installed ngrok,
   but the warm cloud guest does not execute the complete cloud-init workflow.
2. `wait_for_benchmark_frontend_url` sent curl's default user agent. The tunnel
   can exempt that client while challenging a browser. Thus an HTTP success at
   this readiness boundary did not establish that the actual consumer could
   open the fixture. The released task then encountered the captured 511.

The permanent owning-boundary reproduction executes the actual stack-selection
shell block with an absent ngrok binary. A second reproduction executes the
actual readiness function against a real local HTTP server that distinguishes
curl from browser identity and replays the observed 511. They do not run an LLM
or assert that the benchmark itself passed.

Commands, run unchanged before and after the fix:

```bash
agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py -k cloud_bundled_frontend
```

Before: eight failures, three passes. The missing-tool cases reached
`BOOTSTRAP_DONE` and then `ngrok: command not found`; readiness incorrectly
accepted the browser-only challenge. After: all 11 cases passed. The registered
`benchmark.blackbox.py` wrapper was also executed on both sides and failed then
passed unchanged. Adversarial review added historical checkouts, stalled version
commands, redirects, and HTTP 200 interstitials: the expanded permanent suite
failed nine of 18 cases before the second repair, then all 18 passed unchanged. It covers missing/existing tools, download/archive/executable
failure, amd64/arm64 selection, unsupported architecture, and production/simulate
branches that do not require the tool. The real Linux installer separately
installed and executed ngrok 3.39.11 from the official distribution.
The real complete-boot assembly regression then exposed the new helper basename
violating the existing payload allowlist. Renaming it with the required
`cloudbench-` prefix made that unchanged regression and its twelve adjacent
transport cases pass; the strict payload validator was not relaxed.

Archive searches: `ngrok is not installed localtunnel 511` and
`cloud browser local frontend challenge tunnel fallback`. The July 27
free-endpoint contention and unverified Cloudflare-edge cases are relatives;
this occurrence has different first-bad boundaries. Their rejection of shared
endpoint pooling and unverified public origins still applies.

## Solution

Unify ngrok provisioning in `scripts/cloudbench-install-ngrok.sh`, reused by Linux
cloud-init, new warm-image builds, and the real cloud branch that needs a public
frontend. The installer bounds its download to 30 seconds, bounds every executable version probe to five seconds, validates the
executable before atomic installation, and propagates failure. The driver reads
the installer from its sealed controller bundle, including fleet snapshots and
both boot and legacy transports, so historical requested checkouts need not
contain newer control-plane helpers. Production-only
and simulate branches do not install this unused dependency. Existing tunnel
selection and authentication remain intact; no extra fallback is introduced.

The cloud public-frontend probe uses a browser user agent, follows redirects,
and requires nonempty response bytes equal to this stack's local frontend.
Parallel local/public requests retain the existing five-second request ceiling.
Thus the tested curl-only bypass, redirect to a challenge, and HTTP 200
interstitial responses cannot release a task. This verifies the fixture HTML
response at readiness; it does not guarantee every later browser asset or
request succeeds. All existing
readiness, controller, recording, cleanup and task deadlines remain unchanged.

This is one prerequisite installation per isolated VM, normally already baked
into its image, and two concurrent frontend reads under the existing request deadline. It adds no per-agent
background task, loop, shared endpoint or process at 10,000-agent scale. Reusing
one installer removes duplicated provisioning instructions instead of adding
provider-routing flags.

Verification remains open. The hydrated Mac's exact local KYC already passed
on the prior runtime, so it does not reproduce this image-specific missing
executable. The owning-boundary tests prove the bootstrap/readiness mechanisms;
they do not substitute for the exact before/after benchmark outcome. The fixed
cloud KYC retry, full permanent gates, and a fresh ten-by-ten sequential cloud
proof remain pending. No failed slice is reused toward the consecutive streak.

## Human feedback

The user requires ten sequential slices of ten actual cloud tasks with no
infrastructure issues. Normal execution backstops remain 120 minutes; this
validation temporarily uses five minutes. Do not increase other bounds or ask
again for permission to finish the authorized work.

## Reusable lesson

Provision every supported runtime prerequisite and verify a public fixture with
the same client identity as its consumer before admitting an actual task.
