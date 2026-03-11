/**
 * Async schema generation for agents with exponential backoff retry.
 * Generates structured response schemas from goals using Rose Ultra.
 */

import { z } from 'zod';
import { prisma } from './prisma';

// Use local Supabase functions in development, production URL otherwise
const SUPABASE_FUNCTIONS_URL = process.env.NODE_ENV === 'production'
  ? 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1'
  : `http://localhost:${process.env.RESEARCH_PORT || '54321'}/functions/v1`;

// Schema field types supported
const FieldTypeSchema = z.enum(['str', 'int', 'float', 'bool', 'list[str]', 'list[int]', 'file_pointer', 'list[file_pointer]']);

// Individual field definition (no 'required' - we hardcode it to true)
const SchemaFieldSchema = z.object({
  name: z.string().describe('Field name in snake_case'),
  type: FieldTypeSchema.describe('Field type'),
  description: z.string().describe('Brief description of what this field contains'),
});

// The response schema structure
const ResponseSchemaSchema = z.object({
  reasoning: z.string().describe('Your analysis of what outputs this goal requires'),
  fields: z.array(SchemaFieldSchema).describe('List of output fields'),
});

export type ResponseSchema = {
  fields: Array<{
    name: string;
    type: 'str' | 'int' | 'float' | 'bool' | 'list[str]' | 'list[int]' | 'file_pointer' | 'list[file_pointer]';
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
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Field name in snake_case',
          },
          type: {
            type: 'string',
            enum: ['str', 'int', 'float', 'bool', 'list[str]', 'list[int]', 'file_pointer', 'list[file_pointer]'],
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

/**
 * Generate a structured response schema from a goal using Rose Ultra.
 * Uses structured output mode (JSON schema) for reliable JSON responses.
 */
export async function generateResponseSchema(goal: string): Promise<GenerateResult> {
  const startTime = Date.now();
  const roseApiUrl = `${SUPABASE_FUNCTIONS_URL}/completions`;

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

  const response = await fetch(roseApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'x-api-key': process.env.ROSE_API_KEY!,
    },
    body: JSON.stringify({
      model: 'rose-labs/rose-1-ultra',
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
    }),
  });

  if (!response.ok) {
    throw new Error(`Rose API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  const content = data.choices[0]?.message?.content;

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

  const tokensIn = data.usage?.prompt_tokens || 0;
  const tokensOut = data.usage?.completion_tokens || 0;

  const durationMs = Date.now() - startTime;
  console.log('✅ Generated response schema via Rose Ultra', {
    goal: goal.substring(0, 50),
    reasoning: result.reasoning,
    fieldCount: result.fields.length,
    fields: result.fields.map((f) => f.name),
    tokensIn,
    tokensOut,
    durationMs,
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
  console.log('📋 setResponseSchema called', { agentId });
  const maxRetries = 4;
  const baseDelayMs = 100;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`📋 setResponseSchema attempt ${attempt + 1}/${maxRetries}`, { agentId });
      // Fetch agent goal from DB
      const agent = await prisma.agent.findUnique({
        where: { id: agentId },
        select: { goal: true, tokensIn: true, tokensOut: true },
      });

      if (!agent) {
        console.error(`❌ Agent ${agentId} not found, cannot set response schema`);
        return;
      }

      // Generate schema using Opus 4.5
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

      console.log(`✅ Set response schema for agent ${agentId}`);
      return;
    } catch (error) {
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      console.error(
        `❌ Failed to set response schema for agent ${agentId} (attempt ${attempt + 1}/${maxRetries})`,
        error instanceof Error ? error.message : error
      );

      if (attempt < maxRetries - 1) {
        console.log(`⏳ Retrying in ${delayMs}ms...`);
        await sleep(delayMs);
      }
    }
  }

  console.error(`❌ Exhausted retries for setting response schema on agent ${agentId}`);
}
