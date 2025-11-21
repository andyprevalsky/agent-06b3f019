# Rose Benchmark Suite

Comprehensive benchmarking harnesses for evaluating Rose models.

## Quick Start

### Running a Benchmark

```bash
# Set environment variables
export API_KEY="your-rose-api-key"
export MODEL_URL="https://your-project.supabase.co/functions/v1/rose-chat"

# Run MMLU-Pro benchmark (10 questions for testing)
deno run --allow-net --allow-env test-runner.ts
```

### Using in TypeScript

```typescript
import { runBenchmarkSuite } from './test-runner.ts';

const results = await runBenchmarkSuite({
  modelUrl: "https://your-project.supabase.co/functions/v1/rose-chat",
  authHeaders: {
    "x-api-key": "your-api-key-here"
  },
  benchmarks: ["MMLU-Pro"],
  sampleSize: 100,  // Default: 100 questions
  sampleSeed: 42,   // For reproducibility
  cotSteps: 1       // Chain-of-thought steps
});

console.log(results);
```

## Available Benchmarks

### Currently Implemented

1. **MMLU-Pro** - Multiple choice questions (10 options)
   - Sample implementation with 3 questions
   - Full dataset: 12,032 questions
   - Default sample: 100 questions (configurable via `MAX_SAMPLES_PER_BENCH`)

2. **Terminal-Bench** - AI agents in terminal environments ([tbench.ai](https://www.tbench.ai))
   - Sample implementation with 3 tasks
   - Full dataset: 47 tasks (Terminal-Bench Hard)
   - Tests system administration, security, data processing, etc.
   - Uses repetition checker to detect stuck agents

### Coming Soon

2. **GPQA Diamond** - Graduate-level science questions
3. **AIME 2025** - Math competition problems
4. **HLE** - Humanity's Last Exam
5. **IFBench** - Instruction following
6. **SciCode** - Code generation (scientific)
7. **LiveCodeBench** - Code generation (competitive)
8. **SWE-Bench** - Software engineering
9. **Terminal-Bench** - Terminal/CLI tasks
10. **τ²-Bench** - Telecom agent tasks
11. **AA-LCR** - Long context reasoning

## Evaluators

### Equality Checker
Uses GPT-4o to check semantic equivalence.

```typescript
import { checkEquality } from './evaluators/equality-checker.ts';

const isCorrect = await checkEquality(
  "The capital of France is Paris",
  "Paris",
  "What is the capital of France?"
);
```

### Math Evaluator
Extracts answers from `\boxed{}` and normalizes.

```typescript
import { evaluateMathAnswer } from './evaluators/math-evaluator.ts';

const isCorrect = await evaluateMathAnswer(
  "The answer is \\boxed{42}",
  "42"
);
```

### Repetition Checker
Detects agent loops algorithmically.

```typescript
import { checkRepetition } from './evaluators/repetition-checker.ts';

const isStuck = checkRepetition([
  "Let me search for that",
  "Let me search for that",
  "Let me search for that",
  "Let me search for that"
]);
// Returns: true (3+ consecutive similar messages)
```

### Code Evaluator
Docker sandbox for code execution (placeholder).

```typescript
import { evaluateCode } from './evaluators/code-evaluator.ts';

// TODO: Implement Docker sandbox
```

## Configuration

### BenchmarkConfig

```typescript
interface BenchmarkConfig {
  modelUrl: string;         // API endpoint
  apiKey: string;           // Authentication key
  temperature?: number;     // Default: 0.7
  maxTokens?: number;       // Default: 2000
  repeats?: number;         // Override default repeats
  cotSteps?: number;        // Chain-of-thought steps (1-30)
  sampleSize?: number;      // Questions to sample (default: 100)
  sampleSeed?: number;      // Random seed (default: 42)
}
```

## Adding New Benchmarks

1. Create a new harness in `harnesses/`:

```typescript
import { BaseBenchmarkHarness, BenchmarkQuestion } from './base.ts';

export class MyBenchmarkHarness extends BaseBenchmarkHarness {
  readonly name = "My Benchmark";
  readonly description = "Description here";
  readonly questionCount = 1000;
  readonly defaultRepeats = 1;
  
  async loadDataset(): Promise<BenchmarkQuestion[]> {
    // Load your dataset
  }
  
  formatPrompt(question: BenchmarkQuestion): string {
    // Format the prompt
  }
  
  extractAnswer(modelResponse: string): string {
    // Extract the answer
  }
  
  async evaluateAnswer(extracted: string, correct: string): Promise<boolean> {
    // Evaluate if correct
  }
}
```

2. Register in `test-runner.ts`:

```typescript
const BENCHMARK_REGISTRY = {
  'My Benchmark': () => new MyBenchmarkHarness(),
  // ...
};
```

## Dataset Management

See `/datasets/README.md` for instructions on obtaining benchmark datasets.

## Cost Estimates

Running the full suite (100 questions per benchmark):
- MMLU-Pro: ~$0.08
- GPQA Diamond: ~$0.65
- AIME 2025: ~$0.48
- Others: ~$1-7 each

**Total estimated cost for 100-question samples: ~$18**

Full benchmarks (all questions): ~$51

## Environment Variables

Required:
```bash
ROSELABS_API_KEY=<your-openrouter-key>  # For evaluators
API_KEY=<your-rose-api-key>             # For model access
MODEL_URL=<your-model-endpoint>
```

Optional:
```bash
CODE_SANDBOX_ENDPOINT=<docker-sandbox-url>
MAX_SAMPLES_PER_BENCH=100              # Override default sample size per benchmark
```

The `MAX_SAMPLES_PER_BENCH` environment variable controls how many questions are sampled from each benchmark dataset. This is useful for:
- **Development**: Set to 10 for quick testing
- **CI/CD**: Set to 50 for automated testing
- **Production**: Set to 100+ for thorough evaluation

Example:
```bash
# Quick test with 10 questions
MAX_SAMPLES_PER_BENCH=10 deno run --allow-net --allow-env test-runner.ts

# Full evaluation with 200 questions
MAX_SAMPLES_PER_BENCH=200 API_KEY=<key> MODEL_URL=<url> deno run --allow-net --allow-env test-runner.ts
```

