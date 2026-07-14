// System tools available to all Rose agents (mirrors the live tool registry in
// agents/tools/). Drives the public Bazaar listing description.
const SYSTEM_TOOLS = [
  { name: 'web_search', description: 'Search the web for information using Perplexity AI' },
  { name: 'web_fetch', description: 'Fetch and extract content from a specific URL' },
  { name: 'spawn_sub_agents', description: 'Spawn sub-agents for delegating complex subtasks' },
  { name: 'spawn_browser_agent', description: 'Spawn autonomous browser agent for web tasks' },
  {
    name: 'spawn_claude_code_agent',
    description: 'Spawn Claude Code or Codex agent in E2B sandbox for coding tasks',
  },
  { name: 'call_phone_number', description: 'Place an automated phone call to a target number' },
  { name: 'knowledge_base', description: 'Search and retrieve from the user knowledge base' },
  { name: 'read_message_history', description: "Read the user's recent message history" },
  {
    name: 'message_person',
    description: 'Send messages via iMessage or email with AI-generated content',
  },
  {
    name: 'send_message_to_user',
    description: 'Message the user (optionally blocking for a reply)',
  },
  {
    name: 'request_user_approval',
    description: 'Request explicit user approval before continuing',
  },
  { name: 'wait_for', description: 'Wait for a specific event or condition' },
  { name: 'wait_seconds', description: 'Pause execution for a specified duration' },
];

export const BAZAAR_DESCRIPTION = `Spawn an autonomous Rose agent cluster of up to 10,000 agents to complete any arbitrarily complex task. Each Rose agent has access to the following tools:

${SYSTEM_TOOLS.map((tool) => `• ${tool.name}: ${tool.description}`).join('\n')}

Pay with USDC on Base network. Credits are consumed as the agent works. Top up anytime to continue.`;
