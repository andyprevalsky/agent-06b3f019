import {
  BASE_URL,
  request,
  authHeaders,
  ctx,
  assertStatus,
  assertSchema,
} from './integrations.context';
import { ErrorResponse } from './integrations.schemas';

export async function testErrorSurface_404sHaveErrorField() {
  const endpoints = [
    {
      url: `${BASE_URL}/api/integrations/nonexistent_${Date.now()}`,
      method: 'PATCH' as const,
      body: JSON.stringify({}),
    },
    {
      url: `${BASE_URL}/api/integrations/nonexistent_${Date.now()}`,
      method: 'DELETE' as const,
    },
  ];

  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const res = await request(ep.url, {
        method: ep.method,
        body: ep.body,
        headers: authHeaders(ctx.accessToken1!),
      });
      return { ep, res };
    })
  );

  for (const { res } of results) {
    assertStatus(res.status, 404, res.data);
    assertSchema(ErrorResponse, res.data, 'error surface 404');
  }
}
