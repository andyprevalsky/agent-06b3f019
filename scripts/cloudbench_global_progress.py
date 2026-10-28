"""Read-only full-suite /descend progress and observed telemetry projection."""
from __future__ import annotations

import hashlib
import html
import json
import math
import re
import statistics
from zoneinfo import ZoneInfo
from collections import Counter
from datetime import datetime
from pathlib import Path

COLORS = {"PASS": "var(--ok)", "FAIL": "var(--bad)", "PARTIAL": "var(--warn)",
          "UNKNOWN": "var(--warn)", "UNRUN": "var(--na)"}
HEX64 = re.compile(r"[0-9a-f]{64}")


def read(path):
    try:
        raw = Path(path).read_bytes()
        return json.loads(raw), hashlib.sha256(raw).hexdigest()
    except (OSError, ValueError) as error:
        raise ValueError(f"unreadable progress artifact: {path}") from error


def instant(value):
    try:
        result = float(value) if type(value) in (int, float) else datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        return result if math.isfinite(result) and result > 0 else None
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def names_of(selection):
    if not isinstance(selection, dict) or selection.get("schema") != "descend-selected-tasks-v1":
        raise ValueError("selected tasks must use descend-selected-tasks-v1")
    rows = selection.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("selected task rows must be a nonempty ordered list")
    names = [row.get("name") if isinstance(row, dict) else None for row in rows]
    if any(not isinstance(name, str) or not name.strip() or name != name.strip() for name in names) or len(set(names)) != len(names):
        raise ValueError("selected task identities must be nonempty and unique")
    return names


