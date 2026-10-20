/**
 * Local devices domain types (C14: Rose Mac app devices for local code agents).
 */
import { z } from 'zod';

/** POST /api/local-devices/register — sent by the Mac app's main process. */
export const registerDeviceSchema = z.object({
  device_id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  platform: z.string().trim().min(1).max(32).optional(),
  app_version: z.string().trim().max(64).optional(),
});

export type RegisterDeviceBody = z.infer<typeof registerDeviceSchema>;

export interface LocalDeviceView {
  device_id: string;
  name: string;
  platform: string;
  app_version: string | null;
  connected: boolean;
  last_seen_at: string;
}

export interface AgentTargetView {
  available: boolean;
  reason?: string;
  device_id: string | null;
  device_name: string | null;
  message?: string;
}
