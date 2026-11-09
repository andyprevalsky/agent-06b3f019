'use strict';

// Fail before running live tests against a backend without the allocation guard.
async function verifyKernelProxyCustody(baseUrl, requireAllResources = false) {
  const response = await fetch(new URL('/health', baseUrl), {
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok || response.headers.get('x-rose-kernel-proxy-custody') !== 'enforced-v1') {
    throw new Error('Existing blackbox backend must preload blackbox-kernel-proxy-custody.cjs');
  }
  if (requireAllResources && response.headers.get('x-rose-kernel-resource-custody') !== 'enforced-v1') {
    throw new Error('Existing cloud backend must enforce Kernel browser/profile/proxy allocation custody');
  }
  await response.arrayBuffer();
}

module.exports = { verifyKernelProxyCustody };
if (require.main === module) {
  verifyKernelProxyCustody(process.argv[2], process.argv.includes('--all-resources')).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
