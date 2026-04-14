/**
 * Supabase Client Stub for Blackbox Tests
 *
 * Provides a configurable fake Supabase client that simulates
 * auth.getUser() and DB query chains (.from().select().eq()...).
 *
 * The chain is lazy: captures are only recorded when the chain is
 * awaited (via .then()), not at each intermediate step.
 *
 * Usage:
 *   const stub = createSupabaseStub({
 *     user: { id: 'user-123', email: 'test@test.com' },
 *     queryResults: { RoseApiKey: { data: [...], error: null } },
 *   });
 */

export interface StubUser {
  id: string;
  email?: string;
  [key: string]: unknown;
}

export interface StubQueryResult {
  data: unknown[] | unknown | null;
  error: { message: string; code?: string } | null;
}

export interface StubConfig {
  /** Authenticated user. If null, auth.getUser() returns an error. */
  user: StubUser | null;
  /** Auth error message (when user is null). */
  authError?: string;
  /** Per-table query results. Key is table name (e.g., 'RoseApiKey'). */
  queryResults?: Record<string, StubQueryResult>;
  /** Per-table insert results. Key is table name. */
  insertResults?: Record<string, StubQueryResult>;
  /** Per-table delete results. Key is table name. */
  deleteResults?: Record<string, StubQueryResult>;
  /** Captured boundary calls (populated by the stub). */
  captures?: BoundaryCapture[];
}

export interface BoundaryCapture {
  type: 'auth.getUser' | 'db.select' | 'db.insert' | 'db.delete';
  table?: string;
  token?: string;
  filters?: Record<string, unknown>;
  data?: unknown;
  timestamp: string;
}

interface ChainState {
  table: string;
  operation: 'select' | 'insert' | 'delete';
  filters: Record<string, unknown>;
  selectFields?: string;
  insertData?: unknown;
  orderField?: string;
  orderAscending?: boolean;
  isSingle?: boolean;
  resolved?: boolean;
}

function resolveChain(config: StubConfig, state: ChainState): StubQueryResult {
  // Guard against double-resolution
  if (state.resolved) {
    // Return cached result without adding another capture
    return getCachedResult(config, state);
  }
  state.resolved = true;
  const captures = config.captures ?? [];

  if (state.operation === 'select') {
    captures.push({
      type: 'db.select',
      table: state.table,
      filters: { ...state.filters },
      timestamp: new Date().toISOString(),
    });
    return config.queryResults?.[state.table] ?? { data: [], error: null };
  }

  if (state.operation === 'insert') {
    captures.push({
      type: 'db.insert',
      table: state.table,
      data: state.insertData,
      timestamp: new Date().toISOString(),
    });
    return config.insertResults?.[state.table] ?? {
      data: state.isSingle
        ? {
          id: 'generated-id',
          apiKey: 'a'.repeat(32),
          createdAt: new Date().toISOString(),
        }
        : [state.insertData],
      error: null,
    };
  }

  if (state.operation === 'delete') {
    captures.push({
      type: 'db.delete',
      table: state.table,
      filters: { ...state.filters },
      timestamp: new Date().toISOString(),
    });
    return config.deleteResults?.[state.table] ?? { data: null, error: null };
  }

  return { data: null, error: null };
}

function getCachedResult(config: StubConfig, state: ChainState): StubQueryResult {
  if (state.operation === 'select') {
    return config.queryResults?.[state.table] ?? { data: [], error: null };
  }
  if (state.operation === 'insert') {
    return config.insertResults?.[state.table] ?? {
      data: state.isSingle
        ? {
          id: 'generated-id',
          apiKey: 'a'.repeat(32),
          createdAt: new Date().toISOString(),
        }
        : [state.insertData],
      error: null,
    };
  }
  if (state.operation === 'delete') {
    return config.deleteResults?.[state.table] ?? { data: null, error: null };
  }
  return { data: null, error: null };
}

// deno-lint-ignore no-explicit-any
function createQueryChain(config: StubConfig, state: ChainState): any {
  // deno-lint-ignore no-explicit-any
  const chain: any = {};

  // .select(fields) - used after .from() or after .insert()
  chain.select = (fields?: string) => {
    state.selectFields = fields;
    // If we haven't set a specific operation yet (coming from .from()), set to select
    if (state.operation !== 'insert') {
      state.operation = 'select';
    }
    return createQueryChain(config, state);
  };

  // .insert(data)
  chain.insert = (data: unknown) => {
    state.insertData = data;
    state.operation = 'insert';
    return createQueryChain(config, state);
  };

  // .delete()
  chain.delete = () => {
    state.operation = 'delete';
    return createQueryChain(config, state);
  };

  // .eq(column, value)
  chain.eq = (column: string, value: unknown) => {
    state.filters[column] = value;
    return createQueryChain(config, state);
  };

  // .order(column, { ascending })
  chain.order = (column: string, opts?: { ascending?: boolean }) => {
    state.orderField = column;
    state.orderAscending = opts?.ascending ?? true;
    return createQueryChain(config, state);
  };

  // .single() - terminal, returns thenable with result
  chain.single = () => {
    state.isSingle = true;
    // Return a thenable that resolves lazily
    return {
      // deno-lint-ignore no-explicit-any
      then: (resolve?: (value: any) => any, reject?: (reason: any) => any) => {
        const result = resolveChain(config, state);
        return Promise.resolve(result).then(resolve, reject);
      },
    };
  };

  // .then() makes the chain thenable - only resolve when awaited
  // deno-lint-ignore no-explicit-any
  chain.then = (resolve?: (value: any) => any, reject?: (reason: any) => any) => {
    const result = resolveChain(config, state);
    return Promise.resolve(result).then(resolve, reject);
  };

  return chain;
}

export function createSupabaseStub(config: StubConfig) {
  if (!config.captures) config.captures = [];

  return {
    auth: {
      getUser: (token: string) => {
        config.captures!.push({
          type: 'auth.getUser',
          token,
          timestamp: new Date().toISOString(),
        });

        if (config.user) {
          return { data: { user: config.user }, error: null };
        }
        return {
          data: { user: null },
          error: {
            message: config.authError ?? 'Invalid token',
            status: 401,
          },
        };
      },
    },
    from: (table: string) => {
      const state: ChainState = {
        table,
        operation: 'select',
        filters: {},
      };
      return createQueryChain(config, state);
    },
  };
}
