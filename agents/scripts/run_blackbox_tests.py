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
    python scripts/run_blackbox_tests.py --help             # show this help

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
from typing import NoReturn

import structlog.contextvars
from dotenv import load_dotenv

AGENTS_ROOT = Path(__file__).resolve().parent.parent
TESTS_DIR = AGENTS_ROOT / "tests" / "blackbox"
ROOT_DIR = AGENTS_ROOT.parent
ARTIFACT_ROOT = ROOT_DIR / ".context" / "test-runs"

# Add agents root to path so test files can import tools/helpers
sys.path.insert(0, str(AGENTS_ROOT))
# Add tests/blackbox to path so test files can import _test_utils
sys.path.insert(0, str(TESTS_DIR))

# Real credentials from agents/.env must win over test placeholders. Cloud deploy
# shells often omit injected secrets, so load dotenv before setdefault defaults.
load_dotenv(AGENTS_ROOT / ".env", override=False)


def generate_run_id() -> str:
    ts = time.strftime("%Y%m%d-%H%M%S")
    short_uuid = uuid.uuid4().hex[:8]
    return f"{ts}-{os.getpid()}-{short_uuid}"


def discover_domains() -> list[str]:
    """Discover all blackbox test domains from test files."""
    if not TESTS_DIR.exists():
        return []
    return sorted(f.stem.replace(".blackbox", "").replace("_", "-") for f in TESTS_DIR.glob("*.blackbox.py"))


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


# Imported modules stay cached across domains, so an env default a module sets
# while it is being imported (spawn_browser_agent_v3.config's browser-use event
# timeouts) must survive the per-domain restore, as it would in a fresh process
# that imported the same module. Writes made by test code are still reverted,
# and so are a domain file's own module-scope writes: the runner executes it
# without caching it, so a later domain never re-imports it.
_IMPORT_TIME_ENV: dict[str, list[tuple[str, str]]] = {}


def _record_import_time_env(event: str, args: tuple) -> None:
    if event != "os.putenv":
        return
    frame = sys._getframe(1)
    while frame is not None and frame.f_code.co_name != "<module>":
        frame = frame.f_back
    if frame is None or frame.f_back is None:
        return
    if not frame.f_back.f_code.co_filename.startswith("<frozen importlib"):
        return
    module_name = frame.f_globals.get("__name__", "")
    if module_name not in sys.modules:
        return
    key, value = (os.fsdecode(arg) for arg in args)
    _IMPORT_TIME_ENV.setdefault(key, []).append((module_name, value))


sys.addaudithook(_record_import_time_env)


def _restore_environ(snapshot: dict[str, str]) -> None:
    target = dict(snapshot)
    # The newest write from a module that is still cached wins; one whose import
    # later failed has left sys.modules and falls back to the earlier writer.
    for key, records in _IMPORT_TIME_ENV.items():
        for module_name, value in reversed(records):
            if module_name in sys.modules:
                target[key] = value
                break
    for key in set(os.environ) - target.keys():
        del os.environ[key]
    for key, value in target.items():
        if os.environ.get(key) != value:
            os.environ[key] = value


async def run_single_domain(test_file: Path, domain: str) -> tuple[str, bool, str]:
    """Run a single domain's blackbox test. Returns (domain, passed, message)."""
    # Domains run sequentially in one interpreter, but each domain must begin
    # with the same request/logging context and os.environ as an isolated
    # process: a flag one suite exports (e.g. a benchmark-only kill switch)
    # must not silently change the code paths a later suite exercises.
    structlog.contextvars.clear_contextvars()
    # A suite's leftover httpx mock handler would also answer later suites'
    # loopback requests (the capture harness routes localhost through an
    # installed mock): e.g. a real Chromium's /json/version came back as {}.
    from helpers.httpx_capture import clear_mock_handler

    clear_mock_handler()
    env_snapshot = dict(os.environ)
    try:
        spec = importlib.util.spec_from_file_location(f"blackbox_{domain.replace('-', '_')}", test_file)
        if spec is None or spec.loader is None:
            return (domain, False, "Could not load test file")

        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        if not hasattr(module, "run_all_tests"):
            return (domain, False, "No run_all_tests() function found")

        result = await module.run_all_tests()
        if os.environ.get("BLACKBOX_CASE_FUNCTIONS") is not None:
            # Never let a case-filtered domain read like a full pass, whatever run_all_tests returns.
            passed = result is True or result is None or (isinstance(result, dict) and not result.get("failed"))
            return (domain, passed, "case-filtered partial run (BLACKBOX_CASE_FUNCTIONS)")
        if result is True or result is None:
            return (domain, True, "")
        elif isinstance(result, dict):
            passed = result.get("passed", 0)
            failed = result.get("failed", 0)
            # A case-filtered run (BLACKBOX_CASE_FUNCTIONS) is partial; say so in every result line.
            omitted = f", {result['omitted']} omitted by the case filter" if result.get("omitted") else ""
            if failed > 0:
                return (domain, False, f"{passed} passed, {failed} failed{omitted}")
            return (domain, True, f"{passed} passed{omitted}")
        else:
            return (domain, bool(result), "")

    except Exception as e:
        return (domain, False, f"ERROR: {e}")
    finally:
        structlog.contextvars.clear_contextvars()
        _restore_environ(env_snapshot)


