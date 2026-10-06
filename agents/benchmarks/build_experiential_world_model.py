"""Rebuild a native immutable upstream artifact from Rose's complete real exports.

Archive eligibility/export stays with world_model_harness.py. This Python 3.12
boundary consumes the original per-trajectory OTel and starting context, never
the lossy legacy steps index. No generated observation enters the native RAG.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

from exp.common.core.artifacts import (
    SecretBoundaryError,
    SourceIdentity,
    assert_secret_free,
    canonical_json_bytes,
    canonical_jsonl_bytes,
    redact_secret_json,
    sha256_json,
    stable_id,
)
from exp.common.models import BillingSource, ModelCapabilities, ModelSnapshot
from exp.common.project import ArtifactStore, ProjectPaths, artifact_input
from exp.common.traces import Trace, TraceDataset, TraceSource, TraceSpan
from exp.simulation.retrieval import RAGLineageBinding, persist_trace_rag
from exp.simulation.retrieval.transitions import extract_real_transitions
from exp.simulation.world_model.artifact import persist_grounded_world_model

from benchmarks.experiential_world_model import canonical_tool_schema, lineage_id

UPSTREAM_REVISION = "bf75987eac5e8c984d8f3868249f84e4095d1733"
ADAPTER_CONTRACT = "rose-native-canonical-export-v1"


@lru_cache(maxsize=4096)
def _credential_field(key):
    try:
        assert_secret_free({key: None})
    except SecretBoundaryError:
        return True
    return False


def redact_archive(value):
    """Use upstream's secret rules, also removing its forbidden credential fields."""
    redacted, total = redact_secret_json(value)

    def fields(item):
        nonlocal total
        if isinstance(item, dict):
            result = {}
            for key, child in item.items():
                if _credential_field(key):
                    total += 1
                else:
                    result[key] = fields(child)
            return result
        if isinstance(item, list):
            return [fields(child) for child in item]
        if isinstance(item, str) and item.lstrip().startswith(("{", "[")):
            # OTel arguments, observations and snapshots contain encoded JSON.
            try:
                decoded = json.loads(item)
            except ValueError:
                return item
            if isinstance(decoded, (dict, list)):
                safe, count = redact_archive(decoded)
                total += count
                if count:
                    return json.dumps(safe, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return item

    redacted = fields(redacted)
    assert_secret_free(redacted)
    return redacted, total


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=path.name + ".", delete=False) as temporary:
        name = temporary.name
        try:
            json.dump(payload, temporary, indent=2)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
            os.replace(name, path)
        finally:
            if os.path.exists(name):
                os.unlink(name)


def model_capabilities() -> ModelCapabilities:
    context = os.environ.get("WMH_CONTEXT_TOKENS")
    return ModelCapabilities(
        supports_tools=False, maximum_output_tokens=16384, context_window_tokens=int(context) if context else None
    )


def model_snapshot(pool: str, pool_sha256: str) -> ModelSnapshot:
    capabilities = model_capabilities()
    return ModelSnapshot(
        provider="rose",
        model_id=pool,
        revision=pool_sha256,
        billing_source=BillingSource.CUSTOMER_MANAGED,
        capabilities_sha256=capabilities.identity_sha256(),
        connection_sha256=pool_sha256,
    )


def bind_conformance(source_suite: Path, output: Path, transitions, pointer):
    """Bind every existing real replay case to exact native action/observation records."""
    suite, redactions = redact_archive(json.loads(source_suite.read_text()))
    cases = suite["examples"]
    wanted = {}
    if suite.get("status") != "passed" or len(cases) != suite.get("requested_examples"):
        raise ValueError("Native conformance requires a complete passing structural suite")
    for case in cases:
        key = (case["root_agent_id"], sha256_json(case["action"]), sha256_json(case["observation"]))
        wanted[key] = []
    roots = {case["root_agent_id"] for case in cases}
    categories = {}
    tools = {}
    for item in transitions:
        action = item.action.tool_arguments
        category = action["category"]
        tool = action["name"]
        categories[category] = categories.get(category, 0) + 1
        tools[tool] = tools.get(tool, 0) + 1
        if item.trace_id not in roots:
            continue
        key = (item.trace_id, sha256_json(action), sha256_json(json.loads(item.observation.content)))
        if key in wanted:
            wanted[key].append(item.transition_id)
    for case in cases:
        key = (case["root_agent_id"], sha256_json(case["action"]), sha256_json(case["observation"]))
        if not wanted[key]:
            raise ValueError(f"Conformance case lacks matching native source records: {case['root_agent_id']}")
        case["native_source_transition_ids"] = wanted[key]
    suite.update(
        trajectory_count=pointer["trajectories"],
        eligible_examples=pointer["observations"],
        category_count=len(categories),
        category_counts=categories,
        tool_name_count=len(tools),
        tool_name_counts=tools,
        native_world_model_id=pointer["world_model_id"],
        native_world_model_manifest_sha256=pointer["world_model_manifest_sha256"],
        native_redaction_count=redactions,
    )
    atomic_json(output, suite)
    return suite


