/** Immutable native-CLI revisions. Healthy readers are lock-free; repairs share the publisher lease. */
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import { retryWithBackoff } from './retry';

export interface TemplateRecipe {
  id: string;
  /** Connection whose login is paired with this installed recipe. */
  connectionId?: string;
  name: string;
  /** Repeatable installation only; never credentials, account tokens or agent runtime configuration. */
  install: string;
  command: string;
  /** Unauthenticated verification (for example --version). */
  verify: string[];
}
export interface TemplateVariantDefinition {
  key: string;
  provider: 'claude' | 'codex';
  cpu: number;
  memoryGb: number;
  baseTemplateId: string;
}
export interface TemplateVariant extends TemplateVariantDefinition {
  snapshotId: string;
}
export interface UserCodeTemplate {
  kind: 'native-cli-template-v1';
  revision: number;
  variants: TemplateVariant[];
  recipes: TemplateRecipe[];
  lease?: { token: string; operationId: string; expiresAt: number };
}
export interface PublicationFence {
  integrationId: string;
  token: string;
}
interface PublishReceipt {
  fingerprint: string;
  revision: number;
}
export interface UserTemplateStore {
  read(userId: string): Promise<UserCodeTemplate | null>;
  ensure(userId: string): Promise<UserCodeTemplate>;
  receipt(userId: string, operationId: string): Promise<PublishReceipt | null>;
  /** With a receipt, the pointer swap and receipt insertion must commit in one transaction. */
  compareAndSet(
    userId: string,
    expected: UserCodeTemplate,
    next: UserCodeTemplate,
    receipt?: PublishReceipt & { operationId: string },
    fence?: PublicationFence
  ): Promise<boolean>;
}
export interface UserTemplateDependencies {
  store: UserTemplateStore;
  now: () => number;
  token: () => string;
  every: (callback: () => void, milliseconds: number) => () => void;
  wait?: (milliseconds: number) => Promise<void>;
}
export type TemplateBuilder = (
  recipes: TemplateRecipe[],
  variant: TemplateVariantDefinition,
  uniqueName: string
) => Promise<string>;
export class UserCodeTemplateError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly orphanSnapshots: string[] = [],
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}
class TemplateLeaseContentionError extends UserCodeTemplateError {
  constructor(message: string) {
    super(409, message);
  }
}
const REPAIR_WAIT_MS = 30 * 60_000;
const repairQueues = new WeakMap<UserTemplateStore, Map<string, Promise<UserCodeTemplate>>>();
const matchingRepairs = new WeakMap<UserTemplateStore, Map<string, Promise<UserCodeTemplate>>>();
const LEASE_MS = 90_000;
const RENEW_MS = 20_000;
const HEAD_NAME = 'code_template';
const RECEIPT_NAME = 'code_template_operation';
const EMPTY: UserCodeTemplate = {
  kind: 'native-cli-template-v1',
  revision: 0,
  variants: [],
  recipes: [],
};
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const where = (userId: string, name = HEAD_NAME, accountId = '') => ({
  userId_name_accountId: { userId, name, accountId },
});
function decode(value: Prisma.JsonValue): UserCodeTemplate {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.kind !== EMPTY.kind ||
    !Number.isInteger(value.revision) ||
    !Array.isArray(value.variants) ||
    !Array.isArray(value.recipes)
  ) {
    throw new UserCodeTemplateError(409, 'Stored native CLI template is invalid');
  }
  return structuredClone(value) as unknown as UserCodeTemplate;
}
const databaseStore: UserTemplateStore = {
  async read(userId) {
    const row = await prisma.integration.findUnique({
      where: where(userId),
      select: { config: true },
    });
    return row === null ? null : decode(row.config);
  },
  async ensure(userId) {
    const row = await prisma.integration.upsert({
      where: where(userId),
      create: { userId, name: HEAD_NAME, accountId: '', type: 'TOOL_SETUP', config: json(EMPTY) },
      update: {},
      select: { config: true },
    });
    return decode(row.config);
  },
  async receipt(userId, operationId) {
    const row = await prisma.integration.findUnique({
      where: where(userId, RECEIPT_NAME, operationId),
      select: { config: true },
    });
    if (!row) return null;
    const value = row.config;
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.fingerprint !== 'string' ||
      typeof value.revision !== 'number'
    )
      throw new UserCodeTemplateError(409, 'Stored template publication receipt is invalid');
    return { fingerprint: value.fingerprint, revision: value.revision };
  },
  async compareAndSet(userId, expected, next, receipt, fence) {
    const swap = async (db: Pick<Prisma.TransactionClient, 'integration'>) => {
      if (fence) {
        const owner = await db.integration.updateMany({
          where: {
            id: fence.integrationId,
            userId,
            name: 'cli',
            AND: [
              { config: { path: ['publishing_token'], equals: fence.token } },
              { config: { path: ['publishing_expires_at'], gt: Date.now() } },
            ],
          },
          data: { updatedAt: new Date() },
        });
        if (owner.count !== 1) return false;
      }
      const changed = await db.integration.updateMany({
        where: { userId, name: HEAD_NAME, accountId: '', config: { equals: json(expected) } },
        data: {
          config: json(next),
          status: next.revision > 0 ? 'CONNECTED' : 'SYNCING',
          isActive: next.revision > 0,
        },
      });
      if (changed.count !== 1) return false;
      if (receipt)
        await db.integration.create({
          data: {
            userId,
            name: RECEIPT_NAME,
            accountId: receipt.operationId,
            type: 'TOOL_SETUP',
            status: 'CONNECTED',
            config: json(receipt),
          },
        });
      return true;
    };
    return receipt || fence ? runTransactionWithRetry(swap) : swap(prisma);
  },
};
const defaults: UserTemplateDependencies = {
  store: databaseStore,
  now: Date.now,
  token: randomUUID,
  every(callback, milliseconds) {
    const timer = setInterval(callback, milliseconds);
    timer.unref();
    return () => clearInterval(timer);
  },
};

