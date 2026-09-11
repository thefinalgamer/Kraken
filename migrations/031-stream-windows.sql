-- Every stream, not just the last one.
--
-- members.last_stream_start / last_stream_end only ever held the most recent
-- stream, so somebody who streamed Monday and Tuesday and updated on Wednesday
-- lost Monday for good. One row per finished stream fixes it.
--
-- Safe to run twice: every statement is IF NOT EXISTS or OR IGNORE.

CREATE TABLE IF NOT EXISTS stream_windows (
  psn_account_id TEXT    NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER NOT NULL,
  PRIMARY KEY (psn_account_id, started_at)
);

CREATE INDEX IF NOT EXISTS idx_stream_windows_ended ON stream_windows(ended_at);

-- The one stream each member already has on record.
INSERT OR IGNORE INTO stream_windows (psn_account_id, started_at, ended_at)
  SELECT psn_account_id, last_stream_start, last_stream_end
    FROM members
   WHERE last_stream_start > 0
     AND last_stream_end > last_stream_start;
