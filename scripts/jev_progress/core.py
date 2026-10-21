"""Reproducible prefix-only JEV evaluation. No model-driven mutations here."""
from __future__ import annotations

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import threading
import time
import urllib.error
import urllib.request

BINS = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55]
FORMATS = ("history", "timeline", "compact")
ETA = {**{f"{i}m": i * 60 for i in range(1, 60)},
       **{f"{i}h": i * 3600 for i in range(1, 24)},
       **{f"{i}d": i * 86400 for i in range(1, 30)},
       **{f"{i}mo": i * 30 * 86400 for i in range(1, 12)}, "1y": 365 * 86400}
SEED = {
    "scope": "Estimate only this agent. Parent/root agents delegate work in a single tool call; do not count child internal actions as parent batches. Parallel tools issued together count as one batch.",
    "progress": "Estimate the number of future tool-call batches this agent still needs to accomplish its goal and output schema. Use only observed history. Include execution and verification; a final text response costs zero batches. This is remaining workload, not completion probability.",
    "eta": "Estimate wall-clock time remaining from this observed state until this agent finishes. Account for remaining work, tool latency, parallelism, waiting and verification. Choose nearest duration. Minimum 1 minute, maximum 1 year. Do not interpret uncertainty as duration.",
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))
    temporary.replace(path)


def load_rows(path):
    with gzip.open(path, "rt") as stream:
        return [json.loads(line) for line in stream]


def credential(name):
    if os.environ.get(name):
        return os.environ[name]
    root = Path(__file__).resolve().parents[2]
    for path in (root / "agents/.env", root / "back-end/.env"):
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            key, _, value = line.strip().removeprefix("export ").partition("=")
            if key == name and value:
                return value.strip().strip("\"'")
    raise RuntimeError(f"Configure {name} in the process or service environment")


def balanced(rows, count):
    """Round-robin by kind and trace; select deterministic actual examples."""
    groups = defaultdict(lambda: defaultdict(list))
    for row in rows:
        groups[row["agent_kind"]][row["trace_id"]].append(row)
    queues = {}
    for kind, traces in groups.items():
        for values in traces.values():
            values.sort(key=lambda row: digest(row["example_id"]))
        queue = []
        while any(traces.values()):
            for trace in sorted(traces):
                if traces[trace]:
                    queue.append(traces[trace].pop())
        queues[kind] = queue
    selected = []
    while len(selected) < count and any(queues.values()):
        for kind in sorted(queues):
            if queues[kind] and len(selected) < count:
                selected.append(queues[kind].pop(0))
    return selected


def prepare(dataset, output):
    train = load_rows(dataset / "train.jsonl.gz")
    test = load_rows(dataset / "test.jsonl.gz")
    if {r["split_group"] for r in train} & {r["split_group"] for r in test}:
        raise ValueError("Original train/test groups overlap")
    groups = defaultdict(list)
    for row in train:
        groups[row["split_group"]].append(row)
    # Seed selection is independent of outcomes or model scores. Hold out the
    # smaller explore family; its only alternative owns >6k training examples.
    validation_groups = set()
    for kind in ("explore", "browser", "normal_root", "normal_child"):
        if any(r["agent_kind"] == kind for g in validation_groups for r in groups[g]):
            continue
        available = [g for g in groups if g not in validation_groups
                     and any(r["agent_kind"] == kind for r in groups[g])]
        if len(available) > 1:
            validation_groups.add(min(available, key=lambda g: (len(groups[g]), digest(g))))
    for group in sorted(groups, key=digest):
        if sum(len(groups[g]) for g in validation_groups) >= 500:
            break
        if len(groups[group]) < 1000:
            validation_groups.add(group)
    dev = [r for r in train if r["split_group"] not in validation_groups]
    validation = [r for r in train if r["split_group"] in validation_groups]
    if {r["family_id"] for r in dev} & {r["family_id"] for r in validation}:
        raise ValueError("Family leakage")
    manifest = {"schema": 1, "train_ids": [r["example_id"] for r in balanced(dev, 256)],
                "validation_ids": [r["example_id"] for r in balanced(validation, 500)],
                "train_available": len(dev), "validation_available": len(validation),
                "validation_groups": sorted(validation_groups),
                "test_sha256": hashlib.sha256((dataset / "test.jsonl.gz").read_bytes()).hexdigest(),
                "train_sha256": hashlib.sha256((dataset / "train.jsonl.gz").read_bytes()).hexdigest(),
                "traces_sha256": hashlib.sha256((dataset / "traces.jsonl.gz").read_bytes()).hexdigest(),
                "policy": "Never select mutations using the 2000-row test. Validation remains disjoint by family and normalized-goal group."}
    if (output / "cohorts.json").exists():
        previous = json.loads((output / "cohorts.json").read_text())
        if previous != manifest:
            raise ValueError("Dataset/cohort changed; use a new output directory rather than overwrite the experiment")
    save(output / "cohorts.json", manifest)
    save(output / "prompts/seed.json", SEED)
    return manifest


