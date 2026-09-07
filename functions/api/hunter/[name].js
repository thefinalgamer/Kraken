/**
 * One hunter, as JSON. GET /api/hunter/<psn online id>
 *
 * WHY THIS EXISTS AND WHY IT IS ONE ENDPOINT.
 *
 * The Twitch panel is 318 pixels wide and four tabs deep, and it is loaded by
 * every viewer on a channel at once. Four endpoints would mean four round trips
 * per viewer to draw one panel; this is one fetch that answers the whole thing,
 * and every field in it exists because something on that panel prints it.
 *
 * IT COMPUTES NOTHING, same rule as every page on this site. `t.points` is what
 * the bot priced the trophy at, `g.max_points` is what a full completion pays,
 * `m.points` is the score on the card. The only arithmetic here is subtraction
 * for the gaps and `applyCompletion` for the live figure, which is the shared
 * function the scan and the rescore both use.
 *
 * PUBLIC, CORS OPEN, NO KEY. Every number in it is already on a public web page
 * that needs no login, so a key would be a lock on an open door. What it must
 * never carry is anything the site does not already print: no discord ids, no
 * twitch tokens, no psn account ids.
 *
 * THIRTY SECONDS OF EDGE CACHE is what makes it affordable. Three hundred
 * viewers refreshing a panel every minute is five requests a second; cached at
 * Cloudflare's edge that is two database reads a minute rather than three
 * hundred.
 */

import { applyCompletion } from '../../../shared/scoring.mjs';

/** How long the edge may serve a copy. See the header comment. */
const CACHE = 30;

/**
 * A live answer nobody has confirmed lately is a lie, and this is the same
 * cutoff the home page uses. The five minute cron writes `live_checked_at`
 * whether they are on or off, so a stale row means the cron stopped rather
 * than that they are still streaming.
 */
const LIVE_STALE_MS = 11 * 60 * 1000;

/** How long a `live_play` note is worth believing. */
const LIVE_PLAY_MS = 15 * 60 * 1000;

/** Closing games worth warning about, and how many to name. */
const CLOSING_LIMIT = 3;

/**
 * A milestone is only interesting when it is nearly done.
 *
 * "2 trophies from his 215th platinum" is a countdown. "2,847 from his next
 * thousand" is noise, and a panel that always has something to say is a panel
 * that never says anything. So the game has to be within reach AND carry a
 * platinum, or the card is simply absent.
 */
const MILESTONE_WITHIN = 10;

const MEMBER = `
  SELECT psn_account_id, psn_online_id, avatar_url, rank, points, raw_points,
         completion, platinum, gold, silver, bronze, projects, completed,
         rarest_name, rarest_rate, rarest_game,
         twitch_login, live_since, live_checked_at, live_viewers,
         live_play, last_stream_start, last_stream_end, last_update_at
    FROM members
   WHERE psn_online_id = ? COLLATE NOCASE
     AND rank IS NOT NULL
   LIMIT 1`;

/** The whole field, for "31st of 75". */
const TOTAL = 'SELECT COUNT(*) AS c FROM members WHERE rank IS NOT NULL';

/** Whoever is one place above, for the chase. */
const AHEAD = 'SELECT rank, psn_online_id, points FROM members WHERE rank = ? LIMIT 1';

/**
 * `local_started` and the platinum's `local_earned` are the two figures no
 * other trophy site can print, and they are the reason the panel is worth
 * installing at all.
 */
const GAME_COLS = `
  g.np_comm_id, g.title, g.platform, g.icon_url, g.trophy_count, g.max_points,
  g.local_started, g.unobtainable, g.closes_at,
  mg.points, mg.progress, mg.earned_total,
  (SELECT t.local_earned FROM trophies t
    WHERE t.np_comm_id = g.np_comm_id AND t.type = 'platinum' LIMIT 1) AS plat_local`;

const ONE_GAME = `
  SELECT ${GAME_COLS}
    FROM games g
    LEFT JOIN member_games mg
      ON mg.np_comm_id = g.np_comm_id AND mg.psn_account_id = ?
   WHERE g.np_comm_id = ?
   LIMIT 1`;

const PLAYING = `
  SELECT ${GAME_COLS}
    FROM member_games mg
    JOIN games g ON g.np_comm_id = mg.np_comm_id
   WHERE mg.psn_account_id = ?
   ORDER BY COALESCE(mg.last_played_at, mg.last_earned_at, 0) DESC
   LIMIT 1`;

/**
 * The nearest platinum they have not got.
 *
 * Ordered by trophies remaining, so "two away" beats "two hundred away" even
 * if the two hundred is worth more. A milestone is about proximity.
 */
