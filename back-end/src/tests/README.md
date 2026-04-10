# Backend Tests

See [docs/testing.md](../../../docs/testing.md) for the full testing guide.

Quick reference:
```bash
npm run test:structural          # Architecture invariants (fast, no server)
npm run test:blackbox             # Blackbox tests (auto-starts isolated server)
npm run test:blackbox -- <domain> # Single domain
npm run test:all                  # structural + blackbox
```
