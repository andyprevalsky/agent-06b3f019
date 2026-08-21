/** Codex loopback callback interception for the minimal CDP client. */

type CdpSend = (
  method: string,
  params?: unknown,
  opts?: { raw?: boolean; sessionId?: string }
) => Promise<Record<string, unknown>>;

/** The hosted success destination used by the first-party Codex app server. */
export const CODEX_HOSTED_LOGIN_SUCCESS_URL =
  'https://chatgpt.com/codex/open-app?source=login&app_brand=chatgpt';

export interface CodexCallbackFulfillment {
  responseCode: number;
  responseHeaders: Array<{ name: string; value: string }>;
  body?: string;
}

export function codexCallbackFulfillment(
  callbackUrl: string,
  expectedState: string
): CodexCallbackFulfillment | null {
  try {
    const url = new URL(callbackUrl);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== 'localhost' ||
      (url.port !== '1455' && url.port !== '1457') ||
      url.pathname !== '/auth/callback' ||
      url.searchParams.get('state') !== expectedState
    ) {
      return null;
    }
    const code = url.searchParams.get('code');
    if (code !== null && code !== '') {
      return {
        responseCode: 302,
        responseHeaders: [
          { name: 'Location', value: CODEX_HOSTED_LOGIN_SUCCESS_URL },
          { name: 'Cache-Control', value: 'no-store' },
        ],
      };
    }
    const error = url.searchParams.get('error');
    if (error !== null && error !== '') {
      const html =
        '<!doctype html><meta charset="utf-8"><title>Sign-in not completed</title>' +
        '<main style="font:16px system-ui;padding:40px">Sign-in was not completed. Return to Rose and try again.</main>';
      return {
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'text/html; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(html).toString('base64'),
      };
    }
    return null;
  } catch {
    return null;
  }
}

const CODEX_PATTERNS = [
  { urlPattern: 'http://localhost:1455/auth/callback*', requestStage: 'Request' },
  { urlPattern: 'http://localhost:1457/auth/callback*', requestStage: 'Request' },
];

interface CallbackState {
  expectedState: string | null;
  capturedUrl?: string;
}

function handleCallbackMessage(raw: string, state: CallbackState, send: CdpSend): void {
  let message: {
    method?: string;
    sessionId?: string;
    params?: {
      requestId?: string;
      request?: { url?: string };
      sessionId?: string;
      targetInfo?: { type?: string };
    };
  };
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (
    message.method === 'Target.attachedToTarget' &&
    state.expectedState !== null &&
    message.params?.targetInfo?.type === 'page' &&
    message.params.sessionId !== undefined
  ) {
    void send(
      'Fetch.enable',
      { patterns: CODEX_PATTERNS },
      { sessionId: message.params.sessionId }
    );
    return;
  }
  if (message.method !== 'Fetch.requestPaused') return;
  const requestId = message.params?.requestId;
  const callbackUrl = message.params?.request?.url;
  if (requestId === undefined || callbackUrl === undefined || state.expectedState === null) return;
  const fulfillment = codexCallbackFulfillment(callbackUrl, state.expectedState);
  const session = message.sessionId !== undefined ? { sessionId: message.sessionId } : {};
  if (fulfillment === null) {
    void send('Fetch.continueRequest', { requestId }, session);
    return;
  }
  state.capturedUrl ??= callbackUrl;
  void send('Fetch.fulfillRequest', { requestId, ...fulfillment }, session);
}

async function showFinishingPage(send: CdpSend, callbackUrl: string): Promise<boolean> {
  const callback = new URL(callbackUrl);
  if (
    callback.protocol !== 'http:' ||
    callback.hostname !== 'localhost' ||
    (callback.port !== '1455' && callback.port !== '1457') ||
    callback.pathname !== '/auth/callback'
  ) {
    return false;
  }
  const targetsRes = (await send('Target.getTargets', {}, { raw: true })) as {
    result?: { targetInfos?: Array<{ targetId: string; type: string; url?: string }> };
  };
  const target = (targetsRes.result?.targetInfos ?? []).find(
    (candidate) => candidate.type === 'page' && candidate.url === callbackUrl
  );
  if (target === undefined) return false;
  const attached = (await send(
    'Target.attachToTarget',
    { targetId: target.targetId, flatten: true },
    { raw: true }
  )) as { result?: { sessionId?: string } };
  const sessionId = attached.result?.sessionId;
  if (sessionId === undefined) return false;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Finishing connection</title><style>
:root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #fff; color: #171717; }
main { display: flex; align-items: center; gap: 14px; padding: 24px; }
.spinner { width: 20px; height: 20px; border: 2px solid #d4d4d4; border-top-color: #537fff; border-radius: 50%; animation: spin .8s linear infinite; }
h1 { margin: 0 0 4px; font-size: 16px; font-weight: 600; } p { margin: 0; color: #737373; font-size: 13px; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-color-scheme: dark) { body { background: #0a0a0a; color: #fafafa; } p { color: #a3a3a3; } }
</style></head><body><main><div class="spinner"></div><div><h1>Finishing connection</h1>
<p>You can keep this window open.</p></div></main></body></html>`;
  await send(
    'Page.navigate',
    { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` },
    { sessionId }
  );
  return true;
}

export function createCodexCallbackController(ws: WebSocket, send: CdpSend) {
  const state: CallbackState = { expectedState: null };
  ws.addEventListener('message', (event: MessageEvent) => {
    handleCallbackMessage(String(event.data), state, send);
  });
  return {
    async arm(expectedState: string): Promise<void> {
      state.expectedState = expectedState;
      await send('Fetch.enable', { patterns: CODEX_PATTERNS });
      await send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        { raw: true }
      );
    },
    getCapturedUrl: (): string | undefined => state.capturedUrl,
    showFinishingPage: (callbackUrl: string) => showFinishingPage(send, callbackUrl),
  };
}
