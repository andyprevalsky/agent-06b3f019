-- The Benchmark Hub database is authoritative after initial seeding, so the
-- prompt must be updated in the row AND in the runner definition or a Hub
-- export restores the superseded wording over tasks.json.
--
-- The previous prompt named only the restaurant and location. It never said
-- WHERE to order from, so a marketplace (DoorDash, Uber Eats) was a valid
-- reading of the contract while the evaluator required the official Toast
-- checkout. This names the ordering surface in the task itself.
UPDATE "BenchmarkTask"
SET
  "prompt" = 'Order me 1 rocky fish sandwich from Nopa Fish Ferry Building, from the restaurant''s Toast site',
  "definition" = jsonb_set(
    COALESCE("definition", '{}'::jsonb),
    '{prompt}',
    to_jsonb('Order me 1 rocky fish sandwich from Nopa Fish Ferry Building, from the restaurant''s Toast site'::text),
    true
  ),
  "updatedAt" = CURRENT_TIMESTAMP,
  "updatedBy" = 'catalog-migration'
WHERE "name" = 'browser-toast-nopa-write-lock';
