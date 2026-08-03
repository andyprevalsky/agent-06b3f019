---
id: 2026-07-03-llm-used-as-transcriber-obeyed-instructions-spoken-in-the-audio
date: 2026-07-03
title: Using an LLM as the speech-to-text engine made it follow instructions spoken inside the voice note
surface: back-end
component: sms-supervisor-inbound-media
classification: model-intelligence-limitation
problem_class: model-intelligence-limitation
first_bad_boundary: "LLM-as-STT path for inbound voice notes — spoken content entered the model as instructions, not as data to transcribe"
symptoms:
  - transcription step follows instructions spoken in the audio instead of transcribing them
  - a guard prompt is required to keep the transcriber on task
tags:
  - stt
  - voice-note
  - prompt-injection
  - sms
  - inbound-media
sources:
  - commit d126a992e
  - memory:project_sms_mms_media_support
repro: none-recorded
status: fixed
---

## Problem

Before a dedicated speech-to-text provider was wired up, inbound voice notes were
transcribed by an LLM (Gemini via OpenRouter). It followed instructions spoken _in_
the audio instead of transcribing them, and needed a guard prompt to stay on task.

## Diagnosis

An LLM has no boundary between "audio to transcribe" and "instructions from the
principal" — handing it user-supplied speech makes that speech executable, so
transcription became an injection surface. A guard prompt only raises the cost of the
injection; it does not remove the capability being abused. The correct fix is
architectural: use a component that can only transcribe.

## Solution

Inbound audio now goes to a dedicated STT provider — ElevenLabs Scribe
(`POST api.elevenlabs.io/v1/speech-to-text`, `model_id=scribe_v2`, multipart) in
`back-end/src/providers/smsSupervisor/inboundMedia.ts` — which cannot act on the
content it transcribes. Round-tripped by a real-LLM blackbox in
`sms-supervisor.behavior.ts` (spoken question WAV → "Paris"), opt-in via
`BLACKBOX_SMS_SUPERVISOR_REAL_LLM=1`. The recorded rule is not to regress to LLM
transcription; swapping providers means replacing `transcribeVoiceNote()`.

## Human feedback

The human asked for Deepgram specifically; no Deepgram key exists anywhere (local
.env, Render, Fly) and VAPI's Deepgram transcriber is VAPI-hosted, so ElevenLabs
Scribe shipped instead as an equivalent dedicated STT with a key already provisioned
locally and on Render. Switching to Deepgram remains the stated preference once a
`DEEPGRAM_API_KEY` is minted.

## Reusable lesson

Never use a general LLM as a transcriber for user-supplied audio — it will obey
instructions spoken inside the clip; use a dedicated STT component that cannot act.
