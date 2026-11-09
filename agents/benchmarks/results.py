"""Result serialization, storage, and comparison for benchmark runs."""

import hashlib
import json
import os
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import List, Optional

# POSIX NAME_MAX. A run record is named after every task in the suite, so a
# large slice runs straight past it: the 9-task ecommerce slice produced a
# 268-byte basename and `save()` died with `OSError: [Errno 63] File name too
# long` AFTER the whole run had executed, destroying the record and — because
# the write precedes `_record_history()` — the attempts and duration ledgers
# with it. Bound the name instead of losing the run.
MAX_RUN_RECORD_BASENAME_BYTES = 255


def bounded_path_component(value: str, *, suffix: str = "", identity: str | None = None) -> str:
    """Append a suffix without exceeding POSIX ``NAME_MAX``.

    The digest preserves uniqueness when the readable prefix must be shortened.
    ``identity`` lets callers hash the full logical value rather than a derived
    filename while keeping the resulting component deterministic.
    """
    candidate = f"{value}{suffix}"
    if len(candidate.encode()) <= MAX_RUN_RECORD_BASENAME_BYTES:
        return candidate

    digest = hashlib.sha256((identity or candidate).encode()).hexdigest()[:12]
    stable_suffix = f"+{digest}{suffix}"
    budget = MAX_RUN_RECORD_BASENAME_BYTES - len(stable_suffix.encode())
    trimmed = value.encode()[:budget].decode("utf-8", errors="ignore")
    return f"{trimmed}{stable_suffix}"


def run_record_basename(timestamp: str, suite: str) -> str:
    """Name the run record without ever exceeding the filesystem's limit.

    The untruncated suite always survives inside the JSON (`to_dict`), so the
    only thing shortened is the filename. A digest of the full suite is appended
    so two long slices that share a prefix cannot collapse onto one record.
    """
    return bounded_path_component(f"{timestamp}_{suite}", suffix=".json", identity=suite)


@dataclass
class TaskResult:
    name: str
    passed: bool
    agent_id: str
    status: str
    progress_score: float
    duration_seconds: float
    cost_cents: float
    message_count: int
    owned_roots: list[dict] = field(default_factory=list)
    graded_root_creation_outcome: Optional[str] = None
    # False only when the runner's custody proves no root-creation request (graded,
    # fixture first run or Codex) was ever issued; None means it was not tracked.
    root_creation_attempted: Optional[bool] = None
    failure_reason: Optional[str] = None
    # Task-specific measurements recorded on passes AND failures so the two are
    # comparable (e.g. the FCaptcha score, detections and browser session).
    evaluator_evidence: Optional[dict] = None
    approvals_triggered: int = 0
    approvals_resolved: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_hit_pct: float = 0.0
    # Prompt-cache share over cache-sequenced calls (llm_usage.aggregate_prompt_cache_share).
    prompt_cache_read_input_tokens: int = 0
    prompt_cache_creation_input_tokens: int = 0
    prompt_cache_uncached_input_tokens: int = 0
    prompt_cache_share_pct: float = 0.0
    prompt_cache_call_count: int = 0
    # Cache lanes that served the sequenced calls (llm_usage.cache_route); selects the floor.
    prompt_cache_routes: list[str] = field(default_factory=list)
    # Pre-run static-prefix warmup receipt (benchmarks.cache_warmup); never part of the share.
    prompt_cache_warmup: Optional[dict] = None
    llm_call_count: int = 0
    tree_agent_count: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    llm_usage_by_provider: dict = field(default_factory=dict)
    stop_metadata: Optional[dict] = None
    fast_mode_cache_enabled: bool = False
    context_violations: List[dict] = field(default_factory=list)  # [{rule, severity, message}]
    logs: Optional[dict] = None  # {messages, backend_logs, worker_logs, research_logs}
    archive_manifest_ref: Optional[str] = None
    payment_lifecycle: Optional[dict] = None
    world_model_fidelity: Optional[dict] = None
    world_model_mode: Optional[str] = None
    wmh_initial_state: Optional[dict] = None  # scenario seed hash, provenance, and seeded session id
    # Agent lifecycle status is a snapshot (for example PAUSED after a passed
    # abandonment check), not the evaluator or harness outcome.
    benchmark_status: Optional[str] = None
    # Post-verdict owned-resource cleanup that could not be verified (provider
    # sessions, payments). A harness/cleanup failure of the run: it fails CI and the
    # owned batch, but never rewrites the evaluator's verdict above.
    cleanup_failure: Optional[str] = None


