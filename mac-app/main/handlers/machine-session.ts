import { AuthService } from '../services/auth';
import {
  IMPERSONATED_MACHINE_DATA_MESSAGE,
  sessionForLocalMachineData,
} from '../domains/auth/impersonation';

export async function getLocalMachineDataSession(): Promise<{
  session: Awaited<ReturnType<typeof AuthService.getSession>>;
  error: string | null;
}> {
  const current = await AuthService.getSession();
  if (current === null) return { session: null, error: 'Not authenticated' };
  const session = sessionForLocalMachineData(current);
  return {
    session,
    error: session === null ? IMPERSONATED_MACHINE_DATA_MESSAGE : null,
  };
}
