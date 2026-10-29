/**
 * Async schema generation for agents with exponential backoff retry.
 * Generates structured response schemas from goals using Rose Flash.
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
import { FinalPresentationSchema, validateFinalPresentation, type FinalPresentation } from '../domains/agents/finalPresentation';
import { prisma } from './database';
import { createLogger } from './logger';
import { boundsFromEntries, type FieldConstraints } from './responseSchemaBounds';
import { retryWithBackoff } from './retry';
import { createStreamingCompletion, RoseAuthError, RoseInvalidRequest } from './rose';
import { StructuredOutputAccumulator } from './rose/structuredOutput';

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
//   - 'object'                          — nested object; use `properties`
//                                         to spell out sub-fields
//   - 'list[object]'                    — list of objects; `properties`
//                                         describes each item shape
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
// 'object' / 'list[object]' must carry explicit `properties`. The Python
// verifier turns those properties into a closed nested schema so OpenRouter,
// claudeAuth, and gptAuth all enforce the same required fields.
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

const GeneratedBoundSchema = z.object({
  kind: z.enum(['minItems', 'maxItems', 'minLength', 'maxLength']),
  value: z.number().int().min(0),
});

const NestedSchemaFieldSchema = z
  .object({
    name: z.string().describe('Nested field name in snake_case'),
    type: z
      .enum([
        'str',
        'int',
        'float',
        'bool',
        'list[str]',
        'list[int]',
        'file_pointer',
        'list[file_pointer]',
        'session_file_pointer',
        'list[session_file_pointer]',
      ])
      .describe('Nested field type'),
    constraints: z
      .array(GeneratedBoundSchema)
      .nullish()
      .transform((value) => value ?? undefined),
    required: z
      .boolean()
      .nullish()
      .transform((value) => value ?? true),
  })
  .superRefine((field, ctx) => validateFieldConstraints(field, ctx));

function validateFieldConstraints(
  field: { type: string; constraints?: z.infer<typeof GeneratedBoundSchema>[] },
  ctx: z.RefinementCtx
): void {
  try {
    boundsFromEntries(field.type, field.constraints);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// Individual field definition. `required: false` means the agent may omit it.
const SchemaFieldSchema = z
  .object({
    name: z.string().describe('Field name in snake_case'),
    type: FieldTypeSchema.describe('Field type'),
    properties: z
      .array(NestedSchemaFieldSchema)
      .nullish()
      .transform((value) => value ?? undefined)
      .describe(
        'Required for object/list[object]. Explicit nested fields; do not encode subfields in prose.'
      ),
    constraints: z
      .array(GeneratedBoundSchema)
      .nullish()
      .transform((value) => value ?? undefined),
    required: z
      .boolean()
      .nullish()
      .transform((value) => value ?? true),
  })
  .superRefine((field, ctx) => {
    validateFieldConstraints(field, ctx);
    if (
      (field.type === 'object' || field.type === 'list[object]') &&
      (!field.properties || field.properties.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'object and list[object] fields must include explicit properties',
        path: ['properties'],
      });
    }
  });

// The response schema structure.
//
// minItems: 1 — we keep this. A goal must produce at least one verifiable
// output for the verifier to ever score 1.0. We do NOT enforce minItems > 1
// (single-value goals like "What is X's population?" are valid). The custom
// message on `.min(1)` mirrors the prompt directive ("Return AT LEAST ONE
// field. A schema with zero fields is invalid...") so a Zod failure here
// surfaces a clear, prompt-aligned diagnostic to logs and downstream retry.
export const ResponseSchemaSchema = z
  .object({
    presentation: FinalPresentationSchema.nullable().optional(),
    reasoning: z.string().describe('Your analysis of what outputs this goal requires'),
    fields: z
      .array(SchemaFieldSchema)
      .min(1, {
        message:
          'fields must contain at least one field — a schema with zero fields is invalid. Every goal that warrants a verifier must produce at least one verifiable output.',
      })
      .describe('List of output fields; at least one must be required'),
  })
  .superRefine(validateFinalPresentation)
  .refine((schema) => schema.fields.some((field) => field.required), {
    message: 'generated output schema must contain at least one required field',
    path: ['fields'],
  });

export function parseGeneratedResponseSchemaJson(
  content: string
): z.infer<typeof ResponseSchemaSchema> {
  if (!content) {
    throw new Error('LLM returned no content');
  }
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(content);
  } catch (parseError) {
    throw new Error(
      `Failed to parse LLM response as JSON: ${parseError instanceof Error ? parseError.message : parseError}. Content: ${content.substring(0, 200)}`
    );
  }
  const parsed = ResponseSchemaSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    throw new Error(
      `Response schema failed schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`
    );
  }
  return parsed.data;
}

export type ResponseSchema = {
  presentation?: FinalPresentation;
  fields: Array<
    FieldConstraints & {
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
      properties?: Array<
        FieldConstraints & {
          name: string;
          type:
            | 'str'
            | 'int'
            | 'float'
            | 'bool'
            | 'list[str]'
            | 'list[int]'
            | 'file_pointer'
            | 'list[file_pointer]'
            | 'session_file_pointer'
            | 'list[session_file_pointer]';
        }
      >;
    }
  >;
};

type GenerateResult = {
  schema: ResponseSchema;
  tokensIn: number;
  tokensOut: number;
};

// JSON Schema for structured output mode
// A field's `required` flag controls whether its key may be omitted in the final output.
const CONSTRAINT_PROPERTIES = {
  constraints: {
    type: 'array',
    description: 'Bounds: minItems/maxItems for lists; minLength/maxLength for strings.',
    items: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['minItems', 'maxItems', 'minLength', 'maxLength'] },
        value: { type: 'integer', minimum: 0 },
      },
      required: ['kind', 'value'],
      additionalProperties: false,
    },
  },
  required: { type: 'boolean', description: 'Defaults to true; false allows omission.' },
};

export const RESPONSE_SCHEMA_JSON_SCHEMA = {
  type: 'object',
  properties: {
    presentation: {
      anyOf: [
        { type: 'null' },
        { type: 'object', additionalProperties: false, properties: { version: { const: 1 }, mode: { const: 'report' } }, required: ['version', 'mode'] },
        { type: 'object', additionalProperties: false, properties: { version: { const: 1 }, mode: { const: 'value' }, field: { type: 'string' }, encoding: { enum: ['text', 'json'] } }, required: ['version', 'mode', 'field', 'encoding'] },
      ],
    },
    reasoning: {
      type: 'string',
      description: 'Your analysis of what outputs this goal requires',
    },
    fields: {
      type: 'array',
      description:
        'List of output fields. MINIMUM 1 required field; zero fields is invalid. Typically 1-5 fields total. Optional fields may be omitted from the final output.',
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
          properties: {
            type: 'array',
            description:
              'Required when type is object or list[object]. Explicit subfields for the object, never prose.',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Nested field name in snake_case.',
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
                    'file_pointer',
                    'list[file_pointer]',
                    'session_file_pointer',
                    'list[session_file_pointer]',
                  ],
                  description: 'Nested field type.',
                },
                ...CONSTRAINT_PROPERTIES,
              },
              required: ['name', 'type', 'constraints', 'required'],
              additionalProperties: false,
            },
          },
          ...CONSTRAINT_PROPERTIES,
        },
        required: ['name', 'type', 'properties', 'constraints', 'required'],
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

Your output is consumed by an automated verifier that scores 1.0 when every required field can be populated accurately from tool-result evidence. Therefore:
  - Required defaults to true; \`required: false\` lets the agent omit a field.
  - Field names must be SPECIFIC to the goal, not generic catch-alls.
  - You MUST return AT LEAST ONE field. A schema with zero fields is invalid — every goal that warrants a verifier must produce at least one verifiable output.

# CORE PRINCIPLES

1. AT LEAST ONE REQUIRED FIELD. Generate the fields needed to answer the user's goal, with at least one required field. Do NOT add fields like 'reasoning', 'sources', 'confidence', or 'notes' unless the goal asks for them. Keep the schema tight (typically 1-5 fields).

2. SPECIFIC NAMES. Field names must be anchored in the goal. If the goal asks for Tokyo's population, the field is \`population\` or \`tokyo_population\` — not \`result\`. If the goal asks for an email + LinkedIn URL, the fields are \`email\` and \`linkedin_url\` — not \`output\`.

3. SINGLE-VALUE GOALS ARE FINE. If the goal is intrinsically about ONE value, emit EXACTLY ONE field with a precise name. Don't pad the schema, but never drop below one.

4. CONCRETE TYPES. Pick the most precise type the goal allows. \`int\` beats \`str\` for a population. \`list[object]\` beats \`str\` for a comparison table.

5. EXPLICIT OBJECT PROPERTIES. Never encode object subfields in prose. For \`object\` and \`list[object]\`, put nested fields in \`properties\`.

6. RIGHT OUTPUT MEDIUM. Use \`file_pointer\` for open-ended collections of multi-attribute records, without duplicating rows in \`list[object]\`. Keep small results inline.

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
  - object:                     Nested object — MUST include properties: [{ name, type }]
  - list[object]:               List of objects — MUST include properties describing each item shape
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
    { name: "population", type: "int" }
  ]

BAD (anti-pattern — uses catch-all name):
  fields: [
    { name: "result", type: "str" }
  ]

## Example 2 — multi-field extraction

Goal: "Find this person's email and LinkedIn URL."

GOOD:
  fields: [
    { name: "email", type: "str" },
    { name: "linkedin_url", type: "str" }
  ]

BAD (anti-pattern — collapses two distinct outputs into one catch-all):
  fields: [
    { name: "data", type: "str" }
  ]

## Example 3 — derived value

Goal: "Multiply Tokyo's population by NYC's population."

GOOD:
  fields: [
    { name: "tokyo_population", type: "int" },
    { name: "nyc_population", type: "int" },
    { name: "product", type: "int" }
  ]

Why three fields and not one: the verifier scores both intermediate evidence (the two populations from search results) AND the derived value. Listing them all forces the agent to actually surface the source numbers, which prevents fabricated multiplication.

## Example 4 — list of structured items

Goal: "Compare three cities by cost of living and rank them."

GOOD:
  fields: [
    { name: "cities", type: "list[object]",
      properties: [
        { name: "name", type: "str" },
        { name: "cost_of_living_index", type: "float" },
        { name: "rank", type: "int" }
      ] }
  ]

## Example 5 — file output

Goal: "Generate a logo as a PNG."

GOOD:
  fields: [
    { name: "logo", type: "file_pointer" }
  ]

## Example 6 — large downloadable inventory

Goal: "List every record from my history with its link, image, and price so I can reuse the details later."

GOOD:
  fields: [{ name: "inventory_file", type: "file_pointer" }]

BAD:
  fields: [{ name: "items", type: "list[object]", properties: [{ name: "product_url", type: "str" }, { name: "price", type: "float" }] }]

# YOUR JOB

Given a goal, return JSON with:
  - reasoning: 1-3 sentences on what concrete outputs the goal requires.
  - presentation: select version 1 mode value only when the user explicitly requires a value-only answer or exact serialization. Bind field to the only required nonnullable non-file field, using text for scalars or json for requested JSON. Otherwise use mode report or omit. Do not suppress disclosures, approvals, payments or additional deliverables. Never infer this mode merely from one field.
  - fields: a compact list with at least one required field, specific names and concrete types. For object/list[object], include explicit \`properties\`. A zero-length \`fields\` array is invalid.

Output JSON only. Do not include prose outside the JSON envelope.`;

/**
 * Parameters for one streaming attempt against Rose Flash.
 *
 * Pulled out so the max_tokens escalation retry (rule E9 — mirror
 * agents/helpers/llm.py:1276-1313) can re-call with a larger budget
 * without duplicating the request shape.
 */
