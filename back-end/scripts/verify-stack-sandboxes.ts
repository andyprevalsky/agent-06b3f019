import type { SandboxReaperDeps } from '../src/providers/codeSessions/sandboxReaper';

/** Read-only post-teardown evidence; bounded scans never certify an unseen tail. */
export async function verifyStackSandboxes(
  roseStack: string,
  list: SandboxReaperDeps['list']
): Promise<{ roseStack: string; verified: boolean; remaining: string[] }> {
  const remaining: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await list({ roseStack }, 100, cursor);
    remaining.push(
      ...page.items
        .filter((item) => item.metadata.roseStack === roseStack)
        .map((item) => item.sandboxId)
    );
    pages += 1;
    cursor = page.nextCursor;
  } while (cursor !== null && pages < 10);
  return { roseStack, verified: cursor === null && remaining.length === 0, remaining };
}
