import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Seed some example tools
  const tools = [
    {
      name: 'web_search',
      description: 'Search the web for information',
    },
    {
      name: 'code_executor',
      description: 'Execute code in a sandboxed environment',
    },
    {
      name: 'file_reader',
      description: 'Read and analyze files',
    },
    {
      name: 'api_caller',
      description: 'Make HTTP API requests',
    },
    {
      name: 'database_query',
      description: 'Query databases',
    },
  ];

  for (const tool of tools) {
    await prisma.tool.upsert({
      where: { name: tool.name },
      update: {},
      create: tool,
    });
    console.log(`✓ Created/verified tool: ${tool.name}`);
  }

  console.log('Seeding completed!');
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

