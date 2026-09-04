export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export type ExternalHttpRequestBody = {
  method: HttpMethod;
  url: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
};

export type ExternalHttpResponseBody = {
  ok: boolean;
  status: number;
  status_text: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  body_encoding: 'json' | 'text' | 'base64';
  content_type: string | null;
  elapsed_ms: number;
  attempts: number;
};
