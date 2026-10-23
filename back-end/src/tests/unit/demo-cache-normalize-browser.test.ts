#!/usr/bin/env tsx
/* eslint-disable no-console */
/** Unit tests for Fast Mode browser/message normalization. */

import assert from 'node:assert';
import {
  anthropicKeyFromHash,
  browserUseKey,
  canonicalMessages,
  codexKeyFromHash,
  contentKey,
  stripSecrets,
} from '../../domains/fast-cache/normalize';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

test('browserUseKey ignores dynamic browser-state noise', () => {
  const base = {
    task: 'Visit the page',
    browser_state: {
      url: 'https://example.com/path?cb=1',
      title: 'Example',
      dom_tree: 'Timestamp: 2026-06-24T18:29:05Z\n[42]<button />\n\tSubmit',
      scroll_position: { y: 230, pages_above: 0.3 },
      tabs: [{ id: 'FA31', url: 'https://example.com/path?cb=1' }],
    },
    action_entries: [
      {
        action: 'click',
        index: 77,
        coordinates: { x: 531, y: 564 },
        element_description: '[77] div',
        status: 'success',
      },
      { action: 'goto', url: 'https://example.com/path' },
    ],
    config: { browser_use_mode: 'claude' },
    turn_messages: [{ role: 'user', content: 'Screenshot captured (451162 bytes)' }],
  };
  const noisy = {
    task: 'Visit the page',
    browser_state: {
      url: 'https://example.com/path?cb=999',
      title: 'Example',
      dom_tree: 'Timestamp: 2026-06-24T18:35:08Z\n[40]<button />\n\tSubmit',
      scroll_position: { y: 112, pages_above: 0.1 },
      tabs: [{ id: '1407', url: 'https://example.com/path?cb=999' }],
    },
    action_entries: [
      {
        action: 'click',
        index: 72,
        coordinates: { x: 532, y: 663 },
        element_description: '[72] div',
        status: 'success',
      },
      { url: 'https://example.com/path', action: 'goto' },
    ],
    config: { browser_use_mode: 'claude' },
    turn_messages: [{ role: 'user', content: 'Screenshot captured (451055 bytes)' }],
  };
  const changedHistory = {
    ...noisy,
    action_entries: [
      { action: 'goto', url: 'https://example.com/path' },
      { action: 'click', index: 2, element_description: '[2] button Submit' },
    ],
  };
  assert.strictEqual(browserUseKey('goal', base), browserUseKey('goal', noisy));
  assert.notStrictEqual(browserUseKey('goal', base), browserUseKey('goal', changedHistory));
});

test('contentKey is independent of message count when semantic request matches', () => {
  const one = {
    model: 'rose-1',
    messages: [
      { role: 'system', content: 'static\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\nnow=1' },
      { role: 'user', content: 'hello' },
    ],
  };
  const two = {
    messages: [
      { content: 'static\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\nnow=2', role: 'system' },
      { content: 'hello', role: 'user' },
    ],
    model: 'rose-1',
  };
  assert.strictEqual(
    contentKey('g', 'chat_generator', one),
    contentKey('g', 'chat_generator', two)
  );
});

test('contentKey changes when user-visible message content changes', () => {
  assert.notStrictEqual(
    contentKey('g', 'chat_generator', { messages: [{ role: 'user', content: 'hello' }] }),
    contentKey('g', 'chat_generator', { messages: [{ role: 'user', content: 'goodbye' }] })
  );
});

test('canonicalMessages strips secrets and collapses blobs', () => {
  const canonical = canonicalMessages({
    Authorization: 'Bearer secret',
    keep: 'ok',
    image_url: { url: 'data:image/png;base64,huge' },
  });
  assert.strictEqual(canonical, '{"image_url":"<blob>","keep":"ok"}');
});

// #26 no secrets ever reach the stored value.
test('stripSecrets removes credentials recursively', () => {
  const cleaned = stripSecrets({
    Authorization: 'Bearer x',
    cookie: 's=1',
    'x-api-key': 'k',
    keep: 'ok',
    nested: { claude_token: 't', fine: 1 },
  });
  assert.deepStrictEqual(cleaned, { keep: 'ok', nested: { fine: 1 } });
});

