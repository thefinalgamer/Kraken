/**
 * The live trophy poll.
 *
 * ONE MEMBER, WHILE THEY ARE STREAMING, AT MOST ONCE EVERY TEN SECONDS.
 *
 * Everything in this file is a brake. The feature itself is four lines: ask PSN
 * what they have played recently, notice a trophy count that went up, fetch
 * that game's trophies, write the new ones into `member_trophies` so the pop
 * can find them. The rest is making sure it can never become the thing that
 * takes the board's PSN access away.
 *
 * THE FOUR BRAKES, in the order they apply:
 *
 *   1. NOT LIVE, NOT POLLED. Twitch says who is on air. A browser source left
 *      open on a spare monitor for a fortnight polls nothing.
 *   2. TEN SECONDS PER MEMBER, stored in the database rather than in memory,
 *      because a Worker has no memory between requests and a refreshing page
 *      would otherwise ask on every single load.
 *   3. A GLOBAL CEILING per minute across the whole board, so three streamers
 *      cannot add up to something the nightly scan has to share with.
 *   4. A HARD STOP ON 429. If Sony pushes back the whole feature switches
 *      itself off for fifteen minutes, for everybody, without being asked.
 *
 * NOTHING HERE EVER THROWS INTO A PAGE. Every path returns a short string for
 * the log and swallows its own failures. An overlay on somebody's stream is the
 * worst possible place to find out about an exception.
 */

import { isLive } from './twitch.mjs';
import { accessToken, recentTitles, earnedForTitle } from './psn.mjs';

/** How often one member can be looked at. */
export const POLL_EVERY_MS = 10000;

/** How many PSN calls the whole board may make in a minute, for all streams. */
export const CALLS_PER_MINUTE = 30;

/** How long everything stops for when Sony says no. */
export const BACKOFF_MS = 15 * 60 * 1000;

/**
 * Only trophies earned recently are worth writing.
 *
 * A first poll on a member with a long history must not import their whole
 * life into the log. The scan does the history; this does the last few minutes.
 */
const RECENT_MS = 20 * 60 * 1000;

const readState = (env, key) =>
  env.DB.prepare('SELECT value, expires_at FROM worker_state WHERE key = ?')
    .bind(key)
    .first()
    .catch(() => null);

