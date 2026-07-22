"""Serve a built World Model Harness model with the Rose inference provider.

This REPLACES `wmh serve` for our stack. `wmh serve` builds the direct-Anthropic
provider from the model's config.toml (`get_provider(config.serve_provider_config())`);
this CLI loads the same artifact but injects `RoseWMHProvider`, so every WMH step's
LLM call goes through the agent-side Rose machinery (compute tokens + claudeAuth +
rotation) instead of a raw Anthropic key.

Everything else matches `wmh serve`:
  - root/name resolution via `WorldModelStore(root).resolve(name)`,
  - the same FastAPI app from `wmh.serving.server.create_app`,
  - the same `/healthz` + `/world_models/{name}/sessions/.../step` routes,
  - `uvicorn.run(host="127.0.0.1", port=...)`.

Usage:
    python -m benchmarks.serve_world_model --name <model> --port <port> --root <dir> [--pool rose-1-lite]
"""

from __future__ import annotations

import argparse
import json
import sys
import threading

import structlog

logger = structlog.get_logger(__name__)


def _preview(value, limit: int = 500):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
    return text if len(text) <= limit else text[:limit] + f"… [{len(text)} chars]"


def _action_summary(action) -> dict:
    arguments = action.arguments if isinstance(action.arguments, dict) else {}
    safe_keys = (
        "goal",
        "task",
        "url",
        "query",
        "selector",
        "action",
        "request",
        "agent_id",
        "artifact_refs",
    )
    return {
        "kind": getattr(action.kind, "value", str(action.kind)),
        "name": action.name,
        "arguments": {key: _preview(arguments[key]) for key in safe_keys if key in arguments},
        "argument_keys": sorted(arguments),
    }


def _step_summary(step, *, source: str) -> dict:
    structured = step.state_before.structured if isinstance(step.state_before.structured, dict) else {}
    metadata = step.observation.metadata if isinstance(step.observation.metadata, dict) else {}
    return {
        "source": source,
        "task": _preview(step.task or ""),
        "root_agent_id": structured.get("root_agent_id"),
        "state": {
            key: structured[key]
            for key in ("schema", "root_goal", "row_counts", "url", "title")
            if key in structured
        },
        "action": _action_summary(step.action),
        "observation": {
            "content": _preview(step.observation.content),
            "is_error": step.observation.is_error,
            "metadata": {
                key: metadata[key]
                for key in ("source", "result_unavailable", "state_note", "url")
                if key in metadata
            },
        },
        "raw_span_ids": list(step.raw_span_ids),
    }


class RetrievalAuditRetriever:
    """Delegate retriever that records the exact ordered demos returned for each query."""

    def __init__(self, retriever) -> None:
        self._retriever = retriever
        self._offline_step_ids = {id(step) for step in retriever.sample(1_000_000)}
        self._events: list[dict] = []
        self._lock = threading.Lock()

    def index(self, traces) -> None:
        self._retriever.index(traces)
        self._offline_step_ids = {id(step) for step in self._retriever.sample(1_000_000)}

    def topk(self, state, action, k: int):
        demos = self._retriever.topk(state, action, k)
        with self._lock:
            self._events.append(
                {
                    "sequence": len(self._events) + 1,
                    "query": {
                        "action": _action_summary(action),
                        "state_keys": sorted(state.structured) if isinstance(state.structured, dict) else [],
                        "scratchpad_chars": len(state.scratchpad),
                    },
                    "demos": [
                        _step_summary(
                            step,
                            source=(
                                "real_world_archive"
                                if id(step) in self._offline_step_ids
                                else "generated_session"
                            ),
                        )
                        for step in demos
                    ],
                }
            )
        return demos

    def add(self, step) -> None:
        self._retriever.add(step)

    def sample(self, n: int):
        return self._retriever.sample(n)

    def snapshot(self) -> dict:
        with self._lock:
            events = list(self._events)
        archive_demos = sum(
            1
            for event in events
            for demo in event["demos"]
            if demo["source"] == "real_world_archive"
        )
        return {
            "schema": "rose.wmh_retrieval_audit.v1",
            "query_count": len(events),
            "offline_index_steps": len(self._offline_step_ids),
            "real_world_demo_uses": archive_demos,
            "events": events,
        }


def build_app(name: str, root: str, pool: str):
    """Load the model at `root/models/<name>` with the Rose provider and return a FastAPI app.

    Mirrors `wmh serve`'s resolution: `WorldModelStore(root).resolve(name)` picks the
    artifact dir (validating the name and existence), then `WorldModel.load(dir, provider=...)`
    rebuilds the model with our provider injected in place of the config's Anthropic one.
    """
    from wmh.config import WorldModelStore
    from wmh.engine.world_model import WorldModel

    from benchmarks.wmh_rose_provider import GLOBAL_ROSE_USAGE, RoseWMHProvider

    store = WorldModelStore(root)
    model_dir = store.resolve(name)  # raises FileNotFoundError/ValueError on bad --name/--root

    provider = RoseWMHProvider(pool=pool)
    world_model = WorldModel.load(
        str(model_dir),
        provider=provider,
        telemetry_root=store.root,
    )
    # WorldModel.load owns retriever construction. Wrap that loaded retriever without modifying
    # vendored WMH so post-run evidence can show the exact real-world demos used per prediction.
    retrieval_audit = RetrievalAuditRetriever(world_model._retriever)
    world_model._retriever = retrieval_audit

    from wmh.serving.server import create_app

    app = create_app(world_models={name: world_model})
    _add_rose_usage_route(app, GLOBAL_ROSE_USAGE)
    _add_retrieval_audit_route(app, retrieval_audit)
    return app


def _add_rose_usage_route(app, usage) -> None:
    """Expose cumulative Rose inference cost/tokens for this served WMH.

    The vendored `create_app` has no cost endpoint; we extend the returned FastAPI app
    with `GET /rose_usage` so the benchmark controller can attribute WMH grounding cost
    to a run. Reads the process-level accumulator the provider records into on each step.
    """

    @app.get("/rose_usage")
    def rose_usage() -> dict:  # pragma: no cover - exercised via TestClient in tests
        return usage.snapshot().as_dict()


def _add_retrieval_audit_route(app, audit) -> None:
    @app.get("/retrieval_audit")
    def retrieval_audit() -> dict:  # pragma: no cover - exercised via TestClient in tests
        return audit.snapshot()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Serve a WMH model with the Rose inference provider (replaces `wmh serve`)."
    )
    parser.add_argument("--name", required=True, help="World model name to serve.")
    parser.add_argument("--port", type=int, required=True, help="Port for the local backend.")
    parser.add_argument("--root", required=True, help="Project dir holding models/<name>/.")
    parser.add_argument(
        "--pool",
        default="rose-1-lite",
        help="Rose pool backing WMH inference (default: rose-1-lite).",
    )
    args = parser.parse_args(argv)

    try:
        app = build_app(args.name, args.root, args.pool)
    except (ValueError, FileNotFoundError) as err:
        # Bad --name/--root is a usage error, not a traceback (matches `wmh serve`).
        print(f"error: {err}", file=sys.stderr)
        return 2

    logger.info(
        "wmh.serve_world_model.start",
        name=args.name,
        port=args.port,
        root=args.root,
        pool=args.pool,
    )

    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
