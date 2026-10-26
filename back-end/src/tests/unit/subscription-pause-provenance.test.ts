import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const report = (...parts: string[]): void => {
  process.stdout.write(`${parts.join(' ')}\n`);
};
const reportError = (error: unknown): void => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
};

async function main() {
  const cases: Array<{ source: string; signal: unknown[] }> = [];
  let source = '';
  await mock.module('../../providers/stripe', {
    namedExports: {
      stripe: {},
      getStripeClientForLivemode: () => {
        throw new Error('No Stripe calls allowed');
      },
    },
  });
  await mock.module('../../providers/credits', {
    namedExports: {
      getUserUsage: () => {
        throw new Error('No credit calls expected');
      },
    },
  });
  await mock.module('../../providers/agentResume', {
    namedExports: {
      resumeAgentWorkflow: () => {
        throw new Error('Unexpected resume');
      },
    },
  });
  await mock.module('../../providers/gateResolution', {
    namedExports: { resolvePendingGateByKey: () => {} },
  });
  await mock.module('../../providers/supabaseApiKeys', {
    namedExports: { ensureRoseApiKeyForUser: () => {} },
  });
  await mock.module('../../providers/temporal', {
    namedExports: {
      getTemporalClient: async () => ({
        workflow: {
          getHandle: () => ({
            signal: async (...signal: unknown[]) => {
              cases.push({ source, signal });
            },
          }),
        },
      }),
      startAgentWorkflowExecution: () => {
        throw new Error('No workflow launch allowed');
      },
    },
  });
  await mock.module('../../domains/webhooks/repo', {
    namedExports: {
      findSubscriptionByStripeSubscriptionId: async () => ({ userId: 'fixture-user' }),
      findActiveAgents: async () => [
        { id: 'fixture-agent', temporalWorkflowId: 'fixture-workflow' },
      ],
      updateAgentStatus: async () => {},
      deleteSubscriptionByUserId: async () => {},
      upsertSubscription: async () => {},
    },
  });
  const webhook = await import('../../domains/webhooks/service');
  source = 'payment_failed';
  await webhook.handlePaymentFailed({ id: 'invoice', subscription: 'subscription' } as never);
  source = 'subscription_deleted';
  await webhook.handleSubscriptionDeleted({ id: 'subscription' } as never);
  source = 'subscription_updated';
  await webhook.handleSubscriptionUpdated({
    id: 'subscription',
    status: 'past_due',
    items: { data: [] },
    current_period_end: 100,
  } as never);

  await mock.module('../../providers/chat', {
    namedExports: { broadcastAgentModeStarted: () => {} },
  });
  await mock.module('../../domains/agents/repo', {
    namedExports: {
      pauseAgentUnderWorkflowLock: async () => ({
        paused: true,
        temporalWorkflowId: 'fixture-workflow',
      }),
    },
  });
  await mock.module('../../domains/agents/agentConfigService', {
    namedExports: { updateAgentConfig: () => {} },
  });
  await mock.module('../../domains/agents/agentStatusService', {
    namedExports: { updateAgentStatus: () => {} },
  });
  await mock.module('../../domains/agents/agentRestartService', {
    namedExports: {
      acknowledgeWorkflowReplacementBootstrap: () => {},
      finalizeWorkflowReplacementBootstrap: () => {},
      restartAgent: () => {},
    },
  });
  source = 'user_control';
  const { pauseAgent } = await import('../../domains/agents/agentControlService');
  await pauseAgent('fixture-agent');
  assert.equal(cases.length, 4);
  const root = resolve(__dirname, '../../../..');
  const output = execFileSync(
    resolve(root, 'agents/venv/bin/python'),
    [resolve(root, 'agents/tests/blackbox/pause_control_provenance.py')],
    {
      cwd: root,
      input: JSON.stringify(cases),
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    }
  );
  assert.match(output, /B1_PASS: 4/);
  report(output.trim());
}
main().catch((error) => {
  reportError(error);
  process.exitCode = 1;
});
