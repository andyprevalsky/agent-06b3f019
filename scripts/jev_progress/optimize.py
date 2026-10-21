"""GEPA-style reflection, validation, Pareto selection and component merging.

This is a small transparent optimizer, not the GEPA package implementation.
Prompt strings and a whitelisted prefix-only input format mutate.
Cohorts, labels, options and decoding stay fixed.
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import time
import urllib.request

from core import FORMATS, credential, digest, evaluate, load_rows, request, save, verify_dataset


def dominates(a, b):
    keys = ("trace_macro_mae_pp", "eta_log_mae")
    return all(a[k] <= b[k] for k in keys) and any(a[k] < b[k] for k in keys)


def joint_loss(metrics, baseline):
    """Equal-weight, baseline-normalized error: no units dominate the sum."""
    if metrics.get("failed") or metrics.get("eta_log_mae") is None:
        return float("inf")
    return .5 * (metrics["trace_macro_mae_pp"] / baseline["trace_macro_mae_pp"] +
                 metrics["eta_log_mae"] / baseline["eta_log_mae"])


def feedback(rows, traces, results, prompt):
    source = {r["example_id"]: r for r in rows}
    valid = [r for r in results["rows"] if r.get("ok")]
    selected = []
    for kind in sorted({r["kind"] for r in valid}):
        options = [r for r in valid if r["kind"] == kind]
        selected.extend(sorted(options, key=lambda r: r["progress_error"], reverse=True)[:3])
        eta_options = [r for r in options if r["eta_log_error"] is not None]
        selected.extend(sorted(eta_options, key=lambda r: r["eta_log_error"], reverse=True)[:3])
        selected.extend(sorted(options, key=lambda r: r["progress_error"])[:1])
    selected = list({r["example_id"]: r for r in selected}.values())
    examples = []
    for result in selected:
        row = source[result["example_id"]]
        state = request(row, traces[row["trace_id"]], prompt)["state"]
        history = state["history"]
        examples.append({"kind": result["kind"], "goal": state["goal"][:1600],
                         "output_schema": state["output_schema"],
                         "observed_batches": state["observed_batches"],
                         "recent_observations": str(history[-5:])[:9000],
                         "result": {k: result[k] for k in ("actual_progress", "predicted_progress",
                            "remaining_actual", "remaining_predicted", "eta_actual", "eta_predicted", "eta_log_error")}})
    return {"metrics": results["metrics"], "examples": examples}


def reflect(parent, packet, focus, output):
    schema = {"type": "object", "properties": {key: {"type": "string"} for key in
              ("scope", "progress", "eta", "rationale")},
              "required": ["scope", "progress", "eta", "rationale", "input_format"], "additionalProperties": False}
    schema["properties"]["input_format"] = {"type": "string", "enum": list(FORMATS)}
    messages = [
        {"role": "system", "content":
         "You improve JEV inputs and decision prompts using measured training failures. Return scope, progress, eta, rationale, input_format. "
         "JEV is a classifier with fixed options, not a generative planner. Keep instructions concrete, compact and generalizable. "
         "Change prompt text and choose input_format: history (structured observed events), timeline (JSON lines plus observed elapsed time and tool counts), "
         "compact (first 2 plus latest 8 events, elapsed time and tool counts). All use only the visible prefix. "
         "Do not change output bins, labels, decoding, cohort or metrics. "
         "No goal-specific answers, trace IDs or test-set knowledge. The task is predicting actual remaining issued tool-call batches "
         "of a completed agent trajectory, NOT the ideal amount of work to satisfy a task perfectly. Completion may occur with "
         "imperfect outcomes. At a terminal tool observation future issued batches can be zero. One parent spawn can perform "
         "a large child task, and child internal calls do not count as parent batches. Do not assume arbitrary constants or guarantee monotonicity. "
         "ETA is wall-clock to final verifier result, including observed waits; unseen future waits are inherently uncertain. "
         "Reflect only on provided TRAIN examples. Preserve successful behaviors while improving the requested focus. "
         "Progress and ETA have equal priority: minimize the mean of baseline-normalized trace-macro progress MAE "
         "and baseline-normalized mean absolute log1p-seconds ETA error. This is a joint objective. "
         "Study BOTH progress failures and time failures. Do not treat improving one as a reason to ignore the other. "
         "Each prompt field must be under 7000 characters."},
        {"role": "user", "content": json.dumps({"parent": parent, "focus": focus, "training_feedback": packet})}]
    body = {"model": "openai/gpt-6.1-sol", "messages": messages,
            "reasoning": {"effort": "low"}, "max_tokens": 4500,
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "jev_prompt_candidate", "strict": True, "schema": schema}}}
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + credential("OPENROUTER_API_KEY"),
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=150) as response:
        raw = json.load(response)
    candidate = json.loads(raw["choices"][0]["message"]["content"])
    if set(candidate) != set(schema["required"]) or any(not isinstance(v, str) or len(v) > 7000 for v in candidate.values()):
        raise ValueError("Reflector returned an invalid prompt candidate")
    if candidate["input_format"] not in FORMATS:
        raise ValueError("Invalid input format")
    save(output, {"request_model": body["model"], "actual_model": raw.get("model"),
                  "usage": raw.get("usage"), "candidate": candidate, "focus": focus})
    return {key: candidate[key] for key in ("scope", "progress", "eta", "input_format")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=8)
    parser.add_argument("--start-at", type=int, default=1)
    args = parser.parse_args()
    output = args.output
    cohorts = json.loads((output / "cohorts.json").read_text())
    verify_dataset(args.dataset, cohorts)
    all_train = load_rows(args.dataset / "train.jsonl.gz")
    train = [r for r in all_train if r["example_id"] in set(cohorts["train_ids"])]
    validation = [r for r in all_train if r["example_id"] in set(cohorts["validation_ids"])]
    traces = {t["trace_id"]: t for t in load_rows(args.dataset / "traces.jsonl.gz")}
    seed = {"name": "seed", "prompt": json.loads((output / "prompts/seed.json").read_text()),
            "train": json.loads((output / "train-baseline.json").read_text()),
            "validation": json.loads((output / "validation-baseline.json").read_text())}
    pool = [seed]
    winner = seed
    baseline_metrics = seed["validation"]["metrics"]
    # Resume with all measured previous candidates but re-rank under the newly
    # requested joint objective. Previously evaluated prompts are not mutated.
    for i in range(1, args.start_at):
        name = f"candidate-{i:02d}"
        paths = [output / "prompts" / (name + ".json"),
                 output / "evaluations" / (name + "-train.json"),
                 output / "evaluations" / (name + "-validation.json")]
        if all(path.exists() for path in paths):
            prompt, train_result, validation_result = [json.loads(path.read_text()) for path in paths]
            pool.append({"name": name, "prompt": prompt, "train": train_result, "validation": validation_result})
    winner = min(pool, key=lambda c: joint_loss(c["validation"]["metrics"], baseline_metrics))
    started = time.time()
    stale = 0
    for i in range(args.start_at, args.iterations + 1):
        frontier = [c for c in pool if not any(dominates(other["validation"]["metrics"], c["validation"]["metrics"])
                    for other in pool if other is not c)]
        parent = winner if i % 3 else min(frontier, key=lambda c: c["validation"]["metrics"]["eta_log_mae"])
        name = f"candidate-{i:02d}"
        prompt_file = output / "prompts" / (name + ".json")
        if prompt_file.exists():
            prompt = json.loads(prompt_file.read_text())
        else:
            focus = "Jointly reduce progress and ETA errors. Preserve terminal and parent/child progress gains, and fix ETA failures evidenced by the examples."
            if i % 3 == 0:
                focus = "Explore the ETA-strong Pareto parent. Jointly improve both errors, especially ETA over/underestimates, while preserving its working timing behavior."
            prompt = reflect(parent["prompt"], feedback(train, traces, parent["train"], parent["prompt"]),
                             focus, output / "reflections" / (name + ".json"))
            save(prompt_file, prompt)
        train_result = evaluate(train, traces, prompt, output)
        save(output / "evaluations" / (name + "-train.json"), train_result)
        # Full paired validation is evaluated with fixed IDs for every candidate.
        validation_result = evaluate(validation, traces, prompt, output)
        save(output / "evaluations" / (name + "-validation.json"), validation_result)
        candidate = {"name": name, "prompt": prompt, "train": train_result, "validation": validation_result}
        if validation_result["metrics"]["failed"]:
            raise RuntimeError("Candidate has evaluation failures; no promotion or altered denominator")
        pool.append(candidate)
        score = validation_result["metrics"]
        old_score = winner["validation"]["metrics"]
        promoted = joint_loss(score, baseline_metrics) < joint_loss(old_score, baseline_metrics)
        if promoted:
            winner = candidate
            stale = 0
        else:
            stale += 1
        save(output / "winner.json", {"name": winner["name"], "prompt": winner["prompt"],
                                       "validation_metrics": winner["validation"]["metrics"]})
        status = {"iteration": i, "candidate": name, "promoted": promoted, "winner": winner["name"],
                  "objective": "equal-weight normalized progress MAE + ETA log-time MAE",
                  "joint_loss": joint_loss(score, baseline_metrics),
                  "winner_joint_loss": joint_loss(winner["validation"]["metrics"], baseline_metrics),
                  "baseline": seed["validation"]["metrics"], "candidate_metrics": score,
                  "winner_metrics": winner["validation"]["metrics"], "elapsed_seconds": time.time() - started,
                  "candidate_count": len(pool), "phase": "mutation"}
        save(output / "status.json", status)
        print(json.dumps(status), flush=True)
        if stale >= 4:
            break
    # Merge independently successful components; evaluate under identical rules.
    eta_best = min(pool, key=lambda c: c["validation"]["metrics"]["eta_log_mae"])
    merged = {**winner["prompt"], "eta": eta_best["prompt"]["eta"]}
    if digest(merged) != digest(winner["prompt"]):
        result = evaluate(validation, traces, merged, output)
        save(output / "evaluations/merged-validation.json", result)
        save(output / "prompts/merged.json", merged)
        if joint_loss(result["metrics"], baseline_metrics) < joint_loss(winner["validation"]["metrics"], baseline_metrics):
            winner = {"name": "merged", "prompt": merged, "validation": result}
    save(output / "winner.json", {"name": winner["name"], "prompt": winner["prompt"],
                                   "validation_metrics": winner["validation"]["metrics"]})
    save(output / "status.json", {"phase": "complete", "winner": winner["name"], "candidate_count": len(pool),
                                   "objective": "equal-weight normalized progress MAE + ETA log-time MAE",
                                   "winner_joint_loss": joint_loss(winner["validation"]["metrics"], baseline_metrics),
                                   "elapsed_seconds": time.time() - started,
                                   "baseline": seed["validation"]["metrics"],
                                   "winner_metrics": winner["validation"]["metrics"]})
    print("OPTIMIZATION_COMPLETE", winner["name"], flush=True)


if __name__ == "__main__":
    main()