def _attributes(span):
    result = {}
    for a in span.get("attributes", []):
        value = a["value"]
        result[a["key"]] = next(
            (value[key] for key in ("stringValue", "intValue", "doubleValue", "boolValue") if key in value), None
        )
    return result


def load_rose_trace(otel: Path, session_file: Path) -> tuple[Trace, int, int]:
    """Preserve exact task/start context, action/output bytes, source spans and order."""
    session = json.loads(session_file.read_text())
    root = session["root_agent_id"]
    initial = session["initial_state"]
    task = initial.get("root_goal")
    if not isinstance(task, str) or not task.strip():
        raise ValueError(f"{root}: missing original root goal")
    if "DEMO FIXTURE ONLY" in task.upper():
        raise ValueError(f"{root}: DEMO fixture is not real corpus evidence")
    payload = otel.read_bytes()
    source = TraceSource(
        identity=SourceIdentity(kind="file", source_id=root, sha256=hashlib.sha256(payload).hexdigest()),
        semantic_convention_version="rose-canonical-export-v11",
    )
    spans = []
    tools = set()
    pending = {}
    count = 0
    origin = datetime(2020, 1, 1, tzinfo=timezone.utc)
    for line in payload.split(b"\n"):
        if not line:
            continue
        raw = json.loads(line)
        attrs = _attributes(raw)
        name = raw["name"]
        if name.startswith("chat "):
            pending[raw["spanId"]] = (raw, attrs)
            continue
        if not name.startswith("execute_tool "):
            continue
        parent = raw.get("parentSpanId")
        action_raw, action_attrs = pending.pop(parent)
        action = json.loads(action_attrs["gen_ai.tool.call.arguments"])
        observation = json.loads(attrs["gen_ai.tool.output"])
        if (
            action.get("schema") != "rose.canonical_action.v1"
            or observation.get("schema") != "rose.canonical_observation.v1"
        ):
            raise ValueError(f"{root}: noncanonical source")
        metadata = observation.get("metadata") or {}
        if metadata.get("world_model_simulated") or metadata.get("result_unavailable"):
            raise ValueError(f"{root}: generated or unavailable corpus observation")
        if not isinstance(observation.get("content"), str):
            raise ValueError(f"{root}: non-text corpus observation")
        tool = action_attrs["gen_ai.tool.name"]
        tools.add(tool)
        action_attrs["gen_ai.tool.call.id"] = parent
        attrs["gen_ai.tool.call.id"] = parent
        attrs["gen_ai.tool.message"] = attrs["gen_ai.tool.output"]
        # Upstream uses datetime microseconds; OTel's nanosecond projection can
        # collapse distinct pairs. Give each pair a disjoint causal interval and
        # retain the exact source clocks in attributes and canonical payloads.
        for position, (record, attributes) in enumerate(((action_raw, action_attrs), (raw, attrs))):
            attributes["rose.source_start_time_unix_nano"] = str(record["startTimeUnixNano"])
            attributes["rose.source_end_time_unix_nano"] = str(record["endTimeUnixNano"])
            start = origin + timedelta(microseconds=count * 4 + position * 2)
            spans.append(
                TraceSpan(
                    span_id=record["spanId"],
                    parent_span_id=record.get("parentSpanId"),
                    name=record["name"],
                    started_at=start,
                    ended_at=start + timedelta(microseconds=1),
                    attributes=attributes,
                )
            )
        count += 1
    if pending:
        raise ValueError(f"{root}: unpaired source actions")
    trace = Trace(
        trace_id=root,
        conversation_id=root,
        task=task,
        initial_context=initial,
        tools=tuple(canonical_tool_schema(name) for name in sorted(tools)),
        spans=tuple(spans),
        source=source,
    )
    safe, redactions = redact_archive(trace.model_dump(mode="json"))
    return Trace.model_validate(safe), count, redactions


