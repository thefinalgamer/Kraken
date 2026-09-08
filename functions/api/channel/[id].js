/**
 * Whose board belongs to a Twitch channel. GET /api/channel/<twitch user id>
 *
 * THIS IS WHAT CLOSES THE IMPERSONATION HOLE. The panel used to ask the
 * broadcaster to type a PSN ID, and nothing stopped them typing somebody
 * else's: the setting lives in Twitch's own configuration service, owned by
 * that channel, so Kraken could not see it or clear it. Martin, the first time
 * he looked at it: "what happens if i picked someone else id, can i remove it
 * on my end to stop grief". The answer was no.
 *
 * A panel cannot forge the channel it is running on - Twitch's helper hands it
 * the numeric id on load - so matching that against a member who has run
 * /twitch puts the mapping back where it belongs: with Kraken and the member,
 * not with whoever installed the extension. There is nothing left to type.
 *
 * IT ANSWERS WITH A NAME, NOT A HUNTER. One tiny reply, cached hard, and the
 * panel then calls /api/hunter/<name> for everything else. Two requests rather
 * than one, but the expensive half stays a single cacheable URL shared by every
 * viewer on the channel instead of a different URL per channel id.
 *
 * A CHANNEL NOBODY HAS CLAIMED IS A 404, and that is a normal answer rather
 * than a fault - most Twitch channels in the world are not on this board.
 */

/**
 * Longer than the hunter endpoint's thirty seconds, because this changes when
 * somebody runs /twitch and at no other time. A member linking their channel
 * waits at most five minutes to see their own panel fill in.
 */
const CACHE = 300;

const LOOKUP = `
  SELECT psn_online_id, twitch_login
    FROM members
   WHERE twitch_id = ?
     AND rank IS NOT NULL
   LIMIT 1`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${CACHE}`,
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
    },
  });

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '86400',
    },
  });
}

export async function onRequestGet({ params, env }) {
  /**
   * Twitch ids are numeric strings and they are compared as strings, never
   * parsed: JavaScript numbers stop being exact above 2^53 and an id that
   * rounds is an id that matches the wrong member. The digit check is what
   * keeps anything else out of the query.
   */
  const id = String(params.id || '').trim();
  if (!/^\d{1,20}$/.test(id)) return json({ error: 'not a channel id' }, 400);

  /**
   * Wrapped, because `twitch_id` arrives in migration 029. On a database that
   * has not run it this answers "no hunter here" rather than throwing, which is
   * the same thing the panel shows for an unlinked channel - a sentence telling
   * the broadcaster to run /twitch, rather than a broken box.
   */
  const row = await env.DB.prepare(LOOKUP).bind(id).first().catch(() => null);
  if (!row) return json({ hunter: null }, 404);

  return json({ hunter: row.psn_online_id, twitch: row.twitch_login ?? null });
}
