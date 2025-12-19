"""Run all browser tool tests."""

import asyncio
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

# Import test modules
from tests.browser_tools.test_goto import run_all_tests as run_goto_tests
from tests.browser_tools.test_aria_tree import run_all_tests as run_aria_tree_tests
from tests.browser_tools.test_act import run_all_tests as run_act_tests
from tests.browser_tools.test_screenshot import run_all_tests as run_screenshot_tests
from tests.browser_tools.test_scroll import run_all_tests as run_scroll_tests
from tests.browser_tools.test_simple_tools import run_all_tests as run_simple_tools_tests
from tests.browser_tools.test_tool_executor import run_all_tests as run_executor_tests


async def run_all_browser_tool_tests():
    """Run all browser tool test suites."""
    print("\n" + "="*70)
    print("🚀 RUNNING ALL BROWSER TOOL TESTS")
    print("="*70)
    
    results = []
    
    # Run each test suite
    test_suites = [
        ("Goto Tool", run_goto_tests),
        ("Aria Tree Tool", run_aria_tree_tests),
        ("Act Tool", run_act_tests),
        ("Screenshot Tool", run_screenshot_tests),
        ("Scroll Tool", run_scroll_tests),
        ("Simple Tools", run_simple_tools_tests),
        ("Tool Executor", run_executor_tests),
    ]
    
    for suite_name, test_func in test_suites:
        print(f"\n{'='*70}")
        print(f"Running {suite_name} Tests...")
        print(f"{'='*70}")
        
        try:
            success = await test_func()
            results.append((suite_name, success))
        except Exception as e:
            print(f"\n❌ {suite_name} tests failed with exception: {e}")
            import traceback
            traceback.print_exc()
            results.append((suite_name, False))
    
    # Print summary
    print("\n" + "="*70)
    print("📊 TEST SUMMARY")
    print("="*70)
    
    all_passed = True
    for suite_name, success in results:
        status = "✅ PASSED" if success else "❌ FAILED"
        print(f"{status:12} - {suite_name}")
        if not success:
            all_passed = False
    
    print("="*70)
    
    if all_passed:
        print("\n🎉 ALL BROWSER TOOL TESTS PASSED!")
        return True
    else:
        print("\n❌ SOME TESTS FAILED")
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_browser_tool_tests())
    sys.exit(0 if success else 1)

