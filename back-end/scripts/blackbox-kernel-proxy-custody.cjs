'use strict';

// Loaded only by the isolated blackbox backend. Live tests may reuse shared
// Kernel proxies, but cannot allocate new project-wide proxy resources.
function isKernelProxyCreate(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const origins = ['https://api.onkernel.com', 'https://api.kernel.sh'];
  for (const configured of [process.env.KERNEL_BASE_URL, process.env.KERNEL_API_BASE_URL]) {
    if (configured) origins.push(configured.replace(/\/+$/, ''));
  }
  const endpoints = origins.flatMap((origin) => ['proxies', 'browsers', 'profiles'].map((resource) => `${origin}/${resource}`));
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
  globalThis.fetch = async (input, init) => {
    if (isKernelProxyCreate(input, init)) {
      return new Response(
        JSON.stringify({
          message:
            'Blackbox proxy reuse required: no existing matching Kernel proxy was available. New Kernel proxies, browsers and profiles are not provisioned by tests.',
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
  globalThis[Symbol.for('rose.test.kernelResourceCustody')] = true;
}

installKernelProxyCustody();
module.exports = { isKernelProxyCreate, installKernelProxyCustody };
