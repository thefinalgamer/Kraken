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
import { memberCompletion } from './lib/completion.mjs';
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
  const startedAt = Date.now();
  const games = await db.query('SELECT np_comm_id FROM games ORDER BY np_comm_id');
  console.log(`re-scoring ${games.length} games`);

  let changedTrophies = 0;
  let changedGames = 0;
  let estimatedGames = 0;

  // D1 rejects any statement with more than 100 bound parameters, so the page
  // size is dictated by that and not by taste. One id per game = 90 games a
  // round trip. Hardcoding 200 here is what broke the first run.
  const PAGE = D1.chunkSize(1);
  const pending = [];

  // Grouped by value, then sent as ONE request per page.
  //
  // The first version issued a separate HTTP call per distinct value, and there
  // are hundreds of distinct values in a page of 90 games — so a job with a few
  // seconds of real SQL in it took two hours of round trips. Cloudflare is
  // 150ms away; that is the entire cost.
  //
  // Row-value IN matches the primary key (np_comm_id, trophy_id), so each
  // statement is still an indexed lookup rather than a scan.
  const flush = async (rows) => {
    const byValue = new Map();
    for (const [points, gameId, trophyId] of rows) {
      if (!byValue.has(points)) byValue.set(points, []);
      byValue.get(points).push([gameId, trophyId]);
    }

    const statements = [];
    for (const [points, pairs] of byValue) {
      const PER = 200; // no bound-parameter ceiling now, only statement length
      for (let k = 0; k < pairs.length; k += PER) {
        const part = pairs.slice(k, k + PER);
        statements.push(
          `UPDATE trophies SET points = ${D1.lit(points)} WHERE (np_comm_id, trophy_id) IN (VALUES ` +
            part.map(([g, t]) => `(${D1.lit(g)},${D1.lit(t)})`).join(',') +
            ')',
        );
      }
    }
    await db.runBatch(statements);
  };

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

      for (const t of moved) pending.push([t.points, row.np_comm_id, t.id]);
    }

    // Written a PAGE at a time rather than a game at a time. The first version
    // grouped by value WITHIN a game, which meant a game holding twelve
    // differently-priced trophies cost twelve round trips to Cloudflare — over
    // a hundred thousand HTTP calls across the board, and hours of runtime for
    // a job that should take minutes.
    //
    // Row-value IN matches on the primary key (np_comm_id, trophy_id), so each
    // statement is an indexed lookup rather than a scan, and 49 trophies fit in
    // one request against D1's 100-parameter ceiling.
    await flush(pending);
    pending.length = 0;

    // Every other page. A silent four-minute gap is indistinguishable from a
    // hung job, and that ambiguity has now cost two runs.
    if (Math.floor(i / PAGE) % 2 === 0) {
      const done = Math.min(i + PAGE, games.length);
      const secs = Math.round((Date.now() - startedAt) / 1000);
      const eta = done ? Math.round((secs / done) * (games.length - done)) : 0;
      console.log(
        `  ${done}/${games.length} games · ${changedTrophies} trophies re-valued · ` +
          `${secs}s elapsed, ~${Math.ceil(eta / 60)} min left`,
      );
    }
  }

  // Keep games.estimated honest, so the scan knows which ones to re-check in
  // days rather than a month. One statement — a game is estimated exactly when
  // none of its trophies has a published rarity, which SQL can answer itself.
  await db.run(
    `UPDATE games SET estimated = CASE WHEN NOT EXISTS (
       SELECT 1 FROM trophies t WHERE t.np_comm_id = games.np_comm_id AND t.earned_rate > 0
     ) THEN 1 ELSE 0 END`,
  );

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

  // The completion denominator. Independent of scoring — it is just the game's
  // trophy make-up — but recomputed here so a game added by an older build,
  // before the column existed, cannot sit at zero and quietly drop itself out
  // of everyone's completion.
  await db.run(
    `UPDATE games SET completion_weight = (
       SELECT COALESCE(SUM(CASE t.type
                WHEN 'gold' THEN 90 WHEN 'silver' THEN 30 WHEN 'bronze' THEN 15
                ELSE 0 END), 0)
         FROM trophies t WHERE t.np_comm_id = games.np_comm_id)`,
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
  const changed = new Map(); // new value -> the games that now hold it

  for (const row of rows) {
    const earned = new Set(safeJson(row.earned_ids, []));
    const defs = safeJson(row.defs, []);
    let points = 0;
    for (const [trophyId, pts] of defs) if (earned.has(trophyId)) points += pts || 0;
    rawPoints += points;

    // Only rows whose value actually moved. For Lucas that skips 13,334
    // shovelware games sitting at zero before and after.
    if (points !== (row.was_points ?? null)) {
      if (!changed.has(points)) changed.set(points, []);
      changed.get(points).push(row.np_comm_id);
    }
  }

  // Grouped by value and sent in batched requests, same reasoning as the trophy
  // writes: Pelziowo alone has 15,411 rows, and a round trip each would take
  // longer than the entire rest of the job.
  let written = 0;
  const statements = [];
  for (const [points, ids] of changed) {
    const PER = 200;
    for (let i = 0; i < ids.length; i += PER) {
      const part = ids.slice(i, i + PER);
      statements.push(
        `UPDATE member_games SET points = ${D1.lit(points)} ` +
          `WHERE psn_account_id = ${D1.lit(member.psn_account_id)} ` +
          `AND np_comm_id IN (${part.map((g) => D1.lit(g)).join(',')})`,
      );
      written += part.length;
    }
  }
  await db.runBatch(statements);

  // Completion IS recomputed, because it depends on which games are worth
  // nothing and a scoring change moves that line. Same query the scan uses.
  const { completion } = await memberCompletion(db, member.psn_account_id);
  const points = applyCompletion(rawPoints, completion);

  await db.run(
    'UPDATE members SET raw_points = ?, points = ?, completion = ? WHERE discord_id = ?',
    [rawPoints, points, completion, member.discord_id],
  );

  const before = member.points ?? 0;
  const delta = points - before;
  console.log(
    `  ${member.psn_online_id.padEnd(18)} ${String(before).padStart(9)} -> ${String(points).padStart(9)}` +
      `  (${delta >= 0 ? '+' : ''}${delta})  completion ${member.completion} -> ${completion}` +
      `  [${rows.length} games, ${written} rewritten]`,
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
