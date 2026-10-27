/**
 * Dev-log context serialization.
 *
 * The dev pretty-printer interpolates each context value into `key=value`. Any
 * object or array therefore rendered as `[object Object]`, which erased the
 * evidence an RCA needed (see
 * docs/rca/cases/2026-08-03-sms-purchase-request-never-delegated-to-start-agent.md
 * — every supervisor tool call logged as `[object Object]`).
 */

import assert from 'assert';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createLogger } from '../../providers/logger';
import { handleRouteError } from '../../domains/agents/routes.helpers';

function captureStdout(run: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

function testObjectAndArrayContextIsSerialized(): void {
  const log = createLogger('LoggerBlackbox');
  const line = captureStdout(() =>
    log.info('Parsed response', {
      toolCalls: [{ tool: 'start_new_agent', args: '{"budget_dollars":1}' }],
      usage: { promptTokens: 12 },
    })
  );

  assert.ok(
    !line.includes('[object Object]'),
    `context must not flatten to [object Object]: ${line}`
  );
  assert.ok(line.includes('"tool":"start_new_agent"'), `array context must serialize: ${line}`);
  assert.ok(line.includes('"promptTokens":12'), `object context must serialize: ${line}`);
}

function testPrimitiveContextIsUnchanged(): void {
  const log = createLogger('LoggerBlackbox');
  const line = captureStdout(() =>
    log.info('Parsed response', { toolCallCount: 2, reasoning: 'answering', missing: null })
  );

  assert.ok(line.includes('toolCallCount=2'), `numbers must stay bare: ${line}`);
  assert.ok(line.includes('reasoning=answering'), `strings must stay unquoted: ${line}`);
  assert.ok(line.includes('missing=null'), `null must stay readable: ${line}`);
}

/**
 * Serializing context is exactly what makes redaction necessary: request bodies
 * and provider payloads now render in full instead of `[object Object]`.
 */
function testSensitiveValuesAreRedacted(): void {
  const log = createLogger('LoggerBlackbox');
  const line = captureStdout(() =>
    log.info('Inbound request', {
      body: {
        phone: '+19725550123',
        password: 'hunter2',
        access_token: 'sk-live-secret',
        nested: { apiKey: 'ak-secret', keep: 'visible' },
      },
    })
  );

  assert.ok(!line.includes('hunter2'), `password must be redacted: ${line}`);
  assert.ok(!line.includes('sk-live-secret'), `token must be redacted: ${line}`);
  assert.ok(!line.includes('ak-secret'), `nested key material must be redacted: ${line}`);
  assert.ok(line.includes('"keep":"visible"'), `non-sensitive context must survive: ${line}`);

  // Production emits one-line JSON through a different branch, selected by an
  // `isDev` constant captured at module load — so it can only be exercised in a
  // process that starts with NODE_ENV=production.
  const tsxCli = path.join(
    path.dirname(createRequire(__filename).resolve('tsx/package.json')),
    'dist/cli.mjs'
  );
  const prodLine = execFileSync(
    process.execPath,
    [
      tsxCli,
      '-e',
      `require(${JSON.stringify(path.resolve(__dirname, '../../providers/logger'))})` +
        `.createLogger('ProdProbe').info('Inbound request', ` +
        `{ body: { password: 'hunter2', promptTokens: 12 } });`,
    ],
    { env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8' }
  );

  assert.ok(!prodLine.includes('hunter2'), `production JSON must redact secrets: ${prodLine}`);
  assert.ok(
    prodLine.includes('"promptTokens":12'),
    `token counts must survive redaction: ${prodLine}`
  );
  assert.ok(prodLine.trim().startsWith('{'), `production must emit JSON: ${prodLine}`);
}

/** An Error's message/stack are non-enumerable — JSON.stringify would drop them. */
function testErrorsKeepTheirDiagnostics(): void {
  const log = createLogger('LoggerBlackbox');
  const line = captureStdout(() => log.info('Failed', { error: new Error('boom-detail') }));

  assert.ok(line.includes('boom-detail'), `error message must survive: ${line}`);
  assert.ok(!line.includes('error={}'), `error must not serialize to an empty object: ${line}`);
}

function captureStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

/**
 * descend-full69 proof 2 (r001-j0013): an expired interactive transaction made
 * POST /api/agents/:id/messages 500. Prisma's message starts with a newline, so
 * the dev line read `error=` and line-based triage saw an empty error while the
 * cause sat on later lines. One log event must stay one line with its cause.
 */
function testMultilineRouteErrorStaysOnOneLine(): void {
  const prismaMessage =
    '\nInvalid `prisma.$queryRaw()` invocation:\n\n\nTransaction API error: Transaction already ' +
    'closed: A query cannot be executed on an expired transaction. The timeout for this ' +
    'transaction was 10000 ms, however 11302 ms passed since the start of the transaction.';
  let status = 0;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Parameters<typeof handleRouteError>[0];

  const output = captureStderr(() =>
    handleRouteError(res, new Error(prismaMessage), 'Failed to post message', {
      agent_id: 'bcb407af-535a-4bd2-849b-8bd7e137e64b',
    })
  );

  assert.strictEqual(status, 500);
  assert.deepStrictEqual(body, { error: 'Failed to post message' });
  const lines = output.split('\n').filter((line) => line !== '');
  assert.strictEqual(lines.length, 1, `one log event must be one line: ${JSON.stringify(output)}`);
  assert.ok(
    lines[0].includes('Transaction already closed') && lines[0].includes('11302 ms'),
    `the error= field must carry the cause on the logged line: ${lines[0]}`
  );
}

/** A logger must never be the thing that throws. */
function testCircularContextDoesNotThrow(): void {
  const log = createLogger('LoggerBlackbox');
  const circular: Record<string, unknown> = { name: 'root' };
  circular.self = circular;

  const line = captureStdout(() => log.info('Cyclic context', { circular }));
  assert.ok(line.includes('Cyclic context'), `line must still emit: ${line}`);
}

testObjectAndArrayContextIsSerialized();
testPrimitiveContextIsUnchanged();
testSensitiveValuesAreRedacted();
testErrorsKeepTheirDiagnostics();
testCircularContextDoesNotThrow();
testMultilineRouteErrorStaysOnOneLine();

console.log('PASS logger (6 cases)');
