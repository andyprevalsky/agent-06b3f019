/** Self-contained real-app media wire fixtures; no provider or account mutation. */
import type { Page, Route } from '@playwright/test';
import { installMobileTrajectories, MOBILE_AGENTS } from './mobile-performance';
const VIDEO = Buffer.from(
  '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',
  'base64',
);
const WAV = (() => {
  const out = Buffer.alloc(44 + 8_000 * 2 * 4);
  out.write('RIFF');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(8_000, 24);
  out.writeUInt32LE(16_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(out.length - 44, 40);
  for (let i = 0; i < 32_000; i++)
    out.writeInt16LE(Math.round(Math.sin((i * Math.PI * 440) / 4_000) * 2_000), 44 + 2 * i);
  return out;
})();
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="blue"/></svg>';
const HTML =
  '<!doctype html><html><body><canvas id="c" width="64" height="64"></canvas><script>let n=0;const c=document.querySelector("canvas").getContext("2d");function draw(){c.fillStyle=n++%2?"blue":"green";c.fillRect(0,0,64,64);requestAnimationFrame(draw)}draw()</script></body></html>';
export const MEDIA_AGENT = MOBILE_AGENTS[0];
const when = (i: number) => new Date(Date.UTC(2026, 10, 2, 0, 0, i)).toISOString();
const file = (id: string, mime = 'video/mp4') => ({
  id,
  storage_path: `media-audit/${id}`,
  original_filename: id,
  mime_type: mime,
  size_bytes: VIDEO.length,
  created_at: when(0),
  width: 64,
  height: 64,
});
function messages() {
  const task = 'media-browser-task';
  const call = 'media-browser-call';
  const rows: object[] = [
    {
      message_id: 'media-user',
      timestamp: when(0),
      role: 'USER',
      text: 'Exercise media without losing any recordings.',
      file_pointer: file('inline.mp4'),
    },
  ];
  for (let i = 0; i < 6; i++)
    rows.push({
      message_id: `media-part-${i}`,
      timestamp: when(i + 1),
      role: 'TOOL',
      text: 'Browser session recorded.',
      metadata: {
        task_id: task,
        subAgentId: task,
        toolName: 'spawn_browser_agent',
        action_type: 'recording',
        toolStatus: 'FINISHED',
        recording_started_at: when(i),
        recording_file_pointer: file(
          `part-${i}.${i === 5 ? 'html' : 'mp4'}`,
          i === 5 ? 'text/html' : 'video/mp4',
        ),
      },
    });
  rows.push({
    message_id: 'media-browser-complete',
    timestamp: when(8),
    role: 'TOOL',
    text: '**Status**: ✅ SUCCESS — media audit complete.',
    metadata: {
      task_id: task,
      toolCallId: call,
      toolName: 'spawn_browser_agent',
      action_type: 'task_complete',
      toolStatus: 'FINISHED',
    },
  });
  rows.push({
    message_id: 'media-phone',
    timestamp: when(9),
    role: 'TOOL',
    text: 'Call completed.',
    metadata: {
      toolName: 'call_phone_number',
      toolCallId: 'media-phone-call',
      toolStatus: 'FINISHED',
      phoneCall: {
        status: 'ended',
        to: '+15555550123',
        callId: 'media-call',
        duration: 4,
        endedReason: 'complete',
        transcript: 'Valid four second recording.',
        summary: 'Media lifecycle fixture',
      },
    },
  });
  return rows;
}
export async function installAdversarialMedia(page: Page) {
  const base = await installMobileTrajectories(page);
  const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
  const requests: string[] = [];
  const hold = (id: string) => {
    let release!: () => void;
    const promise = new Promise<void>((done) => {
      release = done;
    });
    gates.set(id, { promise, release });
  };
  const release = (id: string) => {
    gates.get(id)?.release();
    gates.delete(id);
  };
  await page.route('**/api/agents/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path !== `/api/agents/${MEDIA_AGENT}`) return route.fallback();
    const rows = messages();
    await route.fulfill({
      json: {
        agent: {
          agent_id: MEDIA_AGENT,
          title: 'Media audit',
          goal: 'Media lifecycle',
          status: 'COMPLETED',
          source: 'WEB',
          model: 'rose-1-flash',
          created_at: when(0),
          updated_at: when(10),
          message_count: rows.length,
          parent_agent_id: null,
          tools: [],
        },
        messages: rows,
        pagination: { has_more: false, oldest_timestamp: null },
      },
    });
  });
  await page.route('**/api/agents/*/attachments/*/url?*', async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/').at(-2)!;
    requests.push(id);
    const gate = gates.get(id);
    if (gate) await gate.promise;
    try {
      await route.fulfill({ json: { signed_url: `https://media-audit.test/${id}` } });
    } catch {
      /* owner may have aborted the held request */
    }
  });
  await page.route('**/api/agents/*/phone-calls/*/recording', (route) =>
    route.fulfill({ contentType: 'audio/wav', body: WAV }),
  );
  await page.route('https://media-audit.test/**', async (route) => {
    const id = new URL(route.request().url()).pathname.slice(1);
    const gate = gates.get(`body:${id}`);
    if (gate) await gate.promise;
    const body = id.endsWith('.html') ? HTML : id.endsWith('.svg') ? SVG : VIDEO;
    const contentType = id.endsWith('.html')
      ? 'text/html'
      : id.endsWith('.svg')
        ? 'image/svg+xml'
        : 'video/mp4';
    try {
      await route.fulfill({ contentType, body, headers: { 'access-control-allow-origin': '*' } });
    } catch {
      /* aborted media body */
    }
  });
  return {
    ...base,
    hold,
    release,
    requests,
    releaseAll: () => {
      for (const id of [...gates.keys()]) release(id);
    },
    videoBytes: VIDEO.length,
    audioBytes: WAV.length,
  };
}
export async function installMediaAuditObserver(page: Page) {
  await page.addInitScript(() => {
    const blobs = new Map<string, number>();
    const fetches: { url: string; hasSignal: boolean; aborted: boolean; finished: boolean }[] = [];
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      const url = create(blob);
      if (blob instanceof Blob && /^(video\/|audio\/|image\/|text\/html)/.test(blob.type))
        blobs.set(url, blob.size);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      blobs.delete(url);
      revoke(url);
    };
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
      const record = {
        url: String(input instanceof Request ? input.url : input),
        hasSignal: !!signal,
        aborted: signal?.aborted ?? false,
        finished: false,
      };
      fetches.push(record);
      const abort = () => {
        record.aborted = true;
      };
      signal?.addEventListener('abort', abort, { once: true });
      return original(input, init).finally(() => {
        record.finished = true;
        signal?.removeEventListener('abort', abort);
      });
    };
    Object.defineProperty(window, '__mediaAudit', { value: { blobs, fetches } });
  });
}
export async function mediaAuditState(page: Page) {
  return page.evaluate(() => {
    const audit = (
      window as unknown as {
        __mediaAudit: {
          blobs: Map<string, number>;
          fetches: { url: string; hasSignal: boolean; aborted: boolean; finished: boolean }[];
        };
      }
    ).__mediaAudit;
    return {
      blobUrls: [...audit.blobs.keys()],
      blobBytes: [...audit.blobs.values()].reduce((a, b) => a + b, 0),
      fetches: audit.fetches.map((x) => ({ ...x })),
      media: [...document.querySelectorAll('video,audio')].map((x) => {
        const m = x as HTMLMediaElement;
        return {
          tag: m.tagName,
          paused: m.paused,
          src: m.getAttribute('src'),
          readyState: m.readyState,
          currentTime: m.currentTime,
        };
      }),
    };
  });
}
