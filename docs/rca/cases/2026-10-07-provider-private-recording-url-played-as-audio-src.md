---
id: 2026-10-07-provider-private-recording-url-played-as-audio-src
date: 2026-10-07
title: FE phone playback used Vapi's private HIPAA R2 recordingUrl as <audio src>, and daily phone benches never fetched the first-party audio
surface: cross
component: phone-recording-playback
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end RecordingPlayer + back-end vapi poll — ended-call recordingUrl (*.r2.cloudflarestorage.com/hipaa-recordings/) was copied into phoneCall metadata and used as <audio src> instead of GET /call/{id}/mono-recording
symptoms:
  - "hipaa-recordings"
  - "r2.cloudflarestorage.com"
  - "<Error><Code>InvalidArgument</Code><Message>Authorization</Message></Error>"
  - "FE phone recording playback failed"
  - "GET /api/agents/:id/phone-calls/:callId/recording"
tags:
  - vapi
  - phone-call
  - recording
  - hipaa
  - r2
  - fe-playback
  - daily-bench
sources:
  - agent b31c8a09-5992-4916-b797-b9c3ae5c75cf
repro: back-end/src/tests/unit/vapi-recording.test.ts
status: fixed
---

## Problem

Prod agent `b31c8a09-5992-4916-b797-b9c3ae5c75cf` finished outbound call
`01a11772-75ae-7000-83c6-064e004a57af` (268s, goal "cancel my membership to
gforce now") with a `phoneCall.recordingUrl` pointing at an unsigned Vapi HIPAA
object:

`https://94bdb67bb98da30b06bdd917725c037d.r2.cloudflarestorage.com/hipaa-recordings/01a11772-75ae-7000-83c6-064e004a57af-mono.wav`

The FE phone card used that URL as `<audio src>`. A direct GET/HEAD of the
object returns HTTP 400 with
`<Error><Code>InvalidArgument</Code><Message>Authorization</Message></Error>`.
The player therefore never plays.

Daily phone tasks (`phone-call-client-intake`, `phone-call-payment`,
`phone-call-ivr-dtmf`) already required agent findings and callee structured
data. They did not GET the FE recording URL or assert playable audio, so a
green daily slice could still ship a dead player.

## Diagnosis

Archive searches (`python3 scripts/rca_archive.py search "phone recording playback hipaa-recordings r2.cloudflarestorage.com"`,
`search "recordingUrl audio src Vapi phone-call FE playback"`, plus
`grep -ri "hipaa-recordings" docs/rca/` and `grep -ri "phone recording" docs/rca/`)
did not hit this boundary. Closest relative:
`2026-08-31-fe-link-browser-terminate-recording-validation` — that case is the
browser-recording FE contract, not Vapi phone audio. **Novel** at phone
playback; same problem class (harness/product sink contract omitted).

Critical path: Vapi poll `GET /call/{id}` → handler copies `recordingUrl` into
`phoneCall` metadata → FE `RecordingPlayer` sets `<audio src={recordingUrl}>` →
browser GET of private R2 → 400. Archive download used the same raw URL.

Vapi's documented retrieval path is `GET https://api.vapi.ai/call/{id}/mono-recording`
(Bearer), which 302s to a short-lived signed URL. Native `fetch` follows that
redirect without forwarding the Bearer token to R2. The webhook/poll
`recordingUrl` is a private bucket object and is not a browser media source.

Local causal repro (exact captured URL + call/agent IDs) on the pre-fix
`archiveVapiRecording` path, with `fetch` stubbed so the private R2 object
returns the observed 400 XML and only the authenticated artifact API returns
WAV:

```
PATH=/home/ubuntu/.nvm/versions/node/v22.22.2/bin:$PATH \
  npx tsx back-end/src/tests/unit/vapi-recording.test.ts
```

Pre-fix failure (archive fetched the private URL):

```
archive must download via authenticated Vapi artifact API, got: https://...r2.cloudflarestorage.com/hipaa-recordings/...wav
```

The daily-phone evaluator gap is independent and was reproduced by
`phone_recording_playback_failures` against the same captured metadata: a
private-provider 400/XML body fails; a first-party `audio/wav` 200 passes.

Step 5a:

1. Why no audio? The `<audio>` element requested a private R2 object.
2. Why that src? `RecordingPlayer` treated `phoneCall.recordingUrl` as public.
3. Why was that URL stored? Vapi poll copied the provider field unchanged.
4. Why didn't daily benches fail? `_evaluate_phone_call_task` never GETed the
   FE recording sink or checked audio bytes.
5. Prompting the model or changing task text cannot make a private bucket
   playable. The owned sink is first-party authenticated retrieval.

Golden reference: Vapi retrieve-call-artifacts (`GET /call/{id}/mono-recording`)
plus our browser-recording first-party path (FE never uses a private provider
object as media src; it fetches an authenticated first-party URL and plays a
blob). The fix converges on that pattern. `claude-code-src/`, `openclaw/`,
`hermes-agent/`, and `codex/` have no Vapi phone-recording player.

## Solution

1. `downloadVapiCallRecording(callId)` — authenticated Vapi artifact GET
   (`mono-recording`, then `stereo-recording`). Archive uses this and never
   fetches the provider `recordingUrl`.
2. `GET /api/agents/:id/phone-calls/:callId/recording` — hybridAuth, ownership
   via `toolSideEffect` `vapi.outbound_call:{agentId}:...`. Ended-call poll
   rewrites `recordingUrl` to that first-party path.
3. FE `fetchPhoneCallRecording` + blob `URL.createObjectURL`; `RecordingPlayer`
   never assigns a `hipaa-recordings` / R2 URL to `<audio src>`.
4. `_evaluate_phone_call_task` now fails any finished `call_phone_number` whose
   first-party GET is not playable audio. Task prompts and `tasks.json`
   evaluators are unchanged.

Cited agent `b31c8a09` is playable after deploy from `callId` alone; no
metadata backfill.

10k-agent: one indexed side-effect lookup + one Vapi artifact GET per user
playback. No shared fan-in, no extra realtime topic.

Cemented by `back-end/src/tests/unit/vapi-recording.test.ts` (pre-fix fail /
post-fix pass), `front-end/src/tests/blackbox/phone-call-card.blackbox.tsx`
(blob src, never R2), `agents/tests/blackbox/benchmark.blackbox.py`
`test_phone_recording_playback_requires_first_party_audio`, and
`agents-lifecycle.cases.ts` 401/404 recording cases.

## Human feedback

User required `/rca` of agent `b31c8a09-5992-4916-b797-b9c3ae5c75cf` and an
update to the existing daily phone-calling benchmark so it validates that FE
recording playback actually works.

## Reusable lesson

Never use a provider-private recording URL as `<audio src>` — serve first-party authenticated audio and make the daily phone evaluator GET that sink.
