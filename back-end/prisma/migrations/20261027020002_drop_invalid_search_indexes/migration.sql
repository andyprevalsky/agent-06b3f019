-- A failed concurrent build leaves an INVALID index behind, and the
-- `CREATE INDEX CONCURRENTLY IF NOT EXISTS` rebuilds that follow would skip it
-- by name. Drop only INVALID copies of the restored search indexes first; a
-- valid index is left untouched. An invalid index serves no reads, so the
-- brief lock this drop takes affects no query plan.
DO $$
DECLARE
  invalid_index TEXT;
BEGIN
  FOR invalid_index IN
    SELECT c.relname
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relnamespace = 'public'::regnamespace
      AND NOT i.indisvalid
      AND c.relname IN ('Agent_title_trgm_idx', 'Agent_goal_trgm_idx', 'Message_text_trgm_idx')
  LOOP
    EXECUTE format('DROP INDEX public.%I', invalid_index);
  END LOOP;
END $$;
