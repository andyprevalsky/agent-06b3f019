# Benchmarks to Evaluate

A running list of benchmarks we want to test our system against.

---

## Browser / Web Agent Benchmarks

### Mind2Web
- **URL**: https://osu-nlp-group.github.io/Mind2Web/
- **Paper**: https://arxiv.org/abs/2306.06070
- **GitHub**: https://github.com/OSU-NLP-Group/Mind2Web
- **Description**: Large-scale dataset for generalist web agents. 2,000+ open-ended tasks across 137 real-world websites.
- **Status**: [ ] Not started

### Remote Labor Index (RLI)
- **URL**: https://www.remotelabor.ai
- **Paper**: https://arxiv.org/abs/2510.26787
- **GitHub**: https://github.com/centerforaisafety/RLI (check)
- **Description**: Real-world, economically valuable remote-work projects. Tests end-to-end agent performance on tasks spanning game development, product design, architecture, data analysis, video animation, etc. 6,000+ hours of work valued at $140k+. Current SOTA (Manus) achieves only 2.5% automation rate.
- **Status**: [ ] Not started

### WebArena
- **URL**: https://webarena.dev/
- **GitHub**: https://github.com/web-arena-x/webarena
- **Description**: Realistic web environment for autonomous agents. Self-hosted websites for reproducible evaluation.
- **Status**: [ ] Not started

### VisualWebArena
- **URL**: https://jykoh.com/vwa
- **Description**: Extension of WebArena with visually-grounded tasks.
- **Status**: [ ] Not started

---

## Terminal / CLI Benchmarks

### Terminal-Bench Hard
- **URL**: https://www.tbench.ai
- **GitHub**: https://github.com/terminal-bench/terminal-bench
- **Description**: AI agents in terminal environments. 47 tasks covering system administration, security, data processing.
- **Code**: `harnesses/terminal-bench.ts`, `back-end/src/benchmarks/harnesses/terminal-bench.ts`
- **Industry Standards** (from `standards.json`):
  - GPT-4o: 65% (2024-11)
  - Claude Sonnet 3.5: 62% (2024-11)
- **Status**: [x] Implemented

---

## Coding Benchmarks

### SWE-Bench Verified
- **URL**: https://www.swebench.com/
- **GitHub**: https://github.com/princeton-nlp/SWE-bench
- **Description**: 300 verified GitHub issues for testing real-world software engineering capabilities.
- **Enum**: `SWE_BENCH = "swe-bench"`
- **Evaluator**: Requires CodeEvaluator
- **Status**: [ ] Not started

### LiveCodeBench
- **GitHub**: https://github.com/LiveCodeBench/LiveCodeBench
- **Description**: 315 competitive programming problems.
- **Enum**: `LIVECODEBENCH = "livecodebench"`
- **Evaluator**: Requires CodeEvaluator
- **Status**: [ ] Not started

### SciCode
- **GitHub**: https://github.com/scicode-bench/SciCode
- **Description**: 338 scientific computing subproblems.
- **Enum**: `SCICODE = "scicode"`
- **Evaluator**: Requires CodeEvaluator
- **Status**: [ ] Not started

---

## Knowledge / Reasoning Benchmarks

### MMLU-Pro
- **Source**: HuggingFace `TIGER-Lab/MMLU-Pro`
- **URL**: https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro
- **Description**: 12,032 graduate-level multiple choice questions (10 options each) across 14 subjects.
- **Code**: `harnesses/mmlu-pro.ts`, `back-end/src/benchmarks/harnesses/mmlu-pro.ts`
- **Enum**: `MMLU_PRO = "mmlu-pro"`
- **Industry Standards** (from `standards.json`):
  - DeepSeek-R1: 84% (2025-01, with CoT)
  - Claude Sonnet 3.5: 78% (2024-06, with CoT)
  - GPT-4o: 72.6% (2024-05, with CoT)
  - GPT-4o: 53.5% (2024-05, no CoT baseline)
- **Status**: [x] Implemented

### GPQA Diamond
- **GitHub**: https://github.com/idavidrein/gpqa
- **Description**: 198 graduate-level science questions (physics, chemistry, biology).
- **Enum**: `GPQA_DIAMOND = "gpqa-diamond"`
- **Status**: [ ] Not started

