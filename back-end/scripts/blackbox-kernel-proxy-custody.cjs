'use strict';

// Loaded only by the isolated blackbox backend. Live tests may reuse shared
// Kernel proxies, but cannot allocate new project-wide proxy resources.
// Browsers and profiles are per-test resources that the live blackbox fixtures
// create and then release/delete in their own cleanup, so the default policy
// refuses only proxy creates. Cloud benchmark guests have no such cleanup and
// opt into refusing all three kinds with ROSE_KERNEL_ALL_RESOURCE_CUSTODY=1.
function allResourceCustody() {
  return process.env.ROSE_KERNEL_ALL_RESOURCE_CUSTODY === '1';
}

function isKernelProxyCreate(input, init, allResources = allResourceCustody()) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const origins = ['https://api.onkernel.com', 'https://api.kernel.sh'];
  for (const configured of [process.env.KERNEL_BASE_URL, process.env.KERNEL_API_BASE_URL]) {
    if (configured) origins.push(configured.replace(/\/+$/, ''));
  }
  const resources = allResources ? ['proxies', 'browsers', 'profiles'] : ['proxies'];
  const endpoints = origins.flatMap((origin) => resources.map((resource) => `${origin}/${resource}`));
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
  return (
    method === 'POST' &&
    endpoints.some((endpoint) => {
      const expected = new URL(endpoint);
      return (
        url.origin === expected.origin && url.pathname.replace(/\/$/, '') === expected.pathname
      );
    })
  );
}

function installKernelProxyCustody(originalFetch = globalThis.fetch) {
  const allResources = allResourceCustody();
  globalThis.fetch = async (input, init) => {
    if (isKernelProxyCreate(input, init, allResources)) {
      return new Response(
        JSON.stringify({
          message:
            'Blackbox proxy reuse required: no existing matching Kernel proxy was available. ' +
            (allResources
              ? 'New Kernel proxies, browsers and profiles are not provisioned by tests.'
              : 'New shared Kernel proxies are not provisioned by tests.'),
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }
      );
    }
    return originalFetch(input, init);
  };
  globalThis[Symbol.for('rose.test.kernelProxyCustody')] = true;
  globalThis[Symbol.for('rose.test.kernelResourceCustody')] = allResources;
}

installKernelProxyCustody();
module.exports = { isKernelProxyCreate, installKernelProxyCustody };
