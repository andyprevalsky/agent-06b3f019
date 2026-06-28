# People Search For Explore Agents

## Summary
A read-only `people_search` tool for explore agents that finds or enriches real
people on the public web using two dedicated providers (Exa and Parallel). The
model chooses both the operation and the provider explicitly; routing is the
(mode × provider) matrix. Sync-only and sub-minute.

## Tool Interface (explore agents only)
```json
{
  "tool": "people_search",
  "query": "natural-language people request",
  "mode": "enrich | discover",
  "provider": "exa | parallel",
  "limit": 10,
  "fields": ["current_title", "current_company", "location", "linkedin_url"]
}
```

- `mode` (required): `enrich` resolves ONE specific person into a field-level
  profile; `discover` returns a LIST of people matching criteria. No `auto`.
- `provider` (required): `exa` or `parallel`. No `auto`.
- `limit`: `discover` ONLY; 1–25, default 10. Rejected for `enrich`.
- `fields`: `enrich` ONLY; defines the output attributes. No imposed default —
  omitted means the provider's native profile. Rejected for `discover`.
- A strict `model_validator` enforces the limit/fields ↔ mode pairing.

## When to use (vs web_search)
Use `people_search` when web_search is insufficient for a people goal: you need
depth (a field-level profile, `enrich`) or comprehensiveness (a broad list,
`discover`). For a quick one-off people fact, web_search is fine. Use
`grep source="network"` when the answer is in the user's OWN contacts.

## Routing (mode × provider)
| | exa | parallel |
| --- | --- | --- |
| **enrich** | Exa Search `category=people`, small candidate pool, optional `outputSchema` for `fields` | Entity Search, tight objective (best-effort `fields`; warns on unavailable) |
| **discover** | Exa Search `category=people`, `numResults=limit` (enriched rows) | Entity Search, `match_limit` (≥5 floor, trimmed to `limit`) |

- **Provider strengths:** Exa = depth/enrichment (structured work + education
  history); Parallel = broad discovery (high recall, shallow rows).
- **No FindAll:** Parallel's deep, cited enrichment (FindAll) is async and
  multi-minute, which violates the sub-minute tool budget, so it is not wired.

## Fallback
- **Automatic:** on a provider rate-limit/error (or missing key), retry the
  OTHER provider once; `providers_attempted` + a `warnings` entry record it.
- **Model-driven:** if results are insufficient, the model re-calls with the
  other `provider`. Empty (non-error) results do NOT trigger auto-fallback.

## Endpoints (verified)
- Exa: `POST https://api.exa.ai/search`, header `x-api-key`. Body
  `{query, category:"people", type:"auto", numResults, contents:{highlights:true}, outputSchema?}`.
- Parallel: `POST https://api.parallel.ai/v1beta/findall/entity-search`, header
  `x-api-key`. Body `{entity_type:"people", objective, match_limit}` (5–1000).

## Normalized Output
```json
{
  "query": "...",
  "mode_used": "enrich | discover",
  "provider_used": "exa | parallel",
  "providers_attempted": ["exa"],
  "results": [
    {
      "name": "...", "profile_url": "...", "title": "...", "company": "...",
      "location": "...", "summary": "...",
      "attributes": { "...": "..." },           // enrich only: the requested fields
      "source": {"provider": "...", "url": "...", "snippet": "..."},
      "confidence": "high | medium | low"
    }
  ],
  "warnings": []
}
```
Exa enrich derives `fields` from the structured person entity (and synthesized
`outputSchema` when present); `linkedin_url` is derived from `profile_url` when
it is a linkedin.com URL. Exa does not return emails (best-effort `null`).

## Implementation
- `agents/tools/people_search/` (`__init__`, `config`, `types`, `repo`,
  `service`, `handler`) following the `web_search` pattern.
- `PeopleSearchTool` in `agents/utils/tool_schemas.py` → `TOOL_MODELS`,
  `EXPLORE_AGENT_TOOLS`, `__all__`.
- `agents/tools/prompts/people_search.py` → `TOOL_PROMPTS`.
- Dispatch in `spawn_explore_agent_activity`; `people_search_activity` in
  `agents/worker.py`.
- `config.py` accepts `PARRALLEL_API_KEY` (legacy) and `PARALLEL_API_KEY`; Exa
  via `EXA_API_KEY` (`ExaConfig`).
- Frontend: `people_search` icon (Users) + `ToolName` type already present;
  "People Searches" display name added (frontend `config.ts` + backend
  `helpers/summarize.py`).
- Removed `people_search` from the deleted-tool invariant lists.

## Verification (automated)
- `agents/tests/blackbox/people_search.blackbox.py` (mocked, 16 tests): strict
  schema pairing, limit clamp, all four request shapes, Parallel min-then-trim,
  Exa enrich attributes + linkedin_url derivation, discover normalization,
  Parallel enrich limited-fields warning, auto-fallback on error, no-fallback on
  empty, missing-key fallback, manager/entry-point dispatch.
- `agents/tests/blackbox/people_search_live.blackbox.py` (gated by
  `PEOPLE_SEARCH_LIVE=1`): LIVE matrix across (mode × provider) + fields/limit
  against real Exa + Parallel. Run:
  `PEOPLE_SEARCH_LIVE=1 python scripts/run_blackbox_tests.py people-search-live`.
- `prompt-invariants` (explore-only, registered, documented), `spawn-agent`
  (explore can execute it), full agents offline suite (75 PASS).
- Benchmarks: `people-search-targeted` (enrich/exa) and `people-search-criteria`
  (discover/parallel) in `agents/benchmarks/tasks.json`, both passing with
  correct routing.

## Sources
- Exa People Search: https://exa.ai/docs/reference/verticals/people
- Exa Search API: https://exa.ai/docs/reference/search
- Parallel Fast Entity Search: https://docs.parallel.ai/api-reference/findall/fast-entity-search
