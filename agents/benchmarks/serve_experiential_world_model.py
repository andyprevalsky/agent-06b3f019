"""Serve a verified native artifact through Rose's existing WMH HTTP contract."""

from __future__ import annotations

import argparse
import json
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from exp.common.project import ArtifactStore, ProjectPaths, artifact_input
from exp.simulation.engines.text.prompt import TextWorldModelProtocolError
from exp.simulation.retrieval import load_rag_index
from exp.simulation.world_model.artifact import grounded_world_model_prompt_sha256
from exp.simulation.world_model.runtime import load_grounded_world_model_artifact
from fastapi import FastAPI, Header, HTTPException

from benchmarks.build_experiential_world_model import (
    ADAPTER_CONTRACT,
    UPSTREAM_REVISION,
    atomic_json,
    model_capabilities,
    model_snapshot,
    redact_archive,
)
from benchmarks.experiential_world_model import ParallelWorldModel, RoseNativeRetriever


class _ReadSnapshot(ArtifactStore):
    """Reuse exact publicly verified immutable bytes within one loading scope.

    Every fresh instance verifies storage again. Public typed loaders still
    validate content identities, source spans and provenance against this
    consistent snapshot. Raw bytes are released on both success and failure.
    """

    def __init__(self, paths):
        super().__init__(paths)
        self.verified = {}

    def read(self, artifact_id):
        if artifact_id not in self.verified:
            self.verified[artifact_id] = super().read(artifact_id)
        return self.verified[artifact_id]


def load_native(root, name, pool, pool_sha256):
    root = Path(root)
    paths = ProjectPaths(root / "experiential", name)
    pointer = json.loads((root / "models" / name / "experiential.json").read_text())
    if (
        pointer["schema"] != "rose.experiential_model.v1"
        or pointer["upstream_revision"] != UPSTREAM_REVISION
        or pointer.get("adapter_contract") != ADAPTER_CONTRACT
    ):
        raise ValueError("Native artifact version differs from the pinned runtime")
    store = _ReadSnapshot(paths)
    try:
        return _load_snapshot(store, pointer, pool, pool_sha256)
    finally:
        store.verified.clear()


def _load_snapshot(store, pointer, pool, pool_sha256):
    stored = store.read(pointer["world_model_id"])
    if artifact_input(stored.manifest).sha256 != pointer["world_model_manifest_sha256"]:
        raise ValueError("Native artifact manifest differs from its published pointer")
    artifact = load_grounded_world_model_artifact(store, artifact_input(stored.manifest))
    if (
        artifact.prompt_sha256 != grounded_world_model_prompt_sha256()
        or artifact.prompt_version != "text-world-model-v3"
    ):
        raise ValueError("Native artifact prompt differs; rebuild explicitly")
    if artifact.model != model_snapshot(pool, pool_sha256):
        raise ValueError("Native artifact Rose pool identity differs; rebuild explicitly")
    loaded = load_rag_index(store, artifact.serving_rag.artifact_id)
    if artifact_input(loaded.manifest) != artifact.serving_rag:
        raise ValueError("Native RAG manifest differs from the world-model artifact")
    retriever = RoseNativeRetriever(loaded)
    retriever.world_model_manifest_sha256 = artifact_input(stored.manifest).sha256
    return artifact, retriever


