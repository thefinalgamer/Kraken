-- Who is streaming, and the scratchpad the Twitch token lives in.
--
-- The live check exists to GATE something expensive rather than to be a feature
-- on its own. Knowing who is on air is what lets the trophy pop ask PSN every
-- ten seconds for two people instead of every minute for seventy, and it is
-- what a "live now" strip on the home page would read from later.
--
-- `twitch_login` is the name in their channel URL, lowercased. Set by the
-- member with /twitch and nobody else: an overlay that announces somebody is
-- streaming is not something a third party gets to switch on for them.
--
-- `live_since` is when Twitch says the current stream started, or NULL when
-- they are off. `live_checked_at` is when we last asked, so a stale answer can
-- be told apart from a confident "no".
--
-- Run once against the live database:
--   npx wrangler d1 execute platinum-intel --remote --file migrations/019-twitch-live.sql

ALTER TABLE members ADD COLUMN twitch_login    TEXT;
ALTER TABLE members ADD COLUMN live_since      INTEGER;
ALTER TABLE members ADD COLUMN live_checked_at INTEGER;

-- One row per member who has told us their channel. The check reads exactly
-- these, so it stays a handful of rows however big the board gets.
CREATE INDEX IF NOT EXISTS idx_members_twitch
  ON members(twitch_login) WHERE twitch_login IS NOT NULL;

-- A tiny key/value scratchpad for the Worker.
--
-- Twitch hands out an app token that lasts about two months. Fetching a fresh
-- one every five minutes would work and would also be 288 pointless requests a
-- day, so it is cached here with its expiry. This table is deliberately generic
-- but must stay small: it is for machine state, never for anything a member
-- would look for.
CREATE TABLE IF NOT EXISTS worker_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  expires_at INTEGER
);
