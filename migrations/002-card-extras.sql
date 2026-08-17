-- The rarest trophy a member owns, cached on their row.
--
-- Computed once per scan rather than per card render. Working it out means
-- joining every one of their earned trophy ids against the shared rarity
-- table, which is fine once during a scan that already takes minutes, and
-- absurd to do four times for one /leaderboard page.
--
-- Run from Actions -> Admin -> Run workflow -> migrate.
-- Safe to re-run: every migration in this folder is written to be idempotent.

ALTER TABLE members ADD COLUMN rarest_name TEXT;
ALTER TABLE members ADD COLUMN rarest_rate REAL;
ALTER TABLE members ADD COLUMN rarest_game TEXT;
