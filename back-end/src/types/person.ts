/**
 * Shared types for Person records and message histories
 */

/**
 * Standardized message structure for all messaging platforms
 * 
 * Each message history field (iMessageHistory, whatsappHistory, etc.)
 * is a JSON array of MessageRecord objects.
 */
export interface MessageRecord {
  from: string;      // Sender identifier (email, phone, username, etc.)
  to: string;        // Recipient identifier (email, phone, username, etc.)
  timestamp: string; // ISO 8601 timestamp (e.g., "2025-01-15T14:30:00Z")
  message: string;   // Message content/body
}

/**
 * Example usage:
 * 
 * const iMessageHistory: MessageRecord[] = [
 *   {
 *     from: "+19729777432",
 *     to: "+14155551234",
 *     timestamp: "2025-01-15T10:30:00Z",
 *     message: "Hey, how's it going?"
 *   },
 *   {
 *     from: "+14155551234",
 *     to: "+19729777432",
 *     timestamp: "2025-01-15T10:32:00Z",
 *     message: "Great! Just finished the meeting."
 *   }
 * ];
 */

