# Terminal-Bench + Rose Integration - Test Status

## ✅ What's Completed

### 1. Custom Rose Agent Created
**File**: `/src/benchmarks/agents/rose_agent.py`
- ✅ Implements Harbor's `BaseAgent` interface
- ✅ Calls Rose completions API (not Anthropic directly)
- ✅ Agentic loop: observe → think → act → repeat
- ✅ Extracts bash commands from model responses
- ✅ Executes in Daytona containers

### 2. Harbor Integration Updated
- ✅ `HarborClient` supports `--agent-import-path`
- ✅ Passes Rose API credentials as environment variables
- ✅ Terminal-Bench harness uses custom Rose agent
- ✅ Agent installed in Harbor's agents directory

### 3. Installation Script
**File**: `/scripts/install-rose-agent.sh`
- ✅ Copies Rose agent to Harbor's site-packages
- ✅ Run once: `bash scripts/install-rose-agent.sh`

### 4. Patched Terminal-Bench Tasks
- ✅ All 89 tasks patched with uv pre-installed
- ✅ Verifiers work (no network download failures)
- ✅ Located at `/tmp/terminal-bench-2`

## 🧪 Test Status

### What Was Tested
- ✅ Agent file created and copied to Harbor
- ✅ Harbor can find the agent (import path works)
- ⏸️ Full end-to-end test pending

### Current Blocker
Harbor loads the agent config correctly but the agent execution hasn't been fully validated yet. The agent shows as `name: null` in the config, which typically means:
1. Import path is correct BUT
2. Agent may need additional dependencies or
3. Agent class needs to match Harbor's expected interface exactly

## 🎯 Next Steps

### Option 1: Debug Agent Loading (Recommended)
```bash
# Check Harbor logs for why agent name is null
cd /tmp/terminal-bench-2
LATEST_JOB=$(ls -t jobs/ | head -1)
cat jobs/$LATEST_JOB/pypi-server*/trial.log

# Try running with debug flag
harbor run --path pypi-server \
  --agent-import-path harbor.agents.installed.rose_agent:RoseAgent \
  -m rose-labs/rose-1-fast \
  --env daytona \
  --debug
```

### Option 2: Simplify Agent (If needed)
The Rose agent might need adjustments to match Harbor's interface exactly. Compare with:
```bash
cat ~/.local/share/uv/tools/harbor/lib/python3.13/site-packages/harbor/agents/installed/claude_code.py
```

### Option 3: Use Existing Agent + Proxy
Alternative approach: Run Claude Code agent but proxy Anthropic API calls through Rose API using environment variables or a local proxy.

## 📋 API Interface (Ready)

The `/v1/bench` endpoint is ready to use Rose models:

```bash
curl -X POST http://localhost:3001/v1/bench \
  -H "Authorization: Bearer $JWT" \
  -H "x-api-key: $ROSE_API_KEY" \
  -d '{
    "benchmark": "terminal-bench",
    "model": "rose-labs/rose-1-fast",
    "samples": 3
  }'
```

## 🔧 Environment Variables

Required in backend `.env`:
```bash
DAYTONA_API_KEY=dtn_xxx
ROSE_API_KEY=your-key
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxx
ROSE_MAX_ITERATIONS=25
```

## 📊 Expected Behavior

When working correctly:
1. User calls `/v1/bench` with Rose model name
2. Terminal-Bench harness runs Harbor with Rose agent
3. Rose agent calls Rose completions API (not Anthropic)
4. Backend routes to best available model via OpenRouter
5. Agent executes bash commands in Daytona container
6. Verifier validates results (uv works!)
7. Results logged to database with industry comparison

## 🎯 Success Criteria

- [ ] Agent loads successfully (name != null)
- [ ] Rose API receives requests from agent
- [ ] Agent can execute bash commands
- [ ] Verifier runs successfully
- [ ] Results match expected format
- [ ] Integration test passes

## 🚀 Once Working

Add to `package.json` scripts:
```json
{
  "postinstall": "bash scripts/install-rose-agent.sh"
}
```

This ensures Rose agent is installed whenever dependencies are updated.



