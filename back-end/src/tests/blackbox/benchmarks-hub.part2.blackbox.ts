#!/usr/bin/env tsx
/**
 * Black-box tests (part 2) for Benchmark Hub run transcripts.
 *
 * Split from benchmarks-hub.blackbox.ts to stay under the max-lines cap.
 * Covers canonical tree shape and response_schema / Task Complete outputs.
 *
 *   npx tsx src/tests/blackbox/benchmarks-hub.part2.blackbox.ts
 */

import { config } from 'dotenv';
import { syntheticBenchmarkBundle } from './benchmarks-hub.testkit';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001'; // pragma: allowlist secret
const API_KEY = process.env.BACKEND_API_KEY || '';
const USER_ID = process.env.TEST_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const RUN_ID = `blackbox-hub-p2-${process.pid}-${Date.now()}`;
const ROOT_AGENT = `bb-p2-root-${process.pid}`;
const SUB_AGENT = `bb-p2-sub-${process.pid}`;

const internalHeaders = {
  'X-API-Key': API_KEY,
  'X-User-Id': USER_ID,
};

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const contentType = response.headers.get('content-type');
  const data = contentType?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected)
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

function syntheticBundle(): Record<string, unknown> {
  return syntheticBenchmarkBundle(RUN_ID, ROOT_AGENT, SUB_AGENT);
}

async function testRuns_toolUsageShapedTreeDoesNotInventEmptyChips(): Promise<void> {
  const runId = `${RUN_ID}-tool-usage-tree`;
  const bundle = syntheticBundle();
  bundle.run_id = runId;
  const tasks = bundle.tasks as Array<Record<string, unknown>>;
  const logs = tasks[0].logs as Record<string, unknown>;
  logs.tree = {
    root_agent_id: ROOT_AGENT,
    agent_count: 54,
    tool_usage_count: 9,
    llm_call_count: 4,
    tokens_in: 1,
    tokens_out: 1,
    total_cost_cents: 0,
    total_cost_dollars: 0,
    total_tokens_from_tools: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    [SUB_AGENT]: {
      parent_agent_id: ROOT_AGENT,
      goal: 'sub research goal',
      status: 'COMPLETED',
      messages: [
        {
          role: 'ASSISTANT',
          message: 'cached child trajectory',
          created_at: '2026-07-10T00:00:03Z',
        },
      ],
    },
  };

  try {
    const upload = await request(`${BASE_URL}/api/benchmarks/runs`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify(bundle),
    });
    assertStatus(upload.status, 201, upload.data);

    const rootView = await request(
      `${BASE_URL}/api/benchmarks/runs/${runId}/agents/${ROOT_AGENT}`,
      {
        headers: internalHeaders,
      }
    );
    assertStatus(rootView.status, 200, rootView.data);
    const tree = (
      rootView.data as {
        tree: Array<{ agent_id: string; message_count: number; status: string }>;
      }
    ).tree;
    const ids = tree.map((n) => n.agent_id);
    assert(!ids.includes('agent_count'), `tool-usage keys leaked into tree: ${ids}`);
    assert(!ids.includes('tool_usage_count'), `tool-usage keys leaked into tree: ${ids}`);
    assert(
      ids.includes(ROOT_AGENT) && ids.includes(SUB_AGENT),
      `canonical children missing: ${ids}`
    );
    const sub = tree.find((n) => n.agent_id === SUB_AGENT);
    assert((sub?.message_count ?? 0) > 0, 'child transcript dropped from mixed tool-usage tree');
    assert(sub?.status === 'COMPLETED', 'child must not render as spinning up');

    const subView = await request(`${BASE_URL}/api/benchmarks/runs/${runId}/agents/${SUB_AGENT}`, {
      headers: internalHeaders,
    });
    assertStatus(subView.status, 200, subView.data);
    const subMessages = (subView.data as { messages: Array<{ text: string }> }).messages;
    assert(
      subMessages[0].text === 'cached child trajectory',
      'child trajectory missing after tool-usage rollup mix-in'
    );
  } finally {
    await request(`${BASE_URL}/api/benchmarks/runs/${runId}`, {
      method: 'DELETE',
      headers: internalHeaders,
    });
  }
}

