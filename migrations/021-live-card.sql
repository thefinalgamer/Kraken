-- Enough to draw a live stream properly rather than list it.
--
-- All three of these arrive in the SAME Twitch response the live check already
-- makes, so none of it costs a request. Storing them turns "Leon is live" into
-- a card with what is on his screen, how many people are watching, and how long
-- he has been on.
--
-- `live_mature` is not decoration. The thumbnail is a frame of somebody else's
-- broadcast hotlinked onto the front of this site, and a stream flagged mature
-- gets its name and game shown WITHOUT the picture. Twitch's own flag is the
-- only signal available and it is better than nothing at all.
--
-- Run once against the live database:
--   npx wrangler d1 execute platinum-intel --remote --file migrations/021-live-card.sql

ALTER TABLE members ADD COLUMN live_thumb   TEXT;
ALTER TABLE members ADD COLUMN live_viewers INTEGER;
ALTER TABLE members ADD COLUMN live_mature  INTEGER;
