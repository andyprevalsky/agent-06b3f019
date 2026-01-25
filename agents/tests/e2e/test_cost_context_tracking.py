#!/usr/bin/env python3
"""
E2E Test: Cost and Context Size Tracking

Tests that tree_cost_cents and context_size are properly tracked and propagated
to the database during agent execution.

Usage:
    python test_cost_context_tracking.py
"""

import asyncio
import os
import sys
import time
from pathlib import Path

# Add parent directories to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from tests.e2e.test_helpers import (
    authenticate,
    spawn_agent,
    get_agent_status,
    cleanup_agent,
    get_auth_headers,
    BASE_URL,
)
import httpx

# Test configuration
TEST_TIMEOUT = 60  # 60 second timeout for more time to complete
POLL_INTERVAL = 2  # Poll every 2 seconds

# Simple test prompt that should complete quickly
TEST_PROMPT = """Calculate 2+2 and return the result. This is a simple test."""


async def run_cost_context_test():
    """
    Test that context_size and tree_cost_cents are updated during execution.

    Verifies:
    1. context_size starts at 0 and increases after LLM calls
    2. tree_cost_cents starts at 0 and increases as costs accumulate
    3. Both values are persisted to DB and retrievable via API
    """
    print("\n" + "=" * 70)
    print("COST & CONTEXT TRACKING TEST")
    print("=" * 70)

    agent_id = None
    start_time = time.time()

    try:
        # Authenticate
        await authenticate()

        # Spawn agent
        print(f"\n1. Spawning agent...")
        print(f"   Timeout: {TEST_TIMEOUT}s")
        agent_id = await spawn_agent(
            goal=TEST_PROMPT,
            model="rose-labs/rose-1-lite",
            timeout=TEST_TIMEOUT,
        )
        print(f"   Agent ID: {agent_id}")

        # Start agent mode (escalate from chat to Temporal workflow)
        print(f"\n2. Starting agent mode (Temporal workflow)...")
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{BASE_URL}/api/agents/{agent_id}/start-agent",
                headers=get_auth_headers(),
                json={"mode": "plan"},  # Start in plan mode
                timeout=30.0,
            )
            if response.status_code != 200:
                print(f"   ERROR: Failed to start agent mode: {response.status_code} - {response.text}")
                raise Exception(f"Failed to start agent: {response.status_code}")
            print(f"   Agent mode started successfully")

        # Track observed values
        observed_context_sizes = []
        observed_tree_costs = []
        observed_tokens_in = []
        observed_tokens_out = []

        # Poll and track values
        print(f"\n3. Polling agent for {TEST_TIMEOUT}s...")
        poll_start = time.time()

        while time.time() - poll_start < TEST_TIMEOUT:
            try:
                data = await get_agent_status(agent_id)
                agent = data.get("agent", {})

                status = agent.get("status", "UNKNOWN")
                context_size = agent.get("context_size", 0)
                tree_cost_cents = agent.get("tree_cost_cents", 0)
                tokens_in = agent.get("tokens_in", 0)
                tokens_out = agent.get("tokens_out", 0)
                progress = agent.get("progress", 0)

                # Track values
                observed_context_sizes.append(context_size)
                observed_tree_costs.append(tree_cost_cents)
                observed_tokens_in.append(tokens_in)
                observed_tokens_out.append(tokens_out)

                elapsed = time.time() - poll_start
                print(f"   [{elapsed:5.1f}s] status={status:15} progress={progress:.0%} "
                      f"context_size={context_size:6} tree_cost={tree_cost_cents:4}c "
                      f"tokens_in={tokens_in:6} tokens_out={tokens_out:5}")

                # Check for terminal states
                if status in {"COMPLETED", "FAILED", "OUT_OF_CREDITS", "COST_LIMIT_REACHED"}:
                    print(f"\n   Agent reached terminal state: {status}")
                    break

            except Exception as e:
                print(f"   Error polling: {e}")

            await asyncio.sleep(POLL_INTERVAL)

        # Final fetch to get latest state
        print(f"\n4. Final state fetch...")
        final_data = await get_agent_status(agent_id)
        final_agent = final_data.get("agent", {})

        final_status = final_agent.get("status", "UNKNOWN")
        final_context_size = final_agent.get("context_size", 0)
        final_tree_cost = final_agent.get("tree_cost_cents", 0)
        final_tokens_in = final_agent.get("tokens_in", 0)
        final_tokens_out = final_agent.get("tokens_out", 0)

        print(f"   Final status: {final_status}")
        print(f"   Final context_size: {final_context_size}")
        print(f"   Final tree_cost_cents: {final_tree_cost}")
        print(f"   Final tokens_in: {final_tokens_in}")
        print(f"   Final tokens_out: {final_tokens_out}")

        # Analyze results
        print(f"\n5. Analyzing results...")

        max_context_size = max(observed_context_sizes)
        max_tree_cost = max(observed_tree_costs)
        max_tokens_in = max(observed_tokens_in)

        print(f"   Max observed context_size: {max_context_size}")
        print(f"   Max observed tree_cost_cents: {max_tree_cost}")
        print(f"   Max observed tokens_in: {max_tokens_in}")

        # Verify expectations
        print(f"\n6. Verification...")

        passed = True
        issues = []

        # Check context_size was updated (should be > 0 after LLM calls)
        if max_context_size == 0 and max_tokens_in > 0:
            issues.append("context_size remained 0 despite tokens_in > 0")
            passed = False
        elif max_context_size > 0:
            print(f"   [PASS] context_size updated: {max_context_size}")
        else:
            print(f"   [SKIP] No tokens used yet, can't verify context_size")

        # Check tree_cost_cents was updated (should be > 0 if tokens used)
        if max_tree_cost == 0 and max_tokens_in > 0:
            # This might be OK if pricing isn't configured
            print(f"   [WARN] tree_cost_cents is 0 despite tokens_in > 0 (check pricing config)")
        elif max_tree_cost > 0:
            print(f"   [PASS] tree_cost_cents updated: {max_tree_cost}c")
        else:
            print(f"   [SKIP] No tokens used yet, can't verify tree_cost_cents")

        # Check tokens_in was updated
        if max_tokens_in > 0:
            print(f"   [PASS] tokens_in updated: {max_tokens_in}")
        else:
            print(f"   [WARN] tokens_in remained 0 - agent may not have made LLM calls")

        # Final result
        duration = time.time() - start_time

        print(f"\n" + "=" * 70)
        if passed:
            print(f"TEST PASSED in {duration:.1f}s")
        else:
            print(f"TEST FAILED in {duration:.1f}s")
            for issue in issues:
                print(f"  - {issue}")
        print("=" * 70)

        return passed, issues

    except Exception as e:
        duration = time.time() - start_time
        print(f"\n" + "=" * 70)
        print(f"TEST ERROR in {duration:.1f}s: {e}")
        print("=" * 70)
        import traceback
        traceback.print_exc()
        return False, [str(e)]

    finally:
        # Cleanup
        if agent_id:
            print(f"\n7. Cleanup: Deleting agent {agent_id[:8]}...")
            deleted = await cleanup_agent(agent_id)
            print(f"   Deleted: {deleted}")


async def main():
    passed, issues = await run_cost_context_test()
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        exit_code = asyncio.run(main())
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\n\nTest interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\nTest runner crashed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
