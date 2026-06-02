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

from tests.e2e.test_helpers import (
    AuthHandoffStateExpectation,
    CredentialBackpropExpectation,
    cleanup_credential_backprop_fixture,
    prepare_credential_backprop_fixture,
    run_e2e_test,
    DEFAULT_TIMEOUT,
)
from tests.e2e.test_prompts import (
    TEST_PROMPTS,
    get_basic_tests,
    get_all_test_names,
    get_test_by_name,
    TestPrompt,
)
from tests.e2e.live_fixtures import FixtureResolutionError, resolve_test_runtime_env


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
        if test.required_env:
            print(f"    Required env: {', '.join(test.required_env)}")
        if test.expected_patterns_env:
            print(f"    Assert env values: {', '.join(test.expected_patterns_env)}")
        if test.expected_credential_ref_kinds:
            print(f"    Assert credential refs: {', '.join(test.expected_credential_ref_kinds)}")
        if test.expected_credential_ref_kinds_env:
            print(f"    Assert credential refs from env: {', '.join(test.expected_credential_ref_kinds_env)}")
        if test.expected_same_steel_session_auth_handoff:
            print("    Assert same Steel session auth handoff")
        if test.auth_handoff_state or test.auth_handoff_state_env:
            print("    Assert live browser state across auth handoff")
        if test.credential_backprop_cases:
            case_names = [str(case.get("name", "unnamed")) for case in test.credential_backprop_cases]
            print(f"    Credential backprop cases: {', '.join(case_names)}")
            for case in test.credential_backprop_cases:
                fixture_case = case.get("credential_fixture_case")
                if fixture_case:
                    print(f"      {case.get('name', 'unnamed')}: built-in fixture {fixture_case}")
                live_fixture = case.get("live_fixture")
                if live_fixture:
                    print(f"      {case.get('name', 'unnamed')}: live fixture {live_fixture}")
        if test.live_fixture:
            ttl = test.live_fixture_ttl_seconds or 24 * 60 * 60
            print(f"    Live fixture: {test.live_fixture} (ttl={ttl}s)")

    print("\n" + "=" * 70)
    print(f"Total: {len(TEST_PROMPTS)} tests ({len(basic_tests)} basic)")
    print("\nBasic tests don't require attachments, browser agent, or Claude Code.")
    print()


def _required_case_env(case: dict) -> list[str]:
    required = []
    for key in ("target_url_env", "credential_ref_id_env"):
        value = case.get(key)
        if isinstance(value, str) and value:
            required.append(value)
    for value in case.get("required_env", []) or []:
        if isinstance(value, str) and value:
            required.append(value)
    return required


def _case_value(runtime_env: dict[str, str], case: dict, env_key: str, default_key: str) -> str:
    env_name = case.get(env_key)
    if isinstance(env_name, str) and runtime_env.get(env_name):
        return runtime_env[env_name]
    default = case.get(default_key)
    if isinstance(default, str) and default:
        return default
    raise FixtureResolutionError(f"Case {case.get('name', 'unnamed')} is missing {env_key}/{default_key}")


