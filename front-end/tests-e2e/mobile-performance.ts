/** API fixtures and passive browser resource observations for the real mobile app. */
import { expect, type CDPSession, type Page } from '@playwright/test';
import { closeSync, openSync, writeSync } from 'node:fs';

export const MOBILE_AGENTS = ['mobile-long-a', 'mobile-long-b'] as const;
export const MESSAGES_PER_AGENT = 3_000;
const START = Date.now() - MESSAGES_PER_AGENT * 1_000;

function trajectory(id: string) {
  return Array.from({ length: MESSAGES_PER_AGENT }, (_, index) => {
    const step = index % 30;
    const turn = Math.floor(index / 30);
    const user = step === 0;
    const report = step === 29;
    return {
      message_id: `${id}-${index}`,
      timestamp: new Date(START + index * 1_000).toISOString(),
      role: user ? 'USER' : step === 1 ? 'ASSISTANT' : 'TOOL',
      text: user
        ? `Review section ${turn} of the mobile performance audit for ${id}. Keep the original sources and check the navigation.`
        : report
          ? `Section ${turn} verified for ${id}.\n\nThe source review and navigation checks are complete. **Result:** all evidence preserved.\n\n- Original content is readable\n- Follow-up work is recorded`
          : `Audit ${id}, section ${turn}, step ${step}: inspect the implementation and compare recorded evidence.\n\n${'The navigation, rendering, and cleanup contracts must remain consistent with the original source. '.repeat(4)}`,
      ...(!user && step !== 1
        ? {
            metadata: {
              toolName: report ? 'send_message_to_user' : step % 2 ? 'run_command' : 'read_file',
              toolCallId: `${id}-call-${index}`,
              toolStatus: 'FINISHED',
              title: `Inspect audit source ${turn}/${step}`,
              ...(report ? { isUserAttentionMessage: true } : {}),
            },
          }
        : {}),
    };
  });
}

export async function installMobileTrajectories(page: Page) {
  const channels = new Set<Set<string>>();
  let joins = 0;
  let leaves = 0;
  // Keep the real Supabase client/channel lifecycle, replying only at its wire
  // boundary. Fixture auth must never contact the production realtime service.
  await page.routeWebSocket('**/realtime/v1/websocket*', (socket) => {
    const active = new Set<string>();
    channels.add(active);
    socket.onClose(() => channels.delete(active));
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      const array = Array.isArray(frame);
      const message = array
        ? { join_ref: frame[0], ref: frame[1], topic: frame[2], event: frame[3], payload: frame[4] }
        : frame;
      if (message.event === 'phx_join') {
        active.add(message.topic);
        joins++;
      }
      if (message.event === 'phx_leave') {
        active.delete(message.topic);
        leaves++;
      }
      if (['phx_join', 'phx_leave', 'heartbeat'].includes(message.event)) {
        const payload = { status: 'ok', response: { postgres_changes: [] } };
        socket.send(
          JSON.stringify(
            array
              ? [message.join_ref, message.ref, message.topic, 'phx_reply', payload]
              : { ...message, event: 'phx_reply', payload },
          ),
        );
      }
    });
  });
  const messages = MOBILE_AGENTS.map(trajectory);
  const agents = MOBILE_AGENTS.map((id) => ({
    agent_id: id,
    title: `Long audit ${id.endsWith('a') ? 'A' : 'B'}`,
    goal: `Review the mobile performance audit for ${id}`,
    model: 'rose-1-flash',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 100,
    status: 'COMPLETED',
    created_at: new Date(START).toISOString(),
    updated_at: new Date(START + MESSAGES_PER_AGENT * 1_000).toISOString(),
    parent_agent_id: null,
    tools: [],
    context_size: 0,
    token_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    message_count: MESSAGES_PER_AGENT,
    price_limit_cents: 100,
    tree_cost_cents: 0,
  }));
  await page.addInitScript(() => {
    const user = { id: 'mobile-performance-viewer', is_anonymous: false };
    localStorage.setItem('app-user', JSON.stringify(user));
    localStorage.setItem(
      'rose-session',
      JSON.stringify({
        user,
        access_token: 'fixture',
        refresh_token: 'fixture',
        token_type: 'bearer',
        expires_at: 9999999999,
      }),
    );
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') return route.fulfill({ status: 204 });
    const index = MOBILE_AGENTS.findIndex((id) => path === `/api/agents/${id}`);
    let body: unknown = {};
    if (index !== -1)
      body = {
        agent: agents[index],
        messages: messages[index],
        pagination: { has_more: false, oldest_timestamp: null },
      };
    else if (path === '/api/agents' || path === '/api/agents/tree') body = { agents };
    else if (path === '/api/agents/code-agents') body = { code_agents: [] };
    else if (path === '/api/projects') body = { projects: [] };
    else if (path === '/api/attention-requests') body = { requests: [] };
    else if (path === '/api/invite-codes/check') body = { needsInviteCode: false };
    await route.fulfill({ json: body });
  });
  return {
    agents: agents.length,
    messagesPerAgent: MESSAGES_PER_AGENT,
    realtime: () => ({
      active: [...channels].reduce((sum, active) => sum + active.size, 0),
      joins,
      leaves,
    }),
    responseBytes: messages.map((rows, i) =>
      Buffer.byteLength(JSON.stringify({ agent: agents[i], messages: rows })),
    ),
  };
}

