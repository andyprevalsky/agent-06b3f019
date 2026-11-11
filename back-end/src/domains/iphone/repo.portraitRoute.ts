/** Caller already holds setup's device/generation lock; evidence is encrypted provider journal only. */
import { openPhoneValue } from '../../providers/phoneHarnessCredentials';
import {
  portraitRouteNext,
  portraitRouteVerdict,
  type PortraitRouteBreak,
  type PortraitRouteEvent,
} from '../../providers/phonePortraitRoute';
import type { SetupClaim } from './repo.setupCommand';
import type { SetupInput } from '../../providers/phoneSetupState';
import type { Transaction, IPhoneOperation } from './types';
const routeBreak = (stage: string, row?: { cursor: number; operation: string }) => ({
  break: {
    stage,
    cursor: row?.cursor ?? 0,
    operation: row?.operation ?? 'none',
    next: portraitRouteNext(stage),
  } satisfies PortraitRouteBreak,
});
/** The proven route, or the first journal event that broke it and the native step it expected. */
export async function currentPortraitRoute(
  tx: Transaction,
  claim: SetupClaim,
  input: SetupInput,
  now: Date
): Promise<
  { digest: string; originalAssistiveTouch: 'on' | 'off' } | { break: PortraitRouteBreak }
> {
  const attempt = claim.state.attempt;
  if (
    attempt === undefined ||
    typeof attempt.firstExecutionRunId !== 'string' ||
    attempt.firstExecutionRunId.length === 0
  )
    return routeBreak('launch');
  const rows = await tx.iPhoneOperation.findMany({
    where: {
      leaseId: claim.lease.id,
      deviceId: claim.device.id,
      cursor: { gt: attempt.floorCursor, lt: claim.command.cursor },
    },
    orderBy: { cursor: 'desc' },
    take: 64,
  });
  rows.reverse();
  let start = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i].operation === 'apps.launch') start = i;
  if (start < 0) return routeBreak('launch', rows.at(-1));
  const events: PortraitRouteEvent[] = [];
  for (const row of rows.slice(start)) {
    if (
      row.actor !== 'agent' ||
      row.state !== 'SUCCEEDED' ||
      row.providerEpoch !== claim.command.providerEpoch ||
      row.completedAt === null ||
      row.resultEncrypted === null ||
      row.createdAt.getTime() < Date.parse(attempt.floorAt) ||
      row.completedAt.getTime() < row.createdAt.getTime() ||
      row.completedAt.getTime() > now.getTime() ||
      now.getTime() - row.createdAt.getTime() > 300000
    )
      return routeBreak('launch', row);
    const event = journalEvent(row);
    if (event === null) return routeBreak('launch', row);
    events.push(event);
  }
  if (events.at(-1)?.cursor !== claim.command.cursor - 1)
    return routeBreak('cc_ready', events.at(-1));
  const verdict = portraitRouteVerdict(events, {
    attemptId: input.attemptId,
    revision: input.expectedRevision,
    firstRun: attempt.firstExecutionRunId,
    profileRevision: claim.state.profileRevision,
    now: now.getTime(),
  });
  return 'proof' in verdict ? verdict.proof : verdict;
}

function journalEvent(row: IPhoneOperation): PortraitRouteEvent | null {
  if (row.resultEncrypted === null) return null;
  const request = openPhoneValue<Record<string, unknown>>(row.requestEncrypted);
  const result = openPhoneValue<unknown>(row.resultEncrypted);
  if (row.operation === 'setup.verify') {
    const old = request.input as SetupInput | undefined;
    if (
      old === undefined ||
      old.action !== 'verify' ||
      old.verificationTarget !== 'portrait_lock' ||
      result === null ||
      typeof result !== 'object' ||
      !('success' in result) ||
      result.success !== true
    )
      return null;
    return {
      cursor: row.cursor,
      operation: row.operation,
      args: {},
      result,
      attemptId: old.attemptId,
      revision: old.expectedRevision,
      proof: request.portraitProof as PortraitRouteEvent['proof'],
    };
  }
  if (
    request.actor !== 'agent' ||
    request.operation !== row.operation ||
    request.attentionRequestId !== undefined ||
    typeof request.setupAttemptId !== 'string' ||
    !Number.isSafeInteger(request.setupRevision) ||
    request.args === null ||
    typeof request.args !== 'object' ||
    Array.isArray(request.args)
  )
    return null;
  return {
    cursor: row.cursor,
    operation: row.operation,
    args: request.args as Record<string, unknown>,
    result,
    attemptId: request.setupAttemptId,
    revision: request.setupRevision as number,
  };
}
