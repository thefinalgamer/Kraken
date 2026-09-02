/**
 * Who is live right now.
 *
 * ONE REQUEST COVERS EVERYBODY. Twitch takes up to a hundred channel names in a
 * single call and answers with only the ones actually streaming, so the whole
 * board costs one request every five minutes whether two people are on or none.
 *
 * WHY THIS EXISTS AT ALL, and it is not for a badge on the website. It is the
 * gate in front of something expensive: the trophy pop wants PSN asked every
 * ten seconds while somebody is streaming, and asking that often for seventy
 * members who are mostly asleep would put the board's own PSN access at risk.
 * Knowing who is on air turns "poll everyone constantly" into "poll two people
 * for four hours", which is the difference between reckless and routine.
 *
 * IT DEGRADES TO NOTHING. No credentials, no members with a channel set, or
 * Twitch having a bad day all end the same way: the check does nothing, says
 * so, and every other part of the site carries on. Nothing here is allowed to
 * be load bearing.
 */

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const STREAMS_URL = 'https://api.twitch.tv/helix/streams';

/** Twitch takes 100 logins per request. The board is nowhere near it. */
const BATCH = 100;

/**
 * The app token, cached in D1.
 *
 * Client credentials, machine to machine: no member ever logs into anything and
 * we can only read what is already public. The token lasts about two months, so
 * fetching one every five minutes would be 288 pointless requests a day. It is
 * cached with a minute of slack against its expiry.
 */
async function appToken(env) {
  const now = Date.now();

  const cached = await env.DB
    .prepare('SELECT value, expires_at FROM worker_state WHERE key = ?')
    .bind('twitch_token')
    .first()
    .catch(() => null);

  if (cached?.value && Number(cached.expires_at) > now + 60000) return cached.value;

  const body = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });

  const res = await fetch(TOKEN_URL, { method: 'POST', body });
  if (!res.ok) throw new Error(`twitch token ${res.status}`);

  const json = await res.json();
  if (!json.access_token) throw new Error('twitch token missing');

  // expires_in is seconds. A minute of slack, so a token cannot expire between
  // being read and being used.
  const expires = now + (Number(json.expires_in) || 3600) * 1000 - 60000;
  await env.DB
    .prepare(
      `INSERT INTO worker_state (key, value, expires_at) VALUES ('twitch_token', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    )
    .bind(json.access_token, expires)
    .run();

  return json.access_token;
}

/** The logins Twitch says are streaming, lowercased, as a Set. */
async function liveNow(env, logins) {
  const token = await appToken(env);
  const live = new Map();

  for (let i = 0; i < logins.length; i += BATCH) {
    const url = new URL(STREAMS_URL);
    for (const login of logins.slice(i, i + BATCH)) url.searchParams.append('user_login', login);

    const res = await fetch(url, {
      headers: { 'Client-Id': env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`twitch streams ${res.status}`);

    const json = await res.json();
    for (const s of json.data ?? []) {
      // `type` is "live" for a real broadcast. Anything else is a rerun or a
      // state Twitch has invented since, and neither is somebody at a console.
      if (s.type && s.type !== 'live') continue;
      const at = Date.parse(s.started_at);
      live.set(String(s.user_login).toLowerCase(), Number.isFinite(at) ? at : Date.now());
    }
  }

  return live;
}

/**
 * Ask Twitch, write the answer, return a one line summary for the log.
 *
 * WRITES ONLY WHAT CHANGED. Every member with a channel gets `live_checked_at`
 * stamped, because "we asked and they are off" is different information from
 * "we have not asked since Tuesday". But `live_since` is only written when the
 * value actually moves, so a quiet Tuesday costs no writes at all beyond the
 * timestamps.
 */
export async function checkLive(env) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    return 'twitch: no credentials, skipped';
  }

  const { results: rows = [] } = await env.DB
    .prepare(
      `SELECT psn_account_id, twitch_login, live_since FROM members
        WHERE twitch_login IS NOT NULL AND TRIM(twitch_login) <> ''`,
    )
    .all();

  if (!rows.length) return 'twitch: nobody has a channel set';

  let live;
  try {
    live = await liveNow(env, rows.map((r) => String(r.twitch_login).toLowerCase()));
  } catch (err) {
    /**
     * A FAILED CHECK LEAVES THE LAST ANSWER ALONE.
     *
     * Writing "nobody is live" because Twitch returned a 503 would take the
     * pop's fast polling away mid stream, and the person it happened to would
     * have no idea why their overlay went quiet. Stale and honest beats fresh
     * and wrong.
     */
    return `twitch: check failed, keeping last answer (${err.message})`;
  }

  const now = Date.now();
  const writes = [];

  for (const r of rows) {
    const at = live.get(String(r.twitch_login).toLowerCase()) ?? null;
    const was = r.live_since == null ? null : Number(r.live_since);

    writes.push(
      at === was
        ? env.DB.prepare('UPDATE members SET live_checked_at = ? WHERE psn_account_id = ?')
            .bind(now, r.psn_account_id)
        : env.DB
            .prepare(
              'UPDATE members SET live_since = ?, live_checked_at = ? WHERE psn_account_id = ?',
            )
            .bind(at, now, r.psn_account_id),
    );
  }

  await env.DB.batch(writes);
  return `twitch: ${live.size} live of ${rows.length} watched`;
}

/**
 * Is this member on air, according to the last check that worked?
 *
 * `live_since` alone would be a lie the moment the cron stopped running: a
 * stream that ended while the check was broken would stay "live" forever, and
 * the thing reading this decides whether to poll PSN. So a live answer expires
 * on its own if nobody has confirmed it recently.
 */
export const LIVE_STALE_MS = 15 * 60 * 1000;

export function isLive(member, now = Date.now()) {
  const since = Number(member?.live_since);
  if (!Number.isFinite(since) || since <= 0) return false;
  const checked = Number(member?.live_checked_at) || 0;
  return now - checked < LIVE_STALE_MS;
}
