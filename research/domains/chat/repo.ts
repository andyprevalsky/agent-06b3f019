/**
 * Chat domain data access.
 *
 * The chat proxy does not read or write persistent state — every inbound
 * request is forwarded to the completions edge function. This file exists to
 * preserve the layered architecture's uniform shape; data access, if ever
 * added, belongs here.
 */

export {};
