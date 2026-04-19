/**
 * i-message-sender domain blackbox
 *
 * Surface under test:
 *   - main/services/iMessageSender.ts
 *       IMessageSender.send({ to, message }) → shells out to `osascript -e <applescript>`
 *       to deliver an iMessage via the macOS Messages app. On first-attempt failure,
 *       a fallback AppleScript (participant-of-service form) is tried; if both fail,
 *       the error is re-thrown prefixed with "Failed to send iMessage:".
 *
 * Observable behavior exercised here:
 *   - Validation: missing `to` or `message` throws before any boundary call.
 *   - Happy path: primary `osascript -e <script>` is invoked with a script that contains
 *     the normalized recipient and the escaped message; no fallback is issued on success.
 *   - Recipient normalization: surrounding whitespace is trimmed before insertion.
 *   - AppleScript escaping: backslashes doubled, double-quotes backslash-escaped,
 *     newline/CR rewritten to \\n / \\r sequences. Order matters (backslashes first).
 *   - Fallback path: when the primary `osascript` call rejects, a second `osascript -e`
 *     call is made with the alternative (participant-of-service) script. On second success
 *     the function resolves without throwing.
 *   - Double failure: when BOTH osascript invocations reject, the original (primary) error
 *     is re-thrown wrapped in "Failed to send iMessage:" — the fallback error is dropped.
 *
 * Boundary capture:
 *   - System boundary is `child_process.execFile('osascript', ['-e', <script>])` invoked
 *     via util.promisify(execFile). The mock records every call (command + args) so tests
 *     assert on the exact shell-level contract. No outbound HTTP calls are expected from
 *     this domain — fetchCaptures is asserted empty as a hard invariant.
 *
 * Scope deferrals (per batch prompt):
 *   - flake x5 reruns, concurrent invocations, negative-control checks, broader-suite verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

// --- child_process.execFile mock -------------------------------------------
// iMessageSender captures `const execFileAsync = promisify(execFile)` at module
// load, so we must install the mock BEFORE importing the module under test.
// The mock must honor the Node callback contract used by promisify:
//   execFile(file, args, callback(err, { stdout, stderr }))

interface ExecFileCall {
  command: string;
  args: readonly string[];
}

type ExecFileHandler = (
  command: string,
  args: readonly string[]
) => { err: NodeJS.ErrnoException | null; stdout?: string; stderr?: string };

const cp = vi.hoisted(() => ({
  calls: [] as ExecFileCall[],
  // Default: every execFile succeeds with empty stdout.
  handler: ((_command: string, _args: readonly string[]) => ({
    err: null,
    stdout: '',
    stderr: '',
  })) as ExecFileHandler,
}));

const setExecFileHandler = (h: ExecFileHandler): void => {
  cp.handler = h;
};

vi.mock('child_process', () => {
  type ExecFileCb = (
    err: NodeJS.ErrnoException | null,
    result: { stdout: string; stderr: string }
  ) => void;

  const execFile = (command: string, args: readonly string[], callback: ExecFileCb): void => {
    cp.calls.push({ command, args });
    // promisify(execFile) wraps a Node-style callback: err !== null rejects, else
    // resolves with { stdout, stderr }. Defer to the microtask queue to match async shape.
    const result = cp.handler(command, args);
    queueMicrotask(() => {
      callback(result.err, { stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
    });
  };

  const mod = { execFile };
  return { ...mod, default: mod };
});

// --- helpers ----------------------------------------------------------------

const osascriptCalls = (): ExecFileCall[] => cp.calls.filter((c) => c.command === 'osascript');

const scriptOf = (call: ExecFileCall): string => {
  // osascript -e <script>
  expect(call.args[0]).toBe('-e');
  return call.args[1] ?? '';
};

describe('i-message-sender blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    cp.calls.length = 0;
    setExecFileHandler(() => ({ err: null, stdout: '', stderr: '' }));
    // Install fetch capture so we can assert zero outbound HTTP as a hard invariant.
    restoreFetch = installFetchCapture({});
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    vi.resetModules();
  });

  it('validation: missing recipient → throws without invoking osascript', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');

    await expect(IMessageSender.send({ to: '', message: 'hi' })).rejects.toThrow(
      'Recipient and message are required'
    );

    expect(osascriptCalls()).toHaveLength(0);
    expect(fetchCaptures).toHaveLength(0);
  });

  it('validation: missing message → throws without invoking osascript', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');

    await expect(IMessageSender.send({ to: '+15555551212', message: '' })).rejects.toThrow(
      'Recipient and message are required'
    );

    expect(osascriptCalls()).toHaveLength(0);
  });

  it('happy path: primary osascript succeeds → exactly one call, no fallback', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');

    await expect(
      IMessageSender.send({ to: '+15555551212', message: 'hello world' })
    ).resolves.toBeUndefined();

    const calls = osascriptCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('osascript');
    // First arg is always `-e`, second is the script body.
    expect(calls[0].args).toHaveLength(2);
    expect(calls[0].args[0]).toBe('-e');
  });

  it('boundary capture: primary script contains recipient + message verbatim, uses buddy lookup', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');

    await IMessageSender.send({ to: '+15555551212', message: 'hello world' });

    const script = scriptOf(osascriptCalls()[0]);
    // The primary script uses the `buddy ... of 1st account whose service type is iMessage` form.
    expect(script).toContain('tell application "Messages"');
    expect(script).toContain('buddy "+15555551212"');
    expect(script).toContain('1st account whose service type is iMessage');
    expect(script).toContain('send "hello world" to targetBuddy');
    expect(script).toContain('end tell');
  });

  it('boundary capture: recipient is trimmed before insertion into script', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');

    await IMessageSender.send({ to: '  +15555551212  \n', message: 'hi' });

    const script = scriptOf(osascriptCalls()[0]);
    expect(script).toContain('buddy "+15555551212"');
    // No leading/trailing whitespace made it into the quoted recipient.
    expect(script).not.toContain('buddy "  ');
    expect(script).not.toContain('  "');
  });

  it('boundary capture: double-quote in message is backslash-escaped in script', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');

    await IMessageSender.send({ to: '+15555551212', message: 'say "hi"' });

    const script = scriptOf(osascriptCalls()[0]);
    // Raw double-quote in the message must appear as \" inside the AppleScript string.
    expect(script).toContain('send "say \\"hi\\"" to targetBuddy');
  });

  it('boundary capture: backslash in message is doubled (escape order: backslash first)', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');

    await IMessageSender.send({ to: '+15555551212', message: 'path\\to' });

    const script = scriptOf(osascriptCalls()[0]);
    // A lone backslash in input becomes a double backslash in the AppleScript literal.
    expect(script).toContain('send "path\\\\to" to targetBuddy');
  });

  it('boundary capture: newline and carriage return are rewritten to \\n / \\r', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');

    await IMessageSender.send({ to: '+15555551212', message: 'line1\nline2\rline3' });

    const script = scriptOf(osascriptCalls()[0]);
    // Literal LF/CR are replaced by the two-character escape sequences \n / \r.
    expect(script).toContain('send "line1\\nline2\\rline3" to targetBuddy');
    // And no raw control characters leaked into the quoted message portion.
    const sendLine = script.split('\n').find((l) => l.includes('send '));
    expect(sendLine).toBeDefined();
    expect(sendLine).not.toMatch(/send "[^"]*[\r][^"]*" to targetBuddy/);
  });

  it('fallback path: primary osascript fails → alternative script invoked, resolves on success', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');

    // First call (primary) rejects; second call (fallback) succeeds.
    let invocations = 0;
    setExecFileHandler(() => {
      invocations += 1;
      if (invocations === 1) {
        return { err: Object.assign(new Error('primary failed'), { code: 1 }) };
      }
      return { err: null, stdout: '', stderr: '' };
    });

    await expect(
      IMessageSender.send({ to: '+15555551212', message: 'retry me' })
    ).resolves.toBeUndefined();

    const calls = osascriptCalls();
    expect(calls).toHaveLength(2);

    // Fallback script uses the `participant ... of targetService` form (distinct from primary).
    const fallbackScript = scriptOf(calls[1]);
    expect(fallbackScript).toContain(
      'set targetService to 1st account whose service type is iMessage'
    );
    expect(fallbackScript).toContain('participant "+15555551212" of targetService');
    expect(fallbackScript).toContain('send "retry me" to targetBuddy');
  });

  it('error state: both osascript invocations fail → throws wrapped error mentioning primary cause', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');

    setExecFileHandler(() => ({
      err: Object.assign(new Error('osascript boom'), { code: 1 }),
    }));

    await expect(IMessageSender.send({ to: '+15555551212', message: 'doomed' })).rejects.toThrow(
      /Failed to send iMessage:.*osascript boom/
    );

    // Exactly two osascript attempts were made (primary + fallback) before giving up.
    expect(osascriptCalls()).toHaveLength(2);
  });

  it('invariant: zero outbound HTTP calls across any send path', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');

    // Happy path.
    await IMessageSender.send({ to: '+15555551212', message: 'one' });
    // Fallback path.
    let invocations = 0;
    setExecFileHandler(() => {
      invocations += 1;
      if (invocations === 1) return { err: new Error('first fails') };
      return { err: null, stdout: '', stderr: '' };
    });
    await IMessageSender.send({ to: '+15555551212', message: 'two' });
    // Double-failure path.
    setExecFileHandler(() => ({ err: new Error('always fails') }));
    await expect(IMessageSender.send({ to: '+15555551212', message: 'three' })).rejects.toThrow(
      /Failed to send iMessage/
    );

    expect(fetchCaptures).toHaveLength(0);
  });
});
