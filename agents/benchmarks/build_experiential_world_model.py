"""Rebuild a native immutable upstream artifact from Rose's complete real exports.

Archive eligibility/export stays with world_model_harness.py. This Python 3.12
boundary consumes the original per-trajectory OTel and starting context, never
the lossy legacy steps index. No generated observation enters the native RAG.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from exp.common.core.artifacts import (
    SourceIdentity,
    assert_secret_free,
    canonical_json_bytes,
    canonical_jsonl_bytes,
    envelope_matches_manifest,
    sha256_json,
    stable_id,
)
from exp.common.models import BillingSource, ModelCapabilities, ModelSnapshot
from exp.common.project import ArtifactStore, ProjectPaths, artifact_input
from exp.common.traces import Trace, TraceDataset, TraceSource, TraceSpan, load_trace_dataset
from exp.simulation.retrieval import RAGIndex, RAGLineageBinding, RAGSourceRef, load_rag_index, persist_trace_rag
from exp.simulation.retrieval.transitions import MEASURED_ELAPSED_MS_ATTRIBUTE, extract_real_transitions
from exp.simulation.world_model.artifact import grounded_world_model_prompt_sha256, persist_grounded_world_model
from exp.simulation.world_model.runtime import load_grounded_world_model_artifact

from benchmarks.experiential_world_model import canonical_tool_schema, lineage_id
from benchmarks.wmh_archive_io import (
    _credential_field as _credential_field,
)
from benchmarks.wmh_archive_io import (
    atomic_json as atomic_json,
)
from benchmarks.wmh_archive_io import (
    redact_archive as redact_archive,
)

UPSTREAM_REVISION = "bf75987eac5e8c984d8f3868249f84e4095d1733"
ADAPTER_CONTRACT = "rose-native-canonical-export-v1"
ASCII_STORAGE_ENCODING = "ascii-jsonl-v1"


def ascii_jsonl_bytes(records):
    """Escape only wire Unicode; retain every typed JSON field and scalar type."""
    return b"".join(
        (
            json.dumps(
                record.model_dump(mode="json", by_alias=True, exclude_none=False),
                allow_nan=False,
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            )
            + "\n"
        ).encode("ascii")
        for record in records
    )


def _records_sha256(records):
    """Fingerprint all ordered semantic fields, distinguishing bool/int/float."""
    digest = hashlib.sha256()
    for record in records:
        digest.update(canonical_json_bytes(record))
        digest.update(b"\n")
    return digest.hexdigest()


@contextmanager
def _verified_store(paths):
    from benchmarks.serve_experiential_world_model import _ReadSnapshot

    store = _ReadSnapshot(paths)
    enabled = gc.isenabled()
    gc.disable()
    try:
        yield store
    finally:
        store.verified.clear()
        (gc.enable if enabled else gc.disable)()


def _ascii_source(paths, reference):
    with _verified_store(paths) as store:
        stored = store.read(reference.artifact_input.artifact_id)
        if artifact_input(stored.manifest) != reference.artifact_input:
            raise ValueError("ASCII source manifest differs from the original RAG input")
        loaded = load_trace_dataset(store, reference.artifact_input.artifact_id)
        dataset = loaded.dataset
        expected = _records_sha256(loaded.traces)
        records = ascii_jsonl_bytes(loaded.traces)
        extras = {p: b for p, b in stored.payloads.items() if p not in ("trace-dataset.json", dataset.traces_path)}
    # Retain only new wire bytes and compact fingerprints before validating the
    # new artifact. Neither the old graph nor its raw snapshot spans that load.
    del loaded, stored
    digest = hashlib.sha256(records).hexdigest()
    values = dataset.model_dump(mode="json")
    values.update(
        dataset_id=stable_id("rose-real-traces", {"records_sha256": digest, "upstream_revision": UPSTREAM_REVISION}),
        traces_sha256=digest,
    )
    if values["source"] is not None and values["source"]["sha256"] == dataset.traces_sha256:
        values["source"]["sha256"] = digest
    replacement = TraceDataset.model_validate(values)
    with _verified_store(paths) as store:
        _, manifest = store.write_or_replay(
            artifact_id=replacement.dataset_id,
            artifact_type="trace-dataset",
            envelope=replacement,
            envelope_path="trace-dataset.json",
            envelope_type=TraceDataset,
            files={**extras, "trace-dataset.json": canonical_json_bytes(replacement), replacement.traces_path: records},
        )
        del records
        verified = load_trace_dataset(store, replacement.dataset_id)
        if _records_sha256(verified.traces) != expected:
            raise ValueError("ASCII source changed ordered typed trace records")
        source = RAGSourceRef.model_validate(
            {
                **reference.model_dump(mode="json"),
                "artifact_input": artifact_input(manifest).model_dump(mode="json"),
                "records_sha256": digest,
                "source": replacement.source.model_dump(mode="json"),
            }
        )
    print(json.dumps({"stage": "native-ascii-source", "dataset_id": replacement.dataset_id}), flush=True)
    return source


def _prepare_ascii_rag(rag, sources):
    transitions = ascii_jsonl_bytes(rag.transitions)
    vectors = canonical_jsonl_bytes(rag.vectors)
    if hashlib.sha256(vectors).hexdigest() != rag.index.vectors_sha256 or not vectors.isascii():
        raise ValueError("ASCII publication changed the native vector wire bytes")
    expected = (_records_sha256(rag.transitions), _records_sha256(rag.vectors))
    sources = tuple(sorted(sources, key=lambda item: item.artifact_input.artifact_id))
    values = rag.index.model_dump(mode="json")
    values.update(
        sources=[item.model_dump(mode="json") for item in sources],
        inputs=[item.artifact_input.model_dump(mode="json") for item in sources],
        transitions_sha256=hashlib.sha256(transitions).hexdigest(),
    )
    content = {k: v for k, v in values.items() if k not in {"rag_id", "created_at", "inputs", "source"}}
    values["rag_id"] = stable_id("trace-rag", content)
    index = RAGIndex.model_validate(values)
    return (
        index,
        {
            "rag-index.json": canonical_json_bytes(index),
            index.transitions_path: transitions,
            index.vectors_path: vectors,
        },
        expected,
    )


def _publish_ascii_rag(store, index, files, expected, *, model_alias, model, created_at, code_revision, top_k):
    _, manifest = store.write_or_replay(
        artifact_id=index.rag_id,
        artifact_type="trace-rag-index",
        envelope=index,
        envelope_path="rag-index.json",
        envelope_type=RAGIndex,
        files=files,
    )
    files.clear()
    print(json.dumps({"stage": "native-ascii-rag", "rag_id": index.rag_id}), flush=True)
    # This public persistence fully validates the new RAG and real sources, then
    # releases its typed RAG before our independent equality/conformance load.
    world = persist_grounded_world_model(
        store,
        artifact_input(manifest),
        model_alias=model_alias,
        model=model,
        created_at=created_at,
        code_revision=code_revision,
        top_k=top_k,
    )
    verified = load_rag_index(store, index.rag_id)
    if (_records_sha256(verified.transitions), _records_sha256(verified.vectors)) != expected:
        raise ValueError("ASCII publication changed ordered native transitions or vectors")
    if load_grounded_world_model_artifact(store, artifact_input(world.manifest)) != world.artifact:
        raise ValueError("ASCII world-model identity changed during publication")
    return world, verified


def republish_ascii(output, name, pool, pool_sha256, source_root=None):
    """Republish verified native records without original imports or embeddings."""
    output = Path(output).resolve()
    paths = ProjectPaths(output / "experiential", name)
    pointer_path = output / "models" / name / "experiential.json"
    pointer = json.loads(pointer_path.read_text())
    if (
        pointer.get("schema") != "rose.experiential_model.v1"
        or pointer.get("upstream_revision") != UPSTREAM_REVISION
        or pointer.get("adapter_contract") != ADAPTER_CONTRACT
    ):
        raise ValueError("ASCII publication requires the original pinned native artifact")
    suite = Path(source_root or pointer.get("source_corpus", output)) / "conformance.json"
    if not suite.exists():
        suite = output / "conformance.native.json"
    if not suite.exists():
        raise ValueError("ASCII republication requires a complete conformance suite")
    with _verified_store(paths) as store:
        stored = store.read(pointer["world_model_id"])
        ref = artifact_input(stored.manifest)
        if ref.sha256 != pointer["world_model_manifest_sha256"]:
            raise ValueError("ASCII publication model manifest differs from its pointer")
        artifact = load_grounded_world_model_artifact(store, ref)
        if (
            artifact.prompt_version != "text-world-model-v3"
            or artifact.prompt_sha256 != grounded_world_model_prompt_sha256()
        ):
            raise ValueError("ASCII publication prompt differs from the pinned runtime")
        if artifact.model != model_snapshot(pool, pool_sha256):
            raise ValueError("ASCII publication pool identity differs from the original model")
        stored_rag = store.read(artifact.serving_rag.artifact_id)
        if artifact_input(stored_rag.manifest) != artifact.serving_rag:
            raise ValueError("ASCII publication RAG manifest differs from the original model")
        index = RAGIndex.model_validate_json(store.read_bytes(artifact.serving_rag.artifact_id, "rag-index.json"))
        if index.rag_id != artifact.serving_rag.artifact_id or not envelope_matches_manifest(
            index, stored_rag.manifest
        ):
            raise ValueError("ASCII publication RAG envelope differs from the original manifest")
    del stored, stored_rag
    if pointer.get("storage_encoding") == ASCII_STORAGE_ENCODING:
        with _verified_store(paths) as store:
            rag = load_rag_index(store, index.rag_id)
            for source in rag.index.sources:
                dataset = TraceDataset.model_validate_json(
                    store.read_bytes(source.artifact_input.artifact_id, "trace-dataset.json")
                )
                if not store.read_bytes(dataset.dataset_id, dataset.traces_path).isascii():
                    raise ValueError("Native source storage encoding differs from its pointer")
            if not store.read_bytes(index.rag_id, index.transitions_path).isascii():
                raise ValueError("Native RAG storage encoding differs from its pointer")
            bind_conformance(suite, output / "conformance.native.json", rag.transitions, pointer)
        return pointer
    replacements = tuple(_ascii_source(paths, source) for source in index.sources)
    with _verified_store(paths) as store:
        original = load_rag_index(store, index.rag_id)
        prepared, files, expected = _prepare_ascii_rag(original, replacements)
    del original
    with _verified_store(paths) as store:
        world, rag = _publish_ascii_rag(
            store,
            prepared,
            files,
            expected,
            model_alias=artifact.model_alias,
            model=artifact.model,
            created_at=artifact.created_at,
            code_revision=artifact.code_revision,
            top_k=artifact.top_k,
        )
        result = {
            **pointer,
            "world_model_id": world.artifact.world_model_id,
            "world_model_manifest_sha256": artifact_input(world.manifest).sha256,
            "storage_encoding": ASCII_STORAGE_ENCODING,
            "republished_from_world_model_id": pointer["world_model_id"],
        }
        bind_conformance(suite, output / "conformance.native.json", rag.transitions, result)
        atomic_json(output / "build.manifest.json", {"engine": "experiential", **result})
        atomic_json(pointer_path, result)
    print(json.dumps({"stage": "native-ascii-ready", **result}), flush=True)
    return result


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


def _clock_ms(value):
    """OTel JSON carries intValue as decimal text; accept only exact nonnegative integers."""
    if isinstance(value, str) and value.isdigit():
        return int(value)
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def measured_elapsed_ms(attrs, root):
    """Real time-to-complete from the export's measured tool clocks, never the pairing ordinals."""
    started, completed = attrs.get("rose.tool.started_at_ms"), attrs.get("rose.tool.completed_at_ms")
    if started is None and completed is None:
        return None
    started, completed = _clock_ms(started), _clock_ms(completed)
    if started is None or completed is None or completed < started:
        raise ValueError(f"{root}: malformed measured tool clocks")
    return completed - started


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
        semantic_convention_version="rose-canonical-export-v12",
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
        elapsed = measured_elapsed_ms(attrs, root)
        if elapsed is not None:
            attrs[MEASURED_ELAPSED_MS_ATTRIBUTE] = elapsed
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
    records = ascii_jsonl_bytes(traces)
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
        semantic_convention_version="rose-canonical-export-v12",
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
    index, files, fingerprints = _prepare_ascii_rag(rag, rag.index.sources)
    del rag
    with _verified_store(store.paths) as verified_store:
        world, rag = _publish_ascii_rag(
            verified_store,
            index,
            files,
            fingerprints,
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
        "storage_encoding": ASCII_STORAGE_ENCODING,
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
    p.add_argument("--source-root", type=Path)
    p.add_argument("--root", required=True, type=Path)
    p.add_argument("--name", required=True)
    p.add_argument("--pool", default="rose-1-ultra")
    p.add_argument("--pool-sha256", required=True)
    p.add_argument("--bind-conformance-only", action="store_true")
    p.add_argument("--republish-ascii", action="store_true")
    a = p.parse_args()
    if a.republish_ascii:
        if a.bind_conformance_only:
            p.error("Choose one of --republish-ascii or --bind-conformance-only")
        republish_ascii(a.root, a.name, a.pool, a.pool_sha256, a.source_root)
    elif a.source_root is None:
        p.error("--source-root is required for import or conformance binding")
    elif a.bind_conformance_only:
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