const MILESTONE = `
  SELECT g.title, g.icon_url, g.trophy_count, mg.earned_total,
         (g.trophy_count - mg.earned_total) AS need
    FROM member_games mg
    JOIN games g ON g.np_comm_id = mg.np_comm_id
   WHERE mg.psn_account_id = ?
     AND g.has_platinum = 1
     AND mg.progress < 100
     AND g.trophy_count > 0
     AND (g.trophy_count - mg.earned_total) BETWEEN 1 AND ?
   ORDER BY need ASC, g.max_points DESC
   LIMIT 1`;

/**
 * Games in their library with a deadline they have not beaten yet.
 *
 * The one genuinely urgent thing this project knows. `closes_at` is set by a
 * mod with /flag, so it is a human saying "these servers go off in March"
 * rather than anything Sony publishes.
 */
const CLOSING = `
  SELECT g.np_comm_id, g.title, g.icon_url, g.closes_at, g.max_points,
         g.trophy_count, mg.progress, mg.earned_total, mg.points
    FROM member_games mg
    JOIN games g ON g.np_comm_id = mg.np_comm_id
   WHERE mg.psn_account_id = ?
     AND mg.progress < 100
     AND g.closes_at IS NOT NULL
     AND g.closes_at > ?
   ORDER BY g.closes_at ASC
   LIMIT ?`;

/** The top of the board, for the panel's Board tab. */
const TOP = `
  SELECT rank, psn_online_id, avatar_url, points
    FROM members
   WHERE rank IS NOT NULL
   ORDER BY rank ASC
   LIMIT ?`;

/** The rows either side of them, so the board can collapse around their row. */
const AROUND = `
  SELECT rank, psn_online_id, avatar_url, points
    FROM members
   WHERE rank IS NOT NULL AND rank BETWEEN ? AND ?
   ORDER BY rank ASC`;

/**
 * Their list of games they want to play, priced.
 *
 * Wrapped at the call site, because the table arrives in a later migration and
 * a panel must not go down on a database that has not run it. Same seatbelt
 * every feature since migration 019 carries.
 */
