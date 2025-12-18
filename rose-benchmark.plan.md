<!-- 474392da-5b35-4f4d-8a34-da5e6665de5c a3abd41b-1c80-4ff6-8d6f-51fcc9520aef -->
# Rose Benchmarking Suite - Schema-First Architecture

## SCHEMAS & CONTRACTS (DEFINE FIRST)

### 1. Database Schema (Prisma)

```prisma
model RoseApiKey {
  id        String   @id @default(uuid())
  userId    String   // Supabase user ID (required)
  apiKey    String   @unique // Generated 32-char key
  name      String?  // Optional descriptive name
  createdAt DateTime @default(now())
  
  logs RoseApiKeyLog[]
  
  @@index([userId])
  @@index([apiKey])
}

model RoseApiKeyLog {
  id        String   @id @default(uuid())
  apiKeyId  String   // FK to RoseApiKey
  userId    String   // Denormalized for fast queries
  input     Json     // Full request payload
  output    Json     // Full response data
  costCents Int      // Cost in cents
  cotSteps  Int      @default(1) // Track CoT steps used
  createdAt DateTime @default(now())
  
  apiKey RoseApiKey @relation(fields: [apiKeyId], references: [id], onDelete: Cascade)
  
  @@index([apiKeyId])
  @@index([userId])
  @@index([createdAt])
}

model BenchmarkRun {
  id               String   @id @default(uuid())
  userId           String   // User who initiated run
  benchmarkName    String   // e.g., "MMLU-Pro", "Terminal-Bench"
  modelConfig      Json     // Model configuration
  results          Json     // Detailed results by question
  aggregateScore   Float    // Overall score (0-100)
  totalCostCents   Int      // Total cost of run
  sampledQuestions Int      // How many questions actually run
  durationSeconds  Int      // Runtime duration
  createdAt        DateTime @default(now())
  
  @@index([userId])
  @@index([benchmarkName])
  @@index([createdAt])
}
```

---

### 2. API Endpoints (All under /rose/ prefix)

#### POST /rose/completions

**Purpose**: OpenAI-compatible chat completions with CoT, streaming, tool calls, and seed support

**Request Headers**:
```typescript
{
  "x-api-key": string;  // Required: RoseApiKey
  "Content-Type": "application/json";
}
```

**Request Body** (OpenAI-compatible):
```typescript
interface RoseCompletionsRequest {
  model: string;              // e.g., "rose-labs/rose-1-lite"
  messages: Message[];        // Array of chat messages
  temperature?: number;       // Default: 0.7
  max_tokens?: number;        // Default: 2000
  seed?: number;              // For reproducible outputs
  stream?: boolean;           // Default: false (SSE streaming)
  tools?: Tool[];             // OpenAI tool definitions
  tool_choice?: string | { type: string; function: { name: string } };
  cot_steps?: number;         // Default: 1, Range: 1-30 (Rose-specific)
  [key: string]: any;         // Pass-through params
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];    // For assistant messages with tools
  tool_call_id?: string;      // For tool role messages
  name?: string;              // Tool name
}

interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, any>;  // JSON schema
  };
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;  // JSON string
  };
}
```

**Response (Non-Streaming)**:
```typescript
interface RoseCompletionsResponse {
  id: string;                 // e.g., "chatcmpl-1234567890"
  object: "chat.completion";
  created: number;            // Unix timestamp
  model: string;              // Requested model (masked)
  choices: [{
    index: 0;
    message: {
      role: "assistant";
      content: string | null; // Null if tool_calls present
      tool_calls?: ToolCall[];
    };
    finish_reason: "stop" | "tool_calls" | "length";
  }];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
```

**Response (Streaming)** - SSE format:
```typescript
// Each event: data: {JSON}\n\n
interface RoseCompletionsStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: [{
    index: 0;
    delta: {
      role?: "assistant";
      content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;  // Partial JSON
        };
      }[];
    };
    finish_reason: null | "stop" | "tool_calls" | "length";
  }];
}

// Final event: data: [DONE]\n\n
```

**Side Effects**:
- Logs usage to `RoseApiKeyLog` table with `cotSteps` and `costCents`

---

#### GET /rose/cost?model=:modelName

**Purpose**: Get cost information for a Rose model

**Query Parameters**:
```typescript
{
  model: string;  // e.g., "rose-labs/rose-1-lite", "rose-1-ultra"
}
```

**Response**:
```typescript
interface RoseCostResponse {
  model: string;              // Normalized model name
  contextLength: number;      // Minimum context window across pool
  pricing: {
    costPerMillionInputTokens: number;   // USD, rounded up to nearest $0.05
    costPerMillionOutputTokens: number;  // USD, rounded up to nearest $0.05
  };
}
```

