import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function main() {
  let resolveTyping!: (stop: () => Promise<void>) => void;
  const typing = new Promise<() => Promise<void>>((resolve) => {
    resolveTyping = resolve;
  });
  let supervisorCalls = 0;
  let stopped = 0;
  await mock.module('../../providers/linq', {
    namedExports: { startLinqTyping: async () => typing },
  });
  await mock.module('../../domains/sms-webhook/repo', {
    namedExports: { getInboundSeq: async () => 1 },
  });
  await mock.module('../../providers/smsSupervisor/sessionStore', {
    namedExports: { recordInboundSms: async () => 1 },
  });
  await mock.module('../../providers/smsSupervisor', {
    namedExports: {
      handleSmsSupervisorMessage: async () => {
        supervisorCalls++;
        return { committed: true, responseText: 'answer', toolsExecuted: [] };
      },
      SUPERVISOR_FALLBACK_MESSAGE: 'fallback',
    },
  });
  await mock.module('../../providers/smsSupervisor/supervisorHandler', {
    namedExports: { withCommitLock: async (_user: string, fn: () => unknown) => fn() },
  });
  await mock.module('../../providers/agentKill', {
    namedExports: { deleteAgentRecursive: async () => undefined },
  });
  await mock.module('../../providers/smsQueue', {
    namedExports: { sendSms: async () => ({ success: true }) },
  });
  await mock.module('../../providers/credits', {
    namedExports: { createSignupBonusCredit: async () => undefined },
  });
  await mock.module('../../providers/errorAlert', {
    namedExports: { alertError: () => undefined },
  });
  const { routeToSupervisor } = await import('../../domains/sms-webhook/service');
  let acknowledged = false;
  const handoff = routeToSupervisor(
    'user',
    { fromPhone: '+19729777432', messageBody: 'hello', messageId: 'incoming', attachments: [] },
    Date.now()
  ).then(() => {
    acknowledged = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(acknowledged, true, 'slow typing must never delay the webhook handoff');
    assert.equal(supervisorCalls, 1, 'supervisor starts while typing is pending');
  } finally {
    resolveTyping(async () => {
      stopped++;
    });
    await handoff;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(stopped, 1, 'completion eventually clears the typing handle');
  process.stdout.write('linq-supervisor-handoff: passed\n');
}
main().catch((error) => {
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});
