import { missingGoogleScopes } from './googleScopes';

/** Keep granted scopes server-side while showing legacy grants as reconnectable. */
export function withGoogleScopeHealth<
  T extends {
    name: string;
    emailCredentials: Array<{
      scopes: string[];
      state: string;
      lastErrorReason: string | null;
    }>;
  },
>(integrations: T[]) {
  return integrations.map((integration) => ({
    ...integration,
    emailCredentials: integration.emailCredentials.map(({ scopes, ...credential }) => {
      const missing = integration.name === 'gmail' ? missingGoogleScopes(scopes) : [];
      return missing.length === 0
        ? credential
        : {
            ...credential,
            state: 'needs_reconnect',
            lastErrorReason: 'Reconnect Google to grant the current permissions.',
          };
    }),
  }));
}
