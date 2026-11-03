/** Read-only deployment check; never invokes a provider, mark, reset or lease. */
import assert from 'assert';
import {
  checkReadOnlyAuthority,
  runDeployAuthorityReadiness,
} from '../../../scripts/check-compute-authority';
import { foundryRegions } from '../../providers/rose/foundry';

export async function runReadOnlyProductionAuthority() {
  assert(
    process.env.COMPUTE_TOKEN_AUTHORITY_URL === 'https://navi-j9a9.onrender.com',
    'Read-only production check requires the explicit production authority origin'
  );
  const keys = [
    ...new Set(
      foundryRegions().flatMap((region) =>
        region.deployments.map((deployment) => `${region.host}:${deployment}`)
      )
    ),
  ];
  const result = await checkReadOnlyAuthority(keys);
  console.log(
    JSON.stringify({
      check: 'compute-token-authority-readonly',
      observedAt: new Date().toISOString(),
      ...result,
      lockingProved: false,
    })
  );
}

export async function testReadOnlyAuthority() {
  const url = process.env.COMPUTE_TOKEN_AUTHORITY_URL;
  const key = process.env.COMPUTE_TOKEN_AUTHORITY_API_KEY;
  const realFetch = global.fetch;
  process.env.COMPUTE_TOKEN_AUTHORITY_URL = 'https://authority.example.test';
  process.env.COMPUTE_TOKEN_AUTHORITY_API_KEY = 'readonly-fixture';
  const keys = ['region.example.test:deployment'];
  let body: unknown = { cooldowns: {} };
  global.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
  try {
    assert.strictEqual((await checkReadOnlyAuthority(keys)).evidence, 'route-only-no-rows');
    body = {
      cooldowns: {
        [keys[0]]: {
          strikes: 1,
          remainingSeconds: 90,
          rateLimitedUntil: '2030-01-01T00:00:00.000Z',
        },
      },
    };
    assert.strictEqual((await checkReadOnlyAuthority(keys)).returnedRows, 1);
    body = { cooldowns: { [keys[0]]: { strikes: 1, rateLimitedUntil: null } } };
    await assert.rejects(checkReadOnlyAuthority(keys), /Invalid Foundry cooldown state/);
    body = { cooldowns: [] };
    await assert.rejects(checkReadOnlyAuthority(keys), /Invalid Foundry cooldown envelope/);
    await assert.rejects(checkReadOnlyAuthority(['bad/key']), /Invalid configured deployment key/);
    global.fetch = async () => new Response('', { status: 404 });
    await assert.rejects(checkReadOnlyAuthority(keys), /returned 404/);
    const backendUrl = process.env.BACKEND_API_URL;
    const backendKey = process.env.BACKEND_API_KEY;
    try {
      process.env.BACKEND_API_URL = 'https://authority.example.test';
      process.env.BACKEND_API_KEY = 'readonly-fixture';
      global.fetch = async (_input, init) => {
        assert(
          init?.signal instanceof AbortSignal,
          'Authority request must have its existing deadline'
        );
        assert.strictEqual(init?.method, 'GET');
        assert.strictEqual(init?.body, undefined);
        return new Response(JSON.stringify({ cooldowns: {} }), { status: 200 });
      };
      assert.strictEqual(
        (await runDeployAuthorityReadiness()).evidence,
        'route-only-readiness-key'
      );
      assert.strictEqual(process.env.COMPUTE_TOKEN_AUTHORITY_URL, 'https://authority.example.test');
      for (const status of [401, 403, 404, 500]) {
        global.fetch = async () => new Response('', { status });
        await assert.rejects(runDeployAuthorityReadiness(), new RegExp(`returned ${status}`));
      }
      global.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
      await assert.rejects(runDeployAuthorityReadiness(), /Invalid Foundry cooldown envelope/);
      global.fetch = async () => {
        throw new Error('fixture timeout');
      };
      await assert.rejects(runDeployAuthorityReadiness(), /fixture timeout/);
      process.env.BACKEND_API_URL = 'https://authority.example.test/path';
      await assert.rejects(runDeployAuthorityReadiness(), /must be an origin/);
      process.env.BACKEND_API_URL = 'http://authority.example.test';
      await assert.rejects(runDeployAuthorityReadiness(), /must use HTTPS/);
      process.env.BACKEND_API_KEY = '';
      await assert.rejects(runDeployAuthorityReadiness(), /Deployment requires/);
    } finally {
      if (backendUrl === undefined) delete process.env.BACKEND_API_URL;
      else process.env.BACKEND_API_URL = backendUrl;
      if (backendKey === undefined) delete process.env.BACKEND_API_KEY;
      else process.env.BACKEND_API_KEY = backendKey;
    }
    console.log(
      'PASS read-only authority check and deployment precondition: route-only, auth, malformed, timeout'
    );
  } finally {
    global.fetch = realFetch;
    if (url === undefined) delete process.env.COMPUTE_TOKEN_AUTHORITY_URL;
    else process.env.COMPUTE_TOKEN_AUTHORITY_URL = url;
    if (key === undefined) delete process.env.COMPUTE_TOKEN_AUTHORITY_API_KEY;
    else process.env.COMPUTE_TOKEN_AUTHORITY_API_KEY = key;
  }
}
