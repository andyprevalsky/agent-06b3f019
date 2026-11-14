import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function main() {
  const state = new Map<string, unknown>();
  await mock.module('../../providers/sharedState', {
    namedExports: {
      getEphemeral: async (namespace: string, key: string) =>
        namespace === 'linq-chat' ? { chatId: 'chat', service: 'iMessage' } : state.get(key),
      putEphemeral: async (_namespace: string, key: string, value: unknown) => {
        state.set(key, value);
      },
      deleteEphemeral: async (_namespace: string, key: string) => {
        state.delete(key);
      },
      withSerializedLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
    },
  });
  const { startLinqTyping } = await import('../../providers/linq');
  Object.assign(process.env, {
    SMS_PROVIDER: 'linq',
    LINQ_TOKEN: 'test',
    LINQ_FROM_PHONE: '+12054015445',
    ALLOW_LIVE_MESSAGING: '1',
  });
  delete process.env.LINQ_RECIPIENTS;
  const methods: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    return new Response('{}');
  }) as typeof fetch;
  const stops: Array<() => Promise<void>> = [];
  try {
    stops.push(await startLinqTyping('+19729777432'));
    stops.push(await startLinqTyping('+19729777432'));
    await stops[0]();
    assert.deepEqual(
      methods,
      ['POST', 'POST'],
      'an obsolete run cannot clear the current run typing'
    );
    await stops[1]();
    assert.deepEqual(methods, ['POST', 'POST', 'DELETE']);
    process.stdout.write('linq-typing: passed\n');
  } finally {
    for (const stop of stops) await stop();
    globalThis.fetch = originalFetch;
  }
}
main().catch((error) => {
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});
