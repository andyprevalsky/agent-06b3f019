#!/usr/bin/env python3
"""Run agents blackbox domains in bounded, isolated coverage subprocesses.

Every domain gets a fresh interpreter because domain modules mutate process-
global capture and mock state. The bounded worker pool changes scheduling only:
it still executes every discovered domain and emits parallel coverage data for
run-coverage.sh to combine.

A failed domain is rerun once, alone, on the same source (never a third run).
A passing rerun makes the domain FLAKY: the run passes, but the domain still
needs /RCA attribution (TEST_FLAKY line, FLAKY progress row). A second failure
is the normal FAIL. A domain timeout or a cancelled run is not rerun.

    domain ─fail─> rerun once ─pass─> FLAKY (exit 0, attribution required)
       │                     └─fail─> FAIL  (exit 1)
       └─pass─> PASS            timeout ─> FAIL, no rerun

Quarantined cases (scripts/lib/test_quarantine.py) write their rows to a
per-attempt file; this runner forwards the counted attempt's rows.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import time
from dataclasses import asdict, dataclass, replace
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


# Live per-domain rows for the gate's worker (scripts/deploy_gate_progress.py).
# Only this runner writes them: domains run without the variable, so a domain
# that exercises a runner with failing fixtures cannot report those fixtures as
# failures of the real gate.
PROGRESS_ENV = "DEPLOY_GATE_PROGRESS"
PROGRESS_HELPER_DIR = Path(__file__).resolve().parents[2] / "scripts"
QUARANTINE_HELPER_DIR = PROGRESS_HELPER_DIR / "lib"
QUARANTINE_ROWS = "quarantine.jsonl"
TIMEOUT_EXIT_CODE = 124


@dataclass
class DomainResult:
    domain: str
    passed: bool
    duration_seconds: float
    log: str
    exit_code: int
    attempts: int = 1
    flaky: bool = False
    # The first attempt's log when a rerun ran: the failure /RCA attributes.
    first_log: str = ""


def _import_script_helper(directory: Path, name: str):
    path = str(directory)
    sys.path.insert(0, path)
    try:
        return __import__(name)
    finally:
        sys.path.remove(path)


def forward_quarantine(result: DomainResult) -> list[str]:
    """Forward the counted attempt's quarantined-case rows; return their TEST_QUARANTINE lines."""
    try:
        quarantine = _import_script_helper(QUARANTINE_HELPER_DIR, "test_quarantine")
        rows = quarantine.forward(ROOT_DIR / result.log.removesuffix(".log") / QUARANTINE_ROWS,
                                  log=str(ROOT_DIR / result.log))
        return [quarantine.progress.stdout_line(row) for row in rows]
    except (ImportError, OSError, ValueError):
        return []


def report_progress(result: DomainResult, output: str) -> None:
    """Append one domain row to the worker's progress file, if it named one.

    Advisory: without the variable nothing is imported or written, and a
    missing helper or unwritable file never changes the result or output.
    """
    if not os.environ.get(PROGRESS_ENV):
        return
    try:
        deploy_gate_progress = _import_script_helper(PROGRESS_HELPER_DIR, "deploy_gate_progress")
        deploy_gate_progress.report(
            result.domain,
            status_of(result),
            scope="domain",
            detail="" if result.passed and not result.flaky else output,
            log=str(ROOT_DIR / (result.first_log if result.flaky else result.log)),
            attempts=result.attempts if result.flaky else None,
        )
    except (ImportError, OSError, ValueError):
        return


def status_of(result: DomainResult) -> str:
    if result.flaky:
        return "FLAKY"
    return "PASS" if result.passed else "FAIL"


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
    attempt: int = 1,
) -> DomainResult:
    name = domain if attempt == 1 else f"{domain}.rerun"
    log_path = artifact_dir / f"{name}.log"
    child_artifact_dir = artifact_dir / name
    child_artifact_dir.mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "BLACKBOX_TEST_ARTIFACT_DIR": str(child_artifact_dir),
        "BLACKBOX_TEST_CAPTURE_OUTBOUND": "1",
        # scripts/lib/test_quarantine.py: this attempt's quarantined-case rows, ids <domain>::<case>.
        "DEPLOY_GATE_QUARANTINE_PROGRESS": str(child_artifact_dir / QUARANTINE_ROWS),
        "DEPLOY_GATE_QUARANTINE_UNIT_PREFIX": domain,
    }
    env.pop(PROGRESS_ENV, None)
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
        exit_code=TIMEOUT_EXIT_CODE if timed_out else (process.returncode or 0),
    )


async def run_domain_with_rerun(
    domain: str,
    semaphore: asyncio.Semaphore,
    coverage_bin: Path,
    artifact_dir: Path,
) -> DomainResult:
    """One attempt, plus exactly one rerun of a failed (not timed-out) domain."""
    first = await run_domain(domain, semaphore, coverage_bin, artifact_dir)
    if first.passed or first.exit_code == TIMEOUT_EXIT_CODE:
        return first
    print(f"  RERUN {domain:<29} attempt 2 of 2 (first attempt exit={first.exit_code}, {first.log})", flush=True)
    second = await run_domain(domain, semaphore, coverage_bin, artifact_dir, attempt=2)
    return replace(
        second,
        duration_seconds=round(first.duration_seconds + second.duration_seconds, 3),
        attempts=2,
        flaky=second.passed,
        first_log=first.log,
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
    tasks = [
        asyncio.create_task(run_domain_with_rerun(domain, semaphore, coverage_bin, artifact_dir))
        for domain in domains
    ]
    try:
        for completed in asyncio.as_completed(tasks):
            result = await completed
            results.append(result)
            status = status_of(result)
            print(f"  {status:<5} {result.domain:<30} {result.duration_seconds:>7.2f}s  {result.log}")
            output = ""
            if not result.passed or result.flaky:
                # FLAKY: the first attempt's failure is what /RCA attributes. A failed
                # rerun shows both attempts, the counted one last.
                logs = [result.first_log] if result.flaky else [result.first_log, result.log]
                output = f"\n--- rerun of {result.domain} (attempt 2 of 2) ---\n".join(
                    (ROOT_DIR / log).read_text(errors="replace") for log in logs if log
                )
                print(output)
            if result.flaky:
                print(f"TEST_FLAKY unit={result.domain} attempts={result.attempts} attribution=REQUIRED", flush=True)
            for line in forward_quarantine(result):
                print(line, flush=True)
            report_progress(result, output)
    except asyncio.CancelledError:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise

    results.sort(key=lambda result: result.domain)
    failures = [result for result in results if not result.passed]
    flaky = [result.domain for result in results if result.flaky]
    summary = {
        "run_id": run_id,
        "partial": partial,
        "selected_domains": domains if partial else [],
        "concurrency": concurrency,
        "passed": len(domains) - len(failures),
        "failed": len(failures),
        "flaky": len(flaky),
        "flaky_domains": flaky,
        "total": len(domains),
        "results": [asdict(result) for result in results],
    }
    (artifact_dir / "results.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Agents blackbox: {summary['passed']} passed ({len(flaky)} flaky), {summary['failed']} failed, "
          f"{summary['total']} total")
    if flaky:
        print("Flaky domains (passed on their one rerun; /RCA attribution required): " + ", ".join(flaky))
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
