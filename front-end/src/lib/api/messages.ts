import { getSession } from '../supabase';
import { API_BASE_WITH_PATH, getAuthHeaders } from './client';
import type { FilePointer, Message } from './types';

// Post a message to an agent
/** Where a user message goes: the agent itself, or one of its running browser tasks. */
export interface MessageTarget {
  browserTaskId: string;
}

export async function postMessage(
  agentId: string,
  message: string,
  attachments?: FilePointer[],
  target?: MessageTarget,
): Promise<Message> {
  const headers = getAuthHeaders();

  const body: { message: string; attachments?: FilePointer[]; browser_task_id?: string } = {
    message,
  };
  if (attachments && attachments.length > 0) {
    body.attachments = attachments;
  }
  if (target) body.browser_task_id = target.browserTaskId;

  const response = await fetch(`${API_BASE_WITH_PATH}/agents/${agentId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to post message');
  }

  return await response.json();
}

// Upload a file attachment to Supabase storage (not agent-scoped)
// Files are stored under userId and can be reused across agents
export async function uploadAttachment(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<FilePointer> {
  const session = getSession();
  const token = session?.access_token;

  if (!token) {
    throw new Error('Not authenticated');
  }

  const formData = new FormData();
  formData.append('file', file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        const progress = Math.round((event.loaded / event.total) * 100);
        onProgress(progress);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response = JSON.parse(xhr.responseText);
          resolve(response.file_pointer);
        } catch {
          reject(new Error('Invalid response from server'));
        }
      } else {
        try {
          const error = JSON.parse(xhr.responseText);
          reject(new Error(error.error || 'Failed to upload attachment'));
        } catch {
          reject(new Error('Failed to upload attachment'));
        }
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error('Network error during upload'));
    });

    xhr.open('POST', `${API_BASE_WITH_PATH}/upload`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.send(formData);
  });
}

// Get a signed URL for downloading a large attachment
export async function getAttachmentUrl(
  agentId: string,
  fileId: string,
  storagePath: string,
): Promise<string> {
  const headers = getAuthHeaders();

  const response = await fetch(
    `${API_BASE_WITH_PATH}/agents/${agentId}/attachments/${fileId}/url?storage_path=${encodeURIComponent(storagePath)}`,
    { headers },
  );

  if (!response.ok) {
    throw new Error(`Failed to get attachment URL (${response.status})`);
  }

  const data = await response.json();
  return data.signed_url;
}
