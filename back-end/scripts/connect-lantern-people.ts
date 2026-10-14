#!/usr/bin/env tsx
/** Import a dedicated official Lantern login into Rose's encrypted credential store. */
import { config } from 'dotenv';
import { createPublicKey } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { encryptPasswordForStorage } from '../src/providers/credentialEnvelope';

config();

async function main() {
  const { values } = parseArgs({
    options: {
      backend: { type: 'string' },
      'user-id': { type: 'string' },
      'connection-file': { type: 'string' },
    },
  });
  if (!values.backend || !values['user-id']) {
    throw new Error('Specify --backend and --user-id for the intended Rose account.');
  }
  const backend = new URL(values.backend);
  if (
    backend.username ||
    backend.password ||
    backend.search ||
    backend.hash ||
    backend.pathname !== '/' ||
    !(
      backend.protocol === 'https:' ||
      (backend.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(backend.hostname))
    )
  ) {
    throw new Error('Use an HTTPS backend origin or local development origin.');
  }
  const path =
    values['connection-file'] ??
    join(homedir(), '.config', 'people-infra-rose-workers', 'connection.json');
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 65536 ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  ) {
    throw new Error('The dedicated connection must be a private, owned regular file.');
  }
  const stored = JSON.parse(readFileSync(path, 'utf8')) as {
    version?: unknown;
    protection?: unknown;
    connection?: unknown;
  };
  if (stored.version !== 1 || stored.protection !== 'owner-only-file' || !stored.connection) {
    throw new Error('Use the official dedicated server login connection file.');
  }
  const privateKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  const apiKey = process.env.BACKEND_API_KEY;
  if (!privateKey || !apiKey)
    throw new Error('Backend credential encryption and authentication must be configured.');
  const publicKey = createPublicKey(Buffer.from(privateKey, 'base64').toString('utf8'))
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const encryptedCredentials = encryptPasswordForStorage(
    JSON.stringify(stored.connection),
    publicKey
  );
  const response = await fetch(
    backend.origin + '/api/integrations/lantern-people/credentials/upload',
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'X-User-Id': values['user-id'],
      },
      body: JSON.stringify({ encryptedCredentials }),
    }
  );
  if (!response.ok)
    throw new Error(
      `Rose rejected the connection (HTTP ${response.status}). Check backend configuration and the dedicated login.`
    );
  const result = (await response.json()) as {
    connected?: unknown;
    connectionId?: unknown;
    expiresAt?: unknown;
  };
  if (result.connected !== true) throw new Error('Rose did not confirm the connection.');
  process.stdout.write(
    JSON.stringify({
      connected: true,
      userId: values['user-id'],
      connectionId: result.connectionId,
      expiresAt: result.expiresAt,
    }) + '\n'
  );
}

void main().catch(() => {
  process.stderr.write(
    'Could not import the dedicated Lantern connection. Check the login file, explicit backend/user, and encryption configuration. No credentials were printed.\n'
  );
  process.exitCode = 1;
});
