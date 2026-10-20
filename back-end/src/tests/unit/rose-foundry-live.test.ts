#!/usr/bin/env tsx

import 'dotenv/config';
import assert from 'node:assert/strict';

import { createStreamingCompletion } from '../../providers/rose';
import {
  FOUNDRY_REGION_ENV_NAMES,
  __resetFoundryCooldowns,
  foundryComplete,
  foundryRegions,
  foundryRoutePlan,
  type FoundryRegion,
} from '../../providers/rose/foundry';
import { getPool } from '../../providers/rose/pools';
import { StructuredOutputAccumulator } from '../../providers/rose/structuredOutput';
import type { ResponseFormat, RoseStreamChunk } from '../../providers/rose/types';

async function probe(
  name: string,
  options: {
    tools?: Array<Record<string, unknown>>;
    toolChoice?: unknown;
    responseFormat?: ResponseFormat;
  } = {}
): Promise<void> {
  const chunks: RoseStreamChunk[] = [];
  for await (const chunk of foundryComplete({
    poolSpec: getPool('rose-1-ultra'),
    messages: [{ role: 'user', content: 'Reply with hi. Use the tool if one is provided.' }],
    responseFormat: options.responseFormat,
    tools: options.tools,
    toolChoice: options.toolChoice,
    effort: 'xhigh',
    providerFastMode: true,
    requestId: `foundry-live-${name}`,
    routeKey: `foundry-live-${name}`,
  })) {
    chunks.push(chunk);
  }
  assert.equal(chunks[0]?.kind, 'metadata');
  assert.equal(chunks[0]?.data.actual_model, 'gpt-6-sol-foundry');
  assert(chunks.some((chunk) => chunk.kind === 'usage'));
  assert(chunks.some((chunk) => chunk.kind === 'done'));
  if (name === 'tool') {
    const tool = chunks.find((chunk) => chunk.kind === 'tool_call');
    assert(tool);
    assert.equal(typeof JSON.parse(String(tool.data.arguments)).text, 'string');
  } else {
    const result = new StructuredOutputAccumulator();
    for (const chunk of chunks) result.addChunk(chunk);
    const content = result.finalText();
    assert(content.length > 0);
    if (name === 'json') assert.equal(typeof JSON.parse(content).text, 'string');
  }
  process.stdout.write(`${name}: Foundry Responses contract passed\n`);
}

/** Probe one configured region (AZURE_FOUNDRY_* or *_2.._9) by making it the sole region. */
async function probeRegion(region: FoundryRegion): Promise<void> {
  const saved = FOUNDRY_REGION_ENV_NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of FOUNDRY_REGION_ENV_NAMES) delete process.env[name];
  process.env.AZURE_FOUNDRY_ENDPOINT = region.endpoint;
  process.env.AZURE_FOUNDRY_API_KEY = region.apiKey();
  process.env.AZURE_FOUNDRY_DEPLOYMENTS = region.deployments.join(',');
  __resetFoundryCooldowns();
  try {
    await probeContract();
    process.stdout.write(`region ${region.slot} (${region.host}): Foundry contract passed\n`);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function main(): Promise<void> {
  if (process.env.RUN_FOUNDRY_LIVE !== '1') return;
  // Regions that serve the Ultra pool's GPT-6 Sol deployment.
  const regions = foundryRegions().filter(
    (region) => foundryRoutePlan([region], getPool('rose-1-ultra').gptAuthModel, 'live').length > 0
  );
  assert(regions.length > 0, 'Foundry endpoint and key are required');
  for (const region of regions) await probeRegion(region);
  await roseUltraRoute();
}

async function probeContract(): Promise<void> {
  await probe('text');
  await probe('tool', {
    tools: [
      {
        name: 'answer',
        description: 'Return the short answer',
        strict: true,
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    ],
    toolChoice: { type: 'function', name: 'answer' },
  });
  await probe('json', {
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: 'short_answer',
        strict: true,
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
  });
}

async function roseUltraRoute(): Promise<void> {
  const gptKey = process.env.GPT_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.GPT_API_KEY = '';
    process.env.ANTHROPIC_API_KEY = '';
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-ultra',
      messages: [{ role: 'user', content: 'Reply with hi.' }],
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert(chunks.some((chunk) => chunk.actual_model === 'gpt-6-sol-foundry'));
    assert(chunks.some((chunk) => chunk.choices[0]?.delta.content));
    process.stdout.write('Rose Ultra route: Foundry selected\n');
  } finally {
    if (gptKey === undefined) delete process.env.GPT_API_KEY;
    else process.env.GPT_API_KEY = gptKey;
    if (anthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = anthropicKey;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.name : 'Foundry live test failed'}\n`);
  process.exitCode = 1;
});
