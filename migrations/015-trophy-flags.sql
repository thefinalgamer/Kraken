-- Flagging one trophy, and flagging one edition.
--
-- TWO GAPS, ONE COMMAND. `/flag` could only ever say "this whole title is
-- broken", and it said it about EVERY edition at once — setUnobtainable matches
-- on title, so flagging GTA V hit the PS3, PS4 and PS5 lists together. Right
-- when a server shutdown kills all three; wrong when only the PS3 list died,
-- and there was no way to say so. Mods hit this immediately.
--
-- POINTS ARE NEVER TOUCHED BY ANY OF THIS. Martin's rule, and it is not up for
-- revisiting: "we cant take points away from people for earning something that
-- no longer achievable." A flag is a warning to whoever comes next. Somebody
-- who earned a trophy before the servers went off keeps every point of it, and
-- nothing in `jobs/rescore.mjs` reads a single column below.
--
-- THE GAME FLAG IS A ROLLUP. Flagging a trophy marks its game automatically, so
-- a mod does one thing rather than remembering two. Clearing the last flagged
-- trophy clears the game with it — a game whose broken trophy was fixed is
-- completable again, and leaving the warning up would be its own bug.
--
-- Run these ONE AT A TIME in the D1 console, and BEFORE pushing. A migration
-- that ships after the code needing it takes the site down: SQLite rejects the
-- entire query for one unknown column, and every page selects from trophies.

ALTER TABLE trophies ADD COLUMN unobtainable INTEGER NOT NULL DEFAULT 0;

-- What is broken about it, in a mod's words. Null when the flag is on but
-- nobody wrote a reason, so every renderer needs a fallback sentence.
ALTER TABLE trophies ADD COLUMN unobtainable_note TEXT;

-- Who and when. The game table already carries these two for the same reason:
-- a flag is a moderator action, and an unattributed one cannot be questioned.
ALTER TABLE trophies ADD COLUMN flagged_by TEXT;
ALTER TABLE trophies ADD COLUMN flagged_at INTEGER;

-- PARTIAL, and that matters at this size. There are over a million trophy rows
-- and the flagged ones will number in the dozens, so a full index would be a
-- million entries to answer "does this game have a dead trophy". The WHERE
-- clause means the index only holds rows that are actually flagged.
CREATE INDEX IF NOT EXISTS idx_trophies_dead
  ON trophies(np_comm_id) WHERE unobtainable = 1;
