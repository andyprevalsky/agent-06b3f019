#!/usr/bin/env python3
"""
E2E Agent Test Runner

Spawns real agents via the Rose API and verifies end-to-end behavior.
Tests mirror the frontend TestPromptsSelector test prompts.

Usage:
    python run_e2e_tests.py --list                    # List all available tests
    python run_e2e_tests.py --test chat-mode          # Run a specific test
    python run_e2e_tests.py --test web-search --timeout 60
    python run_e2e_tests.py --basic                   # Run all basic tests
    python run_e2e_tests.py --all                     # Run ALL tests (including browser/claude code)

NOTE: Tests cannot run in parallel. Each test spawns a real agent that:
  - Consumes API credits
  - Uses Temporal worker resources
  - May interfere with other agents if run concurrently

Environment variables:
    TEST_BASE_URL - Backend URL (default: http://localhost:3001)
    BACKEND_API_KEY - API key for authentication
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path

# Add parent directories to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from tests.e2e.test_helpers import run_e2e_test, DEFAULT_TIMEOUT
from tests.e2e.test_prompts import (
    TEST_PROMPTS,
    get_basic_tests,
    get_all_test_names,
    get_test_by_name,
    TestPrompt,
)


def print_test_list():
    """Print all available tests with their descriptions."""
    print("\nAvailable E2E Tests:")
    print("=" * 70)

    basic_tests = get_basic_tests()
    basic_names = {t.name for t in basic_tests}

    for name, test in TEST_PROMPTS.items():
        flags = []
        if test.requires_browser_agent:
            flags.append("browser")
        if test.requires_claude_code:
            flags.append("claude-code")
        if test.attachment_url or test.attachment_urls:
            flags.append("attachment")

        is_basic = name in basic_names
        basic_marker = "[BASIC]" if is_basic else ""
        flag_str = f" [{', '.join(flags)}]" if flags else ""

        print(f"\n  {name} {basic_marker}{flag_str}")
        print(f"    {test.description}")
        print(f"    Timeout: {test.timeout}s")

    print("\n" + "=" * 70)
    print(f"Total: {len(TEST_PROMPTS)} tests ({len(basic_tests)} basic)")
    print("\nBasic tests don't require attachments, browser agent, or Claude Code.")
    print()


async def run_single_test(test: TestPrompt, timeout_override: int | None = None) -> tuple[bool, str, float]:
    """Run a single test and return the result."""
    timeout = timeout_override or test.timeout

    print(f"\n{'=' * 60}")
    print(f"Running: {test.title}")
    print(f"{'=' * 60}")
    print(f"Description: {test.description}")
    print(f"Timeout: {timeout}s")
    print(f"Prompt: {test.prompt[:100]}{'...' if len(test.prompt) > 100 else ''}")
    print()

    passed, message, duration = await run_e2e_test(
        name=test.name,
        goal=test.prompt,
        timeout=timeout,
        expected_patterns=test.expected_patterns,
        expected_tools=test.expected_tools,
        is_chat_mode=test.is_chat_mode,
    )

    status = "PASSED" if passed else "FAILED"
    print(f"\nResult: {status}")
    print(f"Message: {message}")
    print(f"Duration: {duration:.1f}s")

    return passed, message, duration


async def run_tests(tests: list[TestPrompt], timeout_override: int | None = None):
    """Run a list of tests sequentially (NOT in parallel)."""
    print("\n" + "=" * 70)
    print("E2E AGENT TEST RUNNER")
    print("=" * 70)
    print(f"\nRunning {len(tests)} test(s) SEQUENTIALLY")
    print("(Tests cannot run in parallel - each spawns a real agent)")
    print()

    results = []
    total_start = time.time()

    for i, test in enumerate(tests, 1):
        print(f"\n[{i}/{len(tests)}] Starting test: {test.name}")

        passed, message, duration = await run_single_test(test, timeout_override)
        results.append({
            "name": test.name,
            "title": test.title,
            "passed": passed,
            "message": message,
            "duration": duration,
        })

    # Print summary
    total_duration = time.time() - total_start
    passed_count = sum(1 for r in results if r["passed"])
    failed_count = len(results) - passed_count

    print("\n" + "=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)
    print(f"\nTotal tests: {len(results)}")
    print(f"Passed: {passed_count}")
    print(f"Failed: {failed_count}")
    print(f"Total duration: {total_duration:.1f}s")
    print()

    # Print individual results
    for r in results:
        icon = "PASS" if r["passed"] else "FAIL"
        print(f"  [{icon}] {r['name']} ({r['duration']:.1f}s)")
        if not r["passed"]:
            print(f"         {r['message']}")

    print()

    if failed_count > 0:
        print("SOME TESTS FAILED")
        return 1
    else:
        print("ALL TESTS PASSED!")
        return 0


def main():
    parser = argparse.ArgumentParser(
        description="E2E Agent Test Runner - Spawns real agents and verifies behavior",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python run_e2e_tests.py --list                    # List all tests
  python run_e2e_tests.py --test chat-mode          # Run specific test
  python run_e2e_tests.py --test web-search --timeout 60
  python run_e2e_tests.py --basic                   # Run basic tests only
  python run_e2e_tests.py --all                     # Run ALL tests

NOTE: Tests run sequentially (not in parallel) to avoid resource conflicts.
        """,
    )

    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--list",
        action="store_true",
        help="List all available tests",
    )
    group.add_argument(
        "--test",
        type=str,
        metavar="NAME",
        help="Run a specific test by name",
    )
    group.add_argument(
        "--basic",
        action="store_true",
        help="Run all basic tests (no attachments, browser, or claude code)",
    )
    group.add_argument(
        "--all",
        action="store_true",
        help="Run ALL tests (including those requiring browser/claude code)",
    )

    parser.add_argument(
        "--timeout",
        type=int,
        metavar="SECONDS",
        help=f"Override timeout for tests (default: per-test timeout, typically {DEFAULT_TIMEOUT}s)",
    )

    args = parser.parse_args()

    if args.list:
        print_test_list()
        return 0

    if args.test:
        test = get_test_by_name(args.test)
        if not test:
            print(f"Error: Unknown test '{args.test}'")
            print(f"Available tests: {', '.join(get_all_test_names())}")
            return 1
        tests = [test]

    elif args.basic:
        tests = get_basic_tests()
        if not tests:
            print("Error: No basic tests found")
            return 1

    elif args.all:
        tests = list(TEST_PROMPTS.values())

    return asyncio.run(run_tests(tests, args.timeout))


if __name__ == "__main__":
    try:
        exit_code = main()
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\n\nTest run interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\nTest runner crashed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
