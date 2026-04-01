import { createFeedback } from './repo';

export async function submitFeedback(userId: string, feedback: string): Promise<void> {
  const trimmed = feedback.trim();
  if (trimmed === '') {
    throw new Error('Feedback must not be empty');
  }
  await createFeedback(userId, trimmed);
}
