/** Massive payloads at the app's intercepted API and real Supabase wire boundary. */
import type { Page, WebSocketRoute } from '@playwright/test';
import { installMobileTrajectories } from './mobile-performance';
export const ADVERSARIAL_AGENTS = ['massive-a', 'massive-b'] as const;
export async function installAdversarialTrajectories(
  page: Page,
  count: number,
  options: { streaming?: boolean; huge?: boolean } = {},
) {
  const wire = await installMobileTrajectories(page);
  const topics = new Map<string, { socket: WebSocketRoute; array: boolean; joinRef: string }>();
  let joins = 0,
    leaves = 0;
  if (options.streaming)
    await page.routeWebSocket('**/realtime/v1/websocket*', (socket) => {
      socket.onClose(() => {
        for (const [key, value] of topics) if (value.socket === socket) topics.delete(key);
      });
      socket.onMessage((raw) => {
        const frame = JSON.parse(String(raw)),
          array = Array.isArray(frame);
        const m = array
          ? {
              join_ref: frame[0],
              ref: frame[1],
              topic: frame[2],
              event: frame[3],
              payload: frame[4],
            }
          : frame;
        if (m.event === 'phx_join') {
          topics.set(m.topic, { socket, array, joinRef: m.join_ref });
          joins++;
        }
        if (m.event === 'phx_leave') {
          topics.delete(m.topic);
          leaves++;
        }
        if (['phx_join', 'phx_leave', 'heartbeat'].includes(m.event)) {
          const payload = { status: 'ok', response: { postgres_changes: [] } };
          socket.send(
            JSON.stringify(
              array
                ? [m.join_ref, m.ref, m.topic, 'phx_reply', payload]
                : { ...m, event: 'phx_reply', payload },
            ),
          );
        }
      });
    });
  const epoch = Date.now() - count * 100;
  const agents = ADVERSARIAL_AGENTS.map((agent_id) => ({
    agent_id,
    title: `Massive audit ${agent_id}`,
    goal: `Adversarial audit ${agent_id}`,
    model: 'rose-1-flash',
    source: 'WEB',
    reasoning_effort: 'medium',
    status: options.streaming ? 'ACTIVE' : 'COMPLETED',
    progress: 100,
    parent_agent_id: null,
    created_at: new Date(epoch).toISOString(),
    updated_at: new Date().toISOString(),
    message_count: count,
    tools: [],
    price_limit_cents: 100,
    tree_cost_cents: 0,
    context_size: count * 100,
    token_count: count * 50,
    tokens_in: count * 40,
    tokens_out: count * 10,
  }));
  const payloads = new Map<string, string>();
  const bytes: Record<string, number> = {},
    requests: Record<string, number> = {};
  const held: { id: string; release: () => void }[] = [];
  let holdNext: string | undefined;
  function payload(id: string) {
    if (payloads.has(id)) return payloads.get(id)!;
    const messages = Array.from({ length: count }, (_, index) => {
      const step = index % 40,
        turn = Math.floor(index / 40);
      return {
        message_id: `${id}-${index}`,
        timestamp: new Date(epoch + index * 100 + (step === 2 ? 50 : 0)).toISOString(),
        role: step === 0 ? 'USER' : step === 1 ? 'ASSISTANT' : 'TOOL',
        text:
          step === 0
            ? `Oldest source ${turn} for ${id}: preserve all original evidence and navigation.`
            : step === 39
              ? `Complete section ${turn} for ${id}. **Verified evidence.**\n\n- Sources remain accessible\n- Navigation stays correct\n\n[Source reference](https://example.com/audit/${id}/${turn})`
              : `Audit ${id} section ${turn} step ${step}. Inspect the source, verify ordering and record the full result.\n\n${'The source and navigation contracts must remain consistent. '.repeat(2)}`,
        ...(step > 1
          ? {
              metadata: {
                toolName:
                  step === 39 ? 'send_message_to_user' : step % 2 ? 'run_command' : 'read_file',
                toolCallId: `${id}-call-${index}`,
                title: `Audit activity ${turn}/${step}`,
                toolStatus: 'FINISHED',
                ...(step === 39 ? { isUserAttentionMessage: true } : {}),
              },
            }
          : {}),
      };
    });
    if (options.huge)
      messages[count - 1].text +=
        '\n\nHUGE_BEGIN\n\n```javascript\n' +
        Array.from(
          { length: 8192 },
          (_, i) =>
            `const source_${i} = { index: ${i}, evidence: "retain this full source and its navigation contract" };`,
        ).join('\n') +
        '\n```\n\nHUGE_END';
    const body = JSON.stringify({
      agent: agents.find((a) => a.agent_id === id),
      messages,
      pagination: { has_more: false, oldest_timestamp: null },
    });
    payloads.set(id, body);
    bytes[id] = Buffer.byteLength(body);
    return body;
  }
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (route.request().method() !== 'GET') return route.fulfill({ status: 204 });
    const id = ADVERSARIAL_AGENTS.find((id) => path === `/api/agents/${id}`);
    if (id) {
      requests[id] = (requests[id] ?? 0) + 1;
      const body = payload(id);
      if (holdNext === id) {
        holdNext = undefined;
        await new Promise<void>((release) => held.push({ id, release }));
      }
      return route.fulfill({ body, contentType: 'application/json' }).catch(() => {});
    }
    let body: unknown = {};
    if (path === '/api/agents' || path === '/api/agents/tree') body = { agents };
    else if (path === '/api/agents/code-agents') body = { code_agents: [] };
    else if (path === '/api/projects') body = { projects: [] };
    else if (path === '/api/attention-requests') body = { requests: [] };
    else if (path === '/api/invite-codes/check') body = { needsInviteCode: false };
    return route.fulfill({ json: body });
  });
  return {
    count,
    bytes,
    requests,
    realtime: options.streaming ? () => ({ active: topics.size, joins, leaves }) : wire.realtime,
    emit: (id: string, event: string, record: Record<string, unknown>) => {
      let sent = 0;
      for (const [topic, target] of topics)
        if (topic.endsWith(`agent:${id}`)) {
          const payload = { type: 'broadcast', event, payload: { record } };
          target.socket.send(
            JSON.stringify(
              target.array
                ? [target.joinRef, null, topic, 'broadcast', payload]
                : { join_ref: target.joinRef, ref: null, topic, event: 'broadcast', payload },
            ),
          );
          sent++;
        }
      return sent;
    },
    hold: (id: string) => {
      holdNext = id;
    },
    held: () => held.map(({ id }) => id),
    release: () => held.splice(0).forEach(({ release }) => release()),
  };
}
