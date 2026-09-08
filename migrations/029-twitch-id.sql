-- Twitch's numeric channel id, so the panel cannot be pointed at somebody else.
--
-- THE HOLE THIS CLOSES. The Twitch panel asked the broadcaster to type a PSN ID
-- into a text box. Nothing stopped them typing somebody else's: the setting
-- lives in Twitch's own configuration service, owned by that channel, and
-- Kraken never sees it and cannot clear it. Martin asked the right question the
-- first time he looked at it - "what happens if i picked someone else id, can i
-- remove it on my end to stop grief" - and the answer was no.
--
-- The data was never the problem. Every figure on that panel is on a public web
-- page already. The problem is a viewer being shown one hunter's numbers under
-- another hunter's name.
--
-- THE FIX IS TO STOP ASKING. A panel knows the numeric id of the channel it is
-- running on - Twitch's helper hands it over on load and a broadcaster cannot
-- forge it. Match that against a member who has run /twitch and the mapping
-- belongs to Kraken rather than to whoever installed the extension, so there is
-- nothing left to type and nothing left to impersonate.
--
-- IT COSTS NO EXTRA REQUESTS. `user_id` already arrives in the same helix
-- /streams response the live check reads every five minutes, so members who
-- stream fill this in by themselves. /twitch resolves it once for everybody
-- else at the moment they set their channel.
--
-- Stored as TEXT because Twitch ids are numeric strings and JavaScript numbers
-- stop being exact above 2^53. Nothing here ever does arithmetic on one.
--
-- Run once against the live database:
--   Cloudflare dashboard, D1, platinum-intel, Console. Paste and run.

ALTER TABLE members ADD COLUMN twitch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_members_twitch_id
  ON members(twitch_id) WHERE twitch_id IS NOT NULL;
