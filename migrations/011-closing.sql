-- Games that are not dead yet, but are going to be.
--
-- `unobtainable` answers "can this still be finished". It has no way to say
-- "yes, until the fifteenth of March", and that is the more useful sentence of
-- the two. A dead game is a warning nobody acts on; a game with three weeks
-- left is the only thing on this board that creates a deadline.
--
--   Martin: "one icon says this is already dead / one icon says ive got time to
--   do this - this icon at a glance people think oh ill do it"
--
-- Milliseconds since the epoch, matching every other timestamp in the schema,
-- so nothing here needs a second date format. NULL means no announced closure,
-- which is nearly every game.
--
-- The flip is NOT done here and is not done by a trigger. Once closes_at is in
-- the past the nightly rescore sets unobtainable = 1, so there is exactly one
-- place that decides a game has died and it happens on a schedule we can watch.
-- A page that computed "is it past yet" at render time would disagree with
-- Discord for up to a day, which is the one thing this project does not do.
ALTER TABLE games ADD COLUMN closes_at INTEGER;

-- Small, but the nightly flip scans on it and the contested board sorts by it.
CREATE INDEX IF NOT EXISTS idx_games_closing ON games(closes_at)
  WHERE closes_at IS NOT NULL;
