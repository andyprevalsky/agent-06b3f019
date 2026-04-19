/**
 * messaging-core: repo layer
 *
 * The coordinator transforms in-memory NormalizedMessage batches produced by
 * platform watchers — it doesn't read or write its own persistent store.
 * Persistent integration state lives under sibling domains (messaging-imessage,
 * messaging-telegram, messaging-whatsapp) and under main/services/sync/.
 *
 * This file exists to keep the layer contract uniform across every domain
 * (types / config / repo / service / runtime). If messaging-core ever needs
 * its own data access, add it here; no other layer should read from disk or
 * from the backend directly.
 */

export {};
