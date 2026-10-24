/**
 * The Codex E2B template this backend's ws-server overlay needs. The overlay is
 * written against one Codex CLI app-server protocol, so the template that ships
 * that CLI is versioned with it: a Codex CLI bump builds a NEW template
 * (e2b-templates/build-template-version.mjs) and moves this default, never
 * rebuilding the shared `codex-code` alias that older deploys still resolve.
 * codex-template-contract.case.ts fails when this, the Dockerfile pin and the
 * alias disagree.
 */
export const CODEX_CODE_TEMPLATE = {
  alias: 'codex-code-v0159',
  codexVersion: '0.159.0',
} as const;

export const DEFAULT_CODEX_CODE_TEMPLATE_ID = CODEX_CODE_TEMPLATE.alias;