def project(ledger, names, now, expected_k):
    if not isinstance(ledger, dict) or ledger.get("schema") != "descend-rolling-acceptance-v1":
        raise ValueError("global acceptance must use descend-rolling-acceptance-v1")
    if type(ledger.get("task_count")) is not int or ledger["task_count"] != len(names) or type(ledger.get("k")) is not int or ledger["k"] != expected_k:
        raise ValueError("global acceptance task count or last-X scope disagrees with selection")
    raw_rows = ledger.get("rows")
    if not isinstance(raw_rows, list):
        raise ValueError("global acceptance rows must be a list")
    by_task = {}
    selected_names = set(names)
    for row in raw_rows:
        if not isinstance(row, dict) or row.get("task") not in selected_names or row["task"] in by_task:
            raise ValueError("global acceptance contains duplicate or foreign task identity")
        by_task[row["task"]] = row
    rows, slots = [], []
    physical_owners = {}
    for name in names:
        raw = by_task.get(name)
        status, reason, records = "UNKNOWN", "missing acceptance row", []
        valid, count, complete = [], None, False
        if raw is not None:
            records = raw.get("last_scored", raw.get("last_two_known_scored") if expected_k == 2 else None)
            count = raw.get("known_scored_count")
            if not isinstance(records, list) or len(records) > expected_k:
                raise ValueError("last scored receipts exceed the requested run count")
            identities = [(r.get("campaign_id"), r.get("job_id")) for r in records
                          if isinstance(r, dict) and isinstance(r.get("campaign_id"), str)
                          and isinstance(r.get("job_id"), str)]
            for identity in identities:
                if identity in physical_owners and physical_owners[identity] != name:
                    raise ValueError("physical scored run is attributed to multiple tasks")
                physical_owners[identity] = name
            if len(set(identities)) != len(identities):
                raise ValueError("duplicate physical run in scored receipts")
            valid = [isinstance(r, dict) and r.get("verdict") in ("PASS", "FAIL")
                     and r.get("infra_failure") is not True
                     and isinstance(r.get("campaign_id"), str) and bool(r["campaign_id"])
                     and isinstance(r.get("job_id"), str) and bool(r["job_id"])
                     and type(r.get("run")) is int and r["run"] > 0
                     and bool(re.fullmatch(r"[0-9a-f]{40}", str(r.get("source_commit", ""))))
                     and bool(HEX64.fullmatch(str(r.get("evidence_sha256", ""))))
                     and instant(r.get("controller_terminal_at")) is not None
                     and instant(r["controller_terminal_at"]) <= now for r in records]
            complete = type(count) is int and count >= 0 and len(records) == min(count, expected_k)
            if any(ok and r["verdict"] == "FAIL" for ok, r in zip(valid, records)):
                status, reason = "FAIL", "a verified latest scored receipt failed"
                if not complete or not all(valid):
                    reason += "; other history/evidence is incomplete"
            elif not complete:
                reason = "latest scored receipts missing or count inconsistent"
            elif not records:
                if count == 0 and raw.get("acceptance") == "UNTESTED":
                    status, reason = "UNRUN", "explicitly no scored runs"
                else:
                    reason = "no scored receipts; run state unknown"
            elif not all(valid):
                reason = "unscored, unknown or incomplete source/evidence/clock receipt"
            elif len(records) == expected_k:
                status, reason = "PASS", f"latest {expected_k} scored runs passed (historical outcomes)"
            else:
                status, reason = "PARTIAL", f"{len(records)} scored PASS; {expected_k} required"
        # Each retained result owns one slot. Missing expected receipts are
        # unknown; only an explicitly complete shorter history proves empties.
        for index in range(expected_k):
            record = records[index] if index < len(records) else None
            if index < len(records):
                slot_status = record["verdict"] if valid[index] else "UNKNOWN"
                slot_reason = "verified scored receipt" if valid[index] else "incomplete or unscored receipt"
            elif complete and (count > 0 or raw.get("acceptance") == "UNTESTED"):
                slot_status, slot_reason = "UNRUN", "no scored run recorded for this slot"
            else:
                slot_status, slot_reason = "UNKNOWN", "missing history or expected scored receipt"
            slots.append({"task": name, "slot": index + 1, "selected_ordinal": len(rows) + 1,
                          "status": slot_status, "reason": slot_reason,
                          "records": [{key: record[key] for key in ("campaign_id", "job_id", "run", "verdict", "source_commit", "controller_terminal_at", "clock_scope", "evidence_sha256") if key in record}] if isinstance(record, dict) else [],
                          "final_source_qualified": raw.get("green") if raw is not None and type(raw.get("green")) is bool else None})
        qualified = raw.get("green") if raw is not None and type(raw.get("green")) is bool else None
        if qualified and status != "PASS":
            raise ValueError("final-source qualification contradicts scored receipts")
        rows.append({"task": name, "status": status, "reason": reason, "records": [{key: record[key] for key in ("campaign_id", "job_id", "run", "verdict", "source_commit", "controller_terminal_at", "clock_scope", "evidence_sha256") if key in record} for record in records if isinstance(record, dict)],
                     "final_source_qualified": qualified, "acceptance": raw.get("acceptance") if raw else None})
    counts = {status: sum(row["status"] == status for row in rows) for status in COLORS}
    slot_counts = {status: sum(slot["status"] == status for slot in slots)
                   for status in ("PASS", "FAIL", "UNKNOWN", "UNRUN")}
    return {"slot_count": len(slots), "slots": slots, "slot_counts": slot_counts,
            "slot_pass_fraction": slot_counts["PASS"] / len(slots), "task_count": len(names), "k": expected_k, "rows": rows, "counts": counts,
            "historical_pass_fraction": slot_counts["PASS"] / len(slots),
            "historical_task_pass_fraction": counts["PASS"] / len(names),
            "final_source_qualified": sum(row["final_source_qualified"] is True for row in rows),
            "final_source_unknown": sum(row["final_source_qualified"] is None for row in rows),
            "as_of": ledger.get("metadata_updated_at") or ledger.get("generated_at")}


def load(acceptance, selected, selected_sha256, history, now, expected_k=None):
    if all(value is None for value in (acceptance, selected, selected_sha256, history, expected_k)):
        return None
    if not all((acceptance, selected, selected_sha256)):
        raise ValueError("global progress requires acceptance, selected tasks and selected SHA256 together")
    selection, actual_sha = read(selected)
    if not HEX64.fullmatch(str(selected_sha256)) or actual_sha != selected_sha256:
        raise ValueError("selected task artifact SHA256 mismatch")
    if type(expected_k) is not int or expected_k < 1:
        raise ValueError("global progress requires a positive --global-runs matching artifact k")
    names = names_of(selection)
    ledger, ledger_sha = read(acceptance)
    result = project(ledger, names, now, expected_k)
    result.update(selected_tasks_sha256=actual_sha, acceptance_sha256=ledger_sha, history=[])
    if history:
        data, history_sha = read(history)
        if (not isinstance(data, dict) or data.get("schema") != "descend-global-history-v1"
                or data.get("selected_tasks_sha256") != actual_sha or data.get("task_count") != len(names)
                or type(data.get("k")) is not int or data["k"] != expected_k or not isinstance(data.get("snapshots"), list)):
            raise ValueError("global history scope disagrees with selected tasks")
        seen, previous = set(), 0
        for snapshot in data["snapshots"]:
            if not isinstance(snapshot, dict):
                raise ValueError("history snapshot must be an object")
            identity = snapshot.get("experiment_id")
            at = instant(snapshot.get("finished_at"))
            if not isinstance(identity, str) or not identity or identity in seen or at is None or at > now or at <= previous:
                raise ValueError("global history requires unique IDs and increasing original finished clocks")
            seen.add(identity); previous = at
            item = snapshot.get("acceptance_ledger")
            point = project(item, names, at, expected_k) if item is not None else None
            result["history"].append({"id": identity, "finished_at": at,
                                      "rate": point["slot_pass_fraction"] if point else None})
        result["history_sha256"] = history_sha
    return result


