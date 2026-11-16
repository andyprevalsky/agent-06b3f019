import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export async function verifyAgentInitShellWords(modulePath, hostileCli = true) {
  const { agentGuide, setupStatus } = await import(pathToFileURL(modulePath).href);
  const dir = mkdtempSync(join(tmpdir(), 'rose-command-quoting-'));
  const cli = join(
    dir,
    hostileCli ? "rose cli ' $(printf CLI) `printf TICK` $ROSE_QUOTE_TEST" : 'rose'
  );
  writeFileSync(
    cli,
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n'
  );
  chmodSync(cli, 0o700);
  const name = "checkout ' $(printf NAME) `printf TICK` $ROSE_QUOTE_TEST; next\nline";
  const capture = {
    root: join(dir, name),
    manifest: { git: { remoteUrl: 'local-fixture', branch: 'main' } },
    files: [],
  };
  const login = { project: null, expiresAt: '2099-01-01T00:00:00Z' };
  function execute(command, expected) {
    const result = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      env: { ...process.env, ROSE_QUOTE_TEST: 'EXPANDED' },
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  try {
    const guide = agentGuide({ login, capture, cli });
    // A newline in a shell-quoted word spans display lines. Use stable guide
    // section delimiters, never split the untrusted command by newline.
    const commandBetween = (start, end) =>
      guide
        .slice(guide.indexOf(start) + start.length, guide.indexOf(end, guide.indexOf(start)))
        .trimEnd();
    execute(commandBetween('   Run: ', '\n   It reports'), ['status', '--json']);
    execute(commandBetween('5. Upload.\n   Run: ', ' [--branch'), ['push', '--project', name]);
    execute(commandBetween('6. Verify.\n   Run: ', '\n   Every env file'), [
      'agent-init',
      'status',
      '--project',
      name,
    ]);
    execute(commandBetween('Run "', '" at any time'), ['agent-init', 'status']);
    assert(guide.includes('--setup "<command>"'), 'setup placeholder unchanged');
    const untrustedId = "id ' $(printf ID) `printf TICK` $ROSE_QUOTE_TEST";
    const boundGuide = agentGuide({
      login: { ...login, project: { id: untrustedId, name: 'Bound' } },
      capture,
      cli,
    });
    const boundStart = boundGuide.indexOf('5. Upload.\n   Run: ') + '5. Upload.\n   Run: '.length;
    execute(boundGuide.slice(boundStart, boundGuide.indexOf(' [--branch', boundStart)), [
      'push',
      '--project',
      untrustedId,
    ]);
    const missing = await setupStatus({
      call: async () => ({ projects: [] }),
      login,
      capture,
      projectName: name,
      cli,
    });
    execute(missing.next.split('run: ')[1], ['push', '--project', name]);
    const bound = {
      ...login,
      project: { id: '00000000-0000-4000-8000-000000000001', name: 'Bound' },
    };
    const awaiting = await setupStatus({
      call: async (_method, path) =>
        path === '/api/projects'
          ? {
              projects: [{ id: bound.project.id, name: 'Bound', sync: { revision: 0 } }],
            }
          : { envFiles: [] },
      login: bound,
      capture,
      cli,
    });
    execute(awaiting.next.split('run: ')[1], ['push', '--project', bound.project.id]);
    const placeholder = agentGuide({ login, capture: null, cli: 'rose' });
    assert(placeholder.includes('--project "<name>"'), 'missing-name placeholder unchanged');
    assert(
      placeholder.includes('4. APPROVAL: ask before uploading.'),
      'approval boundary unchanged'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
