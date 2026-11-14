#!/usr/bin/env python3
"""Offline native-event projection. Reads hash-verified originals; never queries a service."""
from __future__ import annotations
import argparse
from collections import defaultdict
from datetime import datetime
import hashlib
import json
import math
import time
from pathlib import Path

EVENTS = {"rose.complete.start", "rose.complete.first_productive_chunk",
          "rose.complete.foundry.done", "rose.complete.waterfall.done", "rose.foundry.served"}

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def event(value):
    if isinstance(value, str):
        try:
            value = json.loads(value[value.index("{"):])
        except (ValueError, TypeError):
            return None
    return value if isinstance(value, dict) and value.get("event") in EVENTS and isinstance(value.get("request_id"), str) and value["request_id"] else None

def delta(start, end):
    try:
        a, z = (datetime.fromisoformat(t.replace("Z", "+00:00")) for t in (start, end))
        if a.tzinfo is None or z.tzinfo is None:
            return None
        value = (z - a).total_seconds()
        return value if math.isfinite(value) and value >= 0 else None
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None

def project_events(member, observations):
    groups = defaultdict(lambda: defaultdict(list))
    for raw, digest in observations:
        obj = event(raw)
        if obj:
            groups[(obj.get("agent_id"), obj["request_id"])][obj["event"]].append((obj, digest))
    rows = []
    for (agent, request), events in sorted(groups.items(), key=lambda item: str(item[0])):
        # This producer covers native root requests only. Child authorization
        # requires a distinct tree proof and must not be guessed from a log.
        if agent is not None and agent not in member["allowed_agent_ids"]:
            continue
        def unique(names):
            values = {}
            for name in names:
                for obj, _ in events.get(name, []):
                    values[json.dumps([obj.get("timestamp"), obj.get("elapsed_s")], sort_keys=True)] = obj
            return list(values.values())
        starts = unique(["rose.complete.start"])
        firsts = unique(["rose.complete.first_productive_chunk"])
        ends = unique(["rose.complete.foundry.done", "rose.complete.waterfall.done"])
        def duration(values):
            return delta(starts[0].get("timestamp"), values[0].get("timestamp")) if agent is not None and len(starts) == len(values) == 1 else None
        ttft, total = duration(firsts), duration(ends)
        if ttft is not None and total is not None and ttft > total:
            ttft = total = None
        rows.append(dict(agent_id=agent, request_id=request, job_id=member["job_id"], task=member["task"],
            ttft_seconds=ttft, total_seconds=total, source_sha256=member["run_json_sha256"],
            run_json_sha256=member["run_json_sha256"],
            additional_source_hashes=sorted({digest for values in events.values() for _, digest in values}),
            scope="productive-first-chunk / native-completion"))
    return rows

def produce(membership_path, roots, output, receipt, replay_owner):
    membership_raw = Path(membership_path).read_bytes()
    members = json.loads(membership_raw)
    if members.get("schema") != "descend-scorecard-membership-v1":
        raise ValueError("unsupported membership schema")
    if not isinstance(replay_owner, str) or not replay_owner.strip():
        raise ValueError("replay owner must identify the original artifact custodian")
    manifests = {}
    for shard, proof in members["proofs"].items():
        raw = (Path(roots[shard]) / "export-manifest.json").read_bytes()
        if sha(raw) != proof["export_manifest_sha256"]:
            raise ValueError("original export manifest SHA256 mismatch")
        manifests[shard] = json.loads(raw)["files"]
    costs, rows, inputs = [], [], []
    for member in members["rows"]:
        amount = None
        if member["binding_status"] == "verified-scored-run":
            root = Path(roots[member["shard"]]).resolve()
            def verified(relative, expected):
                path = (root / relative).resolve()
                if not path.is_relative_to(root):
                    raise ValueError("source path escapes original export")
                raw = path.read_bytes()
                if sha(raw) != expected:
                    raise ValueError("original source SHA256 mismatch")
                inputs.append(dict(shard=member["shard"], path=relative, sha256=expected))
                return raw
            if manifests[member["shard"]].get(member["run_json_path"], {}).get("sha256") != member["run_json_sha256"]:
                raise ValueError("raw run is not bound to original export manifest")
            raw = verified(member["run_json_path"], member["run_json_sha256"])
            run = json.loads(raw)
            if len(run.get("tasks", [])) != 1:
                raise ValueError("one original task per fleet required")
            task = run["tasks"][0]
            amount = task.get("cost_cents")
            observations = [(obj, member["run_json_sha256"]) for obj in task.get("logs", {}).get("worker_logs", [])]
            rows.extend(project_events(member, observations))
        costs.append(dict(job_id=member["job_id"], task=member["task"], cost_cents=amount,
                          run_json_sha256=member["run_json_sha256"]))
    data = dict(schema="descend-scorecard-telemetry-v1", experiment_id=members["experiment_id"],
                scheduled_jobs=members["scheduled_jobs"], covered_run_count=sum(m["binding_status"] == "verified-scored-run" for m in members["rows"]),
                cost_rows=costs, latency_rows=rows,
                coverage_note="Embedded native events in complete hash-verified run artifacts only; capped embedded logs and missing boundaries remain unknown. Separate selected log excerpts are excluded.")
    raw = (json.dumps(data, indent=2, sort_keys=True) + "\n").encode()
    Path(output).write_bytes(raw)
    evidence = dict(schema="descend-telemetry-producer-v1", experiment_id=members["experiment_id"],
                    telemetry_sha256=sha(raw), membership_sha256=sha(membership_raw),
                    producer_sha256=sha(Path(__file__).read_bytes()), inputs=inputs,
                    input_manifest_sha256={k: v["export_manifest_sha256"] for k, v in members["proofs"].items()},
                    replay_owner=replay_owner, replayed_at=time.time())
    Path(receipt).write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    return data, evidence

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--membership", required=True, type=Path)
    parser.add_argument("--source-root", action="append", default=[], help="shard=original export directory")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--replay-owner", required=True, help="artifact custodian attesting this local replay")
    args = parser.parse_args()
    produce(args.membership, dict(x.split("=", 1) for x in args.source_root), args.output, args.receipt, args.replay_owner)
