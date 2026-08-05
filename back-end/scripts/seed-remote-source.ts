import { Prisma, PrismaClient } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { retryWithBackoff } from '../src/providers/retry';

type SeedTransport = 'auto' | 'postgres' | 'https';
type SortDirection = 'asc' | 'desc';
type SeedWhere = Record<string, unknown>;

interface SeedFindArgs {
  where?: SeedWhere;
  select?: Record<string, boolean>;
  orderBy?: Record<string, SortDirection>;
  skip?: number;
  take?: number;
}

interface ConnectableSeedClient {
  $queryRawUnsafe(query: string): Promise<unknown>;
  $disconnect(): Promise<void>;
}

interface SeedRemoteClientOptions {
  databaseUrl: string;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  transport?: SeedTransport;
  createPostgresClient?: (databaseUrl: string) => ConnectableSeedClient;
  fetchImpl?: typeof fetch;
}

interface PostgrestSeedClientOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  requestAttempts?: number;
  requestRetryDelayMs?: number;
}

type ResolvedPostgrestSeedClientOptions = Required<
  Pick<
    PostgrestSeedClientOptions,
    | 'supabaseUrl'
    | 'serviceRoleKey'
    | 'requestTimeoutMs'
    | 'requestAttempts'
    | 'requestRetryDelayMs'
  >
> &
  Pick<PostgrestSeedClientOptions, 'fetchImpl'>;

type SeedRow = Record<string, unknown>;
type ModelMetadata = (typeof Prisma.dmmf.datamodel.models)[number];
type FieldMetadata = ModelMetadata['fields'][number];

const HTTP_PAGE_SIZE = 1000;
const HTTP_IN_FILTER_SIZE = 100;
const HTTP_IN_FILTER_CONCURRENCY = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_ATTEMPTS = 3;
const DEFAULT_REQUEST_RETRY_DELAY_MS = 250;

function lowerFirst(value: string): string {
  return value.slice(0, 1).toLowerCase() + value.slice(1);
}

const MODEL_BY_DELEGATE = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [lowerFirst(model.name), model])
);

function isDatabaseUnreachable(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P1001'
  ) {
    return true;
  }
  return (
    error instanceof Prisma.PrismaClientInitializationError &&
    error.errorCode === undefined &&
    /can(?:not|'t|’t) reach database server at `[^`]+`/i.test(error.message)
  );
}

function requireHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SUPABASE_URL must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('SUPABASE_URL must use HTTPS for service-role seed reads');
  }
  return url.toString().replace(/\/+$/, '');
}

function requireHttpsOptions(options: SeedRemoteClientOptions): PostgrestSeedClientOptions {
  const supabaseUrl = options.supabaseUrl?.trim();
  const serviceRoleKey = options.serviceRoleKey?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('HTTPS seed transport requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  return {
    supabaseUrl: requireHttpsUrl(supabaseUrl),
    serviceRoleKey,
    fetchImpl: options.fetchImpl,
  };
}

export async function createSeedRemoteClient(
  options: SeedRemoteClientOptions
): Promise<PrismaClient> {
  const transport = options.transport ?? 'auto';
  if (transport === 'https') {
    return createPostgrestSeedClient(requireHttpsOptions(options));
  }

  const postgres =
    options.createPostgresClient?.(options.databaseUrl) ??
    new PrismaClient({ datasources: { db: { url: options.databaseUrl } } });
  try {
    await postgres.$queryRawUnsafe('SELECT 1');
    return postgres as PrismaClient;
  } catch (error) {
    await postgres.$disconnect();
    if (transport === 'postgres' || !isDatabaseUnreachable(error)) throw error;
    console.warn(
      '  ⚠️  Production PostgreSQL port unreachable; syncing through Supabase HTTPS instead'
    );
    return createPostgrestSeedClient(requireHttpsOptions(options));
  }
}

