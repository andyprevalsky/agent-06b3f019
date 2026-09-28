import { connectCredentialCdp } from '../../providers/steel/injectionConnection';

export async function assertCredentialCdpHandshakeRecovery(): Promise<void> {
  let attempts = 0;
  let injections = 0;
  const browser = { contexts: () => [] };
  const connected = await connectCredentialCdp(async () => {
    attempts++;
    if (attempts === 1) {
      throw new Error(
        'browserType.connectOverCDP: Timeout 15000ms exceeded.\nCall log:\n  - <ws connecting> wss://connect.steel.dev/'
      );
    }
    if (injections !== 0) throw new Error('browser state was mutated before CDP connected');
    return browser;
  });
  injections++;
  if (connected !== browser || attempts !== 2 || injections !== 1) {
    throw new Error('CDP retry failed');
  }

  for (const message of [
    'browserType.connectOverCDP: 401 Unauthorized',
    'browserType.connectOverCDP: AbortError: request cancelled',
  ]) {
    let rejectedAttempts = 0;
    let rejected = false;
    try {
      await connectCredentialCdp(async () => {
        rejectedAttempts++;
        throw new Error(message);
      });
    } catch (error) {
      rejected = error instanceof Error && error.message === message;
    }
    if (!rejected || rejectedAttempts !== 1) throw new Error(`${message} was retried or swallowed`);
  }
}
