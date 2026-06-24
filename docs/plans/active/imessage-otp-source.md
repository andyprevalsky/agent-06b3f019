# iMessage as an OTP source for the browser agent

## Goal

Let the browser agent's OTP relay read one-time passcodes that arrive over the
user's **iMessage/SMS** (synced from their Mac), in addition to the existing
agent-minted phone (AgentPhone) and OAuth Gmail sources.

## Context / why it didn't work before

Prod has the user's iMessages (real-time sync works), but two upstream bugs in
the mac-app reader made iMessage OTPs unusable:

1. **Short codes dropped at ingestion** — `service.clean.ts` discarded every
   numeric sender ≤ 8 digits. Amazon/banks/2FA senders are short codes, so their
   OTPs never reached the DB (0 short-code senders in 30 days of prod data).
2. **`attributedBody` stored as raw binary** — the decoder only handled the
   legacy `bplist` format; modern macOS uses `streamtyped` (NSArchiver). 82% of
   inbound bodies were stored as `streamtyped…NSAttributedString…` garbage.

## Decisions (from product owner)

- Filter OTPs comprehensively (keyword + digit), **no context gate**.
- iMessage OTPs map to the **SMS** channel in the agent prompt (reuse SMS path).
- Sync cadence unchanged — the real-time `chat.db` watcher already lands codes
  within ~seconds; the 5-min periodic is just a safety net.

## Changes

### Phase 0 — mac-app reader (`mac-app/main/domains/i-message-reader/`)

- `service.clean.ts`:
  - `extractTextFromStreamtyped()` + `readTypedstreamLength()` decode the
    `streamtyped` body to plaintext; wired into `extractTextFromAttributedBody`.
  - `isLikelyOtpMessage()` (digit + comprehensive OTP-keyword regex). Short-code
    messages are now retained **only when OTP-like** (graph stays clean).
- `service.ts`: the periodic `readMessages()` never-replied/unnamed filter now
  exempts OTP-like messages so codes survive the safety-net path too.

### Phase 1 — backend (`back-end/src/domains/imessage/`)

- `GET /api/imessage/recent-inbound?since=&limit=&channel=` — recent inbound
  (`to = 'me'`) messages, newest first; mirrors the agent-phone endpoint.
- New composite index `MessageRecord(channel, timestamp)` (migration
  `20260622000000_add_messagerecord_channel_timestamp_index`) serves the
  channel + `since`-window query.

### Phase 2/3 — agents (`agents/domains/spawn_browser_agent_v3/`)

- `repo.py`: `fetch_recent_imessages()` calls the new endpoint.
- `service_crypto.py`: `fetch_recent_otps()` merges agent-phone SMS + iMessages
  (agent-phone first → wins on duplicate codes via `seen_codes`); iMessage OTPs
  carry `channel="sms"`. `extract_otp_from_text()` rewritten to be comprehensive
  (Google `G-`, passcode/one-time/access, "code is X") while still requiring OTP
  context adjacent to the digits.

## Verification (automated — all passing)

- **mac-app**: `tests/blackbox/i-message-reader.blackbox.ts` — streamtyped decode
  (1-byte + 0x81 length), short-code OTP retained, short-code marketing dropped,
  OTP from never-replied sender kept. 31/31 pass.
- **backend**: `tests/blackbox/imessage-recent-inbound.blackbox.ts` — auth + param
  validation + filtering (inbound-only, within window, channel-scoped) against
  real Postgres. 5/5 pass (full suite 18 + 5).
- **agents**: `tests/blackbox/spawn_browser_agent_v3.blackbox.py` — comprehensive
  OTP extraction, non-OTP rejection, SMS-label/source formatting, iMessage source
  wiring with agent-phone-preferred dedup. New + existing OTP tests pass (275 ✅).

## Notes / follow-ups

- Existing garbled rows / previously-dropped short codes are **not** backfilled
  until a re-sync repopulates them.
- The whole iMessage path depends on the mac-app running with Full Disk Access.
- mac-app changes require a version bump + `MAC-APP-RELEASE` label on the PR.
