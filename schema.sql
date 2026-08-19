-- Platinum Intel / Nahasis rebuild — Cloudflare D1 schema
--
-- Design note: individual earned trophies are stored as a JSON array on
-- member_games rather than one row per trophy. At 300 members averaging 5,000
-- trophies each, the row-per-trophy design is ~1.5M rows and blows through D1's
-- free write allowance during onboarding. The blob design is ~90k rows and every
-- query we actually run (a member's progress in one game) reads exactly one row.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- members ---
CREATE TABLE IF NOT EXISTS members (
  discord_id        TEXT PRIMARY KEY,
  psn_account_id    TEXT NOT NULL UNIQUE,
  psn_online_id     TEXT NOT NULL,
  country           TEXT,                 -- 'GB', 'CA' ... for the [GB] tag
  avatar_url        TEXT,
  registered_at     INTEGER NOT NULL,
  last_update_at    INTEGER,
  last_attempt_at   INTEGER,               -- set BEFORE a refresh scan starts, so a
                                           -- member who times out still loses their turn
  last_scan_ok      INTEGER DEFAULT 1,    -- 0 when the profile went private
  -- cached rollups, so the leaderboard is a single indexed read
  platinum          INTEGER NOT NULL DEFAULT 0,
  gold              INTEGER NOT NULL DEFAULT 0,
  silver            INTEGER NOT NULL DEFAULT 0,
  bronze            INTEGER NOT NULL DEFAULT 0,
  completion        REAL    NOT NULL DEFAULT 0,   -- percent, 41.02
  points            INTEGER NOT NULL DEFAULT 0,   -- the score on the card: raw_points x completion
  raw_points        INTEGER NOT NULL DEFAULT 0,   -- rarity-weighted sum, before the multiplier
  projects          INTEGER NOT NULL DEFAULT 0,   -- games started
  completed         INTEGER NOT NULL DEFAULT 0,   -- games at 100%
  rank              INTEGER,
  prev_rank         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_members_points ON members(points DESC);
CREATE INDEX IF NOT EXISTS idx_members_psn    ON members(psn_account_id);

-- ------------------------------------------------------------------ games ---
-- Global cache. A game's trophy list and worldwide earn rates are identical for
-- everyone, so this is fetched once and reused across all members. With heavy
-- library overlap in a hunting community this is the single biggest saving.
CREATE TABLE IF NOT EXISTS games (
  np_comm_id        TEXT PRIMARY KEY,     -- 'NPWR07110_00'
  np_service_name   TEXT,                 -- 'trophy' | 'trophy2'
  title             TEXT NOT NULL,
  platform          TEXT,
  icon_url          TEXT,
  trophy_count      INTEGER,
  has_platinum      INTEGER DEFAULT 0,
  max_points        INTEGER,              -- full-plat value at last refresh
  estimated         INTEGER NOT NULL DEFAULT 0,  -- 1 = PSN published no rarity; points are a guess
  completion_weight INTEGER NOT NULL DEFAULT 0,  -- gold*90+silver*30+bronze*15, platinum excluded
  local_started     INTEGER NOT NULL DEFAULT 0,  -- members here who own this game
  refreshed_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_games_title     ON games(title);
CREATE INDEX IF NOT EXISTS idx_games_refreshed ON games(refreshed_at);

-- --------------------------------------------------------------- trophies ---
CREATE TABLE IF NOT EXISTS trophies (
  np_comm_id        TEXT NOT NULL,
  trophy_id         INTEGER NOT NULL,
  name              TEXT,
  detail            TEXT,
  type              TEXT,                 -- platinum|gold|silver|bronze
  icon_url          TEXT,
  hidden            INTEGER DEFAULT 0,
  earned_rate       REAL,                 -- percent, 2.71
  points            INTEGER,              -- denormalised, and BLENDED with local rarity
  local_earned      INTEGER NOT NULL DEFAULT 0,  -- members here who have this trophy
  PRIMARY KEY (np_comm_id, trophy_id),
  FOREIGN KEY (np_comm_id) REFERENCES games(np_comm_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------- member_games ---
CREATE TABLE IF NOT EXISTS member_games (
  psn_account_id    TEXT NOT NULL,
  np_comm_id        TEXT NOT NULL,
  progress          INTEGER DEFAULT 0,    -- percent complete
  earned_total      INTEGER DEFAULT 0,    -- cheap change-detection signal
  earned_platinum   INTEGER DEFAULT 0,
  earned_gold       INTEGER DEFAULT 0,
  earned_silver     INTEGER DEFAULT 0,
  earned_bronze     INTEGER DEFAULT 0,
  earned_ids        TEXT,                 -- JSON array of trophy ids
  points            INTEGER DEFAULT 0,    -- this member's points in this game
  last_played_at    INTEGER,
  -- When their first and last trophy in this game were earned. Free to collect
  -- (PSN sends the dates with every trophy) and impossible to backfill without
  -- a full rescan, so we store them now and use them later — see
  -- migrations/006-trophy-timestamps.sql.
  first_earned_at   INTEGER,
  last_earned_at    INTEGER,
  scanned_at        INTEGER,              -- last deep scan; null = never
  PRIMARY KEY (psn_account_id, np_comm_id)
);
CREATE INDEX IF NOT EXISTS idx_mg_member   ON member_games(psn_account_id);
CREATE INDEX IF NOT EXISTS idx_mg_game     ON member_games(np_comm_id);
CREATE INDEX IF NOT EXISTS idx_mg_progress ON member_games(psn_account_id, progress);

-- ---------------------------------------------------------------- updates ---
-- `id` is the global "Update No." shown in the embed. It counts every update
-- ever run across the whole server, not per member — matching the old bot,
-- where RabbitSquared had No. 67 and No. 94 with Snolib's No. 96 in between.
CREATE TABLE IF NOT EXISTS updates (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  psn_account_id    TEXT NOT NULL,
  discord_id        TEXT,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  d_platinum        INTEGER DEFAULT 0,
  d_gold            INTEGER DEFAULT 0,
  d_silver          INTEGER DEFAULT 0,
  d_bronze          INTEGER DEFAULT 0,
  d_projects        INTEGER DEFAULT 0,
  d_completed       INTEGER DEFAULT 0,
  d_completion      REAL    DEFAULT 0,
  d_points          INTEGER DEFAULT 0,
  points_earned     INTEGER DEFAULT 0,    -- from newly earned trophies
  points_backlog    INTEGER DEFAULT 0,    -- from your completion moving, re-pricing everything
  points_drift      INTEGER DEFAULT 0,    -- from the world catching up
  games_changed     INTEGER DEFAULT 0,
  duration_seconds  INTEGER,
  status            TEXT DEFAULT 'running' -- running|done|failed|private
);
CREATE INDEX IF NOT EXISTS idx_updates_member ON updates(psn_account_id, id DESC);

-- ------------------------------------------------------- update_changelog ---
-- One row per changed game per update. Rendered into the update thread —
-- batched into grouped messages rather than one post per game, so a 280-game
-- first scan doesn't fire 280 Discord messages.
CREATE TABLE IF NOT EXISTS update_changelog (
  update_id         INTEGER NOT NULL,
  np_comm_id        TEXT NOT NULL,
  title             TEXT,
  kind              TEXT,                 -- new|progress|completed
  trophies_gained   INTEGER DEFAULT 0,
  points_gained     INTEGER DEFAULT 0,
  progress_from     INTEGER,
  progress_to       INTEGER,
  PRIMARY KEY (update_id, np_comm_id),
  FOREIGN KEY (update_id) REFERENCES updates(id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------- kv -----
-- Bot state: PSN refresh token, token expiry, last fallback run, config.
CREATE TABLE IF NOT EXISTS kv (
  key               TEXT PRIMARY KEY,
  value             TEXT,
  updated_at        INTEGER
);