---

#### POST /rose/generate-api-key

**Purpose**: Generate new API key for authenticated user

**Request Headers**:
```typescript
{
  "authorization": "Bearer <supabase-jwt>";
  "Content-Type": "application/json";
}
```

**Request Body**:
```typescript
interface GenerateApiKeyRequest {
  name?: string;  // Optional descriptive name
}
```

**Response**:
```typescript
interface GenerateApiKeyResponse {
  apiKey: string;     // 32-char hex string
  id: string;         // UUID
  createdAt: string;  // ISO 8601
}
```

---

#### GET /rose/api-keys

**Purpose**: List user's API keys (masked)

**Request Headers**:
```typescript
{
  "authorization": "Bearer <supabase-jwt>";
}
```

**Response**:
```typescript
interface ListApiKeysResponse {
  keys: Array<{
    id: string;
    name: string | null;
    createdAt: string;        // ISO 8601
    maskedApiKey: string;     // e.g., "...a1b2"
  }>;
}
```

---

#### DELETE /rose/delete-api-key

**Purpose**: Revoke API key

**Request Headers**:
```typescript
{
  "authorization": "Bearer <supabase-jwt>";
  "Content-Type": "application/json";
}
```

**Request Body**:
```typescript
interface DeleteApiKeyRequest {
  keyId: string;  // UUID of API key to revoke
}
```

**Response**:
```typescript
interface DeleteApiKeyResponse {
  success: boolean;
  message: string;
}
```

---

#### POST /rose/rose-bench

**Purpose**: Run benchmark against a model endpoint (supports any OpenAI-compatible API)

**Request Headers**:
```typescript
{
  "x-api-key"?: string;  // Optional: For authenticated benchmark runs
  "Content-Type": "application/json";
}
```

**Request Body**:
```typescript
interface RoseBenchmarkRequest {
  url: string;                          // Model endpoint URL (e.g., "/rose/completions")
  headers?: Record<string, string>;     // Pass-through headers (e.g., {"x-api-key": "..."})
  modelConfig: ModelConfig;             // Model configuration
  benchmark: BenchmarkType;             // Which benchmark to run (or "full")
  sampleSeed?: number;                  // Optional: for reproducible question sampling
}

interface ModelConfig {
  model: string;                        // e.g., "rose-labs/rose-1-lite"
  temperature?: number;                 // Default: 0.7
  maxTokens?: number;                   // Default: 2000
  seed?: number;                        // For reproducible model outputs
  cotSteps?: number;                    // Rose-specific: 1-30
}
```

**Response (Single Benchmark)**:
```typescript
interface RoseBenchmarkResponse {
  benchmarkName: string;
  totalQuestions: number;               // Full dataset size
  sampledQuestions: number;             // Actually evaluated (respects MAX_SAMPLES_PER_BENCH)
  correctAnswers: number;
  accuracy: number;                     // 0-100
  totalCostCents: number;
  totalDurationSeconds: number;
  results: BenchmarkResult[];
  isSampled: boolean;                   // True if subset was used
  modelConfig: ModelConfig;             // Config used for this run
}

interface BenchmarkResult {
  questionId: string;
  modelResponse: string;
  extractedAnswer: string;
  isCorrect: boolean;
  costCents: number;
  durationMs: number;
  metadata?: Record<string, any>;
}
```

**Response (benchmark === "full")**:
```typescript
interface FullBenchmarkResponse {
  totalDurationSeconds: number;
  totalCostCents: number;
  benchmarks: RoseBenchmarkResponse[];  // Array of individual benchmark results
  aggregateAccuracy: number;            // Weighted average across all benchmarks
}
```

**Side Effects**:
- Logs benchmark run to `BenchmarkRun` table (one entry per benchmark)

---

### 3. Benchmark Types (Documented Enum)

```typescript
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

const COMING_SOON = [
  BenchmarkType.GPQA_DIAMOND,
  BenchmarkType.AIME_2025,
  BenchmarkType.HLE,
  BenchmarkType.IFBENCH,
  BenchmarkType.SCICODE,
  BenchmarkType.LIVECODEBENCH,
  BenchmarkType.SWE_BENCH,
  BenchmarkType.TAU2_BENCH,
  BenchmarkType.AA_LCR
];
```

---

### 4. Core TypeScript Interfaces

