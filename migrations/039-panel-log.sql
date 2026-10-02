-- A TEMPORARY DIAGNOSTIC. Drop it once the question below is answered.
--
-- THE QUESTION. Three viewers - JoJo, UncleUrbi and GD - get "Log in to Twitch
-- to vote" on a panel they are signed in to. The vote code is behaving
-- correctly: the message only renders after a genuine Twitch-signed token has
-- been verified, so Twitch is handing us an anonymous "A" id for them, and
-- `voterId()` refuses those because they change on every page load.
--
-- WHAT WE HAVE RULED OUT, the slow way. Ad blockers (UncleUrbi disabled his),
-- VPNs (none), antivirus (stock Defender), a hard refresh (Ctrl+F5), and
-- Firefox's Enhanced Tracking Protection (switched off for twitch.tv, 2 October
-- - "No that didn't work"). Chrome works for JoJo on the same connection.
--
-- So we stop guessing and write down what Twitch actually sends. The token
-- carries more than the opaque id: `role`, `is_unlinked`, and `user_id` when
-- the viewer has shared their identity. If the failing viewers differ from the
-- working ones in any of those, this table will show it.
--
-- NOTHING IDENTIFYING IS STORED. Only the FIRST CHARACTER of the opaque id, so
-- there is nothing here that points at a person - which is also the point, since
-- an "A" id points at nobody by design.
--
-- ONE ROW PER CHANNEL PER MINUTE PER OUTCOME. The panel asks every sixty
-- seconds per viewer, so without this a busy stream would write thousands of
-- rows to say one thing. The primary key does the throttling and INSERT OR
-- IGNORE does the rest, which means a row means "at least one viewer in this
-- state during that minute" and never a headcount.
--
-- TO READ IT, in the D1 console:
--
--   SELECT datetime(minute * 60, 'unixepoch') AS at, channel, kind, prefix,
--          role, unlinked, has_user
--     FROM panel_log ORDER BY minute DESC LIMIT 50;
--
-- Have the affected viewer open the panel at a time you know, then look for
-- that minute. An `anon` row at the minute they tried is the confirmation; the
-- other columns on it are the lead.
--
-- TO REMOVE IT when we are done: DROP TABLE panel_log;

CREATE TABLE IF NOT EXISTS panel_log (
  minute   INTEGER NOT NULL,  -- epoch seconds / 60
  channel  TEXT    NOT NULL,  -- the Twitch channel id from the token
  kind     TEXT    NOT NULL,  -- 'anon' (refused) or 'known' (may vote)
  prefix   TEXT,              -- first character of the opaque id: U, A, or odd
  role     TEXT,              -- viewer, moderator, broadcaster
  unlinked INTEGER,           -- the token's is_unlinked flag, 1 or 0
  has_user INTEGER,           -- 1 when the token carried a real user_id
  PRIMARY KEY (minute, channel, kind)
);
