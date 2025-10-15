# Agent Tools Test Suite - Setup Complete ✅

## Summary

A comprehensive test suite has been created for all agent tools, modeled after the backend test structure.

## What Was Created

### 📁 Test Files (in `agents/tests/`)

1. **Individual Test Files:**
   - `test_web_search.py` - Tests web search tool and formatters
   - `test_deep_research.py` - Tests deep research tool and formatters
   - `test_amazon_shopping.py` - Tests Amazon shopping tool formatters
   - `test_request_user_attention.py` - Tests user attention tool formatters
   - `test_wait_seconds.py` - Tests wait seconds formatters
   - `test_spawn_sub_agents.py` - Tests sub-agent spawning formatters
   - `test_knowledge_base.py` - Tests blueprint/knowledge base formatters

2. **Test Infrastructure:**
   - `run_all_tests.py` - Main test runner (runs all tests)
   - `pre-commit-hook.sh` - Pre-commit hook script
   - `setup-pre-commit.sh` - Easy setup script for pre-commit hook
   - `README.md` - Complete testing documentation

3. **Rules:**
   - `.cursorrules/agents/testing` - Rule enforcing test creation for new tools

## Test Coverage

### ✅ Fully Tested
- **web_search** - Basic functionality + formatters + current events
- **wait_seconds** - Duration formatting + formatters
- **All formatters** - Pre/post message formatting for all tools

### ⚠️ Partially Tested (Formatters Only)
- **amazon_shopping** - Formatters only (MCP server required for full tests)
- **request_user_attention** - Formatters only (Temporal context required)
- **spawn_sub_agents** - Formatters only (Temporal/backend required)
- **knowledge_base** - Formatters only (Backend API required)

### 🕐 Slow Tests
- **deep_research** - Takes 30-120 seconds (legitimate delay)

## How to Use

### Run All Tests
```bash
cd agents/tests
python run_all_tests.py
```

### Run Individual Test
```bash
cd agents/tests
python test_web_search.py
python test_wait_seconds.py
# etc...
```

### Setup Pre-commit Hook (Recommended)
```bash
cd agents/tests
./setup-pre-commit.sh
```

This will automatically run tests before each commit and block commits if tests fail.

## Pre-commit Hook

The pre-commit hook:
- ✅ Runs all agent tool tests before commit
- ✅ Blocks commit if any test fails
- ✅ Can be bypassed with `--no-verify` (not recommended)

Manual installation:
```bash
ln -sf agents/tests/pre-commit-hook.sh .git/hooks/pre-commit
```

## Test Philosophy

We test:
1. ✅ All message formatters (required)
2. ✅ Core functionality (when safe)
3. ✅ Error handling

We skip:
1. ❌ Complex infrastructure dependencies
2. ❌ Real API calls with side effects
3. ❌ Tests requiring Temporal workflow context

## Adding New Tools - Checklist

When creating a new agent tool, you MUST:

1. [ ] Create `agents/tests/test_<tool_name>.py`
2. [ ] Test `format_pre_message()`
3. [ ] Test `format_post_message()` (success case)
4. [ ] Test `format_post_message()` (error case)
5. [ ] Test core functionality (if safe)
6. [ ] Add import to `run_all_tests.py`
7. [ ] Add test execution to appropriate runner function
8. [ ] Run full test suite: `python run_all_tests.py`
9. [ ] Document any skipped tests

See `.cursorrules/agents/testing` for complete requirements.

## Comparison to Backend Tests

### Backend Tests (`back-end/src/tests/`)
- ✅ Tests all API endpoints
- ✅ Requires backend server running
- ✅ Pre-commit hook setup
- ✅ Comprehensive README

### Agent Tests (`agents/tests/`)
- ✅ Tests all agent tools
- ✅ Runs independently (no server required for most)
- ✅ Pre-commit hook setup
- ✅ Comprehensive README
- ✅ Similar structure and philosophy

## Test Execution Time

- **Fast tests** (~5s): wait_seconds, spawn_sub_agents, request_user_attention, amazon_shopping, knowledge_base
- **Medium tests** (~10s): web_search
- **Slow tests** (~30-120s): deep_research

**Total:** ~1-2 minutes for full suite

## Example Test Output

```
======================================================================
🚀 AGENT TOOLS TEST SUITE
======================================================================

This test suite validates all agent tools including:
  • User tools: web_search, deep_research, amazon_shopping
  • System tools: wait_seconds, spawn_sub_agents, request_user_attention
  • Activities: knowledge_base (blueprints)

======================================================================

[... individual test output ...]

======================================================================
📊 TEST SUMMARY
======================================================================

  web_search                ✅ PASSED
  deep_research             ✅ PASSED
  amazon_shopping           ✅ PASSED
  request_user_attention    ✅ PASSED
  wait_seconds              ✅ PASSED
  spawn_sub_agents          ✅ PASSED
  knowledge_base            ✅ PASSED

----------------------------------------------------------------------
  Total: 7  |  Passed: 7  |  Failed: 0
======================================================================

🎉 ALL TESTS PASSED!
```

## Next Steps

1. **Install pre-commit hook** (recommended):
   ```bash
   cd agents/tests
   ./setup-pre-commit.sh
   ```

2. **Run tests to verify setup**:
   ```bash
   cd agents/tests
   python run_all_tests.py
   ```

3. **Review the testing rule**:
   - See `.cursorrules/agents/testing` for requirements
   - This ensures all new tools get tests

4. **Add to CI/CD** (future):
   - Tests are ready for GitHub Actions
   - See `agents/tests/README.md` for example config

## Questions?

See `agents/tests/README.md` for:
- Complete documentation
- Troubleshooting guide
- Test template
- Adding new tests
- CI/CD integration

---

**Created:** October 15, 2025
**Tools Tested:** 7 (web_search, deep_research, amazon_shopping, request_user_attention, wait_seconds, spawn_sub_agents, knowledge_base)
**Test Files:** 8 (7 individual + 1 runner)

