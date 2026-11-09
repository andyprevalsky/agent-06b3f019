import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { codePreviewAutostartCommand } from '../../providers/codePreview/preview';
import { waitFor } from '../helpers/waitFor';

// E2B commands.run waits for the command's output pipe. Backgrounding the whole
// `mkdir && nohup …` list kept a subshell on that pipe for the preview's life,
// so every Rose session's autostart waited out its 10 s timeout (preview=10.0s
// in code-agent-rose-repo's startup phases, 2026-11-08).
test('preview autostart returns at once and leaves the preview running detached', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rose-autostart-'));
  const marker = join(home, 'preview-ran');
  mkdirSync(join(home, '.rose', 'bin'), { recursive: true });
  writeFileSync(
    join(home, '.rose', 'bin', 'rose-preview'),
    `#!/bin/sh\ntouch '${marker}'\nsleep 5\n`,
    { mode: 0o755 }
  );
  try {
    const started = Date.now();
    const { stdout } = await promisify(execFile)(
      'bash',
      ['-c', codePreviewAutostartCommand(home, 1000)],
      { timeout: 4000 }
    );
    const elapsed = Date.now() - started;
    assert.equal(stdout, '');
    assert.ok(elapsed < 2000, `autostart held the caller for ${elapsed} ms`);
    await waitFor('the detached preview marker', () => existsSync(marker), { timeoutMs: 4000 });
    assert.ok(existsSync(marker), 'the detached preview never started');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