async function testRuns_copiesResponseSchemaAndFinalOutputs(): Promise<void> {
  const runId = `${RUN_ID}-schema`;
  const bundle = syntheticBundle();
  bundle.run_id = runId;
  const schema = {
    fields: [
      {
        name: 'positioning_statement',
        type: 'str',
        required: true,
        description: "Aman's differentiated positioning",
      },
    ],
  };
  const structured = { positioning_statement: 'Engineer approach to longevity' };
  const tasks = bundle.tasks as Array<Record<string, unknown>>;
  const logs = tasks[0].logs as Record<string, unknown>;
  const tree = logs.tree as Record<string, Record<string, unknown>>;
  const rootNode = tree[ROOT_AGENT];
  rootNode.response_schema = schema;
  rootNode.structured_output = structured;
  rootNode.tokens_out = 29515;
  rootNode.context_size = 185193;
  rootNode.messages = [
    ...((rootNode.messages as Array<Record<string, unknown>>) ?? []),
    {
      role: 'TOOL',
      message: '',
      created_at: '2026-07-10T00:00:04Z',
      metadata: {
        isFinalSummary: true,
        toolName: 'completion_summary',
        toolStatus: 'FINISHED',
        completionSummary: {
          summary: 'Completed a 50-creator competitive analysis.',
          outputs: [
            {
              key: 'positioning_statement',
              label: 'Positioning Statement',
              value: structured.positioning_statement,
            },
          ],
          totalToolCalls: 127,
          durationSeconds: 133,
          costDollars: 0.0885,
        },
      },
    },
  ];

  try {
    const upload = await request(`${BASE_URL}/api/benchmarks/runs`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify(bundle),
    });
    assertStatus(upload.status, 201, upload.data);

    const rootView = await request(
      `${BASE_URL}/api/benchmarks/runs/${runId}/agents/${ROOT_AGENT}`,
      {
        headers: internalHeaders,
      }
    );
    assertStatus(rootView.status, 200, rootView.data);
    const root = rootView.data as {
      agent: {
        response_schema: { fields: Array<{ name: string }> } | null;
        structured_output: { positioning_statement?: string } | null;
        tokens_out: number;
        context_size: number;
      };
      messages: Array<{
        metadata?: {
          isFinalSummary?: boolean;
          completionSummary?: { outputs?: Array<{ key: string; value: string }> };
        };
      }>;
    };
    assert(root.agent.response_schema !== null, 'Hub adapter dropped response_schema');
    assert(
      root.agent.response_schema?.fields?.[0]?.name === 'positioning_statement',
      `schema fields ${JSON.stringify(root.agent.response_schema)}`
    );
    assert(
      root.agent.structured_output?.positioning_statement === 'Engineer approach to longevity',
      'Hub adapter dropped structured_output'
    );
    assert(root.agent.tokens_out === 29515, `tokens_out ${root.agent.tokens_out} != 29515`);
    assert(root.agent.context_size === 185193, `context_size ${root.agent.context_size}`);
    const final = root.messages.find((message) => message.metadata?.isFinalSummary);
    assert(
      (final?.metadata?.completionSummary?.outputs?.length ?? 0) === 1,
      'final outputs missing'
    );
    assert(
      final?.metadata?.completionSummary?.outputs?.[0]?.key === 'positioning_statement',
      'final output key mismatch'
    );
  } finally {
    await request(`${BASE_URL}/api/benchmarks/runs/${runId}`, {
      method: 'DELETE',
      headers: internalHeaders,
    });
  }
}

async function testRuns_derivesResponseSchemaFromFinalOutputs(): Promise<void> {
  const runId = `${RUN_ID}-schema-derived`;
  const bundle = syntheticBundle();
  bundle.run_id = runId;
  const tasks = bundle.tasks as Array<Record<string, unknown>>;
  const logs = tasks[0].logs as Record<string, unknown>;
  const tree = logs.tree as Record<string, Record<string, unknown>>;
  const rootNode = tree[ROOT_AGENT];
  delete rootNode.response_schema;
  delete rootNode.structured_output;
  rootNode.messages = [
    ...((rootNode.messages as Array<Record<string, unknown>>) ?? []),
    {
      role: 'TOOL',
      message: '',
      created_at: '2026-07-10T00:00:04Z',
      metadata: {
        isFinalSummary: true,
        toolName: 'completion_summary',
        toolStatus: 'FINISHED',
        completionSummary: {
          summary: 'Completed a 50-creator competitive analysis.',
          outputs: [
            {
              key: 'top_creators_analysis',
              label: 'Top Creators Analysis',
              value: '1. Andrew Huberman',
            },
            {
              key: 'positioning_statement',
              label: 'Positioning Statement',
              value: 'Engineer approach to longevity',
            },
          ],
          totalToolCalls: 127,
          durationSeconds: 133,
          costDollars: 0.0885,
        },
      },
    },
  ];

  try {
    const upload = await request(`${BASE_URL}/api/benchmarks/runs`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify(bundle),
    });
    assertStatus(upload.status, 201, upload.data);

    const rootView = await request(
      `${BASE_URL}/api/benchmarks/runs/${runId}/agents/${ROOT_AGENT}`,
      {
        headers: internalHeaders,
      }
    );
    assertStatus(rootView.status, 200, rootView.data);
    const root = rootView.data as {
      agent: {
        response_schema: { fields: Array<{ name: string }> } | null;
        structured_output: { positioning_statement?: string } | null;
      };
    };
    const names = (root.agent.response_schema?.fields ?? []).map((field) => field.name);
    assert(
      names.includes('positioning_statement') && names.includes('top_creators_analysis'),
      `derived schema fields ${JSON.stringify(root.agent.response_schema)}`
    );
    assert(
      root.agent.structured_output?.positioning_statement === 'Engineer approach to longevity',
      'derived structured_output missing'
    );
  } finally {
    await request(`${BASE_URL}/api/benchmarks/runs/${runId}`, {
      method: 'DELETE',
      headers: internalHeaders,
    });
  }
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

async function runAll(): Promise<void> {
  if (!API_KEY) {
    console.error('BACKEND_API_KEY required (internal auth for hub endpoints)');
    process.exit(1);
  }
  const tests: Array<[string, () => Promise<void>]> = [
    [
      'runs: tool-usage logs.tree does not invent empty chips',
      testRuns_toolUsageShapedTreeDoesNotInventEmptyChips,
    ],
    [
      'runs: copies response_schema and final outputs',
      testRuns_copiesResponseSchemaAndFinalOutputs,
    ],
    [
      'runs: derives response_schema from final outputs',
      testRuns_derivesResponseSchemaFromFinalOutputs,
    ],
  ];

  const results: TestResult[] = [];
  for (const [name, fn] of tests) {
    results.push(await runTest(name, fn));
  }

  console.log('\nBenchmark Hub part2 black-box results');
  console.log('='.repeat(50));
  for (const r of results) {
    console.log(
      `${r.passed ? '  PASS' : '  FAIL'}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`
    );
  }
  const failed = results.filter((r) => !r.passed);
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

runAll().catch((error) => {
  console.error('Benchmark Hub part2 black-box suite crashed:', error);
  process.exit(1);
});
