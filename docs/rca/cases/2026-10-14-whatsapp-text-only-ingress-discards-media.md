---
id: 2026-10-14-whatsapp-text-only-ingress-discards-media
date: 2026-10-14
title: WhatsApp text-only ingress discarded images and voice notes
surface: back-end
component: whatsapp-webhook
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: back-end/src/domains/whatsapp-webhook/service.validation.ts parseWhatsAppInboundMessages skipped every message whose type was not text
symptoms:
  - "No inbound WhatsApp text to route"
  - "voice notes and images on whatsapp are not working"
  - "media -- image without caption retained"
  - "media -- voice note without text retained"
tags:
  - whatsapp
  - media
  - voice-note
  - inbound-media
sources:
  - commit 32947aee57006a63d9232f77daf7725af70f32ff
  - PR #974
repro: back-end/src/tests/blackbox/whatsapp-webhook.blackbox.ts --parse-media-only
status: open
---

## Problem

The user reported that WhatsApp voice notes and images did not work. Production
Render logs show the ingress acknowledged payloads with `No inbound WhatsApp
text to route` at 2026-10-09T06:11:13.576Z and 2026-10-13T18:09:07.690Z. Nearby
text messages were parsed and routed. The drop logs contain only top-level
shape, so they do not establish which sender or media type caused either
warning. The local reproduction proves the missing image/audio capability;
association of those historical warnings with a particular user upload remains
unverified.

## Diagnosis

Critical path: Meta webhook -> signature verification -> message normalization
-> user provisioning -> atomic inbound persistence -> shared media processing
-> supervisor -> WhatsApp reply.

The first bad boundary is message normalization: the parser skipped every
`message.type !== 'text'`. The domain type represented text only, routing passed
no attachments, and the original permanent blackbox explicitly required image
messages to parse as null and not provision a user. This was the documented v1
text-only design, not a demonstrated regression, provider outage, or model
failure. The deepest owned missing capability is an authenticated WhatsApp
media adapter into the existing shared SMS processor; stop the escalation at
the documented channel capability decision.

Archive searches: `No inbound WhatsApp text to route` and `WhatsApp voice notes
images media ignored`. Related cases cover SMS media persistence and
`start_new_agent` FilePointer forwarding; neither covers native Cloud media
ingress. This is a novel gap, with related SMS mechanisms reused.

Exact unchanged local reproduction:

```bash
cd back-end && node --import tsx src/tests/blackbox/whatsapp-webhook.blackbox.ts --parse-media-only
```

Before production edits, exit 1: 4 passed and 4 failed. Captioned image,
captionless image, and voice-note assertions received `actual null`; the mixed
batch retained only text. After the fix, the same command exited 0 with 8
passed, 0 failed. The permanent assertions and fixtures were not weakened.

Golden references inspected: Hermes
`gateway/platforms/whatsapp_cloud.py:670` authenticates metadata and byte GETs;
OpenClaw `extensions/whatsapp/src/inbound/media.ts:15` downloads native media
before shared processing and `auto-reply/monitor/audio-preflight.ts:20` uses
central transcription. Claude `src/bridge/inboundMessages.ts:52` and Codex
`codex-rs/core/src/image_preparation.rs:122` normalize images centrally; neither
has a direct Cloud API equivalent. This fix converges on transport retrieval
followed by one shared processor.

## Solution

Normalize images/audio into typed media references, preserve captions and
attachment-only turns, and pass those references to the existing supervisor.
The WhatsApp provider resolves the media ID and downloads bytes using the
configured access token on both requests, with a bounded deadline and streamed
byte cap. The shared processor continues to produce existing image content,
storage FilePointers, and ElevenLabs Scribe transcripts without prompt edits or
a second transcription pipeline.

Production configuration presence was checked through the paginated Render
env reader: WhatsApp access token, app secret, webhook verify token, Graph
version and ElevenLabs API key were all nonempty. This is configuration
presence evidence, not live credential validation.

The regression remains registered in the existing WhatsApp blackbox suite,
discovered by the backend runner and invoked by `/deploy` backend coverage.
The full backend coverage run on October 14 passed all 196 domains, including
the 24-test WhatsApp domain, and all 266 unit files. Coverage met the thresholds
(89.57% statements/lines, 80.98% branches, 92.64% functions). The retained log is
`.context/deploy-runs/20261014-220120-4186766/logs/backend-coverage-blackbox-20261014-222604-382499.log`.
Release and production verification remain pending; keep this case open until
those gates have completed. No live, signed native WhatsApp media roundtrip has
been observed in this investigation.

10k-agent behavior: two bounded Meta requests per attachment and the existing
per-turn image upload or transcription. No scan or resource cost grows with
the user's agent count; the existing bounded message-ID dedup is preserved.

Separate existing limitations found during review: rich media is current-turn
input, while session history persists an attachment marker. A rapid later text
turn can supersede the richer earlier reply; this adapter does not redesign
that shared history/sequence policy. Image FilePointers are forwarded to new
agents, while replies to existing agents carry text. These are separate shared
supervisor capability gaps, not proof that the original parser drop survived.

## Human feedback

None recorded.

## Reusable lesson

Normalize every supported channel's native media into the shared attachment processor before acknowledging an inbound turn as handled.
