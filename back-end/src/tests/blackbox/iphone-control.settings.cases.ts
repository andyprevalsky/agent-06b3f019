import { gmailCases } from './iphone-control.gmail.cases';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import type { Case } from './iphone-control.cases';
import {
  freshSetup,
  observe,
  setupPost,
  proveSettings,
  verifierUsage,
  type SetupDto,
} from './iphone-control.setup-fixtures';
export const settingsCases: Case[] = [
  ...gmailCases,
  [
    'Contacts synchronization requires explicit On evidence, not populated names',
    async (h) => {
      const f = await freshSetup(h);
      await proveSettings(h, f, true, true, false);
      assert.notEqual(
        f.setup.state,
        'ready',
        'Other six settings cannot substitute for Contacts sync'
      );
      let status: 'confirmed' | 'disabled' | 'unknown' = 'unknown';
      h.setupVerifier = async (input) => {
        assert.equal(input.verificationTarget, 'icloud_contacts');
        return { identityConfirmed: false, status, usage: verifierUsage };
      };
      const submit = async () => {
        const read = await observe(h, f);
        const reply = await setupPost(h, f, {
          action: 'verify',
          verificationTarget: 'icloud_contacts',
          attemptId: f.setup.attemptId,
          expectedRevision: f.setup.revision,
          expectedCursor: read.cursor,
          requestKey: randomUUID(),
          evidenceOperationIds: [read.id],
        });
        assert.equal(reply.status, 200);
        f.setup = reply.data.setup as SetupDto;
        return (
          f.setup as SetupDto & { verification: { checks: Record<string, { status: string }> } }
        ).verification.checks.icloud_contacts;
      };
      h.observationResult = { text: 'Contacts: Alice, Bob, Carol' };
      assert.equal((await submit()).status, 'unknown');
      status = 'confirmed';
      h.observationResult = { text: 'iCloud Contacts: On' };
      assert.equal((await submit()).status, 'confirmed');
      assert.equal(
        f.setup.state,
        'ready',
        'Contacts On completes otherwise verified startup settings'
      );
      status = 'disabled';
      h.observationResult = { text: 'iCloud Contacts: Off' };
      assert.equal((await submit()).status, 'disabled');
      assert.notEqual(f.setup.state, 'ready');
      status = 'unknown';
      h.observationResult = { text: 'Contacts: Alice, Bob, Carol' };
      await submit();
      assert.notEqual(f.setup.state, 'ready');
    },
  ],

  [
    'portrait lock accepts explicit enabled proof but dimensions alone remain unknown',
    async (h) => {
      const f = await freshSetup(h);
      await proveSettings(h, f, true, false);
      assert.notEqual(
        f.setup.state,
        'ready',
        'All other settings cannot substitute for portrait lock'
      );
      let status: 'confirmed' | 'disabled' | 'unknown' = 'unknown';
      h.setupVerifier = async (input) => {
        assert.equal(input.verificationTarget, 'portrait_lock');
        return { identityConfirmed: false, status, usage: verifierUsage };
      };
      const submit = async () => {
        const read = await observe(h, f);
        const reply = await setupPost(h, f, {
          action: 'verify',
          verificationTarget: 'portrait_lock',
          attemptId: f.setup.attemptId,
          expectedRevision: f.setup.revision,
          expectedCursor: read.cursor,
          requestKey: randomUUID(),
          evidenceOperationIds: [read.id],
        });
        assert.equal(reply.status, 200);
        f.setup = reply.data.setup as SetupDto;
        return reply;
      };
      h.observationResult = { text: 'Portrait screen', width: 750, height: 1334 };
      await submit();
      let check = (
        f.setup as SetupDto & { verification: { checks: { portrait_lock: { status: string } } } }
      ).verification.checks.portrait_lock;
      assert.equal(check.status, 'unknown');
      assert.notEqual(f.setup.state, 'ready');
      status = 'confirmed';
      h.observationResult = { text: 'Portrait Orientation Lock: On' };
      await submit();
      check = (
        f.setup as SetupDto & { verification: { checks: { portrait_lock: { status: string } } } }
      ).verification.checks.portrait_lock;
      assert.equal(check.status, 'confirmed');
      assert.equal(
        f.setup.state,
        'ready',
        'Explicit portrait lock completes the otherwise verified boot settings'
      );
      status = 'disabled';
      h.observationResult = { text: 'Portrait Orientation Lock: Off' };
      await submit();
      assert.notEqual(f.setup.state, 'ready', 'Disabled portrait lock retained boot readiness');
      status = 'unknown';
      h.observationResult = { text: 'Portrait screen', width: 750, height: 1334 };
      await submit();
      assert.notEqual(f.setup.state, 'ready', 'Unknown portrait lock retained boot readiness');
    },
  ],

  [
    'settings proof is invalid after user handback or observed signout and runtime ages out',
    async (h) => {
      const f = await freshSetup(h);
      await proveSettings(h, f);
      assert.equal(f.setup.state, 'ready');
      await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        actor: 'user',
        method: 'POST',
        body: { mode: 'user' },
      });
      await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        actor: 'user',
        method: 'POST',
        body: { mode: 'agent' },
      });
      const current = (await h.request(f.userId, `/interactions/${f.taskId}`)).data
        .setup as SetupDto;
      assert.notEqual(current.state, 'ready', 'User handback retained prior settings proof');
      f.setup = current;
      await proveSettings(h, f);
      const last = await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: f.leaseId } });
      const blocked = await setupPost(h, f, {
        action: 'block',
        reasonCode: 'observed_signed_out',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: last.actionCursor,
        requestKey: randomUUID(),
      });
      f.setup = blocked.data.setup as SetupDto;
      h.setupVerifier = async () => ({
        identityConfirmed: false,
        status: 'confirmed',
        runtime: { sync: 'syncing', activation: 'active', reason: 'unknown' },
        usage: verifierUsage,
      });
      const read = await observe(h, f);
      const runtime = await setupPost(h, f, {
        action: 'verify',
        verificationTarget: 'runtime',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: read.cursor,
        requestKey: randomUUID(),
        evidenceOperationIds: [read.id],
      });
      assert.notEqual(
        (runtime.data.setup as SetupDto).state,
        'ready',
        'Runtime reverified stale signed-out identity'
      );
      f.setup = runtime.data.setup as SetupDto;
      h.setupVerifier = async () => ({ identityConfirmed: true, usage: verifierUsage });
      const signedIn = await observe(h, f);
      const apple = await setupPost(h, f, {
        action: 'verify',
        verificationTarget: 'apple_account',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: signedIn.cursor,
        requestKey: randomUUID(),
        evidenceOperationIds: [signedIn.id],
      });
      assert.notEqual(
        (apple.data.setup as SetupDto).state,
        'ready',
        'Fresh Apple identity reused settings proofs from before sign-out'
      );
    },
  ],

  [
    'settings proof is partial until all targets; disabled and unavailable supersede confirmed; runtime never invents readiness',
    async (h) => {
      const f = await freshSetup(h);
      let status: 'confirmed' | 'disabled' | 'unknown' = 'confirmed';
      let fail = false;
      h.setupVerifier = async (input) => {
        assert.equal(input.expectedReceiveAddress, f.phone);
        if (fail) throw new Error('Synthetic verifier unavailable');
        return {
          identityConfirmed: true,
          status,
          runtime: { sync: 'paused', activation: 'active', reason: 'unknown' },
          usage: verifierUsage,
        };
      };
      const submit = async (verificationTarget: string) => {
        h.observationResult = {
          text: `Explicit ${verificationTarget} status; signed in ${f.identity}; selected enabled ${f.phone}`,
        };
        const read = await observe(h, f);
        const body = {
          action: 'verify',
          verificationTarget,
          attemptId: f.setup.attemptId,
          expectedRevision: f.setup.revision,
          expectedCursor: read.cursor,
          requestKey: randomUUID(),
          evidenceOperationIds: [read.id],
        };
        const reply = await setupPost(h, f, body);
        f.setup = reply.data.setup as SetupDto;
        return { reply, body };
      };
      await submit('runtime');
      assert.equal(
        (f.setup as SetupDto & { verification: { operationalStatus: string } }).verification
          .operationalStatus,
        'unknown'
      );
      await proveSettings(h, f);
      assert.equal(f.setup.state, 'ready');
      await submit('runtime');
      assert.equal(f.setup.state, 'ready');
      assert.equal(
        (f.setup as SetupDto & { verification: { operationalStatus: string } }).verification
          .operationalStatus,
        'degraded'
      );
      status = 'disabled';
      const { body } = await submit('imessage');
      assert.notEqual(f.setup.state, 'ready');
      const repeated = await setupPost(h, f, body);
      assert.equal(repeated.status, 200);
      assert.equal(
        (await setupPost(h, f, { ...body, verificationTarget: 'icloud_keychain' })).status,
        409
      );
      status = 'confirmed';
      await submit('imessage');
      assert.equal(f.setup.state, 'ready');
      fail = true;
      await submit('icloud_messages');
      assert.notEqual(f.setup.state, 'ready');
      const check = (
        f.setup as SetupDto & { verification: { checks: { icloud_messages: { status: string } } } }
      ).verification.checks.icloud_messages;
      assert.equal(check.status, 'unknown');
    },
  ],
];
