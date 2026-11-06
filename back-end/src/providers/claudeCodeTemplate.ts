/**
 * The Claude Code E2B template the backend launches at the default size. The
 * provider rejects a model the template's CLI is too old for (Opus 5.5 needs
 * >= 2.1.280), so the template is versioned with the Dockerfile's CLI pin: a
 * Claude Code CLI bump builds a NEW template (e2b-templates/build-template-version.mjs)
 * and moves this default in the same change.
 *
 * It is code, not per-environment config: a devbox env that still named the
 * May image kng6z68u1md05bfdhq47 (CLI 2.1.138) failed the real E2B smoke after
 * prod had moved on (RCA 2026-11-04-claude-e2b-template-env-drift).
 * sandbox-size-templates.test.ts fails when this and the Dockerfile pin disagree.
 */
export const CLAUDE_CODE_TEMPLATE = {
  alias: 'claude-code-v21305-c2-m4',
  claudeCodeVersion: '2.1.305',
  /** The template's fixed size; a different configured size needs its own template. */
  size: { cpu: 2, memoryGb: 4 },
} as const;

export const DEFAULT_CLAUDE_CODE_TEMPLATE_ID = CLAUDE_CODE_TEMPLATE.alias;