async def run_credential_backprop_suite(
    test: TestPrompt,
    timeout_override: int | None = None,
) -> tuple[bool, str, float]:
    """Run the success and auth-failure credential-backprop live fixture cases."""
    suite_start = time.time()
    cases = test.credential_backprop_cases or []
    results = []

    print(f"\n{'=' * 60}")
    print(f"Running: {test.title}")
    print(f"{'=' * 60}")
    print(f"Description: {test.description}")
    print(f"Cases: {', '.join(str(case.get('name', 'unnamed')) for case in cases)}")
    print()

    for index, case in enumerate(cases, 1):
        case_name = str(case.get("name", f"case-{index}"))
        case_title = str(case.get("title", case_name))
        case_timeout = timeout_override or int(case.get("timeout", test.timeout))
        provisioned_fixture = None
        try:
            runtime_env: dict[str, str] = {}
            fixture_case = case.get("credential_fixture_case")
            if isinstance(fixture_case, str) and fixture_case:
                provisioned_fixture = await prepare_credential_backprop_fixture(fixture_case)
                runtime_env.update(
                    {
                        "TARGET_URL": provisioned_fixture.target_url,
                        "CREDENTIAL_REF_KIND": provisioned_fixture.credential_ref_kind,
                        "CREDENTIAL_REF_ID": provisioned_fixture.credential_ref_id,
                    }
                )
            else:
                required_env = _required_case_env(case)
                runtime_env = await resolve_test_runtime_env(
                    test_name=f"{test.name}.{case_name}",
                    live_fixture=case.get("live_fixture") if isinstance(case.get("live_fixture"), str) else None,
                    required_env=required_env,
                    live_fixture_ttl_seconds=case.get("live_fixture_ttl_seconds")
                    if isinstance(case.get("live_fixture_ttl_seconds"), int)
                    else test.live_fixture_ttl_seconds,
                )
                missing_env = [name for name in required_env if not runtime_env.get(name)]
                if missing_env:
                    duration = time.time() - suite_start
                    return (
                        False,
                        "Missing live e2e configuration for credential backprop case "
                        f"{case_name}: {', '.join(missing_env)}",
                        duration,
                    )
                runtime_env["TARGET_URL"] = _case_value(
                    runtime_env,
                    case,
                    "target_url_env",
                    "target_url",
                )
                runtime_env["CREDENTIAL_REF_ID"] = _case_value(
                    runtime_env,
                    case,
                    "credential_ref_id_env",
                    "credential_ref_id",
                )
                runtime_env["CREDENTIAL_REF_KIND"] = _case_value(
                    runtime_env,
                    case,
                    "credential_ref_kind_env",
                    "credential_ref_kind",
                )

            credential_ref_kind = runtime_env["CREDENTIAL_REF_KIND"]
            expected_failure_reason = None
            if case.get("expected_failure_reason") is not None or case.get("expected_failure_reason_env"):
                expected_failure_reason = _case_value(
                    runtime_env,
                    case,
                    "expected_failure_reason_env",
                    "expected_failure_reason",
                )

            prompt = str(case.get("prompt", test.prompt)).replace("{{TARGET_URL}}", runtime_env["TARGET_URL"])
            expected_terminal_status = str(case["expected_terminal_status"])
            expectation = CredentialBackpropExpectation(
                credential_ref_kind=credential_ref_kind,
                credential_ref_id=runtime_env["CREDENTIAL_REF_ID"],
                expected_terminal_status=expected_terminal_status,
                expected_before_disabled=bool(case["expected_before_disabled"]),
                expected_after_disabled=bool(case["expected_after_disabled"]),
                expected_propagation_outcome=str(case["expected_propagation_outcome"]),
                expected_failure_reason=expected_failure_reason,
            )

            print(f"\n[{index}/{len(cases)}] Credential backprop case: {case_title}")
            print(f"Timeout: {case_timeout}s")
            print(f"Credential ref: {credential_ref_kind}:{runtime_env['CREDENTIAL_REF_ID']}")
            print(f"Prompt: {prompt[:100]}{'...' if len(prompt) > 100 else ''}")
            print()

            passed, message, duration = await run_e2e_test(
                name=f"{test.name}.{case_name}",
                goal=prompt,
                timeout=case_timeout,
                expected_tools=test.expected_tools,
                expected_credential_ref_kinds=[credential_ref_kind],
                credential_backprop_expectation=expectation,
                expected_terminal_status=expected_terminal_status,
                start_phase=test.start_phase,
                is_chat_mode=test.is_chat_mode,
            )
        except FixtureResolutionError as exc:
            duration = time.time() - suite_start
            return (
                False,
                f"Missing live e2e fixture for credential backprop case {case_name}: {exc}",
                duration,
            )
        finally:
            await cleanup_credential_backprop_fixture(provisioned_fixture)

        results.append({
            "name": case_name,
            "passed": passed,
            "message": message,
            "duration": duration,
        })

        status = "PASSED" if passed else "FAILED"
        print(f"\nCase result: {status}")
        print(f"Message: {message}")
        print(f"Duration: {duration:.1f}s")
        if not passed:
            duration = time.time() - suite_start
            return (
                False,
                f"Credential backprop case {case_name} failed: {message}",
                duration,
            )

    total_duration = time.time() - suite_start
    return (
        True,
        "Credential backprop cases passed: "
        + ", ".join(f"{result['name']} ({result['duration']:.1f}s)" for result in results),
        total_duration,
    )


