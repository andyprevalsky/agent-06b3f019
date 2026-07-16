-- Existing Benchmark Hub rows are DB-owned after seeding. Move the iMessage
-- regression bench out of the pre-deploy smoke slice and into Daily while
-- keeping its full task definition aligned with the canonical catalog.
UPDATE "BenchmarkTask"
SET
    "tags" = array_remove("tags", 'smoke'),
    "definition" = jsonb_set(
        jsonb_set(
            "definition",
            '{tags}',
            to_jsonb(array_remove("tags", 'smoke')),
            true
        ),
        '{group}',
        '"Daily"'::jsonb,
        true
    ),
    "updatedAt" = CURRENT_TIMESTAMP,
    "updatedBy" = 'catalog-migration'
WHERE "name" = 'message-person';
