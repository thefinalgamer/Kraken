/**
 * D1 queries for the Worker.
 *
 * Everything here has to answer in a few milliseconds, so member rollups
 * (points, rank, trophy counts) are denormalised onto the members table and the
 * leaderboard is a single indexed read rather than an aggregate over games.
 */

const all = async (env, sql, params = []) =>
  (await env.DB.prepare(sql).bind(...params).all()).results ?? [];

const first = async (env, sql, params = []) => env.DB.prepare(sql).bind(...params).first();

// -------------------------------------------------------------- members ----

export const memberByDiscordId = (env, discordId) =>
  first(env, 'SELECT * FROM members WHERE discord_id = ?', [discordId]);

export const memberByOnlineId = (env, onlineId) =>
  first(env, 'SELECT * FROM members WHERE psn_online_id = ? COLLATE NOCASE', [onlineId]);

export const memberCount = async (env) =>
  (await first(env, 'SELECT COUNT(*) AS c FROM members'))?.c ?? 0;

export const leaderboardPage = (env, offset, limit) =>
  all(
    env,
    `SELECT * FROM members
      WHERE last_update_at IS NOT NULL
      ORDER BY points DESC, psn_online_id ASC
      LIMIT ? OFFSET ?`,
    [limit, offset],
  );

/** A member's rank plus the people either side of them. */
export const neighbours = (env, rank, spread = 2) =>
  all(
    env,
    `SELECT * FROM members
      WHERE rank BETWEEN ? AND ?
      ORDER BY rank ASC`,
    [Math.max(1, rank - spread), rank + spread],
  );

export const rankForPoints = async (env, points) =>
  ((await first(env, 'SELECT COUNT(*) AS c FROM members WHERE points > ?', [points]))?.c ?? 0) + 1;

export const membersBetween = (env, fromRank, toRank) =>
  all(
    env,
    'SELECT psn_online_id, rank FROM members WHERE rank >= ? AND rank < ? ORDER BY rank ASC',
    [fromRank, toRank],
  );

