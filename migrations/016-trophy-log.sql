-- When each trophy was earned, per member.
--
-- WHY THIS COULD NOT WAIT. PSN sends `earnedDateTime` with every earned trophy
-- on every scan, and jobs/scan.mjs already parses it (line ~713). It then uses
-- the dates only to derive first_earned_at and last_earned_at for the GAME and
-- throws the individual ones away. So the data arrives free, costs no extra API
-- call, and is discarded thousands of times a day.
--
-- Recovering it later is the expensive part: earnedDateTime only comes back
-- with a full trophy fetch, so backfilling everybody would mean rescanning
-- every member's entire library, which is hours of PSN calls for Pelziowo and
-- LucasDiasC alone. Going forward it is a handful of rows per scan. Every day
-- this is not recording is a day that can only be bought back with that rescan,
-- which is the whole argument for shipping the write before the feature.
--
-- WHAT IT IS FOR: the PSNProfiles-style recent trophy strip, on the hunter page
-- between the split tiles and the deal. NOT BUILT YET, deliberately. There is
-- nothing to show until a few weeks have accumulated, and a placeholder sitting
-- empty on seventy profiles is worse than no strip at all. The page will render
-- it once there are rows and not before, so it appears on its own.
--
-- A SEPARATE TABLE, not a column. `trophies` is the game's trophy list, shared
-- by everybody who owns it; when a given member earned one is per member, so it
-- cannot live there. Rows only exist for trophies actually earned.
--
-- Run this in the D1 console BEFORE pushing, like every other migration.

CREATE TABLE IF NOT EXISTS member_trophies (
  psn_account_id TEXT    NOT NULL,
  np_comm_id     TEXT    NOT NULL,
  trophy_id      INTEGER NOT NULL,
  earned_at      INTEGER NOT NULL,
  PRIMARY KEY (psn_account_id, np_comm_id, trophy_id)
);

-- The only question this table will ever be asked: "what did this member earn
-- most recently". Descending, so the strip is a range scan of ten rows rather
-- than a sort of everything they own.
CREATE INDEX IF NOT EXISTS idx_member_trophies_recent
  ON member_trophies(psn_account_id, earned_at DESC);
