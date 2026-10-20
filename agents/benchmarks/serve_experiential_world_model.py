"""Serve a verified native artifact through Rose's existing WMH HTTP contract."""

from __future__ import annotations

import argparse
import gc
import json
import os
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
)
from benchmarks.experiential_bridge import PROVIDER_CLIENT_KEEPALIVE_SECONDS
from benchmarks.experiential_world_model import ParallelWorldModel, RetiredWorldModelScope, RoseNativeRetriever
from benchmarks.wmh_execution_policy import DEFAULT_EXECUTION_POLICY, execution_identity, execution_policy


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
    # This synchronous startup load precedes serving. Typed JSON allocation can
    # repeatedly sweep the growing live corpus; keep every public validator but
    # defer automatic GC until the verified-byte snapshot has been released.
    gc_enabled = gc.isenabled()
    gc.disable()
    try:
        return _load_snapshot(store, pointer, pool, pool_sha256)
    finally:
        store.verified.clear()
        (gc.enable if gc_enabled else gc.disable)()


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
        except RetiredWorldModelScope as exc:
            raise HTTPException(409, str(exc)) from exc
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

    # The world clock is addressed by root scope: agents know their root agent
    # id, and a scope maps to exactly one live world session.
    def scoped_session(model_name, scope):
        session_id = model.scopes.get(scope) if model_name == name else None
        if session_id is None or session_id not in model.sessions:
            raise HTTPException(404, "Unknown world scope")
        return session_id

    def clock_call(model_name, scope, operation):
        session_id = scoped_session(model_name, scope)
        try:
            return operation(session_id)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get("/world_models/{model_name}/scopes/{scope}/clock")
    def world_clock(model_name: str, scope: str):
        return clock_call(model_name, scope, model.clock_snapshot)

    @app.post("/world_models/{model_name}/scopes/{scope}/clock/agents/{agent_id}/register")
    def clock_register(model_name: str, scope: str, agent_id: str, payload: dict):
        parent = payload.get("parent")
        if parent is not None and (not isinstance(parent, str) or not parent):
            raise HTTPException(422, "parent must be an agent id")
        return clock_call(model_name, scope, lambda session_id: model.clock_register(session_id, agent_id, parent))

    @app.post("/world_models/{model_name}/scopes/{scope}/clock/agents/{agent_id}/finish")
    def clock_finish(model_name: str, scope: str, agent_id: str, payload: dict):
        return clock_call(model_name, scope, lambda session_id: model.clock_finish(session_id, agent_id))

    def hold_id_of(payload):
        hold_id = payload.get("hold_id")
        if not isinstance(hold_id, str) or not hold_id:
            raise HTTPException(422, "hold_id must be a non-empty string")
        return hold_id

    @app.post("/world_models/{model_name}/scopes/{scope}/clock/agents/{agent_id}/hold")
    def clock_hold(model_name: str, scope: str, agent_id: str, payload: dict):
        hold_id = hold_id_of(payload)
        return clock_call(model_name, scope, lambda session_id: model.clock_hold(session_id, agent_id, hold_id))

    @app.post("/world_models/{model_name}/scopes/{scope}/clock/agents/{agent_id}/release")
    def clock_release(model_name: str, scope: str, agent_id: str, payload: dict):
        hold_id = hold_id_of(payload)
        children = payload.get("children", [])
        if not isinstance(children, list) or not all(isinstance(child, str) and child for child in children):
            raise HTTPException(422, "children must be a list of agent ids")
        return clock_call(
            model_name, scope, lambda session_id: model.clock_release(session_id, agent_id, hold_id, children)
        )

    @app.post("/world_models/{model_name}/scopes/{scope}/clock/agents/{agent_id}/wait")
    async def clock_wait(model_name: str, scope: str, agent_id: str, payload: dict):
        # Long-poll: returns resumed=false after the poll so callers re-poll
        # instead of holding one HTTP request across a long real-time wait.
        wait_id = payload.get("wait_id")
        bounds = [payload.get(key) for key in ("until_ms", "duration_ms")]
        if (
            not isinstance(wait_id, str)
            or not wait_id
            or sum(value is not None for value in bounds) != 1
            or any(value is not None and (type(value) is not int or value < 0) for value in bounds)
        ):
            raise HTTPException(422, "A wait needs a wait_id and exactly one non-negative until_ms or duration_ms")
        session_id = scoped_session(model_name, scope)
        try:
            return await model.clock_wait(
                session_id,
                agent_id,
                wait_id,
                until_ms=bounds[0],
                duration_ms=bounds[1],
                poll_seconds=min(float(payload.get("poll_seconds", 50)), 50),
            )
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get("/world_models/{model_name}/sessions/{session_id}/activity")
    def session_activity(model_name: str, session_id: str):
        # Cheap liveness for benchmark stall detection; never the world state.
        if model_name != name or session_id not in model.sessions:
            raise HTTPException(404, "Unknown session")
        session = model.sessions[session_id]
        in_flight = sum(1 for _, operation in session.receipts.values() if not operation.done())
        return {"revision": session.revision, "operations_in_flight": in_flight}

    @app.delete("/world_models/{model_name}/sessions/{session_id}")
    async def end_session(model_name: str, session_id: str):
        if model_name != name or (session_id not in model.sessions and session_id not in model.retired):
            raise HTTPException(404, "Unknown session")
        return await model.end_session(session_id)

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


