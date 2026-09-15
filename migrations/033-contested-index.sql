-- The index that stops one query reading two billion rows a day.
--
-- 15 September, D1 metrics: 2 BILLION rows read in 24 hours, 1.77B of them from
-- a single query -- the "most contested" list on the home page, 737,000 rows
-- read per render for six rows of output.
--
-- WHY. It joins games to trophies on np_comm_id and filters type = 'platinum'.
-- The primary key is (np_comm_id, trophy_id), so finding the platinum means
-- reading EVERY trophy of that game and throwing away the other thirty-nine,
-- for every game on the board, on every render. The same shape is in
-- functions/contested.js, shared/contested.mjs (the Discord command) and the
-- two overlay queries, which each carry a "the platinum's local_earned"
-- subquery. One index fixes all of them.
--
-- A PARTIAL index, so it holds one row per game rather than one per trophy:
-- about 26,000 rows instead of a million. `local_earned` rides along so the
-- planner never has to open the table at all.
--
-- The second index narrows the other side: the contested list only ever looks
-- at games at least three people own that are worth something and still
-- earnable, which is a small fraction of the catalogue.
--
-- Safe to run twice.

CREATE INDEX IF NOT EXISTS idx_trophies_plat
  ON trophies(np_comm_id, local_earned)
  WHERE type = 'platinum';

CREATE INDEX IF NOT EXISTS idx_games_contested
  ON games(local_started DESC)
  WHERE max_points > 0 AND unobtainable = 0;
