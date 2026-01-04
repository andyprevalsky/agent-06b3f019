/**
 * Async schema generation for agents with exponential backoff retry.
 * Generates structured response schemas from goals using Rose Ultra.
 */

import { z } from 'zod';
import { prisma } from './prisma';

// Schema field types supported
const FieldTypeSchema = z.enum(['str', 'int', 'float', 'bool', 'list[str]', 'list[int]']);

// Individual field definition
const SchemaFieldSchema = z.object({
  name: z.string().describe('Field name in snake_case'),
  type: FieldTypeSchema.describe('Field type'),
  required: z.boolean().describe('Whether this field is required'),
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
    type: 'str' | 'int' | 'float' | 'bool' | 'list[str]' | 'list[int]';
    required: boolean;
    description: string;
  }>;
};

type GenerateResult = {
  schema: ResponseSchema;
  tokensIn: number;
  tokensOut: number;
};

/**
 * Generate a structured response schema from a goal using Rose Ultra.
 */
export async function generateResponseSchema(goal: string): Promise<GenerateResult> {
  const startTime = Date.now();
  const roseApiUrl = `${process.env.SUPABASE_URL}/functions/v1/completions`;

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

You MUST respond with ONLY a JSON object in this exact format, no other text:
{
  "reasoning": "Your analysis of what outputs this goal requires",
  "fields": [
    {"name": "field_name", "type": "str|int|float|bool|list[str]|list[int]", "required": true, "description": "What this field contains"}
  ]
}

EXAMPLES:

Goal: "Find the cheapest flight from NYC to LA on January 15"
Response:
{"reasoning": "This goal requires finding flight details including price, airline, and time.", "fields": [{"name": "price", "type": "float", "required": true, "description": "Lowest price found in USD"}, {"name": "airline", "type": "str", "required": true, "description": "Airline name"}, {"name": "departure_time", "type": "str", "required": true, "description": "Departure time"}, {"name": "booking_url", "type": "str", "required": false, "description": "URL to book the flight"}]}

Goal: "Research competitors in the CRM space"
Response:
{"reasoning": "Need to return list of competitors and analysis.", "fields": [{"name": "competitors", "type": "list[str]", "required": true, "description": "List of competitor company names"}, {"name": "summary", "type": "str", "required": true, "description": "Brief market analysis"}]}

Goal: "Send a message to John about the meeting"
Response:
{"reasoning": "Simple boolean to confirm message was sent.", "fields": [{"name": "message_sent", "type": "bool", "required": true, "description": "Whether message was sent successfully"}]}`;

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
        { role: 'user', content: `Goal: ${goal}\n\nRespond with ONLY the JSON object, no other text.` },
      ],
      temperature: 0.3,
      max_tokens: 2000,
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

  // Extract JSON from response (handle potential markdown code blocks)
  let jsonStr = content.trim();
  if (jsonStr.startsWith('```json')) {
    jsonStr = jsonStr.slice(7);
  } else if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.slice(3);
  }
  if (jsonStr.endsWith('```')) {
    jsonStr = jsonStr.slice(0, -3);
  }
  jsonStr = jsonStr.trim();

  // Parse and validate with Zod
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (parseError) {
    throw new Error(`Failed to parse LLM response as JSON: ${parseError instanceof Error ? parseError.message : parseError}. Content: ${jsonStr.substring(0, 200)}`);
  }
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

  return {
    schema: { fields: result.fields as ResponseSchema['fields'] },
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
  const maxRetries = 5;
  const baseDelayMs = 1000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
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
