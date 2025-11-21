import type { MacContact, OptionalProperty } from 'node-mac-contacts';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const macContacts = require('node-mac-contacts') as {
  getAllContacts: (props?: OptionalProperty[]) => MacContact[];
  getAuthStatus?: () => string;
};

export interface ContactRecord {
  identifier: string;
  firstName: string;
  lastName: string;
  middleName?: string;
  nickname?: string;
  company?: string;
  jobTitle?: string;
  department?: string;
  phoneNumbers: string[];
  emails: string[];
}

export class ContactsReaderNative {
  private static cache: Map<string, ContactRecord> | null = null;
  private static lastLoadedAt = 0;
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  static async readContacts(forceRefresh = false): Promise<Map<string, ContactRecord>> {
    if (!forceRefresh && this.cache && Date.now() - this.lastLoadedAt < this.CACHE_TTL_MS) {
      return this.cache;
    }

    try {
      console.log('[ContactsReaderNative] 🔍 Loading contacts via node-mac-contacts...');
      const authStatus = macContacts.getAuthStatus?.();
      if (authStatus) {
        console.log(`[ContactsReaderNative] Contacts permission status: ${authStatus}`);
      }

      const props: OptionalProperty[] = [
        'jobTitle',
        'departmentName',
        'organizationName',
        'middleName',
      ];

      const contacts = macContacts.getAllContacts(props) || [];
      // Dump every contact object as full JSON per row to a local text file for debugging
      try {
        const fs = require('fs');
        const path = require('path');
        const dumpPath = path.join(process.cwd(), 'contacts_dump.txt');
        const lines = contacts.map(contact => JSON.stringify(contact));
        fs.writeFileSync(dumpPath, lines.join('\n'), 'utf-8');
        console.log(`[ContactsReaderNative] Dumped all contact objects (one per row) to ${dumpPath}`);
      } catch (err) {
        console.warn('[ContactsReaderNative] Failed to dump contacts to text file:', err);
      }
      console.log(`[ContactsReaderNative] Retrieved ${contacts.length} contacts from CNContactStore`);

      const map = new Map<string, ContactRecord>();
      let contactsWithPhones = 0;
      let contactsWithEmails = 0;

      for (const contact of contacts) {
        const record: ContactRecord = {
          identifier: contact.identifier,
          firstName: contact.firstName || '',
          lastName: contact.lastName || '',
          middleName: contact.middleName || undefined,
          nickname: contact.nickname || undefined,
          company: contact.organizationName || undefined,
          jobTitle: contact.jobTitle || undefined,
          department: contact.departmentName || undefined,
          phoneNumbers: (contact.phoneNumbers || [])
            .filter(Boolean)
            .map((phone: string) => this.normalizePhone(phone)),
          emails: (contact.emailAddresses || [])
            .filter(Boolean)
            .map((email: string) => email.trim())
            .filter(Boolean),
        };

        if (record.phoneNumbers.length > 0) contactsWithPhones++;
        if (record.emails.length > 0) contactsWithEmails++;

        this.addRecordToMap(map, record);
      }

      console.log(
        `[ContactsReaderNative] Indexed ${map.size} identifiers (${contactsWithPhones} contacts with phones, ${contactsWithEmails} with emails)`
      );

      const sampleRecords: ContactRecord[] = [];
      const seenIdentifiers = new Set<string>();
      for (const record of map.values()) {
        const key = record.identifier || `${record.firstName}-${record.lastName}-${record.phoneNumbers[0] || ''}`;
        if (seenIdentifiers.has(key)) continue;
        seenIdentifiers.add(key);
        sampleRecords.push(record);
        if (sampleRecords.length >= 5) break;
      }

      if (sampleRecords.length) {
        console.log('[ContactsReaderNative] 📋 Sample contacts:');
        sampleRecords.forEach((record, index) => {
          console.log(
            `  #${index + 1}: id=${record.identifier || 'n/a'} name="${record.firstName} ${record.lastName}". phones=${record.phoneNumbers.length
            } emails=${record.emails.length} company=${record.company || 'n/a'}`
          );
        });
      }

      this.cache = map;
      this.lastLoadedAt = Date.now();
      return map;
    } catch (error) {
      console.error('[ContactsReaderNative] ❌ Failed to load contacts:', error);
      throw error;
    }
  }

  static lookupContact(
    identifier: string,
    contactMap: Map<string, ContactRecord>
  ): ContactRecord | undefined {
    if (!identifier) return undefined;

    const trimmed = identifier.trim();
    const normalized = this.normalizeIdentifier(trimmed);

    return (
      contactMap.get(normalized) ||
      contactMap.get(trimmed.toLowerCase()) ||
      contactMap.get(trimmed)
    );
  }

  private static addRecordToMap(map: Map<string, ContactRecord>, record: ContactRecord) {
    const register = (key: string) => {
      if (!key) return;
      if (!map.has(key)) {
        map.set(key, record);
      }
    };

    register(record.identifier);

    for (const phone of record.phoneNumbers) {
      const normalized = this.normalizePhone(phone);
      register(normalized);
      register(phone.trim());
    }

    for (const email of record.emails) {
      register(email.toLowerCase());
    }
  }

  private static normalizeIdentifier(identifier: string): string {
    if (identifier.includes('@')) {
      return identifier.trim().toLowerCase();
    }
    return this.normalizePhone(identifier);
  }

  private static normalizePhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (!digits) return phone.trim();

    // Remove leading 1 for US numbers
    let normalized = digits;
    if (normalized.length === 11 && normalized.startsWith('1')) {
      normalized = normalized.slice(1);
    }

    if (normalized.length === 10) {
      normalized = `+1${normalized}`;
    } else if (!normalized.startsWith('+')) {
      normalized = `+${normalized}`;
    }

    return normalized;
  }
}

