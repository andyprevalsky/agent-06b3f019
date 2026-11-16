---
id: 2026-11-16-outbound-voice-defaults-override-call-language
date: 2026-11-16
title: Outbound voice defaults override per-call language at greeting, closing and transcription
surface: back-end
component: vapi-outbound-config
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/vapi/config.ts DEFAULT_CALL_ASSISTANT_CONFIG sets fixed English firstMessage and endCallMessage and English-only transcription independently of the call brief
symptoms:
  - "Hello. How are you today?"
  - "Hello, how are you today?"
  - "Thank you for your time"
  - "Jolla Buenas, Gian and Mesa"
  - call_phone_number ignores the system_prompt language
tags:
  - vapi
  - phone
  - language
  - multilingual
sources:
  - agent 01dbedbb-4e9c-40ab-b02c-54189e732055
  - commit d40e1e11692b84a6859aee1f4f80858b73b1b553
repro: back-end/src/tests/blackbox/vapi.blackbox.ts
status: open
---

## Problem

Three calls from agent `01dbedbb-4e9c-40ab-b02c-54189e732055` opened with
“Hello. How are you today?” despite Spanish call briefs. The third brief required
Spanish from the first word and supplied this exact first sentence:
“Hola, buenas. ¿Tienen mesa para dos personas para mañana martes, a las siete de la tarde?”
The report also described accented speech; the saved ASR text alone cannot establish
accent or actual pronunciation. The first brief requested Spanish but did not supply
an exact first sentence; the report's “every” claim is broader than the saved evidence.

The saved agent and report are private under `.context/rca-phone/`. Read-only GETs of
Vapi calls `01a1e4b6-ad51-7000-8754-9556283cb8b6`,
`01a1e4bc-346e-7779-a724-169b0f25eb19` and
`01a1e4de-f404-7000-bb46-88b648c81a21` each returned HTTP 200 and confirmed
`firstMessage: "Hello, how are you today?"`,
`endCallMessage: "Thank you for your time. Goodbye."`, Deepgram
`flux-general-en` / `en`, and an ElevenLabs custom voice with no explicit model.
The actual provider system messages contained the Spanish instructions.

## Diagnosis

Critical path: call_phone_number brief → backend POST /api/vapi/call → prepareCall
identity and base prompt → buildCallAssistantConfig → Vapi → speech/transcription.
The tool did deliver the brief. The first wrong data is the independent fixed
English opening, which bypasses model generation entirely. The same default config
sets an English closing and English-only STT. This makes language in the brief
ineffective at those boundaries; a stronger Spanish prompt cannot repair it.
An unspecified ElevenLabs model also leaves multilingual synthesis to provider defaults;
we do not infer which synthesis model actually ran or assign the garbled ASR to accent.

Archive searches: `call_phone_number Spanish` and `Hello How are you today language`.
No same-defect case found. The 2026-09-02 outbound-vapi-assistant-missing-dtmf-tool
case is a relative: inspect supplied provider configuration before blaming model
intelligence. It is a different capability defect, not a recurrence.

