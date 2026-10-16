"""Prompt for the Lantern-backed people_search tool."""

PROMPT = """Finds people and retrieves source profiles through Lantern People, returning normalized profiles, source record IDs, retrieval dates and the original source evidence.

Use mode="discover" for a list and mode="enrich" for one profile. Query supplies literal profile keywords, not a semantic instruction: put job titles, employers and geography in titles, companies and location. Supply location_kind and country_code when geography is known. Verify compound requirements against the returned evidence; title or keyword matches alone do not establish qualification.

To enrich a selected person, source_record_id is required: pass their source.record_id and the returned generation when available. Enrichment retrieves that exact source profile and does not accept discovery constraints. Keyword matches do not establish exact identity. Fields defines the requested attributes; unavailable values stay null. Profile retrieval does not reveal email addresses or phone numbers automatically.

Lantern is the default and executes every request; legacy provider names also route to Lantern. There is no provider fallback. Correct ambiguous company/location input using the returned error details. Honor rate-limit retryAfterSeconds; a plan error needs an account action. Continue a discover request only with the exact returned next_cursor and the same query and constraints. Use grep source="network" when the answer is in the user's own contacts. For quick public-web facts, web_search is sufficient."""
