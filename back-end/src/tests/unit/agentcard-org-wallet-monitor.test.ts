#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  extractAgentCardOrgWallet,
  monitorAgentCardOrgWallet,
  type AgentCardOrgWalletAlertStore,
} from '../../providers/agentcard/org-wallet-monitor';

function walletResult(availableCents: number, livemode = true) {
  return {
    structuredContent: {
      wallet: {
        livemode,
        balance_cents: availableCents,
        committed_cents: 0,
        available_cents: availableCents,
        deposit_address: '0xagentcard',
        chain: 'base',
        stablecoin: 'usdc',
      },
    },
  };
}

function fakeStore(claimed = true): AgentCardOrgWalletAlertStore & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async claim() {
      calls.push('claim');
      return claimed;
    },
    async markSent() {
      calls.push('markSent');
    },
    async release() {
      calls.push('release');
    },
    async rearm() {
      calls.push('rearm');
    },
  };
}

async function main(): Promise<void> {
  assert.deepEqual(extractAgentCardOrgWallet(walletResult(9_999)), {
    livemode: true,
    balanceCents: 9_999,
    committedCents: 0,
    availableCents: 9_999,
    depositAddress: '0xagentcard',
    chain: 'base',
    stablecoin: 'usdc',
  });

  {
    const store = fakeStore();
    let smsCalls = 0;
    const result = await monitorAgentCardOrgWallet({
      thresholdCents: 10_000,
      alertPhone: '+15555550100',
      reloadUrl: 'https://app.agentcard.sh/org/org-1',
      callOrgTool: async () => walletResult(10_000),
      sendSms: async () => {
        smsCalls += 1;
        return { success: true };
      },
      store,
    });
    assert.equal(result.status, 'healthy', 'exactly $100 must not alert');
    assert.deepEqual(store.calls, ['rearm']);
    assert.equal(smsCalls, 0);
  }

  {
    const store = fakeStore();
    const messages: string[] = [];
    const result = await monitorAgentCardOrgWallet({
      thresholdCents: 10_000,
      alertPhone: '+15555550100',
      reloadUrl: 'https://app.agentcard.sh/org/org-1',
      callOrgTool: async () => walletResult(9_999),
      sendSms: async (_phone, message) => {
        messages.push(message);
        return { success: true, messageSid: 'sms-1' };
      },
      store,
    });
    assert.equal(result.status, 'alerted');
    assert.deepEqual(store.calls, ['claim', 'markSent']);
    assert.match(messages[0], /\$99\.99 available/);
    assert.match(messages[0], /https:\/\/app\.agentcard\.sh\/org\/org-1/);
    assert.match(messages[0], /0xagentcard/);
    assert.match(messages[0], /USDC on Base/);
  }

  {
    const store = fakeStore(false);
    let smsCalls = 0;
    const result = await monitorAgentCardOrgWallet({
      thresholdCents: 10_000,
      alertPhone: '+15555550100',
      reloadUrl: 'https://app.agentcard.sh/org/org-1',
      callOrgTool: async () => walletResult(5_000),
      sendSms: async () => {
        smsCalls += 1;
        return { success: true };
      },
      store,
    });
    assert.equal(result.status, 'already_alerted');
    assert.equal(smsCalls, 0);
  }

  {
    const store = fakeStore();
    await assert.rejects(
      monitorAgentCardOrgWallet({
        thresholdCents: 10_000,
        alertPhone: '+15555550100',
        reloadUrl: 'https://app.agentcard.sh/org/org-1',
        callOrgTool: async () => walletResult(5_000),
        sendSms: async () => ({ success: false, error: 'provider unavailable' }),
        store,
      }),
      /provider unavailable/
    );
    assert.deepEqual(store.calls, ['claim', 'release']);
  }

  {
    const store = fakeStore();
    let smsCalls = 0;
    const result = await monitorAgentCardOrgWallet({
      thresholdCents: 10_000,
      alertPhone: '+15555550100',
      reloadUrl: 'https://app.agentcard.sh/org/org-1',
      callOrgTool: async () => walletResult(5_000, false),
      sendSms: async () => {
        smsCalls += 1;
        return { success: true };
      },
      store,
    });
    assert.equal(result.status, 'sandbox_ignored');
    assert.deepEqual(store.calls, []);
    assert.equal(smsCalls, 0);
  }

  process.stdout.write('AgentCard org-wallet monitor tests passed\n');
}

void main();
