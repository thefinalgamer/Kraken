-- Trophies a game used to have.
--
-- Warhawk, PS3, servers closed in 2019. We hold 94 trophy rows for it. PSN now
-- returns 57 from BOTH of its endpoints: the definition list, and the trophy
-- list of every member who owns it. The missing 37 are its operation packs,
-- which Sony has delisted along with the servers.
--
-- NOTHING IN THIS CODEBASE HAS EVER REMOVED A TROPHY ROW. The scan upserts, so
-- a game that gains DLC grows and a game that loses it keeps the corpse. Every
-- growth bug we have fixed assumed trophy lists only ever get longer. Warhawk
-- is the first game on the board to get shorter.
--
-- What the 37 were doing: nothing anybody could see, and one thing nobody
-- wanted. No name, so no page could draw them. No pack, so they filed under the
-- base game. No points, so they were worth nothing to earn. But they DID carry
-- 1,020 points of completion weight (18 bronze, 16 silver, 3 gold), because the
-- rescore recomputes that column from the rows we hold rather than from PSN's
-- count. So the two members who own Warhawk were being scored against a
-- denominator of 94 for trophies that no longer exist and nobody can earn.
--
-- THE CONDITION IS NARROWER THAN "WARHAWK", ON PURPOSE. A row with no name, no
-- pack, no value and nobody holding it cannot be drawn, cannot be earned and
-- cannot be scored: it is not data, it is a gap. A row that fails even one of
-- those four tests is left exactly where it is. That is what keeps a trophy
-- merely waiting on backfill-names safe here, because the moment it is named,
-- grouped, priced, or earned by anybody, this stops matching it.
--
-- Checked against the live database before this was written: 37 rows across 1
-- game match. Unnamed rows somebody has earned: 0. Unnamed rows worth points: 0.
--
-- RUN THE RESCORE AFTERWARDS. completion_weight is recomputed there, and until
-- it is, the two owners keep the denominator they have today.
--
-- Safe to run twice: the second run matches nothing.

DELETE FROM trophies
 WHERE name IS NULL
   AND group_id IS NULL
   AND COALESCE(points, 0) = 0
   AND COALESCE(local_earned, 0) = 0;
