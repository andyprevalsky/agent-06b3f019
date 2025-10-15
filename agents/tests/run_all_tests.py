#!/usr/bin/env python3
"""
Agent Tools Test Suite Runner

Runs all agent tool tests and reports results.
Similar to back-end's api-test-suite.ts
"""

import asyncio
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from test_web_search import run_all_tests as test_web_search
from test_deep_research import run_all_tests as test_deep_research
from test_amazon_shopping import run_all_tests as test_amazon_shopping
from test_request_user_attention import run_all_tests as test_request_user_attention
from test_wait_seconds import run_all_tests as test_wait_seconds
from test_spawn_sub_agents import run_all_tests as test_spawn_sub_agents
from test_knowledge_base import run_all_tests as test_knowledge_base


async def run_async_tests():
    """Run tests that require async."""
    results = {}
    
    # Web search tests
    print("\n" + "="*70)
    print("🧪 RUNNING WEB_SEARCH TESTS")
    print("="*70)
    results['web_search'] = await test_web_search()
    
    # Deep research tests (can be slow)
    print("\n" + "="*70)
    print("🧪 RUNNING DEEP_RESEARCH TESTS (may take 30-120s)")
    print("="*70)
    results['deep_research'] = await test_deep_research()
    
    # Amazon shopping tests (now async)
    print("\n" + "="*70)
    print("🧪 RUNNING AMAZON_SHOPPING TESTS")
    print("="*70)
    results['amazon_shopping'] = await test_amazon_shopping()
    
    # Spawn sub-agents tests (now async)
    print("\n" + "="*70)
    print("🧪 RUNNING SPAWN_SUB_AGENTS TESTS")
    print("="*70)
    results['spawn_sub_agents'] = await test_spawn_sub_agents()
    
    # Knowledge base tests (now async)
    print("\n" + "="*70)
    print("🧪 RUNNING KNOWLEDGE_BASE TESTS")
    print("="*70)
    results['knowledge_base'] = await test_knowledge_base()
    
    return results


def run_sync_tests():
    """Run tests that are synchronous."""
    results = {}
    
    # Request user attention tests
    print("\n" + "="*70)
    print("🧪 RUNNING REQUEST_USER_ATTENTION TESTS")
    print("="*70)
    results['request_user_attention'] = test_request_user_attention()
    
    # Wait seconds tests
    print("\n" + "="*70)
    print("🧪 RUNNING WAIT_SECONDS TESTS")
    print("="*70)
    results['wait_seconds'] = test_wait_seconds()
    
    return results


async def main():
    """Run all tests and report results."""
    print("\n" + "="*70)
    print("🚀 AGENT TOOLS TEST SUITE")
    print("="*70)
    print("\nThis test suite validates all agent tools including:")
    print("  • User tools: web_search, deep_research, amazon_shopping")
    print("  • System tools: wait_seconds, spawn_sub_agents, request_user_attention")
    print("  • Activities: knowledge_base (blueprints)")
    print("\n" + "="*70)
    
    # Run all tests
    async_results = await run_async_tests()
    sync_results = run_sync_tests()
    
    # Combine results
    all_results = {**async_results, **sync_results}
    
    # Print summary
    print("\n\n" + "="*70)
    print("📊 TEST SUMMARY")
    print("="*70 + "\n")
    
    passed = 0
    failed = 0
    
    for tool_name, result in all_results.items():
        status = "✅ PASSED" if result else "❌ FAILED"
        print(f"  {tool_name:25} {status}")
        if result:
            passed += 1
        else:
            failed += 1
    
    total = passed + failed
    print("\n" + "-"*70)
    print(f"  Total: {total}  |  Passed: {passed}  |  Failed: {failed}")
    print("="*70 + "\n")
    
    if failed == 0:
        print("🎉 ALL TESTS PASSED!")
        return 0
    else:
        print(f"⚠️  {failed} TEST SUITE(S) FAILED")
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

