#!/usr/bin/env tsx
/* eslint-disable no-console */
/** Unit tests for Fast Mode code-agent noise normalization. */

import assert from 'node:assert';
import {
  canonicalMessages,
  codexKeyFromHash,
  webFetchKey,
  webSearchKey,
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

test('codexKeyFromHash normalizes empty successful output and empty running output', () => {
  const exited = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: done\n' +
          'Wall time: 0.0000 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 0\n' +
          'Output:\n',
      },
    ],
  };
  const running = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: running\n' +
          'Wall time: 1.0000 seconds\n' +
          'Process running with session ID 24656\n' +
          'Original token count: 1\n' +
          'Output:\n',
      },
    ],
  };
  const changed = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: done\n' +
          'Wall time: 0.0000 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 1\n' +
          'Output:\n' +
          'created file\n',
      },
    ],
  };
  assert.strictEqual(codexKeyFromHash('abc', exited), codexKeyFromHash('abc', running));
  assert.notStrictEqual(codexKeyFromHash('abc', exited), codexKeyFromHash('abc', changed));
});

test('codexKeyFromHash normalizes live-process polling noise', () => {
  const request = (sessionId: number, partialOutput: string, yieldTimeMs = 1000) => ({
    prompt_cache_key: '019f015c-6bea-7f21-aecc-68fd35ec53d2',
    client_metadata: { 'x-codex-installation-id': '11111111-1111-4111-8111-111111111111' },
    input: [
      {
        type: 'function_call',
        name: 'write_stdin',
        arguments: JSON.stringify({ session_id: sessionId, chars: '', yield_time_ms: yieldTimeMs }),
      },
      {
        type: 'function_call_output',
        output:
          'Chunk ID: abc123\n' +
          'Wall time: 1.0008 seconds\n' +
          `Process running with session ID ${sessionId}\n` +
          'Original token count: 12\n' +
          'Output:\n' +
          partialOutput,
      },
      {
        type: 'function_call_output',
        output:
          'Chunk ID: shell\n' +
          'Wall time: 0.0000 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 7\n' +
          'Output:\n' +
          '/home/user/.codex/shell_snapshots/11111111-1111-4111-8111-111111111111.1782434262046559997.sh\n',
      },
    ],
  });

  const hot = request(24656, '');
  const cold = request(
    10036,
    'Collecting pillow\n Downloading pillow-12.2.0.whl (7.1 MB)\n',
    30000
  );
  const changedFinalOutput = {
    ...hot,
    input: [
      hot.input[0],
      hot.input[1],
      {
        type: 'function_call_output',
        output:
          'Chunk ID: final\n' +
          'Wall time: 0.0000 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 4\n' +
          'Output:\n' +
          'created red file\n',
      },
    ],
  };

  assert.strictEqual(codexKeyFromHash('abc', cold), codexKeyFromHash('abc', hot));
  assert.notStrictEqual(codexKeyFromHash('abc', hot), codexKeyFromHash('abc', changedFinalOutput));
});

test('codexKeyFromHash normalizes stale process-id failures', () => {
  const a = {
    input: [
      {
        type: 'function_call_output',
        output: 'write_stdin failed: Unknown process id 86634',
      },
    ],
  };
  const b = {
    input: [
      {
        type: 'function_call_output',
        output: 'write_stdin failed: Unknown process id 15144',
      },
    ],
  };
  assert.strictEqual(codexKeyFromHash('abc', a), codexKeyFromHash('abc', b));
});

test('codexKeyFromHash strips npm update notices from command output', () => {
  const a = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: abc123\n' +
          'Wall time: 0.0000 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 2\n' +
          'Output:\n' +
          '2.1.193\n',
      },
    ],
  };
  const b = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: def456\n' +
          'Wall time: 0.5809 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 55\n' +
          'Output:\n' +
          '2.1.193\n' +
          'npm notice\n' +
          'npm notice New major version of npm available! 10.8.2 -> 11.17.0\n' +
          'npm notice Changelog: https://github.com/npm/cli/releases/tag/v11.17.0\n' +
          'npm notice To update run: npm install -g npm@11.17.0\n' +
          'npm notice\n',
      },
    ],
  };
  assert.strictEqual(codexKeyFromHash('abc', a), codexKeyFromHash('abc', b));
});

