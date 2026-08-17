import Kernel from '@onkernel/sdk';

let cached: { apiKey: string; client: Kernel } | undefined;

export function kernelClient(): Kernel {
  const apiKey = process.env.KERNEL_API_KEY?.trim();
  if (!apiKey) throw new Error('KERNEL_API_KEY is required when BROWSER_PROVIDER=kernel');
  if (cached?.apiKey !== apiKey) cached = { apiKey, client: new Kernel({ apiKey }) };
  return cached.client;
}
