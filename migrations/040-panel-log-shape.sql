-- Two more columns on the temporary diagnostic from 039, to confirm the fix.
--
-- 039 CAUGHT THE BUG IMMEDIATELY: a row reading `anon` with the prefix `U` on
-- it, which cannot happen if the rule is right. "U" means a signed-in viewer,
-- and we were refusing one. The cause is in `voterId()`, which expected the
-- documented shape - "U" plus the numeric Twitch user id, `U15185913` - and
-- Twitch does not always send that. See twitchdev/issues#559: with ID linking
-- involved the id comes back as "U" plus a long random token, and a single `-`
-- or a sixty-fifth character was enough to make us call UncleUrbi anonymous.
--
-- `shape` is that id with every letter turned into `a` and every digit into `9`,
-- so `U15185913` reads `U99999999`. It answers "what is actually in these
-- things" without storing anybody's id - the difference between knowing there
-- is a hyphen in there and knowing whose hyphen it is.
--
-- AFTER THE FIX, every row should read `known`. An `anon` row with a `U` prefix
-- would mean the new rule is still refusing something, and `shape` and `len`
-- would say what. A genuine `A` row is a logged-out viewer and is correct.
--
--   SELECT datetime(minute * 60, 'unixepoch') AS at, channel, kind, prefix,
--          len, shape, role, unlinked, has_user
--     FROM panel_log ORDER BY minute DESC LIMIT 50;
--
-- TO REMOVE THE WHOLE DIAGNOSTIC when the fix is confirmed:
--   DROP TABLE panel_log;

ALTER TABLE panel_log ADD COLUMN shape TEXT;

ALTER TABLE panel_log ADD COLUMN len INTEGER;
