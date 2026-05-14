export interface CreateCallRequest {
  to: string;
  system_prompt: string;
  output_schema: Record<string, unknown>;
  idempotency_key?: string;
  user_id?: string;
}

export interface VapiCallResponse {
  id: string;
  status: string;
  [key: string]: unknown;
}
