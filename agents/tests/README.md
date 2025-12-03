# Agent Tools Test Suite

Comprehensive test suite for all agent tools, including user-configurable tools, system tools, and workflow activities.

## Overview

This test suite validates:
- **User Tools:** `web_search`, `deep_research`
- **System Tools:** `wait_seconds`, `spawn_sub_agents`, `request_user_attention`
- **Activities:** `knowledge_base` (blueprints)

## Running Tests

### Prerequisites

1. **Environment variables must be set** (in `.env` file):
   ```bash
   # Required for web_search
   OPENAI_API_KEY=your-openai-api-key
   
   # Required for deep_research
   PERPLEXITY_API_KEY=your-perplexity-api-key
   
   # Required for knowledge_base (optional for most tests)
   BACKEND_API_URL=http://localhost:3001
   BACKEND_API_KEY=your-backend-api-key
   ```

2. **Python virtual environment** (recommended):
   ```bash
   cd agents
   python -m venv venv
   source venv/bin/activate  # or `venv\Scripts\activate` on Windows
   pip install -r requirements.txt
   ```

### Run All Tests

```bash
cd agents/tests
python run_all_tests.py
```

Or from the agents directory:
```bash
cd agents
python tests/run_all_tests.py
```

### Run Individual Test Files

```bash
cd agents/tests
python test_web_search.py
python test_deep_research.py
python test_request_user_attention.py
python test_wait_seconds.py
python test_spawn_sub_agents.py
python test_knowledge_base.py
```

### Pre-commit Hook

Tests automatically run before each commit via the pre-commit hook. If tests fail, the commit is blocked.

To set up the pre-commit hook:
```bash
chmod +x agents/tests/pre-commit-hook.sh
ln -sf ../../agents/tests/pre-commit-hook.sh .git/hooks/pre-commit
```

To bypass tests (not recommended):
```bash
git commit --no-verify
```

## What Gets Tested

### web_search
- ✅ Basic search functionality
- ✅ Current events queries
- ✅ Pre/post message formatters

### deep_research
- ✅ Basic research functionality
- ✅ Pre/post message formatters
- ⏳ Note: Takes 30-120 seconds

### request_user_attention
- ✅ Pre/post message formatters
- ℹ️  Actual workflow calls skipped (requires Temporal context)

### wait_seconds
- ✅ Duration formatting (seconds, minutes, hours, days)
- ✅ Pre/post message formatters

### spawn_sub_agents
- ✅ Pre/post message formatters (success, error cases)
- ℹ️  Actual spawning skipped (requires Temporal/backend)

### knowledge_base
- ✅ Query blueprints pre/post message formatters
- ✅ Save blueprint pre/post message formatters
- ℹ️  Actual API calls skipped (requires backend)

## Test Execution Time

- **Fast tests** (~5 seconds): wait_seconds, spawn_sub_agents, request_user_attention, knowledge_base
- **Medium tests** (~10 seconds): web_search
- **Slow tests** (~30-120 seconds): deep_research

Total execution time: ~1-2 minutes

## Test Coverage Philosophy

We test:
1. **All formatters** - Pre/post message formatting for all tools
2. **Core functionality** - Main tool logic where safe to run
3. **Error handling** - Error cases and edge cases

We skip:
1. **Live API calls** - When they require complex setup or could have side effects
2. **Workflow context** - When tools require Temporal workflow execution
3. **Real backend calls** - When tests would need database/backend running

## Adding New Tests

When you create a new tool, you **MUST** create a corresponding test file:

1. Create `test_your_tool.py` in `agents/tests/`
2. Import your tool's functions
3. Write tests for:
   - Core functionality (if safe to test)
   - `format_pre_message()`
   - `format_post_message()`
   - Error handling
4. Add test to `run_all_tests.py`
5. Run the test suite to verify

### Example Test Template

```python
"""Test your_tool tool."""

import asyncio
from dotenv import load_dotenv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
load_dotenv()

from tools.your_tool import your_function, format_pre_message, format_post_message


async def test_basic_functionality():
    """Test basic functionality."""
    result = await your_function(param="test")
    assert "expected_key" in result
    print("✅ test_basic_functionality passed")


def test_format_pre_message():
    """Test pre-message formatting."""
    tool_call = {"param": "test"}
    result = format_pre_message(tool_call)
    assert "title" in result
    assert "message" in result
    print("✅ test_format_pre_message passed")


def test_format_post_message():
    """Test post-message formatting."""
    tool_call = {"param": "test"}
    result_data = {"result": "success"}
    result = format_post_message(tool_call, result_data)
    assert "title" in result
    assert "message" in result
    print("✅ test_format_post_message passed")


async def run_all_tests():
    """Run all tests."""
    print("\n" + "="*60)
    print("🧪 TESTING YOUR_TOOL")
    print("="*60 + "\n")
    
    try:
        await test_basic_functionality()
        test_format_pre_message()
        test_format_post_message()
        
        print("\n✅ All your_tool tests passed!")
        return True
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)
```

## Troubleshooting

### "Module not found" errors
Make sure you're running from the `agents/tests/` directory and have activated the virtual environment:
```bash
cd agents
source venv/bin/activate  # or venv\Scripts\activate on Windows
cd tests
python run_all_tests.py
```

### "API key not found" errors
Check your `.env` file in the `agents/` directory:
```bash
# Required
OPENAI_API_KEY=sk-...
PERPLEXITY_API_KEY=pplx-...

# Optional (for full test coverage)
BACKEND_API_URL=http://localhost:3001
BACKEND_API_KEY=...
```

### Deep research tests timeout
This is normal - deep research can take 30-120 seconds. If it consistently fails:
1. Check your Perplexity API key
2. Check your internet connection
3. Try running just that test: `python test_deep_research.py`

### Tests pass locally but fail in pre-commit
Make sure your `.env` file is properly configured and the virtual environment is activated in the pre-commit hook script.

## CI/CD Integration

These tests are designed to run in CI/CD pipelines. Example GitHub Actions:

```yaml
- name: Run agent tool tests
  working-directory: ./agents
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    PERPLEXITY_API_KEY: ${{ secrets.PERPLEXITY_API_KEY }}
  run: |
    python -m pip install -r requirements.txt
    python tests/run_all_tests.py
```

## Maintenance

- **Keep tests fast** - Only test what's necessary
- **Mock external services** - When safe to do so
- **Update tests** - When tool interfaces change
- **Document skipped tests** - Explain why tests are skipped
- **Run tests before committing** - The pre-commit hook helps with this

