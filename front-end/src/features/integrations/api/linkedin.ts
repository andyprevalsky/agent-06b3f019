/**
 * LinkedIn export sync endpoints (plan row I4). Split from ../api.ts, which is
 * at its line budget.
 *
 *   POST /api/agents                         spawn the export agent (cloud, execute phase)
 *   POST /api/integrations/linkedin/sync     {agent_id, account_id?} → record it as the
 *                                            account's export run; 409 = that account
 *                                            already has a live export agent
 */

import { createAgent } from '@/lib/api';
import { getClientSource } from '@/lib/clientSource';
import { getStoredSession } from '@/lib/supabase';

import { getAuthHeaders } from '../api';
import { API_BASE_URL, API_BASE_WITH_PATH } from '../config';

/**
 * POST /integrations/linkedin/sync answered 409: that LinkedIn account already
 * has a live export agent (`runningAgentId`). The agent this call just spawned
 * (`spawnedAgentId`) duplicates it.
 */
export class LinkedInExportRunningError extends Error {
  constructor(
    message: string,
    readonly runningAgentId: string | null,
    readonly spawnedAgentId: string,
  ) {
    super(message);
  }
}

/**
 * Spawn the LinkedIn export directly as a cloud agent (no chat routing: the
 * task is fully specified), then record it as the user's LinkedIn sync so
 * every client shows "Connecting" until that agent ends. `accountId` names
 * the LinkedIn account to export (retry); omitted = the default account,
 * which the agent moves to the account it finds itself signed into.
 */
export async function createLinkedInSyncAgentApi(accountId?: string): Promise<string> {
  const session = getStoredSession();
  const backendUrl = API_BASE_URL;
  const goal = `Download my LinkedIn data export and upload it to the platform.

Steps:
1. Use a browser agent to navigate to https://www.linkedin.com/mypreferences/d/download-my-data and request a full data export. Click "Request archive" to initiate.

After clicking Request archive, POST ${backendUrl}/api/integrations/linkedin/sync/phase with {"phase":"export_requested","account_id":"<your linkedin.com/in/ URL>","eta_sec":<seconds, only if LinkedIn states one>}. Each time you check and the archive isn't ready, report waiting_for_export. If the link expired or the export failed, report failed with an error. Upload to /api/integrations/linkedin/upload?account_id=<same URL>.

2. LinkedIn takes time to prepare the export (can be minutes to hours). Wait 10 minutes between checks. Use a browser agent to check my email inbox for an email from LinkedIn with subject containing "Your LinkedIn data archive is ready". Repeat checking every 10 minutes for up to 8 hours.

3. When the email arrives, use a browser agent to:
   - Open the email
   - Click the download link
   - Download the ZIP file from the LinkedIn download page

4. After downloading the ZIP file, use a claude code agent to upload it to the backend:
   curl -X POST ${backendUrl}/api/integrations/linkedin/upload -H "Authorization: Bearer ${session?.access_token}" -F "file=@/path/to/downloaded-linkedin-export.zip"`;

  const agent = await createAgent({ goal, source: getClientSource(), start_phase: 'execute' });

  const record =
    accountId === undefined
      ? { agent_id: agent.agent_id }
      : { agent_id: agent.agent_id, account_id: accountId };
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/linkedin/sync`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(record),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      error?: string;
      agent_id?: string;
    };
    const message = error.error ?? `Failed to record LinkedIn sync (HTTP ${response.status})`;
    if (response.status === 409) {
      throw new LinkedInExportRunningError(message, error.agent_id ?? null, agent.agent_id);
    }
    throw new Error(message);
  }
  return agent.agent_id;
}
