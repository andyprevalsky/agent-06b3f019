/**
 * Async schema generation for agents with exponential backoff retry.
 * Generates structured response schemas from goals using Rose Lite.
 *
 * Why this matters: the downstream verifier scores 1.0 IFF every field in
 * this schema can be populated from grounded tool-result evidence. Generic
 * field names like `result` / `output` / `answer` make verification noisy
 * (the verifier has to guess what counts as "the" result). Specific,
 * goal-anchored field names — `population`, `tokyo_population_2024`,
 * `selected_venue_url` — collapse that ambiguity and let the verifier
 * cleanly score 1.0 when the agent actually produced the data.
 *
 * Prompt design (E1/E2/E5/C9/E9): we give the LLM (a) a small set of
 * worked examples covering single-int / multi-field / list-of-object
 * shapes, (b) explicit anti-examples of catch-all names, (c) a richer
 * type enum (incl. object / list[object] for nested shapes), and (d) a
 * MUST-HAVE-ONLY directive so the verifier is not penalized for missing
 * nice-to-haves the goal never asked for.
 *
 * Retry strategy mirrors agents/helpers/llm.py:_call_llm_verifier and
 * call_llm_structured_streaming (escalation retry on max_tokens
 * truncation; exponential backoff on transient errors). See
 * claude-code-src/src/services/api/withRetry.ts and
 * claude-code-src/src/utils/sideQuery.ts for the upstream pattern.
 */

import { z } from 'zod';
import { prisma } from './database';
import { createLogger } from './logger';
import { retryWithBackoff } from './retry';
import { createStreamingCompletion, RoseAuthError, RoseInvalidRequest } from './rose';

const log = createLogger('ResponseSchema');

// Schema field types supported.
//
// We mirror the Pydantic-side enum in agents/helpers/llm.py
// (_build_verifier_json_schema). New types here MUST be added there too,
// otherwise the verifier will fall through and score < 1.0 with a parse error.
//
// Type system notes:
//   - 'str' | 'int' | 'float' | 'bool' — primitives
//   - 'list[str]' | 'list[int]'         — homogeneous primitive lists
//   - 'object'                          — nested object; use the field
//                                         description to spell out sub-fields
//                                         (e.g. "Object with: name (str),
//                                         population (int), notes (str)")
//   - 'list[object]'                    — list of objects; description must
//                                         describe each item shape
//   - 'file_pointer' | 'list[file_pointer]'
//                                       — file outputs (image, doc, etc.) —
//                                         the verifier extracts the full
//                                         FilePointer metadata
//   - 'session_file_pointer' |
//     'list[session_file_pointer]'      — cheap remote-session file references
//                                         used by cloud-agent goals
//                                         (spawn_claude_code_agent,
//                                         spawn_browser_agent). The verifier
//                                         only needs the absolute path from
//                                         terminal output; the spawning
//                                         activity handles download/upload,
//                                         so we skip the full FilePointer
//                                         round-trip.
//
// 'object' / 'list[object]' are accepted by the Pydantic verifier as
// JSON-schema 'object' (additionalProperties: true) — the verifier reads
// the description to populate sub-fields. Keep descriptions concrete. When
// any field uses 'object' or 'list[object]', the verifier on the Python
// side flips `strict: false` on the response-format envelope (open shapes
// are incompatible with OpenAI strict mode). The Python helper handles that
// automatically via `_build_verifier_json_schema`; we don't need to do
// anything extra here on the TS schema-gen side because the schema-gen
// response_format itself stays closed-shape — the LLM chooses a string from
// the type enum, never produces an open-shape object directly. The
// open-shape gymnastics happen at verifier-call time on the Python side,
// using the field types this generator emitted.
const FieldTypeSchema = z.enum([
  'str',
  'int',
  'float',
  'bool',
  'list[str]',
  'list[int]',
  'object',
  'list[object]',
  'file_pointer',
  'list[file_pointer]',
  'session_file_pointer',
  'list[session_file_pointer]',
]);

// Individual field definition (no 'required' - we hardcode it to true)
const SchemaFieldSchema = z.object({
  name: z.string().describe('Field name in snake_case'),
  type: FieldTypeSchema.describe('Field type'),
  description: z.string().describe('Brief description of what this field contains'),
});

