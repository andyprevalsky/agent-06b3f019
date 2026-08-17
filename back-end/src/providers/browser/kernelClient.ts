import Kernel from '@onkernel/sdk';

export function kernelClient(): Kernel {
  const apiKey = process.env.KERNEL_API_KEY?.trim();
  if (!apiKey) throw new Error('KERNEL_API_KEY is required when BROWSER_PROVIDER=kernel');
  return new Kernel({ apiKey });
}
