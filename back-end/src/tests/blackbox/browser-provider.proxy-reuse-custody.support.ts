import assert from 'node:assert/strict';
import type { Kernel } from '@onkernel/sdk';
import { assertResumeReusesExistingProxy } from './browser-provider-proxy-reuse.support';

/** Assert success and failure never allocate or delete project-wide shared proxies. */
export async function assertLiveProxyReuseCustody(): Promise<void> {
  for (const failure of ['none', 'resume', 'replacement-mismatch']) {
    const failResume = failure === 'resume';
    const posts: string[] = [];
    let reads = 0;
    const client = {
      browsers: {
        retrieve: async () => {
          reads += 1;
          return {
            proxy_id:
              failure === 'replacement-mismatch' && reads > 1 ? 'unexpected-proxy' : 'shared-proxy',
          };
        },
      },
      proxies: {
        create: async () => {
          throw new Error('must not allocate a live parity proxy');
        },
        delete: async () => {
          throw new Error('must not delete a shared parity proxy');
        },
      },
    } as unknown as Kernel;
    const run = () =>
      assertResumeReusesExistingProxy({
        kernel: client,
        taskId: 'task',
        sessionId: 'current',
        proxySource: 'kernel_mobile_state',
        proxyLocation: { country: 'US', state: 'GA' },
        post: async (path) => {
          posts.push(path);
          if (failResume && path === '/resume') throw new Error('resume failed');
          return {
            session_id: 'resumed',
            browser_session_metadata: {
              proxy_source: 'kernel_mobile_state',
              proxy_location: { country: 'US', state: 'GA' },
            },
          };
        },
      });
    if (failResume) await assert.rejects(run(), /resume failed/);
    else if (failure === 'replacement-mismatch') await assert.rejects(run(), /must reuse/);
    else assert.equal(await run(), 'resumed');
    assert.deepEqual(
      posts,
      failure === 'replacement-mismatch' ? ['/close', '/resume', '/close'] : ['/close', '/resume']
    );
    assert.equal(reads, failResume ? 1 : 2);
  }
}
