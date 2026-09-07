-- A game can be renamed by the owner, and the rename survives the scan.
--
-- WHY. Sony's own abbreviations are what land in `games.title`, and some of
-- them are wrong enough to be unreadable on the board. Leon found two. A hand
-- edit in the D1 console does not survive: the scan's upsert ends
-- `DO UPDATE SET title = excluded.title`, so the next time anybody who owns the
-- game runs /update, Sony's name comes straight back and nobody knows why.
--
-- THE OVERRIDE LIVES IN `title` ITSELF, not in a third column the whole site
-- would have to COALESCE around. Thirty-odd queries select g.title across the
-- worker, the pages and the jobs, and aliasing every one of them is how half a
-- site ends up showing the old name. So `title` stays THE display name, always,
-- and the two columns here protect it:
--
--   title_psn    - what Sony last called it. Written on every scan whether the
--                  title is locked or not, so the original is never lost and a
--                  rename is always undoable.
--   title_locked - 1 when a human chose the name. The scan's upsert reads this
--                  and leaves `title` alone while it is set.
--
-- Backfilled so title_psn is never null on a row that predates this. Sony's
-- name and the display name are the same thing until somebody changes one.
--
-- ONLY THE OWNER SETS THIS. Not mods. A wrong flag is a warning nobody needed;
-- a wrong rename is a game the whole server can no longer find by name.
--
-- Run once against the live database:
--   npx wrangler d1 execute platinum-intel --remote --file migrations/026-title-override.sql

ALTER TABLE games ADD COLUMN title_psn TEXT;
ALTER TABLE games ADD COLUMN title_locked INTEGER;

UPDATE games SET title_psn = title WHERE title_psn IS NULL;