const writeState = (env, key, value, expiresAt) =>
  env.DB.prepare(
    `INSERT INTO worker_state (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
  )
    .bind(key, String(value), expiresAt)
    .run()
    .catch(() => {});

/**
 * The global budget, as a counter that resets itself.
 *
 * `expires_at` is the end of the current minute. Reading a row that has expired
 * is the same as reading a zero, so nothing has to sweep it.
 */
async function takeBudget(env) {
  const now = Date.now();
  const row = await readState(env, 'psn_budget');
  const fresh = !row || Number(row.expires_at) <= now;
  const used = fresh ? 0 : Number(row.value) || 0;
  if (used >= CALLS_PER_MINUTE) return false;
  await writeState(env, 'psn_budget', used + 1, fresh ? now + 60000 : Number(row.expires_at));
  return true;
}

async function backedOff(env) {
  const row = await readState(env, 'psn_backoff');
  return Boolean(row && Number(row.expires_at) > Date.now());
}

/**
 * Look at one member, if all four brakes allow it.
 *
 * Returns a one line summary for the log. The caller never waits on this: the
 * overlay fires it and forgets, and whatever it writes is picked up by the next
 * refresh ten seconds later. That is deliberate. A page that waits on PSN is a
 * page that goes blank when PSN is slow.
 */
export async function pollMember(env, member) {
  if (!env.PSN_NPSSO) return 'poll: no credential';
  if (!member?.psn_account_id) return 'poll: no member';
  if (!isLive(member)) return 'poll: not live';

  const now = Date.now();
  const last = Number(member.psn_polled_at) || 0;
  if (now - last < POLL_EVERY_MS) return 'poll: too soon';

  if (await backedOff(env)) return 'poll: backed off';
  if (!(await takeBudget(env))) return 'poll: budget spent';

  /**
   * The clock is stamped BEFORE the work, not after.
   *
   * Two requests arriving in the same second would otherwise both read the old
   * timestamp, both decide they were allowed, and both call PSN. Stamping first
   * means the second one loses.
   */
  await env.DB.prepare('UPDATE members SET psn_polled_at = ? WHERE psn_account_id = ?')
    .bind(now, member.psn_account_id)
    .run()
    .catch(() => {});

  try {
    const token = await accessToken(env);
    const titles = await recentTitles(env, member.psn_account_id, token, 5);
    if (!titles.length) return 'poll: nothing played';

    /**
     * The one title whose earned count does not match what we have stored.
     *
     * `member_games` is the scan's record of where they were. If PSN now says
     * more, something happened since, and that is the only game worth spending
     * the second call on.
     */
    const ids = titles.map((t) => t.npCommunicationId);
    const { results: known = [] } = await env.DB.prepare(
      `SELECT np_comm_id, earned_total FROM member_games
        WHERE psn_account_id = ?
          AND np_comm_id IN (${ids.map(() => '?').join(',')})`,
    )
      .bind(member.psn_account_id, ...ids)
      .all();

    const stored = new Map(known.map((r) => [r.np_comm_id, Number(r.earned_total) || 0]));

    const moved = titles.find((t) => {
      const e = t.earnedTrophies ?? {};
      const total =
        (Number(e.bronze) || 0) + (Number(e.silver) || 0) +
        (Number(e.gold) || 0) + (Number(e.platinum) || 0);
      // A game with no row yet counts as moved: it is one they just started.
      return total > (stored.get(t.npCommunicationId) ?? -1);
    });

    /**
     * WRITE WHAT THEY ARE PLAYING, whether or not a trophy moved.
     *
     * The first title in that list is the game they last touched, and PSN's own
     * counts come with it. Keeping it is what lets the bar follow somebody
     * changing disc rather than waiting for their next update, and it costs
     * nothing: the call has already been made and paid for.
     *
     * DISPLAY ONLY, and deliberately not `member_games`. The scan decides
     * whether to re-fetch a game by comparing its stored count against PSN's,
     * so a fresh count written there would make it skip the game and never
     * award the points. A wrong line on an overlay is a shrug; a wrong score is
     * forever.
     */
    const top = titles[0];
    const e = top?.earnedTrophies ?? {};
    await env.DB.prepare('UPDATE members SET live_play = ? WHERE psn_account_id = ?')
      .bind(
        JSON.stringify({
          id: top?.npCommunicationId ?? null,
          at: now,
          progress: Number(top?.progress) || 0,
          platinum: Number(e.platinum) || 0,
          gold: Number(e.gold) || 0,
          silver: Number(e.silver) || 0,
          bronze: Number(e.bronze) || 0,
        }),
        member.psn_account_id,
      )
      .run()
      .catch(() => {});

    if (!moved) return 'poll: nothing new';

    const trophies = await earnedForTitle(
      env,
      member.psn_account_id,
      moved.npCommunicationId,
      moved.trophyTitlePlatform,
      token,
    );

    const rows = trophies
      .filter((t) => t.earned && t.earnedDateTime)
      .map((t) => ({ id: Number(t.trophyId), at: Date.parse(t.earnedDateTime) }))
      .filter((t) => Number.isFinite(t.at) && now - t.at < RECENT_MS);

    if (!rows.length) return `poll: ${moved.trophyTitleName} moved, nothing recent`;

    /**
     * INSERT OR IGNORE against the log's own primary key.
     *
     * The scan writes the same table from the other direction. Whichever gets
     * there first wins and the other one is a no-op, which is why this needs no
     * coordination with a job running on a completely different machine.
     */
    /**
     * `on_stream = 1`, and this is the only place it is ever set.
     *
     * This function does not run unless Twitch says the member is on air, so a
     * trophy it writes was earned in front of an audience by definition. The
     * nightly scan writes the same table and leaves the flag alone, because it
     * has no idea whether anybody was watching.
     *
     * ON CONFLICT rather than OR IGNORE now: the scan may have got there first
     * with the same row, in which case the row is right but the flag is
     * missing, and this is the only chance to add it.
     */
    await env.DB.batch(
      rows.map((t) =>
        env.DB.prepare(
          `INSERT INTO member_trophies
             (psn_account_id, np_comm_id, trophy_id, earned_at, on_stream)
           VALUES (?, ?, ?, ?, 1)
           ON CONFLICT(psn_account_id, np_comm_id, trophy_id)
             DO UPDATE SET on_stream = 1`,
        ).bind(member.psn_account_id, moved.npCommunicationId, t.id, t.at),
      ),
    );

    return `poll: ${rows.length} recent in ${moved.trophyTitleName}`;
  } catch (err) {
    if (err?.rateLimited) {
      /**
       * EVERYBODY STOPS, not just this member. The limit is on the account, and
       * the account is the board's. Fifteen minutes of no live pops costs
       * nothing next to a scan that cannot run tonight.
       */
      await writeState(env, 'psn_backoff', 'rate limited', Date.now() + BACKOFF_MS);
      return 'poll: rate limited, everything paused for 15 minutes';
    }
    return `poll: failed (${err?.message ?? err})`;
  }
}
