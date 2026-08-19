-- 006 — record WHEN trophies were earned
--
-- Every trophy PSN sends us carries the date it was earned, and we have been
-- throwing it away. It costs nothing to keep: same API response, same call.
--
-- What it is for. Rarity has one blind spot — it measures who BOTHERED, not
-- what it took. A brutal game bought only by 3,000 enthusiasts shows 70% earn
-- rates and gets scored as shovelware; a cheap game bought in a sale and never
-- played shows 30% and gets paid. That second case is exactly what broke the
-- board when the curve was flattened.
--
-- Completion TIME fixes it, but only as a property of the GAME rather than of
-- one player: "what is the fastest anyone in this server finished it?" One
-- honest fast player sets the mark, so it cannot be gamed by an individual
-- pausing between trophies — which is why a per-player time limit was rejected
-- (see claude/scoring-model.md §7).
--
-- That needs a population, so nothing uses these columns yet. The point is that
-- the data only accumulates GOING FORWARD: every day we do not store it is a
-- day of history that cannot be recovered without rescanning everybody.
--
-- Run one at a time in the D1 console. "duplicate column" means that step is
-- already done; skip it.

ALTER TABLE member_games ADD COLUMN first_earned_at INTEGER;
ALTER TABLE member_games ADD COLUMN last_earned_at  INTEGER;

-- Milliseconds since epoch, and NULL where unknown — an older row scanned
-- before this existed is genuinely unknown, and must not be confused with a
-- game finished in zero seconds.
CREATE INDEX IF NOT EXISTS idx_mg_earned_span ON member_games(np_comm_id, first_earned_at);
