#!/usr/bin/env tsx
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { nonLocalDatabaseReason } from '../src/utils/localDatabaseUrl';

type Options = {
  agentId: string;
  sourceOut: string;
  treeOut?: string;
};

const prisma = new PrismaClient();

function usage(): never {
  console.log(`usage: npx tsx scripts/export-agent-checkpoint.ts --agent-id UUID --source-out PATH [options]

Export a local benchmark agent transcript and optional tree JSON for checkpoint cloning.

Options:
  --tree-out PATH   Export all Agent rows in the root tree.
`);
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { agentId: '', sourceOut: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === '--help' || arg === '-h') usage();
    else if (arg === '--agent-id') opts.agentId = next();
    else if (arg === '--source-out') opts.sourceOut = next();
    else if (arg === '--tree-out') opts.treeOut = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!opts.agentId) throw new Error('--agent-id is required');
  if (!opts.sourceOut) throw new Error('--source-out is required');
  return opts;
}

function assertLocalDatabase() {
  if (process.env.ALLOW_PROD_CHECKPOINT_CLONE === 'true') return;
  const reason = nonLocalDatabaseReason(process.env.DATABASE_URL);
  if (reason) {
    throw new Error(
      `Refusing to export checkpoint: ${reason}. ` +
        'Set ALLOW_PROD_CHECKPOINT_CLONE=true only if you intend this.'
    );
  }
}

function writeJson(path: string, value: unknown) {
  const out = resolve(path);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(value, null, 2));
  return out;
}

function exportedAgent(agent: any) {
  return {
    agent_id: agent.id,
    id: agent.id,
    user_id: agent.userId,
    goal: agent.goal,
    status: agent.status,
    progress: agent.progress,
    model: agent.model,
    source: agent.source,
    reasoning_max_tokens: agent.reasoningMaxTokens,
    response_schema: agent.responseSchema,
    price_limit_cents: agent.priceLimitCents,
    write_lock_enabled: agent.writeLockEnabled,
    fast_mode_cache_enabled: agent.fastModeCacheEnabled,
    verifier: agent.verifier ? { type: agent.verifier.type } : undefined,
  };
}

function exportedTreeAgent(agent: any) {
  return {
    agent_id: agent.id,
    id: agent.id,
    parent_agent_id: agent.parentAgentId,
    goal: agent.goal,
    status: agent.status,
    progress: agent.progress,
    tools_in_use: agent.toolsInUse,
    message_count: agent.messageCount,
    output_schema: agent.responseSchema,
    structured_output: agent.structuredResponse,
    tree_cost_cents: agent.treeCostCents,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  assertLocalDatabase();

  const root = await prisma.agent.findUnique({
    where: { id: opts.agentId },
    include: {
      verifier: true,
      messages: { orderBy: [{ timestamp: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
  if (!root) throw new Error(`Agent not found: ${opts.agentId}`);
  if (root.parentAgentId) throw new Error(`Expected root agent, got child agent ${opts.agentId}`);

  const sourceOut = writeJson(opts.sourceOut, {
    agent: exportedAgent(root),
    messages: root.messages.map((message) => ({
      message_id: message.id,
      id: message.id,
      timestamp: message.timestamp.toISOString(),
      text: message.text,
      role: message.role,
      metadata: message.metadata,
      file_pointer: message.filePointer,
    })),
  });

  let treeOut: string | null = null;
  if (opts.treeOut) {
    const agents = await prisma.agent.findMany({
      where: { OR: [{ id: root.id }, { busId: root.busId || root.id }] },
      orderBy: [{ depth: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    treeOut = writeJson(opts.treeOut, { agents: agents.map(exportedTreeAgent) });
  }

  console.log(`agent_id=${root.id}`);
  console.log(`source_json=${sourceOut}`);
  if (treeOut) console.log(`tree_json=${treeOut}`);
  console.log(`message_count=${root.messages.length}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
