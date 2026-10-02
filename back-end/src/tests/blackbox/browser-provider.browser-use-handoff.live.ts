/** Paid Browser Use handoff smoke: iframe input -> auth completion -> paused profile reuse. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright';
import { prisma } from '../../providers/database';
import { buildPreferredBrowserConfig } from '../../providers/browser/challengeRecovery';
import { releaseBrowserUseRemoteSession } from '../../providers/browser/browserUse';
import { resumeSession } from '../../providers/browser';
import { releaseKernelRemoteSession } from '../../providers/browser/kernel';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(typeof value === 'object' && value !== null, 'Expected JSON object');
  return value as Record<string, unknown>;
}

async function assertRepeatedBrowserUseUploads(
  base: string,
  headers: Record<string, string>,
  sessionId: string,
  remote: Awaited<ReturnType<typeof chromium.connectOverCDP>>
): Promise<void> {
  const upload = async (value: string): Promise<string> => {
    const form = new FormData();
    form.append('file', new Blob([value], { type: 'text/plain' }), 'same-name.txt');
    const response = await fetch(`${base}/api/browser-session/${sessionId}/files`, {
      method: 'POST',
      headers: { 'X-API-Key': headers['X-API-Key']!, 'X-User-Id': headers['X-User-Id']! },
      body: form,
    });
    const result = asRecord(await response.json());
    assert(response.ok && typeof result.path === 'string', 'Browser Use upload failed');
    return result.path;
  };
  const first = await upload('first upload');
  const second = await upload('second upload');
  assert(first !== second, 'Repeated Browser Use uploads reused one remote path');
  const context = remote.contexts()[0];
  assert(context, 'Browser Use upload verification context is missing');
  const page = await context.newPage();
  try {
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'browser-use-repeated-upload-check';
      document.body.appendChild(input);
    });
    const cdp = await context.newCDPSession(page);
    const domDocument = await cdp.send('DOM.getDocument');
    const input = await cdp.send('DOM.querySelector', {
      nodeId: domDocument.root.nodeId,
      selector: '#browser-use-repeated-upload-check',
    });
    assert(input.nodeId, 'Browser Use upload verification input is missing');
    for (const [remotePath, expected] of [
      [first, 'first upload'],
      [second, 'second upload'],
    ]) {
      await cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [remotePath] });
      const actual = await page.evaluate(
        'new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsText(document.querySelector("#browser-use-repeated-upload-check").files[0]); })'
      );
      assert(actual === expected, 'Browser Use upload bytes changed');
    }
  } finally {
    await page.close();
  }
}

export async function runLiveBrowserUseHandoff(): Promise<void> {
  const base = process.env.TEST_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.BACKEND_API_KEY;
  const providerKey = process.env.BROWSER_USE_API_KEY;
  if (!base || !apiKey || !providerKey) {
    throw new Error(
      'Live Browser Use handoff needs TEST_BASE_URL, BACKEND_API_KEY and BROWSER_USE_API_KEY'
    );
  }
  const userId = `browser-use-handoff-${randomUUID()}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
    'X-User-Id': userId,
  };
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = asRecord(await response.json());
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${JSON.stringify(data)}`);
    return data;
  };
  let sessionId: string | null = null;
  let resumedSessionId: string | null = null;
  let kernelSessionId: string | null = null;
  let profileId: string | null = null;
  let viewer: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  await prisma.user.create({ data: { userId } });
  const agent = await prisma.agent.create({
    data: {
      userId,
      goal: 'Verify Browser Use login handoff',
      status: 'PAUSED',
      proxyCountry: 'US',
    },
  });
  await prisma.browserContext.create({
    data: {
      userId,
      preferredBrowserConfig: buildPreferredBrowserConfig(
        { provider: 'browser-use', proxyMode: 'residential_country' },
        { country: 'US' }
      ),
    },
  });
  try {
    const initial = await post('/api/browser-session/init', {
      user_id: userId,
      agent_id: agent.id,
      start_url: 'https://example.com',
    });
    sessionId = String(initial.session_id);
    const taskId = String(initial.task_id);
    const metadata = asRecord(initial.browser_session_metadata);
    assert(metadata.provider === 'browser-use', 'Preferred Browser Use provider was not selected');
    profileId = String(metadata.profile_id);
    assert(profileId !== 'null' && profileId !== '', 'Persistent profile was not created');

    const remote = await chromium.connectOverCDP(String(initial.ws_url));
    try {
      const context = remote.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        const form = document.createElement('form');
        form.id = 'rose-handoff-proof';
        form.innerHTML = `
          <label>Username <input name="username" autocomplete="username"></label>
          <label>Password <input name="password" type="password" autocomplete="current-password"></label>
          <label>One-time code <input name="code" inputmode="numeric"></label>
          <button type="submit">Sign in</button>
        `;
        Object.assign(form.style, {
          position: 'fixed',
          left: '400px',
          top: '200px',
          width: '300px',
          padding: '12px',
          zIndex: '2147483647',
          background: 'white',
          color: 'black',
        });
        for (const element of form.querySelectorAll('label, input, button')) {
          Object.assign((element as HTMLElement).style, {
            display: 'block',
            width: '100%',
            height: '34px',
            boxSizing: 'border-box',
          });
        }
        for (const label of form.querySelectorAll('label')) label.style.height = '68px';
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          const fields = new FormData(form);
          if (
            fields.get('username') !== 'demo-user' ||
            fields.get('password') !== 'demo-password' ||
            fields.get('code') !== '123456'
          )
            return;
          document.cookie = 'rose_handoff=signed-in; path=/; max-age=600; SameSite=Lax';
          localStorage.setItem('rose_handoff', 'signed-in');
          form.insertAdjacentHTML('beforeend', '<strong id="rose-signed-in">Signed in</strong>');
        });
        document.body.appendChild(form);
      });
      const assistance = await post('/api/auth-assistance', {
        agentId: agent.id,
        authRealm: 'example.com',
        mode: 'live_view',
        browserSessionId: taskId,
      });
      const requestId = String(asRecord(assistance.request).id);
      const liveUrl = new URL(String(asRecord(assistance.handoff).liveViewUrl));
      assert(liveUrl.hostname === 'live.browser-use.com', 'Handoff URL is not Browser Use');
      liveUrl.searchParams.set('ui', 'false');

      viewer = await chromium.launch({ headless: true });
      const viewerPage = await viewer.newPage({ viewport: { width: 1280, height: 800 } });
      await viewerPage.setContent(
        `<iframe src="${liveUrl.toString().replace(/&/g, '&amp;')}" title="Live browser" ` +
          'style="width:1280px;height:800px;border:0" ' +
          'sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"></iframe>'
      );
      await viewerPage.waitForTimeout(3_000);
      await viewerPage.mouse.click(500, 245);
      await viewerPage.keyboard.type('demo-user', { delay: 70 });
      await viewerPage.mouse.click(500, 315);
      await viewerPage.keyboard.type('demo-password', { delay: 70 });
      await viewerPage.mouse.click(500, 385);
      await viewerPage.keyboard.type('123456', { delay: 70 });
      await viewerPage.mouse.click(500, 435);
      await page.waitForFunction(
        () => Boolean(document.querySelector('#rose-signed-in')),
        undefined,
        { timeout: 10_000 }
      );
      await viewerPage.screenshot({
        path: path.resolve(process.cwd(), '../.context/browser-use-handoff-proof.png'),
      });
      assert(
        await page.evaluate(() => document.cookie.includes('rose_handoff=signed-in')),
        'Live viewer input did not set the sign-in cookie'
      );
      const keypress = await post(`/api/browser-session/${sessionId}/computer/press-key`, {
        keys: ['a'],
      });
      assert(
        keypress.supported === true && keypress.pressed === true,
        'Browser Use keyboard route was not supported'
      );
      await post(`/api/browser-session/${sessionId}/computer/press-key`, {
        keys: ['Backspace'],
      });
      await assertRepeatedBrowserUseUploads(base, headers, sessionId, remote);
      await post(`/api/auth-assistance/${requestId}/complete`, {});
      const updatedAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
      assert(updatedAgent.status === 'ACTIVE', 'Completing handoff did not resume the agent');
      assert(
        (await prisma.steelSessionAuth.count({ where: { userId } })) === 0,
        'Browser Use handoff incorrectly created a Steel credential'
      );
    } finally {
      await remote.close();
      await viewer?.close().catch(() => {});
      viewer = null;
    }

    await post('/api/browser-session/close', {
      session_id: sessionId,
      pause: true,
      current_url: 'https://example.com',
    });
    const resumed = await post('/api/browser-session/resume', { task_id: taskId });
    resumedSessionId = String(resumed.session_id);
    assert(resumedSessionId !== sessionId, 'Resume reused the stopped remote browser');
    assert(
      asRecord(resumed.browser_session_metadata).profile_id === profileId,
      'Resume changed the persistent Browser Use profile'
    );
    const next = await chromium.connectOverCDP(String(resumed.ws_url));
    try {
      const context = next.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
      assert(
        await page.evaluate(() => document.cookie.includes('rose_handoff=signed-in')),
        'Signed-in cookie did not survive immediate pause/resume'
      );
      assert(
        (await page.evaluate(() => localStorage.getItem('rose_handoff'))) === 'signed-in',
        'Signed-in local storage did not survive immediate pause/resume'
      );
    } finally {
      await next.close();
    }
    const previousFlag = process.env.BROWSER_AGENT_BROWSER_USE_ENABLED;
    process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = 'false';
    try {
      const fallback = await resumeSession(taskId);
      kernelSessionId = fallback.sessionId;
      assert(fallback.provider === 'kernel', 'Rollout switch did not resume on Kernel');
      assert(fallback.profileId !== profileId, 'Kernel reused a Browser Use profile ID');
      const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
      assert(row.provider === 'kernel', 'Resumed browser row did not move to Kernel');
      const kernelBrowser = await chromium.connectOverCDP(fallback.wsUrl);
      await kernelBrowser.close();
    } finally {
      if (previousFlag === undefined) delete process.env.BROWSER_AGENT_BROWSER_USE_ENABLED;
      else process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = previousFlag;
    }
    console.log(
      'PASS live Browser Use handoff, profile reuse, repeated uploads, and Kernel kill switch'
    );
  } finally {
    await viewer?.close().catch(() => {});
    for (const id of [sessionId, resumedSessionId]) {
      if (id) await releaseBrowserUseRemoteSession(id).catch(() => {});
    }
    if (kernelSessionId) await releaseKernelRemoteSession(kernelSessionId).catch(() => {});
    if (profileId) {
      await fetch(`https://api.browser-use.com/api/v4/profiles/${encodeURIComponent(profileId)}`, {
        method: 'DELETE',
        headers: { 'X-Browser-Use-API-Key': providerKey },
      }).catch(() => {});
    }
    await prisma.agentAttentionRequest.deleteMany({ where: { userId } });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}