test('anthropicKeyFromHash uses canonical request fingerprints', () => {
  assert.strictEqual(
    anthropicKeyFromHash('abc', { messages: [{ role: 'user', content: 'hello' }] }),
    anthropicKeyFromHash('abc', { messages: [{ content: 'hello', role: 'user' }] })
  );
  assert.notStrictEqual(
    anthropicKeyFromHash('abc', { messages: [{ role: 'user', content: 'hello' }] }),
    anthropicKeyFromHash('abc', { messages: [{ role: 'user', content: 'goodbye' }] })
  );
  assert.ok(
    anthropicKeyFromHash('abc', { messages: [] }).startsWith('fastmode:v42:anthropic:abc:c:')
  );
});

test('codexKeyFromHash uses canonical request fingerprints', () => {
  assert.strictEqual(
    codexKeyFromHash('abc', { input: [{ role: 'user', content: 'hello' }] }),
    codexKeyFromHash('abc', { input: [{ content: 'hello', role: 'user' }] })
  );
  assert.notStrictEqual(
    codexKeyFromHash('abc', { input: [{ role: 'user', content: 'hello' }] }),
    codexKeyFromHash('abc', { input: [{ role: 'user', content: 'goodbye' }] })
  );
  assert.ok(codexKeyFromHash('abc', { input: [] }).startsWith('fastmode:v42:codex:abc:c:'));
});

test('canonicalMessages ignores separate dynamic user context system message churn', () => {
  const request = (recentMessage: string, integrations: string[], userText = 'same goal') => ({
    messages: [
      { role: 'system', content: 'static system prompt' },
      {
        role: 'system',
        content:
          '# User Context\n\n' +
          '## User Profile\nName: Andy\n\n' +
          '## Connected Integrations\n' +
          integrations.map((name) => `- ${name}`).join('\n') +
          '\n\n## Recent Communications\n' +
          recentMessage +
          '\n\n## User Network\nAman | daily | 359 msgs\n',
      },
      { role: 'user', content: userText },
    ],
  });

  assert.strictEqual(
    canonicalMessages(
      request('[IMESSAGE] 2026-06-26 01:51 | Started a different task', [
        'chrome',
        'gpt_code',
        'chrome_passwords',
      ])
    ),
    canonicalMessages(
      request('[IMESSAGE] 2026-06-26 01:56 | New message arrived', [
        'chrome',
        'chrome_passwords',
        'gpt_code',
      ])
    )
  );
  assert.notStrictEqual(
    canonicalMessages(request('same context', ['chrome'], 'same goal')),
    canonicalMessages(request('same context', ['chrome'], 'different goal'))
  );
});

test('codexKeyFromHash normalizes run-local rose agent repo identity', () => {
  const request = (repoSlug: string, color = 'green') => ({
    instructions:
      'Repository workflow:\n' +
      `- The repository is cloned at /home/user/${repoSlug}.\n` +
      `- Remote: https://github.com/rose-gh-agent/${repoSlug}.git\n`,
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: abc123\n' +
          'Wall time: 0.0000 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 12\n' +
          'Output:\n' +
          `/home/user/${repoSlug}\n` +
          `origin\thttps://x-access-token:secret@github.com/rose-gh-agent/${repoSlug}.git (fetch)\n` +
          `origin\thttps://github.com/rose-gh-agent/${repoSlug}.git (push)\n` +
          `created /home/user/${repoSlug}/output/rs_${color}.png\n`,
      },
    ],
  });

  assert.strictEqual(
    codexKeyFromHash('abc', request('agent-b913fbea')),
    codexKeyFromHash('abc', request('agent-af3a523b'))
  );
  assert.notStrictEqual(
    codexKeyFromHash('abc', request('agent-b913fbea')),
    codexKeyFromHash('abc', request('agent-af3a523b', 'yellow'))
  );
});

