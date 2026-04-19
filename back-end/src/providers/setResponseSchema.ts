/**
 * Async schema generation for agents with exponential backoff retry.
 * Generates structured response schemas from goals using Rose Lite.
 */

import { z } from 'zod';
import { prisma } from './database';
import { createLogger } from './logger';
import { retryWithBackoff } from './retry';
import {
  createStreamingCompletion,
  RoseAuthError,
  RoseInvalidRequest,
} from './rose';

const log = createLogger('ResponseSchema');

// Schema field types supported
const FieldTypeSchema = z.enum([
  'str',
  'int',
  'float',
  'bool',
  'list[str]',
  'list[int]',
  'file_pointer',
  'list[file_pointer]',
]);

// Individual field definition (no 'required' - we hardcode it to true)
const SchemaFieldSchema = z.object({
  name: z.string().describe('Field name in snake_case'),
  type: FieldTypeSchema.describe('Field type'),
  description: z.string().describe('Brief description of what this field contains'),
});

// The response schema structure
const ResponseSchemaSchema = z.object({
  reasoning: z.string().describe('Your analysis of what outputs this goal requires'),
  fields: z.array(SchemaFieldSchema).min(1).describe('List of output fields'),
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
      | 'file_pointer'
      | 'list[file_pointer]';
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
      description: 'List of output fields (1-5 fields typically)',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Field name in snake_case',
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
            ],
            description: 'Field type',
          },
          description: {
            type: 'string',
            description: 'Brief description of what this field contains',
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

function isRetryableSchemaError(error: unknown): boolean {
  // Auth / bad-request errors from the Rose provider are configuration
  // issues — fail fast rather than burning retries.
  if (error instanceof RoseAuthError || error instanceof RoseInvalidRequest) {
    return false;
  }
  return true;
}

/**
 * Generate a structured response schema from a goal using Rose Lite.
 * Uses structured output mode (JSON schema) for reliable JSON responses.
 */
export async function generateResponseSchema(goal: string): Promise<GenerateResult> {
  const startTime = Date.now();
  const maxGenerationAttempts = 3;

  const systemPrompt = `You are an expert at analyzing agent goals and determining what structured output they should produce.

Your task: Given a goal, identify what CONCRETE outputs the agent should return when completed.

GUIDELINES:
- Focus on VERIFIABLE outputs - data that can be extracted and validated
- Only include fields that are ESSENTIAL for verifying the goal was completed
- Keep it minimal - 1-5 fields typically
- Field names should be snake_case
- Consider what a parent agent would need to receive from a child agent

SUPPORTED TYPES:
- str: String value
- int: Integer number
- float: Decimal number
- bool: True/false
- list[str]: List of strings
- list[int]: List of integers
- file_pointer: Reference to a file created by the agent. Use for tasks that produce files (images, documents, etc.). The verifier will extract file metadata including: path (local path), id (UUID), storage_path (cloud storage), original_filename, mime_type, size_bytes, created_at.
- list[file_pointer]: List of file references. Use when multiple files are produced.`;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxGenerationAttempts; attempt++) {
    try {
      const stream = await createStreamingCompletion({
        model: 'rose-labs/rose-1-lite',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Goal: ${goal}` },
        ],
        temperature: 0.3,
        max_tokens: 2000,
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
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) content += delta.content;
        if (chunk.usage) {
          tokensIn = chunk.usage.prompt_tokens ?? tokensIn;
          tokensOut = chunk.usage.completion_tokens ?? tokensOut;
        }
      }

      if (!content) {
        throw new Error('LLM returned no content');
      }

      // Parse JSON (structured output mode guarantees valid JSON)
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (parseError) {
        throw new Error(
          `Failed to parse LLM response as JSON: ${parseError instanceof Error ? parseError.message : parseError}. Content: ${content.substring(0, 200)}`
        );
      }

      // Validate with Zod
      const result = ResponseSchemaSchema.parse(parsed);

      const durationMs = Date.now() - startTime;
      log.info('Generated response schema via Rose Lite', {
        goal: goal.substring(0, 50),
        fieldCount: result.fields.length,
        tokensIn,
        tokensOut,
        durationMs,
        attempt,
      });

      // Hardcode required: true for all fields
      const fieldsWithRequired = result.fields.map((f) => ({
        name: f.name,
        type: f.type,
        required: true as const,
        description: f.description,
      }));

      return {
        schema: { fields: fieldsWithRequired },
        tokensIn,
        tokensOut,
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
        isRetryable: () => true,
        component: 'ResponseSchema',
      }
    );
  } catch (error) {
    log.error(`Exhausted retries for setting response schema on agent ${agentId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