def tooltip(row):
    lines = [row["task"] + f' · slot {row["slot"]}: ' + row["status"], row["reason"]]
    for r in row["records"]:
        if isinstance(r, dict):
            lines.append(f'{(r.get("verdict") or "UNKNOWN")} · {r.get("campaign_id", "UNRECORDED")}/{r.get("job_id", "UNRECORDED")} · src {(r.get("source_commit") or "UNRECORDED")} · {(r.get("controller_terminal_at") or "clock UNRECORDED")} · {r.get("clock_scope") or "clock scope UNRECORDED"} · evidence {r.get("evidence_sha256", "UNRECORDED")}')
    lines.append("Final-source qualification: " + ("UNKNOWN" if row.get("final_source_qualified") is None else str(row["final_source_qualified"])))
    return "\n".join(lines)


def render(progress):
    e = html.escape
    if progress is None:
        return '<section data-section="global-progress"><h2>Entire selected suite · scored-run coverage</h2><p class="warn">Global progress UNRECORDED · provide the selected scope and acceptance ledger.</p></section>'
    n, counts, k = progress["slot_count"], progress["slot_counts"], progress["k"]
    tasks = progress["task_count"]
    circumference = 2 * math.pi * 94
    pieces = []
    ordered = sorted(enumerate(progress["slots"]), key=lambda pair: list(COLORS).index(pair[1]["status"]))
    for i, (ordinal, row) in enumerate(ordered):
        length = circumference / n
        pieces.append(f'<circle data-task="{e(row["task"], quote=True)}" data-status="{row["status"]}" data-selected-ordinal="{row["selected_ordinal"]}" data-slot="{row["slot"]}" cx="132" cy="132" r="94" fill="none" stroke="{COLORS[row["status"]]}" stroke-width="34" stroke-dasharray="{length * .985:.5f} {circumference - length * .985:.5f}" stroke-dashoffset="{-i * length:.5f}" transform="rotate(-90 132 132)" tabindex="0"><title>{e(tooltip(row))}</title></circle>')
    labels = {"UNRUN": "NO SCORED RESULT"}
    legend = "".join(f'<span style="color:{COLORS[k]}">■ {labels.get(k, k)} {counts[k]}</span>' for k in counts)
    return (f'<section data-section="global-progress"><h2>Entire selected suite · {tasks} tasks × last {k} run slots</h2>'
            '<div class="global-cake"><svg viewBox="0 0 264 264" role="img" aria-label="Entire selected suite historical scored-run outcomes">'
            + ''.join(pieces) + f'<text x="132" y="123" text-anchor="middle" class="cake-count">{counts["PASS"]}/{n}</text>'
            f'<text x="132" y="148" text-anchor="middle">individual scored PASS</text></svg>'
            f'<div><b>Historical PASS slots {100 * counts["PASS"] / n:.1f}%</b><div class="legend">{legend}</div>'
            f'<p>Final-source-qualified (ledger): {progress["final_source_qualified"]}/{tasks}'
            + (f' · {progress["final_source_unknown"]} unknown' if progress["final_source_unknown"] else '')
            + '</p><p class="note">Historical outcomes are not final-source acceptance. Gray = no scored result in slot (unscored attempts may exist); amber = unknown receipt. Hover or focus a segment for original run evidence.</p></div></div></section>')


def clock_label(epoch):
    return datetime.fromtimestamp(epoch, ZoneInfo("America/Los_Angeles")).strftime("%b %d, %I:%M %p %Z")


