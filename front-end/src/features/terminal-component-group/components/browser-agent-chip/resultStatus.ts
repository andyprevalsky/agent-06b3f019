/**
 * The browser completion text leads with the task's goal, which may itself
 * mention "error" or "failed"; its explicit Status line decides when present.
 */
export function isFailedBrowserResult(text: string | undefined): boolean {
  if (!text) return false;
  const status = /^\*\*Status\*\*:[^\S\n]*(.+)$/m.exec(text)?.[1];
  if (status !== undefined) return /❌|FAILED/i.test(status);
  return /❌|FAILED|\berror\b/i.test(text);
}