def verify_dataset(dataset, cohorts):
    for split in ("train", "test", "traces"):
        actual = hashlib.sha256((dataset / f"{split}.jsonl.gz").read_bytes()).hexdigest()
        if actual != cohorts[split + "_sha256"]:
            raise ValueError(f"{split} dataset changed after cohort freeze")


def clip(value, limit):
    if isinstance(value, str) and len(value) > limit:
        return value[:limit * 3 // 4] + " [OMITTED] " + value[-limit // 4:]
    if isinstance(value, list):
        return [clip(v, limit) for v in value]
    if isinstance(value, dict):
        return {k: clip(v, limit) for k, v in value.items()}
    return value


def request(row, trace, prompt):
    """Do not access row.target or any event after the observed cutoff here."""
    events = trace["events"][:row["cutoff_event_index"] + 1]
    history = [{k: v for k, v in event.items() if k in
                ("role", "calls", "text", "status", "tool", "call_id", "timestamp")}
               for event in events]
    state = {"goal": trace["goal"], "output_schema": trace["output_schema"],
             "agent_kind": trace["kind"], "observed_batches": sum(e["role"] == "assistant" for e in events),
             "history": clip(history, 2000), "scope": prompt["scope"]}
    input_format = prompt.get("input_format", "history")
    if input_format not in FORMATS:
        raise ValueError("Unknown input format")
    if input_format != "history":
        # Derived exclusively from visible events; no terminal metadata, total
        # batches, future clocks, labels, or a summarizer with suffix access.
        timed = [datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00"))
                 for e in events if e.get("timestamp")]
        state["elapsed_seconds"] = max(0, (timed[-1] - timed[0]).total_seconds()) if timed else None
        counts = defaultdict(int)
        for event in events:
            for call in event.get("calls") or []:
                counts[call.get("tool") or call.get("name") or call.get("function", {}).get("name", "unknown")] += 1
        state["observed_tool_counts"] = dict(counts)
        if input_format == "compact":
            state["history"] = clip(history if len(history) <= 10 else history[:2] + history[-8:], 1200)
            state["omitted_event_count"] = max(0, len(history) - 10)
    # Preserve all event boundaries; shorten only individual text fields.
    # UTF-8 bytes upper-bound BPE tokens. Small fixtures and requests need no
    # optional tokenizer import; large live contexts use the pinned tokenizer.
    if len(json.dumps(state).encode()) >= 20000:
        import tiktoken
        encoding = tiktoken.get_encoding("cl100k_base")
        for limit in (1200, 600, 300, 150, 80):
            if len(encoding.encode(json.dumps(state))) < 20000:
                break
            state["history"] = clip(state["history"], limit)
        if len(encoding.encode(json.dumps(state))) >= 24000:
            raise ValueError("Input exceeds frozen 24k token budget")
    if input_format == "timeline":
        state["history"] = "\n".join(json.dumps(e, ensure_ascii=False) for e in state["history"])
    return {"model": "jev-1.13.0", "state": state, "questions": {
        "remaining_batches": {"type": "score", "instructions": prompt["progress"],
                              "criteria": [f"{n} remaining tool-call batches" for n in BINS[:-1]]
                              + ["55 or more remaining tool-call batches"]},
        "eta": {"type": "choice", "instructions": prompt["eta"],
                "criteria": {k: f"Approximately {v / 60:g} minutes remaining" for k, v in ETA.items()}}}}


def eta_truth(row, trace):
    def stamp(value):
        if not value:
            return None
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=timezone.utc).timestamp()
    events = trace["events"]
    last = next((e for e in reversed(events) if e["role"] == "assistant"), None)
    if last is None:
        return None
    ids = {c.get("tool_call_id") or c.get("id") for c in last["calls"] if
           (c.get("tool") or c.get("name") or c.get("function", {}).get("name")) in
           ("attempt_completion", "attempt_completion_with_result")}
    ends = [stamp(e.get("timestamp")) for e in events if e.get("call_id") in ids
            and e.get("status") in ("FINISHED", "COMPLETED") and e.get("timestamp")]
    cutoff = row["cutoff_event_index"]
    now = stamp(events[cutoff].get("timestamp")) if cutoff >= 0 else next(
        (stamp(e.get("timestamp")) for e in events if e.get("timestamp")), None)
    return max(ends) - now if ends and now is not None and max(ends) >= now else None


