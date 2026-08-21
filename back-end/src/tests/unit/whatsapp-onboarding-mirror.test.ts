#!/usr/bin/env tsx
/**
 * Unit tests for mirrorOnboardingWelcomeToWhatsApp — the onboarding welcome
 * WhatsApp mirror. Injects fake collaborators (no DB, no Meta call) to pin the
 * gating + reachability-learning contract:
 *   - unconfigured           -> no send, no reachability write
 *   - known-unreachable      -> skip (don't hammer non-WhatsApp numbers)
 *   - send success           -> mark reachable
 *   - recipient-unreachable  -> mark unreachable
 *   - transient failure      -> leave reachability untouched
 */
import assert from 'node:assert';
import {
  mirrorOnboardingWelcomeToWhatsApp,
  type OnboardingMirrorDeps,
} from '../../providers/whatsappOnboarding';
import {
  WHATSAPP_ONBOARDING_TEMPLATE,
  type WhatsAppSendResult,
} from '../../providers/whatsappCloud';

type Calls = {
  reachableReads: string[];
  sends: { phone: string; template: string; lang: string; params: string[] }[];
  markedReachable: string[];
  markedUnreachable: string[];
};

interface DepsOpts {
  reachable?: boolean | null;
  configured?: boolean;
  sendResult?: WhatsAppSendResult;
}

function makeDeps(opts: DepsOpts = {}): { deps: OnboardingMirrorDeps; calls: Calls } {
  const calls: Calls = {
    reachableReads: [],
    sends: [],
    markedReachable: [],
    markedUnreachable: [],
  };
  const configured = opts.configured !== false;
  const deps: OnboardingMirrorDeps = {
    getConfig: () =>
      configured
        ? { phoneNumberId: 'pnid', accessToken: 'tok', graphApiVersion: 'v21.0' }
        : { phoneNumberId: undefined, accessToken: undefined, graphApiVersion: 'v21.0' },
    getReachable: async (userId: string) => {
      calls.reachableReads.push(userId);
      return opts.reachable ?? null;
    },
    sendTemplate: async (phone, template, lang, params = []) => {
      calls.sends.push({ phone, template, lang, params });
      return opts.sendResult ?? { success: true, messageSid: 'wamid.OK' };
    },
    markReachable: async (userId: string) => {
      calls.markedReachable.push(userId);
    },
    markUnreachable: async (userId: string) => {
      calls.markedUnreachable.push(userId);
    },
  };
  return { deps, calls };
}

async function testUnconfiguredNoOp(): Promise<void> {
  const { deps, calls } = makeDeps({ configured: false });
  await mirrorOnboardingWelcomeToWhatsApp('u1', '+15551234567', 'Andy', deps);
  assert.strictEqual(calls.sends.length, 0, 'no send when unconfigured');
  assert.strictEqual(calls.reachableReads.length, 0, 'no reachability read when unconfigured');
  assert.strictEqual(calls.markedReachable.length + calls.markedUnreachable.length, 0, 'no writes');
}

async function testKnownUnreachableSkips(): Promise<void> {
  const { deps, calls } = makeDeps({ reachable: false });
  await mirrorOnboardingWelcomeToWhatsApp('u2', '+15551234567', 'Andy', deps);
  assert.strictEqual(calls.sends.length, 0, 'no send to a known non-WhatsApp number');
  assert.strictEqual(calls.markedReachable.length, 0, 'no reachable write');
  assert.strictEqual(calls.markedUnreachable.length, 0, 'no redundant unreachable write');
}

async function testSuccessMarksReachable(): Promise<void> {
  const { deps, calls } = makeDeps({ reachable: null });
  await mirrorOnboardingWelcomeToWhatsApp('u3', '+15551234567', 'Andy', deps);
  assert.strictEqual(calls.sends.length, 1, 'sends the template once');
  assert.strictEqual(
    calls.sends[0].template,
    WHATSAPP_ONBOARDING_TEMPLATE.name,
    'uses onboarding template'
  );
  assert.strictEqual(
    calls.sends[0].lang,
    WHATSAPP_ONBOARDING_TEMPLATE.language,
    'template language'
  );
  assert.deepStrictEqual(calls.sends[0].params, ['Andy'], 'first name fills body variable');
  assert.deepStrictEqual(calls.markedReachable, ['u3'], 'success -> mark reachable');
  assert.strictEqual(calls.markedUnreachable.length, 0, 'no unreachable write on success');
}

async function testRecipientUnreachableMarksFalse(): Promise<void> {
  const { deps, calls } = makeDeps({
    reachable: null,
    sendResult: { success: false, recipientUnreachable: true, error: 'WhatsApp API error: 400' },
  });
  await mirrorOnboardingWelcomeToWhatsApp('u4', '+15551234567', 'Andy', deps);
  assert.deepStrictEqual(calls.markedUnreachable, ['u4'], 'undeliverable -> mark unreachable');
  assert.strictEqual(calls.markedReachable.length, 0, 'no reachable write on undeliverable');
}

async function testTransientFailureLeavesFlag(): Promise<void> {
  const { deps, calls } = makeDeps({
    reachable: null,
    sendResult: { success: false, error: 'WhatsApp API error: 500' },
  });
  await mirrorOnboardingWelcomeToWhatsApp('u5', '+15551234567', 'Andy', deps);
  assert.strictEqual(calls.sends.length, 1, 'attempted the send');
  assert.strictEqual(
    calls.markedReachable.length + calls.markedUnreachable.length,
    0,
    'transient failure must not touch reachability'
  );
}

async function main(): Promise<void> {
  await testUnconfiguredNoOp();
  await testKnownUnreachableSkips();
  await testSuccessMarksReachable();
  await testRecipientUnreachableMarksFalse();
  await testTransientFailureLeavesFlag();
  process.stdout.write('PASS mirrorOnboardingWelcomeToWhatsApp gating + reachability learning\n');
}

void main();
