/**
 * The update scan — everything `!update` used to do.
 *
 * Runs on a GitHub Actions runner rather than in the Worker, because a full
 * scan makes hundreds of PSN calls over several minutes and Cloudflare's free
 * tier caps a Worker at 50 subrequests per invocation.
 *
 * How the cost stays low
 * ---------------------
 * Two caches do the heavy lifting:
 *
 *  1. Game trophy definitions and worldwide earn rates are IDENTICAL for every
 *     member, so they live in a shared table with a 14-day TTL. The first
 *     member to touch a stale game pays the one call that refreshes it for the
 *     whole server. In a hunting community libraries overlap heavily, so this
 *     gets cheaper the more members you have.
 *
 *  2. A member's own earned trophies are only re-fetched for games whose
 *     earned count actually moved, which the cheap title-list call tells us for
 *     free.
 *
 * Points are then recomputed for EVERY game from stored earned ids against
 * current cached rarity — no API calls at all. That is what produces "points
 * drift": trophies you already own quietly devalue as the rest of the world
 * catches up, which is exactly what the old bot did and why a member could earn
 * three trophies and still lose a thousand points.
 */

import { D1 } from './lib/d1.mjs';
import { PsnClient, PsnPrivateError } from './lib/psn.mjs';
import { trophyPoints, explainDelta } from '../shared/scoring.mjs';
import { postUpdateResult, postMovements, warnTokenExpiry } from './lib/discord.mjs';

const GAME_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const env = process.env;
const db = new D1({
  accountId: env.CF_ACCOUNT_ID,
  databaseId: env.CF_D1_DATABASE_ID,
  apiToken: env.CF_API_TOKEN,
});