#### Benchmark Harness Interface
```typescript
interface IBenchmarkHarness {
  readonly name: string;
  readonly description: string;
  readonly questionCount: number;
  readonly defaultRepeats: number;
  
  loadDataset(): Promise<BenchmarkQuestion[]>;
  formatPrompt(question: BenchmarkQuestion, cotSteps: number): Message[];
  extractAnswer(modelResponse: string): string;
  evaluateAnswer(extracted: string, correct: string): Promise<boolean>;
  runBenchmark(config: BenchmarkConfig): Promise<BenchmarkSummary>;
}

interface BenchmarkQuestion {
  id: string;
  question: string;
  options?: string[];
  correctAnswer: string;
  metadata?: Record<string, any>;
}

interface BenchmarkConfig {
  modelUrl: string;
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
  repeats?: number;
  cotSteps?: number;          // 1-30
  sampleSize?: number;        // Overrides MAX_SAMPLES_PER_BENCH
  sampleSeed?: number;        // For reproducible sampling
}

interface BenchmarkSummary {
  benchmarkName: string;
  totalQuestions: number;
  sampledQuestions: number;
  correctAnswers: number;
  accuracy: number;           // 0-100
  totalCostCents: number;
  totalDurationSeconds: number;
  results: BenchmarkResult[];
  isSampled: boolean;
  metadata?: Record<string, any>;
}
```

#### Evaluator Interfaces
```typescript
interface IEqualityChecker {
  check(
    question: string,
    response: string,
    correctAnswer: string,
    promptType: "hle" | "lcr" | "math"
  ): Promise<boolean>;
}

interface IMathEvaluator {
  extractMathAnswer(modelResponse: string): string | null;
  evaluate(modelAnswer: string, correctAnswer: string): Promise<boolean>;
}

interface IRepetitionChecker {
  addMessage(message: string): void;
  isStuck(): Promise<boolean>;
  reset(): void;
}

interface ICodeEvaluator {
  executeCode(
    code: string,
    tests: string[],
    language?: string,
    timeoutMs?: number
  ): Promise<{
    passed: boolean;
    output: string;
    error: string;
  }>;
}
```

---

### 5. Test Specifications

All endpoints must have tests that can be easily run.

**Test Structure**:
```
research/tests/
├── rose-completions.test.ts
├── rose-cost.test.ts
├── rose-api-keys.test.ts
├── rose-bench.test.ts
└── utils/
    ├── test-client.ts
    └── fixtures.ts
```

**Key Test Cases**:

**POST /rose/completions**:
- Basic completion with valid API key
- Seed reproducibility (same seed = same output)
- Tool calls when tools provided
- SSE streaming support
- CoT steps parameter
- Authentication (reject without key, reject invalid key)

**GET /rose/cost**:
- Returns cost for valid model
- Normalizes model name
- Returns 404 for unknown model

**API Key Management**:
- POST /rose/generate-api-key creates new key
- GET /rose/api-keys lists user keys (masked)
- DELETE /rose/delete-api-key revokes key
- All reject unauthenticated requests

**POST /rose/rose-bench**:
- Runs MMLU-Pro benchmark
- Respects sampleSeed for reproducibility
- Runs full benchmark suite
- Returns 400 for invalid benchmark type

**Run tests**:
```bash
deno test --allow-net --allow-env research/tests/
```

---

### 6. Environment Variables

```typescript
// Required
ROSELABS_API_KEY: string;           // OpenRouter API key
SUPABASE_URL: string;               // Supabase project URL
SUPABASE_ANON_KEY: string;          // Public anon key
SUPABASE_SERVICE_ROLE_KEY: string;  // Service role key (server-side)
OPENROUTER_API_KEY: string;         // For model calls

// Optional
MAX_SAMPLES_PER_BENCH: number;      // Default: 100 (per benchmark)
CODE_SANDBOX_ENDPOINT: string;      // Docker sandbox URL (for code eval)
```

---

## IMPLEMENTATION (AFTER SCHEMAS DEFINED)

### Phase 1: Update Edge Functions to Match New Schemas

#### 1.1 Database Migration
- File: `back-end/prisma/schema.prisma`
- Action: Add RoseApiKey, RoseApiKeyLog, BenchmarkRun models (already done)
- Run: `npx prisma migrate dev --name add_rose_research_tables`

#### 1.2 Update /rose/completions (was rose-chat)
- File: `research/supabase/functions/rose-completions/index.ts`
- Changes:
  - Add `seed` parameter support
  - Add `tools` and `tool_choice` support
  - Add SSE streaming (when `stream: true`)
  - Update response to include `tool_calls` in message
  - Remove `logprobs` from response
  - Change path to `/functions/v1/rose/completions`

