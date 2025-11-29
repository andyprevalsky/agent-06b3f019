# Terminal-Bench Integration Setup

## Overview

Terminal-Bench has been integrated using Harbor Framework for containerized, real command execution. Unlike MMLU-Pro (text-based), Terminal-Bench runs actual commands in isolated Daytona cloud containers.

## What Was Implemented

### 1. Harbor Client (`harbor-client.ts`)
- TypeScript wrapper for Harbor Python CLI
- Supports both `harbor` command (uv tool) and `python3 -m harbor` fallback
- Handles Daytona cloud container orchestration
- Parses Harbor's JSON output into our format

### 2. Terminal-Bench Harness (`harnesses/terminal-bench.ts`)
- Refactored to use Harbor integration
- Loads Terminal-Bench 2.0 dataset (89 tasks)
- `runTask()` method delegates to Harbor for actual execution
- Returns pass/fail from Harbor's automated test scripts
- Falls back to sample tasks if Harbor not installed

### 3. Backend Endpoint (`routes/rose.ts`)
- Branches execution path:
  - **Terminal-Bench**: Harbor containerized execution (Daytona)
  - **MMLU-Pro**: Text-based LLM CoT loop (existing)
- Same API interface for both benchmarks
- Returns consistent response format

### 4. Tests (`research/tests/rose-bench.test.ts`)
- Updated Terminal-Bench test with comprehensive checks
- Verifies same response format as MMLU-Pro
- Gracefully skips if DAYTONA_API_KEY not set
- Documents increased duration for container-based tests

## Setup Instructions

### Step 1: Install Harbor

Harbor is not yet on PyPI. Install via `uv`:

```bash
# Install uv (Python package manager)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install Harbor
uv tool install harbor

# Verify installation
harbor --version
```

Or from the Harbor GitHub repository (if available):
```bash
git clone https://github.com/harborframework/harbor
cd harbor
pip install -e .
```

Check installation:
```bash
npm run harbor:check
```

### Step 2: Add Daytona API Key

Add to `/Users/andyprevalsky/Desktop/projects/navi-whisper-lux/back-end/.env`:

```bash
DAYTONA_API_KEY=dtn_6f10715d7345cf314d93a85002c60872d11d26e19b7daa1325582ec81664f4c6
```

### Step 3: Test the Integration

Run the backend:
```bash
cd /Users/andyprevalsky/Desktop/projects/navi-whisper-lux/back-end
npm run dev
```

Run Terminal-Bench test (from /research):
```bash
cd /Users/andyprevalsky/Desktop/projects/navi-whisper-lux/research
export DAYTONA_API_KEY="dtn_6f10715d7345cf314d93a85002c60872d11d26e19b7daa1325582ec81664f4c6"
export ROSE_API_KEY="your-rose-api-key"
deno test --allow-net --allow-env --no-config tests/rose-bench.test.ts
```

### Step 4: API Usage

Same interface as MMLU-Pro:

```bash
POST /v1/bench
{
  "benchmark": "terminal-bench",
  "model": "rose-labs/rose-1-fast",
  "samples": 3,
  "cotSteps": 1,
  "seed": 42
}
```

Response format (identical to MMLU-Pro):
```json
{
  "benchmarkName": "Terminal-Bench 2.0",
  "model": "rose-labs/rose-1-fast",
  "accuracy": 66.67,
  "sampledQuestions": 3,
  "totalQuestions": 89,
  "correctAnswers": 2,
  "avgDurationMs": 15000,
  "totalCostCents": 0,
  "results": [...],
  "industryComparison": {...}
}
```

## Key Differences from MMLU-Pro

| Aspect | MMLU-Pro | Terminal-Bench |
|--------|----------|----------------|
| Execution | Text-based LLM calls | Containerized command execution |
| Runtime | Supabase Edge Functions | Daytona cloud containers (via Harbor) |
| Evaluation | Text matching | Automated test scripts |
| Duration | ~2-5s per question | ~10-30s per task |
| Cost Tracking | Token-based | Not yet available from Harbor |
| CoT Steps | Multiple LLM calls | Single Harbor agent run (CoT handled internally) |

## Known Limitations

1. **Harbor not yet on PyPI**: Must install via uv or from source
2. **Harbor dataset parsing**: Currently using placeholder task IDs; need to parse actual Harbor dataset structure
3. **CoT integration**: CoT parameter doesn't affect Terminal-Bench yet (Harbor agents handle reasoning internally)
4. **Cost tracking**: Harbor doesn't provide token/cost breakdown yet
5. **Batch processing**: Terminal-Bench runs sequentially (one task at a time) due to container overhead

## Future Improvements

1. Parse actual Harbor dataset registry for real Terminal-Bench 2.0 tasks
2. Implement proper CoT orchestration for Terminal-Bench (run Harbor multiple times per task?)
3. Add cost tracking once Harbor exposes token usage
4. Optimize batch processing for Harbor tasks
5. Add more Harbor agents (not just claude-code)
6. Support Modal as alternative to Daytona

## Troubleshooting

**Harbor not found:**
```bash
npm run harbor:install  # Shows installation instructions
npm run harbor:check    # Verifies installation
```

**DAYTONA_API_KEY not set:**
- Test will skip gracefully with warning
- Add key to backend .env file
- Verify key is loaded: `echo $DAYTONA_API_KEY`

**Harbor execution fails:**
- Check Harbor logs in terminal
- Verify Daytona API key is valid
- Try running Harbor directly: `harbor run -d terminal-bench@2.0 -a oracle`

**Tests timing out:**
- Terminal-Bench tasks take 10-30s each (containers are slower)
- Sample size of 3 should complete in ~1-2 minutes
- Use smaller sample sizes for faster iteration

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         POST /v1/bench                       │
│                     {benchmark: "terminal-bench"}            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
          ┌────────────────────────────────────┐
          │  Backend (rose.ts)                 │
          │  - Routes to Harbor path           │
          │  - Samples N tasks from dataset    │
          └────────────────┬───────────────────┘
                           │
                           ▼
          ┌────────────────────────────────────┐
          │  TerminalBenchHarness              │
          │  - runTask() for each sampled task │
          └────────────────┬───────────────────┘
                           │
                           ▼
          ┌────────────────────────────────────┐
          │  HarborClient                      │
          │  - Spawns Harbor Python CLI        │
          │  - Passes Daytona API key          │
          └────────────────┬───────────────────┘
                           │
                           ▼
          ┌────────────────────────────────────┐
          │  Harbor Framework (Python)         │
          │  - Spins up Daytona container      │
          │  - Runs claude-code agent          │
          │  - Executes commands in container  │
          │  - Runs test scripts               │
          └────────────────┬───────────────────┘
                           │
                           ▼
          ┌────────────────────────────────────┐
          │  Daytona Cloud Container           │
          │  - Isolated Ubuntu environment     │
          │  - Real command execution          │
          │  - Test script verification        │
          └────────────────┬───────────────────┘
                           │
                           ▼
                     Pass/Fail Result
                           │
                           ▼
          ┌────────────────────────────────────┐
          │  Backend Response                  │
          │  - Same format as MMLU-Pro         │
          │  - Logged to BenchmarkRun DB       │
          └────────────────────────────────────┘
```

## Resources

- [Harbor Framework Docs](https://harborframework.com/docs)
- [Terminal-Bench Leaderboard](https://tbench.ai)
- [Daytona Platform](https://daytona.io)






