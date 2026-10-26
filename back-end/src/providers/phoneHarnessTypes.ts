export interface PhoneHarnessDevice {
  id: string;
  label: string;
  state: string;
}
export interface PhoneHarnessSession {
  id: string;
  state: string;
  /** Retained to fail closed when loading a persisted or incomplete receipt. */
  platform: string | null;
  kind: string | null;
  expiresAt: number | null;
  control: { url: string; token: string; expiresAt: number | null } | null;
  requestKey: string | null;
  cleanupComplete: boolean;
  closeRequested: boolean;
}
export interface PhoneHarnessReceipt {
  session: PhoneHarnessSession | null;
  cleanupComplete: boolean;
  requestKey: string;
}
export type PhoneHarnessOutcome = 'rejected' | 'unknown';
export class PhoneHarnessError extends Error {
  readonly name = 'PhoneHarnessError';
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly code: string,
    public readonly outcome: PhoneHarnessOutcome,
    public readonly unsupported = false
  ) {
    super(message);
  }
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      outcome: this.outcome,
      unsupported: this.unsupported,
    };
  }
}
export interface PhoneHarnessClientOptions {
  apiKey?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}