export async function mobileResourceMonitor(page: Page) {
  await page.addInitScript(() => {
    const tasks = { count: 0, totalMs: 0, maxMs: 0 };
    Object.defineProperty(window, '__mobileLongTasks', { value: tasks });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        tasks.count++;
        tasks.totalMs += entry.duration;
        tasks.maxMs = Math.max(tasks.maxMs, entry.duration);
      }
    }).observe({ type: 'longtask', buffered: true });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const inflight = new Map<string, { path: string; method: string }>();
  const sockets = new Set<string>();
  const paths: Record<string, number> = {};
  const methods: Record<string, number> = {};
  const failedRequests: Record<string, number> = {};
  const telemetryResponses: Record<string, number> = {};
  let requests = 0;
  let apiGetRequests = 0;
  let failures = 0;
  cdp.on('Network.requestWillBeSent', (event) => {
    requests++;
    const url = new URL(event.request.url);
    const path = url.pathname;
    const method = event.request.method;
    const methodPath = `${method} ${url.origin}${path}`;
    methods[methodPath] = (methods[methodPath] ?? 0) + 1;
    if (method === 'GET' && path.startsWith('/api/')) apiGetRequests++;
    inflight.set(event.requestId, { path: `${url.origin}${path}`, method: event.request.method });
    paths[path] = (paths[path] ?? 0) + 1;
  });
  cdp.on('Network.loadingFinished', ({ requestId }) => inflight.delete(requestId));
  cdp.on('Network.responseReceived', ({ response }) => {
    const url = new URL(response.url);
    if (url.hostname.endsWith('.amplitude.com')) {
      const key = `${response.status} ${url.origin}${url.pathname}`;
      telemetryResponses[key] = (telemetryResponses[key] ?? 0) + 1;
    }
  });
  cdp.on('Network.loadingFailed', ({ requestId, errorText }) => {
    failures++;
    const request = inflight.get(requestId);
    const key = `${request?.method} ${request?.path}: ${errorText}`;
    failedRequests[key] = (failedRequests[key] ?? 0) + 1;
    inflight.delete(requestId);
  });
  cdp.on('Network.webSocketCreated', ({ requestId }) => sockets.add(requestId));
  cdp.on('Network.webSocketClosed', ({ requestId }) => sockets.delete(requestId));
  const snapshot = async (label: string) => {
    // Cross a task boundary before GC so React's prior commit can retire. CDP
    // handles are always released: the observer must not create its own leak.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const heap = {
      usedSize: await retainedHeapBytes(cdp, () => page.waitForTimeout(HEAP_STABLE_INTERVAL_MS)),
    };
    const dom = await cdp.send('Memory.getDOMCounters');
    const retained: Record<string, number> = {};
    for (const name of [
      'WebSocket',
      'BroadcastChannel',
      'RTCPeerConnection',
      'MediaStream',
      'MediaSource',
    ]) {
      retained[name] = await retainedInstances(cdp, name);
    }
    const view = await page.evaluate(() => ({
      elements: document.querySelectorAll('*').length,
      mediaElements: document.querySelectorAll('video, audio, iframe').length,
      longTasks: (
        window as unknown as {
          __mobileLongTasks: { count: number; totalMs: number; maxMs: number };
        }
      ).__mobileLongTasks,
    }));
    return {
      label,
      heapBytes: heap.usedSize,
      nodes: dom.nodes,
      documents: dom.documents,
      listeners: dom.jsEventListeners,
      ...view,
      retained,
      requests,
      apiGetRequests,
      failures,
      inflight: inflight.size,
      openSockets: sockets.size,
    };
  };
  const background = async () => {
    const before = requests;
    const beforeApiGets = apiGetRequests;
    const beforePaths = { ...paths };
    const beforeMethods = { ...methods };
    await page.waitForTimeout(2_000); // Observation window, never a latency assertion.
    return {
      requests: requests - before,
      apiGetRequests: apiGetRequests - beforeApiGets,
      inflight: inflight.size,
      openSockets: sockets.size,
      paths: Object.fromEntries(
        Object.entries(paths)
          .map(([path, count]) => [path, count - (beforePaths[path] ?? 0)])
          .filter(([, count]) => count !== 0),
      ),
      methods: Object.fromEntries(
        Object.entries(methods)
          .map(([path, count]) => [path, count - (beforeMethods[path] ?? 0)])
          .filter(([, count]) => count !== 0),
      ),
    };
  };
  const heapSnapshot = async (path: string) => {
    const file = openSync(path, 'w', 0o600);
    const chunk = ({ chunk }: { chunk: string }) => writeSync(file, chunk);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', chunk);
    try {
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    } finally {
      cdp.off('HeapProfiler.addHeapSnapshotChunk', chunk);
      closeSync(file);
    }
  };
  return {
    snapshot,
    background,
    heapSnapshot,
    paths,
    methods,
    failedRequests,
    telemetryResponses,
    dispose: () => cdp.detach(),
  };
}

