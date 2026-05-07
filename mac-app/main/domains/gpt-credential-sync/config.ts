import os from 'os';
import path from 'path';

export { RSA_PUBLIC_KEY_PEM } from '../claude-credential-sync/config';

/** Codex CLI auth file written by `codex login` for ChatGPT accounts. */
export const CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');

/** Backend endpoint for encrypted Codex auth upload. */
export const GPT_CREDENTIAL_UPLOAD_PATH = '/api/integrations/gpt-code/credentials/upload';
