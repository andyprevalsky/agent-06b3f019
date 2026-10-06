import https from 'node:https';
import { retryWithBackoff } from '../retry';

export async function releaseKernelRemoteSession(sessionId: string): Promise<void> {
  await retryWithBackoff(
    async () => {
      const apiKey = process.env.KERNEL_API_KEY?.trim();
      if (!apiKey) throw new Error('KERNEL_API_KEY is required to delete Kernel sessions');
      const baseUrl = (process.env.KERNEL_API_BASE_URL ?? 'https://api.onkernel.com').replace(
        /\/$/,
        ''
      );
      const url = new URL(`${baseUrl}/browsers/${encodeURIComponent(sessionId)}`);
      const statusCode = await new Promise<number>((resolve, reject) => {
        const request = https.request(
          url,
          { method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` } },
          (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode ?? 0));
          }
        );
        request.setTimeout(10_000, () => {
          request.destroy(new Error('Kernel session delete timed out'));
        });
        request.once('error', reject);
        request.end();
      });
      if (statusCode !== 204 && statusCode !== 404) {
        throw new Error(`Kernel session delete failed: HTTP ${statusCode}`);
      }
    },
    {
      maxRetries: 3,
      fixedDelays: [250, 500],
      isRetryable: () => true,
      component: 'Kernel session delete',
    }
  );
}