export async function readUserCodeTemplate(
  userId: string,
  deps: UserTemplateDependencies = defaults
): Promise<UserCodeTemplate | null> {
  return deps.store.read(userId);
}
function validatePublication(
  operationId: string,
  recipe: TemplateRecipe,
  variants: TemplateVariantDefinition[]
): void {
  if (!operationId || operationId.length > 200)
    throw new UserCodeTemplateError(400, 'Invalid template publication operation');
  if (
    !recipe.id ||
    recipe.id.length > 200 ||
    (recipe.connectionId !== undefined &&
      (typeof recipe.connectionId !== 'string' || recipe.connectionId.length > 200)) ||
    !recipe.name ||
    recipe.name.length > 200 ||
    !recipe.install ||
    recipe.install.length > 32_768 ||
    !recipe.command.startsWith('/') ||
    recipe.command.includes('\0') ||
    recipe.command.length > 4096 ||
    !Array.isArray(recipe.verify) ||
    recipe.verify.length > 128 ||
    recipe.verify.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > 8192)
  )
    throw new UserCodeTemplateError(400, 'Invalid native CLI installation recipe');
  if (
    !variants.length ||
    variants.length > 18 ||
    new Set(variants.map((variant) => variant.key)).size !== variants.length ||
    variants.some(
      (variant) =>
        !variant.key ||
        variant.key.length > 200 ||
        !['claude', 'codex'].includes(variant.provider) ||
        !Number.isInteger(variant.cpu) ||
        variant.cpu < 1 ||
        !Number.isInteger(variant.memoryGb) ||
        variant.memoryGb < 1 ||
        !variant.baseTemplateId ||
        variant.baseTemplateId.length > 1024
    )
  )
    throw new UserCodeTemplateError(400, 'Invalid native CLI template variants');
}
function fingerprint(recipe: TemplateRecipe, variants: TemplateVariantDefinition[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        recipe: {
          id: recipe.id,
          connectionId: recipe.connectionId,
          name: recipe.name,
          install: recipe.install,
          command: recipe.command,
          verify: recipe.verify,
        },
        variants: variants
          .map((variant) => ({
            key: variant.key,
            provider: variant.provider,
            cpu: variant.cpu,
            memoryGb: variant.memoryGb,
            baseTemplateId: variant.baseTemplateId,
          }))
          .sort((a, b) => a.key.localeCompare(b.key)),
      })
    )
    .digest('hex');
}

