export function buildUserMessageSignalValue(
  messageText: string,
  metadata: Record<string, unknown> | undefined
): string {
  const idempotencyKey = metadata?.idempotencyKey;
  if (metadata?.isResponseSchemaUpdate === true && typeof idempotencyKey === 'string') {
    return JSON.stringify({
      internal_type: 'response_schema_update',
      idempotency_key: idempotencyKey,
    });
  }
  return messageText;
}
