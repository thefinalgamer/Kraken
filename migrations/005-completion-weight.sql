-- 005 — completion stops counting worthless games
--
-- "buying games or playing new games shouldn't help your % up — you should
--  always need to be pushed to do your backlog"  — Martin, 19 August 2026
--
-- Completion multiplies everyone's score, and shovelware is trivially
-- 100%-able, so finishing cheap games was the cheapest way to raise the
-- multiplier on everything you own. Measured: Lucas's worthless games weigh
-- 4.8x his real library; applying that pile to Rabbit takes him from 48% to
-- 91% without earning a single rarity point.
--
-- From now on a game worth zero points contributes nothing to completion in
-- EITHER direction — so abandoned junk stops dragging people down too.
--
-- `completion_weight` is the game's total gold*90 + silver*30 + bronze*15,
-- platinum excluded (see completionWeight() in shared/scoring.mjs). Storing it
-- on the game is what lets the rescore job recompute completion without talking
-- to PSN — before this, only a full rescan could move the number.
--
-- Run one at a time in the D1 console. "duplicate column" means that step is
-- already done; skip it.

ALTER TABLE games ADD COLUMN completion_weight INTEGER NOT NULL DEFAULT 0;

UPDATE games SET completion_weight = (
  SELECT COALESCE(SUM(CASE t.type
           WHEN 'gold'   THEN 90
           WHEN 'silver' THEN 30
           WHEN 'bronze' THEN 15
           ELSE 0 END), 0)
    FROM trophies t WHERE t.np_comm_id = games.np_comm_id
);
