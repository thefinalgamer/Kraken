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

import { applyCompletion, displayBanked } from '../../../shared/scoring.mjs';
import { secureUrl } from '../../_lib/page.js';
import { FINISHABLE_SQL } from '../../../shared/votes.mjs';
import { goalStatus, amount as goalAmount, rateAmount as goalRateAmount } from '../../../shared/goals.mjs';

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
 * `local_started` and `finished_here` are the two figures no other trophy site
 * can print, and they are the reason the panel is worth installing at all.
 *
 * FINISHED MEANS 100%, NOT THE PLATINUM. This shipped counting the platinum's
 * local_earned, so the panel read "8 of us finished" when it meant "8 of us
 * platted" -- a smaller number, and a wrong one on any game with no platinum
 * at all, where it read "nobody has finished it" about a game several people
 * had 100%'d. The site and the Discord embeds have counted progress = 100
 * since the day that came up there; this is the same count, and the two are
 * meant to agree.
 *
 * The platinum's local_earned stays, under its own name, because the scoring
 * model genuinely is platinum-based: localMultiplier asks how many people got
 * stuck before the platinum, which is a different question to how many got to
 * 100%.
 */
const GAME_COLS = `
  g.np_comm_id, g.title, g.platform, g.icon_url, g.trophy_count, g.max_points,
  g.local_started, g.unobtainable, g.closes_at,
  mg.points, mg.progress, mg.earned_total,
  (SELECT t.local_earned FROM trophies t
    WHERE t.np_comm_id = g.np_comm_id AND t.type = 'platinum' LIMIT 1) AS plat_local,
  (SELECT COUNT(*) FROM member_games x
    WHERE x.np_comm_id = g.np_comm_id AND x.progress = 100) AS finished_here`;

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
/**
 * How far off a game can be IN TOTAL before it is even looked at. A cheap
 * first cut so the exact count below runs over a handful of games rather than
 * a whole library. Generous, because DLC inflates the total: a game 3 trophies
 * from its platinum can still be 40 short of 100%.
 */
const MILESTONE_SCAN = 60;

/**
 * The nearest platinum they have NOT got, and exactly how many trophies stand
 * between them and it.
 *
 * TWO BUGS THIS USED TO HAVE, both from counting the whole game. Martin, 22
 * September, on Pig_Gamer_145's panel: "2 trophies to go - Remnant: From the
 * Ashes - for their 186th platinum", when Pig had the base game done and the
 * platinum already in the cabinet. The 2 were DLC trophies.
 *
 *   - it never asked whether the platinum was already earned, so any game with
 *     the plat in and some DLC left over read as a platinum countdown
 *   - it counted every trophy left, DLC included, when the platinum only ever
 *     needs the BASE game's trophies
 *
 * And a third, the same evening: it then showed GTA V, which is flagged. A
 * countdown to a platinum nobody can get is worse than no card, so NO GAME OUR
 * SYSTEM HAS FLAGGED is ever shown: not the game flag, and not a game with any
 * trophy flagged. Martin: "never show a game thats been flagged". The rule is
 * FINISHABLE_SQL, the same one the votes use, so the two can never disagree.
 *
 * So: platinum not earned, and the count is base-game trophies (group
 * 'default', or no group recorded) other than the platinum itself, that are not
 * in their earned_ids. The same json_each test the scan's rarest-trophy query
 * uses.
 */
