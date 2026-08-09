import { ROTATION_CAP, selectRotationStep } from '../../providers/browser/rotation';
import { retryWithBackoff } from '../../providers/retry';

interface RotationResponse {
  task_id?: string;
  session_id?: string;
  ws_url?: string;
  saved_url?: string;
  provider?: string;
  proxy_tier?: string;
  rotations_used?: number;
  rotations_remaining?: number;
  previous_provider?: string;
  recovery_action?: string;
  next_recovery?: string;
  browser_session_metadata?: { provider?: string; steel_profile_id?: string };
}

interface CrossProviderLadderOptions {
  baseUrl: string;
  headers: Record<string, string>;
  taskId: string;
  currentKernelSessionId: string;
  mobileIp: string;
  post: (path: string, body?: unknown) => Promise<RotationResponse>;
  readDifferentExitIp: (wsUrl: string, previousIp: string) => Promise<string>;
  retrieveKernelBrowser: (sessionId: string) => Promise<{ deleted_at?: string | Date | null }>;
  retrieveSteelBrowser: (sessionId: string) => Promise<{ status?: string }>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertFixedRotationLadder(): void {
  assert(ROTATION_CAP === 4, 'rotation cap must remain four recovery actions');
  const steps = [
    selectRotationStep(1, 'kernel'),
    selectRotationStep(2, 'kernel'),
    selectRotationStep(3, 'kernel'),
    selectRotationStep(4, 'steel'),
  ];
  assert(
    JSON.stringify(steps) ===
      JSON.stringify([
        { provider: 'kernel', proxyType: 'residential', recoveryAction: 'ip_rotated' },
        { provider: 'kernel', proxyType: 'mobile', recoveryAction: 'ip_rotated' },
        { provider: 'steel', proxyType: 'residential', recoveryAction: 'provider_switched' },
        { provider: 'steel', proxyType: 'residential', recoveryAction: 'ip_rotated' },
      ]),
    `unexpected rotation ladder: ${JSON.stringify(steps)}`
  );
}

export async function deleteKernelResource(path: string): Promise<void> {
  const apiKey = process.env.KERNEL_API_KEY?.trim();
  if (!apiKey) return;
  const response = await fetch(`https://api.onkernel.com${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (response.status !== 204 && response.status !== 404) {
    throw new Error(`Kernel cleanup failed for ${path}: HTTP ${response.status}`);
  }
}

/** Exercise calls 3-5 after the caller has proven Kernel residential/mobile. */
export async function runCrossProviderRotationLadder(
  options: CrossProviderLadderOptions
): Promise<{ finalSessionId: string; firstSteelIp: string; secondSteelIp: string }> {
  const {
    baseUrl,
    headers,
    taskId,
    currentKernelSessionId,
    mobileIp,
    post,
    readDifferentExitIp,
    retrieveKernelBrowser,
    retrieveSteelBrowser,
  } = options;

  // Steel create is flaky under parallel blackbox load; retry the Kernel→Steel
  // switch on transient connection failures (server already retries create).
  const postWithSteelConnectionRetry = async (
    path: string,
    body?: unknown
  ): Promise<RotationResponse> =>
    retryWithBackoff(() => post(path, body), {
      maxRetries: 3,
      fixedDelays: [1_000, 2_000],
      isRetryable: (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return (
          message.includes('Failed to create Steel replacement') ||
          message.includes('Connection error')
        );
      },
      component: 'browser-provider:steel-switch',
    });

  const switched = await postWithSteelConnectionRetry('/rotate-proxy', {
    task_id: taskId,
    current_url: 'https://example.com/provider-switch-check',
  });
  assert(switched.task_id === taskId, 'provider switch changed the stable task ID');
  assert(
    switched.provider === 'steel' && switched.proxy_tier === 'residential',
    `call 3 expected Steel residential, got ${switched.provider}/${switched.proxy_tier}`
  );
  assert(
    switched.previous_provider === 'kernel' && switched.recovery_action === 'provider_switched',
    'call 3 did not report the Kernel-to-Steel provider switch'
  );
  assert(
    switched.rotations_used === 3 &&
      switched.rotations_remaining === 1 &&
      switched.next_recovery === 'rotate_steel_residential_ip',
    'call 3 returned the wrong counters or next recovery'
  );
  assert(
    switched.saved_url === 'https://example.com/provider-switch-check',
    'provider switch lost the current URL supplied by the browser worker'
  );
  assert(
    switched.browser_session_metadata?.provider === 'steel' &&
      Boolean(switched.browser_session_metadata.steel_profile_id),
    'provider switch omitted Steel session metadata'
  );
  assert(
    switched.session_id !== undefined && switched.session_id !== currentKernelSessionId,
    'provider switch did not allocate a new Steel session'
  );

  const evictedKernel = await retrieveKernelBrowser(currentKernelSessionId);
  assert(Boolean(evictedKernel.deleted_at), 'provider switch leaked the superseded Kernel session');
  const firstSteelIp = await readDifferentExitIp(String(switched.ws_url), mobileIp);

  const steelRotated = await post('/rotate-proxy', {
    task_id: taskId,
    current_url: 'https://example.com/steel-rotation-check',
  });
  assert(
    steelRotated.provider === 'steel' && steelRotated.proxy_tier === 'residential',
    'call 4 must remain on Steel residential'
  );
  assert(
    steelRotated.previous_provider === 'steel' && steelRotated.recovery_action === 'ip_rotated',
    'call 4 incorrectly reported another provider switch'
  );
  assert(
    steelRotated.rotations_used === 4 &&
      steelRotated.rotations_remaining === 0 &&
      steelRotated.next_recovery === 'rotation_budget_exhausted',
    'call 4 returned the wrong final rotation state'
  );
  assert(
    steelRotated.session_id !== undefined && steelRotated.session_id !== switched.session_id,
    'call 4 did not allocate another Steel session'
  );
  const supersededSteelStatus = await retryWithBackoff(
    async () => {
      const status = String((await retrieveSteelBrowser(String(switched.session_id))).status);
      if (status !== 'released') throw new Error(`Steel session remains ${status}`);
      return status;
    },
    {
      maxRetries: 5,
      fixedDelays: [200, 400, 600, 800],
      isRetryable: () => true,
      component: 'browser-provider superseded Steel release',
    }
  );
  assert(
    supersededSteelStatus === 'released',
    `call 4 leaked the superseded Steel session (status=${supersededSteelStatus})`
  );
  const secondSteelIp = await readDifferentExitIp(String(steelRotated.ws_url), firstSteelIp);

  const exhaustedResponse = await fetch(`${baseUrl}/api/browser-session/rotate-proxy`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ task_id: taskId }),
  });
  assert(
    exhaustedResponse.status === 409,
    `expected 409 after four real recoveries, got ${exhaustedResponse.status}`
  );
  const exhaustedBody = (await exhaustedResponse.json()) as { error?: string; message?: string };
  assert(
    exhaustedBody.error === 'proxy_rotation_exhausted' &&
      String(exhaustedBody.message).includes('PROXY_ROTATION_EXHAUSTED'),
    'exhaustion response missing the structured error the agent reads'
  );

  return {
    finalSessionId: String(steelRotated.session_id),
    firstSteelIp,
    secondSteelIp,
  };
}
