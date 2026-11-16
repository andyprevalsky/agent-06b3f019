/** Longest preview title; the image sizes titles up to this length to fit three lines. */
export const MAX_PREVIEW_TITLE_CHARACTERS = 80;

/** Agent ids are UUIDs; anything else never reaches the database. */
export const AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
