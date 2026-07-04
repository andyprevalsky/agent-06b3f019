"""Score WMH prediction fidelity across archived local trace bundles."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from benchmarks.world_model_harness import evaluate_archives_with_world_model


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root-agent-id", action="append", default=[], help="Archive bundle to score. Repeatable.")
    parser.add_argument("--world-model-url", default=None, help="WMH server base URL. Defaults to WMH_BASE_URL.")
    parser.add_argument("--world-model-name", default=None, help="WMH model name. Defaults to WMH_MODEL_NAME.")
    parser.add_argument("--archive-backend", choices=["local", "r2"], default=None, help="Trace archive backend to read.")
    parser.add_argument("--limit", type=int, default=None, help="Limit auto-discovered bundle count.")
    parser.add_argument("--output", default=None, help="Optional JSON output path.")
    return parser


async def _main() -> int:
    args = _parser().parse_args()
    if args.archive_backend:
        import os

        os.environ["TRACE_ARCHIVE_BACKEND"] = args.archive_backend
    root_agent_ids = args.root_agent_id or None
    if root_agent_ids is None and args.limit is not None:
        from benchmarks.world_model_harness import list_archive_bundle_ids

        root_agent_ids = list_archive_bundle_ids()[: args.limit]
    result = await evaluate_archives_with_world_model(
        root_agent_ids,
        base_url=args.world_model_url,
        world_model_name=args.world_model_name,
    )
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if result.get("status") == "scored" else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
