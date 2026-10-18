/** A task-local command claims one UUID before POST; UNKNOWN recovers by GET only, never by replay. */
import { performPhoneOperation, PhoneRequestError, type PhoneOperation } from '@/lib/api/iphone';
import type { Scope } from './phoneOverlaySession';

export function recordPhoneOutcome(scope: Scope, operation: PhoneOperation) {
  scope.operation = operation;
  if (operation.status === 'FAILED' && operation.operation !== 'screen.bounds')
    scope.notice =
      operation.errorCode === 'phone_connection_not_ready'
        ? 'Phone input was not applied. No input was replayed. Wait for the phone to be ready before trying a new action.'
        : 'Phone request rejected. Check the screen before trying a new action.';
}

export async function performScopedPhoneOperation(
  scope: Scope,
  name: string,
  args: Record<string, unknown>,
  publish: (scope: Scope) => void,
) {
  const lease = scope.snapshot?.lease;
  if (!lease) return null;
  const id = crypto.randomUUID();
  if (name !== 'screen.bounds') scope.notice = '';
  // Preserve this identity even if the POST response is lost. Never resubmit the mutation.
  scope.operation = {
    id,
    cursor: scope.snapshot.cursor,
    operation: name,
    status: 'UNKNOWN',
    errorCode: null,
    result: null,
  };
  publish(scope);
  try {
    const result = await performPhoneOperation(
      lease.id,
      { operationId: id, operation: name, args, expectedCursor: scope.snapshot.cursor },
      scope.controller.signal,
    );
    recordPhoneOutcome(scope, result.operation);
    scope.snapshot.cursor = result.operation.cursor;
    return result.operation;
  } catch (error) {
    scope.bounds = null;
    if (error instanceof PhoneRequestError && error.status === 409) scope.operation = null;
    throw error;
  }
}
