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

/** A failed restore is retryable only after its owned transport actually closes. */
export async function withAcknowledgedResumeTransport<T>(
  transport: { validationBrowser?: { close(): Promise<unknown> } },
  action: () => Promise<T>,
  acknowledgeClosed: () => void
): Promise<T> {
  let closed = transport.validationBrowser === undefined;
  try {
    return await withOwnedResumeTransport(
      {
        validationBrowser: transport.validationBrowser && {
          close: async () => {
            await transport.validationBrowser!.close();
            closed = true;
          },
        },
      },
      action
    );
  } catch (error) {
    if (closed) acknowledgeClosed();
    throw error;
  }
}