async function main() {
  const discordId = env.TARGET_DISCORD_ID;
  const interactionToken = env.INTERACTION_TOKEN || null;

  const member = await db.one('SELECT * FROM members WHERE discord_id = ?', [discordId]);
  if (!member) {
    console.error(`No registered member for discord id ${discordId}`);
    process.exit(1);
  }

  const psn = await connect();
  const started = Date.now();

  // /register writes a provisional row with a `pending:` placeholder, because
  // the Worker has no PSN credentials. Resolving it here is what actually
  // validates that the account exists and its trophies are public.
  if (member.psn_account_id.startsWith('pending:')) {
    const account = await psn.findAccount(member.psn_online_id);
    if (!account) {
      await db.run('DELETE FROM members WHERE discord_id = ?', [discordId]);
      throw new Error(
        `No PSN account called "${member.psn_online_id}". Check the spelling and register again.`,
      );
    }
    await db.run(
      'UPDATE members SET psn_account_id = ?, psn_online_id = ?, avatar_url = ? WHERE discord_id = ?',
      [account.accountId, account.onlineId, account.avatarUrl ?? null, discordId],
    );
    member.psn_account_id = account.accountId;
    member.psn_online_id = account.onlineId;
    member.avatar_url = account.avatarUrl ?? null;
    console.log(`Resolved ${account.onlineId} to account ${account.accountId}`);
  }

  // The global "Update No." — counts every update ever run across the server.
  await db.run(
    'INSERT INTO updates (psn_account_id, discord_id, started_at, status) VALUES (?,?,?,?)',
    [member.psn_account_id, discordId, started, 'running'],
  );
  const { id: updateNo } = await db.one(
    'SELECT id FROM updates WHERE psn_account_id = ? ORDER BY id DESC LIMIT 1',
    [member.psn_account_id],
  );

  try {
    const result = await scanMember(psn, member, updateNo);
    result.updateNo = updateNo;
    result.durationSeconds = Math.round((Date.now() - started) / 1000);

    await finaliseUpdate(updateNo, result, member);
    const movements = await recomputeRanks();

    await postUpdateResult({ member, result, interactionToken });
    if (movements.length) await postMovements(movements);

    const daysLeft = psn.daysUntilReauth();
    if (daysLeft !== null && daysLeft <= 3) await warnTokenExpiry(daysLeft);

    console.log(
      `Update No. ${updateNo} for ${member.psn_online_id}: ` +
        `${result.gamesChanged} games changed, ${psn.requestCount} PSN calls, ` +
        `${result.durationSeconds}s`,
    );
  } catch (err) {
    const status = err instanceof PsnPrivateError ? 'private' : 'failed';
    await db.run('UPDATE updates SET status = ?, finished_at = ? WHERE id = ?', [
      status,
      Date.now(),
      updateNo,
    ]);
    if (status === 'private') {
      await db.run('UPDATE members SET last_scan_ok = 0 WHERE discord_id = ?', [discordId]);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- auth -----

async function connect() {
  const stored = await db.getState('psn_tokens');
  const psn = new PsnClient({
    npsso: env.PSN_NPSSO || undefined,
    refreshToken: stored?.refreshToken,
    onTokens: (state) => db.setState('psn_tokens', state),
  });
  await psn.authenticate();
  psn.refreshTokenExpiresAt = (await db.getState('psn_tokens'))?.refreshTokenExpiresAt;
  return psn;
}

// ---------------------------------------------------------------- scan -----

async function scanMember(psn, member, updateNo) {
  const accountId = member.psn_account_id;

  const before = {
    platinum: member.platinum,
    gold: member.gold,
    silver: member.silver,
    bronze: member.bronze,
    completion: member.completion,
    points: member.points,
    projects: member.projects,
    completed: member.completed,
  };

  const summary = await psn.summary(accountId);
  const titles = await psn.titles(accountId);

  // Sanity check. If the summary says this member owns trophies but their game
  // list comes back empty, something is wrong with the request rather than with
  // the account — fail loudly instead of quietly writing a card full of zeroes.
  const summaryTrophies = sumTrophies(summary?.earnedTrophies);
  if (summaryTrophies > 0 && titles.length === 0) {
    throw new Error(
      `${member.psn_online_id} has ${summaryTrophies} trophies but PSN returned no games. ` +
        `The trophy summary call worked and the titles call did not, so this is a request ` +
        `problem, not a private profile.`,
    );
  }

  const priorRows = await db.query(
    'SELECT np_comm_id, earned_total, progress, points, scanned_at FROM member_games WHERE psn_account_id = ?',
    [accountId],
  );
  const prior = new Map(priorRows.map((r) => [r.np_comm_id, r]));

  // Which games need work, and why.
  const needsEarnedScan = [];
  const gameRows = [];
  for (const t of titles) {
    const was = prior.get(t.npCommunicationId);
    const earnedTotal = sumTrophies(t.earnedTrophies);
    gameRows.push(t);
    if (!was || was.earned_total !== earnedTotal || was.scanned_at == null) {
      needsEarnedScan.push(t);
    }
  }

  // Refresh any globally-stale game definitions. Shared across all members.
  const cutoff = Date.now() - GAME_CACHE_TTL_MS;
  const freshness = new Map();
  // Chunked, because D1 rejects any statement with more than 100 bound
  // parameters and a member with 800 games would otherwise build an IN()
  // clause with 800 of them.
  const CHUNK = D1.chunkSize(1);
  for (let i = 0; i < gameRows.length; i += CHUNK) {
    const slice = gameRows.slice(i, i + CHUNK);
    const cached = await db.query(
      `SELECT np_comm_id, refreshed_at FROM games WHERE np_comm_id IN (${placeholders(slice.length)})`,
      slice.map((t) => t.npCommunicationId),
    );
    for (const r of cached) freshness.set(r.np_comm_id, r.refreshed_at);
  }
  const staleGames = gameRows.filter((t) => (freshness.get(t.npCommunicationId) ?? 0) < cutoff);

  console.log(
    `${member.psn_online_id}: ${titles.length} games — ` +
      `${staleGames.length} rarity refreshes, ${needsEarnedScan.length} progress rescans`,
  );

  for (const t of staleGames) await refreshGameDefinitions(psn, t);

  const changelog = [];
  for (const t of needsEarnedScan) {
    const entry = await rescanMemberGame(psn, accountId, t, prior.get(t.npCommunicationId));
    if (entry) changelog.push(entry);
  }

  // Recompute every game's points from stored ids against current rarity.
  // Pure database work — this is where drift shows up.
  const pointsByGame = await recomputeMemberPoints(accountId);

  const totals = rollUp(summary, titles, pointsByGame);
  const pointsEarned = changelog.reduce((n, c) => n + c.points_gained, 0);
  const delta = explainDelta(pointsEarned, totals.points - before.points);

  if (changelog.length) {
    await db.batchInsert(
      'update_changelog',
      ['update_id', 'np_comm_id', 'title', 'kind', 'trophies_gained', 'points_gained', 'progress_from', 'progress_to'],
      changelog.map((c) => [
        updateNo, c.np_comm_id, c.title, c.kind,
        c.trophies_gained, c.points_gained, c.progress_from, c.progress_to,
      ]),
    );
  }

  return { before, after: totals, delta, changelog, gamesChanged: changelog.length };
}

/** Fetch and cache a game's trophy list + worldwide earn rates. One call, shared by everyone. */
async function refreshGameDefinitions(psn, title) {
  let defs;
  try {
    defs = await psn.titleTrophies(title.npCommunicationId, title.trophyTitlePlatform);
  } catch (err) {
    if (err instanceof PsnPrivateError) return; // delisted / region-locked
    throw err;
  }

  const rows = defs.map((d) => [
    title.npCommunicationId,
    d.trophyId,
    d.trophyName ?? null,
    d.trophyDetail ?? null,
    d.trophyType ?? null,
    d.trophyIconUrl ?? null,
    d.trophyHidden ? 1 : 0,
    d.trophyEarnedRate != null ? Number(d.trophyEarnedRate) : null,
    d.trophyEarnedRate != null ? trophyPoints(Number(d.trophyEarnedRate)) : 0,
  ]);

  await db.run(
    `INSERT OR REPLACE INTO games
       (np_comm_id, np_service_name, title, platform, icon_url, trophy_count, has_platinum, max_points, refreshed_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      title.npCommunicationId,
      title.npServiceName ?? null,
      title.trophyTitleName,
      title.trophyTitlePlatform ?? null,
      title.trophyTitleIconUrl ?? null,
      defs.length,
      defs.some((d) => d.trophyType === 'platinum') ? 1 : 0,
      rows.reduce((n, r) => n + (r[8] || 0), 0),
      Date.now(),
    ],
  );

  await db.batchInsert(
    'trophies',
    ['np_comm_id', 'trophy_id', 'name', 'detail', 'type', 'icon_url', 'hidden', 'earned_rate', 'points'],
    rows,
  );
}

/** Re-read which trophies this member has earned in one game. */
async function rescanMemberGame(psn, accountId, title, was) {
  let earned;
  try {
    earned = await psn.earnedForTitle(accountId, title.npCommunicationId, title.trophyTitlePlatform);
  } catch (err) {
    if (err instanceof PsnPrivateError) return null;
    throw err;
  }

  const earnedIds = earned.filter((t) => t.earned).map((t) => t.trophyId);
  const counts = sumByType(earned);
  const progress = title.progress ?? 0;

  await db.run(
    `INSERT OR REPLACE INTO member_games
       (psn_account_id, np_comm_id, progress, earned_total,
        earned_platinum, earned_gold, earned_silver, earned_bronze,
        earned_ids, points, last_played_at, scanned_at)
     VALUES (?,?,?,?,?,?,?,?,?,COALESCE((SELECT points FROM member_games WHERE psn_account_id=? AND np_comm_id=?),0),?,?)`,
    [
      accountId, title.npCommunicationId, progress, earnedIds.length,
      counts.platinum, counts.gold, counts.silver, counts.bronze,
      JSON.stringify(earnedIds),
      accountId, title.npCommunicationId,
      title.lastUpdatedDateTime ? Date.parse(title.lastUpdatedDateTime) : null,
      Date.now(),
    ],
  );

  const gained = earnedIds.length - (was?.earned_total ?? 0);
  const kind = !was ? 'new' : progress === 100 && was.progress !== 100 ? 'completed' : 'progress';

  return {
    np_comm_id: title.npCommunicationId,
    title: title.trophyTitleName,
    kind,
    trophies_gained: gained,
    points_gained: 0, // filled in by recomputeMemberPoints
    progress_from: was?.progress ?? 0,
    progress_to: progress,
  };
}

/**
 * Recompute this member's points for every game from stored earned ids against
 * the current cached rarity. No PSN calls — this is a join.
 */
async function recomputeMemberPoints(accountId) {
  const rows = await db.query(
    `SELECT mg.np_comm_id, mg.earned_ids,
            (SELECT json_group_array(json_array(t.trophy_id, t.points))
               FROM trophies t WHERE t.np_comm_id = mg.np_comm_id) AS defs
       FROM member_games mg
      WHERE mg.psn_account_id = ?`,
    [accountId],
  );

  const byGame = new Map();
  const updates = [];
  for (const row of rows) {
    const earned = new Set(safeJson(row.earned_ids, []));
    const defs = safeJson(row.defs, []);
    let points = 0;
    for (const [trophyId, pts] of defs) if (earned.has(trophyId)) points += pts || 0;
    byGame.set(row.np_comm_id, points);
    updates.push([points, accountId, row.np_comm_id]);
  }

  for (const [points, acct, game] of updates) {
    await db.run(
      'UPDATE member_games SET points = ? WHERE psn_account_id = ? AND np_comm_id = ?',
      [points, acct, game],
    );
  }
  return byGame;
}

// ------------------------------------------------------------- rollups -----

function rollUp(summary, titles, pointsByGame) {
  const earned = summary?.earnedTrophies ?? {};
  const completed = titles.filter((t) => (t.progress ?? 0) === 100).length;
  const completion = titles.length
    ? titles.reduce((n, t) => n + (t.progress ?? 0), 0) / titles.length
    : 0;

  let points = 0;
  for (const p of pointsByGame.values()) points += p;

  return {
    platinum: earned.platinum ?? 0,
    gold: earned.gold ?? 0,
    silver: earned.silver ?? 0,
    bronze: earned.bronze ?? 0,
    completion: Math.round(completion * 100) / 100,
    points,
    projects: titles.length,
    completed,
  };
}

async function finaliseUpdate(updateNo, result, member) {
  const { before, after, delta } = result;
  await db.run(
    `UPDATE updates SET
       finished_at = ?, d_platinum = ?, d_gold = ?, d_silver = ?, d_bronze = ?,
       d_projects = ?, d_completed = ?, d_completion = ?, d_points = ?,
       points_earned = ?, points_drift = ?, games_changed = ?,
       duration_seconds = ?, status = 'done'
     WHERE id = ?`,
    [
      Date.now(),
      after.platinum - before.platinum,
      after.gold - before.gold,
      after.silver - before.silver,
      after.bronze - before.bronze,
      after.projects - before.projects,
      after.completed - before.completed,
      Math.round((after.completion - before.completion) * 100) / 100,
      delta.net,
      delta.earned,
      delta.drift,
      result.gamesChanged,
      result.durationSeconds,
      updateNo,
    ],
  );

  await db.run(
    `UPDATE members SET
       platinum = ?, gold = ?, silver = ?, bronze = ?,
       completion = ?, points = ?, projects = ?, completed = ?,
       last_update_at = ?, last_scan_ok = 1
     WHERE discord_id = ?`,
    [
      after.platinum, after.gold, after.silver, after.bronze,
      after.completion, after.points, after.projects, after.completed,
      Date.now(), member.discord_id,
    ],
  );
}

/** Re-rank everyone and return who moved, for the #leaderboard feed. */
async function recomputeRanks() {
  const rows = await db.query(
    'SELECT discord_id, psn_online_id, points, rank FROM members ORDER BY points DESC, psn_online_id ASC',
  );

  const movements = [];
  for (let i = 0; i < rows.length; i++) {
    const newRank = i + 1;
    const oldRank = rows[i].rank;
    if (oldRank !== newRank) {
      await db.run('UPDATE members SET prev_rank = rank, rank = ? WHERE discord_id = ?', [
        newRank,
        rows[i].discord_id,
      ]);
      if (oldRank != null) {
        movements.push({
          onlineId: rows[i].psn_online_id,
          from: oldRank,
          to: newRank,
          direction: newRank < oldRank ? 'up' : 'down',
        });
      }
    }
  }
  return movements;
}

// ---------------------------------------------------------------- utils ----

const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');

function sumTrophies(t = {}) {
  return (t.platinum ?? 0) + (t.gold ?? 0) + (t.silver ?? 0) + (t.bronze ?? 0);
}

function sumByType(trophies) {
  const out = { platinum: 0, gold: 0, silver: 0, bronze: 0 };
  for (const t of trophies) if (t.earned && out[t.trophyType] !== undefined) out[t.trophyType]++;
  return out;
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return fallback;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
