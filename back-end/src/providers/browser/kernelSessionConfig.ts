export function readOnlyLiveView(url: string | undefined): string {
  if (!url) return '';
  const parsed = new URL(url);
  parsed.searchParams.set('readOnly', 'true');
  return parsed.toString();
}

export function kernelTimeoutSeconds(): number {
  const parsed = Number.parseInt(process.env.KERNEL_TIMEOUT_SECONDS ?? '900', 10);
  return Number.isFinite(parsed) ? Math.min(259_200, Math.max(10, parsed)) : 900;
}
