/**
 * Re-price the entire board from stored data. NO PSN CALLS AT ALL.
 *
 * Every time the scoring rules change, every number in the database is stale —
 * and the only way to refresh them used to be scanning everybody again. That is
 * fine for a member with 350 games and completely impractical for Pelziowo's
 * 15,411: hours of API calls to recompute something that is already sitting in
 * the database.
 *
 * So this exists. It walks the three layers in order:
 *
 *   1. trophies.points   — re-scored from stored earned_rate under the current
 *                          rules, a whole game at a time (the floor for easy
 *                          trophies in real games, and the estimate for games
 *                          PSN gave us no rarity for, both need the game in view)
 *   2. games.max_points  — the sum of the above
 *   3. member_games.points, then members.raw_points/points/rank
 *
 * Everything is a join over data we already own. A full pass across 500,000
 * trophies and 20,000 games takes a couple of minutes, against many hours for
 * a rescan, and it cannot possibly lose data because it never talks to Sony.
 *
 * Run it from Actions -> Admin -> rescore.
 */

import { D1 } from './lib/d1.mjs';
import { scoreGameTrophies, applyCompletion } from '../shared/scoring.mjs';
import { publishLeaderboard } from './lib/discord.mjs';

const env = process.env;
const db = new D1({
  accountId: env.CF_ACCOUNT_ID,
  databaseId: env.CF_D1_DATABASE_ID,
  apiToken: env.CF_API_TOKEN,
});

const safeJson = (raw, fallback) => {
  try {
    return JSON.parse(raw ?? '');
  } catch {
    return fallback;
  }
};

// ------------------------------------------------------------- trophies ----

/**
 * Re-score every trophy, one game at a time.
 *
 * Paged rather than loaded whole: half a million rows will not fit in a D1
 * response, and would not fit comfortably in memory on a runner either. Games
 * are the natural page boundary because a game is exactly the unit
 * scoreGameTrophies() needs.
 */
async function rescoreTrophies() {
  const games = await db.query('SELECT np_comm_id FROM games ORDER BY np_comm_id');
  console.log(`re-scoring ${games.length} games`);

  let changedTrophies = 0;
  let changedGames = 0;
  let estimatedGames = 0;

  // D1 rejects any statement with more than 100 bound parameters, so the page
  // size is dictated by that and not by taste. One id per game = 90 games a
  // round trip. Hardcoding 200 here is what broke the first run.
  const PAGE = D1.chunkSize(1);

  for (let i = 0; i < games.length; i += PAGE) {
    const slice = games.slice(i, i + PAGE);
    const rows = await db.query(
      `SELECT np_comm_id,
              json_group_array(json_array(trophy_id, type, earned_rate, points)) AS defs
         FROM trophies
        WHERE np_comm_id IN (${slice.map(() => '?').join(',')})
        GROUP BY np_comm_id`,
      slice.map((g) => g.np_comm_id),
    );

    for (const row of rows) {
      const defs = safeJson(row.defs, []);
      const scored = scoreGameTrophies(
        defs.map(([id, type, rate]) => ({ id, type, rate })),
      );
      const wasByeId = new Map(defs.map(([id, , , pts]) => [id, pts ?? 0]));

      // Only write trophies whose value actually moved. On a no-op rescore
      // that is zero rows, which matters because D1 charges for writes and a
      // blind rewrite of 500,000 trophies would burn a day's allowance.
      const moved = scored.filter((t) => t.points !== wasByeId.get(t.id));
      if (!moved.length) continue;

      changedGames += 1;
      changedTrophies += moved.length;
      if (scored.some((t) => t.estimated)) estimatedGames += 1;

      // Grouped by new value, so a 97-trophy game is one or two statements
      // rather than 97.
      const byValue = new Map();
      for (const t of moved) {
        if (!byValue.has(t.points)) byValue.set(t.points, []);
        byValue.get(t.points).push(t.id);
      }
      for (const [points, ids] of byValue) {
        // points + np_comm_id + the ids, all bound — so the id list has to
        // leave room for the other two.
        const CHUNK = D1.chunkSize(1) - 2;
        for (let j = 0; j < ids.length; j += CHUNK) {
          const part = ids.slice(j, j + CHUNK);
          await db.run(
            `UPDATE trophies SET points = ?
              WHERE np_comm_id = ? AND trophy_id IN (${part.map(() => '?').join(',')})`,
            [points, row.np_comm_id, ...part],
          );
        }
      }
    }

    if (Math.floor(i / PAGE) % 20 === 0) {
      console.log(`  ${Math.min(i + PAGE, games.length)}/${games.length} games`);
    }
  }

  console.log(
    `  ${changedTrophies} trophies re-valued across ${changedGames} games ` +
      `(${estimatedGames} of them estimated — PSN has no rarity for those)`,
  );
}

