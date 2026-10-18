import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openPhoneValue, sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import { prisma } from '../../providers/database';
import type { Case } from './iphone-control.cases';

export const privacyCases: Case[] = [
  [
    'unregistered user input cannot enter command receipts, status or task observations',
    async (h) => {
      const f = await h.fixture();
      const context = await prisma.browserContext.create({
        data: { userId: f.userId, contextId: randomUUID() },
      });
      const browser = await prisma.browserSession.create({
        data: { contextId: context.id, agentId: f.agentId, sessionId: randomUUID() },
      });
      await prisma.iPhoneLease.update({
        where: { id: f.leaseId },
        data: { browserTaskId: browser.id },
      });
      const takeover = await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        actor: 'user',
        method: 'POST',
        body: { mode: 'user' },
      });
      assert.equal(takeover.status, 200);
      const canary = `unregistered-${randomUUID()}-${randomUUID()}`;
      const operationId = randomUUID();
      h.echoInputResult = true;
      const receipt = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        actor: 'user',
        method: 'POST',
        body: { operationId, operation: 'input.text', args: { s: canary } },
      });
      assert.equal(receipt.status, 200);
      const status = await h.request(f.userId, `/leases/${f.leaseId}/operations/${operationId}`);
      const interaction = await h.request(f.userId, `/interactions/${browser.id}`);
      assert.equal(status.status, 200);
      assert.equal(interaction.status, 200);
      const replay = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        actor: 'user',
        method: 'POST',
        body: { operationId, operation: 'input.text', args: { s: canary } },
      });
      assert.equal(replay.status, 200);
      assert.equal(
        h.physicalOperations.filter((op) => op.op === 'input.text' && op.kw.s === canary).length,
        1,
        'Stable private intent replay executed physical input twice'
      );
      await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        actor: 'user',
        method: 'POST',
        body: { mode: 'agent' },
      });
      h.observationResult = { text: `visible ${canary}`, nested: { error: canary } };
      const ocr = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
      });
      assert.equal(ocr.status, 200);
      const rows = await prisma.iPhoneOperation.findMany({ where: { leaseId: f.leaseId } });
      assert.ok(!JSON.stringify(rows).includes(canary), 'Plaintext secret persisted in phone rows');
      for (const row of rows)
        if (row.resultEncrypted !== null)
          assert.ok(
            !JSON.stringify(openPhoneValue(row.resultEncrypted)).includes(canary),
            'Private echo retained inside result envelope'
          );
      const leaked = Object.entries({
        receipt: receipt.data,
        status: status.data,
        interaction: interaction.data,
        replay: replay.data,
        ocr: ocr.data,
      })
        .filter(([, value]) => JSON.stringify(value).includes(canary))
        .map(([surface]) => surface);
      assert.equal(leaked.join(','), '', `Unregistered input exposed by: ${leaked.join(',')}`);
    },
  ],
  [
    'unregistered transport error echoes stay private',
    async (h) => {
      const f = await h.fixture();
      const canary = `unregistered-error-${randomUUID()}`;
      await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        actor: 'user',
        method: 'POST',
        body: { mode: 'user' },
      });
      h.inputMode = 'echo-error';
      h.errorEcho = canary;
      const operationId = randomUUID();
      const receipt = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        actor: 'user',
        method: 'POST',
        body: { operationId, operation: 'input.text', args: { s: canary } },
      });
      assert.equal(receipt.status, 200);
      const status = await h.request(f.userId, `/leases/${f.leaseId}/operations/${operationId}`);
      assert.ok(
        !JSON.stringify([receipt.data, status.data]).includes(canary),
        'Transport error echoed unregistered input'
      );
      const rows = await prisma.iPhoneOperation.findMany({ where: { leaseId: f.leaseId } });
      assert.ok(!JSON.stringify(rows).includes(canary), 'Transport error stored plaintext input');
    },
  ],
  [
    'private phase blocks model media but preserves owner PNG and explicit user resume',
    async (h) => {
      const f = await h.fixture();
      const context = await prisma.browserContext.create({
        data: { userId: f.userId, contextId: randomUUID() },
      });
      const browser = await prisma.browserSession.create({
        data: { contextId: context.id, agentId: f.agentId, sessionId: randomUUID() },
      });
      await prisma.iPhoneLease.update({
        where: { id: f.leaseId },
        data: { browserTaskId: browser.id },
      });
      await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        actor: 'user',
        method: 'POST',
        body: { mode: 'user' },
      });
      const canary = `phase-${randomUUID()}`;
      await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        actor: 'user',
        method: 'POST',
        body: { operationId: randomUUID(), operation: 'input.text', args: { s: canary } },
      });
      const calls = h.calls.length;
      assert.equal(
        (await h.request(f.userId, `/leases/${f.leaseId}/frame`)).status,
        409,
        'Internal frame exposed private phase'
      );
      assert.equal(h.calls.length, calls, 'Denied model frame called provider');
      assert.equal(
        (await h.request(f.userId, `/leases/${f.leaseId}/frame`, { actor: 'user' })).status,
        200,
        'Owner PNG became unavailable'
      );
      await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        actor: 'user',
        method: 'POST',
        body: { mode: 'agent' },
      });
      const before = h.calls.length;
      for (const operation of ['screen.capture', 'screen.frame']) {
        const capture = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: { operationId: randomUUID(), operation, args: {} },
        });
        assert.equal(capture.status, 403, 'Raw model media was admitted');
      }
      assert.equal(h.calls.length, before, 'Denied raw capture called provider');
      h.observationResult = {
        text: `OTP 654321 ${canary}`,
        png_b64: Buffer.from(canary).toString('base64'),
      };
      const ocr = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
      });
      const output = JSON.stringify(ocr.data);
      assert.ok(output.includes('654321'), 'Fresh OTP was suppressed after trusted resume');
      assert.ok(!output.includes(canary), 'Known private text survived resume');
      assert.ok(
        !output.includes(Buffer.from(canary).toString('base64')),
        'Model media survived sanitizer'
      );
    },
  ],
  [
    'private vault survives release and successor lease and sanitizes legacy receipts',
    async (h) => {
      const f = await h.fixture();
      const canary = `durable-${randomUUID()}`;
      await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        actor: 'user',
        method: 'POST',
        body: { mode: 'user' },
      });
      const operationId = randomUUID();
      await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        actor: 'user',
        method: 'POST',
        body: { operationId, operation: 'input.text', args: { s: canary } },
      });
      const saved = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.ok(
        saved.privateInputEncrypted && !saved.privateInputEncrypted.includes(canary),
        'Vault missing or plaintext'
      );
      const decoded = openPhoneValue<{ values: string[]; active: boolean }>(
        saved.privateInputEncrypted
      );
      assert.ok(
        decoded.values.includes(canary) && decoded.active,
        'Reloaded durable vault lost input'
      );
      // Fresh worker process reads/decrypts the DB envelope: no process-global registry.
      const reloaded = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `
        import { prisma } from './src/providers/database.ts';
        import { privacyState } from './src/domains/iphone/privacy.ts';
        const device = await prisma.iPhoneDevice.findUniqueOrThrow({where:{id:process.argv[1]}});
        const state = privacyState(device.privateInputEncrypted);
        if (!state.active || state.values.length !== 1) process.exitCode = 1;
        await prisma.$disconnect();
      `,
          f.deviceId,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      assert.ok(!reloaded.includes(canary), 'Fresh worker printed private input');
      // A pre-fix encrypted result must be protected by current disclosure policy too.
      await prisma.iPhoneOperation.updateMany({
        where: { leaseId: f.leaseId, requestKey: operationId },
        data: { resultEncrypted: sealPhoneValue({ text: canary }) },
      });
      assert.ok(
        !JSON.stringify(
          (await h.request(f.userId, `/leases/${f.leaseId}/operations/${operationId}`)).data
        ).includes(canary),
        'Legacy replay leaked'
      );
      h.cleanupComplete = true;
      await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST', actor: 'user' });
      h.cleanupComplete = false; // New session is live; only the released session had cleanup proof.
      const agent = await h.createAgent(f.userId);
      const next = await h.acquire(f.userId, agent.id);
      assert.equal(next.status, 'ACTIVE');
      const denied = await h.request(f.userId, `/leases/${next.id}/operations`, {
        method: 'POST',
        body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
      });
      assert.equal(denied.status, 409, 'Successor implicitly cleared private phase');
      const retained = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.equal(
        retained.privateInputEncrypted,
        saved.privateInputEncrypted,
        'Release cleared or rewrote vault'
      );
      await h.request(f.userId, `/leases/${next.id}/control`, {
        actor: 'user',
        method: 'POST',
        body: { mode: 'user' },
      });
      await h.request(f.userId, `/leases/${next.id}/control`, {
        actor: 'user',
        method: 'POST',
        body: { mode: 'agent' },
      });
      h.observationResult = { text: `OTP 123456 ${canary}` };
      const read = await h.request(f.userId, `/leases/${next.id}/operations`, {
        method: 'POST',
        body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
      });
      assert.equal(read.status, 200);
      assert.ok(
        JSON.stringify(read.data).includes('123456') && !JSON.stringify(read.data).includes(canary),
        'Successor masking/OTP boundary failed'
      );
    },
  ],
  [
    'private capacity rejects before physical RPC and unknown input keeps stable custody',
    async (h) => {
      const f = await h.fixture();
      await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        actor: 'user',
        method: 'POST',
        body: { mode: 'user' },
      });
      for (const values of [Array.from({ length: 64 }, () => randomUUID()), ['界'.repeat(5461)]]) {
        await prisma.iPhoneDevice.update({
          where: { id: f.deviceId },
          data: { privateInputEncrypted: sealPhoneValue({ version: 1, active: true, values }) },
        });
        const calls = h.calls.length;
        const cursor = (await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: f.leaseId } }))
          .actionCursor;
        const response = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          actor: 'user',
          method: 'POST',
          body: {
            operationId: randomUUID(),
            operation: 'input.text',
            args: { s: 'new-private-value' },
          },
        });
        assert.equal(response.status, 409, 'Private capacity overflow was admitted');
        assert.equal(h.calls.length, calls, 'Capacity failure called provider');
        assert.equal(
          (await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: f.leaseId } })).actionCursor,
          cursor
        );
      }
      await prisma.iPhoneDevice.update({
        where: { id: f.deviceId },
        data: { privateInputEncrypted: null },
      });
      const canary = `unknown-${randomUUID()}`;
      h.inputMode = 'unknown';
      const operationId = randomUUID();
      const send = () =>
        h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          actor: 'user',
          method: 'POST',
          body: { operationId, operation: 'input.text', args: { s: canary } },
        });
      const first = await send();
      assert.equal(first.data.operation?.status, 'UNKNOWN');
      const replay = await send();
      assert.equal(replay.data.operation?.status, 'UNKNOWN');
      assert.equal(h.physicalOperations.filter((op) => op.kw.s === canary).length, 1);
      const command = await prisma.iPhoneOperation.findFirstOrThrow({
        where: { leaseId: f.leaseId, requestKey: operationId },
      });
      assert.equal(command.activeDeviceId, f.deviceId, 'Unknown private input lost fence');
      assert.ok(
        !JSON.stringify([first.data, replay.data, command]).includes(canary),
        'Unknown input leaked'
      );
    },
  ],
  [
    'fragmented private input and malformed envelopes fail closed',
    async (h) => {
      const f = await h.fixture();
      await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        actor: 'user',
        method: 'POST',
        body: { mode: 'user' },
      });
      const fragments = [`fragment-${randomUUID()}-`, randomUUID()];
      for (const s of fragments) {
        const typed = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          actor: 'user',
          method: 'POST',
          body: { operationId: randomUUID(), operation: 'input.text', args: { s } },
        });
        assert.equal(typed.status, 200);
      }
      const saved = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      const vault = openPhoneValue<{ values: string[] }>(saved.privateInputEncrypted!);
      assert.ok(
        vault.values.includes(fragments.join('')),
        'Fragmented full submitted value not retained'
      );
      await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        actor: 'user',
        method: 'POST',
        body: { mode: 'agent' },
      });
      h.observationResult = { text: `OTP 765432 ${fragments.join('')}` };
      const read = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
      });
      assert.ok(
        JSON.stringify(read.data).includes('765432') &&
          !JSON.stringify(read.data).includes(fragments.join('')),
        'Fragmented submitted value leaked'
      );
      for (const malformed of [
        sealPhoneValue(null),
        sealPhoneValue({ version: 1, active: true, values: [null] }),
        'invalid-envelope',
      ]) {
        await prisma.iPhoneDevice.update({
          where: { id: f.deviceId },
          data: { privateInputEncrypted: malformed },
        });
        const before = h.calls.length;
        const denied = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
        });
        assert.equal(denied.status, 409, 'Malformed privacy state did not fail closed');
        assert.equal(h.calls.length, before, 'Malformed privacy state reached provider');
        assert.ok(JSON.stringify(denied.data).includes('Phone privacy state is unavailable'));
      }
    },
  ],
];
