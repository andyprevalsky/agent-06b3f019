import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

/**
 * The user's persona is their existing custom system prompt
 * (`User.customSystemPrompt`, edited in Settings → Customization as the
 * "Personality Prompt"). The Voice app reads and writes the same field.
 */
export async function fetchPersona(): Promise<string> {
  const response = await fetch(`${API_BASE_WITH_PATH}/user-settings`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`Failed to load persona (${response.status})`);
  const data = (await response.json()) as { customSystemPrompt?: string | null };
  return data.customSystemPrompt ?? '';
}

export async function savePersona(persona: string): Promise<void> {
  const response = await fetch(`${API_BASE_WITH_PATH}/user-settings`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify({ customSystemPrompt: persona.trim() === '' ? null : persona }),
  });
  if (!response.ok) throw new Error(`Failed to save persona (${response.status})`);
}