// ---------------------------------------------------------------- games ----

/** games.max_points is the sum of its trophies. Recomputed in one statement. */
async function rescoreGames() {
  await db.run(
    `UPDATE games SET max_points =
       (SELECT COALESCE(SUM(t.points), 0) FROM trophies t WHERE t.np_comm_id = games.np_comm_id)`,
  );
  const worthless = await db.one('SELECT COUNT(*) AS c FROM games WHERE max_points = 0');
  const total = await db.one('SELECT COUNT(*) AS c FROM games');
  console.log(`  ${worthless.c} of ${total.c} games still score nothing (all-easy shovelware)`);
}

// -------------------------------------------------------------- members ----

/**
 * One member's games and totals, from stored earned ids against the rarity we
 * just rewrote. Identical arithmetic to the scan's recomputeMemberPoints —
 * deliberately, because if these two ever disagree the board contradicts itself
 * depending on which job ran last.
 */
async function rescoreMember(member) {
  const rows = await db.query(
    `SELECT mg.np_comm_id, mg.earned_ids, mg.points AS was_points,
            (SELECT json_group_array(json_array(t.trophy_id, t.points))
               FROM trophies t WHERE t.np_comm_id = mg.np_comm_id) AS defs
       FROM member_games mg
      WHERE mg.psn_account_id = ?`,
    [member.psn_account_id],
  );

  let rawPoints = 0;
  let written = 0;
  for (const row of rows) {
    const earned = new Set(safeJson(row.earned_ids, []));
    const defs = safeJson(row.defs, []);
    let points = 0;
    for (const [trophyId, pts] of defs) if (earned.has(trophyId)) points += pts || 0;
    rawPoints += points;

    if (points !== (row.was_points ?? null)) {
      await db.run(
        'UPDATE member_games SET points = ? WHERE psn_account_id = ? AND np_comm_id = ?',
        [points, member.psn_account_id, row.np_comm_id],
      );
      written += 1;
    }
  }

  // Completion is untouched — it comes from PSN's trophy counts, not from
  // rarity, so no scoring change can move it. Only the multiplication is redone.
  const points = applyCompletion(rawPoints, member.completion);

  await db.run('UPDATE members SET raw_points = ?, points = ? WHERE discord_id = ?', [
    rawPoints,
    points,
    member.discord_id,
  ]);

  const before = member.points ?? 0;
  const delta = points - before;
  console.log(
    `  ${member.psn_online_id.padEnd(18)} ${String(before).padStart(9)} -> ${String(points).padStart(9)}` +
      `  (${delta >= 0 ? '+' : ''}${delta}, ${rows.length} games, ${written} rewritten)`,
  );
  return { onlineId: member.psn_online_id, before, after: points };
}

/** Re-rank from the new scores. Same ordering the scan uses. */
async function recomputeRanks() {
  const rows = await db.query(
    'SELECT discord_id, rank FROM members ORDER BY points DESC, psn_online_id ASC',
  );
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].rank !== i + 1) {
      await db.run('UPDATE members SET prev_rank = rank, rank = ? WHERE discord_id = ?', [
        i + 1,
        rows[i].discord_id,
      ]);
    }
  }
}

// ----------------------------------------------------------------- main ----

async function main() {
  const started = Date.now();
  console.log('Rescoring the board from stored data — no PSN calls.\n');

  await rescoreTrophies();
  await rescoreGames();

  const members = await db.query(
    'SELECT discord_id, psn_account_id, psn_online_id, points, completion FROM members ORDER BY points DESC',
  );
  console.log(`\nre-pricing ${members.length} members`);
  for (const m of members) await rescoreMember(m);

  await recomputeRanks();

  // Push the new board out, best-effort. A Discord outage must not make a
  // completed rescore look like a failure — the numbers are already saved.
  try {
    const board = await db.query(
      `SELECT discord_id, psn_online_id, points, completion, rank, prev_rank
         FROM members
        WHERE rank IS NOT NULL AND last_update_at IS NOT NULL
        ORDER BY rank ASC`,
    );
    await publishLeaderboard(board, {
      get: (k, fallback) => db.getState(k, fallback),
      set: (k, v) => db.setState(k, v),
    });
    console.log('\n#leaderboard updated.');
  } catch (err) {
    console.error('\nCould not update #leaderboard (the scores are saved regardless):', err.message);
  }

  console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)}s.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
