---
id: 2026-10-06-playwright-cache-parent-preceded-runtime-ownership
date: 2026-10-06
title: Checkout browser cache was consumed before its shared parent became runtime-owned
surface: infra
component: cloudbench-driver-browser-bootstrap
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench-run.sh creates the Playwright cache beneath a root-private shared parent before its existing runtime-user ownership step
symptoms:
  - new-user checkout browser startup fails EACCES under cloudbench-cache
  - task startup cannot produce its ordinary evaluated terminal evidence
tags:
  - cloudbench
  - playwright
  - cache-parent
  - permissions
  - startup
sources:
  - commit 5c1fc870c237908db79191ed6c6ae5de5dd96e48
  - plan:.context/fresh-claude-grouped50-20261006/playwright-cache-parent-packet/handoff-checkpoint.safe.json
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_prebuilt_checkout_browser_cache_parent_is_runtime_writable
status: open
---

## Problem

The independent fifty-task DAILY control exposed a real checkout-bootstrap
permission failure beneath `/data/cloudbench-cache/playwright-browsers`.
The root driver creates the shared parent under umask077, but its intended
ownership step is later than the first checkout Playwright consumer. Giving
only the browser-cache child to the runtime user leaves that user unable to
traverse the root-owned0700 parent. The kernel returns errno13 before the
checkout browser can be installed. This is missing usable startup state,
not an LLM evaluator verdict or a microscopic observation timeout.

The original control and every verdict remain untouched. This failure is one
reason that control supplies no credit toward the new five consecutive LIVE
fifty-task goal; the local regression does not retroactively repair it.

## Diagnosis

Path: root driver under private umask → first mkdir beneath the shared cache →
child-only ownership change → nonroot Playwright mkdir `.links` → kernel access
denial → later intended parent ownership is unreachable. The same ordering also
fails when a stopped/reused volume already has a root-private cache parent.
A runtime-owned existing parent is the positive inverse.

Two archive searches were `playwright mkdir cloudbench-cache permission denied`
and `root parent runtime user writable cache first consumer`. The October6
private-dependency-overlay case is related: its visible overlay root lost donor
metadata, whereas this parent is deliberately shared and is owned too late.
The July25 missing-Chromium setup case is also related, but installing binaries
cannot resolve this traversal denial. This is a new ordering incident with its
own driver/cache boundary.

The permanent existing dependency-sync family adds three parent states: missing,
root-private and runtime-owned. It extracts the actual first-consumer driver
fragment, preserves umask077, and executes its installer as a real nonroot
Linux user. Only the declared installer transport is replaced; the kernel
permissions, driver mkdir/chown, UID transition and parent/child traversal are
native. Original5c1 produces two kernel-permission failures and one healthy
inverse pass (0.556 seconds). Moving the existing ownership stanza passes the
identical three cases (0.554 seconds). These small local durations are synthetic
correctness evidence, not production startup performance.

Both exact offline network-none containers were normally retired and are absent;
their captured native outer births are absent. There are no provider or model
requests, new image build, current control mutation or task outcome credit.
Earlier fixture setup attempts remain separate. Source-relative Ruff introduces
no new diagnostic class. The newly formatted owning function is AST-identical
to the executed control; every old test AST and baseline module byte is unchanged.

## Solution

Move the existing dedicated-cache-parent mkdir/chown immediately after Prisma
synchronization, before the first Playwright cache consumer. Keep its intended
runtime owner, private mode and later consumers unchanged. Do not chown the whole
`/data` volume, loosen directory permissions, replace the image or alter tasks.
The controls retain the root-owned data directory and an unrelated root-private
file inside the shared parent. At10k guests this reorders one existing constant
local setup operation per driver, without another provider request or install.

Host coverage already discovers the dependency-sync family but skips this
root-Linux permission primitive on Mac. The existing status-service-shutdown
Linux fixture now extracts the same permanent function and derives all three
states from its actual decorator. Its exact fixture root is traversable by the
runtime user and remains separate from private status/authentication files.
The normal Linux dispatcher snapshots the owning dependency test alongside its
existing read-only inputs; no pytest/image dependency or new test family is added.
The complete composed C3 source then passed the normal STATUS dispatcher in
3.395 seconds, including the same three permission states and original status
controls. All242 mounted source inputs matched; exact stop/export/removal
succeeded, the native container and captured leaders were absent, and the
observer reported zero errors. This is composed-source discovery evidence,
not an immutable final-head or task-performance claim. An earlier source-only
dispatch from the incomplete private candidate failed before native allocation
and retains zero fixture/acceptance credit. Final integrated deploy qualification
remains separate.

Final independent review, combined source policy, normal deploy qualification,
production rollout and actual new LIVE trials remain pending. The original
control failure and independent monetary custody gap remain honest.

## Human feedback

Fix causes in parallel while the ordinary control finishes its exact cleanup.
Use generous stage targets, usable next-stage state and whole-run bounds; do not
restart on observational silence or weaken task/evaluation contracts. Preserve
Freedom and unrelated services/resources.

## Reusable lesson

Make every required parent traversable by the actual runtime user before the
first child consumer; correct child ownership alone cannot cross a private parent.


## Existing ngrok fixture extraction, October 6

The final850 covered benchmark failed all twelve existing ngrok-bootstrap
variants before invoking their driver fragment: its end delimiter was the DB
warm-start paragraph that this parent-ownership repair correctly moved before
stack selection. Searching after stack selection therefore raised ValueError.
The fixture now ends at the real following stack-launch handoff. Driver code,
all twelve scenarios and every bootstrap/architecture/failure assertion stay
unchanged. Two archive searches were `ngrok bootstrap hangs fixture` and
`fixture extraction delimiter moved paragraph`; this browser-bootstrap case owns
the source movement, while the old production tunnel repair remains correct.

The original owning missing-tool case reproduced the delimiter failure in
3.830seconds. Correcting only that delimiter yielded eleven passes and one
existing-hangs whole-command timeout; the latter had already printed
BOOTSTRAP_DONE. The installer still bounds each binary probe at5seconds, and
the fixture retains curl connect10/max30 inputs. The enclosing10second test
command guard measured startup and multiple native probes as well. A controlled
local6second shell startup delay gave the boundary-only fixture the same
whole-command failure in10.862seconds. With a generous30second whole fixture
guard, that identical control passed in12.236seconds. All twelve ordinary
cases then passed in14.478seconds. This proves the enclosing guard can reject
usable bootstrap state; it does not prove the exact cause of the original host
delay or claim a production ngrok speed improvement.

Only the extraction delimiter and whole fixture guard change. The five-second
production probe, all transport limits, failure verdicts and assertions are
unchanged. The ten captured verification leaders were revalidated natively
absent. One private proxy setup failure is retained without owning credit.
Normal combined covered benchmark qualification and production rollout remain
pending; this local fixture supplies no task/acceptance credit.