function quoteFilterValue(value: unknown): string {
  // `String(new Date())` yields a locale string PostgREST cannot parse.
  const stringValue = value instanceof Date ? value.toISOString() : String(value);
  if (!/[\s,()"\\]/.test(stringValue)) return stringValue;
  return `"${stringValue.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function escapeLikeValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('*', '\\*').replaceAll('%', '\\%');
}

function operatorExpression(value: unknown): string {
  if (value === null) return 'is.null';
  if (typeof value !== 'object' || value instanceof Date || Array.isArray(value)) {
    return `eq.${quoteFilterValue(value)}`;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) {
    throw new Error(`Unsupported seed filter: ${JSON.stringify(value)}`);
  }
  const [operator, operand] = entries[0];
  switch (operator) {
    case 'not':
      return operand === null ? 'not.is.null' : `not.${operatorExpression(operand)}`;
    case 'in': {
      if (!Array.isArray(operand)) throw new Error('Seed "in" filter must be an array');
      return `in.(${operand.map(quoteFilterValue).join(',')})`;
    }
    case 'endsWith':
      return `like.${quoteFilterValue(`*${escapeLikeValue(String(operand))}`)}`;
    case 'contains':
      return `like.${quoteFilterValue(`*${escapeLikeValue(String(operand))}*`)}`;
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return `${operator}.${quoteFilterValue(operand)}`;
    default:
      throw new Error(`Unsupported seed filter operator: ${operator}`);
  }
}

function databaseFieldName(model: ModelMetadata, fieldName: string): string {
  const field = model.fields.find((candidate) => candidate.name === fieldName);
  if (!field) throw new Error(`Unknown ${model.name} filter field: ${fieldName}`);
  return field.dbName ?? field.name;
}

function orClauseExpression(clause: SeedWhere, model: ModelMetadata): string {
  const entries = Object.entries(clause);
  if (entries.length !== 1) {
    const nested = entries
      .map(([field, value]) => `${databaseFieldName(model, field)}.${operatorExpression(value)}`)
      .join(',');
    return `and(${nested})`;
  }
  const [field, value] = entries[0];
  return `${databaseFieldName(model, field)}.${operatorExpression(value)}`;
}

function applyWhere(url: URL, where: SeedWhere | undefined, model: ModelMetadata): void {
  if (!where) return;
  for (const [field, value] of Object.entries(where)) {
    if (field === 'OR') {
      if (!Array.isArray(value)) throw new Error('Seed OR filter must be an array');
      const clauses = value.map((clause) => {
        if (!clause || typeof clause !== 'object' || Array.isArray(clause)) {
          throw new Error('Seed OR clauses must be objects');
        }
        return orClauseExpression(clause as SeedWhere, model);
      });
      url.searchParams.set('or', `(${clauses.join(',')})`);
      continue;
    }
    url.searchParams.set(databaseFieldName(model, field), operatorExpression(value));
  }
}

function selectedFields(select: Record<string, boolean> | undefined, model: ModelMetadata): string {
  if (!select) return '*';
  const fields = Object.entries(select)
    .filter(([, included]) => included)
    .map(([field]) => databaseFieldName(model, field));
  if (fields.length === 0) throw new Error('Seed select must include at least one field');
  return fields.join(',');
}

function stableOrder(args: SeedFindArgs, model: ModelMetadata): string {
  const explicit = Object.entries(args.orderBy ?? {}).map(
    ([field, direction]) => `${databaseFieldName(model, field)}.${direction}`
  );
  const idField = databaseFieldName(model, 'id');
  if (!explicit.some((entry) => entry.startsWith(`${idField}.`))) {
    explicit.push(`${idField}.asc`);
  }
  return explicit.join(',');
}

function parseCsvRows(csv: string): SeedRow[] {
  if (csv.trim() === '') return [];
  return parse(csv, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    cast(value, context) {
      if (context.header) return value;
      return value === '' && !context.quoting ? null : value;
    },
  }) as SeedRow[];
}

function decodeBytes(value: string): Buffer {
  if (value.startsWith('\\x')) return Buffer.from(value.slice(2), 'hex');
  return Buffer.from(value, 'base64');
}

function normalizeField(value: unknown, field: FieldMetadata): unknown {
  if (value === null || value === undefined) return value;
  if (field.isList) {
    if (!Array.isArray(value)) {
      throw new Error(`Expected an array for ${field.name}, got ${typeof value}`);
    }
    return value.map((item) => normalizeField(item, { ...field, isList: false } as FieldMetadata));
  }
  const stringValue = String(value);
  switch (field.type) {
    case 'BigInt':
      return BigInt(stringValue);
    case 'Boolean':
      return stringValue === 'true' || stringValue === 't';
    case 'Bytes':
      return decodeBytes(stringValue);
    case 'DateTime': {
      const date = new Date(stringValue);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid DateTime for ${field.name}: ${stringValue}`);
      }
      return date;
    }
    case 'Decimal':
      return new Prisma.Decimal(stringValue);
    case 'Float':
    case 'Int':
      return Number(stringValue);
    case 'Json':
      // Non-BigInt models use PostgREST's JSON response, where a JSON column
      // may itself legitimately contain a scalar string. Parsing that string
      // again would turn valid values such as "STATUS: SUCCESS" into errors.
      return value;
    default:
      return value;
  }
}