const MILESTONE = `
  WITH near AS (
    SELECT mg.np_comm_id, mg.earned_ids, g.title, g.icon_url, g.max_points
      FROM member_games mg
      JOIN games g ON g.np_comm_id = mg.np_comm_id
     WHERE mg.psn_account_id = ?
       AND g.has_platinum = 1
       AND COALESCE(mg.earned_platinum, 0) = 0
       AND ${FINISHABLE_SQL}
       AND mg.progress < 100
       AND g.trophy_count > 0
       AND (g.trophy_count - mg.earned_total) BETWEEN 1 AND ?
  )
  SELECT title, icon_url, need FROM (
    SELECT n.title, n.icon_url, n.max_points,
           (SELECT COUNT(*) FROM trophies t
             WHERE t.np_comm_id = n.np_comm_id
               AND COALESCE(t.group_id, 'default') = 'default'
               AND t.type <> 'platinum'
               AND NOT EXISTS (
                     SELECT 1 FROM json_each(COALESCE(n.earned_ids, '[]')) je
                      WHERE je.value = t.trophy_id
                   )) AS need
      FROM near n
  )
   WHERE need BETWEEN 1 AND ?
   ORDER BY need ASC, max_points DESC
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

/**
 * Their goals, for the Hunter tab. Running ones only, newest first: a panel
 * 318 pixels wide has room for what they are chasing, not their history.
 */
const GOALS = `
  SELECT id, kind, target, start_value, created_at, deadline_at,
         reached_at, ended_at, final_value
    FROM goals
   WHERE psn_account_id = ? AND reached_at IS NULL AND ended_at IS NULL
   ORDER BY created_at DESC
   LIMIT 6`;

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
        icon: secureUrl(g.icon_url) || null,
        trophies: num(g.trophy_count),
        earned: num(g.earned_total) ?? 0,
        progress: num(g.progress) ?? 0,
        points: num(g.points) ?? 0,
        max: num(g.max_points) ?? 0,
        ownedHere: num(g.local_started) ?? 0,
        finishedHere: num(g.finished_here) ?? 0,
        plattedHere: num(g.plat_local) ?? 0,
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

  const [total, ahead, playing, milestone, closing, top, around, list, goalRows] = await Promise.all([
    env.DB.prepare(TOTAL).first().catch(() => null),
    rank > 1
      ? env.DB.prepare(AHEAD).bind(rank - 1).first().catch(() => null)
      : Promise.resolve(null),
    play
      ? env.DB.prepare(ONE_GAME).bind(m.psn_account_id, play.id).first().catch(() => null)
      : env.DB.prepare(PLAYING).bind(m.psn_account_id).first().catch(() => null),
    env.DB.prepare(MILESTONE).bind(m.psn_account_id, MILESTONE_SCAN, MILESTONE_WITHIN)
      .first().catch(() => null),
    env.DB.prepare(CLOSING).bind(m.psn_account_id, now, CLOSING_LIMIT)
      .all().catch(() => ({ results: [] })),
    env.DB.prepare(TOP).bind(5).all().catch(() => ({ results: [] })),
    env.DB.prepare(AROUND).bind(Math.max(1, rank - 1), rank + 1)
      .all().catch(() => ({ results: [] })),
    // The wishlist table arrives in a later migration. An empty list is a
    // panel with one quiet tab; a thrown query is no panel at all.
    env.DB.prepare(WISHLIST).bind(m.psn_account_id).all().catch(() => ({ results: [] })),
    // Goals arrive in migration 037, so the same seatbelt as the wishlist.
    env.DB.prepare(GOALS).bind(m.psn_account_id).all().catch(() => ({ results: [] })),
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
  /**
   * `Number.isFinite(play.points)` AND NOT `Number.isFinite(Number(play.points))`.
   *
   * THE BUG THAT WAS. `Number(null)` is 0 and `Number.isFinite(0)` is true, so
   * the coercing version turned "the poll has not priced this game yet" - which
   * is the normal state for the first few minutes of every stream - into a
   * confident zero. Leon's panel read "0 / 674 pts" on a game he had 530 in,
   * and the same zero went through the total, so the chase was wrong too.
   *
   * `points: null` is the poll saying it does not know. It has to stay
   * distinguishable from the poll saying nought.
   */
  const priced = play && Number.isFinite(play.points) ? Number(play.points) : null;
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

  /**
   * THE GAME'S FRACTION IS IN THE MEMBER'S CURRENCY, both halves, the way every
   * other surface on this project prints one.
   *
   * It was raw here and completion-applied everywhere else, so the same game
   * read 674 on the Twitch panel and 586 on the hunter page. A member seeing
   * two different numbers for one thing has no way to know which to believe,
   * and the answer is the one the update will actually pay.
   *
   * See the note in functions/hunter/[name].js: BOTH numbers are multiplied,
   * never one.
   */
  const rawPoints = priced !== null ? priced : num(playing?.points) ?? 0;
  const game = gameOut(playing, {
    points: displayBanked(rawPoints, m.completion),
    max: displayBanked(num(playing?.max_points) ?? 0, m.completion),
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
      avatar: secureUrl(x.avatar_url) || null,
      points: num(x.points) ?? 0,
    }));

  return json({
    hunter: {
      name: m.psn_online_id,
      avatar: secureUrl(m.avatar_url) || null,
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
          icon: secureUrl(milestone.icon_url) || null,
        }
      : null,

    /**
     * Closing and list points are the GAME's worth at 100%, not the member's
     * share of it, because both answer "is this worth starting" rather than
     * "what did I bank". The panel labels them as such.
     */
    closing: (closing?.results ?? []).map((g) => ({
      id: g.np_comm_id,
      title: g.title,
      icon: secureUrl(g.icon_url) || null,
      closesAt: num(g.closes_at),
      left: Math.max(0, (num(g.trophy_count) ?? 0) - (num(g.earned_total) ?? 0)),
      points: Math.max(0, (num(g.max_points) ?? 0) - (num(g.points) ?? 0)),
    })),

    list: (list?.results ?? []).map((g) => ({
      id: g.np_comm_id,
      title: g.title,
      icon: secureUrl(g.icon_url) || null,
      platform: g.platform ?? null,
      points: num(g.max_points) ?? 0,
      ownedHere: num(g.local_started) ?? 0,
      finishedHere: num(g.finished_here) ?? 0,
    })),

    board: { top: rows(top), around: rows(around) },

    /**
     * Worked out here with the same rules as the website and the bot, so the
     * panel prints sentences rather than doing arithmetic. Anything the live
     * row has already pushed past its target is left off: the job has not
     * caught up yet, and "100%, 0 to go" is not a goal.
     */
    goals: (goalRows?.results ?? [])
      .map((g) => ({ g, s: goalStatus(g, m, now) }))
      .filter(({ s }) => s.state === 'active' && s.title)
      .map(({ g, s }) => ({
        id: g.id,
        kind: g.kind,
        title: s.title,
        percent: Math.floor(s.percent * 10) / 10,
        left: goalAmount(g.kind, s.remaining),
        perDay: s.neededPerDay !== null ? goalRateAmount(g.kind, s.neededPerDay) : null,
        daysLeft: s.daysLeft,
        pace: s.pace,
      })),
  });
}
