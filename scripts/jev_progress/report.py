"""Compare frozen prompts on the same untouched test examples."""
import argparse
from collections import defaultdict
import json
import math
from pathlib import Path
import random
import statistics


def percentile(values, fraction):
    values = sorted(values)
    index = (len(values) - 1) * fraction
    low = math.floor(index)
    high = math.ceil(index)
    return values[low] + (values[high] - values[low]) * (index - low)


def metrics(rows):
    errors = [100 * r["progress_error"] for r in rows]
    nonzero = [r for r in rows if r["actual_progress"] > 0]
    eta = [r for r in rows if r["eta_actual"] is not None]
    eta_positive = [r for r in eta if r['eta_actual'] > 0]
    return {"count": len(rows), "mae_pp": statistics.mean(errors),
            "within_10pp": sum(e <= 10 for e in errors) / len(errors),
            "coverage_65_pp": percentile(errors, .65), "coverage_95_pp": percentile(errors, .95),
            "median_relative_error": statistics.median(r["progress_error"] / r["actual_progress"] for r in nonzero),
            "mean_relative_error": statistics.mean(r["progress_error"] / r["actual_progress"] for r in nonzero),
            "eta_log_mae": statistics.mean(r["eta_log_error"] for r in eta) if eta else None,
            "eta_median_relative_error": statistics.median(abs(r['eta_predicted']-r['eta_actual'])/r['eta_actual'] for r in eta_positive) if eta_positive else None,
            "eta_mean_relative_error": statistics.mean(abs(r['eta_predicted']-r['eta_actual'])/r['eta_actual'] for r in eta_positive) if eta_positive else None,
            "eta_mean_absolute_seconds": statistics.mean(abs(r['eta_predicted']-r['eta_actual']) for r in eta) if eta else None,
            "eta_count": len(eta)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--winner", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    baseline = json.loads(args.baseline.read_text())
    winner = json.loads(args.winner.read_text())
    if baseline["cohort_hash"] != winner["cohort_hash"]:
        raise ValueError("Unpaired cohorts")
    if baseline["metrics"]["failed"] or winner["metrics"]["failed"]:
        raise ValueError("Failed cases must be resolved before a complete comparison")
    base = {r["example_id"]: r for r in baseline["rows"]}
    after = {r["example_id"]: r for r in winner["rows"]}
    by_trace = defaultdict(list)
    for key in base:
        by_trace[base[key]["trace_id"]].append(100 * (base[key]["progress_error"] - after[key]["progress_error"]))
    deltas = [statistics.mean(v) for v in by_trace.values()]
    rng = random.Random(20261021)
    boot = [statistics.mean(rng.choices(deltas, k=len(deltas))) for _ in range(3000)]
    result = {"baseline": metrics(list(base.values())), "winner": metrics(list(after.values())),
              "paired_trace_macro_improvement_pp": statistics.mean(deltas),
              "trace_bootstrap_95_interval_pp": [percentile(boot, .025), percentile(boot, .975)],
              "by_kind": {k: {"baseline": metrics([r for r in base.values() if r["kind"] == k]),
                              "winner": metrics([r for r in after.values() if r["kind"] == k])}
                          for k in sorted({r["kind"] for r in base.values()})},
              "test_cohort_hash": baseline["cohort_hash"], "baseline_prompt_hash": baseline["prompt_hash"],
              "winner_prompt_hash": winner["prompt_hash"],
              "limitations": "The test was previously reported but never fed into reflection or candidate selection in this run. Repeated prefixes are correlated; bootstrap clusters by trace, not full root family."}
    args.output.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
