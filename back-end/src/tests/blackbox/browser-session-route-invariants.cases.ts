/** Repeatability invariant shared with the browser-session owner. */
import { request } from './browser-session-test-support';
export async function testReproducibility_threeSequential(
  BASE_URL: string,
  apiKeyHeaders: () => Record<string, string>
) {
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/browser-session/task/nonexistent`, {
      headers: apiKeyHeaders(),
    });
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1) throw new Error(`Three sequential: ${statuses.join(', ')}`);
}
