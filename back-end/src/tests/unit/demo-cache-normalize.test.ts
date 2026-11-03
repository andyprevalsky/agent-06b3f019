#!/usr/bin/env tsx
/**
 * Unit tests for the DEMO cache normalization + key builder (TS side).
 *
 * Proves the anti-bust + PII-stripping + canonical fingerprint invariants that
 * the cache relies on, and parity with the Python mirror (agents/providers/demo_cache).
 *
 * Run: npx tsx src/tests/unit/demo-cache-normalize.test.ts
 */

import assert from 'node:assert';
import { testRegisteredWmhExecutionPolicy } from './demo-cache-normalize-policy-controls';
import {
  normalizeUrl,
  canonicalMessages,
  goalHash,
  llmKey,
  browserHttpKey,
} from '../../domains/demo-cache/normalize';
import { isOaiDemoGoal } from '../../providers/demoCacheNormalizeOaiDemo';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

// #15 cache-busting query drift collapses to one key.
test('normalizeUrl strips volatile params + lowercases + sorts', () => {
  const a = normalizeUrl('https://Example.com/path/?utm_source=x&cb=123&b=2&a=1#frag');
  const b = normalizeUrl('https://example.com/path?a=1&b=2&cb=999999&gclid=zzz');
  assert.strictEqual(a, b);
  assert.strictEqual(a, 'https://example.com/path?a=1&b=2');
});

test('normalizeUrl drops default ports + trailing slash', () => {
  assert.strictEqual(normalizeUrl('https://x.com:443/a/'), 'https://x.com/a');
  assert.strictEqual(normalizeUrl('http://x.com:80/'), 'http://x.com/');
});

test('browserHttpKey is stable across cache-busters (anti-bust)', () => {
  const k1 = browserHttpKey('goal', 'GET', 'https://s.com/a?_=1&q=hi');
  const k2 = browserHttpKey('goal', 'get', 'https://s.com/a?q=hi&_=99999');
  assert.strictEqual(k1, k2);
});

test('browserHttpKey reuses public GETs across goals', () => {
  assert.strictEqual(
    browserHttpKey('goal-a', 'GET', 'https://s.com/a?q=hi'),
    browserHttpKey('goal-b', 'GET', 'https://s.com/a?q=hi')
  );
});

test('browserHttpKey partitions authenticated requests', () => {
  const publicKey = browserHttpKey('goal-a', 'GET', 'https://s.com/a?q=hi');
  const authA = browserHttpKey('goal-b', 'GET', 'https://s.com/a?q=hi', { Cookie: 'sid=a' });
  const authB = browserHttpKey('goal-b', 'GET', 'https://s.com/a?q=hi', { Cookie: 'sid=b' });
  assert.notStrictEqual(publicKey, authA);
  assert.notStrictEqual(authA, authB);
});

