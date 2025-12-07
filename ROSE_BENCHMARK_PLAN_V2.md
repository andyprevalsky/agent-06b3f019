# Rose Benchmarking Suite - Schema-First Plan V2

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
  model: string;              // e.g., "rose-labs/rose-1-fast"
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
- Logs usage to `RoseApiKeyLog` table

---

#### GET /rose/cost?model=:modelName
**Purpose**: Get cost information for a Rose model

**Query Parameters**:
```typescript
{
  model: string;  // e.g., "rose-labs/rose-1-fast", "rose-1-ultra"
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
  model: string;                        // e.g., "rose-labs/rose-1-fast"
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
```

---

### 4. Test Specifications

All endpoints must have tests that can be easily run.

**Test Structure**:
```
research/tests/
├── rose-completions.test.ts
├── rose-cost.test.ts
├── rose-api-keys.test.ts
├── rose-bench.test.ts
└── utils/test-client.ts
```

**Key Test Cases**:
- `/rose/completions`: Basic completion, seed reproducibility, tool calls, streaming, CoT steps, auth
- `/rose/cost`: Valid model, model name normalization, unknown model
- `/rose/generate-api-key`, `/rose/api-keys`, `/rose/delete-api-key`: CRUD operations, auth
- `/rose/rose-bench`: Single benchmark, full suite, seed reproducibility

**Run tests**:
```bash
deno test --allow-net --allow-env research/tests/
```

---

### 5. Environment Variables

```typescript
ROSELABS_API_KEY: string;           // OpenRouter API key
SUPABASE_URL: string;               
SUPABASE_ANON_KEY: string;          
SUPABASE_SERVICE_ROLE_KEY: string;  
OPENROUTER_API_KEY: string;         
MAX_SAMPLES_PER_BENCH: number;      // Default: 100
CODE_SANDBOX_ENDPOINT: string;      // Optional: Docker sandbox
```

---

## IMPLEMENTATION CHECKLIST

- [ ] Update `.cursor/rules/plan.mdc` to emphasize schema-first approach
- [ ] Update existing edge functions to match new schemas:
  - `/rose/completions` (was `/rose-chat`) - add tool_calls, streaming, seed
  - `/rose/cost` - change pricing field names, remove poolSize
  - `/rose/generate-api-key` (was `/rose-api-keys` POST) - add createdAt to response
  - `/rose/api-keys` (was GET `/rose-api-keys`)
  - `/rose/delete-api-key` (was DELETE `/rose-api-keys/:id`) - change to POST with body
  - `/rose/rose-bench` (was `/rose-bench`) - update request/response schemas
- [ ] Write test files for all 5 endpoint groups
- [ ] Run database migration
- [ ] Deploy updated edge functions
- [ ] Run test suite and verify all pass