// The response schema structure.
//
// minItems: 1 — we keep this. A goal must produce at least one verifiable
// output for the verifier to ever score 1.0. We do NOT enforce minItems > 1
// (single-value goals like "What is X's population?" are valid). The custom
// message on `.min(1)` mirrors the prompt directive ("Return AT LEAST ONE
// field. A schema with zero fields is invalid...") so a Zod failure here
// surfaces a clear, prompt-aligned diagnostic to logs and downstream retry.
const ResponseSchemaSchema = z.object({
  reasoning: z.string().describe('Your analysis of what outputs this goal requires'),
  fields: z
    .array(SchemaFieldSchema)
    .min(1, {
      message:
        'fields must contain at least one field — a schema with zero fields is invalid. Every goal that warrants a verifier must produce at least one verifiable output.',
    })
    .describe('List of MUST-HAVE output fields (at least one required)'),
});

export type ResponseSchema = {
  fields: Array<{
    name: string;
    type:
      | 'str'
      | 'int'
      | 'float'
      | 'bool'
      | 'list[str]'
      | 'list[int]'
      | 'object'
      | 'list[object]'
      | 'file_pointer'
      | 'list[file_pointer]'
      | 'session_file_pointer'
      | 'list[session_file_pointer]';
    required: boolean;
    description: string;
  }>;
};

type GenerateResult = {
  schema: ResponseSchema;
  tokensIn: number;
  tokensOut: number;
};

// JSON Schema for structured output mode
// Note: 'required' field is NOT in schema - we hardcode it to true for all fields
const RESPONSE_SCHEMA_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: {
      type: 'string',
      description: 'Your analysis of what outputs this goal requires',
    },
    fields: {
      type: 'array',
      description:
        'List of MUST-HAVE output fields. MINIMUM 1 field required — a schema with zero fields is invalid. Typically 1-5 fields total. Include ONLY fields strictly required to fully answer the goal, but ALWAYS include at least one.',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Field name in snake_case. MUST be specific to the goal — never use catch-all names like "result", "output", "answer", "data", or "value".',
          },
          type: {
            type: 'string',
            enum: [
              'str',
              'int',
              'float',
              'bool',
              'list[str]',
              'list[int]',
              'object',
              'list[object]',
              'file_pointer',
              'list[file_pointer]',
              'session_file_pointer',
              'list[session_file_pointer]',
            ],
            description: 'Field type',
          },
          description: {
            type: 'string',
            description:
              'Concrete description of what this field contains. For object/list[object], spell out sub-field names and types.',
          },
        },
        required: ['name', 'type', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['reasoning', 'fields'],
  additionalProperties: false,
};

/**
 * System prompt for the schema-gen LLM.
 *
 * Sections:
 *   1. ROLE
 *   2. CORE PRINCIPLES (must-have only, specific names, anchor in goal)
 *   3. BANNED FIELD NAMES
 *   4. SUPPORTED TYPES
 *   5. WORKED EXAMPLES (good vs bad)
 *
 * Inspired by the structured-output prompts in claude-code-src/src/tools/
 * SyntheticOutputTool/SyntheticOutputTool.ts (the "structured output" tool
 * that Claude Code uses in non-interactive mode) and the worked-examples
 * pattern in agents/utils/prompts.py:_VERIFIER_STATIC_PROMPT.
 */
