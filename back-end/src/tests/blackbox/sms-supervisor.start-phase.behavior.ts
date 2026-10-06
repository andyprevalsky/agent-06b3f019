/**
 * SMS supervisor start_new_agent start_phase contract.
 *
 * The supervisor chooses whether a new agent starts in PLAN or EXECUTE. That
 * choice must survive the model-facing schema (strict content path + native
 * tool path) and reach the Temporal workflow start; an omitted phase keeps the
 * historical PLAN default.
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { defaultPayloadConverter } from '@temporalio/client';

import { SUPERVISOR_RESPONSE_SCHEMA } from '../../providers/smsSupervisor/schema';
import { commitPendingWrites } from '../../providers/smsSupervisor/supervisorTools';
import type { StartNewAgentArgs } from '../../providers/smsSupervisor/supervisorTools.startAgent';
import { TOOL_SCHEMAS } from '../../providers/smsSupervisor/supervisorTools.schemas';
import { buildAgentWorkflowStartHistoryRequest, getTemporalClient } from '../../providers/temporal';
import {
  cleanupAgentScopedUser,
  provisionUserWithPhone,
  uniqueSmsPhone,
} from './sms-supervisor.helpers';

// Positional AgentWorkflow arg, see buildAgentWorkflowArgs in providers/temporal.ts.
const START_PHASE_ARG_INDEX = 11;

interface JsonSchemaNode {
  anyOf?: JsonSchemaNode[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  required?: string[];
}

async function workflowStartPhase(workflowId: string): Promise<unknown> {
  const temporal = await getTemporalClient();
  const history = await temporal.workflowService.getWorkflowExecutionHistory(
    buildAgentWorkflowStartHistoryRequest(temporal.options.namespace, workflowId)
  );
  const payloads =
    history.history?.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads ?? [];
  const args = payloads.map((payload) => defaultPayloadConverter.fromPayload(payload));
  return args[START_PHASE_ARG_INDEX];
}

async function commitStartNewAgent(prisma: PrismaClient, args: Omit<StartNewAgentArgs, 'goal'>) {
  const userId = await provisionUserWithPhone(prisma, uniqueSmsPhone());
  const provisionalId = randomUUID();
  const goal = `start-phase-${provisionalId}`;
  const [result] = await commitPendingWrites(
    [{ kind: 'start_new_agent', args: { goal, ...args }, provisionalId }],
    userId
  );
  const agent = await prisma.agent.findUnique({ where: { id: provisionalId } });
  return { userId, provisionalId, result, agent };
}

async function assertStartedIn(
  prisma: PrismaClient,
  args: Omit<StartNewAgentArgs, 'goal'>,
  expected: 'plan' | 'execute'
) {
  const run = await commitStartNewAgent(prisma, args);
  try {
    if (run.result?.success !== true) {
      throw new Error(`Expected start_new_agent to commit, got ${JSON.stringify(run.result)}`);
    }
    if (run.agent?.workflowStartPhase !== expected) {
      throw new Error(
        `Expected Agent.workflowStartPhase=${expected}, got ${run.agent?.workflowStartPhase}`
      );
    }
    const started = await workflowStartPhase(run.provisionalId);
    if (started !== expected) {
      throw new Error(`Expected the workflow to start in ${expected}, got ${String(started)}`);
    }
  } finally {
    await cleanupAgentScopedUser(prisma, run.userId);
  }
}

export async function testStartNewAgent_executePhaseReachesWorkflow(prisma: PrismaClient) {
  await assertStartedIn(prisma, { start_phase: 'execute' }, 'execute');
}

export async function testStartNewAgent_omittedPhaseStartsInPlan(prisma: PrismaClient) {
  await assertStartedIn(prisma, {}, 'plan');
}

export function testStartNewAgent_schemaRequiresPhaseChoice() {
  const response = SUPERVISOR_RESPONSE_SCHEMA as unknown as {
    json_schema?: { schema?: JsonSchemaNode };
  };
  const variants = response.json_schema?.schema?.properties?.tool_calls?.items?.anyOf ?? [];
  const startAgent = variants.find((variant) =>
    variant.properties?.tool?.enum?.includes('start_new_agent')
  );
  const runtimeArgs = startAgent?.properties?.arguments;
  const runtimePhase = runtimeArgs?.properties?.start_phase;
  if (JSON.stringify(runtimePhase?.enum) !== '["plan","execute"]') {
    throw new Error(`start_phase must be a plan|execute enum, got ${JSON.stringify(runtimePhase)}`);
  }
  if (!runtimeArgs?.required?.includes('start_phase')) {
    throw new Error('start_phase must be required in the runtime response schema');
  }
  if (!runtimePhase?.description) {
    throw new Error('start_phase must carry a model-facing description');
  }

  const declared = TOOL_SCHEMAS.find((tool) => tool.name === 'start_new_agent')?.parameters as
    JsonSchemaNode | undefined;
  if (declared?.properties?.start_phase?.description !== runtimePhase.description) {
    throw new Error('TOOL_SCHEMAS start_new_agent.start_phase drifted from the runtime schema');
  }
  if (!declared.required?.includes('start_phase')) {
    throw new Error('TOOL_SCHEMAS start_new_agent must require start_phase');
  }
}

export function smsStartPhaseBehaviorCases(prisma: PrismaClient) {
  return [
    {
      name: 'start_new_agent -- schema requires a plan|execute start_phase',
      fn: async () => testStartNewAgent_schemaRequiresPhaseChoice(),
    },
    {
      name: 'start_new_agent -- start_phase=execute reaches the workflow start',
      fn: () => testStartNewAgent_executePhaseReachesWorkflow(prisma),
    },
    {
      name: 'start_new_agent -- omitted start_phase starts in plan',
      fn: () => testStartNewAgent_omittedPhaseStartsInPlan(prisma),
    },
  ];
}
