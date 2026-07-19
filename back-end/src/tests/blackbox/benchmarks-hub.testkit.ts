export function syntheticBenchmarkBundle(
  runId: string,
  rootAgentId: string,
  subAgentId: string
): Record<string, unknown> {
  return {
    run_id: runId,
    timestamp: new Date().toISOString(),
    suite: 'blackbox',
    source: 'blackbox-test',
    tasks: [
      {
        name: 'chat-mode',
        passed: true,
        status: 'passed',
        agent_id: rootAgentId,
        duration_seconds: 12.5,
        cost_cents: 3,
        world_model_mode: 'real',
        fast_mode_cache_enabled: true,
        tree_agent_count: 2,
        logs: {
          messages: [
            { role: 'USER', message: 'hub blackbox goal', created_at: '2026-07-10T00:00:01Z' },
            { role: 'ASSISTANT', message: 'root reply', created_at: '2026-07-10T00:00:02Z' },
          ],
          tree: {
            [rootAgentId]: {
              parent_agent_id: null,
              goal: 'hub blackbox goal',
              status: 'COMPLETED',
              messages: [
                {
                  role: 'USER',
                  message: 'hub blackbox goal',
                  created_at: '2026-07-10T00:00:01Z',
                },
                {
                  role: 'ASSISTANT',
                  message: 'root reply',
                  created_at: '2026-07-10T00:00:02Z',
                },
              ],
            },
            [subAgentId]: {
              parent_agent_id: rootAgentId,
              goal: 'sub research goal',
              status: 'COMPLETED',
              messages: [
                {
                  role: 'ASSISTANT',
                  message: 'sub result',
                  created_at: '2026-07-10T00:00:03Z',
                },
              ],
            },
          },
        },
      },
    ],
  };
}
