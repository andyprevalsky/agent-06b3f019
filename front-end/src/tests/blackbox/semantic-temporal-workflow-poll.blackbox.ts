import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForTemporalWorkflow } from '../../../tests-e2e/helpers';

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('semantic Temporal workflow polling', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('retries a warming archive index until the new live agent is visible', async () => {
    vi.stubEnv('TEST_USER_ID', 'semantic-ratchet-user');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(503, {
          error: 'Benchmark Hub archive index is warming; retry shortly',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          agent: {
            temporal_workflow_id: 'semantic-workflow-id',
            status: 'RUNNING',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(waitForTemporalWorkflow('new-agent-id', 1_000)).resolves.toBe(
      'semantic-workflow-id',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still fails immediately for a non-retryable server response', async () => {
    vi.stubEnv('TEST_USER_ID', 'semantic-ratchet-user');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, { error: 'unexpected backend failure' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(waitForTemporalWorkflow('new-agent-id', 1_000)).rejects.toThrow(
      'Temporal-start check failed: 500',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