#### 1.3 Update /rose/cost
- File: `research/supabase/functions/rose-cost/index.ts`
- Changes:
  - Change from URL param to query param: `?model=`
  - Remove `poolSize` from response
  - Change `pricing.prompt` to `pricing.costPerMillionInputTokens`
  - Change `pricing.completion` to `pricing.costPerMillionOutputTokens`
  - Values should be numbers (not strings)

#### 1.4 Update API Key Management
- Rename function: `rose-api-keys` → split into 3 separate endpoints
- **POST /rose/generate-api-key**:
  - Add `createdAt` to response
- **GET /rose/api-keys**:
  - No changes needed
- **DELETE /rose/delete-api-key**:
  - Change from URL param to request body
  - Return JSON response instead of 204

#### 1.5 Update /rose/rose-bench
- File: `research/supabase/functions/rose-bench/index.ts`
- Changes:
  - Update request schema: `url`, `headers`, `modelConfig`, `benchmark`, `sampleSeed`
  - Remove `model_url`, `pass_through_headers`, `cot_steps`, `sample_size`
  - `modelConfig` includes: `model`, `temperature`, `maxTokens`, `seed`, `cotSteps`
  - Support `benchmark: "full"` for running all benchmarks
  - Return `modelConfig` in response

### Phase 2: Write Test Suite

#### 2.1 Test Infrastructure
- Create `research/tests/utils/test-client.ts` - HTTP client wrapper
- Create `research/tests/utils/fixtures.ts` - Test data and helpers

#### 2.2 Endpoint Tests
- `research/tests/rose-completions.test.ts` - All completion tests
- `research/tests/rose-cost.test.ts` - Cost endpoint tests
- `research/tests/rose-api-keys.test.ts` - API key CRUD tests
- `research/tests/rose-bench.test.ts` - Benchmark tests

#### 2.3 Test Runner
- Configure Deno test runner
- Add test script to package.json (if using npm scripts)

### Phase 3: Documentation & Deployment

#### 3.1 Update Planning Rules
- File: `.cursor/rules/plan.mdc`
- Add checklist emphasizing schema-first approach:
  - Database schemas defined FIRST
  - API endpoint contracts defined FIRST
  - Important interfaces (TypeScript, Pydantic) in plan
  - Backend endpoints list all routes created/modified

#### 3.2 Update Documentation
- `research/README.md` - Update with new endpoint paths
- `research/benchmarks/README.md` - Update usage examples
- Add API documentation file with all endpoint schemas

#### 3.3 Deploy & Test
- Deploy updated edge functions to Supabase
- Run test suite: `deno test --allow-net --allow-env research/tests/`
- Verify all tests pass
- Test manually with curl/Postman

---

## IMPLEMENTATION CHECKLIST

- [ ] Update `.cursor/rules/plan.mdc` to emphasize schema-first planning
- [ ] Run Prisma migration for research tables
- [ ] Update `/rose/completions` edge function (add tool calls, streaming, seed)
- [ ] Update `/rose/cost` edge function (query params, pricing field names)
- [ ] Create `/rose/generate-api-key` endpoint
- [ ] Create `/rose/api-keys` endpoint
- [ ] Create `/rose/delete-api-key` endpoint
- [ ] Update `/rose/rose-bench` endpoint (new request/response schemas)
- [ ] Create test infrastructure (test-client, fixtures)
- [ ] Write tests for `/rose/completions`
- [ ] Write tests for `/rose/cost`
- [ ] Write tests for API key management
- [ ] Write tests for `/rose/rose-bench`
- [ ] Deploy updated edge functions to Supabase
- [ ] Run full test suite and verify all pass
- [ ] Update documentation with new schemas
- [ ] End-to-end testing with Rose models

---

## SUMMARY OF CHANGES

1. **All endpoints now under `/rose/` prefix**
2. **`/rose/completions`** (renamed from rose-chat):
   - Added `seed` for reproducibility
   - Added `tools` and `tool_choice` for function calling
   - Added `stream` for SSE streaming
   - Response includes `tool_calls` in message
   - Removed `logprobs`
3. **`/rose/cost`**:
   - Query param instead of URL param
   - Removed `poolSize`
   - Pricing fields: `costPerMillionInputTokens`, `costPerMillionOutputTokens` (numbers)
4. **API Key endpoints split**:
   - `/rose/generate-api-key` (POST) - includes `createdAt` in response
   - `/rose/api-keys` (GET)
   - `/rose/delete-api-key` (DELETE with body)
5. **`/rose/rose-bench`**:
   - New request schema with `url`, `headers`, `modelConfig`, `benchmark`
   - `modelConfig` object includes all model params
   - Supports `benchmark: "full"` for complete suite
6. **Comprehensive test specifications** for all endpoints
7. **BenchmarkType enum** documented
