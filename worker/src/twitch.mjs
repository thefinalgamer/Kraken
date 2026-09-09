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

import {
  MARK_WINDOW_SQL, MIN_STREAM_MS, SWEEP_WINDOW_MS, streamWindow, sweepable,
} from '../../shared/on-stream.mjs';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const STREAMS_URL = 'https://api.twitch.tv/helix/streams';
const USERS_URL = 'https://api.twitch.tv/helix/users';

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
      live.set(String(s.user_login).toLowerCase(), {
        since: Number.isFinite(at) ? at : Date.now(),
        /**
         * The numeric channel id, which is what the Twitch panel identifies a
         * channel by. It arrives in this response already, so capturing it
         * costs nothing and means anybody who streams links themselves without
         * being asked. See migration 029.
         */
        id: typeof s.user_id === 'string' && s.user_id ? s.user_id : null,
        // Everything below arrives in this same response, so carrying it costs
        // nothing. "Leon is live" is a fact; a card showing what is on his
        // screen, what he is playing and who is watching is a reason to click.
        game: typeof s.game_name === 'string' && s.game_name.trim() ? s.game_name.trim() : null,
        viewers: Number.isFinite(Number(s.viewer_count)) ? Number(s.viewer_count) : null,
        /**
         * The thumbnail comes as a template with {width} and {height} in it.
         * Sized here rather than on the page so the site never has to know the
         * shape of a Twitch URL, and only the finished address is stored.
         */
        thumb: typeof s.thumbnail_url === 'string' && s.thumbnail_url.startsWith('https://')
          ? s.thumbnail_url.replace('{width}', '640').replace('{height}', '360')
          : null,
        mature: s.is_mature ? 1 : 0,
      });
    }
  }

  return live;
}

/**
 * One channel's numeric id, by login.
 *
 * WHY /twitch NEEDS THIS AND THE LIVE CHECK IS NOT ENOUGH. The live check only
 * ever sees people who are actually streaming, so a member who sets a channel
 * and then does not go live for a fortnight would have no id, and their panel
 * would have nothing to match against for a fortnight. This resolves it at the
 * moment they set it, which is also the moment they are watching for a reply.
 *
 * ONE REQUEST, AND FAILURE IS FREE. A null here means the panel falls back to
 * saying the channel is not linked yet, and the next stream fills it in anyway.
 * Nothing about /twitch is allowed to fail because Twitch had a bad second.
 */