export async function createProvisionalMember(env, { discordId, onlineId, verifyCode }) {
  // psn_account_id is filled in by the first scan, which is what actually
  // validates the profile exists and is public. Provisional rows are excluded
  // from the leaderboard by the `last_update_at IS NOT NULL` filter.
  await env.DB.prepare(
    `INSERT INTO members (discord_id, psn_account_id, psn_online_id, registered_at, verify_code)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(discordId, `pending:${discordId}`, onlineId, Date.now(), verifyCode ?? null)
    .run();
}

// --------------------------------------------------------- verification ----

/** The verify_code doubles as the OAuth state, so this is the lookup for both. */
export const memberByVerifyCode = (env, code) =>
  first(env, 'SELECT * FROM members WHERE verify_code = ?', [code]);

export async function markVerified(env, discordId, method) {
  await env.DB.prepare(
    'UPDATE members SET verified_at = ?, verify_method = ?, verify_code = NULL WHERE discord_id = ?',
  )
    .bind(Date.now(), method, discordId)
    .run();
}

/**
 * Is this PSN ID genuinely spoken for?
 *
 * Only a VERIFIED member blocks a claim. An unverified provisional row expires
 * after an hour, so somebody who types a name and never proves it cannot sit on
 * it forever — which was the whole problem with the old first-come-first-served
 * check. The hour of grace exists only so two people racing for the same name
 * are not both told it is free.
 */
const CLAIM_GRACE_MS = 60 * 60 * 1000;

export const claimBlockedBy = (env, onlineId) =>
  first(
    env,
    `SELECT * FROM members
      WHERE psn_online_id = ? COLLATE NOCASE
        AND (verified_at IS NOT NULL OR registered_at > ?)`,
    [onlineId, Date.now() - CLAIM_GRACE_MS],
  );

/**
 * Hand an unverified member a fresh code, and let them correct the PSN name
 * while they're at it — a typo is the most likely reason a first attempt
 * failed, and making them find a mod to fix it would be daft.
 */
export async function reissueVerifyCode(env, discordId, currentOnlineId, requestedOnlineId, code) {
  const onlineId = requestedOnlineId || currentOnlineId;
  await env.DB.prepare(
    'UPDATE members SET verify_code = ?, psn_online_id = ? WHERE discord_id = ? AND verified_at IS NULL',
  )
    .bind(code, onlineId, discordId)
    .run();
}

/** Mod tooling. Frees both the Discord user and the PSN name for reuse. */
export async function unlinkMember(env, discordId) {
  const member = await memberByDiscordId(env, discordId);
  if (!member) return null;
  await env.DB.prepare('DELETE FROM members WHERE discord_id = ?').bind(discordId).run();
  return member;
}

/**
 * Scans currently in progress, anywhere on the server.
 *
 * Scans are serialised — every one authenticates as the same PSN account, so
 * running them in parallel would blow Sony's rate limit. That means a member
 * can be waiting behind somebody else's scan, and without telling them so the
 * bot simply looks dead.
 */
export const activeScans = (env) =>
  all(
    env,
    `SELECT m.psn_online_id, u.started_at
       FROM updates u
       JOIN members m ON m.psn_account_id = u.psn_account_id
      WHERE u.status = 'running' AND u.started_at > ?
      ORDER BY u.started_at ASC`,
    [Date.now() - 60 * 60 * 1000],
  );

/** Guards against a double /update. Anything older than an hour is a dead job. */
export const hasRunningUpdate = async (env, accountId) =>
  Boolean(
    await first(
      env,
      `SELECT 1 AS x FROM updates
        WHERE psn_account_id = ? AND status = 'running' AND started_at > ?`,
      [accountId, Date.now() - 60 * 60 * 1000],
    ),
  );

// ---------------------------------------------------------------- games ----

export const findGame = (env, query) =>
  first(
    env,
    `SELECT * FROM games
      WHERE title = ? COLLATE NOCASE
         OR title LIKE ? COLLATE NOCASE
      ORDER BY LENGTH(title) ASC
      LIMIT 1`,
    [query, `%${query}%`],
  );

export const searchGames = (env, query, limit = 25) =>
  all(
    env,
    'SELECT title FROM games WHERE title LIKE ? COLLATE NOCASE ORDER BY LENGTH(title) ASC LIMIT ?',
    [`%${query}%`, limit],
  );

export const gameTrophies = (env, npCommId) =>
  all(
    env,
    'SELECT trophy_id, name, type, earned_rate, points FROM trophies WHERE np_comm_id = ?',
    [npCommId],
  );

export const memberGame = (env, accountId, npCommId) =>
  first(
    env,
    'SELECT * FROM member_games WHERE psn_account_id = ? AND np_comm_id = ?',
    [accountId, npCommId],
  );

export async function gameOwners(env, npCommId) {
  const row = await first(
    env,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN progress = 100 THEN 1 ELSE 0 END) AS platted
       FROM member_games WHERE np_comm_id = ?`,
    [npCommId],
  );
  const fastest = await first(
    env,
    `SELECT m.psn_online_id
       FROM member_games mg JOIN members m ON m.psn_account_id = mg.psn_account_id
      WHERE mg.np_comm_id = ? AND mg.progress = 100
      ORDER BY mg.last_played_at ASC LIMIT 1`,
    [npCommId],
  );
  return {
    total: row?.total ?? 0,
    platted: row?.platted ?? 0,
    fastest: fastest?.psn_online_id ?? null,
  };
}

export const gameOwnerList = (env, npCommId, limit = 15) =>
  all(
    env,
    `SELECT m.psn_online_id, mg.progress
       FROM member_games mg JOIN members m ON m.psn_account_id = mg.psn_account_id
      WHERE mg.np_comm_id = ?
      ORDER BY mg.progress DESC, m.psn_online_id ASC LIMIT ?`,
    [npCommId, limit],
  );

// -------------------------------------------------------------- backlog ----

/**
 * Unfinished games ranked by what finishing them is worth.
 *
 * `remaining_points` is the game's full value minus what this member has
 * already banked, so a game they're 90% through correctly shows as a small
 * remaining prize rather than a big one.
 */
