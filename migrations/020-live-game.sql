-- What they are streaming, not just that they are.
--
-- The live check already receives the game name in the same response it uses to
-- decide who is on air, so storing it costs nothing extra: no second request,
-- no second table. "Leon is live" is a fact; "Leon is live playing Elden Ring"
-- is a reason to click.
--
-- NULL when they are off, same as live_since, so the two can never disagree.
--
-- Run once against the live database:
--   npx wrangler d1 execute platinum-intel --remote --file migrations/020-live-game.sql

ALTER TABLE members ADD COLUMN live_game TEXT;
