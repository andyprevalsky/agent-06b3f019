import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

// Blueprint Feedback
export interface BlueprintFeedback {
  rating: number;
  issueType?: string;
  comment?: string;
  helpImprove: boolean;
}

// Find blueprint by goal
export async function findBlueprintByGoal(goal: string): Promise<{ id: string } | null> {
  const headers = getAuthHeaders();

  const response = await fetch(
    `${API_BASE_WITH_PATH}/blueprints/by-goal?goal=${encodeURIComponent(goal)}`,
    { headers },
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error('Failed to find blueprint');
  }

  return response.json();
}

// Submit feedback for a blueprint
export async function submitBlueprintFeedback(
  blueprintId: string,
  feedback: BlueprintFeedback & { agentId: string },
): Promise<void> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/blueprints/${blueprintId}/feedback`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(feedback),
  });

  if (!response.ok) {
    throw new Error('Failed to submit feedback');
  }
}