const SYSTEM_PROMPT = `You are an expert at analyzing agent goals and producing the MINIMAL output schema needed to verify the goal was completed.

Your output is consumed by an automated verifier that scores 1.0 IFF every field in the schema can be populated accurately from tool-result evidence. Therefore:
  - EVERY field you add must be populatable for the goal to count as done.
  - Adding optional / nice-to-have fields PENALIZES the agent — keep it strict.
  - Field names must be SPECIFIC to the goal, not generic catch-alls.
  - You MUST return AT LEAST ONE field. A schema with zero fields is invalid — every goal that warrants a verifier must produce at least one verifiable output.

# CORE PRINCIPLES

1. MUST-HAVE ONLY, AT LEAST ONE. Generate ONLY the fields strictly required to fully answer the user's goal — but ALWAYS at least one field. Skip nice-to-haves. Do NOT add fields like 'reasoning', 'sources', 'confidence', 'notes', or other meta-fields unless the goal explicitly asks for them. The minimum is 1 field; the maximum should still be tight (typically 1-5).

2. SPECIFIC NAMES. Field names must be anchored in the goal. If the goal asks for Tokyo's population, the field is \`population\` or \`tokyo_population\` — not \`result\`. If the goal asks for an email + LinkedIn URL, the fields are \`email\` and \`linkedin_url\` — not \`output\`.

3. SINGLE-VALUE GOALS ARE FINE. If the goal is intrinsically about ONE value, emit EXACTLY ONE field with a precise name. Don't pad the schema, but never drop below one.

4. CONCRETE TYPES. Pick the most precise type the goal allows. \`int\` beats \`str\` for a population. \`list[object]\` beats \`str\` for a comparison table.

5. CONCRETE DESCRIPTIONS. The description tells the verifier exactly what counts as "populated." Include units, formats, examples where useful (e.g. "Population of Tokyo Metropolis as a single integer (e.g. 13960000)").

# BANNED FIELD NAMES

Do NOT use these catch-all names. They make the verifier guess what counts as the answer, which produces noisy scores:
  - result
  - output
  - answer
  - data
  - value
  - response

Always replace with a goal-anchored name. Examples:
  - "the answer to the math problem" -> \`product\`, \`sum\`, \`final_int\` (whichever fits)
  - "the chosen venue" -> \`selected_venue_name\` + \`selected_venue_url\`
  - "the email I should send" -> \`final_email_body\` + \`final_email_subject\`

# SUPPORTED TYPES

  - str:                        String value
  - int:                        Integer number
  - float:                      Decimal number
  - bool:                       True/false
  - list[str]:                  List of strings
  - list[int]:                  List of integers
  - object:                     Nested object — describe sub-fields in the description (e.g. "Object with: name (str), population (int), notes (str)")
  - list[object]:               List of objects — describe each item's shape in the description
  - file_pointer:               Reference to a file produced by the agent (image, doc, etc.). Use for tasks that produce files. The verifier extracts full file metadata: path, id, storage_path, original_filename, mime_type, size_bytes, created_at.
  - list[file_pointer]:         List of file references. Use when multiple files are produced.
  - session_file_pointer:       Cheap variant of file_pointer for cloud-agent goals (spawn_claude_code_agent / spawn_browser_agent). The verifier extracts ONLY the absolute path from terminal output — the spawning activity handles download/upload, so you avoid the full FilePointer round-trip. Prefer this over file_pointer when the goal is delegated to a cloud sandbox or browser session.
  - list[session_file_pointer]: List of session file references — same use case as session_file_pointer, but for goals producing multiple cloud-session files.

# WORKED EXAMPLES

Each example is a goal -> a GOOD schema and (where instructive) a BAD anti-example.

## Example 1 — single integer

Goal: "What is Tokyo's current population?"

GOOD:
  fields: [
    { name: "population", type: "int",
      description: "Population of Tokyo Metropolis as a single integer (e.g. 13960000). Most recent year available." }
  ]

BAD (anti-pattern — uses catch-all name):
  fields: [
    { name: "result", type: "str", description: "the answer" }
  ]

## Example 2 — multi-field extraction

Goal: "Find this person's email and LinkedIn URL."

GOOD:
  fields: [
    { name: "email", type: "str",
      description: "Primary email address for the target person, e.g. 'jane@example.com'" },
    { name: "linkedin_url", type: "str",
      description: "Full LinkedIn profile URL (https://www.linkedin.com/in/...)" }
  ]

BAD (anti-pattern — collapses two distinct outputs into one catch-all):
  fields: [
    { name: "data", type: "str", description: "email and LinkedIn" }
  ]

## Example 3 — derived value

Goal: "Multiply Tokyo's population by NYC's population."

GOOD:
  fields: [
    { name: "tokyo_population", type: "int",
      description: "Population of Tokyo Metropolis as a single integer (most recent year)." },
    { name: "nyc_population", type: "int",
      description: "Population of New York City as a single integer (most recent year)." },
    { name: "product", type: "int",
      description: "Tokyo population multiplied by NYC population, as a single integer." }
  ]

Why three fields and not one: the verifier scores both intermediate evidence (the two populations from search results) AND the derived value. Listing them all forces the agent to actually surface the source numbers, which prevents fabricated multiplication.

## Example 4 — list of structured items

Goal: "Compare three cities by cost of living and rank them."

GOOD:
  fields: [
    { name: "cities", type: "list[object]",
      description: "Each item is an object with: name (str), cost_of_living_index (number), rank (int, 1=cheapest)." }
  ]

## Example 5 — file output

Goal: "Generate a logo as a PNG."

GOOD:
  fields: [
    { name: "logo", type: "file_pointer",
      description: "PNG file containing the generated logo (mime_type=image/png)." }
  ]

# YOUR JOB

Given a goal, return JSON with:
  - reasoning: 1-3 sentences on what concrete outputs the goal requires.
  - fields: the minimal MUST-HAVE list, with AT LEAST ONE field. Specific names, concrete types, concrete descriptions. A zero-length \`fields\` array is invalid and will be rejected.

Output JSON only. Do not include prose outside the JSON envelope.`;

