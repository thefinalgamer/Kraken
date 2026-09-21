-- Personal goals. /goal in Discord, cards on the hunter page.
--
-- Asked for by PrimalxFear: "im close to 200k, and set that as a goal for end
-- of month... or set completion rate goal till end of year". Everybody can see
-- everybody's, the same as rivals.
--
-- A GOAL STORES ONLY WHAT NOTHING ELSE KNOWS: what it is for, the target, the
-- date, and the number they were on when they set it. The current number is
-- read from the members row every time, because the scan and the rescore
-- already keep that current and a second copy would only drift.
--
-- `kind` is one of points, completion, platinum, completed, trophies
-- (shared/goals.mjs owns the list and which members column each one reads).
--
-- `reached_at` is set by a job the first time the live number gets there, and
-- that is the moment the bot posts it. `ended_at` is set when the date passes
-- first. Both freeze `final_value`, so a finished card keeps saying what it
-- finished on rather than whatever the row says months later.
--
-- Unlinking a member deletes their goals with the rest of their rows.

CREATE TABLE IF NOT EXISTS goals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  psn_account_id TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  target         REAL    NOT NULL,
  start_value    REAL    NOT NULL,
  created_at     INTEGER NOT NULL,
  deadline_at    INTEGER,
  reached_at     INTEGER,
  ended_at       INTEGER,
  final_value    REAL
);

-- One member's goals, for the page and for /goal.
CREATE INDEX IF NOT EXISTS idx_goals_member ON goals(psn_account_id, created_at DESC);

-- The open ones, for the job that decides a goal has been hit. Partial, so it
-- stays the size of what is still running rather than of everything ever set.
CREATE INDEX IF NOT EXISTS idx_goals_open ON goals(psn_account_id)
  WHERE reached_at IS NULL AND ended_at IS NULL;
