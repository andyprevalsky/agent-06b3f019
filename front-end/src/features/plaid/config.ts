import { BACKEND_BASE_URL } from '@/lib/backendUrl';

export const API_BASE_URL = BACKEND_BASE_URL;
export const API_BASE_WITH_PATH = `${API_BASE_URL}/api`;

/**
 * LocalStorage key holding the Plaid `link_token` while the user is mid-flow
 * through an OAuth-bank redirect. The OAuth-return page reads this back and
 * resumes Link with `receivedRedirectUri` so the user does not have to retype
 * credentials.
 */
export const PLAID_OAUTH_LINK_TOKEN_STORAGE_KEY = 'rose:plaid:oauth:link_token';

/**
 * In-app route that Plaid redirects OAuth banks back to.
 * Must be registered in the Plaid Dashboard (Team Settings -> API -> Allowed
 * redirect URIs) for the relevant environment.
 */
export const PLAID_OAUTH_REDIRECT_PATH = '/plaid-oauth-redirect';
