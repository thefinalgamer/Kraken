-- Every stored image URL becomes https.
--
-- PSN serves its images from four hosts and two of them are plain http:
--
--   https://image.api.playstation.com                      game art, newer
--   https://psnobj.prod.dl.playstation.net                 game art, older
--   http://static-resource.np.community.playstation.net    avatars
--   http://psn-rsc.prod.dl.playstation.net                 avatars
--
-- The site is https, so those last two are mixed content. Browsers have not
-- simply loaded them for years: Chrome quietly upgrades a mixed image to https
-- and blocks it when that fails, and others block it outright. So those avatars
-- either worked by luck or were invisible to some members the whole time, and
-- nothing on the page said which. Nobody reported it because a missing avatar
-- looks like a member who never set one.
--
-- It became unavoidable with the Twitch panel: an extension declares its image
-- hosts in a Content Security Policy allowlist, and an https page cannot
-- usefully allowlist an http origin.
--
-- SAFE EITHER WAY. An http image inside an https page was never going to load
-- as http, so upgrading cannot be worse than what it replaces. If a host turns
-- out not to answer on https, the page falls back to the blank avatar it was
-- already showing.
--
-- Only rows that actually move are written - the same rule the nightly rescore
-- follows - so re-running this costs nothing.
--
-- The scan stores https from now on (see the https() helper in jobs/scan.mjs)
-- and functions/_lib/page.js upgrades anything left behind at render time, so
-- this is a tidy-up rather than the fix itself.
--
-- Run once against the live database:
--   Cloudflare dashboard, D1, platinum-intel, Console. Paste and run.

UPDATE members
   SET avatar_url = 'https://' || substr(avatar_url, 8)
 WHERE avatar_url LIKE 'http://%';

UPDATE games
   SET icon_url = 'https://' || substr(icon_url, 8)
 WHERE icon_url LIKE 'http://%';

UPDATE trophies
   SET icon_url = 'https://' || substr(icon_url, 8)
 WHERE icon_url LIKE 'http://%';
