export async function withOwnedResumeTransport<T>(
  transport: { validationBrowser?: { close(): Promise<unknown> } },
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } finally {
    await transport.validationBrowser?.close().catch(() => {});
  }
}
