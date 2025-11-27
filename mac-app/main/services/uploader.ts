import { BrowserWindow } from 'electron';
import { config } from '../base/config';
import { Crypto } from '../base/crypto';
import type {
  UploadResult,
  IMessageData,
  IMessageUploadContact,
  IMessageUploadMessage,
  IMessageUploadPayload,
} from '../../shared/types/ipc';

const buildIMessagePayload = (data: IMessageData[] | IMessageUploadContact[]): IMessageUploadPayload => {
  if (!Array.isArray(data)) {
    return { contacts: [] };
  }

  const isAlreadyStructured = (item: any): item is IMessageUploadContact =>
    item && typeof item === 'object' && Array.isArray(item.messages);

  if (data.every(isAlreadyStructured)) {
    return { contacts: data as IMessageUploadContact[] };
  }

  const contactMap = new Map<string, IMessageUploadContact>();

  (data as IMessageData[]).forEach((msg) => {
    const handle = (msg.contact_id || '').trim();
    if (!handle) return;

    const isEmail = handle.includes('@');
    let contact = contactMap.get(handle);

    if (!contact) {
      contact = {
        contact_id: handle,
        contact_name: msg.contact_name || null,
        phoneNumber: isEmail ? null : handle,
        email: msg.contact_email || (isEmail ? handle : null),
        firstName: msg.contact_firstName || null,
        lastName: msg.contact_lastName || null,
        company: msg.contact_company || null,
        title: msg.contact_title || null,
        emailAddresses: msg.contact_emailAddresses || [],
        messages: [],
      };
      contactMap.set(handle, contact);
    } else {
      contact.contact_name = contact.contact_name || msg.contact_name || null;
      contact.firstName = contact.firstName || msg.contact_firstName || null;
      contact.lastName = contact.lastName || msg.contact_lastName || null;
      contact.company = contact.company || msg.contact_company || null;
      contact.title = contact.title || msg.contact_title || null;
      if (!contact.email && (msg.contact_email || isEmail)) {
        contact.email = msg.contact_email || (isEmail ? handle : null);
      }
      if (msg.contact_emailAddresses?.length) {
        const existingEmails = new Set(contact.emailAddresses || []);
        for (const email of msg.contact_emailAddresses) {
          if (!existingEmails.has(email)) {
            existingEmails.add(email);
            contact.emailAddresses = Array.from(existingEmails);
          }
        }
      }
    }

    const messageEntry: IMessageUploadMessage = {
      id: msg.id,
      text: msg.text,
      date: msg.date,
      is_from_me: msg.is_from_me,
      contactHandle: handle,
    };
    contact.messages.push(messageEntry);
  });

  return { contacts: Array.from(contactMap.values()) };
};

export class Uploader {
  static async uploadData(
    integrationType: string,
    data: any,
    accessToken: string,
    window: BrowserWindow | null
  ): Promise<UploadResult> {
    try {
      const isIMessage = integrationType === 'imessage';
      let response: Response;
      
      // Upload with progress
      window?.webContents.send('upload:progress', {
        type: integrationType,
        percent: 50,
      });
      
      if (isIMessage) {
        const payload = buildIMessagePayload(data as IMessageData[] | IMessageUploadContact[]);
        const body: IMessageUploadPayload = {
          contacts: payload.contacts,
        };
        
        response = await fetch(`${config.apiUrl}/api/integrations/imessage/upload`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } else if (integrationType === 'chrome_cookies') {
        // Cookies go to the dedicated cookie endpoint
        const { encrypted, iv, key } = Crypto.encrypt(data);

        const formData = new FormData();
        formData.append('data', encrypted);
        formData.append('iv', iv);
        formData.append('key', key);
        
        response = await fetch(`${config.apiUrl}/api/integrations/cookies/upload`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
          body: formData,
        });
      } else {
        const { encrypted, iv, key } = Crypto.encrypt(data);

        const formData = new FormData();
        formData.append('integrationType', integrationType);
        formData.append('data', encrypted);
        formData.append('iv', iv);
        formData.append('key', key);
        
        response = await fetch(`${config.apiUrl}/api/integrations/upload`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
          body: formData,
        });
      }
      
      window?.webContents.send('upload:progress', {
        type: integrationType,
        percent: 100,
      });
      
      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }
      
      return { success: true };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

