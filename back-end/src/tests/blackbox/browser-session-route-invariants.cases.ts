/** Repeatability invariant shared with the browser-session owner. */
import assert from 'node:assert/strict';
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

export async function testNavigationRouteGuards(
  BASE_URL: string,
  apiKeyHeaders: () => Record<string, string>
) {
  const path = `${BASE_URL}/api/browser-session/task/missing/navigation`;
  assert.equal(
    (await request(path, { method: 'POST', body: JSON.stringify({ action: 'back' }) })).status,
    401
  );
  assert.equal(
    (
      await request(path, {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: JSON.stringify({ action: 'go-somewhere' }),
      })
    ).status,
    400
  );
  assert.equal(
    (
      await request(path, {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: JSON.stringify({ action: 'back' }),
      })
    ).status,
    404
  );
}
