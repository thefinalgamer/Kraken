-- DLC packs.
--
-- PSN has always sent a `trophyGroupId` with every trophy definition — "default"
-- for the base game, "001", "002" and so on for each add-on — and both writers
-- (jobs/names.mjs and backfillNames() in jobs/scan.mjs) were throwing it away.
-- So Minecraft arrived here as one undifferentiated list of 136 trophies while
-- the console shows a base game and eight expansion packs.
--
-- Nothing here needs a rescan and nothing here costs a PSN call: the group id
-- comes back on the SAME call we already make for names and rarity. Re-running
-- `npm run backfill-names` fills it in.
--
-- Run these ONE AT A TIME in the D1 console. ALTER TABLE ADD COLUMN cannot be
-- batched with anything, and a migration that ships after the code that needs
-- it takes the whole site down — every page selecting an unknown column makes
-- SQLite reject the entire query. Migration first, push second. Always.

ALTER TABLE trophies ADD COLUMN group_id TEXT;

-- The pack NAMES are the one thing the trophies call does not carry, so they
-- come from getTitleTrophyGroups — one extra call, and only ever for a game
-- whose trophies span more than one group. On this server that is a few dozen
-- games out of five hundred, not five hundred out of five hundred.
--
-- `name` is nullable on purpose. A game can be known to have three groups
-- before anybody has fetched what they are called, and "Pack 2" with no name is
-- still better than 136 trophies in one heap.
CREATE TABLE IF NOT EXISTS trophy_groups (
  np_comm_id  TEXT NOT NULL,
  group_id    TEXT NOT NULL,          -- 'default' | '001' | '002' | ...
  name        TEXT,                   -- 'Expansion Pack 4'
  icon_url    TEXT,
  fetched_at  INTEGER,
  PRIMARY KEY (np_comm_id, group_id)
);

-- Partial: the vast majority of trophies are in 'default' and no query ever
-- asks for those by group, so indexing them would be paying to store a column
-- of the same value.
CREATE INDEX IF NOT EXISTS idx_trophies_group
    ON trophies(np_comm_id, group_id)
 WHERE group_id IS NOT NULL AND group_id <> 'default';
