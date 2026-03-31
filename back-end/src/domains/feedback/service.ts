import { createFeedback } from './repo';

export async function submitFeedback(userId: string, feedback: string): Promise<void> {
  await createFeedback(userId, feedback.trim());
}
