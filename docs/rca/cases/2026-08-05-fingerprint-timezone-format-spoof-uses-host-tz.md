---
id: 2026-08-05-fingerprint-timezone-format-spoof-uses-host-tz
date: 2026-08-05
title: Fingerprint timezone spoof lied via resolvedOptions while format() stayed on host Eastern TZ
surface: cross
component: steel-fingerprint-injection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/steel/injectionScripts.ts Intl.DateTimeFormat spoof — patched only resolvedOptions().timeZone / getTimezoneOffset, so format()/toLocaleString kept host America/New_York
symptoms:
  - "Thursday Aug 6, 2026, 10:30 PM at Grace Cathedral"
  - Should be 7:45
  - level-item--selected aria-label="10:30 PM"
  - resolvedOptions.timeZone America/Los_Angeles but format 10:30 PM EDT
  - Emulation.setTimezoneOverride America/Los_Angeles
tags:
  - fingerprint
  - timezone
  - kernel
  - fever
  - payment-approval
  - intl
  - browser-injection
sources:
  - agent 15508426-8fbc-4ae7-a4e1-0ee77b63cf47
repro: back-end/src/tests/blackbox/steel-fingerprint.blackbox.ts (fingerprint timezone format uses user location not host TZ)
status: fixed
---

## Problem

Payment approval for Fever tickets showed **10:30 PM** at Grace Cathedral (San Francisco)
instead of a Pacific showtime. User goal was `7:45pm tomorrow (Thursday Aug 6)`; rejection
text was `Should be 7:45`.

Runtime evidence from agent `15508426-8fbc-4ae7-a4e1-0ee77b63cf47`:

- Plan/goal correctly asked for 7:45 PM Pacific at Aura Grace Cathedral.
- Fever page/API inventory for that date is `2026-08-06T19:30:00-07:00` ("7:30 pm") and
  `2026-08-06T20:45:00-07:00` ("8:45 pm") in `America/Los_Angeles` — **no 7:45 slot**.
- Browser evaluate showed dual time labels 3 hours apart: empty `fv-level-item`
  `aria-label="7:30 pm"` (width 0) beside visible selected `10:30 PM` (and 8:45 / 11:45).
- Payment `request_user_approval` attention text copied the visible `10:30 PM` label.
- Live Kernel CDP on the still-open session: blank page host TZ `America/New_York`; after
  fingerprint init script, `resolvedOptions().timeZone` claimed `America/Los_Angeles` and
  `getTimezoneOffset()` returned 420, but `Intl.DateTimeFormat#format` /
  `Date#toLocaleString` still produced `10:30 PM EDT` for the PT instant. Forcing
  `timeZone: 'America/Los_Angeles'` yielded `7:30 PM PDT`.
- User `browser_fingerprint` integration: `timezone: America/Los_Angeles`,
  `timezoneOffset: 420`. Preferred Kernel proxy location: Cupertino, CA.

Archive searches (`payment request time 10:30`, `wrong session time ticket timezone UTC`,
`browser timezone fingerprint kernel steel`, `10:30 7:30 timezone display payment approval`)
found no prior case for incomplete fingerprint TZ format spoofing — **novel** relative to
Steel/Kernel fingerprint cases and the scheduled-wait "NOT a timezone bug" case.

## Diagnosis

Critical path:

`user fingerprint (America/Los_Angeles) → getFingerprintInjectionData initScript → worker
apply_fingerprint_injection → Fever client formats session ISO with Intl/Date locale APIs →
visible 10:30 PM → browser agent request_payment_card line_items.name → payment approval SMS/UI`

Binary search:

1. Payment path faithfully forwarded the line-item name (sink OK).
2. Fever server data is Pacific (`-07:00`, labels 7:30/8:45) — source inventory OK.
3. Midpoint: browser Intl. Host is Eastern; fingerprint spoof claimed LA via
   `resolvedOptions` only; **format paths stayed Eastern** → first wrong data.

Deepest owned cause (Step 5a): the fingerprint contract promised "browser TZ matches user
location" but only implemented a lie on `resolvedOptions`/`getTimezoneOffset`. That made
every site that formats absolute instants via Intl show host-Eastern labels on Kernel VMs
while detectors that only check `resolvedOptions().timeZone` saw LA.

Secondary residuals (not first-bad for the 10:30 label):

- Exact requested 7:45 does not exist on Fever for that date (nearest is 7:30 PT).
- Browser agent did not verify selected showtime against the goal before payment approval.

## Solution

Generalizable fix at the fingerprint boundary (user location TZ must drive format output):

1. `buildFingerprintScript` now injects `fp.timezone` into `Intl.DateTimeFormat` constructor
   options and patches `Date#toLocaleString` / `toLocaleDateString` / `toLocaleTimeString`
   unless the caller set an explicit `timeZone`. `resolvedOptions` no longer overwrites an
   explicit caller timeZone.
2. `getFingerprintInjectionData` (`files.ts`) deleted its duplicated init-script copy (which
   also ended with a browser-illegal `log.info`) and now calls `buildFingerprintScript`;
   returns `timezone` for the worker.
3. `apply_fingerprint_injection` calls CDP `Emulation.setTimezoneOverride` with the user's
   IANA timezone so ICU/host TZ aligns with location (JS patches remain belt-and-suspenders).

Siblings prevented: any Kernel booking/checkout site that localizes session times via Intl
(movies, restaurants, flights) will no longer silently show Eastern labels for Pacific users.

10k-agent behavior: one-time CDP override + init script per browser session connect; no
per-agent fan-in, O(1) per session.

Local repro (identical command):

```bash
cd back-end && npx tsx src/tests/blackbox/steel-fingerprint.blackbox.ts
```

- Pre-fix: `✗ fingerprint timezone format uses user location not host TZ: Intl format must use user location TZ (expected 7:30 PM PT, not host 10:30 PM ET); got "10:30 PM"`
- Post-fix: `✓ fingerprint timezone format uses user location not host TZ` (10/10 passed)

Agents: `python tests/blackbox/fingerprint_injection.blackbox.py` asserts
`Emulation.setTimezoneOverride` with `America/Los_Angeles`.

## Human feedback

User clarified the intended contract: the browser timezone should match the user's location.

## Reusable lesson

When spoofing timezone for user location, force the IANA zone into every format path
(Intl constructor options, Date#toLocale*, and CDP Emulation.setTimezoneOverride) — never
only `resolvedOptions().timeZone`.
