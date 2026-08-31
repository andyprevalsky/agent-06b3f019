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

/** Cursor API key used to spawn cloud RCA agents from Report Bug. */
export function getCursorApiKey(): string | undefined {
  const key = process.env.CURSOR_API_KEY;
  return key !== undefined && key !== '' ? key : undefined;
}

/** Cursor Cloud Agents API base (no trailing slash required). */
export function getCursorApiBaseUrl(): string {
  const base = process.env.CURSOR_API_BASE_URL;
  return base !== undefined && base !== '' ? base : 'https://api.cursor.com/v1';
}

/**
 * Named Cursor-hosted environment for Report Bug cloud agents.
 * Prefer the named env over raw repos so RCA agents inherit secrets/setup.
 */
export function getCursorCloudEnvName(): string {
  const name = process.env.CURSOR_CLOUD_ENV_NAME;
  return name !== undefined && name !== '' ? name : 'rose-ai-labs/rose';
}

/**
 * GitHub repo used to @cursor-launch Report Bug agents (source:scm).
 * API launches are source:api and hidden by default in the mobile inbox.
 */
export function getCursorBugReportGithubRepo(): string {
  const repo = process.env.CURSOR_BUG_REPORT_GITHUB_REPO ?? process.env.GITHUB_DISPATCH_REPO;
  return repo !== undefined && repo !== '' ? repo : 'Rose-Ai-Labs/rose';
}

/** True when at least one GitHub token can create issues for scm launch. */
export function hasGithubIssueLaunchToken(): boolean {
  const tokens = [process.env.GITHUB_TOKEN ?? '', process.env.GITHUB_DISPATCH_TOKEN ?? ''];
  return tokens.some((t) => t.trim() !== '');
}
