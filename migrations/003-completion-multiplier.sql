-- 003 — the completion multiplier
--
-- Your score becomes your rarity points multiplied by your overall completion.
-- A game worth 1,000 pays 700 at 70%. This is what Esto's original bot did and
-- it is the whole "reward the backlog" mechanic: finishing old games re-prices
-- your entire library at once.
--
-- `points` keeps its meaning as "the number on your card", so every query,
-- index, card and leaderboard downstream is untouched. The new `raw_points`
-- holds the rarity sum underneath it.
--
-- Run these one at a time in the D1 console. ALTER TABLE ADD COLUMN is not
-- idempotent — if a statement says the column already exists, that step is
-- already done, skip it and carry on with the next.

-- 1. the new columns
ALTER TABLE members ADD COLUMN raw_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE updates ADD COLUMN points_backlog INTEGER DEFAULT 0;

-- 2. everything scored so far was raw, so that is what it becomes
UPDATE members SET raw_points = points;

-- 3. and the score on the card becomes the banked figure.
--    CAST(... AS INTEGER) truncates, which is the floor we want: nobody is
--    paid for a completion point they have not finished earning.
UPDATE members SET points = CAST(raw_points * completion / 100.0 AS INTEGER);

-- 4. re-rank, because multiplying by different completions can reorder people.
--    Without this the board shows the old order against the new numbers until
--    somebody runs an update.
UPDATE members SET prev_rank = rank;

UPDATE members
   SET rank = (
     SELECT rn FROM (
       SELECT discord_id,
              ROW_NUMBER() OVER (ORDER BY points DESC, psn_online_id ASC) AS rn
         FROM members
        WHERE last_update_at IS NOT NULL
     ) r WHERE r.discord_id = members.discord_id
   )
 WHERE last_update_at IS NOT NULL;
