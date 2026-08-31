#!/usr/bin/env bash
# Summarize k=5 A/B results from benchmark logs
set -eo pipefail
python3 - "$@" <<'PY'
import re, sys
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


def normalize_task_name(name):
    """Map a possibly-truncated report-card task name onto TASKS."""
    for t in TASKS:
        if t.startswith(name) or name.startswith(t[:20]):
            return t
    return None


def parse_log(path: Path):
    text = path.read_text(errors="replace")
    final = {}
    for line in text.splitlines():
        m = re.match(
            r"\s+(browser-[a-z0-9-]+)\s+(passed|failed)\s+",
            line,
        )
        if not m:
            continue
        task = normalize_task_name(m.group(1))
        if not task:
            continue
        final.setdefault(task, []).append(m.group(2))
    # Collapse consecutive duplicates from repeating report-card snapshots;
    # keep the last five unique attempt outcomes per task.
    out = {}
    for t, statuses in final.items():
        deduped = []
        for status in statuses:
            if not deduped or deduped[-1] != status:
                deduped.append(status)
        out[t] = deduped[-5:] if len(deduped) >= 5 else deduped
    return out


def summarize(label, path):
    p = Path(path)
    if not p.exists():
        print(f"{label}: missing {path}")
        return False
    data = parse_log(p)
    print(f"\n=== {label} ({p.name}) ===")
    total_p, total_f = 0, 0
    for t in TASKS:
        sts = data.get(t, [])
        p_count = sum(1 for s in sts if s == "passed")
        f_count = sum(1 for s in sts if s == "failed")
        total_p += p_count
        total_f += f_count
        rate = f"{p_count}/5" if len(sts) >= 5 else f"{p_count}/{len(sts)} ({sts})"
        print(f"  {t}: {rate}")
    print(f"  TOTAL: {total_p}/{len(TASKS) * 5} (completed: {total_p + total_f}/{len(TASKS) * 5})")
    return True


failed = False
for arg in sys.argv[1:]:
    label, path = arg.split(":", 1)
    if not summarize(label, path):
        failed = True
if failed:
    sys.exit(1)
PY
