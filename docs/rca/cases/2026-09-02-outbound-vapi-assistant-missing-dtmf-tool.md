---
id: 2026-09-02-outbound-vapi-assistant-missing-dtmf-tool
date: 2026-09-02
title: Outbound Vapi assistant lacked dtmf tool so call-tree IVR navigation spoke digits instead of sending keypad tones
surface: cross
component: vapi-outbound-config
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: back-end/src/domains/vapi/config.ts:DEFAULT_CALL_ASSISTANT_CONFIG.model.tools — only endCall was enabled; outbound voice agents had no dtmf function for IVR/keypad entry
symptoms:
  - "No ten digit tracking number was entered"
  - "Using the keypad, please enter your ten digit tracking number followed by the pound key"
  - "Enters two four five one three three eight eight two"
  - "Presses one for yes"
  - call_phone_number IVR DHL tracking failure
tags:
  - phone
  - ivr
  - dtmf
  - vapi
  - call-tree
sources:
  - agent 308c7437-b205-45ca-aa47-0a9c6a5c5f0a
repro: back-end/src/tests/structural/vapi-outbound-config.test.ts
status: fixed
---

## Problem

Agent `308c7437-b205-45ca-aa47-0a9c6a5c5f0a` placed outbound calls to DHL's automated IVR to track package `2451338820`. The IVR repeatedly asked for keypad entry ("Using the keypad, please enter your ten digit tracking number followed by the pound key"), but the Rose voice agent spoke digits aloud ("The tracking number is two four five one three three") and narrated button presses ("Presses one for yes", "Presses nine to return to the main menu") instead of sending DTMF tones. DHL rejected every attempt with "No ten digit tracking number was entered" and the call ended without reaching tracking status.

Prod transcript excerpt (call idx 491):

```
User: Using the keypad, please enter your ten digit tracking number followed by the pound key.
AI: Enters two four five one three three eight eight two zero followed by the pound key.
User: That number is not a valid tracking number.
```

## Diagnosis

Critical path: agent EXECUTE loop → `call_phone_number` tool → backend `/api/vapi/call` → Vapi outbound assistant → PSTN IVR.

Binary search:
1. Agent chose the right tool and goal (track package via phone) — upstream OK.
2. Call connected and transcript shows IVR prompts — telephony path OK.
3. First bad data at the outbound Vapi assistant configuration: `DEFAULT_CALL_ASSISTANT_CONFIG.model.tools` contained only `{ type: 'endCall' }`. Vapi's native `dtmf` default tool was never enabled, and `BASE_SYSTEM_PROMPT` did not instruct the model to use keypad tones for IVR menus.
4. Without the `dtmf` tool, the LLM fallback is to speak numbers and describe button presses — exactly matching the failure transcript.

RCA archive searches: `phone call tree DTMF dial digits` (novel relative to prior cases — closest hits were unrelated tree/UI or payment-phone routing). `call_phone_number IVR keypad press` (no direct hit). This incident is **novel**.

## Solution

1. Enabled Vapi `dtmf` default tool alongside `endCall` in `back-end/src/domains/vapi/config.ts`.
2. Extended `BASE_SYSTEM_PROMPT` with explicit IVR guidance: use `dtmf` for keypad menus, never speak digits aloud, use `w` pause characters between digits.
3. Added daily benchmark `phone-call-ivr-dtmf` with a controlled IVR callee (`phone_persona` + `keypad_input_plan`) that rejects spoken digits and verifies DTMF on both menu selection and tracking-number entry.
4. Cemented regression coverage in `back-end/src/tests/structural/vapi-outbound-config.test.ts`, `back-end/src/tests/blackbox/vapi.blackbox.ts`, and `agents/tests/blackbox/benchmark.blackbox.py`.

10k-agent behavior: unchanged hot-path cost — one additional static tool declaration per outbound call config; no per-agent fan-in or polling added.

## Human feedback

None recorded.

## Reusable lesson

When a phone-call transcript shows the agent speaking digits or saying "presses one" against an IVR that asks for keypad entry, inspect the outbound Vapi assistant tools first — `dtmf` must be enabled before blaming model intelligence.