def decode(raw, row, trace):
    answer = raw["answers"]["remaining_batches"]
    probs = answer["probabilities"]
    if set(probs) != {str(i) for i in range(len(BINS))}:
        raise ValueError("Unexpected progress bins")
    values = [float(probs[str(i)]) for i in range(len(BINS))]
    if any(not math.isfinite(v) or not 0 <= v <= 1 for v in values) or abs(sum(values) - 1) > .03:
        raise ValueError("Invalid progress distribution")
    remaining = sum(p * b for p, b in zip(values, BINS)) / sum(values)
    observed = sum(e["role"] == "assistant" for e in trace["events"][:row["cutoff_event_index"] + 1])
    predicted = observed / (observed + remaining) if observed + remaining else 0
    choice = raw["answers"]["eta"]["choice"]
    if choice not in ETA or raw.get("model") != "jev-1.13.0":
        raise ValueError("Wrong ETA choice or model version")
    actual_eta = eta_truth(row, trace)
    return {"example_id": row["example_id"], "trace_id": row["trace_id"],
            "family_id": row.get("family_id", trace.get("family_id", row["trace_id"])), "kind": trace["kind"],
            "actual_progress": row["target"]["batch_progress"], "predicted_progress": predicted,
            "progress_error": abs(predicted - row["target"]["batch_progress"]),
            "remaining_actual": row["target"]["remaining_batches"], "remaining_predicted": remaining,
            "eta_actual": actual_eta, "eta_predicted": ETA[choice], "eta_bucket": choice,
            "eta_log_error": abs(math.log1p(ETA[choice]) - math.log1p(actual_eta)) if actual_eta is not None else None}


def api(body, key):
    request_body = json.dumps(body).encode()
    start = time.monotonic()
    for attempt in range(3):
        req = urllib.request.Request("https://api.typesafe.ai/v1/systemone", data=request_body,
                                     headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                return json.load(response), time.monotonic() - start
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise RuntimeError(f"TypeSafe HTTP {exc.code}") from None
            time.sleep(1 + attempt)
    raise RuntimeError("Request exhausted")


def summarize(rows, total):
    valid = [r for r in rows if r.get("ok")]
    if not valid:
        return {"total": total, "valid": 0, "failed": total}
    by_trace = defaultdict(list)
    for row in valid:
        by_trace[row["trace_id"]].append(row["progress_error"])
    errors = sorted(r["progress_error"] for r in valid)
    eta = [r for r in valid if r["eta_log_error"] is not None]
    eta_positive = [r for r in eta if r['eta_actual'] > 0]
    return {"total": total, "valid": len(valid), "failed": total - len(valid),
            "progress_mae_pp": 100 * statistics.mean(errors),
            "trace_macro_mae_pp": 100 * statistics.mean(statistics.mean(v) for v in by_trace.values()),
            "progress_within_10pp": sum(e <= .1 for e in errors) / total,
            "progress_p65_pp": 100 * errors[math.ceil(.65 * len(errors)) - 1],
            "progress_p95_pp": 100 * errors[math.ceil(.95 * len(errors)) - 1],
            "eta_log_mae": statistics.mean(r["eta_log_error"] for r in eta) if eta else None,
            "eta_median_relative_error": statistics.median(abs(r['eta_predicted']-r['eta_actual'])/r['eta_actual'] for r in eta_positive) if eta_positive else None,
            "eta_mean_absolute_seconds": statistics.mean(abs(r['eta_predicted']-r['eta_actual']) for r in eta) if eta else None,
            "eta_count": len(eta), "trace_count": len(by_trace),
            "recorded_tokens": sum((r.get("usage") or {}).get("input_tokens", 0) +
                                   (r.get("usage") or {}).get("output_tokens", 0) for r in valid)}


def evaluate(rows, traces, prompt, output, workers=12, transport=api):
    prompt_hash = digest(prompt)
    key = credential("TYPESAFE_API_KEY") if transport is api else "offline"
    cache = output / "cache"
    def one(row):
        trace = traces[row["trace_id"]]
        body = request(row, trace, prompt)
        cache_key = digest({"request": body, "scoring_version": 1})
        path = cache / (cache_key + ".json.gz")
        cached = path.exists()
        if cached:
            with gzip.open(path, "rt") as stream:
                stored = json.load(stream)
        else:
            raw, latency = transport(body, key)
            stored = {"raw": raw, "latency": latency, "request_hash": digest(body)}
            # Validate before marking response reusable; malformed output never becomes a hit.
            decode(raw, row, trace)
            cache.mkdir(exist_ok=True, parents=True)
            with gzip.open(path, "wt") as stream:
                json.dump(stored, stream)
        result = decode(stored["raw"], row, trace)
        return {**result, "ok": True, "cache_hit": cached, "request_hash": stored["request_hash"],
                "usage": stored["raw"].get("usage"), "latency_seconds": stored["latency"], "prompt_hash": prompt_hash}
    results = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(one, row): row for row in rows}
        for future in as_completed(futures):
            row = futures[future]
            try:
                results.append(future.result())
            except Exception as exc:
                results.append({"ok": False, "example_id": row["example_id"], "error": str(exc)})
    result = {"prompt_hash": prompt_hash, "cohort_hash": digest(sorted(r["example_id"] for r in rows)),
              "metrics": summarize(results, len(rows)), "rows": results}
    return result
