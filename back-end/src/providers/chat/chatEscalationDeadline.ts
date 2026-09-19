/**
 * Bound the persist half of chat → Temporal escalation.
 *
 * handleChatMessage is fire-and-forget. If createMessage hangs after the router
 * chooses start_superintelligence, the catch that fails the agent never runs and
 * the row stays ACTIVE with a null workflow forever. Race the persist against a
 * deadline so that path rejects and the existing failAgentIfStillActive hook can
 * fire. Temporal start stays outside this helper — acceptance already has its
 * own reject/terminate path.
 */

export const CHAT_ESCALATION_DEADLINE_MS = 30_000;

export async function withChatEscalationDeadline<T>(
  work: () => Promise<T>,
  timeoutMs: number = CHAT_ESCALATION_DEADLINE_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Chat escalation exceeded ${timeoutMs}ms without starting a workflow`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
