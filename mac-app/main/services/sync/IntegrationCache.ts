import { config } from '../../base/config';
import { AuthService } from '../auth';
import { logConsole, logConsoleError } from '../../base/logger';

interface Integration {
  name: string;
  status: string;
  config?: Record<string, unknown>;
}

interface CachedIntegrations {
  connected: Set<string>;
  all: Integration[];
  timestamp: number;
}

/**
 * Centralized cache for integration statuses.
 * Avoids multiple API calls to GET /api/integrations per sync cycle.
 *
 * Usage:
 *   const isConnected = await IntegrationCache.isConnected('telegram');
 *   const connectedList = await IntegrationCache.getConnected();
 */
export class IntegrationCache {
  private static cache: CachedIntegrations | null = null;
  private static readonly CACHE_TTL_MS = 30 * 1000; // 30 seconds
  private static fetchPromise: Promise<CachedIntegrations> | null = null;

  /**
   * Check if a specific integration is connected.
   */
  static async isConnected(integrationName: string): Promise<boolean> {
    const { connected } = await this.getIntegrations();
    return connected.has(integrationName);
  }

  /**
   * Get set of all connected integration names.
   */
  static async getConnected(): Promise<Set<string>> {
    const { connected } = await this.getIntegrations();
    return connected;
  }

  /**
   * Get full integration data for a specific integration.
   */
  static async getIntegration(integrationName: string): Promise<Integration | undefined> {
    const { all } = await this.getIntegrations();
    return all.find(i => i.name === integrationName);
  }

  /**
   * Invalidate cache to force fresh fetch on next call.
   * Call this after connecting/disconnecting an integration.
   */
  static invalidate(): void {
    this.cache = null;
    this.fetchPromise = null;
    logConsole('IntegrationCache', 'Cache invalidated');
  }

  /**
   * Get integrations (from cache or fresh fetch).
   * Uses request deduplication to avoid parallel fetches.
   */
  private static async getIntegrations(): Promise<CachedIntegrations> {
    const now = Date.now();

    // Return cached if still valid
    if (this.cache && (now - this.cache.timestamp) < this.CACHE_TTL_MS) {
      return this.cache;
    }

    // If fetch already in progress, wait for it
    if (this.fetchPromise) {
      return this.fetchPromise;
    }

    // Start new fetch
    this.fetchPromise = this.fetchIntegrations();

    try {
      const result = await this.fetchPromise;
      this.cache = result;
      return result;
    } finally {
      this.fetchPromise = null;
    }
  }

  /**
   * Fetch integrations from backend API.
   */
  private static async fetchIntegrations(): Promise<CachedIntegrations> {
    const session = await AuthService.getSession();
    if (!session) {
      logConsole('IntegrationCache', 'No session, returning empty');
      return { connected: new Set(), all: [], timestamp: Date.now() };
    }

    try {
      const response = await fetch(`${config.apiUrl}/api/integrations`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        logConsoleError('IntegrationCache', 'Failed to fetch integrations', response.statusText);
        // Return stale cache if available, otherwise empty
        return this.cache ?? { connected: new Set(), all: [], timestamp: Date.now() };
      }

      const data = await response.json() as { integrations?: Integration[] };
      const all = data.integrations ?? [];
      const connected = new Set(
        all.filter(i => i.status === 'CONNECTED').map(i => i.name)
      );

      logConsole('IntegrationCache', `Fetched ${all.length} integrations, ${connected.size} connected`);

      return { connected, all, timestamp: Date.now() };
    } catch (error) {
      logConsoleError('IntegrationCache', 'Error fetching integrations', error);
      // Return stale cache if available, otherwise empty
      return this.cache ?? { connected: new Set(), all: [], timestamp: Date.now() };
    }
  }
}
