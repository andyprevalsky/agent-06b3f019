/**
 * People domain config — constants, defaults.
 */

/** Default and max page size for the people list endpoint. */
export const DEFAULT_PEOPLE_LIMIT = 2000;
export const MAX_PEOPLE_LIMIT = 2000;

/** Default search limit for semantic search. */
export const DEFAULT_SEARCH_LIMIT = 5;

/** Default message limit when fetching messages for a person. */
export const DEFAULT_MESSAGE_LIMIT = 50;

/** Maximum age window when a caller explicitly requests one. */
export const MAX_RECENT_DAYS = 30;

/** Default limit for recent messages. */
export const DEFAULT_RECENT_LIMIT = 200;