const WISHLIST = `
  SELECT w.np_comm_id, g.title, g.icon_url, g.platform, g.max_points,
         g.local_started,
         (SELECT COUNT(*) FROM member_games x
           WHERE x.np_comm_id = g.np_comm_id AND x.progress = 100) AS finished_here
    FROM wishlist w
    JOIN games g ON g.np_comm_id = w.np_comm_id
   WHERE w.psn_account_id = ?
   ORDER BY w.added_at DESC
   LIMIT 12`;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${CACHE}`,
      // Open on purpose: a Twitch extension runs on an origin nobody can
      // predict, and everything here is already on a public page.
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
    },
  });

/** A game row, shaped once so every place that returns one agrees. */
const gameOut = (g, extra = {}) =>
  g
    ? {
        id: g.np_comm_id,
        title: g.title,
        platform: g.platform ?? null,
        icon: g.icon_url ?? null,
        trophies: num(g.trophy_count),
        earned: num(g.earned_total) ?? 0,
        progress: num(g.progress) ?? 0,
        points: num(g.points) ?? 0,
        max: num(g.max_points) ?? 0,
        ownedHere: num(g.local_started) ?? 0,
        finishedHere: num(g.plat_local) ?? 0,
        closesAt: num(g.closes_at),
        unobtainable: Number(g.unobtainable) === 1,
        ...extra,
      }
    : null;

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
  const name = decodeURIComponent(params.name || '').trim().slice(0, 40);
  if (!name) return json({ error: 'no hunter named' }, 400);

  const m = await env.DB.prepare(MEMBER).bind(name).first();
  if (!m) return json({ error: 'no such hunter' }, 404);

  const now = Date.now();

  /**
   * ON AIR, and the same two-part test the rest of the site uses: Twitch said
   * they were live, AND we asked recently enough to believe it.
   */
  const live = (num(m.live_since) ?? 0) > 0
    && now - (num(m.live_checked_at) ?? 0) < LIVE_STALE_MS;

  // What the poll last saw them playing. A note that fails to parse is a note
  // that never existed - this is a panel on somebody's channel and there is no
  // version of a broken blob worth an exception.
  let play = null;
  try {
    const parsed = JSON.parse(m.live_play || 'null');
    if (parsed?.id && now - (num(parsed.at) ?? 0) < LIVE_PLAY_MS) play = parsed;
  } catch {
    play = null;
  }

  const rank = num(m.rank) ?? 1;

  const [total, ahead, playing, milestone, closing, top, around, list] = await Promise.all([
    env.DB.prepare(TOTAL).first().catch(() => null),
    rank > 1
      ? env.DB.prepare(AHEAD).bind(rank - 1).first().catch(() => null)
      : Promise.resolve(null),
    play
      ? env.DB.prepare(ONE_GAME).bind(m.psn_account_id, play.id).first().catch(() => null)
      : env.DB.prepare(PLAYING).bind(m.psn_account_id).first().catch(() => null),
    env.DB.prepare(MILESTONE).bind(m.psn_account_id, MILESTONE_WITHIN)
      .first().catch(() => null),
    env.DB.prepare(CLOSING).bind(m.psn_account_id, now, CLOSING_LIMIT)
      .all().catch(() => ({ results: [] })),
    env.DB.prepare(TOP).bind(5).all().catch(() => ({ results: [] })),
    env.DB.prepare(AROUND).bind(Math.max(1, rank - 1), rank + 1)
      .all().catch(() => ({ results: [] })),
    // The wishlist table arrives in a later migration. An empty list is a
    // panel with one quiet tab; a thrown query is no panel at all.
    env.DB.prepare(WISHLIST).bind(m.psn_account_id).all().catch(() => ({ results: [] })),
  ]);

  /**
   * THE LIVE SCORE, and it is the same arithmetic the overlay does.
   *
   * `raw_points` is the pre-multiplier sum, `playing.points` is the game's
   * stale share of it, and `play.points` is what the poll priced the same game
   * at seconds ago. Swap one for the other and run the WHOLE total through
   * applyCompletion, exactly as the rescore does - flooring once, where the
   * rescore floors once, so the panel agrees with the update that follows it.
   */
  const stored = num(m.points) ?? 0;
  const raw = num(m.raw_points);
  const priced = play && Number.isFinite(Number(play.points)) ? Number(play.points) : null;
  const points =
    playing && raw !== null && priced !== null
      ? applyCompletion(raw - (num(playing.points) ?? 0) + priced, m.completion)
      : stored;

  /**
   * Counts come from the poll when it has them. A pinned game PSN has not
   * caught up with carries `counts: false` and no figures, and merging zeroes
   * over the scan's real ones would be a worse lie than a stale number.
   */
  const fresh = play && play.counts !== false ? play : null;

  const game = gameOut(playing, {
    ...(priced !== null ? { points: priced } : {}),
    ...(fresh
      ? {
          progress: num(fresh.progress) ?? 0,
          earned:
            (num(fresh.platinum) ?? 0) + (num(fresh.gold) ?? 0) +
            (num(fresh.silver) ?? 0) + (num(fresh.bronze) ?? 0),
        }
      : {}),
  });

  const rows = (r) =>
    (r?.results ?? []).map((x) => ({
      rank: num(x.rank),
      name: x.psn_online_id,
      avatar: x.avatar_url ?? null,
      points: num(x.points) ?? 0,
    }));

  return json({
    hunter: {
      name: m.psn_online_id,
      avatar: m.avatar_url ?? null,
      rank,
      of: num(total?.c) ?? 0,
      points,
      // What the board currently shows, kept beside the live figure so a
      // reader can tell the difference rather than guess at it.
      storedPoints: stored,
      completion: num(m.completion) ?? 0,
      cabinet: {
        platinum: num(m.platinum) ?? 0,
        gold: num(m.gold) ?? 0,
        silver: num(m.silver) ?? 0,
        bronze: num(m.bronze) ?? 0,
      },
      games: { started: num(m.projects) ?? 0, completed: num(m.completed) ?? 0 },
      rarest:
        m.rarest_name && (num(m.rarest_rate) ?? 0) > 0
          ? { name: m.rarest_name, rate: num(m.rarest_rate), game: m.rarest_game ?? null }
          : null,
      updatedAt: num(m.last_update_at),
    },

    live: {
      on: live,
      since: live ? num(m.live_since) : null,
      viewers: live ? num(m.live_viewers) : null,
      twitch: m.twitch_login ?? null,
      lastStream: { start: num(m.last_stream_start), end: num(m.last_stream_end) },
    },

    playing: game,

    chase: ahead
      ? {
          rank: num(ahead.rank),
          name: ahead.psn_online_id,
          // Against the LIVE figure, so the gap closes while they play rather
          // than at their next update.
          gap: Math.max(0, (num(ahead.points) ?? 0) - points),
          past: (num(ahead.points) ?? 0) <= points,
        }
      : null,

    milestone: milestone
      ? {
          kind: 'platinum',
          at: (num(m.platinum) ?? 0) + 1,
          need: num(milestone.need),
          title: milestone.title,
          icon: milestone.icon_url ?? null,
        }
      : null,

    closing: (closing?.results ?? []).map((g) => ({
      id: g.np_comm_id,
      title: g.title,
      icon: g.icon_url ?? null,
      closesAt: num(g.closes_at),
      left: Math.max(0, (num(g.trophy_count) ?? 0) - (num(g.earned_total) ?? 0)),
      points: Math.max(0, (num(g.max_points) ?? 0) - (num(g.points) ?? 0)),
    })),

    list: (list?.results ?? []).map((g) => ({
      id: g.np_comm_id,
      title: g.title,
      icon: g.icon_url ?? null,
      platform: g.platform ?? null,
      points: num(g.max_points) ?? 0,
      ownedHere: num(g.local_started) ?? 0,
      finishedHere: num(g.finished_here) ?? 0,
    })),

    board: { top: rows(top), around: rows(around) },
  });
}
