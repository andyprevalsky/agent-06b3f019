"""Run a real-trajectory conformance suite against a served WHM model."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from benchmarks.world_model_harness import evaluate_world_model_conformance_suite


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Replay a generated 100-case Rose trajectory suite against a served WMH model."
    )
    parser.add_argument("--suite", required=True, help="Path to conformance.json from the model build.")
    parser.add_argument("--url", required=True, help="Served WMH base URL.")
    parser.add_argument("--model", required=True, help="Served WMH model name.")
    parser.add_argument("--output", help="Optional JSON report path.")
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--min-mean-score", type=float, default=0.7)
    parser.add_argument("--min-content-accuracy", type=float, default=0.25)
    args = parser.parse_args(argv)

    report = asyncio.run(
        evaluate_world_model_conformance_suite(
            Path(args.suite),
            world_model_name=args.model,
            base_url=args.url,
            output_path=Path(args.output) if args.output else None,
            concurrency=args.concurrency,
            min_mean_score=args.min_mean_score,
            min_content_accuracy=args.min_content_accuracy,
        )
    )
    summary = {key: value for key, value in report.items() if key not in {"results", "by_category"}}
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