export async function channelId(env, login) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return null;
  try {
    const token = await appToken(env);
    const url = new URL(USERS_URL);
    url.searchParams.set('login', String(login).toLowerCase());
    const res = await fetch(url, {
      headers: { 'Client-Id': env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const id = json?.data?.[0]?.id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Look several channels up at once, by login or by numeric id.
 *
 * ONE REQUEST FOR THE WHOLE BOARD, the same shape as the live check: helix/users
 * takes up to a hundred `login` and `id` parameters combined and answers with
 * only the ones that exist. Resolving nine missing ids one at a time would be
 * nine round trips inside a Discord interaction that has three seconds to live.
 *
 * BY ID WHERE WE HAVE ONE, BY LOGIN WHERE WE DO NOT, and the asymmetry matters.
 * A Twitch id is permanent; a login is not. Somebody who renames their channel
 * keeps their id and breaks their login, so the live check quietly stops finding
 * them and nothing says why. Asking by id is how a rename gets noticed at all.
 *
 * Anything Twitch does not return is simply absent from the map. That is the
 * answer for a channel that never existed and for one that has been deleted,
 * and the caller wants to report both the same way: "Twitch does not know this
 * name."
 */
export async function lookupChannels(env, { logins = [], ids = [] } = {}) {
  const out = { byLogin: new Map(), byId: new Map() };
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return out;

  const params = [
    ...ids.filter(Boolean).map((v) => ['id', String(v)]),
    ...logins.filter(Boolean).map((v) => ['login', String(v).toLowerCase()]),
  ];
  if (!params.length) return out;

  let token;
  try {
    token = await appToken(env);
  } catch {
    return out;
  }

  for (let i = 0; i < params.length; i += BATCH) {
    const url = new URL(USERS_URL);
    for (const [key, value] of params.slice(i, i + BATCH)) url.searchParams.append(key, value);

    let json;
    try {
      const res = await fetch(url, {
        headers: { 'Client-Id': env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
      });
      if (!res.ok) continue;
      json = await res.json();
    } catch {
      continue;
    }

    for (const u of json?.data ?? []) {
      const id = typeof u.id === 'string' && u.id ? u.id : null;
      const login = typeof u.login === 'string' && u.login ? u.login.toLowerCase() : null;
      if (!id || !login) continue;
      const row = { id, login };
      out.byId.set(id, row);
      out.byLogin.set(login, row);
    }
  }

  return out;
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
export async function checkLive(env, { onStreamEnd = null } = {}) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    return 'twitch: no credentials, skipped';
  }

  const { results: rows = [] } = await env.DB
    .prepare(
      `SELECT psn_account_id, discord_id, twitch_login, twitch_id, live_since,
              live_game, last_stream_start, last_stream_end, last_update_at
         FROM members
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
  // Whoever went off air on this tick. Used after the batch to drop game pins.
  const ended = [];
  /** The same streams as objects, for the scan dispatch below. */
  const finished = [];

  for (const r of rows) {
    const on = live.get(String(r.twitch_login).toLowerCase()) ?? null;
    const at = on?.since ?? null;
    const game = on?.game ?? null;

    /**
     * A live stream is written EVERY time, because the viewer count and the
     * thumbnail both move while nothing else does. An off stream is written
     * only when it was on last time, so a board where nobody is streaming
     * costs one timestamp per member and nothing else.
     */
    const wasOn = r.live_since != null;

    /**
     * REMEMBER THE WINDOW WHEN A STREAM ENDS.
     *
     * `live_since` is about right now and goes null the moment they are off,
     * which is useless for what happens next: somebody streams for four hours,
     * goes off, and THEN runs /update. The scan writes those trophies with the
     * stream long over and nothing is left to say anybody was watching.
     *
     * So the window is kept, and swept for a while afterwards.
     */
    const justEnded = wasOn && !on;
    if (justEnded) {
      ended.push(r.psn_account_id);
      finished.push({ row: r, from: Number(r.live_since), to: now });
    }

    writes.push(
      !on && !wasOn
        ? env.DB.prepare('UPDATE members SET live_checked_at = ? WHERE psn_account_id = ?')
            .bind(now, r.psn_account_id)
        : env.DB
            .prepare(
              `UPDATE members
                  SET live_since = ?, live_game = ?, live_viewers = ?, live_thumb = ?,
                      live_mature = ?, live_checked_at = ?` +
                (justEnded ? ', last_stream_start = ?, last_stream_end = ?' : '') +
                ' WHERE psn_account_id = ?',
            )
            .bind(
              at, game, on?.viewers ?? null, on?.thumb ?? null, on?.mature ?? null, now,
              ...(justEnded ? [Number(r.live_since), now] : []),
              r.psn_account_id,
            ),
    );
  }

  await env.DB.batch(writes);

  /**
   * A GAME PIN DOES NOT OUTLIVE THE STREAM THAT NEEDED IT.
   *
   * `/setgame` is a fail-safe for PSN being slow to reorder somebody's
   * recently-played list, which only matters while a bar is on screen. Left
   * standing it would show the wrong game on the next stream instead, so going
   * off air takes it off. The poll drops it too, the moment a trophy lands in
   * a different game. See migration 027.
   *
   * SEPARATE FROM THE BATCH ON PURPOSE. `live_pin` arrives in migration 027 and
   * a batch is all-or-nothing: folded into the writes above, a database that
   * has not run it yet would lose the entire live check rather than one pin
   * clear. Same seatbelt every migration since 024 carries.
   */
  /**
   * LEARN THE CHANNEL ID FROM A STREAM WE WERE READING ANYWAY.
   *
   * Only when it actually moves - a first sighting, or a member who renamed
   * their channel onto an id we have not seen. Every other tick this costs
   * nothing, which is the same rule every other write in this function follows.
   *
   * Outside the batch, because `twitch_id` arrives in migration 029 and a batch
   * is all or nothing: folded in above, a database that has not run it yet
   * would lose the entire live check rather than one id.
   */
  const ids = [];
  for (const r of rows) {
    const on = live.get(String(r.twitch_login).toLowerCase());
    if (on?.id && on.id !== r.twitch_id) ids.push([on.id, r.psn_account_id]);
  }
  for (const [id, account] of ids) {
    await env.DB.prepare('UPDATE members SET twitch_id = ? WHERE psn_account_id = ?')
      .bind(id, account)
      .run()
      .catch(() => {});
  }

  if (ended.length) {
    await env.DB.prepare(
      'UPDATE members SET live_pin = NULL, live_pin_at = NULL WHERE psn_account_id IN (' +
        ended.map(() => '?').join(',') +
        ')',
    )
      .bind(...ended)
      .run()
      .catch(() => {});
  }

  /**
   * THE CATCH-UP SWEEP.
   *
   * Marks anything earned inside a stream window. The poll already does this
   * while somebody is on air; this is for the rows that only turn up
   * afterwards, when they finally run /update.
   *
   * A little slack past the end of the stream, because a trophy that popped in
   * the last minute of a broadcast has an `earned_at` fractionally after the
   * moment Twitch noticed the stream stop.
   *
   * THE WINDOW USED TO BE TWELVE HOURS AND THAT WAS TOO SHORT. Ragowit streamed
   * for ten hours on 8 September, finished at 17:15, and ran /update the next
   * morning at 08:56 -- three hours and forty-one minutes after the sweep had
   * given up on him. Fourteen trophies earned on camera, none of them marked,
   * and nothing anywhere said why he was missing from the board.
   *
   * The poll could not save him either. It only sees what PSN has published,
   * and a member whose console does not sync mid-session publishes nothing
   * until they update. For anybody who plays that way -- which is most people;
   * Leon syncing after every trophy is the unusual one -- the sweep is the ONLY
   * route, so its window has to be longer than a night's sleep.
   *
   * WIDENING THIS CANNOT MARK A TROPHY THAT WAS NOT EARNED ON STREAM. The
   * window being swept is fixed by `last_stream_start` and `last_stream_end`;
   * the number below only decides how long we keep re-running the same sweep in
   * case more rows arrive. Three days covers "streamed at the weekend, updated
   * on Monday" without pretending a week-old session is still settling.
   *
   * STILL ONLY THE LAST STREAM. `last_stream_start`/`last_stream_end` is one
   * pair of columns, so somebody who streams Monday and Tuesday and updates on
   * Wednesday gets Tuesday and loses Monday. Fixing that needs a table of
   * windows, which is a migration and is parked.
   *
   * Only rows that are not already flagged, only members who have actually
   * updated since the stream began -- if they have not, there are provably no
   * new rows to find and the statement is pure waste -- and it runs at most
   * once every five minutes for the whole board.
   */
  const recent = rows
    .map((r) => ({ r, w: streamWindow(r) }))
    .filter(
      ({ r, w }) =>
        sweepable(w, now) &&
        // Nothing new can have arrived if they have not scanned since the
        // stream began, so the statement would be pure waste. This is what
        // stops a three day window becoming an UPDATE per streamer every five
        // minutes for three days, almost all of them no-ops.
        Number(r.last_update_at) > w.from,
    );

  if (recent.length) {
    await env.DB.batch(
      recent.map(({ r, w }) =>
        env.DB.prepare(MARK_WINDOW_SQL).bind(r.psn_account_id, w.from, w.to),
      ),
    ).catch(() => {});
  }

  /**
   * A STREAM ENDING IS THE MOMENT TO GO AND LOOK.
   *
   * Martin: *"i think we need an auto update for when some ends stream, this
   * way it will help people on console or people who aint using the overlay"*.
   * He is right, and it is the root fix rather than the patch the sweep is: the
   * sweep exists because trophies arrive late, and scanning on stream end is
   * how they stop arriving late.
   *
   * WHO IT ACTUALLY HELPS. The live poll only ever sees what PSN has published,
   * so a member whose console does not sync mid-session is invisible to it for
   * the entire broadcast. Ragowit streamed for ten hours and the poll caught
   * nothing, because there was nothing published to catch. Those members have
   * never had a route that did not depend on them remembering to run /update.
   *
   * THIRTY MINUTES, NOT A COOLDOWN. Twitch reports a dropped connection as a
   * stream ending and a new one starting, so a flapping evening would otherwise
   * be a dozen scans. Martin's rule handles it more cleanly than a timer: each
   * fragment of a flapping connection is short, so none of them qualifies,
   * while one real session that drops and comes back for another hour fires
   * twice -- two scans for one evening, which is affordable.
   *
   * IT IS A DISPATCH, NOT A SCAN. All this does is post to the GitHub Actions
   * API, exactly as /update does; the hundreds of PSN calls happen on a runner
   * with no subrequest cap. No heavy work enters the Worker.
   *
   * The callback is passed in rather than imported, because the Worker's
   * dispatcher lives in index.mjs and index.mjs imports this file. Same shape
   * oauth.handleCallback already uses for the same reason.
   */
  if (onStreamEnd) {
    for (const { row, from, to } of finished) {
      if (!row.discord_id) continue;
      if (to - from < MIN_STREAM_MS) continue;
      try {
        await onStreamEnd(env, String(row.discord_id), null, {
          reason: 'stream-end',
          stream_start: from,
          stream_end: to,
        });
      } catch (err) {
        // A failed dispatch must never take the live check down with it. The
        // sweep is still there, and they can still run /update themselves.
        console.error('stream-end scan dispatch failed:', err?.message ?? err);
      }
    }
  }

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