/**
 * Parameters for one streaming attempt against Rose Lite.
 *
 * Pulled out so the max_tokens escalation retry (rule E9 — mirror
 * agents/helpers/llm.py:1276-1313) can re-call with a larger budget
 * without duplicating the request shape.
 */
interface StreamAttemptOptions {
  goal: string;
  maxTokens: number;
}

interface StreamAttemptResult {
  parsed: z.infer<typeof ResponseSchemaSchema>;
  tokensIn: number;
  tokensOut: number;
  finishReason: string | null;
  rawContent: string;
}

/**
 * Sentinel error for "the model hit max_tokens before emitting a complete
 * JSON object." Caller in `generateResponseSchema` catches this and re-runs
 * the stream with 2x max_tokens (one-shot escalation, mirroring
 * call_llm_structured_streaming in agents/helpers/llm.py).
 */
class MaxTokensTruncationError extends Error {
  readonly maxTokens: number;
  readonly partialContent: string;
  constructor(maxTokens: number, partialContent: string) {
    super(`Schema-gen response truncated at max_tokens=${maxTokens} (finish_reason=length)`);
    this.name = 'MaxTokensTruncationError';
    this.maxTokens = maxTokens;
    this.partialContent = partialContent;
  }
}

function isRetryableSchemaError(error: unknown): boolean {
  // Auth / bad-request errors from the Rose provider are configuration
  // issues — fail fast rather than burning retries.
  if (error instanceof RoseAuthError || error instanceof RoseInvalidRequest) {
    return false;
  }
  // max_tokens truncation is handled inline (one-shot escalation), not via
  // retry-with-backoff. If it bubbles up here it means escalation already ran
  // and still failed — don't retry.
  if (error instanceof MaxTokensTruncationError) {
    return false;
  }
  return true;
}

/**
 * Drain the Rose Lite stream once and produce a parsed schema.
 *
 * Returns the parsed schema, token usage, and the final finish_reason so
 * the caller can decide whether to escalate max_tokens.
 *
 * Throws:
 *   - MaxTokensTruncationError if finish_reason === 'length' (caller may retry with larger budget)
 *   - Any RoseError / parse error otherwise (caller's retryWithBackoff handles the transient ones)
 */
