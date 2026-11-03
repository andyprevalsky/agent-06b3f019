/** Exercise the exported notification entrypoint; stub only external effects. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { completionAnswerText } from '../../domains/agents/finalPresentation';

const path =
  process.env.R78_DISPATCH_SOURCE ??
  new URL('../../domains/send-sms/service.ts', import.meta.url).pathname;
const code = ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
let claims = 0,
  sends = 0,
  succeeded = 0,
  failed = 0;
let existing = false;
let delivery: Record<string, unknown> = { success: true };
let lastAnswer: unknown;
const noop = () => {};
const stubs: Record<string, unknown> = {
  '../agents/finalPresentation': { completionAnswerText },
  '../../providers/smsQueue': {},
  '../../providers/logger': { createLogger: () => ({ info: noop, warn: noop, error: noop }) },
  '../../providers/toolSideEffects': {
    claimToolSideEffect: async () => {
      claims++;
      return existing
        ? { status: 'existing', record: { status: 'succeeded' } }
        : { status: 'claimed' };
    },
    markToolSideEffectFailed: async () => {
      failed++;
    },
    markToolSideEffectSucceeded: async () => {
      succeeded++;
    },
  },
  '../../providers/smsSupervisor/outboundEvents': {
    notifyCompletion: async (...args: unknown[]) => {
      sends++;
      lastAnswer = args[5];
      return delivery;
    },
    buildCompletionSmsBody: () => '',
  },
  './repo': {
    findAgentDeletedStatus: async () => ({ deletedAt: null, isBenchmark: false, source: 'WEB' }),
  },
  './service.dispatch': {},
  '../../providers/smsSupervisor/channelDelivery': {
    notificationChannelsFor: () => ['SMS'],
    isWhatsAppConfigured: () => false,
  },
  '../../providers/whatsappReachability': { getWhatsAppReachable: async () => false },
};
const exports: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
vm.runInNewContext(code, {
  exports,
  require: (key: string) => {
    if (!(key in stubs)) throw new Error(`Unexpected external dependency ${key}`);
    return stubs[key];
  },
  console,
});
const value = {
  summary: '4',
  presentation: { version: 1, mode: 'value', field: 'day', encoding: 'text' },
  answerText: '4',
  outputs: [{ key: 'day', value: 4 }],
};
const call = (payload: unknown) =>
  exports.dispatchNotification({ user_id: 'u', agent_id: 'a', event_type: 'completion', payload });
async function main() {
  await call({ summary: 'legacy', outputs: [] });
  assert.equal(lastAnswer, undefined);
  await call(value);
  assert.equal(lastAnswer, '4');
  assert.deepEqual([claims, sends, succeeded, failed], [2, 2, 2, 0]);
  existing = true;
  await call(value);
  assert.equal(sends, 2);
  existing = false;
  delivery = { success: false, definitiveFailure: true, error: 'declined' };
  await assert.rejects(call(value), /declined/);
  assert.equal(failed, 1);
  delivery = { success: false, definitiveFailure: false, error: 'unknown delivery' };
  await assert.rejects(call(value), /unknown delivery/);
  assert.equal(failed, 1);
  const priorClaims = claims;
  await assert.rejects(call({ ...value, answerText: '5' }), /mismatch/);
  assert.equal(claims, priorClaims, 'invalid value must not claim delivery');
  process.stdout.write('actual notification dispatch legacy/value/dedup/failure PASS\n');
}
main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
