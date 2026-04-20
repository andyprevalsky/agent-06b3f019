/**
 * Types for the contacts-reader-native domain.
 *
 * Encapsulates the shape of a single macOS address-book contact after
 * `node-mac-contacts` has been normalized into our domain's canonical
 * representation (phones rewritten to E.164, emails trimmed, optionals
 * collapsed to `undefined`).
 */

/** Canonical contact record produced by the reader. */
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
