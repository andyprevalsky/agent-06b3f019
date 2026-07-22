#!/usr/bin/env python3
"""Run agents blackbox domains in bounded, isolated coverage subprocesses.

Every domain gets a fresh interpreter because domain modules mutate process-
global capture and mock state. The bounded worker pool changes scheduling only:
it still executes every discovered domain and emits parallel coverage data for
run-coverage.sh to combine.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path


AGENTS_ROOT = Path(__file__).resolve().parent.parent
ROOT_DIR = AGENTS_ROOT.parent
TESTS_DIR = AGENTS_ROOT / "tests" / "blackbox"

# Start the measured long poles together so a 27-second domain is not left at
# the tail of an otherwise-drained worker pool. This changes scheduling only.
LONG_DOMAIN_ORDER = (
    "workflow",
    "benchmark",
    "predeploy-metrics",
    "spawn-browser-agent-v3",
    "llm",
    "rose",
    "rose-browser-use",
    "prompt-invariants",
)

@dataclass
class DomainResult:
    domain: str
    passed: bool
    duration_seconds: float
    log: str
    exit_code: int


def discover_domains() -> list[str]:
    domains = sorted(
        path.stem.replace(".blackbox", "").replace("_", "-")
        for path in TESTS_DIR.glob("*.blackbox.py")
    )
    priority = {domain: index for index, domain in enumerate(LONG_DOMAIN_ORDER)}
    return sorted(domains, key=lambda domain: (priority.get(domain, len(priority)), domain))


def positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be a positive integer, got {raw!r}") from error
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer, got {raw!r}")
    return value


async def run_domain(
    domain: str,
    semaphore: asyncio.Semaphore,
    coverage_bin: Path,
    artifact_dir: Path,
) -> DomainResult:
    log_path = artifact_dir / f"{domain}.log"
    child_artifact_dir = artifact_dir / domain
    child_artifact_dir.mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "BLACKBOX_TEST_ARTIFACT_DIR": str(child_artifact_dir),
        "BLACKBOX_TEST_CAPTURE_OUTBOUND": "1",
    }
    async with semaphore:
        started = time.monotonic()
        process = await asyncio.create_subprocess_exec(
            str(coverage_bin),
            "run",
            "--parallel-mode",
            "scripts/run_blackbox_tests.py",
            domain,
            cwd=AGENTS_ROOT,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        output, _ = await process.communicate()
    log_path.write_bytes(output)
    elapsed = time.monotonic() - started
    return DomainResult(
        domain=domain,
        passed=process.returncode == 0,
        duration_seconds=round(elapsed, 3),
        log=str(log_path.relative_to(ROOT_DIR)),
        exit_code=process.returncode or 0,
    )


async def async_main() -> int:
    domains = discover_domains()
    if not domains:
        print(f"No blackbox domains found in {TESTS_DIR}", file=sys.stderr)
        return 1

    concurrency = min(
        len(domains),
        positive_int("AGENTS_COVERAGE_CONCURRENCY", min(6, os.cpu_count() or 4)),
    )
    coverage_bin = Path(
        os.environ.get("COVERAGE_BIN", str(AGENTS_ROOT / "venv" / "bin" / "coverage"))
    )
    if not coverage_bin.is_file():
        print(f"coverage executable not found: {coverage_bin}", file=sys.stderr)
        return 1

    run_id = f"agents-coverage-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}"
    artifact_dir = ROOT_DIR / ".context" / "test-runs" / run_id
    artifact_dir.mkdir(parents=True, exist_ok=True)
    print(
        f"Running {len(domains)} agents blackbox domains "
        f"in {concurrency} isolated coverage processes"
    )
    print(f"Artifacts: {artifact_dir}")

    semaphore = asyncio.Semaphore(concurrency)
    results: list[DomainResult] = []
    tasks = [
        run_domain(domain, semaphore, coverage_bin, artifact_dir)
        for domain in domains
    ]
    for completed in asyncio.as_completed(tasks):
        result = await completed
        results.append(result)
        status = "PASS" if result.passed else "FAIL"
        print(
            f"  {status:<4} {result.domain:<30} "
            f"{result.duration_seconds:>7.2f}s  {result.log}"
        )
        if not result.passed:
            print((ROOT_DIR / result.log).read_text(errors="replace"))

    results.sort(key=lambda result: result.domain)
    failures = [result for result in results if not result.passed]
    summary = {
        "run_id": run_id,
        "concurrency": concurrency,
        "passed": len(domains) - len(failures),
        "failed": len(failures),
        "total": len(domains),
        "results": [asdict(result) for result in results],
    }
    (artifact_dir / "results.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(
        f"Agents blackbox: {summary['passed']} passed, {summary['failed']} failed, "
        f"{summary['total']} total"
    )
    return 1 if failures else 0


def main() -> None:
    try:
        exit_code = asyncio.run(async_main())
    except ValueError as error:
        print(error, file=sys.stderr)
        exit_code = 2
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
