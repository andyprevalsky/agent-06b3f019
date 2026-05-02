/**
 * Type declarations for x402 payment modules
 */

declare module 'x402-express' {
  import { RequestHandler } from 'express';

  interface RouteConfig {
    price: string;
    network: string;
    config?: {
      description?: string;
      mimeType?: string;
      maxTimeoutSeconds?: number;
      inputSchema?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      customPaywallHtml?: string;
      resource?: string;
    };
  }

  interface Facilitator {
    url?: string;
  }

  export function paymentMiddleware(
    receivingAddress: string,
    routes: Record<string, RouteConfig>,
    facilitator?: Facilitator | Record<string, unknown>
  ): RequestHandler;

  export enum Network {
    BASE = 'base',
    BASE_SEPOLIA = 'base-sepolia',
    SOLANA = 'solana',
    SOLANA_DEVNET = 'solana-devnet',
  }
}

declare module '@coinbase/x402' {
  export const facilitator: {
    url?: string;
    [key: string]: unknown;
  };
}
