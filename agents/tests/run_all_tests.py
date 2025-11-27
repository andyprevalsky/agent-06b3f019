#!/usr/bin/env python3
"""
Agent Tools Test Suite Runner

Runs all agent tool tests in parallel and reports results.
Similar to back-end's api-test-suite.ts
"""

import asyncio
import sys
import time
from pathlib import Path
from typing import Dict, Callable, Awaitable

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from test_web_search import run_all_tests as test_web_search
from test_amazon_shopping import run_all_tests as test_amazon_shopping
from test_request_user_attention import run_all_tests as test_request_user_attention
from test_wait_seconds import run_all_tests as test_wait_seconds
from test_spawn_sub_agents import run_all_tests as test_spawn_sub_agents
from test_knowledge_base import run_all_tests as test_knowledge_base
from test_send_sms import run_all_tests as test_send_sms
from test_send_sms_as_user import run_all_tests as test_send_sms_as_user
from test_send_email import run_all_tests as test_send_email
from test_find_all import run_all_tests as test_find_all
from test_enrich import run_all_tests as test_enrich
from test_monitor import run_all_tests as test_monitor
from test_read_message_history import run_all_tests as test_read_message_history
from test_message_person import run_all_tests as test_message_person


async def run_test_silent(name: str, test_func: Callable[[], Awaitable[bool]]) -> tuple[str, bool, float]:
    """Run a test silently and return results."""
    import io
    import contextlib
    
    start = time.time()
    
    # Capture stdout/stderr to suppress test output
    stdout_capture = io.StringIO()
    stderr_capture = io.StringIO()
    
    try:
        with contextlib.redirect_stdout(stdout_capture), contextlib.redirect_stderr(stderr_capture):
            result = await test_func()
        duration = time.time() - start
        return (name, result, duration)
    except Exception as e:
        duration = time.time() - start
        # On error, show the captured output for debugging
        captured_out = stdout_capture.getvalue()
        captured_err = stderr_capture.getvalue()
        if captured_out:
            print(f"\n--- {name} stdout ---")
            print(captured_out)
        if captured_err:
            print(f"\n--- {name} stderr ---")
            print(captured_err)
        print(f"❌ {name} failed with exception: {e}")
        return (name, False, duration)


async def main():
    """Run all tests in parallel and report results."""
    start_time = time.time()
    
    print("🧪 Starting Agent Tools Test Suite...")
    print("")
    
    # Group tests that can run in parallel
    print("🔧 Running tool tests in parallel...")
    
    # Create test tasks (all async, run in parallel)
    test_tasks = [
        run_test_silent("Web Search", test_web_search),
        run_test_silent("Amazon Shopping", test_amazon_shopping),
        run_test_silent("Knowledge Base", test_knowledge_base),
        run_test_silent("Send SMS", test_send_sms),
        run_test_silent("Send SMS As User", test_send_sms_as_user),
        run_test_silent("Send Email", test_send_email),
        run_test_silent("Find All", test_find_all),
        run_test_silent("Enrich", test_enrich),
        run_test_silent("Monitor", test_monitor),
        run_test_silent("Read Message History", test_read_message_history),
        run_test_silent("Message Person", test_message_person),
    ]
    
    # Run sync tests (these are fast, run them sequentially, silently)
    import io
    import contextlib
    
    sync_start = time.time()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        wait_seconds_result = test_wait_seconds()
    wait_seconds_duration = (time.time() - sync_start) * 1000
    
    sync_start = time.time()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        request_attention_result = test_request_user_attention()
    request_attention_duration = (time.time() - sync_start) * 1000
    
    # Wait for all async tests
    async_results = await asyncio.gather(*test_tasks)
    
    # Run Spawn Sub-Agents after other async tests to avoid interference
    spawn_result = await run_test_silent("Spawn Sub-Agents", test_spawn_sub_agents)
    
    # Collect all results
    results = []
    for name, passed, duration in async_results:
        results.append((name, passed, int(duration * 1000)))  # Convert to ms
    
    # Include Spawn Sub-Agents result (convert duration to ms)
    results.append((spawn_result[0], spawn_result[1], int(spawn_result[2] * 1000)))
    
    results.append(("Wait Seconds", wait_seconds_result, int(wait_seconds_duration)))
    results.append(("Request User Attention", request_attention_result, int(request_attention_duration)))
    
    # Calculate summary
    total_duration = int((time.time() - start_time) * 1000)
    passed_count = sum(1 for _, passed, _ in results if passed)
    failed_count = len(results) - passed_count
    
    # Print summary
    print("")
    print("=" * 60)
    print("")
    print("📊 Test Summary:")
    print(f"   Total: {len(results)}")
    print(f"   ✅ Passed: {passed_count}")
    print(f"   ❌ Failed: {failed_count}")
    print(f"   ⏱️  Duration: {total_duration}ms")
    print("")
    
    # Print individual results
    for name, passed, duration in results:
        status = "✅" if passed else "❌"
        print(f"{status} {name} ({duration}ms)")
    
    print("")
    
    if failed_count == 0:
        print("✅ ALL TESTS PASSED!")
        print("")
        return 0
    else:
        print(f"❌ {failed_count} TEST(S) FAILED")
        print("")
        return 1


if __name__ == "__main__":
    try:
        exit_code = asyncio.run(main())
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\n\n⚠️  Tests interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n\n❌ Test runner failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

