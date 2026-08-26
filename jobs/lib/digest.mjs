/**
 * The weekly digest.
 *
 * Posted at the end of the weekly refresh, which is the only moment in the week
 * when every member's data is known to be current — the refresh has just walked
 * the whole list, so "points earned this week" is true for everybody rather than
 * only for whoever remembered to run /update.
 *
 * NO NEW COLUMNS. Everything here comes out of tables that already exist:
 * `updates` records every scan with its deltas, `update_changelog` records what
 * changed in each one, and week-over-week rank movement is a snapshot this job
 * writes to `kv` for itself to read next Monday.
 *
 * That snapshot is why the FIRST digest has no climber and no faller. It has
 * nothing to compare against and says so by leaving the lines out, rather than
 * inventing a baseline out of prev_rank — which tracks the last move a member
 * made, not where they stood seven days ago, and would quietly report a Tuesday
 * change as the whole week's story.
 */

import { digestBlocks } from '../../shared/ui.mjs';
import { rankContested, CONTESTED_SQL, CONTESTED_MIN_OWNERS } from '../../shared/contested.mjs';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const fmt = (ms) =>
  new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

/**
 * Gather the week and hand back the card, or null when there is nothing at all
 * to say. Pure reads apart from the rank snapshot it leaves for next time.
 */
export async function buildWeeklyDigest(db, { now = Date.now() } = {}) {
  const since = now - WEEK_MS;

  const totals = await db.one(
    `SELECT COALESCE(SUM(d_points), 0)    AS points,
            COALESCE(SUM(d_completed), 0) AS completed,
            COUNT(DISTINCT psn_account_id) AS members
       FROM updates
      WHERE status = 'done' AND finished_at >= ?`,
    [since],
  );

  // Everything anybody finished this week, with the two facts that make a
  // completion worth printing: what its platinum is worth worldwide, and what
  // the game paid.
  const completions = await db.query(
    `SELECT c.title, m.psn_online_id, g.max_points,
            (SELECT t.earned_rate FROM trophies t
              WHERE t.np_comm_id = c.np_comm_id AND t.type = 'platinum' LIMIT 1) AS plat_rate
       FROM update_changelog c
       JOIN updates u ON u.id = c.update_id
       JOIN members m ON m.psn_account_id = u.psn_account_id
       LEFT JOIN games g ON g.np_comm_id = c.np_comm_id
      WHERE c.kind = 'completed' AND u.status = 'done' AND u.finished_at >= ?`,
    [since],
  );

  // A game reaching 100% means its platinum was earned, so "the rarest platinum
  // anyone took this week" is exact rather than an approximation — which is more
  // than can be said for rarest TROPHY, since we store when a game was last
  // touched but not when each individual trophy landed.
  const rated = completions.filter((c) => Number(c.plat_rate) > 0);
  const rarest = rated.length
    ? rated.reduce((best, c) => (Number(c.plat_rate) < Number(best.plat_rate) ? c : best))
    : null;

  const valued = completions.filter((c) => Number(c.max_points) > 0);
  const toughest = valued.length
    ? valued.reduce((best, c) => (Number(c.max_points) > Number(best.max_points) ? c : best))
    : null;

  const joined = await db.one(
    `SELECT COUNT(*) AS c FROM members m
      WHERE (SELECT MIN(u.finished_at) FROM updates u
              WHERE u.psn_account_id = m.psn_account_id AND u.status = 'done') >= ?`,
    [since],
  );

  const stuck = rankContested(await db.query(CONTESTED_SQL, [CONTESTED_MIN_OWNERS, 1]));

  // -- movement, against the snapshot this job left last week ---------------
  const board = await db.query(
    `SELECT discord_id, psn_online_id, rank, points
       FROM members
      WHERE rank IS NOT NULL AND last_update_at IS NOT NULL`,
  );
  const wasRaw = await db.getState('digest_ranks', null);
  const was = new Map(Array.isArray(wasRaw) ? wasRaw : []);

  let climber = null;
  let faller = null;
  for (const m of board) {
    const before = was.get(m.discord_id);
    if (!before?.rank) continue; // new since last week — moving is meaningless
    const moved = before.rank - m.rank; // positive is upwards
    if (moved > 0 && (!climber || moved > climber.moved)) {
      climber = {
        moved,
        onlineId: m.psn_online_id,
        from: before.rank,
        to: m.rank,
        points: (m.points ?? 0) - (before.points ?? 0),
      };
    }
    if (moved < 0 && (!faller || moved < faller.moved)) {
      faller = { moved, onlineId: m.psn_online_id, from: before.rank, to: m.rank };
    }
  }

  // Leave next week's baseline behind. Written even on a silent week, because a
  // gap in the snapshots is what turns one quiet Monday into a fortnight of
  // wrong movement figures.
  await db.setState(
    'digest_ranks',
    board.map((m) => [m.discord_id, { rank: m.rank, points: m.points }]),
  );

  const nothingHappened =
    !climber && !faller && !completions.length && !(totals?.points > 0) && !(joined?.c > 0);
  if (nothingHappened) return null;

  return digestBlocks({
    range: `${fmt(since)} – ${fmt(now)}`,
    climber,
    faller,
    rarestPlat: rarest
      ? { title: rarest.title, rate: rarest.plat_rate, onlineId: rarest.psn_online_id }
      : null,
    toughest: toughest
      ? { title: toughest.title, points: toughest.max_points, onlineId: toughest.psn_online_id }
      : null,
    contested: stuck.length
      ? {
          title: stuck[0].title,
          stuck: Math.max(0, (stuck[0].local_started ?? 0) - (stuck[0].platted_here ?? 0)),
        }
      : null,
    completed: Number(totals?.completed ?? 0),
    points: Number(totals?.points ?? 0),
    members: Number(totals?.members ?? 0),
    joined: Number(joined?.c ?? 0),
  });
}
