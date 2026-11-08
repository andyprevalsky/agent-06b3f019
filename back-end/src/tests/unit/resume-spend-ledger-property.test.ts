#!/usr/bin/env tsx
/**
 * Property test of the resume spend ledger (resumeReportedSpend.ts): the ledger is
 * the single source of resume spend, no workflow ever holds it in memory, and every
 * tree-cost write adds the ledger's totals under that agent. Driven through the real
 * backend paths: POST resume-cost (applyResumeCost), tree-cost writes
 * (updateAgentConfig) and the deployment restore (claim + refresh).
 *
 * A 3-level chain root R → middle M → owner O (the resumed agent's owner). Each
 * workflow is modelled as AgentWorkflow does (subtree = own + children's last
 * relayed subtrees, written as a SET) and is resume-aware (new generation: its root
 * checks max(in-memory, stored tree)) or pre-deploy, in every mix. Deterministic
 * random sequences mix: the run spending with reports dropped, duplicated and
 * reordered, continue-as-new (the same total again), concurrent own spend at every
 * level, the owner closing and being reactivated under the same id (a fresh run), and
 * a cutover (deployment replacement onto resume-aware workers) of any level.
 *
 * After every step: ledger = max(reported totals); tree(O) = own(O) + resume spend
 * while O runs; tree(M) = own(M) + tree(O); tree(R) = own(R) + tree(M); no tree ever
 * decreases (a fresh owner run resets its own spend by design); the root's cap trips
 * exactly when tree(R) reaches its limit, for resume-cost and for a resume-aware
 * running root, and never before.
 */
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { applyResumeCost } from '../../domains/agents/agentResumeCostService';
import { updateAgentConfig } from '../../domains/agents/agentConfigService';
import {
  claimWorkflowReplacement,
  refreshWorkflowReplacementResumeState,
} from '../../providers/workflowReplacementState';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('resume spend ledger property tests');

/** Deterministic PRNG (mulberry32): the same sequences every run. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface WorkflowModel {
  id: string;
  /** Resume-aware (new generation): as a root it checks max(in-memory, stored tree). */
  aware: boolean;
  live: boolean;
  limitReached: boolean;
  own: number;
  /** child agent id → its last relayed subtree (never any resume spend). */
  children: Record<string, number>;
}

const subtree = (model: WorkflowModel) =>
  model.own + Object.values(model.children).reduce((sum, value) => sum + value, 0);

/** AgentWorkflow's write (identical for both generations); a root then checks its cap. */
async function persist(model: WorkflowModel, limit: number | null): Promise<number> {
  const result = await updateAgentConfig(
    model.id,
    { tree_cost_cents: Math.round(subtree(model)), own_cost_cents: model.own },
    undefined,
    undefined,
    { broadcastUpdate: async () => {} }
  );
  assert.ok(!('error' in result), JSON.stringify(result));
  const stored = (result as { agent: { tree_cost_cents: number } }).agent.tree_cost_cents;
  if (limit !== null) {
    const seen = model.aware ? Math.max(subtree(model), stored) : subtree(model);
    model.limitReached ||= seen >= limit;
  }
  return stored;
}

async function tree(agentId: string): Promise<number> {
  return (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).treeCostCents;
}

type Step =
  | 'run-spends'
  | 'run-spends-report-dropped'
  | 'report-duplicated'
  | 'report-reordered'
  | 'continue-as-new'
  | 'owner-spends'
  | 'middle-spends'
  | 'root-spends'
  | 'owner-closes'
  | 'owner-reactivated'
  | 'cutover-root'
  | 'cutover-middle'
  | 'cutover-owner'
  | 'concurrent-raise-and-writes'
  | 'concurrent-raise-and-cutover';

const STEPS: Step[] = [
  'run-spends',
  'run-spends',
  'run-spends-report-dropped',
  'report-duplicated',
  'report-reordered',
  'continue-as-new',
  'owner-spends',
  'middle-spends',
  'root-spends',
  'owner-closes',
  'owner-reactivated',
  'cutover-root',
  'cutover-middle',
  'cutover-owner',
  'concurrent-raise-and-writes',
  'concurrent-raise-and-writes',
  'concurrent-raise-and-cutover',
];

async function createAgent(
  id: string,
  userId: string,
  parent: string | null,
  rootId: string,
  limit: number,
  depth: number
) {
  await prisma.agent.create({
    data: {
      id,
      userId,
      goal: 'resume ledger property',
      status: 'ACTIVE',
      busId: rootId,
      parentAgentId: parent,
      parentWorkflowId: parent,
      temporalWorkflowId: id,
      priceLimitCents: limit,
      depth,
      verifier: { create: {} },
    },
  });
}

