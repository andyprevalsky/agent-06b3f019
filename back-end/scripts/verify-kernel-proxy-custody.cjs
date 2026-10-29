'use strict';

// Fail before running live tests against a backend without the allocation guard.
async function verifyKernelProxyCustody(baseUrl) {
  const response = await fetch(new URL('/health', baseUrl), {
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok || response.headers.get('x-rose-kernel-proxy-custody') !== 'enforced-v1') {
    throw new Error('Existing blackbox backend must preload blackbox-kernel-proxy-custody.cjs');
  }
  await response.arrayBuffer();
}

module.exports = { verifyKernelProxyCustody };
if (require.main === module) {
  verifyKernelProxyCustody(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
