export interface CreateCallRequest {
  to: string;
  system_prompt: string;
  output_schema: Record<string, unknown>;
}

export interface VapiCallResponse {
  id: string;
  status: string;
  [key: string]: unknown;
}
