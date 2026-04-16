"""Result serialization, storage, and comparison for benchmark runs."""

import json
import os
import uuid
from datetime import datetime, timezone
from dataclasses import dataclass, field, asdict
from typing import List, Optional


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
    failure_reason: Optional[str] = None
    approvals_triggered: int = 0
    approvals_resolved: int = 0
    context_violations: List[dict] = field(default_factory=list)  # [{rule, severity, message}]
    logs: Optional[dict] = None  # {messages, backend_logs, worker_logs, research_logs}


@dataclass
class BenchmarkRun:
    run_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    suite: str = "all"
    base_url: str = ""
    task_results: List[TaskResult] = field(default_factory=list)

    @property
    def summary(self) -> dict:
        total = len(self.task_results)
        skipped = sum(1 for r in self.task_results if r.status == "SKIPPED")
        passed = sum(1 for r in self.task_results if r.passed)
        failed = total - passed - skipped
        eligible = total - skipped
        total_cost = sum(r.cost_cents for r in self.task_results)
        total_duration = sum(r.duration_seconds for r in self.task_results)
        result = {
            "total": total,
            "passed": passed,
            "failed": failed,
            "total_cost_cents": round(total_cost, 2),
            "total_duration_seconds": round(total_duration, 1),
            "pass_rate": round(passed / eligible, 2) if eligible > 0 else 0.0,
        }
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
            "tasks": [asdict(r) for r in self.task_results],
        }

    def save(self, directory: str = None) -> str:
        if directory is None:
            directory = os.path.join(os.path.dirname(__file__), "runs")
        os.makedirs(directory, exist_ok=True)

        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        filename = f"{ts}_{self.suite}.json"
        path = os.path.join(directory, filename)

        with open(path, "w") as f:
            json.dump(self.to_dict(), f, indent=2)

        return path

    @staticmethod
    def load(path: str) -> "BenchmarkRun":
        with open(path) as f:
            data = json.load(f)
        run = BenchmarkRun(
            run_id=data["run_id"],
            timestamp=data["timestamp"],
            suite=data["suite"],
            base_url=data["base_url"],
        )
        for t in data["tasks"]:
            run.task_results.append(TaskResult(**t))
        return run


def compare_runs(path_a: str, path_b: str) -> None:
    a = BenchmarkRun.load(path_a)
    b = BenchmarkRun.load(path_b)

    print(f"\n{'='*70}")
    print(f"Benchmark Comparison")
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
