import { overlayCodexCodeWsServer } from '../../providers/e2bWsServerOverlay';

/**
 * The E2B template ID names a remote image, not the local source directory.
 * Both the default and a custom image ID must upload the current local server.
 */
export async function testCodexWsServerOverlayUsesLocalSource(): Promise<void> {
  const previousTemplateId = process.env.E2B_CODEX_CODE_TEMPLATE_ID;
  try {
    for (const templateId of [undefined, 'remote-codex-image-id']) {
      if (templateId === undefined) delete process.env.E2B_CODEX_CODE_TEMPLATE_ID;
      else process.env.E2B_CODEX_CODE_TEMPLATE_ID = templateId;

      const writes: Array<{ path: string; source: string }> = [];
      const sandbox = {
        files: {
          write: async (path: string, blob: Blob) => {
            writes.push({ path, source: await blob.text() });
          },
        },
        commands: { run: async () => ({ exitCode: 0 }) },
      } as unknown as Parameters<typeof overlayCodexCodeWsServer>[0];
      await overlayCodexCodeWsServer(sandbox);
      // The Azure model catalog travels with the ws-server that reads it.
      const catalog = writes.find((write) => write.path === '/home/user/azure-model-catalog.json');
      if (
        catalog === undefined ||
        !(JSON.parse(catalog.source) as { models: { slug: string }[] }).models.some(
          (model) => model.slug === 'gpt-6.1-sol'
        )
      ) {
        throw new Error('the Azure Codex model catalog was not overlaid next to ws-server.mjs');
      }
      if (
        writes.length !== 2 ||
        writes[0].path !== '/home/user/ws-server.mjs' ||
        !writes[0].source.includes('oauthFallbackReason') ||
        !writes[0].source.includes('refresh_token_invalidated')
      ) {
        throw new Error(
          `Codex ws-server fallback source was not overlaid for template ${templateId ?? '<default>'}`
        );
      }
    }
  } finally {
    if (previousTemplateId === undefined) delete process.env.E2B_CODEX_CODE_TEMPLATE_ID;
    else process.env.E2B_CODEX_CODE_TEMPLATE_ID = previousTemplateId;
  }
}
