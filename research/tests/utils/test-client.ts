/**
 * Test HTTP Client for Rose Benchmarking Suite
 */

export interface RequestOptions {
  headers?: Record<string, string>;
  body?: any;
  method?: string;
}

export class TestClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    // Default to local Supabase (supabase functions serve)
    // Override with BASE_URL env var for testing against prod
    this.baseUrl = baseUrl || Deno.env.get('BASE_URL') || 'http://localhost:54321/functions/v1';
  }

  async request(path: string, options: RequestOptions = {}) {
    const url = `${this.baseUrl}${path}`;
    const method = options.method || 'GET';
    
    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    };

    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    try {
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
    } catch (error) {
      console.error(`Request failed: ${method} ${url}`, error);
      throw error;
    }
  }

  async get(path: string, options: RequestOptions = {}) {
    return this.request(path, { ...options, method: 'GET' });
  }

  async post(path: string, body: any, options: RequestOptions = {}) {
    return this.request(path, { ...options, method: 'POST', body });
  }

  async delete(path: string, body?: any, options: RequestOptions = {}) {
    return this.request(path, { ...options, method: 'DELETE', body });
  }
}

export const testClient = new TestClient();

