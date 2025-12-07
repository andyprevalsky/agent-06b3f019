# Terminal-Bench + Rose Integration

## Overview

Terminal-Bench now uses Rose models through a **custom Harbor agent** that calls the Rose completions API.

## Architecture

```
User Request
    ↓
POST /v1/bench {benchmark: "terminal-bench", model: "rose-labs/rose-1-fast"}
    ↓
Terminal-Bench Harness
    ↓
Harbor + Rose Agent (custom)
    ↓
Rose Completions API (/functions/v1/completions)
    ↓
Rose Model Pool (backend routing)
    ↓
OpenRouter / Anthropic
```

## Key Components

### 1. Rose Agent (`/src/benchmarks/agents/rose_agent.py`)

Custom Harbor agent that:
- Calls Rose completions API instead of Anthropic directly
- Uses agentic loop: observe → think → act → repeat
- Extracts bash commands from model responses
- Executes commands in Daytona container
- Supports any Rose model (`rose-labs/rose-1-fast`, `rose-labs/rose-1`, etc.)

### 2. Patched Terminal-Bench Tasks (`/tmp/terminal-bench-2`)

All 89 tasks patched to:
- Pre-install `uv` in Docker images (fixes Daytona network restrictions)
- Force Dockerfile builds instead of using prebuilt images

Patch script: `/src/benchmarks/patch-terminal-bench.sh`

### 3. HarborClient (`/src/benchmarks/harbor-client.ts`)

TypeScript wrapper that:
- Supports `--agent-import-path` for custom agents
- Passes Rose API credentials as environment variables
- Handles local task paths for patched tasks

## API Usage

### Same as MMLU-Pro!

```bash
curl -X POST http://localhost:3001/v1/bench \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "x-api-key: $ROSE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "benchmark": "terminal-bench",
    "model": "rose-labs/rose-1-fast",
    "cotSteps": 1,
    "samples": 3,
    "seed": 42
  }'
```

### Response Format

```json
{
  "benchmarkName": "Terminal-Bench 2.0",
  "accuracy": 33.3,
  "correctAnswers": 1,
  "totalQuestions": 3,
  "sampledQuestions": 3,
  "cotSteps": 1,
  "avgDurationMs": 120000,
  "totalCostCents": 0,
  "durationSeconds": 360,
  "industryComparison": {
    "Claude Sonnet 4.5": 58.4,
    "GPT-4o": 51.7
  },
  "results": [
    {
      "questionId": "pypi-server",
      "cotResponses": ["..."],
      "extractedAnswer": "pass",
      "correctAnswer": "pass",
      "isCorrect": true,
      "durationMs": 120000,
      "costCents": 0
    }
  ]
}
```

## Environment Variables

Required in backend `.env`:

```bash
# Daytona (cloud container runtime)
DAYTONA_API_KEY=dtn_xxx

# Rose API
ROSE_API_KEY=your-rose-key
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxx

# Optional
ROSE_MAX_ITERATIONS=25  # Max agent iterations per task
MAX_SAMPLES_PER_BENCH=100
```

## Benefits

✅ **Same interface as MMLU-Pro**
- Both benchmarks use Rose models
- Same request/response format
- Consistent pricing and routing

✅ **Full Rose ecosystem support**
- All Rose models work (fast, standard, premium)
- Backend handles model selection
- Automatic failover and load balancing

✅ **Production ready**
- Verifiers work (uv pre-installed)
- Error handling and timeouts
- Database logging

✅ **Scalable**
- Daytona handles containerization
- Sequential task execution (parallel coming soon)
- Configurable iterations and timeouts

## Testing

### Quick test (pypi-server task only):
```bash
cd /Users/andyprevalsky/Desktop/projects/navi-whisper-lux/back-end
bash test-rose-agent.sh
```

### Full integration test:
```bash
cd /Users/andyprevalsky/Desktop/projects/navi-whisper-lux/research
deno test --allow-net --allow-env tests/rose-bench.test.ts
```

## Troubleshooting

### "Rose agent not found"
- Ensure `rose_agent.py` exists in `/src/benchmarks/agents/`
- Check `agentImportPath` points to correct file

### "ROSE_API_KEY not set"
- Export `ROSE_API_KEY` before running Harbor
- Check backend `.env` file

### "Verifier fails with uvx not found"
- Run patch script: `bash src/benchmarks/patch-terminal-bench.sh`
- Use `--force-build` flag to rebuild Docker images

### "Task timeout"
- Increase `ROSE_MAX_ITERATIONS` (default: 25)
- Check Rose API is responding
- Verify Daytona credentials

## Next Steps

1. ✅ Implement Rose agent
2. ✅ Update Terminal-Bench harness
3. ✅ Test with single task
4. 🔲 Run full test suite
5. 🔲 Deploy to production
6. 🔲 Add parallel execution support






