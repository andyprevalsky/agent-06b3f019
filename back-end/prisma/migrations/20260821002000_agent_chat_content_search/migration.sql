-- Case-insensitive substring search backs the sidebar's title, goal, and chat
-- content search. B-tree indexes cannot accelerate ILIKE '%needle%'; trigram
-- GIN indexes can, keeping each debounced search bounded as histories grow.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
