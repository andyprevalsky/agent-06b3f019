import * as repo from './repo';

export async function listTools() {
  const tools = await repo.findAllTools();

  return {
    tools: tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
    })),
  };
}