@dataclass
class BenchmarkRun:
    run_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    suite: str = "all"
    base_url: str = ""
    task_results: List[TaskResult] = field(default_factory=list)
    memory_summary: Optional[dict] = None
    world_model_retrieval_audit: Optional[dict] = None

    @property
    def summary(self) -> dict:
        total = len(self.task_results)
        skipped = sum(1 for r in self.task_results if r.status == "SKIPPED")
        passed = sum(1 for r in self.task_results if r.passed)
        failed = total - passed - skipped
        eligible = total - skipped
        total_cost = sum(r.cost_cents for r in self.task_results)
        total_duration = sum(r.duration_seconds for r in self.task_results)
        agg_cache_read = sum(r.cache_read_input_tokens for r in self.task_results)
        agg_cache_write = sum(r.cache_creation_input_tokens for r in self.task_results)
        agg_cache_total = agg_cache_read + agg_cache_write
        agg_cache_hit_pct = round(agg_cache_read / agg_cache_total * 100, 1) if agg_cache_total > 0 else 0.0
        scored_world_model = [
            r.world_model_fidelity
            for r in self.task_results
            if isinstance(r.world_model_fidelity, dict)
            and r.world_model_fidelity.get("status") == "scored"
            and isinstance(r.world_model_fidelity.get("mean_score"), (int, float))
        ]
        result = {
            "total": total,
            "passed": passed,
            "failed": failed,
            "cleanup_failures": sum(1 for r in self.task_results if getattr(r, "cleanup_failure", None)),
            "total_cost_cents": round(total_cost, 2),
            "total_duration_seconds": round(total_duration, 1),
            "pass_rate": round(passed / eligible, 2) if eligible > 0 else 0.0,
            "cache_read_input_tokens": agg_cache_read,
            "cache_creation_input_tokens": agg_cache_write,
            "cache_hit_pct": agg_cache_hit_pct,
        }
        from benchmarks.llm_usage import merge_usage_breakdowns

        result["llm_usage_by_provider"] = merge_usage_breakdowns(
            r.llm_usage_by_provider for r in self.task_results
        )
        if scored_world_model:
            result["wmh_scored_tasks"] = len(scored_world_model)
            result["wmh_prediction_accuracy"] = round(
                sum(float(report["mean_score"]) for report in scored_world_model) / len(scored_world_model),
                3,
            )
        if skipped > 0:
            result["skipped"] = skipped
        return result

    def to_dict(self) -> dict:
        return {
            "run_id": self.run_id,
            "timestamp": self.timestamp,
            "suite": self.suite,
            "base_url": self.base_url,
            "summary": self.summary,
            "memory_summary": self.memory_summary,
            "world_model_retrieval_audit": self.world_model_retrieval_audit,
            "tasks": [asdict(r) for r in self.task_results],
        }

    def save(self, directory: str = None) -> str:
        if any(r.benchmark_status == "UNSCORED" or (r.stop_metadata or {}).get("purpose") == "owned_recording_preparation"
               for r in self.task_results):
            raise ValueError("Unscored preparation cannot enter benchmark results, history or eligibility")
        if directory is None:
            directory = os.path.join(os.path.dirname(__file__), "runs")
        os.makedirs(directory, exist_ok=True)

        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        # Concurrent occurrences of the same task can finish in one second.
        # Bind the record to this run before applying the existing name bound.
        filename = run_record_basename(f"{ts}_{self.run_id}", self.suite)
        path = os.path.join(directory, filename)

        with open(path, "w") as f:
            json.dump(self.to_dict(), f, indent=2)

        self._record_history()
        self._upload_to_hub()

        return path

    def _upload_to_hub(self) -> None:
        """Push the terminal bundle to the in-app Benchmark Hub.

        CLI benchmark runs set BENCHMARK_HUB_REQUIRED after their fail-closed
        startup registration. Fleet children carry BENCHMARK_HUB_PARENT_RUN_ID
        and leave aggregation/upload to that already-visible parent run.

        When the fail-closed Hub is an ephemeral localhost stack, also mirror
        the terminal bundle to the always-on production Hub so
        ``roselabs.ai/open-agent`` remains reachable after teardown.
        """
        if os.getenv("BENCHMARK_HUB_PARENT_RUN_ID"):
            return
        required = os.getenv("BENCHMARK_HUB_REQUIRED") == "1"
        try:
            from benchmarks.hub_upload import (
                hub_upload_enabled,
                mirror_run_bundle_to_durable_hub,
                print_durable_agent_links,
                upload_run_bundle,
            )
        except Exception as e:
            if required:
                raise
            print(f"⚠️  hub upload import failed (non-fatal): {e}")
            return
        if not required and not hub_upload_enabled():
            return
        bundle = self.to_dict()
        upload_run_bundle(bundle, required=required)
        try:
            mirror_run_bundle_to_durable_hub(bundle)
        except Exception as e:
            # Cloud agents raise HubVisibilityError from the mirror helper;
            # local /deploy must not die on a prod outage during mirror.
            if required and os.getenv("CURSOR_AGENT"):
                raise
            print(f"⚠️  durable hub mirror failed (non-fatal): {e}")
        print_durable_agent_links(bundle)

    def _record_history(self) -> None:
        """Record run stats for every completed task, plus pass-only corpora.

        Every attempt (pass or fail, local or prod) lands in the attempts
        ledger; passes additionally feed the timeout-derivation corpus and
        span-latency baselines. Best-effort, per-task: history recording must
        never fail save() after the results JSON has already been written, and
        one task's failure must not prevent subsequent tasks from being
        recorded.
        """
        def emit_history_diagnostic(message):
            try:
                print(message)
            except BrokenPipeError:
                pass  # Diagnostic delivery must not interrupt best-effort ledger writes.

        try:
            from benchmarks.timeout_history import record_attempt, record_pass
        except Exception as e:
            emit_history_diagnostic(f"⚠️  _record_history import failed (non-fatal): {e}")
            return
        try:
            from benchmarks.agent_latency import record_span_history_from_logs
        except Exception as e:
            record_span_history_from_logs = None
            emit_history_diagnostic(f"⚠️  span-history import failed (non-fatal): {e}")

        environment = "local" if "localhost" in self.base_url or "127.0.0.1" in self.base_url else "prod"
        for r in self.task_results:
            if r.status == "SKIPPED":
                continue
            # Full trajectories for each attempt are already persisted in this
            # run's JSON (messages + logs) and .llm-dumps/<agent_id>/ locally.
            try:
                record_attempt(
                    task_name=r.name,
                    passed=r.passed,
                    status=r.status,
                    duration_seconds=r.duration_seconds,
                    cost_cents=r.cost_cents,
                    agent_id=r.agent_id,
                    failure_reason=r.failure_reason,
                    fast_mode_cache_enabled=r.fast_mode_cache_enabled,
                    timestamp=self.timestamp,
                    # Prefer explicit BENCHMARK_ATTEMPT_SUITE (predeploy scripts)
                    # so worktree smoke cannot invalidate canary eligibility.
                    suite=os.environ.get("BENCHMARK_ATTEMPT_SUITE") or self.suite,
                    run_id=self.run_id,
                    outcome_class=("cleanup-failure" if r.cleanup_failure else "passed" if r.passed else "failed"),
                    evaluator_evidence=r.evaluator_evidence,
                )
            except Exception as e:
                emit_history_diagnostic(f"⚠️  record_attempt failed for {r.name} (non-fatal): {e}")
            if not r.passed:
                continue
            if r.fast_mode_cache_enabled:
                emit_history_diagnostic(f"    Timeout history skipped for {r.name}: fast mode cache was enabled")
            else:
                try:
                    record_pass(
                        task_name=r.name,
                        duration_seconds=r.duration_seconds,
                        cost_cents=r.cost_cents,
                        agent_id=r.agent_id,
                        timestamp=self.timestamp,
                    )
                except Exception as e:
                    emit_history_diagnostic(f"⚠️  _record_history failed for {r.name} ({r.agent_id}) (non-fatal): {e}")
            try:
                if record_span_history_from_logs and r.logs:
                    count = record_span_history_from_logs(
                        agent_id=r.agent_id,
                        logs=r.logs,
                        benchmark=r.name,
                        environment=environment,
                        timestamp=self.timestamp,
                        run_status="passed",
                    )
                    if count:
                        emit_history_diagnostic(f"    Span history recorded: {count} spans for {r.name}")
            except Exception as e:
                emit_history_diagnostic(f"⚠️  span-history recording failed for {r.name} ({r.agent_id}) (non-fatal): {e}")

    @staticmethod
    def load(path: str) -> "BenchmarkRun":
        with open(path) as f:
            data = json.load(f)
        run = BenchmarkRun(
            run_id=data["run_id"],
            timestamp=data["timestamp"],
            suite=data["suite"],
            base_url=data["base_url"],
            memory_summary=data.get("memory_summary"),
        )
        task_result_fields = set(TaskResult.__dataclass_fields__)
        for t in data["tasks"]:
            filtered = {key: value for key, value in t.items() if key in task_result_fields}
            run.task_results.append(TaskResult(**filtered))
        return run


