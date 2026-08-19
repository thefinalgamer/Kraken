-- 004 — mark games whose points are estimated
--
-- A game PSN has published no rarity for gets its points from
-- UNRATED_FALLBACK. Two very different things land in that bucket:
--
--   old PS3 titles  — Sony will never publish figures for these
--   new releases    — Assassin's Creed Black Flag Resynced and friends, where
--                     Sony simply hasn't computed rarity yet
--
-- The second group gets real numbers within weeks, but the game cache holds for
-- 30 days, so without this flag a brand-new game would sit on a guess for a
-- month after the truth became available. Flagged games are re-checked every
-- three days instead.
--
-- Run these one at a time in the D1 console. If a statement says the column
-- already exists, that step is done — skip it.

ALTER TABLE games ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0;

-- Backfill: a game is estimated when not one of its trophies has a published
-- rarity. That is exactly the 152 the investigation found.
UPDATE games
   SET estimated = 1
 WHERE NOT EXISTS (
   SELECT 1 FROM trophies t
    WHERE t.np_comm_id = games.np_comm_id AND t.earned_rate > 0
 );