async def run_single_test(test: TestPrompt, timeout_override: int | None = None) -> tuple[bool, str, float]:
    """Run a single test and return the result."""
    if test.credential_backprop_cases:
        return await run_credential_backprop_suite(test, timeout_override)

    timeout = timeout_override or test.timeout
    try:
        runtime_env = await resolve_test_runtime_env(
            test_name=test.name,
            live_fixture=test.live_fixture,
            required_env=test.required_env or [],
            live_fixture_ttl_seconds=test.live_fixture_ttl_seconds,
        )
    except FixtureResolutionError as exc:
        return (False, f"Missing live e2e fixture: {exc}", 0.0)

    missing_env = [name for name in (test.required_env or []) if not runtime_env.get(name)]
    if missing_env:
        return (
            False,
            "Missing live e2e configuration: " + ", ".join(missing_env),
            0.0,
        )

    prompt = test.prompt
    for name in test.required_env or []:
        prompt = prompt.replace(f"{{{{{name}}}}}", runtime_env[name])

    expected_patterns = list(test.expected_patterns or [])
    for name in test.expected_patterns_env or []:
        value = runtime_env.get(name)
        if value:
            expected_patterns.append(value)

    expected_credential_ref_kinds = list(test.expected_credential_ref_kinds or [])
    for name in test.expected_credential_ref_kinds_env or []:
        value = runtime_env.get(name)
        if value:
            expected_credential_ref_kinds.extend(
                kind.strip()
                for kind in value.split(",")
                if kind.strip()
            )

    auth_handoff_state = None
    if test.auth_handoff_state:
        auth_handoff_state = AuthHandoffStateExpectation(
            input_selector=test.auth_handoff_state["input_selector"],
            automation_value=test.auth_handoff_state["automation_value"],
            interactive_value=test.auth_handoff_state["interactive_value"],
        )
    elif test.auth_handoff_state_env:
        try:
            auth_handoff_state = AuthHandoffStateExpectation(
                input_selector=runtime_env[test.auth_handoff_state_env["input_selector"]],
                automation_value=runtime_env[test.auth_handoff_state_env["automation_value"]],
                interactive_value=runtime_env[test.auth_handoff_state_env["interactive_value"]],
            )
        except KeyError as exc:
            return (
                False,
                f"Missing live auth handoff state configuration: {exc}",
                0.0,
            )

    print(f"\n{'=' * 60}")
    print(f"Running: {test.title}")
    print(f"{'=' * 60}")
    print(f"Description: {test.description}")
    print(f"Timeout: {timeout}s")
    print(f"Prompt: {prompt[:100]}{'...' if len(prompt) > 100 else ''}")
    print()

    passed, message, duration = await run_e2e_test(
        name=test.name,
        goal=prompt,
        timeout=timeout,
        expected_patterns=expected_patterns,
        expected_tools=test.expected_tools,
        expected_credential_ref_kinds=expected_credential_ref_kinds,
        expected_same_steel_session_auth_handoff=test.expected_same_steel_session_auth_handoff,
        auth_handoff_state=auth_handoff_state,
        start_phase=test.start_phase,
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
