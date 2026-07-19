/**
 * Agents domain config — env access lives here per the domain config.ts rule.
 */

/** Read a {{VAR_NAME}} prompt secret from its PROMPT_SECRET_* env var. */
export function getPromptSecret(varName: string): string | undefined {
  return process.env[`PROMPT_SECRET_${varName}`];
}

/**
 * The internal backend key that benchmark/eval runners echo in the X-Benchmark-Run
 * header to mark a created agent as a benchmark run (see routes.guards.ts →
 * isBenchmarkRequest). Read here per the domain config.ts env-access rule.
 */
export function getBenchmarkRunSecret(): string | undefined {
  const key = process.env.BACKEND_API_KEY;
  return key !== undefined && key !== '' ? key : undefined;
}
