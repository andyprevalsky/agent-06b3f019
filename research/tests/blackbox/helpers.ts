/**
 * Shared blackbox test helpers for research edge functions.
 *
 * Provides:
 * - TestClient: HTTP client for calling edge functions
 * - getTestJwt(): Obtains a valid Supabase JWT via admin user creation + password sign-in
 * - seedApiKey(): Creates a RoseApiKey row directly via Supabase REST API
 * - cleanupTestData(): Deletes all test data created during the run
 */

// ---------------------------------------------------------------------------
// Test HTTP client
// ---------------------------------------------------------------------------

export interface RequestOptions {
  headers?: Record<string, string>;
  body?: unknown;
  method?: string;
}

export interface TestResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  // deno-lint-ignore no-explicit-any
  data: any;
}

export class TestClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ||
      Deno.env.get('BASE_URL') ||
      'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1';
  }

  async request(path: string, options: RequestOptions = {}): Promise<TestResponse> {
    const url = `${this.baseUrl}${path}`;
    const method = options.method || 'GET';

    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    };

    if (options.body !== undefined) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);

    let data;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      data,
    };
  }

  post(path: string, body: unknown, options: RequestOptions = {}): Promise<TestResponse> {
    return this.request(path, { ...options, method: 'POST', body });
  }

  delete(path: string, body?: unknown, options: RequestOptions = {}): Promise<TestResponse> {
    return this.request(path, { ...options, method: 'DELETE', body });
  }

  get(path: string, options: RequestOptions = {}): Promise<TestResponse> {
    return this.request(path, { ...options, method: 'GET' });
  }
}

export const testClient = new TestClient();

// ---------------------------------------------------------------------------
// Supabase config
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://kzlurqihzaolhzsbkctf.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU';

const TEST_EMAIL_PREFIX = 'bbx-delete-api-key';
const TEST_PASSWORD = 'blackbox-test-pw-xK9mQ2';

// ---------------------------------------------------------------------------
// JWT acquisition via Supabase admin API
// ---------------------------------------------------------------------------

/** Track created user IDs for cleanup. */
const _createdUserIds: string[] = [];
/** Track seeded API key IDs for cleanup. */
const _createdApiKeyIds: string[] = [];

let _cachedJwt: string | null = null;
let _cachedUserId: string | null = null;

/**
 * Creates a Supabase auth user via admin API, signs in via password, and returns the JWT.
 * Caches the result for the lifetime of the test process.
 *
 * Falls back to the SUPABASE_JWT env var if set.
 */
export async function getTestJwt(): Promise<string> {
  const envJwt = Deno.env.get('SUPABASE_JWT');
  if (envJwt) return envJwt;

  if (_cachedJwt) return _cachedJwt;

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required to create test users');
  }

  // Step 1: Create a test user via admin API
  const email = `${TEST_EMAIL_PREFIX}-${Date.now()}-${
    Math.random().toString(36).slice(2, 6)
  }@test.roselabs.ai`;

  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({
      email,
      password: TEST_PASSWORD,
      email_confirm: true,
    }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Failed to create test user: ${createRes.status} ${errText}`);
  }

  const userData = await createRes.json();
  _cachedUserId = userData.id;
  _createdUserIds.push(userData.id);

  // Step 2: Sign in with password to get JWT
  const signInRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });

  if (!signInRes.ok) {
    const errText = await signInRes.text();
    throw new Error(`Failed to sign in test user: ${signInRes.status} ${errText}`);
  }

  const signInData = await signInRes.json();
  const jwt = signInData.access_token;

  if (!jwt) {
    throw new Error('Sign-in succeeded but no access_token in response');
  }

  _cachedJwt = jwt;
  return jwt;
}

/** Returns the Supabase user ID of the test user (created by getTestJwt). */
export function getTestUserId(): string {
  if (!_cachedUserId) throw new Error('getTestJwt() must be called first');
  return _cachedUserId;
}

// ---------------------------------------------------------------------------
// API Key seeding via Supabase REST API
// ---------------------------------------------------------------------------

/**
 * Creates a RoseApiKey row directly via the Supabase REST API.
 * The generate-api-key edge function has a known issue where the DB `id` column
 * lacks a default, so we seed keys directly.
 */
export async function seedApiKey(
  userId: string,
  namePrefix: string,
): Promise<{ id: string; apiKey: string }> {
  const id = crypto.randomUUID();
  const apiKey = crypto.randomUUID().replace(/-/g, '');
  const name = `${namePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/RoseApiKey`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ id, userId, apiKey, name }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to seed API key: ${res.status} ${errText}`);
  }

  const data = await res.json();
  _createdApiKeyIds.push(data[0].id);
  return { id: data[0].id, apiKey: data[0].apiKey };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Deletes all test data created during this run: API keys and auth users.
 * Call this in a final cleanup test step.
 */
export async function cleanupTestData(): Promise<void> {
  // Clean up API keys first (they reference userId)
  for (const keyId of _createdApiKeyIds) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/RoseApiKey?id=eq.${keyId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: SUPABASE_SERVICE_ROLE_KEY,
        },
      });
      // Consume response body to avoid Deno leak detection
      await res.text();
    } catch {
      // Best-effort cleanup
    }
  }
  _createdApiKeyIds.length = 0;

  // Clean up auth users
  for (const userId of _createdUserIds) {
    // Also clean any remaining API keys for this user
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/RoseApiKey?userId=eq.${userId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: SUPABASE_SERVICE_ROLE_KEY,
        },
      });
      await res.text();
    } catch {
      // Best-effort
    }

    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: SUPABASE_SERVICE_ROLE_KEY,
        },
      });
      await res.text();
    } catch {
      // Best-effort cleanup
    }
  }
  _createdUserIds.length = 0;
  _cachedJwt = null;
  _cachedUserId = null;
}
