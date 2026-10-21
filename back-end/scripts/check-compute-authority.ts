/** Read-only deployment precondition. Uses the production cooldown client; no provider or mutation. */
import assert from 'assert';
import { readSharedFoundryCooldowns } from '../src/providers/foundryDeploymentCooldown';

export async function checkReadOnlyAuthority(keys: string[]) {
  const authority = new URL(process.env.COMPUTE_TOKEN_AUTHORITY_URL ?? '');
  assert(authority.protocol === 'https:', 'Authority must use HTTPS');
  assert(
    !authority.username && !authority.password && !authority.search && !authority.hash,
    'Authority must not contain credentials, query or fragment'
  );
  assert(authority.pathname === '/', 'Authority must be an origin');
  assert(process.env.COMPUTE_TOKEN_AUTHORITY_API_KEY?.trim(), 'Authority API key required');
  assert(keys.length > 0 && keys.length <= 64, 'Need 1–64 configured deployment keys');
  assert(
    keys.every((key) => /^[a-z0-9-]+(\.[a-z0-9-]+)+:[a-zA-Z0-9._-]{1,100}$/.test(key)),
    'Invalid configured deployment key'
  );
  const realFetch = global.fetch;
  let requests = 0;
  // Guard the real production client: no accidental future POST/provider call.
  global.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert(
      url.origin === authority.origin &&
        url.pathname === '/api/integrations/compute-code/foundry-deployment/cooldown' &&
        init?.method === 'GET' &&
        init.body === undefined,
      'Read-only check attempted a disallowed request'
    );
    requests++;
    return realFetch(input, init);
  };
  try {
    const rows = await readSharedFoundryCooldowns(keys);
    assert(
      Object.keys(rows).every((key) => keys.includes(key)),
      'Unexpected cooldown key'
    );
    assert(requests === 1, 'Expected exactly one authority GET');
    return {
      requestedKeys: keys.length,
      returnedRows: Object.keys(rows).length,
      evidence: Object.keys(rows).length
        ? 'row-envelope-and-remainingSeconds'
        : 'route-only-no-rows',
    };
  } finally {
    global.fetch = realFetch;
  }
}

// Reserved non-provider identity: CI has backend auth, not Foundry deployment secrets.
// This deliberately proves only the authenticated route/response contract.
export const DEPLOY_READINESS_KEY = 'authority-readiness.invalid:route-contract';

export async function runDeployAuthorityReadiness() {
  const url = process.env.BACKEND_API_URL?.trim();
  const key = process.env.BACKEND_API_KEY?.trim();
  assert(url && key, 'Deployment requires BACKEND_API_URL and BACKEND_API_KEY');
  const previousUrl = process.env.COMPUTE_TOKEN_AUTHORITY_URL;
  const previousKey = process.env.COMPUTE_TOKEN_AUTHORITY_API_KEY;
  // This script runs as a fresh deployment child; restore even in imported fixture calls.
  process.env.COMPUTE_TOKEN_AUTHORITY_URL = url;
  process.env.COMPUTE_TOKEN_AUTHORITY_API_KEY = key;
  try {
    const result = await checkReadOnlyAuthority([DEPLOY_READINESS_KEY]);
    return { ...result, evidence: 'route-only-readiness-key', lockingProved: false };
  } finally {
    if (previousUrl === undefined) delete process.env.COMPUTE_TOKEN_AUTHORITY_URL;
    else process.env.COMPUTE_TOKEN_AUTHORITY_URL = previousUrl;
    if (previousKey === undefined) delete process.env.COMPUTE_TOKEN_AUTHORITY_API_KEY;
    else process.env.COMPUTE_TOKEN_AUTHORITY_API_KEY = previousKey;
  }
}

if (require.main === module) {
  runDeployAuthorityReadiness()
    .then((result) =>
      process.stdout.write(
        `${JSON.stringify({ check: 'deployment-compute-authority', ...result })}\n`
      )
    )
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Authority readiness failed'}\n`
      );
      process.exitCode = 1;
    });
}
