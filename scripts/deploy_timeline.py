"""Account for work and waits without turning historical gaps into work."""
from __future__ import annotations

import math

KINDS = ("active_work", "automation", "external_wait")


def _time(value):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError("timeline boundaries must be finite timestamps")
    return float(value)


def event_intervals(events):
    """Pair scoped native activity records; unmatched records carry no duration."""
    pending, intervals, gaps = {}, [], []
    for row in sorted(events, key=lambda row: _time(row["recorded_epoch"])):
        event = row.get("event", "")
        if event not in {"work-start", "work-finish", "wait-start", "wait-finish"}:
            continue
        detail = row.get("detail") or {}
        if not detail.get("request_id") or not detail.get("reason"):
            raise ValueError("activity records need a correlation ID and reason")
        run_id = row.get("run_id") or detail.get("run_id")
        if not run_id:
            raise ValueError("activity records need their original run identity")
        key = (row.get("workflow"), run_id, detail["request_id"], event.split("-")[0], row["value"])
        if event.endswith("-start"):
            if key in pending:
                raise ValueError("duplicate activity start")
            pending[key] = row
        elif key not in pending:
            gaps.append({"kind": "unmatched_finish", "key": key})
        else:
            start = pending.pop(key)
            intervals.append({"start": start["recorded_epoch"], "end": row["recorded_epoch"],
                              "kind": "active_work" if event.startswith("work") else "external_wait",
                              "reason": start["detail"]["reason"],
                              "evidence": {"start": start, "finish": row}})
    gaps.extend({"kind": "unmatched_start", "key": key} for key in pending)
    return intervals, gaps


def account(start, end, intervals):
    """Return disjoint wall time plus original overlapping evidence rows.

    Work may continue while another lane waits. Work takes precedence in the
    wall total; raw wait intervals remain available for the parallel timeline.
    Gaps are displayed only as waits with an unrecorded reason. Their external
    cause is unverified; they never establish active work or a specific cause.
    """
    start, end = _time(start), _time(end)
    if end < start:
        raise ValueError("timeline end precedes start")
    rows = []
    for interval in intervals:
        a, b = _time(interval["start"]), _time(interval["end"])
        if b < a or interval.get("kind") not in KINDS:
            raise ValueError("invalid timeline interval")
        if not interval.get("reason") or not interval.get("evidence"):
            raise ValueError("recorded intervals need a reason and evidence")
        a, b = max(start, a), min(end, b)
        if b > a:
            rows.append({**interval, "start": a, "end": b, "basis": "recorded"})
    boundaries = sorted({start, end, *(r[k] for r in rows for k in ("start", "end"))})
    totals = dict.fromkeys(KINDS, 0.0)
    segments = []
    for a, b in zip(boundaries, boundaries[1:]):
        covering = [r for r in rows if r["start"] <= a and r["end"] >= b]
        kind = next((kind for kind in KINDS if any(r["kind"] == kind for r in covering)), "external_wait")
        selected = [r for r in covering if r["kind"] == kind]
        totals[kind] += b - a
        segments.append({"start": a, "end": b, "kind": kind,
                         "reason": sorted({r["reason"] for r in selected}) if selected else ["wait reason unrecorded"],
                         "basis": "recorded" if selected else "unrecorded",
                         "wait_reason_recorded": bool(selected) if kind == "external_wait" else None})
    return {"start": start, "end": end, "seconds": totals, "segments": segments,
            "recorded_intervals": rows,
            "unrecorded_wait_seconds": sum(r["end"] - r["start"] for r in segments if r["basis"] == "unrecorded")}
