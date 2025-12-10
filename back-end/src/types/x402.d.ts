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
      inputSchema?: Record<string, any>;
      outputSchema?: Record<string, any>;
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
    facilitator?: Facilitator | any
  ): RequestHandler;
  
  export enum Network {
    BASE = 'base',
    BASE_SEPOLIA = 'base-sepolia',
    SOLANA = 'solana',
    SOLANA_DEVNET = 'solana-devnet',
  }
}

declare module '@coinbase/x402' {
  export const facilitator: any;
}

