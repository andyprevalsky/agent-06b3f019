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
import signal
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path


AGENTS_ROOT = Path(__file__).resolve().parent.parent
ROOT_DIR = AGENTS_ROOT.parent
TESTS_DIR = AGENTS_ROOT / "tests" / "blackbox"
# Whole verification domains include many independent native controls and run
# beside the other deployment coverage pools. This budget does not change any
# benchmark task timeout or its end-to-end allocation-to-release deadline.
DOMAIN_TIMEOUT_SECONDS = 1800

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
    domains = sorted(path.stem.replace(".blackbox", "").replace("_", "-") for path in TESTS_DIR.glob("*.blackbox.py"))
    # Affected-test selection (scripts/select_affected_tests.py --format
    # lane:agents-blackbox) may narrow the run; unset or empty runs every domain.
    selected = {d for d in os.environ.get("AGENTS_BLACKBOX_DOMAINS", "").replace(",", " ").split() if d}
    if selected:
        unknown = selected - set(domains)
        if unknown:
            raise ValueError(f"AGENTS_BLACKBOX_DOMAINS names unknown domain(s): {sorted(unknown)}")
        domains = [d for d in domains if d in selected]
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
    timeout_seconds = positive_int("AGENTS_COVERAGE_DOMAIN_TIMEOUT", DOMAIN_TIMEOUT_SECONDS)
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
            start_new_session=True,
        )
        communicate_task = asyncio.create_task(process.communicate())
        timed_out = False
        try:
            output, _ = await asyncio.wait_for(asyncio.shield(communicate_task), timeout=timeout_seconds)
        except asyncio.TimeoutError:
            timed_out = True
            # This session belongs only to the domain, including its browsers.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            output, _ = await communicate_task
            output += (f"\nTIMEOUT: domain {domain!r} exceeded {timeout_seconds}s\n").encode()
        except asyncio.CancelledError:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await communicate_task
            raise
    log_path.write_bytes(output)
    elapsed = time.monotonic() - started
    return DomainResult(
        domain=domain,
        passed=not timed_out and process.returncode == 0,
        duration_seconds=round(elapsed, 3),
        log=str(log_path.relative_to(ROOT_DIR)),
        exit_code=124 if timed_out else (process.returncode or 0),
    )


async def async_main() -> int:
    domains = discover_domains()
    partial = bool(os.environ.get("AGENTS_BLACKBOX_DOMAINS", "").strip())
    if not domains:
        print(f"No blackbox domains found in {TESTS_DIR}", file=sys.stderr)
        return 1

    concurrency = min(
        len(domains),
        positive_int("AGENTS_COVERAGE_CONCURRENCY", min(6, os.cpu_count() or 4)),
    )
    coverage_bin = Path(os.environ.get("COVERAGE_BIN", str(AGENTS_ROOT / "venv" / "bin" / "coverage")))
    if not coverage_bin.is_file():
        print(f"coverage executable not found: {coverage_bin}", file=sys.stderr)
        return 1

    run_id = f"agents-coverage-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}"
    artifact_dir = ROOT_DIR / ".context" / "test-runs" / run_id
    artifact_dir.mkdir(parents=True, exist_ok=True)
    print(f"Running {len(domains)} agents blackbox domains in {concurrency} isolated coverage processes")
    print(f"Artifacts: {artifact_dir}")
    if partial:
        print("Partial diagnostic scope: AGENTS_BLACKBOX_DOMAINS is set")

    semaphore = asyncio.Semaphore(concurrency)
    results: list[DomainResult] = []
    tasks = [asyncio.create_task(run_domain(domain, semaphore, coverage_bin, artifact_dir)) for domain in domains]
    try:
        for completed in asyncio.as_completed(tasks):
            result = await completed
            results.append(result)
            status = "PASS" if result.passed else "FAIL"
            print(f"  {status:<4} {result.domain:<30} {result.duration_seconds:>7.2f}s  {result.log}")
            if not result.passed:
                print((ROOT_DIR / result.log).read_text(errors="replace"))
    except asyncio.CancelledError:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise

    results.sort(key=lambda result: result.domain)
    failures = [result for result in results if not result.passed]
    summary = {
        "run_id": run_id,
        "partial": partial,
        "selected_domains": domains if partial else [],
        "concurrency": concurrency,
        "passed": len(domains) - len(failures),
        "failed": len(failures),
        "total": len(domains),
        "results": [asdict(result) for result in results],
    }
    (artifact_dir / "results.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Agents blackbox: {summary['passed']} passed, {summary['failed']} failed, {summary['total']} total")
    if failures:
        # Machine-readable terminal inventory excludes expected failures in
        # domain logs from the factory's stage classification.
        print("FACTORY_TEST_FAILURE " + json.dumps({
            "runner": "agents-blackbox-domains", "passed": summary["passed"],
            "failed": summary["failed"], "total": summary["total"],
            "failing": [result.domain for result in failures],
        }, sort_keys=True))
    return 1 if failures else 0


async def run_cli() -> int:
    loop = asyncio.get_running_loop()
    main_task = asyncio.create_task(async_main())
    received_signal = None

    def stop(signum: int) -> None:
        nonlocal received_signal
        if received_signal is None:
            received_signal = signum
            main_task.cancel()

    for signum in (signal.SIGTERM, signal.SIGHUP):
        loop.add_signal_handler(signum, stop, signum)
    try:
        return await main_task
    except asyncio.CancelledError:
        if received_signal is None:
            raise
        return 128 + received_signal
    finally:
        for signum in (signal.SIGTERM, signal.SIGHUP):
            loop.remove_signal_handler(signum)


def main() -> None:
    try:
        exit_code = asyncio.run(run_cli())
    except ValueError as error:
        print(error, file=sys.stderr)
        exit_code = 2
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
