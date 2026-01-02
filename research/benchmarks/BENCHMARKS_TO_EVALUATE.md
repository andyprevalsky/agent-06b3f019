# Benchmarks to Evaluate

A running list of benchmarks we want to test our system against.

---

## Browser / Web Agent Benchmarks

### Summary Table

| Benchmark | SOTA | Popularity | Cost/Run | Integration |
|-----------|------|------------|----------|-------------|
| Online-Mind2Web | 83.6% (Lux) | ★★★★☆ | $9-$1,600 | MEDIUM |
| WebArena | 61.7% (IBM CUGA) | ★★★★★ | $500-$2,000 | HARD |
| VisualWebArena | 16.4% (GPT-4V+SoM) | ★★★★☆ | $1,000-$3,000 | HARD |
| RLI | 2.5% (Manus) | ★★★☆☆ | ~$7,200 | VERY HARD |

**Integration Priority**: Online-Mind2Web → WebArena → VisualWebArena → RLI

---

### Mind2Web / Online-Mind2Web
- **URL**: https://osu-nlp-group.github.io/Mind2Web/
- **Paper**: https://arxiv.org/abs/2306.06070
- **GitHub**: https://github.com/OSU-NLP-Group/Mind2Web
- **Online GitHub**: https://github.com/OSU-NLP-Group/Online-Mind2Web
- **Leaderboards**:
  - [HAL: Online Mind2Web](https://hal.cs.princeton.edu/online_mind2web)
  - [HuggingFace](https://huggingface.co/spaces/osunlp/Online_Mind2Web_Leaderboard)
- **Description**: Large-scale dataset for generalist web agents. Original: 2,000+ tasks across 137 websites (cached HTML). Online: 300 tasks across 136 live websites.
- **Tasks**: 300 (Online-Mind2Web, live websites)
- **Industry Standards** (Online-Mind2Web, 2025):
  - Lux (OpenAGI): 83.6%
  - Gemini CUA: 69.0%
  - OpenAI Operator: 61.3%
  - Claude Sonnet 4: 61.0%
  - SeeAct + GPT-5: 42.3%
  - Human baseline: ~88%
- **Popularity**: ★★★★☆ (High - NeurIPS 2023 spotlight, COLM 2025 for Online version)
- **Cost per run**: $9 (Gemini Flash) to $1,600 (Claude Sonnet 4) for 300 tasks
- **Integration difficulty**: MEDIUM (~1 week)
  - Browserbase CDP already supported
  - Live websites, no Docker needed
  - Need task loader + evaluator
- **Status**: [ ] Not started

### WebArena
- **URL**: https://webarena.dev/
- **GitHub**: https://github.com/web-arena-x/webarena
- **Leaderboard**: [Google Sheets](https://docs.google.com/spreadsheets/d/1M801lEpBbKSNwP-vDBkC_pF7LdyGU1f_ufZb_NWNBZQ)
- **Description**: Realistic web environment for autonomous agents. Self-hosted websites for reproducible evaluation.
- **Tasks**: 812 (self-hosted Docker containers)
- **Industry Standards** (2025):
  - IBM CUGA: 61.7%
  - OpenAI Operator: 58.0%
  - AWA 1.5 (Jace AI): 57.0%
  - Gemini 2.5 Pro: 54.8%
  - AWM (open-source): 35.5%
  - Human baseline: 78.2%
- **Popularity**: ★★★★★ (Very High - gold standard, every major lab reports)
- **Cost per run**: ~$500-2,000 estimated (812 tasks × $0.60-2.50/task)
- **Integration difficulty**: HARD (~2 weeks)
  - 5+ Docker containers (Shopping, Reddit, GitLab, Map, Wikipedia)
  - Significant infrastructure setup
  - Reproducible but complex
- **Status**: [ ] Not started

### VisualWebArena
- **URL**: https://jykoh.com/vwa
- **GitHub**: https://github.com/web-arena-x/visualwebarena
- **Leaderboard**: [Project Page](https://jykoh.com/vwa)
- **Description**: Extension of WebArena with visually-grounded tasks. Tests multimodal agent capabilities.
- **Tasks**: 910 (vision-grounded)
- **Industry Standards** (2024-2025):
  - GPT-4V + SoM: 16.4%
  - Gemini-Pro: ~14%
  - GPT-4o: ~13%
  - GPT-4 Turbo: ~12%
  - Mixtral-8x7B: ~8%
  - Human baseline: 88.7%
- **Popularity**: ★★★★☆ (High - ACL 2024, tests multimodal)
- **Cost per run**: ~$1,000-3,000 estimated (910 tasks with vision tokens)
- **Integration difficulty**: HARD (~2 weeks)
  - Same Docker setup as WebArena
  - Additional Classifieds/Reddit/Wikipedia containers
  - Python 3.10/3.11 required (not 3.12)
- **Status**: [ ] Not started

### Remote Labor Index (RLI)
- **URL**: https://www.remotelabor.ai
- **Paper**: https://arxiv.org/abs/2510.26787
- **GitHub**: https://github.com/centerforaisafety/rli_evaluation_platform
- **Leaderboard**: [Scale AI RLI](https://scale.com/leaderboard/rli)
- **Description**: Real-world, economically valuable remote-work projects from Upwork. Tests end-to-end agent performance on tasks spanning game development, product design, architecture, data analysis, video animation, etc. 6,000+ hours of work valued at $143,991.
- **Tasks**: 240 real Upwork projects (median 11.5 hours, mean 28.9 hours per task)
- **Industry Standards** (2025):
  - Manus 1.5: 2.50% (ELO: 518)
  - Manus 1.0: 2.50% (ELO: 510)
  - Claude Sonnet 4.5: 2.08% (ELO: 442)
  - GPT-5: 1.67% (ELO: 437)
  - ChatGPT Agent: 1.25% (ELO: 454)
  - Human baseline: 100%
- **Popularity**: ★★★☆☆ (Medium - emerging, Scale AI backed)
- **Cost per run**: ~$7,200 ($30/task budget × 240 tasks)
- **Integration difficulty**: VERY HARD (~1 month+)
  - Multi-hour tasks (median 11.5 hours per task)
  - CLI (OpenHands) + GUI environments needed
  - Manual expert evaluation required
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
