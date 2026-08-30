#!/usr/bin/env bash
# Summarize k=5 A/B results from benchmark logs
set -eo pipefail
python3 <<'PY'
import json, re, sys
from collections import defaultdict
from pathlib import Path

TASKS = [
    "browser-1015-eventim-request-card",
    "browser-alchemy-springs-sauna",
    "browser-amazon-return",
    "browser-doordash-usb-c-cable",
    "browser-event-ticket",
    "browser-file-upload-tinypng",
    "browser-imax-group-tickets",
]

def parse_log(path: Path):
    text = path.read_text(errors="replace")
    # Final report-card rows: task name truncated + status
    rows = defaultdict(list)
    for line in text.splitlines():
        m = re.match(
            r"\s+(browser-[a-z0-9-]+)\s+(passed|failed|running|queued)\s+",
            line,
        )
        if m:
            name, status = m.group(1), m.group(2)
            # normalize truncated names
            for t in TASKS:
                if t.startswith(name) or name.startswith(t[:20]):
                    rows[t].append(status)
                    break
    # Take last status per occurrence (report card updates)
    # Better: count from RESULTS line at end
    final = {}
    for t in TASKS:
        statuses = []
        for line in text.splitlines():
            m = re.match(
                rf"\s+({re.escape(t[:25])}[a-z-]*)\s+(passed|failed)\s+",
                line,
            )
            if m:
                statuses.append(m.group(2))
        if statuses:
            # report-card rows repeat within a snapshot; collapse consecutive
            # duplicates so one attempt is not counted many times, then keep
            # the last five unique attempt outcomes.
            deduped = []
            for status in statuses:
                if not deduped or deduped[-1] != status:
                    deduped.append(status)
            final[t] = deduped[-5:] if len(deduped) >= 5 else deduped
    return final

def summarize(label, path):
    p = Path(path)
    if not p.exists():
        print(f"{label}: missing {path}")
        return
    data = parse_log(p)
    print(f"\n=== {label} ({p.name}) ===")
    total_p, total_f = 0, 0
    for t in TASKS:
        sts = data.get(t, [])
        p = sum(1 for s in sts if s == "passed")
        f = sum(1 for s in sts if s == "failed")
        total_p += p
        total_f += f
        rate = f"{p}/5" if len(sts) >= 5 else f"{p}/{len(sts)} ({sts})"
        print(f"  {t}: {rate}")
    print(f"  TOTAL: {total_p}/{len(TASKS) * 5} (completed: {total_p + total_f}/{len(TASKS) * 5})")

for arg in sys.argv[1:]:
    label, path = arg.split(":", 1)
    summarize(label, path)
PY
