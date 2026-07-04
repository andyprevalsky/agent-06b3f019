/**
 * Agents domain config — env access lives here per the domain config.ts rule.
 */

/** Read a {{VAR_NAME}} prompt secret from its PROMPT_SECRET_* env var. */
export function getPromptSecret(varName: string): string | undefined {
  return process.env[`PROMPT_SECRET_${varName}`];
}
