---
id: 2026-10-29-bu078-terminal-native-screenshots-absent-from-independent-evaluator
date: 2026-10-29
title: BU078 native screenshot receipts reached verifier but not independent evaluator
surface: agents
component: browser-terminal-visual-evidence
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: Successful native screenshot sidecar is available to the browser verifier but omitted from saved public messages consumed by Polar
symptoms:
  - "num_screenshots_sent=0 despite six native historical screenshot receipts"
  - "no screenshots are attached to verify the cited video frame"
tags:
  - polar
  - bu078
  - screenshot
  - evidence-custody
sources:
  - commit 4016ffaf50aeee0eff1b242d9e348f54896fdc02
  - agent 11e4d546-148b-4538-9e90-f3dc65c3d44e
  - plan:.context/r72/proof.json
  - plan:.context/r72/manifest.json
repro: agents/tests/blackbox/terminal_visual_evidence_fixture.py
status: mitigated
---

## Problem

It20 BU078r1 j0008 completed natively in939.6s but failed the declared evaluator
2/4 with stored infra_failure=false. The request asks for the maximum length of
species #9 in the first National Geographic YouTube Short, according to Monterey
Bay Aquarium, as just a number. Original source4016ffaf/patchnone returned1.8.
The evaluator accepted the aquarium length but lacked visual identification
proof; bare-number presentation was another independent failure. Original task
FAILED, grade, clocks and infra flag remain unchanged.

## Diagnosis

Original archive SHA256
2e9e83a7b46df39b63164d139ddba2c7312359f55459a715eee6845ed5227250 and all seven
normal member hashes/sizes were verified. Normal manifest SHA256
38e8412d631cfa493f4b02fcc73b22aba4868e640064d81e288f19f3183f7424.
The original raw browser-verifier context carries six native historical PNG
receipts at action steps13,18,27,30,32,34. The original step34 PNG hash is
fce08f8093850fa6629b5a002a3367f945e79d41fbcac516764526958e10b791.
Private visual inspection shows a Facebook National Geographic video frame
with 09 and BLACKTIP REEF. This proves the displayed frame, not equivalence to
the earliest YouTube Short. The latter remains unestablished.

The native screenshot handler records verified pixels in ActionHistory's
session/task-bound sidecar. The browser verifier admits those receipts. The
ordinary saved action message contains parameters and the step but no pixels;
Polar's existing screenshot extractor therefore receives zero images. The
original declared evaluator records num_screenshots_sent=0. Full encoded native
verifier dump was skipped at3589864bytes above1000000; raw context and verifier
reasoning are available, but are not claimed to be full provider-wire parity.

## Solution

The exact reviewed four-file patch
9dd79349ddc7655022fc95d535901467d0222fc3200bc12f9cb8ead809ffba20 adds terminal
persistence before successful native close/disconnect. It accepts only the
current native ActionHistory/DOM and existing admitted sidecar, rechecks
session/task/step/hash/PNG/byte/pixel provenance, and writes bounded historical
screenshot messages through the ordinary owner repository route. Messages are
excluded from acting-model context and carry no completion authority.

The existing limits remain20 images,4MiB aggregate PNG bytes,16M aggregate
pixels,1MiB/4M per image. Each metadata body is below1.5MiB, within the existing
messages endpoint100MiB parser. No URL/file hydration, capture, model call,
provider change, retry, timeout, task criterion or Polar selection change.
Later credential use before finalization suppresses export; resume does not
restore raster bytes. Eligibility is rechecked between awaited writes.

Persistence failures stop the remaining image writes and record explicit
failed/withheld counts in completion metadata. Cancellation and sealed-generation
errors propagate. Already acknowledged public captures cannot be recalled by a
later privacy-state change; no subsequent capture is sent. This is not a new
PII detector. Only successful finalization is bridged; failed/paused paths and
resumed empty sidecars gain no evidence.

Fresh independent review returned GROUNDED for the exact patch and all four
file hashes. The reviewer independently reproduced the original-image baseline
failure, all16 selected candidate checks, real repository JSON serialization into
the unchanged Polar consumer and sealed-generation propagation. The same
registered full-activity original-image control is RED on4016 and GREEN with
the patch; five new groups plus eleven existing visual/screenshot controls pass.
These are mocked transport/owning-boundary proofs, not live DB durability or a
rerun of the original task. Three personally opened primary codebases and
contrary practice are recorded in the portable review packet.

Applied only to an isolated future branch over6cb633ff42bbaf041f7ca2b74755a589a7f70095,
after verifying all four relevant baseline identities match4016. Existing case
files on that parent are preserved. No active owner/root checkout change or
provider/model/browser/DB operation was performed. Original full task outcome,
earliest-video identity and answer-only formatting remain OPEN.

## Human feedback

The coordinator required a terminal current-session trusted-sidecar bridge,
not immediate screenshot export that could precede later private credential
use. Preserve source/privacy/size contracts and the independent video-identity
gap; prove the ordinary evaluator path with the same original pixels. Fresh
exact review was required before isolated apply, and the active run remains
frozen. No original grade may be upgraded by this repair.

## Reusable lesson

An image present in one verifier's private context is not evidence delivered to
an independent judge. Trace capture, identity/privacy admission, persistence,
and actual consumer extraction separately; make delivery failures explicit
without promoting screenshot content into completion authority.