async function attemptSchemaGeneration(opts: StreamAttemptOptions): Promise<StreamAttemptResult> {
  const stream = await createStreamingCompletion({
    model: 'rose-labs/rose-1-lite',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Goal: ${opts.goal}` },
    ],
    temperature: 0.3,
    max_tokens: opts.maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'response_schema',
        strict: true,
        schema: RESPONSE_SCHEMA_JSON_SCHEMA,
      },
    },
  });

  let content = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let finishReason: string | null = null;
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const delta = choice?.delta;
    if (delta?.content) content += delta.content;
    // The final chunk carries finish_reason. claudeAuth uses 'length' for
    // max_tokens truncation; the OpenRouter waterfall mirrors that.
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) {
      tokensIn = chunk.usage.prompt_tokens ?? tokensIn;
      tokensOut = chunk.usage.completion_tokens ?? tokensOut;
    }
  }

  if (finishReason === 'length') {
    // The model ran out of tokens mid-emission. Caller decides whether to
    // escalate (one-shot doubling) or surrender.
    throw new MaxTokensTruncationError(opts.maxTokens, content);
  }

  if (!content) {
    throw new Error('LLM returned no content');
  }

  // Parse JSON (structured output mode guarantees valid JSON, but if a
  // provider falls through we still get something parseable in practice).
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(content);
  } catch (parseError) {
    throw new Error(
      `Failed to parse LLM response as JSON: ${parseError instanceof Error ? parseError.message : parseError}. Content: ${content.substring(0, 200)}`
    );
  }

  // Validate with Zod
  const parsed = ResponseSchemaSchema.parse(parsedRaw);

  return { parsed, tokensIn, tokensOut, finishReason, rawContent: content };
}

/**
 * Generate a structured response schema from a goal using Rose Lite.
 *
 * Two-tier retry:
 *   1. INNER (max_tokens escalation): if the first stream truncates with
 *      finish_reason=length, retry ONCE with 2x max_tokens. Mirrors
 *      agents/helpers/llm.py:call_llm_structured_streaming (lines 1273-1313)
 *      and the upstream Anthropic SDK pattern in
 *      claude-code-src/src/services/api/withRetry.ts.
 *   2. OUTER (transient): up to maxGenerationAttempts streaming retries
 *      with exponential backoff for transient parse / Rose errors. Skipped
 *      for non-retryable RoseAuthError / RoseInvalidRequest /
 *      MaxTokensTruncationError (the latter is already escalated).
 */
export async function generateResponseSchema(goal: string): Promise<GenerateResult> {
  const startTime = Date.now();
  const maxGenerationAttempts = 3;
  const initialMaxTokens = 2000;
  const escalatedMaxTokens = 4000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxGenerationAttempts; attempt++) {
    try {
      let result: StreamAttemptResult;
      try {
        result = await attemptSchemaGeneration({
          goal,
          maxTokens: initialMaxTokens,
        });
      } catch (innerErr) {
        if (innerErr instanceof MaxTokensTruncationError) {
          // One-shot escalation. Mirrors agents/helpers/llm.py escalation
          // (max_tokens 2000 -> 4000 here, smaller budget than the agent
          // path because schema-gen is far less verbose than full agent
          // turns).
          log.warn(
            `Schema-gen truncated at max_tokens=${innerErr.maxTokens}; retrying with ${escalatedMaxTokens}`,
            {
              goalSnippet: goal.substring(0, 50),
              partialChars: innerErr.partialContent.length,
            }
          );
          result = await attemptSchemaGeneration({
            goal,
            maxTokens: escalatedMaxTokens,
          });
        } else {
          throw innerErr;
        }
      }

      const durationMs = Date.now() - startTime;
      log.info('Generated response schema via Rose Lite', {
        goal: goal.substring(0, 50),
        fieldCount: result.parsed.fields.length,
        fieldNames: result.parsed.fields.map((f) => f.name),
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        durationMs,
        attempt,
      });

      // Hardcode required: true for all fields.
      // The schema-gen prompt explicitly tells the LLM to emit MUST-HAVE
      // fields only, so every emitted field is required by construction.
      const fieldsWithRequired = result.parsed.fields.map((f) => ({
        name: f.name,
        type: f.type,
        required: true as const,
        description: f.description,
      }));

      return {
        schema: { fields: fieldsWithRequired },
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      };
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < maxGenerationAttempts && isRetryableSchemaError(error);

      log.warn('Response schema generation attempt failed', {
        attempt,
        maxGenerationAttempts,
        error: error instanceof Error ? error.message : String(error),
        shouldRetry,
      });

      if (!shouldRetry) {
        break;
      }

      await sleep(200 * Math.pow(2, attempt - 1));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unknown error generating response schema');
}

/**
 * Sleep helper for exponential backoff
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Set the response schema for an agent with exponential backoff retry.
 * This function runs in the background (fire-and-forget).
 */
export async function setResponseSchema(agentId: string): Promise<void> {
  log.info('setResponseSchema called', { agentId });

  try {
    await retryWithBackoff(
      async () => {
        // Fetch agent goal from DB
        const agent = await prisma.agent.findUnique({
          where: { id: agentId },
          select: { goal: true, tokensIn: true, tokensOut: true },
        });

        if (!agent) {
          log.error(`Agent ${agentId} not found, cannot set response schema`);
          return;
        }

        // Generate schema using Rose Lite
        const { schema, tokensIn, tokensOut } = await generateResponseSchema(agent.goal);

        // Update agent with schema and token usage
        await prisma.agent.update({
          where: { id: agentId },
          data: {
            responseSchema: schema,
            tokensIn: agent.tokensIn + tokensIn,
            tokensOut: agent.tokensOut + tokensOut,
          },
        });

        log.info(`Set response schema for agent ${agentId}`);
      },
      {
        maxRetries: 4,
        initialBackoffMs: 100,
        // Auth / invalid-request errors are configuration problems — retrying
        // them delays schema setup and burns duplicate provider calls.
        isRetryable: isRetryableSchemaError,
        component: 'ResponseSchema',
      }
    );
  } catch (error) {
    log.error(`Exhausted retries for setting response schema on agent ${agentId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