async function completedPublication(
  userId: string,
  operationId: string,
  operationFingerprint: string,
  deps: UserTemplateDependencies
): Promise<UserCodeTemplate | null> {
  const receipt = await deps.store.receipt(userId, operationId);
  if (receipt) {
    if (receipt.fingerprint !== operationFingerprint)
      throw new UserCodeTemplateError(
        409,
        'Template operation ID was already used for different inputs'
      );
    const current = await deps.store.read(userId);
    if (!current || current.revision < receipt.revision)
      throw new UserCodeTemplateError(409, 'Committed template revision is unavailable');
    return current;
  }
  return null;
}

/** Every builder starts from variant.baseTemplateId and replays ALL supplied recipes. */
export async function publishUserCodeTemplate(
  userId: string,
  operationId: string,
  recipe: TemplateRecipe,
  variants: TemplateVariantDefinition[],
  builder: TemplateBuilder,
  deps: UserTemplateDependencies = defaults,
  fence?: PublicationFence
): Promise<UserCodeTemplate> {
  return commitTemplateOperation(
    userId,
    operationId,
    recipe,
    variants,
    builder,
    deps,
    false,
    fence
  );
}

/** Repair exactly one environment while retaining every installed recipe and other variant. */
export async function repairUserCodeTemplateVariant(
  userId: string,
  variant: TemplateVariantDefinition,
  builder: TemplateBuilder,
  deps: UserTemplateDependencies = defaults
): Promise<UserCodeTemplate> {
  const queues = repairQueues.get(deps.store) ?? new Map<string, Promise<UserCodeTemplate>>();
  const matches = matchingRepairs.get(deps.store) ?? new Map<string, Promise<UserCodeTemplate>>();
  repairQueues.set(deps.store, queues);
  matchingRepairs.set(deps.store, matches);
  const key = JSON.stringify([userId, variant]);
  const matching = matches.get(key);
  if (matching) return matching;
  const previous = queues.get(userId);
  const deadline = deps.now() + REPAIR_WAIT_MS;
  const operation = (async () => {
    // Different variants queue behind the same user's writer, then reread all recipes.
    if (previous) await previous.catch(() => undefined);
    return retryWithBackoff(
      async () => {
        const head = await deps.store.read(userId);
        if (!head || head.revision === 0 || !head.recipes.length)
          throw new UserCodeTemplateError(409, 'No published CLI recipes are available to rebuild');
        if (
          head.variants.some(
            (entry) =>
              entry.key === variant.key &&
              entry.provider === variant.provider &&
              entry.cpu === variant.cpu &&
              entry.memoryGb === variant.memoryGb &&
              entry.baseTemplateId === variant.baseTemplateId &&
              entry.snapshotId
          )
        )
          return head;
        if (deps.now() >= deadline)
          throw new UserCodeTemplateError(
            409,
            'CLI template repair is still in progress; retry shortly'
          );
        if (head.lease && head.lease.expiresAt > deps.now())
          throw new TemplateLeaseContentionError('Another template update is in progress');
        const operationId = `repair:${head.revision}:${createHash('sha256').update(JSON.stringify(variant)).digest('hex')}`;
        return commitTemplateOperation(
          userId,
          operationId,
          head.recipes[0]!,
          [variant],
          builder,
          deps,
          true
        );
      },
      {
        maxRetries: Math.ceil(REPAIR_WAIT_MS / 1000) + 1,
        isRetryable: (error) =>
          error instanceof TemplateLeaseContentionError && deps.now() < deadline,
        getBackoffDelayMs: (_error, attempt) =>
          Math.max(0, Math.min(1000 * 2 ** Math.min(attempt - 1, 3), 5000, deadline - deps.now())),
        sleep: deps.wait,
        component: 'NativeCliTemplateRepair',
      }
    );
  })();
  queues.set(userId, operation);
  matches.set(key, operation);
  try {
    return await operation;
  } finally {
    if (queues.get(userId) === operation) queues.delete(userId);
    if (matches.get(key) === operation) matches.delete(key);
  }
}

