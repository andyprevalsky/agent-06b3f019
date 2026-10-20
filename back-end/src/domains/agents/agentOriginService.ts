/**
 * Agent origin device (C14 local code agents): the Rose Mac app that started a
 * root agent. Recorded at create time so a code agent in that tree may run on
 * that Mac; web/PWA/SMS roots and sub-agents never record one.
 */
import { findOwnedLocalDevice } from '../../providers/localDevices/store';
import type { CreateAgentBody } from './types';

/** The Mac that started this root agent; nothing for web/PWA/SMS roots and sub-agents. */
export async function originDeviceFields(
  body: Pick<CreateAgentBody, 'source'>,
  userId: string,
  isSubAgent: boolean,
  header: string | undefined
): Promise<{ originDeviceId?: string }> {
  if (isSubAgent || body.source !== 'MAC_APP' || header === undefined || header === '') {
    return {};
  }
  const device = await findOwnedLocalDevice(header, userId);
  return device === null ? {} : { originDeviceId: device.id };
}
