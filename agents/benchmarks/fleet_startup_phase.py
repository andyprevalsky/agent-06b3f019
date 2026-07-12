#!/usr/bin/env python3
"""Per-bench startup-phase tracker for the batch dashboard.

Before a bench's on-box `run_benchmark` starts emitting a report card, the bench
is "queued" — but it is really progressing through concrete startup steps on its
isolated machine (clone → VM/volume provision → stage driver → boot stack). This
derives the current step + how long each step has taken from the bench's
`run-bench-cloud` child log, so the dashboard can render a per-row step timeline
(expected vs elapsed) instead of an opaque "queued".

The controller polls the child log every ~1s; we persist the wall-clock instant
each step was FIRST observed to a small state file, so elapsed/step-durations are
stable across polls (the log lines themselves carry no timestamps).
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Optional

# (step key, human label, expected seconds, first-line marker in the child log).
# Expected seconds are from measured cold-start runs; "cloning" has no marker —
# it is the implicit state before the child logs "Starting warm machine".
PHASES = [
    ("cloning", "cloning machine", 90, None),
    ("provisioning", "provisioning VM + volume", 180, "Starting warm machine"),
    ("staging", "staging driver", 45, "Machine started + ssh-ready"),
    ("booting", "booting stack", 90, "On-box driver launched"),
]
_ORDER = [p[0] for p in PHASES]
_EXPECTED = {p[0]: p[2] for p in PHASES}
_LABEL = {p[0]: p[1] for p in PHASES}


def current_phase(child_log_text: str) -> str:
    """The latest startup phase whose marker is present (default 'cloning')."""
    cur = "cloning"
    for key, _label, _exp, marker in PHASES:
        if marker and marker in child_log_text:
            cur = key
    return cur


def startup_state(child_log: Path, state_file: Path, now: Optional[float] = None) -> dict:
    """Return {phase, label, total_elapsed_s, total_expected_s, steps:[...]}.

    Each step: {key, label, expected_s, elapsed_s, status: done|active|pending}.
    Persists first-seen timestamps to `state_file` so durations are stable.
    """
    now = time.time() if now is None else now
    try:
        text = child_log.read_text(errors="ignore")
    except Exception:
        text = ""
    cur = current_phase(text)
    cur_idx = _ORDER.index(cur)

    try:
        state = json.loads(state_file.read_text())
    except Exception:
        state = {}
    seen: dict = state.get("seen", {})
    # Every phase up to and including the current one has started by now.
    for i in range(cur_idx + 1):
        seen.setdefault(_ORDER[i], now)
    state["seen"] = seen
    try:
        state_file.write_text(json.dumps(state))
    except Exception:
        pass

    steps = []
    for i, key in enumerate(_ORDER):
        exp = _EXPECTED[key]
        if key not in seen:
            steps.append({"key": key, "label": _LABEL[key], "expected_s": exp, "elapsed_s": 0.0, "status": "pending"})
        elif i < cur_idx:
            end = seen.get(_ORDER[i + 1], now)
            steps.append({"key": key, "label": _LABEL[key], "expected_s": exp,
                          "elapsed_s": round(max(0.0, end - seen[key]), 1), "status": "done"})
        elif key == cur:
            steps.append({"key": key, "label": _LABEL[key], "expected_s": exp,
                          "elapsed_s": round(max(0.0, now - seen[key]), 1), "status": "active"})
        else:
            steps.append({"key": key, "label": _LABEL[key], "expected_s": exp, "elapsed_s": 0.0, "status": "pending"})

    total_elapsed = round(max(0.0, now - seen[_ORDER[0]]), 1) if _ORDER[0] in seen else 0.0
    return {
        "phase": cur,
        "label": _LABEL[cur],
        "total_elapsed_s": total_elapsed,
        "total_expected_s": sum(_EXPECTED.values()),
        "steps": steps,
    }
