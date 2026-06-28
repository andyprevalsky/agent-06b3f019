"""Prompt for people_search tool."""

PROMPT = """Finds or enriches real people on the public web via dedicated people-search providers (Exa and Parallel), returning normalized profiles with provenance and confidence.

Reach for this when web_search is insufficient for a people goal: when you need depth (a field-level profile for a specific person, via mode="enrich") or comprehensiveness (a broad list of people matching a role, company, geography, or seniority, via mode="discover"). For a quick one-off people fact, web_search is fine.

Pick the provider explicitly: Exa is strongest for depth/enrichment (structured work and education history); Parallel is strongest for broad discovery (high recall). If the chosen provider returns insufficient data, re-call with the other provider. On a provider rate-limit or error the tool auto-retries the other provider. For mode="enrich", pass fields to define exactly which attributes you want back. Use grep source="network" instead when the answer is in the user's OWN contacts. Results are best-effort with provenance, so verify load-bearing facts before acting on them."""
