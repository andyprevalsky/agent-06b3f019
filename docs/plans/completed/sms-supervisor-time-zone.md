# SMS supervisor time-zone context

## Problem

At `2026-07-20T20:26:48.771Z`, the SMS supervisor told a San Francisco user that it was
8:26 PM. The same instant was 1:26 PM PDT. The runtime exposed only a UTC ISO timestamp, so the
model had no authoritative user time zone or local clock.

## Temporal contract

The Mac browser fingerprint already persists the device's IANA time zone at
`Integration(userId, name="browser_fingerprint").config.fingerprint.timezone`. Treat that value as
the SMS supervisor's canonical time-zone source. Do not infer a zone from a shipping address and do
not treat a fixed UTC offset as a time zone.

Capture one `Date` per context build and derive both representations from it:

```text
encrypted Mac fingerprint
  -> Integration.config.fingerprint.timezone
  -> validate as an IANA zone
  -> capture one current instant
       |-> UTC ISO instant
       `-> Intl.DateTimeFormat(timeZone) local clock + DST abbreviation
  -> dynamic get_environment state
  -> SMS supervisor LLM
```

When the fingerprint has no valid time zone, keep the UTC snapshot for event ordering and add one
concise guardrail telling the model that the zone is unknown and it must not infer local date or time
from UTC. Do not emit placeholder local-time fields and do not guess a zone.

## Implementation

- Add a provider utility that extracts and validates the fingerprint IANA zone and formats the
  temporal state from a caller-supplied instant.
- Fetch the browser-fingerprint integration in parallel with the existing SMS context queries. This
  adds one indexed O(1) lookup and no serial latency dependency.
- Put UTC instant, IANA zone, and local clock in the run-local state block; keep the cacheable system
  prompt unchanged.
- Log only zone availability and the selected IANA identifier, never the fingerprint payload.

## Verification

- Check in the exact incident instant as an SMS blackbox regression: `20:26:48Z` with
  `America/Los_Angeles` must render `1:26 PM PDT`.
- Cover absent and invalid fingerprint zones by asserting that local-time assumptions are forbidden.
- Run TypeScript, lint, structural, blackbox, coverage, smoke, semantic, review, merge, and production
  verification through `/deploy`.