### Humanity's Last Exam (HLE)
- **GitHub**: https://github.com/centerforaisafety/HLE
- **Description**: 2,684 extremely difficult questions designed by domain experts.
- **Enum**: `HLE = "hle"`
- **Evaluator**: Requires EqualityChecker
- **Status**: [ ] Not started

### AIME 2025
- **URL**: https://artofproblemsolving.com/wiki/index.php/2025_AIME_Problems
- **Description**: 30 math competition problems from American Invitational Mathematics Examination.
- **Enum**: `AIME_2025 = "aime-2025"`
- **Evaluator**: Requires MathEvaluator
- **Note**: Requires manual transcription
- **Status**: [ ] Not started

### IFBench (Instruction Following)
- **GitHub**: https://github.com/Instruction-Following-Eval/IFBench
- **Description**: 294 instruction following evaluation questions.
- **Enum**: `IFBENCH = "ifbench"`
- **Status**: [ ] Not started

### AA-LCR (Artificial Analysis Long Context Reasoning)
- **URL**: https://artificialanalysis.ai
- **Description**: 100 long-context reasoning questions.
- **Enum**: `AA_LCR = "aa-lcr"`
- **Evaluator**: Requires EqualityChecker
- **Note**: May need to be recreated if not publicly available
- **Status**: [ ] Not started

---

## Other Agent Benchmarks

### τ²-Bench (Tau-Bench) Telecom
- **GitHub**: https://github.com/tau2-bench/tau2-bench
- **Description**: 114 telecom agent tasks.
- **Enum**: `TAU2_BENCH = "tau2-bench"`
- **Evaluator**: Requires RepetitionChecker
- **Status**: [ ] Not started

### AgentBench
- **URL**: https://llmbench.ai/agent
- **Description**: Multi-dimensional agent evaluation across 8 environments.
- **Status**: [ ] Not started

### GAIA
- **URL**: https://huggingface.co/gaia-benchmark
- **Description**: General AI Assistants benchmark - real-world questions requiring multi-step reasoning.
- **Status**: [ ] Not started

---

## Benchmark Enum (from codebase)

```typescript
// From ROSE_BENCHMARK_PLAN_V2.md
enum BenchmarkType {
  MMLU_PRO = "mmlu-pro",           // 12,032 questions - Multiple choice
  TERMINAL_BENCH = "terminal-bench", // 47 tasks - Terminal commands
  GPQA_DIAMOND = "gpqa-diamond",   // Graduate-level science
  AIME_2025 = "aime-2025",         // Math competition (requires MathEvaluator)
  HLE = "hle",                     // Human-like evaluation (requires EqualityChecker)
  IFBENCH = "ifbench",             // Instruction following
  SCICODE = "scicode",             // Scientific code (requires CodeEvaluator)
  LIVECODEBENCH = "livecodebench", // Live code bench (requires CodeEvaluator)
  SWE_BENCH = "swe-bench",         // Software engineering (requires CodeEvaluator)
  TAU2_BENCH = "tau2-bench",       // Telecom (requires RepetitionChecker)
  AA_LCR = "aa-lcr",               // AA Long-context recall (requires EqualityChecker)
  FULL = "full"                    // Run all benchmarks sequentially
}

// Implementation status
const IMPLEMENTED_BENCHMARKS = [
  BenchmarkType.MMLU_PRO,
  BenchmarkType.TERMINAL_BENCH
];
```

---

## Notes

- **Priority for Navi**: Browser/web agent benchmarks (Mind2Web, RLI, WebArena) are most relevant to our core use case
- **RLI** is particularly interesting because it tests real economic value, not just capability
- **Evaluators needed**:
  - `EqualityChecker` - GPT-4o semantic equivalence (for HLE, AA-LCR)
  - `MathEvaluator` - `\boxed{}` extraction (for AIME)
  - `CodeEvaluator` - Docker sandbox (for SciCode, LiveCodeBench, SWE-Bench)
  - `RepetitionChecker` - Detects agent loops (for Terminal-Bench, Tau-Bench)

---

## Code Locations

- **Harness base class**: `research/benchmarks/harnesses/base.ts`
- **Test runner**: `research/benchmarks/test-runner.ts`
- **Industry standards**: `research/benchmarks/standards.json`, `back-end/benchmarks/standards.json`
- **Dataset info**: `research/benchmarks/datasets/README.md`
