"""CLI: prepare -> evaluate -> errors. Mutations are deliberately a separate step."""
import argparse
from pathlib import Path
import json
from core import load_rows, prepare, evaluate, save, verify_dataset


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "evaluate", "errors"])
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prompt", type=Path)
    parser.add_argument("--cohort", choices=["train", "validation", "test"], default="train")
    parser.add_argument("--allow-test", action="store_true")
    parser.add_argument("--result", type=Path)
    args = parser.parse_args()
    if args.command == "prepare":
        print(json.dumps(prepare(args.dataset, args.output), indent=2))
        return
    if args.command == "errors":
        result = json.loads(args.result.read_text())
        print(json.dumps(sorted((r for r in result["rows"] if r.get("ok")),
                                key=lambda r: r["progress_error"], reverse=True)[:12], indent=2))
        return
    cohorts = json.loads((args.output / "cohorts.json").read_text())
    verify_dataset(args.dataset, cohorts)
    if args.cohort == "test" and not args.allow_test:
        parser.error("Test is sealed during optimization. Use --allow-test only for final reporting.")
    rows = load_rows(args.dataset / ("test.jsonl.gz" if args.cohort == "test" else "train.jsonl.gz"))
    if args.cohort != "test":
        wanted = set(cohorts[args.cohort + "_ids"])
        rows = [r for r in rows if r["example_id"] in wanted]
    traces = {t["trace_id"]: t for t in load_rows(args.dataset / "traces.jsonl.gz")}
    prompt = json.loads((args.prompt or args.output / "prompts/seed.json").read_text())
    result = evaluate(rows, traces, prompt, args.output)
    save(args.result or args.output / (args.cohort + "-baseline.json"), result)
    print(json.dumps(result["metrics"], indent=2))


if __name__ == "__main__":
    main()
