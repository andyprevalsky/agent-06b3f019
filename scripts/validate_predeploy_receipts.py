#!/usr/bin/env python3
"""Read-only policy projection over explicit terminal smoke receipts.

Confirmations are trusted operator-reviewed evidence, not inferred from logs.
They bind one nonpassing task to immutable producer bytes and its exact reason.
This tool cannot establish that a provider is exhausted; it validates a supplied
confirmation and never changes the original verdict or receipt.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from datetime import datetime
from pathlib import Path

RESOURCE_CODES = frozenset({"billing_credit_exhausted", "compute_quota_exhausted", "storage_capacity_exhausted"})


# These are explicit standing decisions, separate from RESOURCE_CODES. A native
# SKIPPED receipt does not establish billing, credential validity or pool cause.
# Producer contracts: run_benchmark.py _is_permitted_claude_code_skip and
# _is_permitted_compute_token_skip; the owning regression checks their literals.
CLAUDE_CREDENTIAL_REASON = "Claude Code credentials unavailable: no synced Claude token and no available pool token"
COMPUTE_TOKEN_SKIP_PREFIX = "Compute token pool exhausted or cooling down"
STANDING_POLICIES = {
    "standing_claude_credential_unavailable": (
        "native_credential", "Anthropic", ".claude/commands/deploy.md",
    ),
    "standing_compute_token_unavailable": (
        "shared_compute_pool", "OpenAI shared compute-token pool",
        "docs/rca/cases/2026-10-25-benchmark-judge-compute-token-unavailable-classified-infra.md",
    ),
}


def standing_skip_policy(proof, original, display, source, planned_source):
    """Validate an explicitly reviewed standing skip, never infer its cause."""
    policy = STANDING_POLICIES.get(proof.get("reason_code"))
    if (policy is None or (proof.get("resource_scope"), proof.get("provider")) != policy[:2]
            or policy[2] not in proof["evidence"]
            or original.get("status") != "SKIPPED" or original.get("benchmark_status") != "SKIPPED"
            or display.get("status") != "skipped" or source != planned_source):
        return None
    reason = original["failure_reason"]
    if proof["reason_code"] == "standing_claude_credential_unavailable":
        # Match the producer's catalog-scoped Claude preflight contract. A funded
        # API key or an arbitrary authentication failure cannot satisfy it.
        catalog = strict_json((Path(__file__).resolve().parents[1] / "agents/benchmarks/tasks.json").read_text())
        if reason != CLAUDE_CREDENTIAL_REASON or not any(
                task.get("name") == original["name"] and task.get("requires_claude_code") is True
                for task in catalog):
            return None
    elif not reason.startswith(COMPUTE_TOKEN_SKIP_PREFIX + ": "):
        return None
    return policy[2]


def strict_json(value):
    def reject_constant(constant):
        raise ValueError("non-finite JSON constant")
    def parse_finite_float(token):
        result = float(token)
        if not math.isfinite(result):
            raise ValueError("non-finite JSON number")
        return result
    return json.loads(value, parse_constant=reject_constant, parse_float=parse_finite_float)


def finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _validate(summary, bundles, confirmations, bindings, wrapper_explanation=None, wrapper_observation=None):
    problems, warnings, rows = [], [], []
    planned = summary.get("tasks")
    if not isinstance(summary.get("run_id"), str) or not summary["run_id"].strip():
        problems.append("invalid planned run identity")
    source_sha = summary.get("git_sha")
    if not isinstance(source_sha, str) or len(source_sha) != 40 or any(c not in "0123456789abcdef" for c in source_sha):
        problems.append("invalid planned source identity")
    if (not isinstance(planned, list) or not planned or
            any(not isinstance(n, str) or not n.strip() for n in planned) or
            len(set(planned)) != len(planned)):
        problems.append("invalid or duplicate planned tasks")
        planned = []
    exit_code = summary.get("exit_code")
    if type(exit_code) is not int or not 0 <= exit_code < 126:
        problems.append("unknown, command-failure or signal original smoke process exit")
    binding_map = {}
    for binding in bindings:
        identity = binding.get("run_id")
        if not isinstance(identity, str) or identity in binding_map:
            problems.append("invalid or duplicate plan/run binding")
            continue
        binding_map[identity] = binding
    bound = set()
    indexed_confirmations = {}
    for proof in confirmations:
        key = (proof.get("run_id"), proof.get("task"))
        if not all(isinstance(v, str) and v for v in key) or key in indexed_confirmations:
            problems.append("invalid or duplicate resource confirmation")
            continue
        indexed_confirmations[key] = proof
    used = set()
    seen = set()
    for bundle in bundles:
        run, card = bundle["run"], bundle["card"]
        raw, displayed = run.get("tasks"), card.get("per_task")
        run_id = run.get("run_id")
        if not isinstance(run_id, str) or card.get("run_id") != run_id:
            problems.append("run identity mismatch")
            continue
        binding = binding_map.get(run_id)
        if (binding is None or binding.get("plan_run_id") != summary.get("run_id")
                or binding.get("receipt_sha256") != bundle["sha256"]
                or binding.get("card_sha256") != bundle["card_sha256"]
                or binding.get("planned_source_sha") != summary.get("git_sha")):
            problems.append("missing or mismatched immutable plan/run binding")
            continue
        bound.add(run_id)
        try:
            plan_start = datetime.fromisoformat(summary["started_at"]).timestamp()
            plan_end = datetime.fromisoformat(summary["finished_at"]).timestamp()
            raw_start = datetime.fromisoformat(run["timestamp"]).timestamp()
            if not (plan_start <= raw_start <= card["finished_at"] <= plan_end):
                problems.append("run timestamps outside plan")
        except (KeyError, ValueError, TypeError, ArithmeticError, OSError):
            problems.append("unknown plan/run timestamps")
        if bundle.get("cleanup_verified") is not True:
            problems.append("run or stack cleanup unverified")
        if not finite(card.get("finished_at")) or not finite(card.get("started_at")) or card["finished_at"] < card["started_at"]:
            problems.append("missing or invalid terminal timestamp")
            continue
        inventory = card.get("tasks", {})
        if (not isinstance(raw, list) or not raw or not isinstance(displayed, list)
                or len(displayed) != len(raw)
                or any(type(inventory.get(k)) is not int for k in ("total", "running", "completed", "queued"))
                or inventory != {"total": len(raw), "running": 0, "completed": len(raw), "queued": 0}):
            problems.append("incomplete terminal run inventory")
            continue
        displayed_by_name = {r.get("name"): r for r in displayed}
        if len(displayed_by_name) != len(displayed):
            problems.append("duplicate displayed task")
        source = card.get("source_sha")
        if source is not None and source != summary.get("git_sha"):
            problems.append("receipt source differs from planned source")
        for original in raw:
            name, status = original.get("name"), original.get("status")
            if not isinstance(name, str) or not isinstance(status, str):
                problems.append("invalid task name or status")
                continue
            if name in seen or name not in planned:
                problems.append("duplicate or unplanned terminal task")
            seen.add(name)
            display = displayed_by_name.get(name, {})
            row = {"task": name, "run_id": run_id, "original_status": status,
                   "original_passed": original.get("passed"), "original_reason": original.get("failure_reason"),
                   "source_sha": source, "source_verification": "unrecorded" if source is None else "matches_plan", "evidence": bundle["evidence"],
                   "receipt_sha256": bundle["sha256"], "finished_at": card.get("finished_at"),
                   "classification": "BLOCKED"}
            rows.append(row)
            if original.get("cleanup_failure"):
                problems.append("task cleanup failure: " + str(name))
                continue
            if (original.get("passed") is True and original.get("benchmark_status") == "PASSED"
                    and display.get("status") == "passed" and source == summary.get("git_sha")):
                # benchmark_status is the terminal evaluator verdict. status is
                # the native agent lifecycle (legitimately ACTIVE for chat-mode).
                row["classification"] = "PASS"
                continue
            key = (run_id, name)
            proof = indexed_confirmations.get(key)
            reason = original.get("failure_reason")
            if proof is not None:
                used.add(key)
            bound_confirmation = (proof is not None and original.get("passed") is False
                       and proof.get("receipt_sha256") == bundle["sha256"]
                       and isinstance(reason, str) and bool(reason.strip())
                       and proof.get("receipt_reason") == reason
                       and proof.get("exclusive_cause") is True
                       and isinstance(proof.get("provider"), str) and bool(proof["provider"].strip())
                       and isinstance(proof.get("evidence"), str) and bool(proof["evidence"].strip())
                       and finite(proof.get("confirmed_at")) and proof["confirmed_at"] >= card.get("finished_at", float('inf')))
            resource_allowed = (bound_confirmation
                       and status in {"SKIPPED", "FAILED", "ERROR", "INFRA_ERROR"}
                       and display.get("status") in {"skipped", "failed", "error", "infra_error", "infra-error"}
                       and proof.get("resource_scope") == "third_party"
                       and proof.get("reason_code") in RESOURCE_CODES)
            policy_source = (standing_skip_policy(proof, original, display, source, source_sha)
                             if bound_confirmation else None)
            allowed = resource_allowed or policy_source is not None
            if allowed:
                row["classification"] = "SKIPPED"
                row["exception_kind"] = "resource_exhaustion" if resource_allowed else "standing_policy"
                warnings.append({"test": name, "provider": proof["provider"], "reason": reason,
                                 "exception_kind": row["exception_kind"], "policy_source": policy_source,
                                 "reason_code": proof["reason_code"], "finished_at": card["finished_at"],
                                 "confirmed_at": proof["confirmed_at"], "evidence": proof["evidence"],
                                 "source_sha": source, "original_status": status})
            else:
                problems.append("unconfirmed or nonresource task failure: " + str(name))
    if bound != set(binding_map):
        problems.append("unused plan/run binding")
    if seen != set(planned):
        problems.append("terminal task coverage differs from exact plan")
    if used != set(indexed_confirmations):
        problems.append("unused resource confirmation")
    wrapper_warning = None
    if exit_code != 0:
        proof = wrapper_explanation or {}
        observation = wrapper_observation or {}
        cohort = sorted((b["run"]["run_id"], b["sha256"], b["card_sha256"]) for b in bundles)
        skipped = sorted((r["run_id"], r["task"]) for r in rows if r["classification"] == "SKIPPED")
        try:
            finished_epoch = datetime.fromisoformat(summary["finished_at"]).timestamp()
        except (TypeError, ValueError, KeyError, ArithmeticError, OSError):
            finished_epoch = float("inf")
        # The existing wrapper proof covers resource-only exits. Standing skips
        # cannot be relabelled as resource exhaustion to explain a nonzero exit.
        resource_only = all(r.get("exception_kind") == "resource_exhaustion"
                            for r in rows if r["classification"] == "SKIPPED")
        explained = (bool(skipped) and resource_only and not problems
                     and proof.get("kind") == "task_result_exit"
                     and proof.get("plan_run_id") == summary.get("run_id")
                     and type(proof.get("exit_code")) is int and proof["exit_code"] == exit_code
                     and proof.get("summary_sha256") == observation.get("summary_sha256")
                     and proof.get("runner_log_sha256") == observation.get("runner_log_sha256")
                     and all(isinstance(observation.get(k), str) and len(observation[k]) == 64
                             and all(c in "0123456789abcdef" for c in observation[k])
                             for k in ("summary_sha256", "runner_log_sha256"))
                     and proof.get("receipt_cohort") == [list(row) for row in cohort]
                     and proof.get("resource_tasks") == [list(row) for row in skipped]
                     and proof.get("exclusive_cause") is True
                     and proof.get("independent_failures") == []
                     and isinstance(proof.get("evidence"), str) and bool(proof["evidence"].strip())
                     and finite(proof.get("confirmed_at")) and proof["confirmed_at"] >= finished_epoch)
        if not explained:
            problems.append("nonzero wrapper exit lacks exact exclusive task-resource explanation")
        else:
            wrapper_warning = {"original_exit_code": exit_code, "reason": "confirmed resource-task exit",
                               "evidence": proof["evidence"], "confirmed_at": proof["confirmed_at"],
                               "runner_log_sha256": observation["runner_log_sha256"]}
    elif wrapper_explanation is not None:
        problems.append("unused nonzero wrapper explanation")
    verdict = "BLOCKED" if problems else "SKIPPED_WITH_WARNING" if warnings else "PASS"
    return {"schema_version": 1, "status": verdict, "original_summary_status": summary.get("status"),
            "original_exit_code": summary.get("exit_code"), "planned_source_sha": summary.get("git_sha"),
            "wrapper_warning": wrapper_warning, "planned_tasks": planned, "per_task": rows, "warnings": warnings, "problems": problems,
            "counts": {"passed": sum(r["classification"] == "PASS" for r in rows),
                       "skipped": sum(r["classification"] == "SKIPPED" for r in rows),
                       "blocked": sum(r["classification"] == "BLOCKED" for r in rows)}}


def validate(summary, bundles, confirmations, bindings, wrapper_explanation=None, wrapper_observation=None):
    try:
        result = _validate(summary, bundles, confirmations, bindings, wrapper_explanation, wrapper_observation)
        # Direct callers can supply values that did not pass the JSON parser.
        json.dumps(result, allow_nan=False)
        return result
    except (TypeError, ValueError, KeyError, AttributeError, ArithmeticError, OSError):
        return {"status": "BLOCKED", "problems": ["malformed receipt structure"], "warnings": []}


def verify_cleanup(directory):
    """Join existing producer receipts by exact token and native birth identity."""
    def fields(path):
        rows = [line.split("=", 1) for line in path.read_text().splitlines()]
        if any(len(row) != 2 for row in rows) or len({row[0] for row in rows}) != len(rows):
            return {}
        return dict(rows)
    benchmark = strict_json((directory / "local-benchmark-owner.json").read_text())
    stack = strict_json((directory / "local-stack-owner.json").read_text())
    token = benchmark.get("token")
    if not isinstance(token, str) or not token.isalnum():
        return False
    receipt = fields(directory / ("benchmark-cleanup-" + token + ".status"))
    stack_receipt = fields(directory / "local-stack-cleanup.status")
    return (benchmark.get("run_id") == directory.name == stack.get("run_id")
            and benchmark.get("state") == "cleanup_verified"
            and receipt == {"version": "1", "token": token, "state": "clean"}
            and stack_receipt.get("version") == "2" and stack_receipt.get("state") == "clean"
            and isinstance(stack.get("token"), str) and bool(stack["token"])
            and stack_receipt.get("token") == stack["token"]
            and type(stack.get("pid")) is int and stack_receipt.get("stack_pid") == str(stack["pid"])
            and isinstance(stack.get("native_identity"), str) and bool(stack["native_identity"])
            and stack_receipt.get("stack_native_identity") == stack["native_identity"]
            and stack_receipt.get("stack_birth") == stack.get("birth"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path, action="append", required=True)
    parser.add_argument("--confirmations", type=Path, required=True)
    parser.add_argument("--bindings", type=Path, required=True)
    parser.add_argument("--wrapper-explanation", type=Path)
    args = parser.parse_args()
    try:
        bundles = []
        for directory in args.run_dir:
            raw = (directory / "run.json").read_bytes()
            card_raw = (directory / "report-card.json").read_bytes()
            bundles.append({"run": strict_json(raw), "card": strict_json(card_raw),
                            "card_sha256": hashlib.sha256(card_raw).hexdigest(),
                            "cleanup_verified": verify_cleanup(directory),
                            "sha256": hashlib.sha256(raw).hexdigest(), "evidence": str(directory / "run.json")})
        summary_bytes = args.summary.read_bytes()
        summary = strict_json(summary_bytes)
        explanation, observation = None, None
        if args.wrapper_explanation is not None:
            explanation = strict_json(args.wrapper_explanation.read_bytes())
            log_digest = hashlib.sha256()
            with Path(summary["runner_log"]).open("rb") as log:
                for chunk in iter(lambda: log.read(1024 * 1024), b""):
                    log_digest.update(chunk)
            observation = {"summary_sha256": hashlib.sha256(summary_bytes).hexdigest(),
                           "runner_log_sha256": log_digest.hexdigest()}
        result = validate(summary, bundles, strict_json(args.confirmations.read_text()),
                          strict_json(args.bindings.read_text()), explanation, observation)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, ArithmeticError) as exc:
        result = {"status": "BLOCKED", "problems": ["invalid or unreadable receipt input: " + type(exc).__name__], "warnings": []}
    try:
        output = json.dumps(result, indent=2, allow_nan=False)
    except (TypeError, ValueError, ArithmeticError):
        result = {"status": "BLOCKED", "problems": ["non-serializable receipt value"], "warnings": []}
        output = json.dumps(result, indent=2)
    print(output)
    return 1 if result["status"] == "BLOCKED" else 0


if __name__ == "__main__":
    raise SystemExit(main())
