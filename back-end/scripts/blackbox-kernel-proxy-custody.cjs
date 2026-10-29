'use strict';

// Loaded only by the isolated blackbox backend. Live tests may reuse shared
// Kernel proxies, but cannot allocate new project-wide proxy resources.
function isKernelProxyCreate(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const configured = process.env.KERNEL_BASE_URL;
  const hosts = new Set(['api.onkernel.com', 'api.kernel.sh']);
  if (configured) hosts.add(new URL(configured).host);
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
  return hosts.has(url.host) && /^\/proxies\/?$/.test(url.pathname) && method === 'POST';
}

function installKernelProxyCustody(originalFetch = globalThis.fetch) {
  globalThis.fetch = async (input, init) => {
    if (isKernelProxyCreate(input, init)) {
      return new Response(
        JSON.stringify({
          message:
            'Blackbox proxy reuse required: no existing matching Kernel proxy was available. New shared proxies are not provisioned by tests.',
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }
      );
    }
    return originalFetch(input, init);
  };
}

installKernelProxyCustody();
module.exports = { isKernelProxyCreate, installKernelProxyCustody };
