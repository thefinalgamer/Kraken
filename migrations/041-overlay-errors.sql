-- A TEMPORARY DIAGNOSTIC. Drop it once the question below is answered.
--
-- THE QUESTION. JFL__Leon, 9 October: "everytime he earns a trophy his overlay
-- is disapears he has to refresh". The overlay has a catch-all that turns any
-- failure into an empty, transparent page rather than letting Cloudflare's own
-- error banner land across somebody's stream, so "disappears" is exactly what
-- a thrown error looks like from the outside.
--
-- Half of his complaint is already explained and fixed: that empty page carried
-- a sixty second refresh while the live bar had moved to ten, so one bad render
-- cost him a full minute of nothing. He would reach for refresh long before it
-- repaired itself. That is a sentence anybody could have written without this
-- table.
--
-- WHAT THIS TABLE IS FOR is the other half: WHY it threw at all, and whether it
-- really is tied to a trophy landing or just happens often enough to look that
-- way. The handler logs to the console, which only reaches the Cloudflare
-- dashboard; this puts it where Martin already works, which is the D1 console.
--
-- ONE ROW PER MEMBER PER MINUTE. The overlay refreshes every ten seconds while
-- somebody is live, so without the primary key doing the throttling one broken
-- bar would write six rows a minute for a whole broadcast. A row means "this
-- member's overlay failed at least once that minute", never a count.
--
-- TO READ IT, in the D1 console:
--
--   SELECT datetime(minute * 60, 'unixepoch') AS at, name, message
--     FROM overlay_errors ORDER BY minute DESC LIMIT 50;
--
-- Compare the times against when somebody earned something:
--
--   SELECT datetime(mt.earned_at / 1000, 'unixepoch') AS earned, g.title
--     FROM member_trophies mt
--     JOIN games g ON g.np_comm_id = mt.np_comm_id
--     JOIN members m ON m.psn_account_id = mt.psn_account_id
--    WHERE m.psn_online_id = 'JFL__Leon' COLLATE NOCASE
--    ORDER BY mt.earned_at DESC LIMIT 20;
--
-- An empty table after a stream with trophies in it is an answer too: it would
-- mean nothing is throwing, and the disappearing was the sixty second gap all
-- along.
--
-- TO REMOVE IT when we are done: DROP TABLE overlay_errors;

CREATE TABLE IF NOT EXISTS overlay_errors (
  minute  INTEGER NOT NULL,  -- epoch seconds / 60
  name    TEXT    NOT NULL,  -- the psn_online_id in the overlay URL
  message TEXT,              -- whatever threw, trimmed
  PRIMARY KEY (minute, name)
);
