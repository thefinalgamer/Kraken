-- The clock that stops the live poll running away.
--
-- While somebody is streaming, their overlay asks the Worker to check PSN for
-- new trophies. `psn_polled_at` is the last time that actually happened for
-- this member, and it is what turns "every page refresh" into "at most once
-- every ten seconds": the browser source can ask as often as it likes and the
-- answer is usually "not yet".
--
-- IT PROTECTS THE BOARD, NOT THE OVERLAY. One PSN account sits behind every
-- scan this project runs. A poll loop with no floor under it is the one bug in
-- this whole system that could take the nightly update down for everybody, so
-- the floor is stored per member and enforced before any request is made.
--
-- Run once against the live database:
--   npx wrangler d1 execute platinum-intel --remote --file migrations/022-live-poll.sql

ALTER TABLE members ADD COLUMN psn_polled_at INTEGER;