async def run_tests(domain_filters: list[str] | None = None, concurrency: int = 30) -> int:
    run_id = os.environ.get("BLACKBOX_TEST_RUN_ID", generate_run_id())
    artifact_dir = Path(os.environ.get("BLACKBOX_TEST_ARTIFACT_DIR", str(ARTIFACT_ROOT / run_id)))
    artifact_dir.mkdir(parents=True, exist_ok=True)

    # Write manifest
    manifest = {
        "run_id": run_id,
        "mode": "direct-import",
        "artifact_dir": str(artifact_dir),
        "domain_filters": domain_filters,
        "capture_outbound": True,
        "concurrency": concurrency,
    }
    (artifact_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    # Set up environment
    os.environ["BLACKBOX_TEST_CAPTURE_OUTBOUND"] = "1"
    os.environ["BLACKBOX_TEST_RUN_ID"] = run_id
    os.environ["BLACKBOX_TEST_ARTIFACT_DIR"] = str(artifact_dir)
    # Blackbox requests are captured and replayed, but importing a domain may
    # still construct AppConfig before its test installs a narrower fixture.
    # Keep the standalone runner deterministic in clean CI without overriding
    # any explicitly supplied credential or endpoint. Single source of truth,
    # shared with agents/conftest.py so the pytest suites and the blackbox
    # runner start from the same deterministic environment.
    from tests.env_defaults import apply_test_env_defaults

    apply_test_env_defaults()

    # Install capture harness
    from helpers.httpx_capture import install_capture

    install_capture()

    # Discover test files
    if domain_filters:
        test_pairs = []
        for domain_filter in domain_filters:
            test_file = domain_to_test_file(domain_filter)
            if test_file is None:
                print(f"ERROR: No blackbox test found for domain '{domain_filter}'")
                print(f"Expected: {TESTS_DIR}/{domain_filter.replace('-', '_')}.blackbox.py")
                return 1
            test_pairs.append((test_file, domain_filter))
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

    case_filter = os.environ.get("BLACKBOX_CASE_FUNCTIONS")
    if case_filter is not None:
        print(f"CASE FILTER:  BLACKBOX_CASE_FUNCTIONS={case_filter} (partial run, not a full domain pass)")
    print(f"Run ID:       {run_id}")
    print(f"Artifact dir: {artifact_dir}")
    print(f"Domains:      {len(test_pairs)}")
    print(f"Concurrency:  {concurrency}")
    print()

    # Run tests sequentially — agents tests share global mock state
    # (_mock_handler, _captures) so concurrent execution causes cross-domain
    # collisions. Sequential is fine since all HTTP is mocked (fast).
    start = time.monotonic()
    results: list[tuple[str, bool, str]] = []
    for tf, d in test_pairs:
        results.append(await run_single_domain(tf, d))
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
        "details": [{"domain": d, "passed": s, "message": m} for d, s, m in results],
    }
    if case_filter is not None:
        result_data["case_filter"] = case_filter
    (artifact_dir / "results.json").write_text(json.dumps(result_data, indent=2))

    return 0 if failed == 0 else 1


def _usage_error(message: str) -> NoReturn:
    print(f"Error: {message}\n{__doc__}", file=sys.stderr)
    sys.exit(2)


def parse_args(args: list[str]) -> tuple[list[str], int]:
    """Return (domain filters, concurrency).

    An unrecognized option must fail fast: with no domain filter the runner
    starts every domain, so an ignored typo would launch the full suite.
    """
    domain_filters: list[str] = []
    concurrency = 30

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--concurrency":
            if i + 1 >= len(args):
                _usage_error("--concurrency requires an integer value")
            try:
                concurrency = int(args[i + 1])
            except ValueError:
                _usage_error(f"--concurrency requires an integer value, got '{args[i + 1]}'")
            i += 2
        elif arg.startswith("-"):
            _usage_error(f"unknown option '{arg}'")
        else:
            domain_filters.append(arg)
            i += 1

    return domain_filters, concurrency


def main() -> None:
    args = sys.argv[1:]

    if "-h" in args or "--help" in args:
        print(__doc__)
        return

    if "--list" in args:
        list_domains()
        return

    domain_filters, concurrency = parse_args(args)
    exit_code = asyncio.run(run_tests(domain_filters or None, concurrency))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
