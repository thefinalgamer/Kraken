-- 010 — games with trophies nobody can earn any more
--
-- Martin: "i dont know if we could have a ! emote or some sort of warning for
-- people to know a game has unobtainable in it, i dont know if you can grab
-- that info or if players have to let a mod know and we tag it ?"
--
-- Players have to tell a mod. PSN does not publish it and cannot: a trophy
-- becomes unobtainable when a server is switched off, an event ends, or a patch
-- breaks it, and none of those are facts about the trophy. Sony's API returns
-- exactly the same row for "nobody can get this now" and "nobody has bothered".
--
-- Guessing it from the data was considered and rejected. The obvious heuristic —
-- nobody on PSN has earned it in a long time — fires confidently on any obscure
-- game nobody plays, and a wrong warning is worse than no warning: it tells
-- somebody not to start a game that is perfectly completable.
--
-- So it is a human judgement, stored as one. /flag records who said so and
-- when, because a warning with no name against it is unarguable-with, and these
-- will occasionally be wrong.
--
-- The note is the part that matters. "Has unobtainable trophies" tells nobody
-- anything; "online servers closed May 2024, 3 multiplayer trophies" tells them
-- whether they care.

ALTER TABLE games ADD COLUMN unobtainable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN unobtainable_note TEXT;
ALTER TABLE games ADD COLUMN flagged_by TEXT;
ALTER TABLE games ADD COLUMN flagged_at INTEGER;
