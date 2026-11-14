/** Live custody checks reuse the existing shared proxy; never create or delete it. */
import type { Kernel } from '@onkernel/sdk';
import {
  assert,
  type BrowserApiResponse,
  type BrowserMetadataResponse,
} from './browser-provider.helpers';

export async function assertResumeReusesExistingProxy(options: {
  kernel: Kernel;
  taskId: string;
  sessionId: string;
  proxySource: string | undefined;
  proxyLocation: BrowserMetadataResponse['proxy_location'];
  post: (path: string, body?: unknown) => Promise<BrowserApiResponse>;
}): Promise<string> {
  const { kernel, taskId, sessionId, proxySource, proxyLocation, post } = options;
  const before = await kernel.browsers.retrieve(sessionId, { include_deleted: true });
  assert(
    typeof before.proxy_id === 'string' && before.proxy_id !== '',
    'live browser must name its existing proxy'
  );
  await post('/close', {
    session_id: sessionId,
    pause: true,
    current_url: 'https://example.com/proxy-reuse-check',
  });
  const resumed = await post('/resume', { task_id: taskId });
  const resumedId = String(resumed.session_id);
  try {
    const metadata = resumed.browser_session_metadata ?? {};
    assert(
      metadata.proxy_source === proxySource &&
        JSON.stringify(metadata.proxy_location) === JSON.stringify(proxyLocation),
      'resume changed the existing proxy tier or location'
    );
    const after = await kernel.browsers.retrieve(resumedId, { include_deleted: true });
    assert(after.proxy_id === before.proxy_id, 'resume must reuse the existing shared proxy');
  } catch (error) {
    // The caller cannot learn this replacement ID on a failed assertion.
    // Close only the exact browser created by this leg; shared proxies stay intact.
    await post('/close', { session_id: resumedId, pause: false }).catch(() => {});
    throw error;
  }
  return resumedId;
}
