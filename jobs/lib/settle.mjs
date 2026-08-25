/**
 * Settle local rarity for the handful of games one update actually touched.
 *
 * THE BUG THIS FIXES, in Martin's own words: "our board taking points of people
 * when other members start the same projects? i know its not working. i did 6
 * bronze and 2 silver trophies on blackflag, wilko played it and didnt lose any
 * points at all from me doing them."
 *
 * He was right that nothing happened, and the reason was not a broken
 * calculation. Local rarity lived entirely in the nightly rescore, because a
 * trophy's local value depends on what the WHOLE SERVER has earned and no
 * single member's scan can see that. So Martin's eight trophies did change what
 * Wilko's copies were worth — at 03:00, hours later, on a job nobody was
 * watching. By the time Wilko ran /update the loss had already been absorbed
 * into his baseline. Layer two was real, correct, and invisible.
 *
 * A full rescore after every update is not the answer: it walks 20,000 games
 * and half a million trophies to fix eight rows.
 *
 * So this does the same arithmetic over a much smaller world. It takes the
 * games whose earned sets actually moved this session — usually two or three —
 * and for those games only:
 *
 *   1. recounts local_started and local_earned from member_games
 *   2. re-prices their trophies against the new counts
 *   3. re-totals games.max_points
 *   4. re-totals member_games.points for everyone who owns them
 *   5. re-totals members.raw_points and points for those members
 *
 * The people who lose points are not scanning and will not see it until their
 * next /update — which is exactly what reported_points was built for. They get
 * told, once, with the loss bucketed as `drift`.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: maintain counters incrementally. Every
 * count here is recomputed from member_games, never nudged. A nudged counter
 * drifts the first time a job dies mid-write, and a drifted rarity figure does
 * not error — it silently misprices a game forever. Same reasoning as
 * countLocalRarity() in the rescore, which remains the authority: it recounts
 * the entire board every night, so anything this gets wrong survives one day.
 *
 * COMPLETION IS NOT RECOMPUTED, and that is safe rather than lazy. The local
 * multiplier is clamped at a floor of 1, so it can only ever raise a trophy's
 * value. A game worth nothing stays worth nothing, the set of zero-value games
 * cannot change, and completion — which depends only on which games are
 * worthless and on their trophy make-up — cannot move. If that floor is ever
 * removed, this assumption has to come out with it.
 */

import { D1 } from './d1.mjs';
import { scoreGameTrophies, applyCompletion } from '../../shared/scoring.mjs';

const safeJson = (raw, fallback) => {
  try {
    return JSON.parse(raw ?? '');
  } catch {
    return fallback;
  }
};

/**
 * Above this many games, hand the job back to the nightly rescore.
 *
 * A first scan changes every game a member owns — 15,411 of them for Pelziowo —
 * and settling those would take longer than the scan did. A repeat update
 * changes two or three. The cap is what separates the two cases without needing
 * to be told which is which.
 */
export const SETTLE_GAME_LIMIT = 300;

/** np_comm_id has no spaces in it, so a space is a safe compound key. */
const key = (game, trophyId) => `${game} ${trophyId}`;

