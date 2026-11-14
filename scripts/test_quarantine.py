#!/usr/bin/env python3
"""Quarantined-test release report: `python3 scripts/test_quarantine.py report [--json]`; after merge,
`link-repair --occurrence <id> --repair <thread URL>` replaces a marker's pending-handoff:<id>.

Lists every in-definition quarantine marker with its consecutive-pass streak from recorded
results (factory ledger + local deploy attempts); "ready to release" at 5. Logic lives in
scripts/deploy_test_quarantine.py (not importable as `test_quarantine`, which is the marker
module scripts/lib/test_quarantine.py).
"""
from deploy_test_quarantine import main

if __name__ == '__main__':
    raise SystemExit(main())
