/**
 * "Set up with your coding agent": the prompt a user pastes into Claude Code,
 * Codex or another coding agent in their project folder. Wording mirrors
 * boxes.dev's setup prompt exactly, with Rose's CLI package and bin. The
 * package and bin must match scripts/lib/rose-sync/package.json (cemented by
 * back-end/src/tests/blackbox/repo-onboarding.blackbox.ts).
 */

export const ROSE_CLI_PACKAGE = '@roselabs.ai/cli';
export const ROSE_CLI_BIN = 'rose';

export function agentInitPrompt(code: string): string {
  return (
    `Install the Rose CLI with \`npm i -g ${ROSE_CLI_PACKAGE}\`, then set up this project on Rose ` +
    `by running \`${ROSE_CLI_BIN} agent-init --login-code ${code}\` and following its instructions. ` +
    'Run these commands yourself and ask for my approval when needed.'
  );
}