export async function settleLocalRarity(db, gameIds, { skipAccountId = null } = {}) {
  const games = [...new Set((gameIds ?? []).filter(Boolean))];
  const nothing = { games: 0, trophies: 0, members: [], skipped: null };
  if (!games.length) return nothing;
  if (games.length > SETTLE_GAME_LIMIT) {
    console.log(
      `  local rarity: ${games.length} games changed — over the ${SETTLE_GAME_LIMIT} limit, ` +
        `leaving it to the nightly rescore`,
    );
    return { ...nothing, skipped: games.length };
  }

  const PAGE = D1.chunkSize(1);
  const chunks = [];
  for (let i = 0; i < games.length; i += PAGE) chunks.push(games.slice(i, i + PAGE));

  // -- 1. who owns these games, and what have they earned in them -----------
  const owners = [];
  const started = new Map(); // game -> members owning it
  const earned = new Map(); // key(game, trophyId) -> members holding it

  for (const chunk of chunks) {
    const rows = await db.query(
      `SELECT psn_account_id, np_comm_id, earned_ids, points AS was_points
         FROM member_games
        WHERE np_comm_id IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    );
    for (const row of rows) {
      const ids = safeJson(row.earned_ids, []);
      owners.push({
        accountId: row.psn_account_id,
        game: row.np_comm_id,
        earned: new Set(ids),
        wasPoints: row.was_points ?? null,
      });
      started.set(row.np_comm_id, (started.get(row.np_comm_id) ?? 0) + 1);
      for (const id of ids) earned.set(key(row.np_comm_id, id), (earned.get(key(row.np_comm_id, id)) ?? 0) + 1);
    }
  }

  // -- 2. persist the counts, so /game can show them without recounting ------
  const counts = [];
  const byStarted = new Map();
  for (const [game, n] of started) {
    if (!byStarted.has(n)) byStarted.set(n, []);
    byStarted.get(n).push(game);
  }
  for (const [n, list] of byStarted) {
    for (let i = 0; i < list.length; i += 200) {
      counts.push(
        `UPDATE games SET local_started = ${D1.lit(n)} WHERE np_comm_id IN (` +
          list.slice(i, i + 200).map((g) => D1.lit(g)).join(',') + ')',
      );
    }
  }

  const byEarned = new Map();
  for (const [k, n] of earned) {
    if (!byEarned.has(n)) byEarned.set(n, []);
    byEarned.get(n).push(k.split(' '));
  }
  for (const [n, pairs] of byEarned) {
    for (let i = 0; i < pairs.length; i += 200) {
      counts.push(
        `UPDATE trophies SET local_earned = ${D1.lit(n)} WHERE (np_comm_id, trophy_id) IN (VALUES ` +
          pairs.slice(i, i + 200).map(([g, t]) => `(${D1.lit(g)},${D1.lit(Number(t))})`).join(',') +
          ')',
      );
    }
  }
  await db.runBatch(counts);

  // -- 3. re-price the trophies ---------------------------------------------
  // The same call the rescore makes, on the same inputs, so the two jobs cannot
  // disagree about what a trophy is worth depending on which one ran last.
  const pointsByGame = new Map();
  const writes = [];
  let repriced = 0;

  for (const chunk of chunks) {
    const rows = await db.query(
      `SELECT np_comm_id,
              json_group_array(json_array(trophy_id, type, earned_rate, points)) AS defs
         FROM trophies
        WHERE np_comm_id IN (${chunk.map(() => '?').join(',')})
        GROUP BY np_comm_id`,
      chunk,
    );

    for (const row of rows) {
      const defs = safeJson(row.defs, []);
      const scored = scoreGameTrophies(
        defs.map(([id, type, rate]) => ({ id, type, rate })),
        undefined,
        {
          started: started.get(row.np_comm_id) ?? 0,
          earned: new Map(defs.map(([id]) => [id, earned.get(key(row.np_comm_id, id)) ?? 0])),
        },
      );
      pointsByGame.set(row.np_comm_id, new Map(scored.map((t) => [t.id, t.points])));

      const wasById = new Map(defs.map(([id, , , pts]) => [id, pts ?? 0]));
      const moved = scored.filter((t) => t.points !== wasById.get(t.id));
      if (!moved.length) continue;
      repriced += moved.length;

      const byValue = new Map();
      for (const t of moved) {
        if (!byValue.has(t.points)) byValue.set(t.points, []);
        byValue.get(t.points).push(t.id);
      }
      for (const [points, ids] of byValue) {
        for (let i = 0; i < ids.length; i += 200) {
          writes.push(
            `UPDATE trophies SET points = ${D1.lit(points)} ` +
              `WHERE np_comm_id = ${D1.lit(row.np_comm_id)} AND trophy_id IN (` +
              ids.slice(i, i + 200).map((id) => D1.lit(Number(id))).join(',') + ')',
          );
        }
      }
    }
  }

  if (!repriced) {
    console.log(`  local rarity: ${games.length} game(s) settled, nothing moved`);
    return { games: games.length, trophies: 0, members: [], skipped: null };
  }
  await db.runBatch(writes);

  // -- 4. the games' own totals ---------------------------------------------
  for (const chunk of chunks) {
    await db.run(
      `UPDATE games SET max_points =
         (SELECT COALESCE(SUM(t.points), 0) FROM trophies t WHERE t.np_comm_id = games.np_comm_id)
        WHERE np_comm_id IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    );
  }

  // -- 5. everyone who owns them --------------------------------------------
  // The member being scanned is left out on purpose: recomputeMemberPoints()
  // runs immediately after this and rebuilds their whole library properly.
  // Touching them here would only be overwritten a second later.
  const rowWrites = [];
  const touched = new Set();
  for (const o of owners) {
    if (skipAccountId && o.accountId === skipAccountId) continue;
    const values = pointsByGame.get(o.game);
    if (!values) continue;
    let points = 0;
    for (const id of o.earned) points += values.get(id) ?? 0;
    if (points === o.wasPoints) continue;
    touched.add(o.accountId);
    rowWrites.push(
      `UPDATE member_games SET points = ${D1.lit(points)} ` +
        `WHERE psn_account_id = ${D1.lit(o.accountId)} AND np_comm_id = ${D1.lit(o.game)}`,
    );
  }
  await db.runBatch(rowWrites);

  if (!touched.size) {
    console.log(`  local rarity: ${repriced} trophies re-valued, nobody else affected`);
    return { games: games.length, trophies: repriced, members: [], skipped: null };
  }

  // -- 6. their totals ------------------------------------------------------
  // Re-summed from member_games rather than adjusted by a delta. A delta is one
  // failed write away from a member whose score is quietly wrong forever, and
  // the sum costs one statement.
  const accounts = [...touched];
  const moved = [];
  for (let i = 0; i < accounts.length; i += PAGE) {
    const slice = accounts.slice(i, i + PAGE);
    const holes = slice.map(() => '?').join(',');
    await db.run(
      `UPDATE members SET raw_points =
         (SELECT COALESCE(SUM(mg.points), 0) FROM member_games mg
           WHERE mg.psn_account_id = members.psn_account_id)
        WHERE psn_account_id IN (${holes})`,
      slice,
    );

    const rows = await db.query(
      `SELECT psn_account_id, psn_online_id, raw_points, points, completion
         FROM members WHERE psn_account_id IN (${holes})`,
      slice,
    );

    const totals = [];
    for (const m of rows) {
      const after = applyCompletion(m.raw_points ?? 0, m.completion);
      if (after === (m.points ?? null)) continue;
      totals.push(
        `UPDATE members SET points = ${D1.lit(after)} WHERE psn_account_id = ${D1.lit(m.psn_account_id)}`,
      );
      moved.push({ onlineId: m.psn_online_id, before: m.points ?? 0, after });
    }
    await db.runBatch(totals);
  }

  for (const m of moved) {
    const d = m.after - m.before;
    console.log(`  local rarity: ${m.onlineId} ${m.before} -> ${m.after} (${d >= 0 ? '+' : ''}${d})`);
  }
  console.log(
    `  local rarity: ${repriced} trophies re-valued across ${games.length} game(s), ` +
      `${moved.length} member${moved.length === 1 ? '' : 's'} moved`,
  );

  return { games: games.length, trophies: repriced, members: moved, skipped: null };
}
