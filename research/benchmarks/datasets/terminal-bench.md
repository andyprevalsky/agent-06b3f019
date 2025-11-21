# Terminal-Bench Dataset

Terminal-Bench is a benchmark for AI agents in terminal environments from [tbench.ai](https://www.tbench.ai).

## Overview

- **Total Tasks**: 47 (Terminal-Bench Hard)
- **Categories**: 
  - System Administration
  - Security
  - Data Processing
  - Model Training
  - File Operations
  - Version Control

## Sample Tasks

1. **build-linux-kernel-qemu** (Medium)
   - Build Linux kernel from source
   - Add custom kernel message
   - Run with QEMU

2. **configure-git-webserver** (Hard)
   - Configure git server with auto-deploy
   - Setup webserver on port 8080
   - Enable push-to-deploy workflow

3. **crack-7z-hash** (Medium)
   - Extract password from encrypted archive
   - Write solution to file

## Evaluation

Terminal-Bench tasks are evaluated by:
1. Executing agent's commands in sandboxed environment
2. Running test suites to verify completion
3. Checking for repetition loops (stuck agents)

## Integration

The Terminal-Bench harness is implemented at:
`/research/benchmarks/harnesses/terminal-bench.ts`

To run Terminal-Bench:
```bash
deno run --allow-net --allow-env test-runner.ts \
  --url https://your-model-url.com \
  --key your-api-key \
  --benchmarks Terminal-Bench
```

## Data Sources

- Official Website: https://www.tbench.ai
- Task Registry: https://www.tbench.ai/tasks
- Leaderboard: https://www.tbench.ai/leaderboard

## Notes

- Terminal-Bench requires actual command execution
- Current implementation uses sample tasks for testing
- Full integration requires Docker/sandbox environment
- Repetition detection uses 99% similarity threshold with 3+ loops