function normalizeRows(rows: SeedRow[], model: ModelMetadata): SeedRow[] {
  const fields = new Map(
    model.fields.flatMap((field) => [
      [field.name, field] as const,
      [field.dbName ?? field.name, field] as const,
    ])
  );
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([name, value]) => {
        const field = fields.get(name);
        if (!field) throw new Error(`Unknown ${model.name} field from PostgREST: ${name}`);
        return [field.name, normalizeField(value, field)];
      })
    )
  );
}

async function responseRows(response: Response, model: ModelMetadata): Promise<SeedRow[]> {
  // JSON parses `numeric` into a double, and normalizeField then rebuilds a
  // Decimal from that already-rounded value. Decimal needs the CSV path just as
  // much as BigInt does.
  const requiresLosslessNumbers = model.fields.some(
    (field) => field.type === 'BigInt' || field.type === 'Decimal'
  );
  if (requiresLosslessNumbers) return parseCsvRows(await response.text());
  const value = (await response.json()) as unknown;
  if (!Array.isArray(value)) {
    throw new Error(`Supabase HTTPS seed read returned non-array JSON for ${model.name}`);
  }
  return value as SeedRow[];
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  if ('cause' in error) return errorCode((error as { cause?: unknown }).cause);
  return undefined;
}

function isTransientFetchError(error: unknown): boolean {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name?: unknown }).name)
      : '';
  const code = errorCode(error);
  return (
    error instanceof TypeError ||
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code?.startsWith('UND_ERR_') === true ||
    ['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(code ?? '')
  );
}

async function fetchSeedPage(
  url: URL,
  init: Omit<RequestInit, 'signal'>,
  options: ResolvedPostgrestSeedClientOptions
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  return retryWithBackoff(
    () =>
      fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      }),
    {
      maxRetries: options.requestAttempts,
      initialBackoffMs: options.requestRetryDelayMs,
      isRetryable: isTransientFetchError,
      shouldRetryResult: (response) => isTransientHttpStatus(response.status),
      beforeRetryResult: async (response) => {
        // Release the failed response before opening the replacement connection.
        await response.arrayBuffer().catch(() => undefined);
      },
      component: 'Supabase HTTPS seed read',
    }
  );
}

async function fetchUnchunkedModelRows(
  model: ModelMetadata,
  args: SeedFindArgs,
  options: ResolvedPostgrestSeedClientOptions
): Promise<SeedRow[]> {
  const rows: SeedRow[] = [];
  let offset = args.skip ?? 0;
  let remaining = args.take ?? Number.POSITIVE_INFINITY;

  while (remaining > 0) {
    const pageSize = Math.min(HTTP_PAGE_SIZE, remaining);
    const tableName = model.dbName ?? model.name;
    const url = new URL(
      `/rest/v1/${encodeURIComponent(tableName)}`,
      options.supabaseUrl.replace(/\/+$/, '')
    );
    url.searchParams.set('select', selectedFields(args.select, model));
    url.searchParams.set('order', stableOrder(args, model));
    applyWhere(url, args.where, model);

    const response = await fetchSeedPage(
      url,
      {
        headers: {
          Accept: model.fields.some((field) => field.type === 'BigInt')
            ? 'text/csv'
            : 'application/json',
          apikey: options.serviceRoleKey,
          Authorization: `Bearer ${options.serviceRoleKey}`,
          Range: `${offset}-${offset + pageSize - 1}`,
          'Range-Unit': 'items',
        },
      },
      options
    );
    if (response.status === 416) break;
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      throw new Error(
        `Supabase HTTPS seed read failed for ${model.name} (HTTP ${response.status}): ${body}`
      );
    }

    const page = normalizeRows(await responseRows(response, model), model);
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += page.length;
    remaining -= page.length;
  }
  return rows;
}

function largeInFilter(where: SeedWhere | undefined): { field: string; values: unknown[] } | null {
  if (!where) return null;
  for (const [field, condition] of Object.entries(where)) {
    if (
      condition &&
      typeof condition === 'object' &&
      !Array.isArray(condition) &&
      'in' in condition
    ) {
      const values = (condition as { in?: unknown }).in;
      if (Array.isArray(values) && values.length > HTTP_IN_FILTER_SIZE) {
        return { field, values };
      }
    }
  }
  return null;
}

function comparable(value: unknown): string | number | bigint {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' || typeof value === 'bigint') return value;
  return String(value);
}

/**
 * Mirror PostgreSQL ordering so the chunked client-side path slices the same
 * page the server-side `order` parameter would have returned:
 *  - NULLs sort last on `asc` (PostgreSQL's default), not first.
 *  - A numeric column with a null in one row must still compare numerically,
 *    otherwise `10` sorts before `9`.
 *  - Byte-wise string comparison instead of `localeCompare`, whose ICU locale
 *    varies per machine and would order the same query differently.
 */