async function scenario(seed: number, aware: { root: boolean; middle: boolean; owner: boolean }) {
  const random = prng(seed);
  const userId = `resume-ledger-property-${randomUUID()}`;
  const [rootId, middleId, ownerId] = [randomUUID(), randomUUID(), randomUUID()];
  const limit = 70 + Math.floor(random() * 110);
  const key = `resume:code-resume:${ownerId}:${seed}`;
  await createAgent(rootId, userId, null, rootId, limit, 0);
  await createAgent(middleId, userId, rootId, rootId, 100, 1);
  await createAgent(ownerId, userId, middleId, rootId, 100, 2);
  const fresh = (id: string, isAware: boolean): WorkflowModel => ({
    id,
    aware: isAware,
    live: true,
    limitReached: false,
    own: 0,
    children: {},
  });
  const root = fresh(rootId, aware.root);
  const middle = fresh(middleId, aware.middle);
  const owner = fresh(ownerId, aware.owner);
  let total = 0;
  const reported: number[] = [];
  const last = { root: 0, middle: 0, owner: 0 };
  let maxRootTree = 0;

  // Each level writes and relays its subtree to its parent (AgentWorkflow).
  const settle = async () => {
    if (owner.live) {
      await persist(owner, null);
      middle.children[ownerId] = subtree(owner);
    }
    await persist(middle, null);
    root.children[middleId] = subtree(middle);
    await persist(root, limit);
  };

  // A report racing other transactions: its limit answer is checked by the step.
  const raise = async (value: number) => {
    reported.push(value);
    const answer = await applyResumeCost(ownerId, { key, total_cents: value });
    assert.ok(!('error' in answer), JSON.stringify(answer));
  };

  const report = async (value: number) => {
    reported.push(value);
    const answer = await applyResumeCost(ownerId, { key, total_cents: value });
    assert.ok(!('error' in answer), JSON.stringify(answer));
    assert.strictEqual(
      answer.limit_reached,
      (await tree(rootId)) >= limit,
      `seed ${seed}: resume-cost trips exactly when the root's tree reaches the limit`
    );
  };

  const cutover = async (model: WorkflowModel) => {
    const claim = await refreshWorkflowReplacementResumeState(
      await claimWorkflowReplacement(model.id)
    );
    const state = claim.resumeState;
    assert.ok(
      !Object.keys(state.children_cost_cents).some((k) => k.startsWith('resume:')),
      'a restore never puts resume spend in memory'
    );
    // A deployment replacement restores onto the current (resume-aware) workers.
    Object.assign(model, {
      aware: true,
      own: state.own_cost_cents,
      children: { ...state.children_cost_cents },
    });
  };

  try {
    for (let step = 0; step < 16; step += 1) {
      const action = STEPS[Math.floor(random() * STEPS.length)];
      let ownRunReset = false;
      const spend = 1 + Math.floor(random() * 12);
      if (action === 'run-spends') {
        total += spend;
        await report(total);
      } else if (action === 'run-spends-report-dropped') {
        total += spend; // the report is lost; the next one carries the larger total
      } else if (action === 'report-duplicated' && reported.length > 0) {
        await report(reported[reported.length - 1]);
      } else if (action === 'report-reordered' && reported.length > 0) {
        await report(reported[Math.floor(random() * reported.length)]);
      } else if (action === 'continue-as-new') {
        await report(total); // the successor reports its carried total
      } else if (action === 'owner-spends' && owner.live) {
        owner.own += spend;
      } else if (action === 'middle-spends') {
        middle.own += spend;
      } else if (action === 'root-spends') {
        root.own += spend;
      } else if (action === 'owner-closes' && owner.live) {
        owner.live = false;
        await prisma.agent.update({ where: { id: ownerId }, data: { status: 'COMPLETED' } });
      } else if (action === 'owner-reactivated' && !owner.live) {
        // A chat follow-up: a fresh run under the same workflow id (its own spend resets).
        Object.assign(owner, fresh(ownerId, owner.aware));
        await prisma.agent.update({ where: { id: ownerId }, data: { status: 'ACTIVE' } });
        ownRunReset = true;
      } else if (action === 'cutover-root') {
        await cutover(root);
      } else if (action === 'cutover-middle') {
        await cutover(middle);
      } else if (action === 'cutover-owner' && owner.live) {
        await cutover(owner);
      } else if (action === 'concurrent-raise-and-writes') {
        // Real parallel transactions: a raise and every level's tree-cost write.
        total += spend;
        await Promise.all([
          raise(total),
          owner.live ? persist(owner, null) : Promise.resolve(0),
          persist(middle, null),
          persist(root, limit),
        ]);
      } else if (action === 'concurrent-raise-and-cutover') {
        total += spend;
        await Promise.all([raise(total), cutover(middle), cutover(root)]);
      }
      await settle();

      const where = `seed ${seed} step ${step} ${action}`;
      const reportedTotal = Math.max(0, ...reported);
      const [rootTree, middleTree, ownerTree] = await Promise.all([
        tree(rootId),
        tree(middleId),
        tree(ownerId),
      ]);
      if (owner.live) assert.strictEqual(ownerTree, owner.own + reportedTotal, `${where}: owner`);
      assert.ok(ownerTree >= reportedTotal, `${where}: resume spend never dropped`);
      assert.strictEqual(middleTree, middle.own + ownerTree, `${where}: middle settles`);
      assert.strictEqual(rootTree, root.own + middleTree, `${where}: root settles`);
      if (!ownRunReset) {
        assert.ok(ownerTree >= last.owner, `${where}: owner tree decreased`);
        assert.ok(middleTree >= last.middle, `${where}: middle tree decreased`);
        assert.ok(rootTree >= last.root, `${where}: root tree decreased`);
      }
      maxRootTree = Math.max(maxRootTree, rootTree);
      if (root.aware) {
        if (rootTree >= limit) assert.ok(root.limitReached, `${where}: root cap missed`);
        if (root.limitReached) assert.ok(maxRootTree >= limit, `${where}: root tripped early`);
      }
      Object.assign(last, { root: rootTree, middle: middleTree, owner: ownerTree });
    }
  } finally {
    await prisma.$executeRaw`
      DELETE FROM "SharedEphemeralState"
      WHERE (namespace = ${`resume-reported:${ownerId}`} AND key = ${key})
         OR (namespace = 'resume-total' AND key = ANY(${[ownerId, middleId, rootId]}::text[]))
    `;
    await prisma.agent.deleteMany({ where: { id: { in: [ownerId, middleId, rootId] } } });
  }
}