def native_provider_http_client(provider_url, provider_token):
    """One native-to-bridge transport contract for the service and owning controls."""
    return httpx.AsyncClient(
        base_url=provider_url,
        headers={"X-Rose-Provider-Token": provider_token},
        timeout=660,
        limits=httpx.Limits(keepalive_expiry=PROVIDER_CLIENT_KEEPALIVE_SECONDS),
        trust_env=False,
    )


async def native_provider_complete(
    client, root, effective_identity, capture_enabled, session_id, prediction_id, request
):
    from exp.common.core.artifacts import sha256_json

    from benchmarks.wmh_provider_capture import close_owner, open_owner

    request_sha256 = sha256_json(request.model_dump(mode="json"))
    if capture_enabled:
        open_owner(
            root,
            session_id,
            prediction_id,
            request_sha256,
            effective_identity,
            wire={
                "messages": [m.model_dump(mode="json", exclude_none=True) for m in request.messages],
                "maximum_output_tokens": request.maximum_output_tokens,
            },
        )
    try:
        return await _native_provider_post(
            client, effective_identity, capture_enabled, session_id, prediction_id, request, request_sha256
        )
    finally:
        if capture_enabled:
            close_owner(root, session_id, prediction_id)


async def _native_provider_post(
    client, effective_identity, capture_enabled, session_id, prediction_id, request, request_sha256
):
    response = await client.post(
        "/complete",
        json={
            "messages": [m.model_dump(mode="json", exclude_none=True) for m in request.messages],
            "maximum_output_tokens": request.maximum_output_tokens,
            "session_id": session_id,
            "prediction_id": prediction_id,
            "execution_identity": effective_identity,
            **({"request_sha256": request_sha256} if capture_enabled else {}),
        },
    )
    if response.status_code == 422:
        detail = response.json().get("detail")
        if isinstance(detail, dict) and detail.get("kind") == "invalid_prediction":
            error = TextWorldModelProtocolError(detail["reason"])
            error.rejected_response = detail.get("rejected_response")
            raise error
    response.raise_for_status()
    result = response.json()
    if result.get("execution_identity") != effective_identity:
        raise ValueError("Provider bridge returned a different execution identity")
    return result


def main():
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--pool", default="rose-1-ultra")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--provider-url", required=True)
    parser.add_argument("--execution-policy", default=os.environ.get("WMH_EXECUTION_POLICY", DEFAULT_EXECUTION_POLICY))
    args = parser.parse_args()
    policy = execution_policy(args.execution_policy)
    artifact, retriever = load_native(args.root, args.name, args.pool, os.environ["WMH_ROSE_POOL_SHA256"])
    effective_identity = execution_identity(
        policy.name,
        artifact.world_model_id,
        retriever.world_model_manifest_sha256,
        base_protocol_sha256=artifact.prompt_sha256,
        runtime_config=json.loads(os.environ.get("WMH_RUNTIME_CONFIG_JSON", "null")),
    )
    # Both services bind loopback. Credentials never leave the existing provider.
    client = native_provider_http_client(args.provider_url, os.environ["WMH_PROVIDER_BRIDGE_TOKEN"])

    capture_enabled = bool((effective_identity.get("runtime_config") or {}).get("validation_recovery"))

    async def complete_scoped(session_id, prediction_id, request):
        return await native_provider_complete(
            client, args.root, effective_identity, capture_enabled, session_id, prediction_id, request
        )

    async def retire_provider(session_id):
        response = await client.post(f"/sessions/{session_id}/retire")
        response.raise_for_status()
        return response.json()

    async def usage():
        response = await client.get("/rose_usage")
        response.raise_for_status()
        return response.json()

    async def close_owned():
        await client.aclose()
        # After the model closed, so no admitted write still needs the pool.
        redactor.shutdown(wait=True)

    from benchmarks.wmh_native_prediction_writer import NativePredictionWriter, redaction_pool

    redactor = redaction_pool()
    record_prediction = NativePredictionWriter(
        args.root, artifact.world_model_id, artifact.prompt_sha256, redactor=redactor
    )

    def record_retirement(receipt):
        path = Path(args.root) / "native-retirements" / (receipt["session_id"] + ".json")
        atomic_json(path, receipt)
        return path

    def load_retirement(path):
        return json.loads(path.read_text())

    model = ParallelWorldModel(
        None,
        retriever,
        capabilities=model_capabilities(),
        record_prediction=record_prediction,
        complete_scoped=complete_scoped,
        retire_provider=retire_provider,
        record_retirement=record_retirement,
        load_retirement=load_retirement,
        execution_policy=policy.name,
        execution_identity=effective_identity,
    )
    app = create_app(
        args.name,
        model,
        usage,
        close_owned,
        identity={
            "world_model_id": artifact.world_model_id,
            "world_model_manifest_sha256": retriever.world_model_manifest_sha256,
            "execution_identity": effective_identity,
        },
    )
    uvicorn.run(app, host="127.0.0.1", port=args.port, timeout_graceful_shutdown=10)


if __name__ == "__main__":
    main()
