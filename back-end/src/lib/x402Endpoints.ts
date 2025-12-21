/**
 * x402 Endpoint Discovery
 * 
 * Returns available x402 endpoints for API discoverability.
 * Included in successful responses so callers know what else they can do.
 */

// Base URL for constructing endpoint URLs (use env or default)
const BASE_URL = process.env.API_BASE_URL || 'https://api.roselabs.ai';

export interface EndpointParam {
  type: string;
  required: boolean;
  description: string;
  example?: string | number | boolean;
}

export interface X402Endpoint {
  url: string;
  method: string;
  description: string;
  price: string;
  auth: string;
  params?: Record<string, EndpointParam>;
  headers?: Record<string, EndpointParam>;
}

export interface X402Endpoints {
  topup: X402Endpoint;
  create_agent: X402Endpoint;
  agent_status: X402Endpoint;
}

/**
 * Get available x402 endpoints for discoverability
 * @param agentId - Optional agent ID for agent-specific endpoints
 */
export function getX402Endpoints(agentId?: string): X402Endpoints {
  return {
    topup: {
      url: `${BASE_URL}/api/x402/topup`,
      method: 'POST',
      description: 'Add credits to your wallet account. Payment amount becomes credits.',
      price: '$0.05 minimum payment',
      auth: 'x402 payment header required',
      headers: {
        'X-PAYMENT': {
          type: 'string',
          required: true,
          description: 'Base64-encoded x402 payment payload with EIP-3009 signature',
        },
      },
      params: {
        // No body params needed - payment amount from x402 header
      },
    },
    create_agent: {
      url: `${BASE_URL}/api/agents`,
      method: 'POST',
      description: 'Create a new Rose agent to accomplish a goal',
      price: '$0.10 per agent creation',
      auth: 'x402 payment header OR JWT token OR API key',
      headers: {
        'X-PAYMENT': {
          type: 'string',
          required: false,
          description: 'Base64-encoded x402 payment payload (if paying with x402)',
        },
        'Authorization': {
          type: 'string',
          required: false,
          description: 'Bearer token for JWT auth (alternative to x402)',
          example: 'Bearer eyJhbGc...',
        },
        'X-API-Key': {
          type: 'string',
          required: false,
          description: 'API key for internal auth (alternative to x402)',
        },
      },
      params: {
        goal: {
          type: 'string',
          required: true,
          description: 'The goal for the agent to accomplish',
          example: 'Find 10 AI startups in San Francisco',
        },
        model: {
          type: 'string',
          required: false,
          description: 'Model to use (defaults to rose-labs/rose-1)',
          example: 'rose-labs/rose-1',
        },
        reasoning_max_tokens: {
          type: 'number',
          required: false,
          description: 'Max tokens for reasoning (0 disables, default 256)',
          example: 2048,
        },
        tool_ids: {
          type: 'array',
          required: false,
          description: 'Array of custom tool IDs to enable for this agent',
          example: '[]',
        },
      },
    },
    agent_status: {
      url: agentId 
        ? `${BASE_URL}/api/x402/agents/${agentId}/status`
        : `${BASE_URL}/api/x402/agents/{agent_id}/status`,
      method: 'GET',
      description: 'Check agent status, progress, and recent messages',
      price: 'Free (no auth required)',
      auth: 'None - public endpoint',
      params: {
        agent_id: {
          type: 'string (path parameter)',
          required: true,
          description: 'The UUID of the agent to check',
          example: agentId || 'abc123-def456-...',
        },
      },
    },
  };
}

