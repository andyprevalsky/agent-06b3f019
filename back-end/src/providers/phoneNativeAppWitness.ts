/** Native provider bundle identity only routes a semantic assessment; it is not auth state. */
export function nativeMessagesWitness(operation: string, request: unknown, result: unknown) {
  const input = request as { args?: { name?: unknown } } | null;
  return (
    result === 'com.apple.MobileSMS' &&
    (operation === 'apps.current' ||
      (operation === 'apps.launch' && input?.args?.name === 'com.apple.MobileSMS'))
  );
}
