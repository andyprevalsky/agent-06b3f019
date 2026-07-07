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
import sys

import structlog

logger = structlog.get_logger(__name__)


def build_app(name: str, root: str, pool: str):
    """Load the model at `root/models/<name>` with the Rose provider and return a FastAPI app.

    Mirrors `wmh serve`'s resolution: `WorldModelStore(root).resolve(name)` picks the
    artifact dir (validating the name and existence), then `WorldModel.load(dir, provider=...)`
    rebuilds the model with our provider injected in place of the config's Anthropic one.
    """
    from wmh.config import WorldModelStore
    from wmh.engine.world_model import WorldModel

    from benchmarks.wmh_rose_provider import RoseWMHProvider

    store = WorldModelStore(root)
    model_dir = store.resolve(name)  # raises FileNotFoundError/ValueError on bad --name/--root

    provider = RoseWMHProvider(pool=pool)
    world_model = WorldModel.load(
        str(model_dir),
        provider=provider,
        telemetry_root=store.root,
    )

    from wmh.serving.server import create_app

    return create_app(world_models={name: world_model})


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
