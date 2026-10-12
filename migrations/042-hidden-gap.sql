-- What PlayStation says the account holds, against what it will show us.
--
-- THE QUESTION, from Martin on 12 October: "if player two joins us but before he
-- joins us he deletes all his shit to make himself look good... anyway we can
-- see this? i dont want people cheating our system."
--
-- DELETING IS ALREADY DEAD. PSN only lets you delete a trophy list you have
-- earned nothing in, and since the 0% rule those count for nothing anyway. The
-- one that survives is HIDING, which has no such limit: a member can hide a
-- game they are 40% through and PSN simply stops returning it.
--
-- For somebody already on the board that gains them nothing - the scan never
-- removes a row with trophies in it, so a hidden game keeps counting in both
-- halves of their completion, which is what migration 036 and tools/hiding.sql
-- are about. The gap is somebody who hides BEFORE they join. We have no history
-- to compare against, so they arrive with those games simply absent.
--
-- WHAT THIS MEASURES. PSN answers two different questions: the account summary
-- gives trophy totals for the whole profile, and the titles call gives the
-- games. Those two numbers should agree. When the summary says 4,000 and the
-- visible games add up to 3,100, the missing 900 are somewhere we cannot see.
-- It works on a first scan, before any history exists, which is exactly the
-- case nothing else covers.
--
-- THIS IS A MEASUREMENT, NOT A VERDICT, and it is stored that way: two numbers
-- and a date, no flag, nothing called cheating, and nothing member-facing reads
-- it. Three reasons a gap can be innocent:
--
--   * Sony delists games outright (Warhawk lost three operation packs)
--   * regional stacks get restructured
--   * a short PSN response drops titles for one scan
--
-- AND IT MAY MEASURE NOTHING AT ALL, which is the honest caveat. Whether
-- Sony's account summary still counts a hidden game is not documented and is
-- not something to take on trust. If every member comes back with a gap of
-- zero, that is the answer: the summary is filtered too, this column is useless,
-- and we drop it and think again. Cross-check against tools/hiding.sql - a
-- member known to be hiding something SHOULD show a gap here. If they do not,
-- the measurement is wrong, not the member.
--
-- TO READ IT, in the D1 console:
--
--   SELECT psn_online_id, summary_trophies, visible_trophies,
--          summary_trophies - visible_trophies AS gap,
--          datetime(hidden_checked_at / 1000, 'unixepoch') AS checked
--     FROM members
--    WHERE summary_trophies IS NOT NULL
--    ORDER BY gap DESC;

ALTER TABLE members ADD COLUMN summary_trophies INTEGER;

ALTER TABLE members ADD COLUMN visible_trophies INTEGER;

ALTER TABLE members ADD COLUMN hidden_checked_at INTEGER;