test('codexKeyFromHash normalizes ls long-listing mtimes', () => {
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
          '/home/user:\n' +
          'total 64\n' +
          'drwxr-xr-x 6 user user 4.0K Jun 25 05:57 .\n' +
          '-rw-r--r-- 1 user user 900 Jun 25 05:57 AGENTS.md\n',
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
          '/home/user:\n' +
          'total 64\n' +
          'drwxr-xr-x 6 user user 4.0K Jun 25 06:12 .\n' +
          '-rw-r--r-- 1 user user 900 Jun 25 06:12 AGENTS.md\n',
      },
    ],
  };
  const changed = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: zzz999\n' +
          'Wall time: 0.1234 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 99\n' +
          'Output:\n' +
          '/home/user:\n' +
          'total 64\n' +
          'drwxr-xr-x 6 user user 4096 Jun 25 06:12 .\n' +
          '-rw-r--r-- 1 user user 901 Jun 25 06:12 AGENTS.md\n',
      },
    ],
  };
  assert.strictEqual(codexKeyFromHash('abc', a), codexKeyFromHash('abc', b));
  assert.notStrictEqual(codexKeyFromHash('abc', a), codexKeyFromHash('abc', changed));
});

test('codexKeyFromHash normalizes package download progress rates', () => {
  const a = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: abc123\n' +
          'Wall time: 1.0008 seconds\n' +
          'Process running with session ID 85557\n' +
          'Original token count: 12\n' +
          'Output:\n' +
          'Collecting Pillow\n' +
          ' Downloading pillow-12.2.0.whl (7.1 MB)\n' +
          ' ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 7.1/7.1 MB 63.3 MB/s eta 0:00:00\n',
      },
    ],
  };
  const b = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: def456\n' +
          'Wall time: 1.0011 seconds\n' +
          'Process running with session ID 31569\n' +
          'Original token count: 12\n' +
          'Output:\n' +
          'Collecting Pillow\n' +
          ' Downloading pillow-12.2.0.whl (7.1 MB)\n' +
          ' ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 7.1/7.1 MB 57.3 MB/s eta 0:00:00\n',
      },
    ],
  };
  const changed = {
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: def456\n' +
          'Wall time: 1.0011 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 12\n' +
          'Output:\n' +
          'Collecting numpy\n' +
          ' Downloading numpy.whl (18.0 MB)\n' +
          ' ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 18.0/18.0 MB 57.3 MB/s eta 0:00:00\n',
      },
    ],
  };
  assert.strictEqual(codexKeyFromHash('abc', a), codexKeyFromHash('abc', b));
  assert.notStrictEqual(codexKeyFromHash('abc', a), codexKeyFromHash('abc', changed));
});

test('codexKeyFromHash normalizes completed package-manager progress noise', () => {
  const pip = (rate: string, prefix: string, success: string) => ({
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: pkg\n' +
          'Wall time: 4.2210 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 120\n' +
          'Output:\n' +
          prefix +
          ` ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 7.1/7.1 MB ${rate} eta 0:00:00\n` +
          'Installing collected packages: Pillow\n' +
          `${success}\n`,
      },
    ],
  });
  const npm = (duration: string, warn = false) => ({
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: npm\n' +
          'Wall time: 5.2210 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 80\n' +
          'Output:\n\n' +
          (warn ? 'npm warn deprecated phin@3.7.1: Package no longer supported.\n' : '') +
          `added 9 packages, and audited 11 packages in ${duration}\n\n` +
          '3 packages are looking for funding\n',
      },
    ],
  });

  assert.strictEqual(
    codexKeyFromHash(
      'abc',
      pip(
        '63.3 MB/s',
        'Collecting Pillow\n Downloading pillow-12.2.0.whl (7.1 MB)\n',
        'Successfully installed Pillow-12.2.0'
      )
    ),
    codexKeyFromHash(
      'abc',
      pip(
        '42.1 MB/s',
        'Collecting Pillow\nCollecting numpy\n Downloading pillow-12.2.0.whl (7.1 MB)\n',
        'Successfully installed Pillow-12.2.0'
      )
    )
  );
  assert.notStrictEqual(
    codexKeyFromHash(
      'abc',
      pip(
        '63.3 MB/s',
        'Collecting Pillow\n Downloading pillow-12.2.0.whl (7.1 MB)\n',
        'Successfully installed Pillow-12.2.0'
      )
    ),
    codexKeyFromHash(
      'abc',
      pip(
        '42.1 MB/s',
        'Collecting numpy\n Downloading numpy.whl (18.0 MB)\n',
        'Successfully installed numpy-2.2.6'
      )
    )
  );
  assert.strictEqual(
    codexKeyFromHash('abc', npm('4s')),
    codexKeyFromHash('abc', npm('883ms', true))
  );
});

