-- The index behind the stream overlay's "what are they playing".
--
-- The overlay asks one question every sixty seconds while somebody is live:
-- the single most recently played game for one member. Without this index that
-- is a scan and a sort of every row they own to return one of them, and the
-- biggest library here is 1,512 games. Eight hours of one stream would be
-- 720,000 rows read to print one title, and D1's free tier allows five million
-- a day for the whole board.
--
-- With it the same question reads a handful of rows. The write cost is one
-- index entry per member_games row the scan touches, which is the trade worth
-- making for a query that runs a thousand times a day and never gets cached.
--
-- Run once against the live database:
--   npx wrangler d1 execute platinum-intel --remote --file migrations/017-overlay-recent.sql

CREATE INDEX IF NOT EXISTS idx_member_games_recent
  ON member_games(psn_account_id, last_played_at DESC);
