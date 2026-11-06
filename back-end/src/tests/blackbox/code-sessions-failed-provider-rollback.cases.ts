import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
import { revertCodeSessionProvider } from '../../providers/codeSessions/usageLimit';

export function registerFailedProviderRollbackCases(): void {
  for (const scenario of [
    'success',
    'foreign-owner',
    'same-owner-successor',
    'claim-loss',
    'paused-kill-failure',
    'active-kill-failure',
    'publication-lost',
    'local-binding',
  ] as const) {
    test(`failed provider rollback retains attempt custody: ${scenario}`, async (t) => {
      const attemptOwner = 'provider-switch:failed-attempt';
      const row = {
        id: 'rollback-fixture',
        codeProvider: 'codex',
        cliSessionId: null,
        state: scenario === 'active-kill-failure' ? 'ACTIVE' : 'PAUSED',
        sandboxKind: 'e2b',
        sandboxId: 'failed-sandbox',
        homeDir: null,
        leaseOwner: attemptOwner,
        leaseExpiresAt: null,
      };
      if (scenario === 'local-binding') row.sandboxKind = 'local';
      if (scenario === 'foreign-owner') row.leaseOwner = 'another-agent';
      if (scenario === 'same-owner-successor') {
        row.leaseOwner = 'provider-switch:successor-of-same-agent';
        row.sandboxId = 'successor-sandbox';
      }
      let kills = 0;
      let firstCas = true;
      const originalFind = prisma.codeSession.findUnique;
      const originalUpdate = prisma.codeSession.updateMany;
      t.after(() => {
        prisma.codeSession.findUnique = originalFind;
        prisma.codeSession.updateMany = originalUpdate;
      });
      prisma.codeSession.findUnique = (async () => ({ ...row })) as typeof originalFind;
      prisma.codeSession.updateMany = (async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (firstCas && scenario === 'claim-loss') row.leaseOwner = 'winner';
        firstCas = false;
        const matches = Object.entries(where).every(([key, value]) => {
          const actual = row[key as keyof typeof row];
          return typeof value === 'object' && value !== null && 'not' in value
            ? actual !== value.not
            : actual === value;
        });
        if (!matches) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }) as typeof originalUpdate;
      const run = () =>
        revertCodeSessionProvider(row.id, 'codex', 'claude', attemptOwner, async (id) => {
          kills++;
          assert.equal(id, 'failed-sandbox');
          assert.equal(row.codeProvider, 'codex');
          assert.equal(row.sandboxId, id);
          assert.match(row.leaseOwner, /^provider-revert:/);
          if (scenario.endsWith('kill-failure')) throw new Error('native kill rejected');
          if (scenario === 'publication-lost') {
            row.leaseOwner = 'successor-owner';
            row.sandboxId = 'successor-sandbox';
          }
        });
      if (scenario.endsWith('kill-failure')) {
        await assert.rejects(run, /native kill rejected/);
        assert.equal(kills, 1);
        assert.equal(row.codeProvider, 'codex');
        assert.equal(row.sandboxId, 'failed-sandbox');
        if (scenario === 'active-kill-failure') assert.match(row.leaseOwner, /^provider-revert:/);
        else assert.equal(row.leaseOwner, null);
      } else if (scenario === 'publication-lost') {
        assert.equal(await run(), false);
        assert.equal(kills, 1);
        assert.equal(row.codeProvider, 'codex');
        assert.equal(row.sandboxId, 'successor-sandbox');
        assert.equal(row.leaseOwner, 'successor-owner');
      } else if (scenario === 'success') {
        const reverted = await run();
        assert.equal(kills, 1);
        assert.equal(reverted, true);
        assert.equal(row.codeProvider, 'claude');
        assert.equal(row.sandboxId, null);
        assert.equal(row.leaseOwner, null);
      } else {
        const reverted = await run();
        assert.equal(kills, 0);
        assert.equal(row.codeProvider, 'codex');
        assert.equal(reverted, false);
        assert.equal(
          row.leaseOwner,
          scenario === 'claim-loss'
            ? 'winner'
            : scenario === 'foreign-owner'
              ? 'another-agent'
              : scenario === 'local-binding'
                ? attemptOwner
                : 'provider-switch:successor-of-same-agent'
        );
      }
    });
  }
}
