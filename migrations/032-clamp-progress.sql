-- A percentage cannot be more than all of it.
--
-- PSN's own weighted progress overshoots while a DLC pack lands, so rows were
-- stored -- and update cards printed -- at 102%. The scan now clamps on the way
-- in; this fixes what is already sitting in the table.
--
-- Safe to run twice: the second run matches nothing.

UPDATE member_games SET progress = 100 WHERE progress > 100;
UPDATE member_games SET progress = 0 WHERE progress < 0;
