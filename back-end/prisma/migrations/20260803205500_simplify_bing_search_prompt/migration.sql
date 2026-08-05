-- The Benchmark Hub database is authoritative after initial seeding. Update
-- both prompt representations so a Hub export cannot restore the superseded
-- task text over tasks.json.
UPDATE "BenchmarkTask"
SET
  "prompt" = 'Use a browser agent, not web_search or web_fetch, to go to https://www.bing.com/search?q=OpenAI+official+website and inspect the visible Bing results page. Return exactly one non-ad search result: include only the result title and URL.',
  "definition" = jsonb_set(
    COALESCE("definition", '{}'::jsonb),
    '{prompt}',
    to_jsonb('Use a browser agent, not web_search or web_fetch, to go to https://www.bing.com/search?q=OpenAI+official+website and inspect the visible Bing results page. Return exactly one non-ad search result: include only the result title and URL.'::text),
    true
  ),
  "updatedAt" = CURRENT_TIMESTAMP,
  "updatedBy" = 'catalog-migration'
WHERE "name" = 'browser-bing-search-single-result';