export function backlog(env, accountId, sort = 'value', limit = 5) {
  const order = {
    value: 'remaining_points DESC',
    nearly: 'mg.progress DESC, remaining_points DESC',
    quick: 'remaining_trophies ASC, remaining_points DESC',
    rare: 'plat_rate ASC, remaining_points DESC',
  }[sort] ?? 'remaining_points DESC';

  return all(
    env,
    `SELECT g.title,
            g.np_comm_id,
            mg.progress,
            (g.max_points - mg.points)              AS remaining_points,
            (g.trophy_count - mg.earned_total)      AS remaining_trophies,
            (SELECT t.earned_rate FROM trophies t
              WHERE t.np_comm_id = g.np_comm_id AND t.type = 'platinum' LIMIT 1) AS plat_rate
       FROM member_games mg
       JOIN games g ON g.np_comm_id = mg.np_comm_id
      WHERE mg.psn_account_id = ?
        AND mg.progress < 100
        AND g.max_points IS NOT NULL
        AND (g.trophy_count - mg.earned_total) > 0
      ORDER BY ${order}
      LIMIT ?`,
    [accountId, limit],
  );
}

/**
 * Members who actually appear on the board — ranked, with a completed scan.
 * memberCount() counts registrations, which includes anyone mid-first-scan and
 * made the leaderboard header disagree with the list underneath it.
 */
export const rankedCount = async (env) =>
  (await first(env, 'SELECT COUNT(*) AS c FROM members WHERE rank IS NOT NULL AND last_update_at IS NOT NULL'))?.c ?? 0;

/**
 * What changed in one update. Ordered by what it was worth, so the interesting
 * games are at the top and any truncation drops the boring ones.
 */
export const changelogFor = (env, updateId, limit = 60) =>
  all(
    env,
    `SELECT title, kind, trophies_gained, points_gained, progress_from, progress_to
       FROM update_changelog
      WHERE update_id = ?
      ORDER BY points_gained DESC, trophies_gained DESC
      LIMIT ?`,
    [updateId, limit],
  );

export const changelogCount = async (env, updateId) =>
  (await first(env, 'SELECT COUNT(*) AS c FROM update_changelog WHERE update_id = ?', [updateId]))?.c ?? 0;

// -------------------------------------------------------------- profile ----

/** The single game worth the most points to this member. */
export const bestGame = (env, accountId) =>
  first(
    env,
    `SELECT g.title, mg.points, mg.progress
       FROM member_games mg JOIN games g ON g.np_comm_id = mg.np_comm_id
      WHERE mg.psn_account_id = ? AND mg.points > 0
      ORDER BY mg.points DESC LIMIT 1`,
    [accountId],
  );

/** Most recently finished games — what they've been clearing lately. */
export const recentlyFinished = (env, accountId, limit = 3) =>
  all(
    env,
    `SELECT g.title, mg.last_played_at
       FROM member_games mg JOIN games g ON g.np_comm_id = mg.np_comm_id
      WHERE mg.psn_account_id = ? AND mg.progress = 100
      ORDER BY mg.last_played_at DESC LIMIT ?`,
    [accountId, limit],
  );

/** Update history: how many, and the best single one. */
export const updateStats = (env, accountId) =>
  first(
    env,
    `SELECT COUNT(*) AS runs,
            MAX(d_points) AS best_gain,
            SUM(d_platinum) AS plats_here
       FROM updates
      WHERE psn_account_id = ? AND status = 'done'`,
    [accountId],
  );

/**
 * Games you BOTH own where they are further ahead than you.
 *
 * The most useful thing one member can learn about another, and the seed of the
 * /boost co-op idea: not "they are better than me" but "here are four specific
 * games where they know something I don't".
 */
export const aheadOfMe = (env, theirAccount, myAccount, limit = 4) =>
  all(
    env,
    `SELECT g.title, mine.progress AS my_progress, theirs.progress AS their_progress
       FROM member_games theirs
       JOIN member_games mine
         ON mine.np_comm_id = theirs.np_comm_id AND mine.psn_account_id = ?
       JOIN games g ON g.np_comm_id = theirs.np_comm_id
      WHERE theirs.psn_account_id = ?
        AND theirs.progress > mine.progress
      ORDER BY (theirs.progress - mine.progress) DESC, theirs.progress DESC
      LIMIT ?`,
    [myAccount, theirAccount, limit],
  );