test('codexKeyFromHash ignores Responses API volatile ids and encrypted blobs', () => {
  const a = {
    previous_response_id: 'resp_1234567890abcdef',
    input: [
      {
        id: 'rs_1234567890abcdef',
        type: 'reasoning',
        encrypted_content: 'opaque-a',
      },
      {
        id: 'msg_1234567890abcdef',
        type: 'message',
        content: [{ type: 'input_text', text: 'command output: 111 steps' }],
      },
    ],
  };
  const b = {
    previous_response_id: 'resp_fedcba0987654321',
    input: [
      {
        id: 'rs_fedcba0987654321',
        type: 'reasoning',
        encrypted_content: 'opaque-b',
      },
      {
        id: 'msg_fedcba0987654321',
        type: 'message',
        content: [{ type: 'input_text', text: 'command output: 111 steps' }],
      },
    ],
  };
  const changed = {
    ...b,
    input: [
      b.input[0],
      {
        id: 'msg_fedcba0987654321',
        type: 'message',
        content: [{ type: 'input_text', text: 'command output: 112 steps' }],
      },
    ],
  };
  assert.strictEqual(codexKeyFromHash('abc', a), codexKeyFromHash('abc', b));
  assert.notStrictEqual(codexKeyFromHash('abc', a), codexKeyFromHash('abc', changed));
});

test('codexKeyFromHash normalizes command wrapper noise and path listing order', () => {
  const a = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: abc123\n' +
          'Wall time: 0.0000 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 12\n' +
          'Output:\n' +
          '/home/user/b.txt\n' +
          '/home/user/a.txt\n',
      },
    ],
  };
  const b = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: def456\n' +
          'Wall time: 0.1234 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 99\n' +
          'Output:\n' +
          '/home/user/a.txt\n' +
          '/home/user/b.txt\n',
      },
    ],
  };
  const orderedProgramOutput = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: def456\n' +
          'Wall time: 0.1234 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 99\n' +
          'Output:\n' +
          '2\n' +
          '1\n',
      },
    ],
  };
  const changedProgramOutput = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: zzz999\n' +
          'Wall time: 0.1234 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 99\n' +
          'Output:\n' +
          '1\n' +
          '2\n',
      },
    ],
  };
  assert.strictEqual(codexKeyFromHash('abc', a), codexKeyFromHash('abc', b));
  assert.notStrictEqual(
    codexKeyFromHash('abc', orderedProgramOutput),
    codexKeyFromHash('abc', changedProgramOutput)
  );
});

test('codexKeyFromHash normalizes timestamped path listings', () => {
  const a = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: paths\n' +
          'Wall time: 0.0000 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 8\n' +
          'Output:\n' +
          '1782435343.0029090300 /home/user/b.txt\n' +
          '1782435211.8108716460 /home/user/a.txt\n',
      },
    ],
  };
  const b = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: paths2\n' +
          'Wall time: 0.0000 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 8\n' +
          'Output:\n' +
          '1782435999.1234567890 /home/user/a.txt\n' +
          '1782435888.1234567890 /home/user/b.txt\n',
      },
    ],
  };
  assert.strictEqual(codexKeyFromHash('abc', a), codexKeyFromHash('abc', b));
});

test('codexKeyFromHash normalizes ISO timestamps inside command output', () => {
  const request = (timestamp: string, cwd = '/home/user') => ({
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: date\n' +
          'Wall time: 0.0000 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 6\n' +
          'Output:\n' +
          `${cwd}\n` +
          `${timestamp}\n`,
      },
    ],
  });
  assert.strictEqual(
    codexKeyFromHash('abc', request('2026-06-26T01:38:50Z')),
    codexKeyFromHash('abc', request('2026-06-26T01:42:37Z'))
  );
  assert.notStrictEqual(
    codexKeyFromHash('abc', request('2026-06-26T01:38:50Z')),
    codexKeyFromHash('abc', request('2026-06-26T01:38:50Z', '/tmp'))
  );
});

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`\n✅ fast-cache browser/message normalize: ${passed}/${passed} passed`);