def curve(progress):
    rows = (progress or {}).get("history", [])
    parts = ['<section data-section="global-trend" class="trend"><h2>GLOBAL SUCCESS RATE OVER TIME</h2>']
    if not rows:
        return ''.join(parts) + '<p class="warn">UNMEASURED · no verified full-suite history snapshots</p></section>'
    start, end = rows[0]["finished_at"], rows[-1]["finished_at"]
    x = lambda at: 40 + 620 * (at - start) / (end - start) if end > start else 350
    y = lambda rate: 125 - 100 * rate
    parts.append('<svg viewBox="0 0 690 185" role="img" aria-label="Historical full-suite individual scored-run coverage by original experiment finish; missing snapshots are gaps"><text x="0" y="29">100%</text><text x="10" y="129">0%</text>')
    for a, b in zip(rows, rows[1:]):
        if a["rate"] is not None and b["rate"] is not None:
            parts.append(f'<path class="path" d="M{x(a["finished_at"]):.2f} {y(a["rate"]):.2f} L{x(b["finished_at"]):.2f} {y(b["rate"]):.2f}"/>')
    for row in rows:
        if row["rate"] is not None:
            parts.append(f'<circle class="dot" cx="{x(row["finished_at"]):.2f}" cy="{y(row["rate"]):.2f}" r="4"><title>{e_text(row["id"])}: {row["rate"] * 100:.1f}% · {clock_label(row["finished_at"])}</title></circle>')
        else:
            parts.append(f'<circle cx="{x(row["finished_at"]):.2f}" cy="145" r="2" fill="none" stroke="var(--na)"><title>{e_text(row["id"])}: missing snapshot · {clock_label(row["finished_at"])}</title></circle>')
    parts.append(f'<text x="40" y="175">{clock_label(start)}</text><text x="660" y="175" text-anchor="end">{clock_label(end)}</text>')
    return ''.join(parts) + f'</svg><p class="note">Individual PASS / ({progress["task_count"]} selected tasks × {progress["k"]} latest run slots). Original experiment finish clocks; missing snapshots are not bridged. Hollow marks indicate missing snapshots.</p></section>'


def e_text(value):
    return html.escape(str(value))


def membership(path, sources, experiment_id, scheduled_jobs, canonical_rows):
    """Bind the audit projection to canonical jobs and immutable export entries.

    Native-log indices authorize their recorded root only. Child timing requires
    a future explicit tree proof; naming an arbitrary agent never authorizes it.
    """
    if not path or not sources:
        raise ValueError("telemetry requires membership and original export source packet")
    data, digest = read(path)
    if (data.get("schema") != "descend-scorecard-membership-v1"
            or data.get("experiment_id") != experiment_id
            or data.get("scheduled_jobs") != scheduled_jobs):
        raise ValueError("membership scope differs from current experiment")
    canonical = {r.get("job_id"): r for r in canonical_rows}
    if len(canonical) != scheduled_jobs or None in canonical:
        raise ValueError("telemetry requires all original canonical job identities")
    proofs = {}
    for shard, proof in data.get("proofs", {}).items():
        if not re.fullmatch(r"[0-9]{2}", shard):
            raise ValueError("invalid membership shard")
        root = Path(sources) / shard
        manifest, manifest_sha = read(root / "export-manifest.json")
        summary, summary_sha = read(root / "summary.json")
        index, _ = read(root / "native-log-index.json")
        if (manifest_sha != proof.get("export_manifest_sha256")
                or summary_sha != proof.get("campaign_summary_sha256")
                or manifest.get("archive_sha256") != proof.get("original_export_archive_sha256")
                or summary.get("campaign_id") != proof.get("campaign_id")):
            raise ValueError("membership original export proof mismatch")
        proofs[shard] = (manifest["files"], {r["job_id"]: r for r in summary["jobs"]}, index)
    bound = {}
    for row in data.get("rows", []):
        job = row.get("job_id")
        if job not in canonical or job in bound or row.get("shard") not in proofs:
            raise ValueError("foreign or duplicate membership job")
        original = canonical[job]
        files, summary, index = proofs[row["shard"]]
        saved = summary.get(job, {})
        if (row.get("task") != original.get("task") or row.get("task") != saved.get("task")
                or row.get("fleet_run_id") != saved.get("run_id")
                or row.get("original_task_status") != original.get("task_status")
                or row.get("original_task_status") != saved.get("task_status")
                or row.get("campaign_id") != data["proofs"][row["shard"]]["campaign_id"]):
            raise ValueError("membership does not match original task/fleet outcome")
        run_hash = row.get("run_json_sha256")
        if row.get("binding_status") == "unsealed-runtime-unknown":
            if run_hash is not None or row.get("allowed_agent_ids") or row.get("allowed_source_sha256"):
                raise ValueError("unsealed job cannot authorize source or agent")
        else:
            if (row.get("binding_status") != "verified-scored-run"
                    or not HEX64.fullmatch(str(run_hash))
                    or f"/{row['fleet_run_id']}/{row['task']}/" not in str(row.get("run_json_path"))
                    or files.get(row.get("run_json_path")) != row.get("manifest_run_entry")
                    or (row.get("manifest_run_entry") or {}).get("sha256") != run_hash
                    or row.get("root_agent_id") != original.get("agent_id")):
                raise ValueError("membership run hash or root is not canonical")
            logs = [r for r in index if r.get("job") == job]
            agents = {r.get("root_agent") for r in logs}
            allowed = {run_hash}
            for entry in row.get("source_log_entries", []):
                if (files.get(entry.get("path")) != entry.get("manifest_entry")
                        or (entry.get("manifest_entry") or {}).get("sha256") != entry.get("sha256")
                        or not any(r.get("file") == entry.get("path") and r.get("sha256") == entry.get("sha256")
                                   and r.get("task") == row["task"] and r.get("fleet") == row["fleet_run_id"] for r in logs)):
                    raise ValueError("membership log source not in original export")
                allowed.add(entry["sha256"])
            if (set(row.get("allowed_source_sha256", [])) != allowed
                    or set(row.get("allowed_agent_ids", [])) != {row["root_agent_id"]}
                    or agents != {row["root_agent_id"]}):
                raise ValueError("membership source or native agent authorization mismatch")
        bound[job] = dict(row, canonical_cost_usd=original.get("cost_usd"))
    if set(bound) != set(canonical):
        raise ValueError("membership does not cover original scheduled jobs")
    return bound, digest


