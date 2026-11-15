/**
 * The trace archive is append-only: a bundle is deleted ONLY when a user
 * explicitly asked for it (Andy, 2026-11-13). No automated job may delete.
 */
export interface ArchiveDeletionRequest {
  userRequested: true;
  /** Who asked (user id or name). */
  requestedBy: string;
  /** The user's stated reason / ticket. */
  reason: string;
}

export function assertUserRequestedDeletion(request: unknown): ArchiveDeletionRequest {
  const value = request as Partial<ArchiveDeletionRequest> | null | undefined;
  if (
    value?.userRequested !== true ||
    typeof value.requestedBy !== 'string' ||
    value.requestedBy.trim() === '' ||
    typeof value.reason !== 'string' ||
    value.reason.trim() === ''
  ) {
    throw new Error(
      'Trace archive deletion refused: bundles are deleted only on an explicit user request ' +
        '({ userRequested: true, requestedBy, reason })'
    );
  }
  return value as ArchiveDeletionRequest;
}
