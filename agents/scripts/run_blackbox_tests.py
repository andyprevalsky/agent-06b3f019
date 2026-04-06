#!/usr/bin/env python3
"""
Blackbox test runner for the agents codebase.

Sets up capture mode, generates run artifacts, discovers and runs
blackbox test suites with domain filtering and concurrency control.

Usage:
    python scripts/run_blackbox_tests.py                    # run all domains
    python scripts/run_blackbox_tests.py web-search         # run one domain
    python scripts/run_blackbox_tests.py --list             # list available domains
    python scripts/run_blackbox_tests.py --concurrency 5    # limit parallel domains

Modeled after back-end/scripts/run-blackbox-tests.sh.
"""

import asyncio
import importlib.util
import json
import os
import sys
import time
import uuid
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parent.parent
TESTS_DIR = AGENTS_ROOT / "tests" / "blackbox"
ROOT_DIR = AGENTS_ROOT.parent
ARTIFACT_ROOT = ROOT_DIR / ".context" / "test-runs"

# Add agents root to path so test files can import tools/helpers
sys.path.insert(0, str(AGENTS_ROOT))
# Add tests/blackbox to path so test files can import _test_utils
sys.path.insert(0, str(TESTS_DIR))


def generate_run_id() -> str:
    ts = time.strftime("%Y%m%d-%H%M%S")
    short_uuid = uuid.uuid4().hex[:8]
    return f"{ts}-{os.getpid()}-{short_uuid}"


def discover_domains() -> list[str]:
    """Discover all blackbox test domains from test files."""
    if not TESTS_DIR.exists():
        return []
    return sorted(
        f.stem.replace(".blackbox", "").replace("_", "-")
        for f in TESTS_DIR.glob("*.blackbox.py")
    )


def domain_to_test_file(domain: str) -> Path | None:
    """Convert a domain name to its blackbox test file path."""
    snake = domain.replace("-", "_")
    candidates = [
        TESTS_DIR / f"{snake}.blackbox.py",
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


def list_domains() -> None:
    domains = discover_domains()
    if not domains:
        print("No blackbox test files found.")
        print(f"Expected location: {TESTS_DIR}/<domain>.blackbox.py")
        return
    print(f"Available blackbox test domains ({len(domains)}):")
    for d in domains:
        print(f"  {d}")


async def run_single_domain(test_file: Path, domain: str) -> tuple[str, bool, str]:
    """Run a single domain's blackbox test. Returns (domain, passed, message)."""
    try:
        spec = importlib.util.spec_from_file_location(
            f"blackbox_{domain.replace('-', '_')}", test_file
        )
        if spec is None or spec.loader is None:
            return (domain, False, "Could not load test file")

        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        if not hasattr(module, "run_all_tests"):
            return (domain, False, "No run_all_tests() function found")

        result = await module.run_all_tests()
        if result is True or result is None:
            return (domain, True, "")
        elif isinstance(result, dict):
            passed = result.get("passed", 0)
            failed = result.get("failed", 0)
            if failed > 0:
                return (domain, False, f"{passed} passed, {failed} failed")
            return (domain, True, f"{passed} passed")
        else:
            return (domain, bool(result), "")

    except Exception as e:
        return (domain, False, f"ERROR: {e}")


async def run_tests(
    domain_filter: str | None = None, concurrency: int = 30
) -> int:
    run_id = os.environ.get("BLACKBOX_TEST_RUN_ID", generate_run_id())
    artifact_dir = Path(
        os.environ.get("BLACKBOX_TEST_ARTIFACT_DIR", str(ARTIFACT_ROOT / run_id))
    )
    artifact_dir.mkdir(parents=True, exist_ok=True)

    # Write manifest
    manifest = {
        "run_id": run_id,
        "mode": "direct-import",
        "artifact_dir": str(artifact_dir),
        "domain_filter": domain_filter,
        "capture_outbound": True,
        "concurrency": concurrency,
    }
    (artifact_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    # Set up environment
    os.environ["BLACKBOX_TEST_CAPTURE_OUTBOUND"] = "1"
    os.environ["BLACKBOX_TEST_RUN_ID"] = run_id
    os.environ["BLACKBOX_TEST_ARTIFACT_DIR"] = str(artifact_dir)

    # Install capture harness
    from helpers.httpx_capture import install_capture

    install_capture()

    # Discover test files
    if domain_filter:
        test_file = domain_to_test_file(domain_filter)
        if test_file is None:
            print(f"ERROR: No blackbox test found for domain '{domain_filter}'")
            print(f"Expected: {TESTS_DIR}/{domain_filter.replace('-', '_')}.blackbox.py")
            return 1
        test_pairs = [(test_file, domain_filter)]
    else:
        all_domains = discover_domains()
        if not all_domains:
            print("No blackbox test files found.")
            return 1
        test_pairs = []
        for d in all_domains:
            tf = domain_to_test_file(d)
            if tf:
                test_pairs.append((tf, d))

    print(f"Run ID:       {run_id}")
    print(f"Artifact dir: {artifact_dir}")
    print(f"Domains:      {len(test_pairs)}")
    print(f"Concurrency:  {concurrency}")
    print()

    # Run tests with concurrency control
    semaphore = asyncio.Semaphore(concurrency)

    async def run_with_semaphore(
        tf: Path, d: str
    ) -> tuple[str, bool, str]:
        async with semaphore:
            return await run_single_domain(tf, d)

    start = time.monotonic()
    results = await asyncio.gather(
        *(run_with_semaphore(tf, d) for tf, d in test_pairs)
    )
    elapsed = time.monotonic() - start

    # Print results
    passed = 0
    failed = 0
    for domain, success, msg in results:
        status = "PASS" if success else "FAIL"
        suffix = f" ({msg})" if msg else ""
        print(f"  {'✅' if success else '❌'} {domain:<30} {status}{suffix}")
        if success:
            passed += 1
        else:
            failed += 1

    print()
    print(f"Results: {passed} passed, {failed} failed ({elapsed:.1f}s)")

    # Write results
    result_data = {
        "passed": passed,
        "failed": failed,
        "total": passed + failed,
        "elapsed_seconds": round(elapsed, 1),
        "details": [
            {"domain": d, "passed": s, "message": m} for d, s, m in results
        ],
    }
    (artifact_dir / "results.json").write_text(json.dumps(result_data, indent=2))

    return 0 if failed == 0 else 1


def main() -> None:
    args = sys.argv[1:]

    if "--list" in args:
        list_domains()
        return

    domain_filter: str | None = None
    concurrency = 30

    i = 0
    while i < len(args):
        if args[i] == "--concurrency" and i + 1 < len(args):
            try:
                concurrency = int(args[i + 1])
            except ValueError:
                print(f"Error: --concurrency requires an integer value, got '{args[i + 1]}'")
                sys.exit(1)
            i += 2
        elif not args[i].startswith("-"):
            domain_filter = args[i]
            i += 1
        else:
            i += 1

    exit_code = asyncio.run(run_tests(domain_filter, concurrency))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
