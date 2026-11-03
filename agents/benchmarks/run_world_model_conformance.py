"""Run a real-trajectory conformance suite against a served WHM model."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from benchmarks.wmh_execution_policy import (
    DEFAULT_EXECUTION_POLICY,
    bind_execution_suite,
    registered_execution_policies,
)
from benchmarks.world_model_harness import evaluate_world_model_conformance_suite


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Replay a generated 100-case Rose trajectory suite against a served WMH model."
    )
    parser.add_argument("--suite", required=True, help="Path to conformance.json from the model build.")
    parser.add_argument("--url", help="Served WMH base URL.")
    parser.add_argument("--model", help="Served WMH model name.")
    parser.add_argument("--output", help="Optional JSON report path.")
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--min-mean-score", type=float, default=0.7)
    parser.add_argument("--min-content-accuracy", type=float, default=0.25)
    parser.add_argument(
        "--execution-policy",
        choices=registered_execution_policies(),
        default=DEFAULT_EXECUTION_POLICY,
        help="Expected native runtime policy; never inferred from the server.",
    )
    parser.add_argument("--bind-execution-suite", help="Write a separately bound suite and exit without model calls.")
    parser.add_argument("--runtime-config-file", help="Expected explicit WHM inference configuration JSON; never inferred from the server.")
    args = parser.parse_args(argv)
    runtime_config = json.loads(Path(args.runtime_config_file).read_text()) if args.runtime_config_file else None
    if args.bind_execution_suite:
        suite = bind_execution_suite(args.suite, args.bind_execution_suite, args.execution_policy, runtime_config=runtime_config)
        print(
            json.dumps(
                {
                    "native_execution_identity": suite["native_execution_identity"],
                    "bound_suite": args.bind_execution_suite,
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0
    if not args.url or not args.model:
        parser.error("--url and --model are required for evaluation")

    report = asyncio.run(
        evaluate_world_model_conformance_suite(
            Path(args.suite),
            world_model_name=args.model,
            base_url=args.url,
            output_path=Path(args.output) if args.output else None,
            concurrency=args.concurrency,
            min_mean_score=args.min_mean_score,
            min_content_accuracy=args.min_content_accuracy,
            execution_policy=args.execution_policy,
            runtime_config=runtime_config,
        )
    )
    summary = {key: value for key, value in report.items() if key not in {"results", "by_category"}}
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