test('codexKeyFromHash ignores optional pip installing status lines', () => {
  const request = (includeInstallingLine: boolean) => ({
    input: [
      {
        type: 'function_call_output',
        output:
          'Chunk ID: pkg\n' +
          'Wall time: 4.2210 seconds\n' +
          'Process exited with code 0\n' +
          'Original token count: 80\n' +
          'Output:\n' +
          (includeInstallingLine ? 'Installing collected packages: Pillow\n' : '') +
          'Successfully installed Pillow-12.2.0\n',
      },
    ],
  });
  assert.strictEqual(
    codexKeyFromHash('abc', request(true)),
    codexKeyFromHash('abc', request(false))
  );
});

test('canonicalMessages ignores code-agent heartbeat status updates', () => {
  const withHeartbeat = {
    messages: [
      {
        role: 'tool',
        content:
          '✓ Task Completed: **Status**: SUCCESS\n\n' +
          '**Actions Taken** (6 total, showing last 6):\n' +
          '  • Created E2B sandbox: <sandbox_id>\n' +
          '  • Status update at 30s\n' +
          '  • Agentic loop finished: 0 interactions\n',
      },
      {
        role: 'tool',
        content:
          'TOOL_RESULT {"tool_name":"claude_code_history","result":"Execution Summary:\\n\\nCreated E2B sandbox: sandboxabc123\\nStatus update at 30s\\nAgentic loop finished: 0 interactions"}',
      },
    ],
  };
  const withoutHeartbeat = {
    messages: [
      {
        role: 'tool',
        content:
          '✓ Task Completed: **Status**: SUCCESS\n\n' +
          '**Actions Taken** (5 total, showing last 5):\n' +
          '  • Created E2B sandbox: <sandbox_id>\n' +
          '  • Agentic loop finished: 0 interactions\n',
      },
      {
        role: 'tool',
        content:
          'TOOL_RESULT {"tool_name":"claude_code_history","result":"Execution Summary:\\n\\nCreated E2B sandbox: sandboxabc123\\nAgentic loop finished: 0 interactions"}',
      },
    ],
  };
  assert.strictEqual(canonicalMessages(withHeartbeat), canonicalMessages(withoutHeartbeat));
});

test('canonicalMessages ignores optional code-agent sandbox action line', () => {
  const withSandboxAction = {
    messages: [
      {
        role: 'tool',
        content:
          '✓ Task Completed: **Status**: ✅ SUCCESS\n\n' +
          '**Actions Taken** (6 total, showing last 6):\n' +
          '  • Created E2B sandbox: <sandbox_id>\n' +
          '  • Uploaded 1 files to /home/user/attachments/\n' +
          '  • Agentic loop finished: 0 interactions\n',
      },
      {
        role: 'tool',
        content:
          'TOOL_RESULT {"tool_name":"claude_code_history","result":"Execution Summary:\\n\\nCreated E2B sandbox: sandboxabc123\\nUploaded 1 files to /home/user/attachments/\\nAgentic loop finished: 0 interactions"}',
      },
    ],
  };
  const withoutSandboxAction = {
    messages: [
      {
        role: 'tool',
        content:
          '✓ Task Completed: **Status**: ✅ SUCCESS\n\n' +
          '**Actions Taken** (5 total, showing last 5):\n' +
          '  • Uploaded 1 files to /home/user/attachments/\n' +
          '  • Agentic loop finished: 0 interactions\n',
      },
      {
        role: 'tool',
        content:
          'TOOL_RESULT {"tool_name":"claude_code_history","result":"Execution Summary:\\n\\nUploaded 1 files to /home/user/attachments/\\nAgentic loop finished: 0 interactions"}',
      },
    ],
  };
  assert.strictEqual(canonicalMessages(withSandboxAction), canonicalMessages(withoutSandboxAction));
});

test('webFetchKey collapses cache-busters', () => {
  assert.strictEqual(
    webFetchKey('g', 'https://x.com/a?t=1'),
    webFetchKey('g', 'https://x.com/a?t=2')
  );
});

test('web provider keys are global across goals', () => {
  assert.strictEqual(
    webSearchKey('goal-a', 'Best cities to live in your 20s', 100),
    webSearchKey('goal-b', ' best   cities to LIVE in your 20s ', 100)
  );
  assert.strictEqual(
    webFetchKey('goal-a', 'https://x.com/a?t=1'),
    webFetchKey('goal-b', 'https://x.com/a?t=999')
  );
  assert.ok(webSearchKey('goal-a', 'query', 100).startsWith('fastmode:v42:web_search:global:'));
  assert.ok(webFetchKey('goal-a', 'https://x.com/a').startsWith('fastmode:v42:web_fetch:global:'));
});

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`\n✅ fast-cache code-agent normalize: ${passed}/${passed} passed`);