/** Many raises racing tree-cost writes at every level: nothing is lost (the 62-vs-12 race). */
async function concurrentStress(seed: number): Promise<void> {
  const random = prng(seed);
  const userId = `resume-ledger-stress-${randomUUID()}`;
  const [rootId, middleId, ownerId] = [randomUUID(), randomUUID(), randomUUID()];
  await createAgent(rootId, userId, null, rootId, 100_000, 0);
  await createAgent(middleId, userId, rootId, rootId, 100, 1);
  await createAgent(ownerId, userId, middleId, rootId, 100, 2);
  const models = [ownerId, middleId, rootId].map((id) => ({
    id,
    aware: true,
    live: true,
    limitReached: false,
    own: 0,
    children: {} as Record<string, number>,
  }));
  const [owner, middle, root] = models;
  const keys = [1, 2, 3].map((n) => `resume:code-resume:${ownerId}:stress-${seed}-${n}`);
  const totals = keys.map(() => 0);
  try {
    for (let round = 0; round < 12; round += 1) {
      const raises = keys.map((key, index) => {
        totals[index] += 1 + Math.floor(random() * 9);
        return applyResumeCost(ownerId, { key, total_cents: totals[index] });
      });
      owner.own += 1;
      middle.own += 2;
      root.own += 3;
      middle.children[ownerId] = subtree(owner);
      root.children[middleId] = subtree(middle);
      await Promise.all([
        ...raises,
        persist(owner, null),
        persist(middle, null),
        persist(root, null),
      ]);
    }
    await persist(owner, null);
    await persist(middle, null);
    await persist(root, null);
    const resume = totals.reduce((sum, value) => sum + value, 0);
    assert.strictEqual(await tree(ownerId), owner.own + resume, `stress ${seed}: owner`);
    assert.strictEqual(
      await tree(middleId),
      middle.own + owner.own + resume,
      `stress ${seed}: middle`
    );
    assert.strictEqual(
      await tree(rootId),
      root.own + middle.own + owner.own + resume,
      `stress ${seed}: root`
    );
  } finally {
    await prisma.$executeRaw`
      DELETE FROM "SharedEphemeralState"
      WHERE (namespace = ${`resume-reported:${ownerId}`} AND key = ANY(${keys}::text[]))
         OR (namespace = 'resume-total' AND key = ANY(${[ownerId, middleId, rootId]}::text[]))
    `;
    await prisma.agent.deleteMany({ where: { id: { in: [ownerId, middleId, rootId] } } });
  }
}

async function main(): Promise<void> {
  await test('3-level chains: every resume-aware / pre-deploy mix keeps the ledger invariant', async () => {
    let mix = 0;
    for (const root of [true, false]) {
      for (const middle of [true, false]) {
        for (const owner of [true, false]) {
          for (let seed = 1; seed <= 5; seed += 1) {
            await scenario(mix * 100 + seed, { root, middle, owner });
          }
          mix += 1;
        }
      }
    }
  });
  await test('concurrent raises and tree-cost writes never lose resume spend', async () => {
    for (let seed = 1; seed <= 6; seed += 1) await concurrentStress(seed);
  });
  finish();
}

void main();
