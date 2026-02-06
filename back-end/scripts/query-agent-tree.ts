import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function getAgentTree(rootId: string, depth = 0): Promise<any[]> {
  const agent = await prisma.agent.findUnique({
    where: { id: rootId },
    select: {
      id: true,
      goal: true,
      tokensIn: true,
      tokensOut: true,
      treeCostCents: true,
      parentAgentId: true,
    }
  });

  if (!agent) return [];

  const children = await prisma.agent.findMany({
    where: { parentAgentId: rootId },
    select: { id: true }
  });

  const result = [{
    id: agent.id.slice(0, 8),
    full_id: agent.id,
    depth,
    tokens_in: agent.tokensIn,
    tokens_out: agent.tokensOut,
    tree_cost: agent.treeCostCents,
    is_leaf: children.length === 0,
    goal: agent.goal?.slice(0, 50)
  }];

  for (const child of children) {
    const childResults = await getAgentTree(child.id, depth + 1);
    result.push(...childResults);
  }

  return result;
}

async function main() {
  const tree = await getAgentTree('f49cde36-23d1-467b-8eba-136eaf0f6634');

  // Sort by tokens_in descending
  const sorted = tree.sort((a, b) => (b.tokens_in || 0) - (a.tokens_in || 0));

  console.log('=== ALL AGENTS IN TREE (sorted by tokens_in) ===');
  console.log('ID       | Depth | Tokens In    | Tokens Out | Tool $ | Leaf? | Goal');
  console.log('-'.repeat(120));

  let totalTokensIn = 0;
  let leafTokensIn = 0;

  for (const a of sorted) {
    const leaf = a.is_leaf ? 'LEAF' : '';
    console.log(`${a.id} | ${a.depth}     | ${String(a.tokens_in || 0).padStart(12)} | ${String(a.tokens_out || 0).padStart(10)} | ${String(a.tree_cost || 0).padStart(5)} | ${leaf.padEnd(4)} | ${a.goal || ''}`);
    totalTokensIn += a.tokens_in || 0;
    if (a.is_leaf) leafTokensIn += a.tokens_in || 0;
  }

  console.log('-'.repeat(120));
  console.log(`Total agents: ${sorted.length}`);
  console.log(`Total tokens_in: ${totalTokensIn.toLocaleString()}`);
  console.log(`Leaf-only tokens_in: ${leafTokensIn.toLocaleString()}`);
  console.log(`Leaf nodes: ${sorted.filter(a => a.is_leaf).length}`);

  // Show top 10 leaf nodes
  console.log('\n=== TOP 10 LEAF NODES BY COST ===');
  const leaves = sorted.filter(a => a.is_leaf).slice(0, 10);
  for (const a of leaves) {
    const cost = ((a.tokens_in || 0) * 0.000001) + ((a.tokens_out || 0) * 0.000005) + ((a.tree_cost || 0) / 100);
    console.log(`${a.full_id} | $${cost.toFixed(2)} | ${a.goal || ''}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