function compareValues(left: unknown, right: unknown): number {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull || rightNull) {
    if (leftNull && rightNull) return 0;
    return leftNull ? 1 : -1;
  }
  const a = comparable(left);
  const b = comparable(right);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a !== 'string' && typeof b !== 'string') {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  }
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function sortRows(rows: SeedRow[], args: SeedFindArgs): SeedRow[] {
  const order = Object.entries(args.orderBy ?? {}) as Array<[string, SortDirection]>;
  if (!order.some(([field]) => field === 'id')) order.push(['id', 'asc']);
  return rows.sort((left, right) => {
    for (const [field, direction] of order) {
      const compared = compareValues(left[field], right[field]);
      if (compared !== 0) return direction === 'desc' ? -compared : compared;
    }
    return 0;
  });
}

async function fetchModelRows(
  model: ModelMetadata,
  args: SeedFindArgs,
  options: ResolvedPostgrestSeedClientOptions
): Promise<SeedRow[]> {
  const chunked = largeInFilter(args.where);
  if (!chunked) return fetchUnchunkedModelRows(model, args, options);

  const chunks: unknown[][] = [];
  for (let offset = 0; offset < chunked.values.length; offset += HTTP_IN_FILTER_SIZE) {
    chunks.push(chunked.values.slice(offset, offset + HTTP_IN_FILTER_SIZE));
  }
  const rows: SeedRow[] = [];
  const perChunkTake = args.take === undefined ? undefined : (args.skip ?? 0) + args.take;
  for (let offset = 0; offset < chunks.length; offset += HTTP_IN_FILTER_CONCURRENCY) {
    const batch = chunks.slice(offset, offset + HTTP_IN_FILTER_CONCURRENCY);
    const results = await Promise.all(
      batch.map((values) =>
        fetchUnchunkedModelRows(
          model,
          {
            ...args,
            skip: 0,
            take: perChunkTake,
            where: {
              ...args.where,
              [chunked.field]: { in: values },
            },
          },
          options
        )
      )
    );
    rows.push(...results.flat());
  }

  // `JSON.stringify` throws on BigInt, and several models (cookie tables among
  // them) carry BigInt columns while others have no `id` to key on — which is
  // exactly when this fallback runs. Serialize BigInt as a string instead.
  const dedupeKey = (row: Record<string, unknown>): string =>
    String(row.id ?? JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const uniqueRows = [...new Map(rows.map((row) => [dedupeKey(row), row])).values()];
  const sorted = sortRows(uniqueRows, args);
  const start = args.skip ?? 0;
  return sorted.slice(start, args.take === undefined ? undefined : start + args.take);
}

function createModelDelegate(
  model: ModelMetadata,
  options: ResolvedPostgrestSeedClientOptions
): {
  findMany(args?: SeedFindArgs): Promise<SeedRow[]>;
  findUnique(args: SeedFindArgs): Promise<SeedRow | null>;
} {
  return {
    findMany: async (args = {}) => fetchModelRows(model, args, options),
    findUnique: async (args) => {
      const rows = await fetchModelRows(model, { ...args, take: 1 }, options);
      return rows[0] ?? null;
    },
  };
}

export function createPostgrestSeedClient(input: PostgrestSeedClientOptions): PrismaClient {
  const options = {
    ...input,
    supabaseUrl: requireHttpsUrl(input.supabaseUrl),
    requestTimeoutMs: input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    requestAttempts: input.requestAttempts ?? DEFAULT_REQUEST_ATTEMPTS,
    requestRetryDelayMs: input.requestRetryDelayMs ?? DEFAULT_REQUEST_RETRY_DELAY_MS,
  };
  const delegates = new Map<string, ReturnType<typeof createModelDelegate>>();
  const base = {
    $connect: async () => {},
    $disconnect: async () => {},
  };

  return new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(target, property, receiver);
      // Async factory resolution probes returned values for a `then` method.
      // The Prisma-shaped proxy is not a promise.
      if (property === 'then') return undefined;
      if (property in target) return Reflect.get(target, property, receiver);
      const model = MODEL_BY_DELEGATE.get(property);
      if (!model) throw new Error(`Unknown Prisma seed delegate: ${property}`);
      let delegate = delegates.get(property);
      if (!delegate) {
        delegate = createModelDelegate(model, options);
        delegates.set(property, delegate);
      }
      return delegate;
    },
  }) as unknown as PrismaClient;
}
