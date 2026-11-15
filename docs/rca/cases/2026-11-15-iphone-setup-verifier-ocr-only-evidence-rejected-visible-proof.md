---
id: 2026-11-15-iphone-setup-verifier-ocr-only-evidence-rejected-visible-proof
date: 2026-11-15
title: iPhone setup verifier returned unknown on screens that showed Gmail, iMessage and receive-address proof because its OCR-only evidence rules covered neither Gmail's Settings screen nor OCR checkmark glyphs
surface: cross
component: iphone-setup-verifier
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/phoneSetupPurpose.ts settingsPurpose — the verifier receives only screen.text OCR (no app identity, no switch or checkmark state) but its gmail/imessage/receive_address purposes named no OCR-observable proof screen, so rose-1-mini returned unknown on the screens the agent could actually capture
symptoms:
  - setup.verify target gmail returned unknown
  - phone_setup_gmail
  - phone_setup_receive_address
  - Gmail Settings a@roselabs.ai still unknown
tags:
  - iphone
  - phone-harness
  - setup-verification
  - ocr
  - prompt
  - rose-1-mini
sources:
  - PR #2210
  - commit 8e74738f13adfe9a5db1c61cd673dd8c3dd69b73
  - agent 1772a64a-c22a-5cf7-9184-17508eda5df6
  - agent 1772a64a lease 45543f2e-e77c-4470-b258-4c19dc135226
  - agent 1772a64a lease 7c1dd8c6-b81e-4bcc-908b-15f76b23d1ed
repro: back-end/src/tests/blackbox/iphone-control.setup-verifier-replay.cases.ts "live setup verifier: recorded proof screens and controls"
status: fixed
---

## Problem

Prod setup agent 1772a64a (2026-11-15 05:21-06:15Z) passed portrait lock and Apple Account, signed in to Gmail and reached Gmail's per-account Settings screen (`Settings / Account / Andy Prevalsky / a@roselabs.ai / … / Apps in Gmail`, cursor 119 and again cursor 4 on lease 7c1dd8c6) and the Google Account page (cursor 9). Every `setup.verify target=gmail` returned `{"status":"unknown"}` (archived `phone_setup_gmail` finals 29f5b7b1, e2654036, f7bf822f, plus the 06:04:38Z call). The Send & Receive page (`V +1 (972) 977-7432`, `/ andyprevalsky@icloud.com`, `v andyprevalsky@yahoo.com`, `Apple Account: andyprevalsky@yahoo.com`) returned unknown for receive_address (df737ea3; model reasoning: "a 'V' might represent a visual checkmark, but it's not explicitly marked"). The prod journal (`iPhoneOperation` rows for both leases) shows the agent never submitted icloud_messages, icloud_keychain, icloud_contacts or imessage.

## Diagnosis

Critical path: agent screen.text → `setupEvidence` (repo.setupEvidence.ts: one current window of OCR rows, identities un-redacted) → `verifyPhoneSetup` (rose-1-mini, `settingsPurpose(target)`, strict `{status}` schema) → `parseSettingsResult` → stored proof → `verificationDto`/`setupProgress`.

- Evidence selection, schema and parse were correct: each call carried the intended latest observation, expected identities were present and unmasked, output was valid JSON `{"status":"unknown"}` (no truncation, no refusal).
- First bad data: the model's verdict. Exact replays through the same TS client path (gpt-5.6-luna-foundry, same messages/schema/config): Gmail Settings gmail unknown 3/3 (both recorded observations), Google Account page unknown 3/3, Send & Receive receive_address confirmed 1/3, imessage unknown 3/3.
- Why: the evidence is OCR text only (`Only server-loaded text evidence is available`), so app identity, switch positions and checkmarks are not represented. The gmail purpose required an "authenticated Gmail screen" but nothing OCR-visible identified Gmail's account Settings screen as one; no purpose said how iOS checkmarks render in OCR (a leading `V`/`v`/`/` glyph), so receive_address was a coin flip and imessage (whose switch has no text) could never confirm.
- Why possible: the agent guidance (agents/domains/spawn_browser_agent_v3/phone.py) never told the agent the verifier sees OCR only or which screens carry textual proof, so the agent also never opened the iCloud or Messages > Send & Receive screens for icloud_* / imessage.
- Progress reset (separate finding, not fixed here): `ensureSetup` (back-end/src/domains/iphone/repo.setup.ts:103-135) mints a new attempt id and floor for each new lease, so proofs from released lease 45543f2e failed `proofCurrent` on lease 7c1dd8c6 and the card restarted at portrait_lock. Sibling of 2026-11-14-iphone-session-ttl-refresh-discarded-in-progress-setup-checks (epoch carry only), recommended as its own goal.

Class stopped at: "verifier prompts must name the OCR-observable proof for each target". Deeper class tried: give the verifier structured app identity / control state from the provider (no such provider field exists; the journal's last `apps.launch` is not proof because later taps can switch apps), so a prompt-level OCR contract is the coherent owned fix.

## Solution

- `settingsPurpose` shared suffix: an iOS checkmark on a selectable row renders as a separate single leading glyph (V, v, /, check mark) followed by a space and counts as selection only for that row; switches have no text.
- gmail purpose: Gmail's per-account Settings screen showing the exact account email under Account with Gmail-only settings (Apps in Gmail) is an authenticated Gmail screen; a Google Account page alone does not identify the Gmail app.
- imessage purpose: the Send & Receive screen headed "You Can Receive iMessages to and Reply From" with the exact expected Apple Account establishes iMessage On and signed in unless any observation shows "Waiting for activation" or an activation error (unknown).
- PHONE_GUIDANCE: tell the agent the verifier sees screen.text OCR only and name the screens (Settings > your name > iCloud; Settings > Apps > Messages > Send & Receive; Gmail account Settings).
- Regression: live rose-1-mini replay of the recorded observations with negative controls (inbox under dialog, Google Account page alone, typed sign-in form, wrong Google account, phone row without glyph, phone unchecked only under Receive, Waiting for activation, FaceTime look-alike, wrong Apple Account). Before: FAIL 3/3 (Gmail Settings and iMessage unknown); after: PASS 5/5. The independent review's Waiting-for-activation negative caught an overbroad first draft, fixed before landing.
- 10k agents: prompt text only; no new queries or fan-in.

Shipped: PR #2210, merged 8e74738f13 on 2026-11-15. Production lanes PASS: Render live via descendant 37308b16bd, backend probes, Fly verified by descendant cutover 64f91559 (a867f5d4), workflow migration, semantic via descendant 6c9aa700. Live owner retry of the gmail, imessage and receive_address verifies is still pending. The progress reset across leases (finding 3) shipped separately in PR #2225. The Fly cutover was delayed by an unrelated drain wedge: agent 8789a5df, continuation payload TMPRL1103, RCA thread ph7dv1m8q2ye99cdta8n3q7g3s8j92q4.

## Human feedback

The user required no weakening of proof (a typed-but-unsigned identifier must never confirm) and replay regressions from the real observations.

## Reusable lesson

When a verifier only sees OCR text, each target's purpose and the agent guidance must name the OCR-visible screen that proves it (and how glyphs like checkmarks render); otherwise a correct device state stays unknown forever.
