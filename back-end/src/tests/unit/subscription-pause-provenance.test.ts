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

// Worker generations that may own a workflow while a cutover drains. `legacy` is
// the pre-cause `pause(self)` handler: temporalio calls it with every signal
// argument, so any cause fails that workflow task on each retry. `current`
// accepts a cause and reports `user_pause_active` from parent_state_query.
// `unreachable` cannot answer the probe, so its generation is unknown.
type Generation = 'current' | 'legacy' | 'unreachable';
const PARENT_STATE: Record<Exclude<Generation, 'unreachable'>, Record<string, boolean>> = {
  current: {
    is_paused: false,
    is_cost_limit_reached: false,
    is_finished: false,
    user_pause_active: false,
  },
  legacy: { is_paused: false, is_cost_limit_reached: false, is_finished: false },
};

async function main() {
  const cases: Array<{ source: string; generation: Generation; signal: unknown[] }> = [];
  let source = '';
  let generation: Generation = 'current';
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
        withDeadline: async (_deadline: unknown, fn: () => Promise<unknown>) => fn(),
        workflow: {
          getHandle: () => ({
            query: async (name: string) => {
              assert.equal(name, 'parent_state_query');
              if (generation === 'unreachable') throw new Error('query deadline exceeded');
              return PARENT_STATE[generation];
            },
            signal: async (...signal: unknown[]) => {
              cases.push({ source, generation, signal });
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
  for (const owner of ['current', 'legacy', 'unreachable'] as const) {
    generation = owner;
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
  }

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
  for (const owner of ['current', 'legacy'] as const) {
    generation = owner;
    await pauseAgent('fixture-agent');
  }
  assert.equal(cases.length, 11);
  const legacyArgs = cases
    .filter((entry) => entry.generation !== 'current')
    .map((entry) => ({ source: entry.source, signal: entry.signal }));
  assert.deepEqual(
    legacyArgs.filter((entry) => entry.signal.length !== 1 || entry.signal[0] !== 'pause'),
    [],
    'a draining pre-cause or unprobed generation must receive the zero-argument pause signal'
  );
  const current = cases.filter((entry) => entry.generation === 'current');
  assert.equal(current.length, 4);
  report('LEGACY_PAUSE_PASS:', String(legacyArgs.length), 'zero-argument pause signals');
  const root = resolve(__dirname, '../../../..');
  const output = execFileSync(
    resolve(root, 'agents/venv/bin/python'),
    [resolve(root, 'agents/tests/blackbox/pause_control_provenance.py')],
    {
      cwd: root,
      input: JSON.stringify(current),
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
