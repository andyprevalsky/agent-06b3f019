#!/usr/bin/env tsx
/**
 * Black-box tests (part 4) for the Vapi phone-payment tool envelope on
 * /api/test-payment/vapi-phone-payment-tool.
 *
 * Split from test-payment.blackbox.ts to stay under the max-lines cap.
 */

import 'dotenv/config';
import { z } from 'zod';

const BASE_URL = process.env.TEST_BASE_URL || '[REDACTED]';

const VapiToolResponse = z.object({
  results: z.array(
    z.object({
      toolCallId: z.string(),
      result: z.string(),
    })
  ),
});

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const contentType = response.headers.get('content-type');
  const data = contentType?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected)
    throw new Error(`Expected ${expected}, got ${actual}: ${JSON.stringify(data)}`);
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`${label} schema failed: ${parsed.error.message}`);
  return parsed.data;
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
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    'Vapi phone payment tool returns tool-call result envelope on validation failure',
    async () => {
      const response = await request('/api/test-payment/vapi-phone-payment-tool', {
        method: 'POST',
        body: JSON.stringify({
          message: {
            type: 'tool-calls',
            toolCallList: [
              {
                id: 'toolu_phone_payment_missing_cvc',
                name: 'complete_test_payment',
                arguments: {
                  card_number: '4242 4242 4242 4242',
                  expiration: '12/30',
                  billing_zip: '78731',
                },
              },
            ],
          },
        }),
      });
      assertStatus(response.status, 200, response.data);
      const body = assertSchema(VapiToolResponse, response.data, 'vapi payment tool');
      assert(
        body.results[0].toolCallId === 'toolu_phone_payment_missing_cvc',
        'wrong tool call id'
      );
      const result = JSON.parse(body.results[0].result) as { status?: string; error?: string };
      assert(result.status === 'failed', 'expected failed result');
      assert(String(result.error || '').includes('cvc'), `expected cvc error, got ${result.error}`);
    },
  ],
  [
    'Vapi phone payment tool accepts JSON-string tool arguments',
    async () => {
      const response = await request('/api/test-payment/vapi-phone-payment-tool', {
        method: 'POST',
        body: JSON.stringify({
          message: {
            type: 'tool-calls',
            toolCallList: [
              {
                id: 'toolu_phone_payment_string_args',
                name: 'complete_test_payment',
                arguments: JSON.stringify({
                  card_number: '4242 4242 4242 4242',
                  expiration: '12/30',
                  billing_zip: '78731',
                }),
              },
            ],
          },
        }),
      });
      assertStatus(response.status, 200, response.data);
      const body = assertSchema(VapiToolResponse, response.data, 'vapi payment tool');
      assert(
        body.results[0].toolCallId === 'toolu_phone_payment_string_args',
        'wrong tool call id'
      );
      const result = JSON.parse(body.results[0].result) as { status?: string; error?: string };
      assert(result.status === 'failed', 'expected failed result');
      assert(String(result.error || '').includes('cvc'), `expected cvc error, got ${result.error}`);
    },
  ],
  [
    'Vapi phone payment tool accepts nested function toolCalls payload',
    async () => {
      const response = await request('/api/test-payment/vapi-phone-payment-tool', {
        method: 'POST',
        body: JSON.stringify({
          message: {
            type: 'tool-calls',
            toolCalls: [
              {
                id: 'call_nested_missing_cvc',
                type: 'function',
                function: {
                  name: 'complete_test_payment',
                  arguments: {
                    card_number: '4242 4242 4242 4242',
                    expiration: '12/30',
                    billing_zip: '78731',
                  },
                },
              },
            ],
          },
        }),
      });
      assertStatus(response.status, 200, response.data);
      const body = assertSchema(VapiToolResponse, response.data, 'vapi payment tool');
      assert(body.results[0].toolCallId === 'call_nested_missing_cvc', 'wrong tool call id');
      const result = JSON.parse(body.results[0].result) as { status?: string; error?: string };
      assert(result.status === 'failed', 'expected failed result');
      assert(String(result.error || '').includes('cvc'), `expected cvc error, got ${result.error}`);
    },
  ],
];

async function main(): Promise<void> {
  process.stdout.write(`Running test-payment black-box tests part 4 (${tests.length} tests)...\n`);
  const results: TestResult[] = [];
  for (const [name, fn] of tests) results.push(await runTest(name, fn));
  const passed = results.filter((result) => result.passed).length;
  for (const result of results) {
    process.stdout.write(
      `${result.passed ? 'PASS' : 'FAIL'} ${result.name} (${result.duration}ms)\n`
    );
    if (!result.passed) process.stdout.write(`  ${result.error}\n`);
  }
  process.stdout.write(
    `\nTest-payment black-box tests part 4: ${passed}/${results.length} passed\n`
  );
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exit(1);
});
