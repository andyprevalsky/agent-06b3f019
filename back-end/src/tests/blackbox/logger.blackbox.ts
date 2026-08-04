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
import { createLogger } from '../../providers/logger';

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
testCircularContextDoesNotThrow();

console.log('PASS logger (3 cases)');
