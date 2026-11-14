/** A renewable, caller-fenced publication claim stored with the CLI connection. */
import { Prisma, type IntegrationStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from './database';
import { CliIntegrationError } from './cliIntegrations';

const LEASE_MS = 90_000;
// Pre-lease publishers had no heartbeat. Allow their bounded multi-variant builds to finish.
const LEGACY_GRACE_MS = 24 * 60 * 60_000;
type Row = { config: Prisma.JsonValue; updatedAt: Date; status: IntegrationStatus };
export interface CliPublicationLeaseDependencies {
  now(): number;
  token(): string;
  every(callback: () => void, milliseconds: number): () => void;
  read(): Promise<Row>;
  swap(expected: Row, config: Prisma.InputJsonObject): Promise<boolean>;
}

export interface CliPublicationAuth {
  beginAuth(): Promise<void>;
  endAuth(): Promise<void>;
}

export async function withCliPublicationLease<T>(
  userId: string,
  integrationId: string,
  operation: (
    token: string,
    assertOwned: () => Promise<void>,
    auth: CliPublicationAuth
  ) => Promise<T>,
  injected?: CliPublicationLeaseDependencies
): Promise<T> {
  const deps: CliPublicationLeaseDependencies = injected ?? {
    now: Date.now,
    token: randomUUID,
    every(callback, milliseconds) {
      const timer = setInterval(callback, milliseconds);
      timer.unref();
      return () => clearInterval(timer);
    },
    async read() {
      const row = await prisma.integration.findFirst({
        where: { id: integrationId, userId, name: 'cli' },
      });
      if (!row) throw new CliIntegrationError(404, 'CLI connection not found');
      return row;
    },
    async swap(expected, config) {
      const result = await prisma.integration.updateMany({
        where: {
          id: integrationId,
          userId,
          status: expected.status,
          config: { equals: expected.config as Prisma.InputJsonValue },
        },
        data: { config },
      });
      return result.count === 1;
    },
  };
  const row = await deps.read();
  const config = row.config as Prisma.JsonObject;
  if (
    config.publishing_token &&
    config.publishing_expires_at !== undefined &&
    (typeof config.publishing_expires_at !== 'number' ||
      !Number.isFinite(config.publishing_expires_at))
  )
    throw new CliIntegrationError(409, 'Stored CLI publication lease is invalid');
  const previousExpiry =
    typeof config.publishing_expires_at === 'number'
      ? config.publishing_expires_at
      : row.updatedAt.getTime() + LEGACY_GRACE_MS;
  if (config.publishing_token && previousExpiry > deps.now())
    throw new CliIntegrationError(
      409,
      'This CLI publication is already running; retry after it finishes'
    );
  if (config.publishing_auth_inflight !== undefined && config.publishing_auth_inflight !== false)
    throw new CliIntegrationError(
      409,
      'Prior CLI authentication outcome is uncertain; reconnect this CLI with a fresh login'
    );
  const token = deps.token();
  if (
    !(await deps.swap(row, {
      ...config,
      publishing_token: token,
      publishing_expires_at: deps.now() + LEASE_MS,
    }))
  )
    throw new CliIntegrationError(
      409,
      'Another setup publication is running; retry after it finishes'
    );
  let failure: unknown;
  let writes = Promise.resolve();
  const assertOwned = async () => {
    await writes;
    if (failure) throw failure;
    const latest = await deps.read();
    const value = latest.config as Prisma.JsonObject;
    if (
      value.publishing_token !== token ||
      typeof value.publishing_expires_at !== 'number' ||
      value.publishing_expires_at <= deps.now()
    )
      throw new CliIntegrationError(
        409,
        'CLI publication lease expired or was replaced; retry publication'
      );
  };
  const changeAuth = async (active: boolean) => {
    const changed = writes.then(async () => {
      if (failure) throw failure;
      const latest = await deps.read();
      const value = latest.config as Prisma.JsonObject;
      if (
        value.publishing_token !== token ||
        typeof value.publishing_expires_at !== 'number' ||
        value.publishing_expires_at <= deps.now()
      )
        throw new CliIntegrationError(
          409,
          'CLI publication lease expired or was replaced; retry publication'
        );
      const next = { ...value };
      if (active) next.publishing_auth_inflight = true;
      else delete next.publishing_auth_inflight;
      if (!(await deps.swap(latest, next)))
        throw new CliIntegrationError(
          409,
          'CLI publication lease expired or was replaced; retry publication'
        );
    });
    writes = changed.catch((error: unknown) => {
      failure = error;
    });
    await changed;
  };
  const stop = deps.every(() => {
    writes = writes
      .then(async () => {
        const latest = await deps.read();
        const value = latest.config as Prisma.JsonObject;
        if (
          value.publishing_token !== token ||
          typeof value.publishing_expires_at !== 'number' ||
          value.publishing_expires_at <= deps.now() ||
          !(await deps.swap(latest, { ...value, publishing_expires_at: deps.now() + LEASE_MS }))
        )
          throw new CliIntegrationError(
            409,
            'CLI publication lease expired or was replaced; retry publication'
          );
      })
      .catch((error: unknown) => {
        failure = error;
      });
  }, 20_000);
  try {
    return await operation(token, assertOwned, {
      beginAuth: () => changeAuth(true),
      endAuth: () => changeAuth(false),
    });
  } finally {
    stop();
    await writes;
    const latest = await deps.read();
    const value = latest.config as Prisma.JsonObject;
    if (value.publishing_token === token && value.publishing_auth_inflight !== true) {
      const next = { ...value };
      delete next.publishing_token;
      delete next.publishing_expires_at;
      await deps.swap(latest, next);
    }
  }
}