def create_app(name, model, usage=None, close_provider=None, *, identity=None):
    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            await model.close()
            if close_provider:
                await close_provider()

    app = FastAPI(lifespan=lifespan)

    @app.get("/healthz")
    def health():
        return {
            "status": "ok",
            "engine": "experiential",
            "protocol": "text-world-model-v3",
            "world_model_name": name,
            **(identity or {}),
        }

    @app.get("/world_models")
    def models():
        return {"world_models": [name]}

    @app.post("/world_models/{model_name}/sessions")
    async def new_session(model_name: str, payload: dict):
        if model_name != name:
            raise HTTPException(404, "Unknown world model")
        try:
            session = model.new_session(
                payload.get("task"), payload.get("seed_state") or {}, payload.get("session_scope_id")
            )
            return {"session_id": session.id}
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/world_models/{model_name}/sessions/{session_id}/step")
    async def step(
        model_name: str, session_id: str, payload: dict, x_rose_wmh_invocation: str | None = Header(default=None)
    ):
        if model_name != name:
            raise HTTPException(404, "Unknown world model")
        try:
            return {"observation": await model.step(session_id, payload["action"], x_rose_wmh_invocation)}
        except KeyError as exc:
            raise HTTPException(404, "Unknown native session/action") from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get("/world_models/{model_name}/sessions/{session_id}")
    async def get_session(model_name: str, session_id: str):
        if model_name != name or session_id not in model.sessions:
            raise HTTPException(404, "Unknown session")
        session = model.sessions[session_id]
        async with session.lock:
            return {
                "id": session.id,
                "task": session.task,
                "state": session.state,
                "history": session.history,
                "revision": session.revision,
            }

    @app.delete("/world_models/{model_name}/sessions/{session_id}")
    async def end_session(model_name: str, session_id: str):
        if model_name != name or session_id not in model.sessions:
            raise HTTPException(404, "Unknown session")
        await model.end_session(session_id)
        return {"ended": session_id}

    @app.get("/retrieval_audit")
    def audit():
        events = list(model.audit)
        size = len(getattr(getattr(model.retriever, "loaded", None), "transitions", ()))
        return {
            "schema": "rose.wmh_retrieval_audit.v1",
            "engine": "experiential",
            "query_count": model.retrieval_calls,
            "offline_index_steps": size,
            "eligible_index_steps": size,
            "real_world_demo_uses": sum(len(e["demos"]) for e in events),
            "events": events,
        }

    @app.get("/rose_usage")
    async def rose_usage():
        return await usage() if usage else {}

    return app


def main():
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--pool", default="rose-1-ultra")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--provider-url", required=True)
    args = parser.parse_args()
    artifact, retriever = load_native(args.root, args.name, args.pool, os.environ["WMH_ROSE_POOL_SHA256"])
    # Both services bind loopback. Credentials never leave the existing provider.
    client = httpx.AsyncClient(
        base_url=args.provider_url,
        headers={"X-Rose-Provider-Token": os.environ["WMH_PROVIDER_BRIDGE_TOKEN"]},
        timeout=660,
        trust_env=False,
    )

    async def complete(request):
        response = await client.post(
            "/complete",
            json={
                "messages": [m.model_dump(mode="json", exclude_none=True) for m in request.messages],
                "maximum_output_tokens": request.maximum_output_tokens,
            },
        )
        if response.status_code == 422:
            detail = response.json().get("detail")
            if isinstance(detail, dict) and detail.get("kind") == "invalid_prediction":
                raise TextWorldModelProtocolError(detail["reason"])
        response.raise_for_status()
        return response.json()

    async def usage():
        response = await client.get("/rose_usage")
        response.raise_for_status()
        return response.json()

    def record_prediction(record):
        safe, redactions = redact_archive(record)
        safe.update(
            world_model_id=artifact.world_model_id, prompt_sha256=artifact.prompt_sha256, redaction_count=redactions
        )
        atomic_json(Path(args.root) / "native-predictions" / record["session_id"] / (uuid.uuid4().hex + ".json"), safe)

    model = ParallelWorldModel(
        complete, retriever, capabilities=model_capabilities(), record_prediction=record_prediction
    )
    app = create_app(
        args.name,
        model,
        usage,
        client.aclose,
        identity={
            "world_model_id": artifact.world_model_id,
            "world_model_manifest_sha256": retriever.world_model_manifest_sha256,
        },
    )
    uvicorn.run(app, host="127.0.0.1", port=args.port, timeout_graceful_shutdown=10)


if __name__ == "__main__":
    main()