interface StreamAttemptOptions {
  goal: string;
  maxTokens: number;
  directAuth?: ResponseSchemaDirectAuth;
}

export interface ResponseSchemaDirectAuth {
  type: 'claude' | 'gpt';
  accessToken: string;
  accountId?: string;
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
 * Drain the Rose Flash stream once and produce a parsed schema.
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
    model: 'rose-labs/rose-1-flash',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Goal: ${opts.goal}` },
    ],
    temperature: 0.3,
    max_tokens: opts.maxTokens,
    ...(opts.directAuth?.type === 'claude' ? { claude_token: opts.directAuth.accessToken } : {}),
    ...(opts.directAuth?.type === 'gpt'
      ? {
          gpt_token: opts.directAuth.accessToken,
          gpt_account_id: opts.directAuth.accountId,
        }
      : {}),
    disable_waterfall: opts.directAuth !== undefined,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'response_schema',
        strict: true,
        schema: RESPONSE_SCHEMA_JSON_SCHEMA,
      },
    },
  });

  const structuredOutput = new StructuredOutputAccumulator();
  let tokensIn = 0;
  let tokensOut = 0;
  let finishReason: string | null = null;
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    structuredOutput.addCompletionChunk(chunk);
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
    throw new MaxTokensTruncationError(opts.maxTokens, structuredOutput.currentText());
  }

  const rawContent = structuredOutput.currentText();
  const parsed = parseGeneratedResponseSchemaJson(rawContent);

  return { parsed, tokensIn, tokensOut, finishReason, rawContent };
}

/**
 * Generate a structured response schema from a goal using Rose Flash.
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
export async function generateResponseSchema(
  goal: string,
  opts: { directAuth?: ResponseSchemaDirectAuth } = {}
): Promise<GenerateResult> {
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
          directAuth: opts.directAuth,
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
            directAuth: opts.directAuth,
          });
        } else {
          throw innerErr;
        }
      }

      const durationMs = Date.now() - startTime;
      log.info('Generated response schema via Rose Flash', {
        goal: goal.substring(0, 50),
        fieldCount: result.parsed.fields.length,
        fieldNames: result.parsed.fields.map((f) => f.name),
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        durationMs,
        attempt,
      });

      const fieldsWithRequired = result.parsed.fields.map((f) => ({
        name: f.name,
        type: f.type,
        required: f.required,
        ...boundsFromEntries(f.type, f.constraints),
        ...((f.type === 'object' || f.type === 'list[object]') && f.properties
          ? {
              properties: f.properties.map((p) => ({
                name: p.name,
                type: p.type,
                required: p.required,
                ...boundsFromEntries(p.type, p.constraints),
              })),
            }
          : {}),
      }));

      return {
        schema: { fields: fieldsWithRequired, ...(result.parsed.presentation ? { presentation: result.parsed.presentation } : {}) },
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

        // Generate schema using Rose Flash
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