def telemetry(path, experiment_id, scheduled_jobs, membership_path=None, sources=None, canonical_rows=(), receipt_path=None, receipt_sha256=None):
    if not path:
        return None
    data, digest = read(path)
    if (not isinstance(data, dict) or data.get("schema") != "descend-scorecard-telemetry-v1"
            or data.get("experiment_id") != experiment_id or type(data.get("scheduled_jobs")) is not int
            or data["scheduled_jobs"] != scheduled_jobs):
        raise ValueError("telemetry must match the current experiment and original scheduled jobs")
    members, membership_sha = membership(membership_path, sources, experiment_id, scheduled_jobs, canonical_rows)
    if not receipt_path:
        raise ValueError("native telemetry requires an original producer receipt")
    receipt, actual_receipt_sha = read(receipt_path)
    if not HEX64.fullmatch(str(receipt_sha256)) or receipt_sha256 != actual_receipt_sha:
        raise ValueError("original producer receipt SHA256 mismatch")
    producer_hash = hashlib.sha256(Path(__file__).with_name("cloudbench_telemetry.py").read_bytes()).hexdigest()
    expected_inputs = {(m["shard"], m["run_json_path"], m["run_json_sha256"])
                       for m in members.values() if m["binding_status"] == "verified-scored-run"}
    if (receipt.get("schema") != "descend-telemetry-producer-v1"
            or receipt.get("experiment_id") != experiment_id
            or receipt.get("telemetry_sha256") != digest
            or receipt.get("membership_sha256") != membership_sha
            or receipt.get("producer_sha256") != producer_hash
            or receipt.get("input_manifest_sha256") != {k: v["export_manifest_sha256"] for k, v in read(membership_path)[0]["proofs"].items()}
            or not isinstance(receipt.get("replay_owner"), str) or not receipt["replay_owner"].strip()
            or instant(receipt.get("replayed_at")) is None
            or {(x.get("shard"), x.get("path"), x.get("sha256")) for x in receipt.get("inputs", [])} != expected_inputs):
        raise ValueError("native telemetry producer receipt mismatch")
    covered = data.get("covered_run_count")
    if type(covered) is not int or not 0 <= covered <= scheduled_jobs:
        raise ValueError("invalid telemetry run coverage")
    if covered != sum(r["binding_status"] == "verified-scored-run" for r in members.values()):
        raise ValueError("telemetry coverage disagrees with verified original runs")
    costs, seen_jobs = [], set()
    if not isinstance(data.get("cost_rows"), list):
        raise ValueError("cost rows must be a list")
    for row in data["cost_rows"]:
        if not isinstance(row, dict):
            raise ValueError("cost row must be an object")
        job = row.get("job_id")
        if not isinstance(job, str) or not job or job in seen_jobs:
            raise ValueError("duplicate or missing telemetry job identity")
        seen_jobs.add(job)
        member = members.get(job)
        if (member is None or row.get("task") != member["task"]
                or row.get("run_json_sha256") != member["run_json_sha256"]):
            raise ValueError("cost row is not an original job/run")
        amount = row.get("cost_cents")
        if amount is None:
            continue
        if (type(amount) not in (int, float) or not math.isfinite(amount) or amount < 0
                or not HEX64.fullmatch(str(row.get("run_json_sha256", "")))):
            raise ValueError("cost requires finite nonnegative cents and an original run hash")
        expected = member["canonical_cost_usd"]
        if (type(expected) not in (int, float) or not math.isfinite(expected)
                or not math.isclose(amount / 100, expected, rel_tol=0, abs_tol=1e-9)):
            raise ValueError("cost does not match canonical job charge")
        costs.append(amount / 100)
    if len(seen_jobs) > scheduled_jobs:
        raise ValueError("too many telemetry job rows")
    timings = {"ttft_seconds": [], "total_seconds": []}
    seen_requests = set()
    rows = data.get("latency_rows", [])
    if not isinstance(rows, list):
        raise ValueError("latency rows must be a list")
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("latency row must be an object")
        member = members.get(row.get("job_id"))
        if (member is None or row.get("task") != member["task"]
                or row.get("run_json_sha256") != member["run_json_sha256"]
                or row.get("source_sha256") not in member["allowed_source_sha256"]
                or not set(row.get("additional_source_hashes", [])).issubset(member["allowed_source_sha256"])):
            raise ValueError("latency source is not an original job/run log")
        agent, request = row.get("agent_id"), row.get("request_id")
        if agent is not None and agent not in member["allowed_agent_ids"]:
            raise ValueError("latency agent has no original native identity proof")
        if not isinstance(request, str) or not request:
            raise ValueError("missing telemetry request identity")
        if not isinstance(agent, str) or not agent:
            # Explicit orphan records contribute to coverage gaps, never timings.
            if (row.get("ttft_seconds") is not None or row.get("total_seconds") is not None
                    or not isinstance(row.get("job_id"), str) or not row["job_id"]):
                raise ValueError("unattributed request cannot supply timing values")
            identity = ("unattributed", row["job_id"], request)
        else:
            identity = (agent, request)
        if identity in seen_requests:
            raise ValueError("duplicate telemetry request identity")
        seen_requests.add(identity)
        if not HEX64.fullmatch(str(row.get("source_sha256", ""))):
            raise ValueError("latency requires an original source hash")
        for key in timings:
            value = row.get(key)
            if value is not None:
                if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                    raise ValueError("invalid observed latency")
                timings[key].append(value)
        if row.get("ttft_seconds") is not None and row.get("total_seconds") is not None and row["ttft_seconds"] > row["total_seconds"]:
            raise ValueError("first productive chunk cannot follow request completion")
    def stats(values):
        values = sorted(values)
        return {"n": len(values), "p50": statistics.median(values),
                "p95": values[math.ceil(.95 * len(values)) - 1]} if values else None
    cost = {"metered_usd": sum(costs) if costs else None,
            "n": len(costs), "of": scheduled_jobs, "unmetered": ["Azure/provider spend", "infra", "wmh_grounding"] + (["missing agent-task costs"] if len(costs) < scheduled_jobs else []),
            "scope": "user-metered agent LLM cost"}
    return {"sha256": digest, "membership_sha256": membership_sha, "producer_sha256": producer_hash, "cost": cost if len(seen_jobs) == scheduled_jobs else None, "ttft": stats(timings["ttft_seconds"]),
            "total": stats(timings["total_seconds"]), "requests": len(seen_requests),
            "covered_runs": covered, "scheduled_jobs": scheduled_jobs}


def latency_text(value):
    if not value:
        return "UNMEASURED · no observed LLM timing receipts"
    parts = []
    for key, label in (("ttft", "First productive chunk"), ("total", "Request total")):
        stats = value[key]
        parts.append(f'{label}: p50 {stats["p50"]:.2f}s · p95 {stats["p95"]:.2f}s · {stats["n"]}/{value["requests"]} observed request records'
                     if stats else f'{label}: UNMEASURED')
    return "; ".join(parts) + f' · captured runs {value["covered_runs"]}/{value["scheduled_jobs"]}'
