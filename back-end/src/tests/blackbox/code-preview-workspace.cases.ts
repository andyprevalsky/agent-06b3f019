/** Preview CLI rollout and explicit legacy-disabled contract. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { prepareCodeSessionWorkspace } from '../../providers/codeSessionWorkspace';
import { CODE_PREVIEW_CLI_PATH } from '../../providers/codePreview/preview';

export function previewWorkspaceCases(f: {
  devUser: string;
  otherUser: string;
  agentFor: (userId: string) => Promise<string>;
}) {
  test('enabled sessions get preview CLI and env; explicitly disabled sessions get neither', async () => {
    const agentId = await f.agentFor(f.devUser);
    const dev = await prepareCodeSessionWorkspace(f.devUser, agentId, randomUUID(), 'claude');
    assert.ok(dev, 'dev workspace prepared');
    assert.ok(
      dev.files.some((file) => file.path === CODE_PREVIEW_CLI_PATH),
      'rose-preview installed'
    );
    assert.equal(dev.envs.ROSE_PREVIEW_PORT, '5173');
    assert.match(dev.envs.ROSE_PREVIEW_BACKEND_URL ?? '', /^https?:\/\//);
    assert.equal(dev.localEnvs?.ROSE_PREVIEW_PORT, '', 'same-host sessions pick a free port');
    const otherAgent = await f.agentFor(f.otherUser);
    const enabled = await prepareCodeSessionWorkspace(
      f.otherUser,
      otherAgent,
      randomUUID(),
      'claude'
    );
    assert.ok(enabled?.files.some((file) => file.path === CODE_PREVIEW_CLI_PATH));
    assert.equal(enabled?.envs.ROSE_PREVIEW_PORT, '5173');
    const other = await prepareCodeSessionWorkspace(
      f.otherUser,
      otherAgent,
      randomUUID(),
      'claude',
      false
    );
    assert.ok(!(other?.files ?? []).some((file) => file.path === CODE_PREVIEW_CLI_PATH));
    assert.equal(other?.envs.ROSE_PREVIEW_PORT, undefined);
  });
}