def build(source_root: Path, output: Path, name: str, pool: str, pool_sha256: str):
    source_root = source_root.resolve()
    output = output.resolve()
    sessions = json.loads((source_root / "sessions.json").read_text())["sessions"]
    traces = []
    bindings = []
    expected = 0
    excluded = []
    redactions = []
    for position, session in enumerate(sessions):
        root = session["root_agent_id"]
        if "DEMO FIXTURE ONLY" in str(session["initial_state"].get("root_goal", "")).upper():
            excluded.append({"root_agent_id": root, "reason": "DEMO FIXTURE ONLY task"})
            continue
        trace, count, redaction_count = load_rose_trace(
            source_root / "otel" / f"{root}.otel.jsonl", source_root / "sessions" / f"{root}.session.json"
        )
        if redaction_count:
            redactions.append({"root_agent_id": root, "redaction_count": redaction_count})
        binding = RAGLineageBinding(trace_id=root, lineage_id=lineage_id(root), partition="fit")
        actual = extract_real_transitions((trace,), (binding,), included_partitions=frozenset({"fit"}))
        if len(actual) != count:
            raise ValueError(f"{root}: upstream paired {len(actual)} of {count} source observations")
        for transition in actual:
            assert_secret_free(transition)
        traces.append(trace)
        bindings.append(binding)
        expected += count
        if position % 100 == 0:
            print(
                json.dumps({"stage": "native-import", "trajectories": len(traces), "observations": expected}),
                flush=True,
            )
    now = datetime.now(timezone.utc)
    store = ArtifactStore(ProjectPaths(output / "experiential", name))
    records = canonical_jsonl_bytes(traces)
    digest = hashlib.sha256(records).hexdigest()
    dataset_id = stable_id("rose-real-traces", {"records_sha256": digest, "upstream_revision": UPSTREAM_REVISION})
    code_revision = f"{ADAPTER_CONTRACT}@{UPSTREAM_REVISION}"
    dataset = TraceDataset(
        schema_version=2,
        created_at=now,
        inputs=(),
        code_revision=code_revision,
        source=SourceIdentity(kind="file", source_id="rose-real-archive-export", sha256=digest),
        dataset_id=dataset_id,
        semantic_convention_version="rose-canonical-export-v11",
        traces_path="traces.jsonl",
        traces_sha256=digest,
        trace_ids=tuple(t.trace_id for t in traces),
    )
    _, manifest = store.write_or_replay(
        artifact_id=dataset_id,
        artifact_type="trace-dataset",
        envelope=dataset,
        envelope_path="trace-dataset.json",
        envelope_type=TraceDataset,
        files={"trace-dataset.json": canonical_json_bytes(dataset), "traces.jsonl": records},
    )
    trace_count = len(traces)
    # Native RAG reopens the verified dataset. Release our import copy before
    # that load rather than retaining two complete corpora during construction.
    del traces, records
    print(json.dumps({"stage": "native-rag", "observations": expected}), flush=True)
    rag = persist_trace_rag(
        store, (artifact_input(manifest),), bindings, created_at=now, code_revision=code_revision, default_top_k=5
    )
    if rag.index.transition_count != expected:
        raise ValueError("Native RAG count differs from original source pairs")
    world = persist_grounded_world_model(
        store,
        artifact_input(rag.manifest),
        model_alias=pool,
        model=model_snapshot(pool, pool_sha256),
        created_at=now,
        code_revision=code_revision,
        top_k=5,
    )
    pointer = {
        "schema": "rose.experiential_model.v1",
        "upstream_revision": UPSTREAM_REVISION,
        "adapter_contract": ADAPTER_CONTRACT,
        "world_model_id": world.artifact.world_model_id,
        "world_model_manifest_sha256": artifact_input(world.manifest).sha256,
        "pool": pool,
        "pool_sha256": pool_sha256,
        "trajectories": trace_count,
        "observations": expected,
        "exclusions": excluded,
        "redactions": redactions,
        "source_corpus": str(source_root),
    }
    if (source_root / "conformance.json").exists():
        bind_conformance(source_root / "conformance.json", output / "conformance.native.json", rag.transitions, pointer)
    model_dir = output / "models" / name
    model_dir.mkdir(parents=True, exist_ok=True)
    atomic_json(model_dir / "experiential.json", pointer)
    atomic_json(output / "build.manifest.json", {"engine": "experiential", **pointer})
    print(json.dumps({"stage": "native-ready", **pointer}), flush=True)
    return pointer


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--source-root", required=True, type=Path)
    p.add_argument("--root", required=True, type=Path)
    p.add_argument("--name", required=True)
    p.add_argument("--pool", default="rose-1-ultra")
    p.add_argument("--pool-sha256", required=True)
    p.add_argument("--bind-conformance-only", action="store_true")
    a = p.parse_args()
    if a.bind_conformance_only:
        from benchmarks.serve_experiential_world_model import load_native

        _, retriever = load_native(a.root, a.name, a.pool, a.pool_sha256)
        pointer = json.loads((a.root / "models" / a.name / "experiential.json").read_text())
        suite = bind_conformance(
            a.source_root / "conformance.json",
            a.root / "conformance.native.json",
            retriever.loaded.transitions,
            pointer,
        )
        print(
            json.dumps(
                {
                    "stage": "native-conformance-bound",
                    "examples": len(suite["examples"]),
                    "model_id": pointer["world_model_id"],
                }
            ),
            flush=True,
        )
    else:
        build(a.source_root, a.root, a.name, a.pool, a.pool_sha256)


if __name__ == "__main__":
    main()