async function commitTemplateOperation(
  userId: string,
  operationId: string,
  recipe: TemplateRecipe,
  variants: TemplateVariantDefinition[],
  builder: TemplateBuilder,
  deps: UserTemplateDependencies,
  repair: boolean,
  fence?: PublicationFence
): Promise<UserCodeTemplate> {
  validatePublication(operationId, recipe, variants);
  const operationFingerprint = fingerprint(recipe, variants);
  const completed = await completedPublication(userId, operationId, operationFingerprint, deps);
  if (completed) return completed;
  const previous = await deps.store.ensure(userId);
  // A publisher may have committed between our first receipt read and head read.
  const racedCompletion = await completedPublication(
    userId,
    operationId,
    operationFingerprint,
    deps
  );
  if (racedCompletion) return racedCompletion;
  if (previous.lease && previous.lease.expiresAt > deps.now())
    throw new TemplateLeaseContentionError('Another template update is in progress');
  const recipes = repair
    ? structuredClone(previous.recipes)
    : [...previous.recipes.filter((item) => item.id !== recipe.id), structuredClone(recipe)];
  if (recipes.length > 200)
    throw new UserCodeTemplateError(400, 'At most 200 native CLI recipes are supported');
  const basename = recipe.command.split('/').at(-1);
  if (
    !repair &&
    previous.recipes.some(
      (item) =>
        item.id !== recipe.id &&
        (item.command === recipe.command || item.command.split('/').at(-1) === basename)
    )
  ) {
    throw new UserCodeTemplateError(
      409,
      'This CLI command is already connected; reconnect the existing CLI instead'
    );
  }
  const token = deps.token();
  let current: UserCodeTemplate = {
    ...previous,
    lease: { token, operationId, expiresAt: deps.now() + LEASE_MS },
  };
  if (!(await deps.store.compareAndSet(userId, previous, current, undefined, fence)))
    throw new TemplateLeaseContentionError('Another template update won the lease');
  let leaseError: unknown;
  let writes = Promise.resolve();
  const snapshots: string[] = [];
  const assertLease = () => {
    if (
      leaseError ||
      !current.lease ||
      current.lease.token !== token ||
      current.lease.expiresAt <= deps.now()
    )
      throw new UserCodeTemplateError(
        409,
        'Template publication lease expired or was replaced',
        [...snapshots],
        { cause: leaseError }
      );
  };
  const stop = deps.every(() => {
    writes = writes
      .then(async () => {
        assertLease();
        const renewed = {
          ...current,
          lease: { token, operationId, expiresAt: deps.now() + LEASE_MS },
        };
        if (!(await deps.store.compareAndSet(userId, current, renewed, undefined, fence)))
          throw new UserCodeTemplateError(409, 'Template publication lease was replaced');
        current = renewed;
      })
      .catch((error: unknown) => {
        leaseError = error;
      });
  }, RENEW_MS);
  try {
    const built: TemplateVariant[] = [];
    const userKey = createHash('sha256').update(userId).digest('hex').slice(0, 16);
    // Private staging and unique names prevent a stale builder from mutating any published snapshot.
    for (const [index, variant] of variants.entries()) {
      await writes;
      assertLease();
      const uniqueName = `rose-user-${userKey}-${token}-${index}`;
      const snapshotId = await builder(structuredClone(recipes), { ...variant }, uniqueName);
      if (typeof snapshotId !== 'string' || !snapshotId || snapshotId.length > 1024)
        throw new UserCodeTemplateError(502, 'Template builder returned an invalid snapshot');
      snapshots.push(snapshotId);
      built.push({ ...variant, snapshotId });
    }
    stop();
    await writes;
    assertLease();
    const next: UserCodeTemplate = {
      kind: EMPTY.kind,
      revision: previous.revision + 1,
      recipes,
      variants: repair
        ? [
            ...previous.variants.filter(
              (entry) => !variants.some((variant) => variant.key === entry.key)
            ),
            ...built,
          ]
        : built,
    };
    const committed = await deps.store.compareAndSet(
      userId,
      current,
      next,
      {
        operationId,
        fingerprint: operationFingerprint,
        revision: next.revision,
      },
      fence
    );
    if (!committed)
      throw new UserCodeTemplateError(409, 'Another template revision superseded this publication');
    return next;
  } catch (error) {
    stop();
    await writes;
    // CAS can release only this exact lease; a successor's pointer/lease is never overwritten.
    const unlocked = { ...current };
    delete unlocked.lease;
    try {
      await deps.store.compareAndSet(userId, current, unlocked);
    } catch {
      /* Retain the lease until expiry if storage is unavailable. */
    }
    const inherited = error instanceof UserCodeTemplateError ? error.orphanSnapshots : [];
    throw new UserCodeTemplateError(
      error instanceof UserCodeTemplateError ? error.status : 502,
      error instanceof Error ? error.message : 'Template publication failed',
      [...new Set([...snapshots, ...inherited])],
      { cause: error }
    );
  }
}