// Retained heap = the post-GC heap once the page is quiescent (RCA
// 2026-11-12-mobile-heap-probe-sampled-in-flight-work-not-retained-heap):
// - one HeapProfiler.collectGarbage can leave floating garbage that the next
//   pass frees, so every read collects until a pass frees under HEAP_SETTLED_BYTES;
// - a sample taken right after a navigation can land while the app is still
//   working on it, holding megabytes that are live for a second or more and then
//   released, so reads repeat once per HEAP_STABLE_INTERVAL_MS until two agree.
// Reachable memory such as a leaked trajectory survives every pass and interval
// and is measured in full; a heap still changing after MAX_HEAP_READS fails loudly.
const HEAP_SETTLED_BYTES = 256 * 1024;
const MAX_GC_PASSES = 8;
const HEAP_STABLE_INTERVAL_MS = 1_000; // Idle observation between reads, never a latency assertion.
const MAX_HEAP_READS = 10;

async function settledHeapBytes(cdp: Pick<CDPSession, 'send'>) {
  let previous = Infinity;
  for (let pass = 0; pass < MAX_GC_PASSES; pass++) {
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = await cdp.send('Runtime.getHeapUsage');
    if (previous - usedSize < HEAP_SETTLED_BYTES) return Math.min(previous, usedSize);
    previous = usedSize;
  }
  throw new Error(`post-GC heap still shrinking after ${MAX_GC_PASSES} collections`);
}

export async function retainedHeapBytes(cdp: Pick<CDPSession, 'send'>, idle: () => Promise<void>) {
  let previous = await settledHeapBytes(cdp);
  for (let read = 1; read < MAX_HEAP_READS; read++) {
    await idle();
    const current = await settledHeapBytes(cdp);
    if (Math.abs(current - previous) < HEAP_SETTLED_BYTES) return Math.min(previous, current);
    previous = current;
  }
  throw new Error(
    `post-GC heap still changing after ${MAX_HEAP_READS} reads ${HEAP_STABLE_INTERVAL_MS} ms apart`,
  );
}

async function retainedInstances(cdp: CDPSession, constructor: string) {
  const objectGroup = 'mobile-resource-observation';
  try {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(constructor)}]?.prototype`,
      objectGroup,
    });
    if (!result.objectId) return 0;
    const { objects } = await cdp.send('Runtime.queryObjects', {
      prototypeObjectId: result.objectId,
      objectGroup,
    });
    const count = await cdp.send('Runtime.callFunctionOn', {
      objectId: objects.objectId,
      functionDeclaration: 'function () { return this.length; }',
      returnByValue: true,
    });
    return Number(count.result.value);
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup });
  }
}

export async function expectMobileContent(page: Page, id: string) {
  const latest = page.locator(`[data-message-id="${id}-${MESSAGES_PER_AGENT - 1}"]`);
  await expect(latest).toContainText(`Section 99 verified for ${id}`);
  await latest.scrollIntoViewIfNeeded();
  await expect(latest).toBeInViewport();
  const overflow = await latest.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, right: box.right, width: innerWidth };
  });
  expect(overflow.left).toBeGreaterThanOrEqual(-1);
  expect(overflow.right).toBeLessThanOrEqual(overflow.width + 2);
  await expect(
    page.locator(`[data-message-id^="${MOBILE_AGENTS.find((other) => other !== id)}-"]`),
  ).toHaveCount(0);
}
