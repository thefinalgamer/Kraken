-- 007 — local rarity
--
-- "our members completing games was making each others worth less"
--
-- The layer that turns a leaderboard into an economy. A trophy is rare HERE if
-- few of us have earned it, and quietly loses value as the server grinds the
-- game down. Reconstructing this from one screenshot of Esto's old site fit his
-- real figures to within 1.4%, where a global-rarity model was off by 36x.
--
--   games.local_started   how many members own this game
--   trophies.local_earned how many members have this specific trophy
--
-- Both default to 0, which is the correct starting value: at zero local owners
-- the blend (see blendedRate() in shared/scoring.mjs) returns Sony's global
-- figure exactly. So the board keeps working normally until the first rescore
-- fills these in, and there is no moment where scores are wrong.
--
-- NOT backfilled here. Counting which members hold which trophy means expanding
-- every earned_ids blob — around a million rows today — and a single statement
-- doing that inside the D1 console would time out. The rescore job recounts
-- them in memory instead, paged, which is both faster and re-runnable.
--
-- Run one at a time. "duplicate column" means that step is already done.

ALTER TABLE games ADD COLUMN local_started INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trophies ADD COLUMN local_earned INTEGER NOT NULL DEFAULT 0;