test('browserHttpKey scopes POST replay by goal and endpoint', () => {
  const a = browserHttpKey('goal', 'POST', 'https://s.com/api', undefined, '{"b":2,"a":1}');
  const b = browserHttpKey('goal', 'post', 'https://s.com/api', undefined, '{"a":1,"b":2}');
  const c = browserHttpKey('other goal', 'POST', 'https://s.com/api', undefined, '{"a":1,"b":2}');
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

// Parity with Python: same goal → same hash; exact-match (case-sensitive).
test('goalHash is exact-match', () => {
  assert.strictEqual(goalHash('buy milk'), goalHash('buy milk'));
  assert.notStrictEqual(goalHash('buy milk'), goalHash('buy MILK'));
});

// Parity with Python: run-local @ref:message pointers collapse before hashing,
// so sub-agent goals (which get a fresh message reference per run) share one
// namespace across reruns.
test('goalHash aliases Andy-named OAi-demo children onto the July Aman namespace', () => {
  const window = '2026-04-04 through 2026-07-03'; // pragma: allowlist secret
  const aman =
    'You are analyzing ONE creator for Aman Gottumukkala, a technology founder ' +
    `building a personal brand. Last 90 days: ${window}. Creator: Dr. Eric Topol.`; // pragma: allowlist secret
  const andy = aman.replaceAll('Aman Gottumukkala', 'Andy Prevalsky');
  assert.strictEqual(goalHash(andy), goalHash(aman));
  assert.strictEqual(goalHash(andy), 'a33288f6c3a3e484');
  const sahil = andy.replaceAll('Dr. Eric Topol', 'Sahil Bloom');
  assert.strictEqual(goalHash(sahil), '3fd2fec61970ac83');
  const otherAndy =
    'Find the current professional profile of Andy Prevalsky, founder of Rose Labs.';
  const otherAman = otherAndy.replaceAll('Andy Prevalsky', 'Aman Gottumukkala');
  assert.notStrictEqual(goalHash(otherAndy), goalHash(otherAman));
});

test('goalHash collapses run-local message refs', () => {
  const base = 'Analyze ONE creator.\nRow item:\nThomas DeLauer | YouTube';
  const runA = `${base}\n\nReference: @ref:message:3018fec0-93f2-4907-bba9-098cef49ab74`;
  const runB = `${base}\n\nReference: @ref:message:aaaabbbb-cccc-4ddd-8eee-ffff00001111`;
  assert.strictEqual(goalHash(runA), goalHash(runB));
  assert.strictEqual(goalHash(runA), goalHash(`${base}\n\nReference: @ref:message:<uuid>`));
  assert.notStrictEqual(goalHash(runA), goalHash(`Different goal${runA}`));
});

test('llmKey uses canonical request fingerprints', () => {
  assert.strictEqual(
    llmKey('g', 'execute_loop', { messages: [{ role: 'user', content: 'hello' }] }),
    llmKey('g', 'execute_loop', { messages: [{ content: 'hello', role: 'user' }] })
  );
  assert.notStrictEqual(
    llmKey('g', 'execute_loop', { messages: [{ role: 'user', content: 'hello' }] }),
    llmKey('g', 'execute_loop', { messages: [{ role: 'user', content: 'goodbye' }] })
  );
});

test('llmKey ignores browser step index in call site', () => {
  const request = { messages: [{ role: 'user', content: 'same browser request' }] };
  assert.strictEqual(
    llmKey('g', 'browser_use_step_2', request),
    llmKey('g', 'browser_use_step_7', request)
  );
  assert.ok(llmKey('g', 'browser_use_step_2', request).includes(':browser_use_step:c:'));
});

test('canonicalMessages ignores run-local ids and timestamps', () => {
  const a = {
    messages: [
      {
        role: 'user',
        content:
          '[STATE: now=2026-06-24T18:28:00Z]\n\n[2026-06-24 18:28] Run the task.\nReference: <resolved-ref pointer="@ref:message:11111111-1111-4111-8111-111111111111" title="x">',
      },
      {
        role: 'tool',
        tool_call_id: 'toolu_01AAAAAAAAAAAAAAAAAAAAAA',
        content:
          'TOOL_RESULT {"tool_call_id":"toolu_01AAAAAAAAAAAAAAAAAAAAAA","id":"22222222-2222-4222-8222-222222222222"}',
      },
    ],
    agent_id: '33333333-3333-4333-8333-333333333333',
    span_id: 'abcdef123456',
  };
  const b = {
    span_id: 'fedcba654321',
    agent_id: '44444444-4444-4444-8444-444444444444',
    messages: [
      {
        content:
          '[STATE: now=2026-06-24T18:34:00Z]\n\n[2026-06-24 18:34] Run the task.\nReference: <resolved-ref pointer="@ref:message:55555555-5555-4555-8555-555555555555" title="x">',
        role: 'user',
      },
      {
        content:
          'TOOL_RESULT {"tool_call_id":"toolu_01BBBBBBBBBBBBBBBBBBBBBB","id":"66666666-6666-4666-8666-666666666666"}',
        tool_call_id: 'toolu_01BBBBBBBBBBBBBBBBBBBBBB',
        role: 'tool',
      },
    ],
  };
  assert.strictEqual(canonicalMessages(a), canonicalMessages(b));
});

test('canonicalMessages normalizes code-agent runtime noise', () => {
  const a = {
    messages: [
      {
        role: 'tool',
        content:
          'TOOL_RESULT {"tool_name":"code_agent_sdk_events","result":"{\\n' +
          '  \\"timestamp\\": \\"2026-06-25T04:08:16.913Z\\",\\n' +
          '  \\"sandbox_id\\": \\"ituiwnzr4eqea3lh6uhl1\\"\\n}"}\n\n' +
          'Created E2B sandbox: ituiwnzr4eqea3lh6uhl1',
      },
    ],
  };
  const b = {
    messages: [
      {
        role: 'tool',
        content:
          'TOOL_RESULT {"tool_name":"code_agent_sdk_events","result":"{\\n' +
          '  \\"timestamp\\": \\"2026-06-25T04:16:27.334Z\\",\\n' +
          '  \\"sandbox_id\\": \\"i5lnhwwkqbm4pbdo02gm1\\"\\n}"}\n\n' +
          'Created E2B sandbox: i5lnhwwkqbm4pbdo02gm1',
      },
    ],
  };
  const changed = {
    messages: [
      {
        role: 'tool',
        content:
          'TOOL_RESULT {"tool_name":"code_agent_sdk_events","result":"{\\n' +
          '  \\"timestamp\\": \\"2026-06-25T04:16:27.334Z\\",\\n' +
          '  \\"sandbox_id\\": \\"i5lnhwwkqbm4pbdo02gm1\\",\\n' +
          '  \\"stdout\\": \\"different result\\"\\n}"}',
      },
    ],
  };
  assert.strictEqual(canonicalMessages(a), canonicalMessages(b));
  assert.notStrictEqual(canonicalMessages(a), canonicalMessages(changed));
});

test('canonicalMessages canonicalizes code-agent SDK event telemetry', () => {
  const toolResult = (payload: unknown) =>
    `TOOL_RESULT ${JSON.stringify({
      tool_name: 'code_agent_sdk_events',
      tool_call_id: null,
      result: `Code-agent SDK event JSON:\n\n${JSON.stringify(payload, null, 2)}`,
    })}`;
  const coldPayload = {
    code_agent_events: [
      {
        type: 'command',
        raw_type: 'item.started',
        status: 'started',
        command: '/bin/bash -lc pwd',
      },
      {
        type: 'command',
        raw_type: 'item.started',
        status: 'started',
        command: "/bin/bash -lc 'ls -la /home/user'",
      },
      {
        type: 'command',
        raw_type: 'item.completed',
        status: 'completed',
        command: '/bin/bash -lc pwd',
        exit_code: 0,
        output: '/home/user\n',
      },
      {
        type: 'command',
        raw_type: 'item.completed',
        status: 'completed',
        command: "/bin/bash -lc 'ls -la /home/user'",
        exit_code: 0,
        output:
          '/home/user:\n' +
          'total 64\n' +
          'drwxr-xr-x 6 user user 4096 Jun 25 06:11 .\n' +
          '-rw-r--r-- 1 user user 900 Jun 25 06:11 AGENTS.md\n',
      },
      {
        type: 'command',
        raw_type: 'item.completed',
        status: 'completed',
        command: 'python3 /home/user/output/collatz_27.py',
        exit_code: 0,
        output: 'Total steps: 111\n',
      },
    ],
    execution_summary: [
      'Created E2B sandbox: abc123sandbox',
      'Status update at 30s',
      'Extracted 1 output files',
    ],
    extracted_output_files: [{ path: '/home/user/output/collatz_27.py', size_bytes: 484 }],
  };
  const hotPayload = {
    ...coldPayload,
    code_agent_events: [
      coldPayload.code_agent_events[0],
      coldPayload.code_agent_events[2],
      coldPayload.code_agent_events[1],
      {
        ...coldPayload.code_agent_events[3],
        output:
          '/home/user:\n' +
          'total 64\n' +
          'drwxr-xr-x 6 user user 4096 Jun 25 06:13 .\n' +
          '-rw-r--r-- 1 user user 900 Jun 25 06:13 AGENTS.md\n',
      },
      coldPayload.code_agent_events[4],
    ],
    execution_summary: ['Created E2B sandbox: different456sandbox', 'Extracted 1 output files'],
  };
  const changedPayload = {
    ...hotPayload,
    code_agent_events: [
      ...hotPayload.code_agent_events.slice(0, 4),
      { ...hotPayload.code_agent_events[4], output: 'Total steps: 112\n' },
    ],
  };
  const request = (payload: unknown) => ({
    messages: [{ role: 'tool', content: toolResult(payload) }],
  });
  assert.strictEqual(
    canonicalMessages(request(coldPayload)),
    canonicalMessages(request(hotPayload))
  );
  assert.notStrictEqual(
    canonicalMessages(request(coldPayload)),
    canonicalMessages(request(changedPayload))
  );
});

test('canonicalMessages repairs capped raw code-agent SDK event text', () => {
  const payload = {
    code_agent_events: [
      {
        version: 1,
        provider: 'codex',
        type: 'command',
        raw_type: 'item.started',
        status: 'started',
        command: '/bin/bash -lc pwd',
      },
      {
        version: 1,
        provider: 'codex',
        timestamp: '2026-06-25T23:14:31.127Z',
        type: 'command',
        raw_type: 'item.completed',
        status: 'completed',
        command: '/bin/bash -lc pwd',
        output: '/home/user\n',
        exit_code: 0,
      },
      {
        version: 1,
        provider: 'codex',
        timestamp: '2026-06-25T23:15:18.137Z',
        type: 'final',
        status: 'completed',
        exit_code: 0,
        signal: null,
      },
    ],
    extracted_output_files: [{ path: '/home/user/output/collatz_27.py', size_bytes: 514 }],
    execution_summary: [
      'Created E2B sandbox: i57ri32j3jealyuuqwqhd',
      'Status update at 30s',
      'Extracted 1 output files',
    ],
  };
  const full = JSON.stringify(payload, null, 2);
  const startedIdx = full.indexOf('{\n      "version"');
  const completedIdx = full.indexOf('{\n      "version"', startedIdx + 1);
  const coldText = `Code-agent SDK event JSON:\n\n${full.slice(startedIdx)}`;
  const hotText =
    'Code-agent SDK event JSON:\n\n' +
    ': "/bin/bash -lc pwd"\n    },\n    ' +
    full
      .slice(completedIdx)
      .replace('2026-06-25T23:15:18.137Z', '2026-06-25T23:18:56.051Z')
      .replace('i57ri32j3jealyuuqwqhd', 'ies64r770imeqmunyr0fr')
      .replace('    "Status update at 30s",\n', '');
  const changedText = hotText.replace('/home/user\\n', '/tmp\\n');
  const request = (text: string) => ({ messages: [{ role: 'TOOL', text }] });

  assert.strictEqual(canonicalMessages(request(coldText)), canonicalMessages(request(hotText)));
  assert.notStrictEqual(
    canonicalMessages(request(coldText)),
    canonicalMessages(request(changedText))
  );
});

test('canonicalMessages normalizes browser result DOM and action index noise', () => {
  const base = {
    messages: [
      {
        role: 'tool',
        content:
          'Browser automation complete: **Status**: SUCCESS\n\n' +
          '**Actions Taken** (4 total, showing last 4):\n' +
          '  • click: {"action":"click","index":78,"params":{"index":78}}\n' +
          '  • input_text: {"action":"input_text","index":35,"params":{"index":35,"text":"benchmark-human@example.com"}}\n\n' +
          'TOOL_RESULT {"tool_name":"spawn_browser_agent","result":"  • click: {\\"action\\":\\"click\\",\\"index\\":78,\\"params\\":{\\"index\\":78}}"}\n' +
          '### DOM Tree (browser-extracted final-state page content)\n' +
          '[78]<div role=checkbox aria-checked=true />\n' +
          '|SHADOW(open)|[35]<input id=demo-email />\n' +
          'Token: eyJpcF9oYXNoIjoiabc","score":0.1\n' +
          'Risk Score: 0.04',
      },
    ],
  };
  const noisy = {
    messages: [
      {
        role: 'tool',
        content:
          'Browser automation complete: **Status**: SUCCESS\n\n' +
          '**Actions Taken** (4 total, showing last 4):\n' +
          '  • click: {"action":"click","index":74,"params":{"index":74}}\n' +
          '  • input_text: {"action":"input_text","index":30,"params":{"index":30,"text":"benchmark-human@example.com"}}\n\n' +
          'TOOL_RESULT {"tool_name":"spawn_browser_agent","result":"  • click: {\\"action\\":\\"click\\",\\"index\\":74,\\"params\\":{\\"index\\":74}}"}\n' +
          '### DOM Tree (browser-extracted final-state page content)\n' +
          '[74]<div role=checkbox aria-checked=true />\n' +
          '|SHADOW(open)|[30]<input id=demo-email />\n' +
          'Token: eyJpcF9oYXNoIjoixyz","score":0.9\n' +
          'Risk Score: 0.04',
      },
    ],
  };
  const changed = {
    messages: [
      {
        role: 'tool',
        content: noisy.messages[0].content.replace('Risk Score: 0.04', 'Risk Score: 0.91'),
      },
    ],
  };
  assert.strictEqual(canonicalMessages(base), canonicalMessages(noisy));
  assert.notStrictEqual(canonicalMessages(base), canonicalMessages(changed));
});

test('canonicalMessages sorts adjacent parallel tool results', () => {
  const base = {
    messages: [
      { role: 'user', content: 'Compare cities' },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'toolu_austin', function: { name: 'spawn_agent', arguments: '{}' } },
          { id: 'toolu_denver', function: { name: 'spawn_agent', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_austin', content: 'Austin result' },
      { role: 'tool', tool_call_id: 'toolu_denver', content: 'Denver result' },
      { role: 'assistant', content: 'Next step' },
    ],
  };
  const reordered = {
    messages: [
      base.messages[0],
      base.messages[1],
      { role: 'tool', tool_call_id: 'toolu_denver', content: 'Denver result' },
      { role: 'tool', tool_call_id: 'toolu_austin', content: 'Austin result' },
      base.messages[4],
    ],
  };
  const changed = {
    messages: [
      base.messages[0],
      base.messages[1],
      { role: 'tool', tool_call_id: 'toolu_denver', content: 'Different Denver result' },
      { role: 'tool', tool_call_id: 'toolu_austin', content: 'Austin result' },
      base.messages[4],
    ],
  };
  assert.strictEqual(canonicalMessages(base), canonicalMessages(reordered));
  assert.notStrictEqual(canonicalMessages(base), canonicalMessages(changed));
});

test('canonicalMessages sorts adjacent parallel user result messages', () => {
  const base = {
    messages: [
      { role: 'user', content: 'Run DAG' },
      { role: 'user', content: '[2026-06-24 21:48] [spawn_general_purpose_agent result]: NYC' },
      { role: 'user', content: '[2026-06-24 21:49] [spawn_general_purpose_agent result]: Tokyo' },
      { role: 'user', content: '[2026-06-24 21:50] [thought result]: use both values' },
    ],
  };
  const reordered = {
    messages: [
      base.messages[0],
      { role: 'user', content: '[2026-06-24 21:53] [spawn_general_purpose_agent result]: Tokyo' },
      { role: 'user', content: '[2026-06-24 21:53] [spawn_general_purpose_agent result]: NYC' },
      { role: 'user', content: '[2026-06-24 21:53] [thought result]: use both values' },
    ],
  };
  assert.strictEqual(canonicalMessages(base), canonicalMessages(reordered));
});

test('canonicalMessages sorts parallel TOOL_RESULT blocks inside text', () => {
  const base = {
    messages: [
      {
        role: 'user',
        content:
          'TOOL_RESULT {"tool_name": "spawn_general_purpose_agent", "tool_call_id": "toolu_NYC111111", "result": "NYC"}' +
          '\n\n' +
          'TOOL_RESULT {"tool_name": "spawn_general_purpose_agent", "tool_call_id": "toolu_TOKYO111111", "result": "Tokyo"}' +
          '\n\n' +
          'TOOL_RESULT {"tool_name": "thought", "tool_call_id": "toolu_THOUGHT111111", "result": "use both"}',
      },
    ],
  };
  const reordered = {
    messages: [
      {
        role: 'user',
        content:
          'TOOL_RESULT {"tool_name": "spawn_general_purpose_agent", "tool_call_id": "toolu_TOKYO222222", "result": "Tokyo"}' +
          '\n\n' +
          'TOOL_RESULT {"tool_name": "spawn_general_purpose_agent", "tool_call_id": "toolu_NYC222222", "result": "NYC"}' +
          '\n\n' +
          'TOOL_RESULT {"tool_name": "thought", "tool_call_id": "toolu_THOUGHT222222", "result": "use both"}',
      },
    ],
  };
  assert.strictEqual(canonicalMessages(base), canonicalMessages(reordered));
});

test('canonicalMessages normalizes provider JSON observation key order', () => {
  const base = {
    messages: [
      {
        role: 'tool',
        name: 'web_search',
        content:
          '[2026-06-24 21:48] {"answer":"Denver has a large job market.","sources":["https://example.com/a"],"query":"Denver jobs","provider":"parallel"}',
      },
    ],
  };
  const reordered = {
    messages: [
      {
        role: 'tool',
        name: 'web_search',
        content:
          '[2026-06-24 21:49] {"query":"Denver jobs","answer":"Denver has a large job market.","provider":"parallel","sources":["https://example.com/a"]}',
      },
    ],
  };
  const changed = {
    messages: [
      {
        role: 'tool',
        name: 'web_search',
        content:
          '[2026-06-24 21:49] {"query":"Denver jobs","answer":"Denver has a small job market.","provider":"parallel","sources":["https://example.com/a"]}',
      },
    ],
  };
  assert.strictEqual(canonicalMessages(base), canonicalMessages(reordered));
  assert.notStrictEqual(canonicalMessages(base), canonicalMessages(changed));
});

test('canonicalMessages normalizes web_fetch downloaded-file metadata', () => {
  const base = {
    messages: [
      {
        role: 'tool',
        name: 'web_fetch',
        content:
          '[2026-06-24 21:48] {"content":"Official housing facts","url":"https://example.com/housing","objective":"Extract facts","summarized":true,"downloaded_files":[{"id":"11111111-1111-4111-8111-111111111111","storage_path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111_Report.pdf","original_filename":"Report.pdf","mime_type":"application/pdf","size_bytes":123,"created_at":"2026-06-24T21:48:01Z"}],"links_discovered":4,"links_downloaded":1}',
      },
    ],
  };
  const noisy = {
    messages: [
      {
        role: 'tool',
        name: 'web_fetch',
        content:
          '[2026-06-24 21:49] {"objective":"Extract facts","url":"https://example.com/housing","downloaded_files":[{"id":"22222222-2222-4222-8222-222222222222","storage_path":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/22222222-2222-4222-8222-222222222222_Report.pdf","created_at":"2026-06-24T21:49:01Z","size_bytes":123,"mime_type":"application/pdf","original_filename":"Report.pdf"}],"links_downloaded":1,"content":"Official housing facts","links_discovered":4,"summarized":true}',
      },
    ],
  };
  const changed = {
    messages: [
      {
        role: 'tool',
        name: 'web_fetch',
        content:
          '[2026-06-24 21:49] {"objective":"Extract facts","url":"https://example.com/housing","downloaded_files":[],"links_downloaded":0,"content":"Different facts","links_discovered":4,"summarized":true}',
      },
    ],
  };
  assert.strictEqual(canonicalMessages(base), canonicalMessages(noisy));
  assert.notStrictEqual(canonicalMessages(base), canonicalMessages(changed));
});

test('worldModelCacheScope partitions simulated runs, real/shadow keys unchanged', () => {
  delete process.env.BENCHMARK_WORLD_MODEL_MODE;
  delete process.env.WMH_MODEL_NAME;
  const realKey = llmKey('goal', 'site', { messages: [] });
  assert.ok(realKey.startsWith('fastmode:v42:llm:'));

  process.env.BENCHMARK_WORLD_MODEL_MODE = 'simulate';
  process.env.WMH_MODEL_NAME = 'rose archive/v2';
  const simKey = llmKey('goal', 'site', { messages: [] });
  assert.notStrictEqual(simKey, realKey);
  assert.ok(simKey.includes(':sim.rose-archive-v2:'));

  // Shadow mode executes real calls — those cache entries are real signal.
  process.env.BENCHMARK_WORLD_MODEL_MODE = 'shadow';
  assert.strictEqual(llmKey('goal', 'site', { messages: [] }), realKey);
  delete process.env.BENCHMARK_WORLD_MODEL_MODE;
  delete process.env.WMH_MODEL_NAME;
});

test('isOaiDemoGoal matches only identity-bound mass-agent demo goals', () => {
  assert.strictEqual(
    isOaiDemoGoal(
      "I'm building a personal brand for health, longevity, technology, founder journey [x]"
    ),
    true
  );
  assert.strictEqual(
    isOaiDemoGoal('You are analyzing ONE creator for Andy Prevalsky — Huberman'),
    true
  );
  assert.strictEqual(isOaiDemoGoal('You are analyzing ONE creator for Andy'), false);
  assert.strictEqual(isOaiDemoGoal('You are analyzing ONE creator'), false);
  assert.strictEqual(
    isOaiDemoGoal('Order a Vanilla Bean Shakerato and waffle from Blue Bottle'),
    false
  );
});

test(
  'registered WMH policy isolates backend cache and mirrors exact Python metadata',
  testRegisteredWmhExecutionPolicy
);
if (failures.length > 0) {
  process.stderr.write(
    `\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`
  );
  process.exit(1);
}
process.stdout.write(`\n✅ demo-cache normalize: ${passed}/${passed} passed\n`);