def compare_runs(path_a: str, path_b: str) -> None:
    a = BenchmarkRun.load(path_a)
    b = BenchmarkRun.load(path_b)

    print(f"\n{'='*70}")
    print("Benchmark Comparison")
    print(f"  A: {os.path.basename(path_a)} ({a.timestamp[:19]})")
    print(f"  B: {os.path.basename(path_b)} ({b.timestamp[:19]})")
    print(f"{'='*70}")

    sa, sb = a.summary, b.summary
    print(f"\n{'Metric':<25} {'Run A':>10} {'Run B':>10} {'Delta':>10}")
    print(f"{'-'*55}")
    print(f"{'Pass rate':<25} {sa['pass_rate']:>9.0%} {sb['pass_rate']:>9.0%} {sb['pass_rate']-sa['pass_rate']:>+9.0%}")
    print(f"{'Passed':<25} {sa['passed']:>10} {sb['passed']:>10} {sb['passed']-sa['passed']:>+10}")
    print(f"{'Failed':<25} {sa['failed']:>10} {sb['failed']:>10} {sb['failed']-sa['failed']:>+10}")
    print(f"{'Cost (cents)':<25} {sa['total_cost_cents']:>10.1f} {sb['total_cost_cents']:>10.1f} {sb['total_cost_cents']-sa['total_cost_cents']:>+10.1f}")
    print(f"{'Duration (s)':<25} {sa['total_duration_seconds']:>10.1f} {sb['total_duration_seconds']:>10.1f} {sb['total_duration_seconds']-sa['total_duration_seconds']:>+10.1f}")

    # Per-task diff
    a_tasks = {r.name: r for r in a.task_results}
    b_tasks = {r.name: r for r in b.task_results}
    all_names = sorted(set(list(a_tasks.keys()) + list(b_tasks.keys())))

    print(f"\n{'Task':<25} {'A':>8} {'B':>8} {'A cost':>8} {'B cost':>8} {'A dur':>7} {'B dur':>7}")
    print(f"{'-'*72}")
    for name in all_names:
        ra = a_tasks.get(name)
        rb = b_tasks.get(name)
        a_pass = "SKIP" if ra and ra.status == "SKIPPED" else ("PASS" if ra and ra.passed else ("FAIL" if ra else "-"))
        b_pass = "SKIP" if rb and rb.status == "SKIPPED" else ("PASS" if rb and rb.passed else ("FAIL" if rb else "-"))
        a_cost = f"{ra.cost_cents:.1f}" if ra else "-"
        b_cost = f"{rb.cost_cents:.1f}" if rb else "-"
        a_dur = f"{ra.duration_seconds:.0f}s" if ra else "-"
        b_dur = f"{rb.duration_seconds:.0f}s" if rb else "-"
        marker = ""
        if ra and rb and ra.passed != rb.passed:
            marker = " !!!"
        print(f"{name:<25} {a_pass:>8} {b_pass:>8} {a_cost:>8} {b_cost:>8} {a_dur:>7} {b_dur:>7}{marker}")

    print()