Reproduction: `bash back-end/scripts/run-blackbox-tests.sh vapi`, using the existing
loopback fake-upstream safety guard and the third call's non-identifying opening
instructions. Before repair: exit 1, assertion “Expected prompt-generated Spanish
opening, got {\"firstMessage\":\"Hello, how are you today?\"}”. The same
command and unchanged greeting assertion pass with the repair (five consecutive
post-fix runs, each exit 0; unchanged test source throughout those five runs).
TypeScript, ESLint, outbound structural tests (10/10), and archive structural test
(1/1) also pass. The affected-test selector maps the changed config to
`backend-blackbox vapi` and `backend-structural vapi-outbound-config.test.ts`. This proves the
submitted provider boundary, not generated speech or PSTN audio. English/French
and IVR negative controls, and custom voice preservation, exercise sibling cases.

The deepest coherent fix is removing independent language-specific defaults and
using the existing model context. No language classifier, text extraction, prompt
rewrite, model upgrade, or fallback is needed. The next broader change (replacing
telephony orchestration) would not address this owned configuration conflict.

## Solution

Implemented and validated locally, pending deployment: generate the opener from model messages;
use Deepgram `nova-3` with `multi`; explicitly select ElevenLabs
`eleven_turbo_v2_5` while preserving the voice ID. Keep IVR/callee-first mode,
DTMF, wait-for-human, output schema, identity and timeouts.
Remove endCallMessage and set endCall's request-start message content to empty:
the existing prompt already asks the model to say goodbye before hanging up.
This suppresses Vapi's additional default goodbye. Merely omitting endCallMessage
would still let Vapi say “Goodbye” in the transcriber language.

Official provider references checked 2026-11-16:
- https://docs.vapi.ai/customization/multilingual (Nova 3 / Multi)
- https://docs.vapi.ai/providers/voice/elevenlabs (supported multilingual models)
- https://docs.vapi.ai/api-reference/assistants/create (model-generated first message)
- https://docs.vapi.ai/tools/hang-up/configuration (empty request-start is silent;
  omission falls back to endCallMessage or provider goodbye)
- https://github.com/VapiAI/server-sdk-python/blob/main/src/vapi/types/deepgram_transcriber.py
  (Flux-only endpointing fields removed when selecting Nova)

Golden reference: not applicable (no approval-gated hunk). All three native guards
(prompt, agent behavior, trajectory injection) are clear. Independently inspected
OpenClaw `extensions/voice-call/src/realtime-agent-context.ts:11`
assembles voice instructions from base and agent context;
`extensions/voice-call/src/runtime.ts:63` directs context-aware hangup. This repair
converges on that single-context approach; Vapi-specific modes have no direct analog
in that harness. Fresh independent reviewer ph7ek42nem6vrrt52saps01mks8janf4 independently
identified the same first bad boundary and approved the deterministic regression
and its flakiness controls, without code-level blocking findings.

No fan-in, polling, extra model turn, or per-call database access is added by config
construction at 10,000 concurrent agents. A generated opener does require provider
LLM generation before initial speech. Nova endpointing differs from Flux and live
turn timing needs provider verification. Controlled live provider proof uses the exact third provider system message and
custom voice, with WebSocket audio transport instead of dialing a telephone.
Original-config replay `01a1e4e5-99b0-7001-8141-baf73346d3e8` opened in English
and recognized the supplied Spanish decline only as “No” (confidence 0.3313).
Fixed-config replay `01a1e4e5-5d2d-7000-96a7-afe43d2b5db0` opened with the
requested Spanish words and recognized the complete Spanish decline. Independent
ElevenLabs Scribe transcription of the captured assistant PCM confirms original
English versus fixed Spanish, including “Hola, buenas. ¿Tienen mesa para dos
personas para mañana martes a las siete de la tarde?” and Spanish follow-up.
A second fixed replay also spoke its goodbye entirely in Spanish; its recorded
audio independently transcribes “Muchas gracias por su tiempo. Que tenga un buen
día. Adiós.” No fixed English closing was spoken. The client ended these bounded
replays, so silent endCall execution itself is covered at configuration level,
not established by these live sessions. Native Castilian accent, arbitrary
custom-voice pronunciation, deterministic script fidelity, and actual restaurant
booking success are not established. No restaurant/user was dialed.


## Human feedback

The user requires reading the actual work/evidence in active bug threads before
editing and reconciling an existing owner rather than duplicating its repair.
The coordinator read 44 active/relevant project threads and searched the agent
ID and call tool; no same-defect owner was found. Folder-specific discovery is
not exposed to this ordinary devbox, so project-wide reads covered active Bugs
and other Bug Report work without inferring ownership from titles.

## Reusable lesson

Make the call brief the single source of spoken language and verify provider opening,
closing, recognition and synthesis settings before blaming the conversation model.
