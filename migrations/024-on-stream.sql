-- Which trophies were earned in front of an audience.
--
-- The live poll only ever runs while somebody is streaming, so every trophy it
-- writes was earned on air by definition. That is worth keeping: a trophy list
-- where you can see which ones happened live ties the board to the streams for
-- anybody browsing the site, and it is a fact nothing else on the internet
-- records.
--
-- Only the POLL sets this. The nightly scan writes the same table and leaves
-- the flag alone, because it has no idea whether anybody was watching.
--
-- THE INDEX IS PARTIAL and that is the whole reason this is affordable. A game
-- page asks "which trophies here were earned live", which cannot use the
-- table's own key (that starts with the member). Indexing every row would mean
-- indexing hundreds of thousands to serve a few hundred; indexing only the
-- flagged ones is a handful of rows that grows one at a time, live.
--
-- Run once against the live database:
--   npx wrangler d1 execute platinum-intel --remote --file migrations/024-on-stream.sql

ALTER TABLE member_trophies ADD COLUMN on_stream INTEGER;

CREATE INDEX IF NOT EXISTS idx_member_trophies_onstream
  ON member_trophies(np_comm_id, trophy_id) WHERE on_stream = 1;
