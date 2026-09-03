-- The stream that just finished.
--
-- `live_since` answers "are they on air now" and goes null the moment they are
-- not, which is right for the overlay and useless for the thing that happens
-- next: somebody streams for four hours, goes off, and THEN runs /update. The
-- scan writes those trophies with the stream long over, so nothing is left to
-- say they were earned in front of an audience.
--
-- These two remember the window. The live check keeps sweeping it for a while
-- after the stream ends, so a trophy that arrives late still gets marked.
--
-- Run once against the live database:
--   npx wrangler d1 execute platinum-intel --remote --file migrations/025-stream-window.sql

ALTER TABLE members ADD COLUMN last_stream_start INTEGER;
ALTER TABLE members ADD COLUMN last_stream_end   INTEGER;
