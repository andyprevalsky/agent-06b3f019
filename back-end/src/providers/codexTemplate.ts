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
  sizedAliasPrefix: 'codex-code-v0159-node22234',
  alias: 'codex-code-v0159-node22234-c2-m4',
  codexVersion: '0.159.0',
  nodeVersion: '22.23.4',
} as const;

export const DEFAULT_CODEX_CODE_TEMPLATE_ID = CODEX_CODE_TEMPLATE.alias;

/**
 * Priority processing: the Codex catalog's "Fast" tier on ChatGPT plans and
 * Azure OpenAI's only faster tier (Azure has no fast / ultrafast). A Fast or
 * Ultrafast agent requests it on Azure; a standard agent requests nothing.
 */
export const CODEX_AZURE_SERVICE_TIER = 'priority';

/**
 * Codex model catalog for the funded Azure provider (model_catalog_json).
 * Codex 0.159.0 bundles no gpt-6.1-sol metadata, so without it the CLI falls
 * back to generic metadata that drops the priority tier and reasoning effort.
 * The entry is the gpt-6.1-sol entry of the Codex release catalog
 * (codex-rs/models-manager/models.json, openai/codex f8bfbc45a), which
 * advertises only `priority`. It sits next to ws-server.mjs in the template
 * and in the overlay.
 */
export const CODEX_AZURE_MODEL_CATALOG_FILE = 'azure-model-catalog.json';
