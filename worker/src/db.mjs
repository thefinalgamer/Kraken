/**
 * D1 queries for the Worker.
 *
 * Everything here has to answer in a few milliseconds, so member rollups
 * (points, rank, trophy counts) are denormalised onto the members table and the
 * leaderboard is a single indexed read rather than an aggregate over games.
 */

import {
  CONTESTED_SQL,
  CONTESTED_MIN_OWNERS,
  CONTESTED_LIMIT,
} from '../../shared/contested.mjs';

const all = async (env, sql, params = []) =>
  (await env.DB.prepare(sql).bind(...params).all()).results ?? [];

const first = async (env, sql, params = []) => env.DB.prepare(sql).bind(...params).first();

/**
 * The games the server is collectively stuck on.
 *
 * The query itself lives in shared/contested.mjs, because the rescore job runs
 * the identical thing over the REST API to publish the standing board — and two
 * copies of that SQL would eventually disagree about what "contested" means.
 */
export const contested = (env, limit = CONTESTED_LIMIT) =>
  all(env, CONTESTED_SQL, [CONTESTED_MIN_OWNERS, limit]);

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

/**
 * A member added by a mod, skipping verification entirely.
 *
 * The whole verification system exists so nobody can claim somebody else's
 * account. This bypasses it — which is fine ONLY because a mod is vouching with
 * their own judgement, and it is recorded as `grandfathered` so the difference
 * between "proved it" and "someone said so" is never lost.
 *
 * psn_account_id stays provisional until the first scan resolves it, exactly as
 * for a self-registered member: that scan is what actually proves the profile
 * exists and is public.
 */
export async function createVerifiedMember(env, { discordId, onlineId }) {
  await env.DB.prepare(
    `INSERT INTO members (discord_id, psn_account_id, psn_online_id, registered_at,
                          verified_at, verify_method)
     VALUES (?, ?, ?, ?, ?, 'grandfathered')`,
  )
    .bind(discordId, `pending:${discordId}`, onlineId, Date.now(), Date.now())
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
/**
 * Scans currently running, with which LANE each is in.
 *
 * `first_scan` is 1 when that member has never completed a scan — which is
 * exactly what puts them in the slow lane. Derived rather than stored, so there
 * is no second copy of the lane rule to fall out of step with the one in
 * dispatchScan().
 */
export const activeScans = (env) =>
  all(
    env,
    `SELECT m.psn_online_id, u.started_at,
            CASE WHEN m.last_update_at IS NULL THEN 1 ELSE 0 END AS first_scan
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

/**
 * Every edition of a title, best guess first.
 *
 * findGame() returns ONE row, ordered by title length, and for a game that
 * exists on three consoles that is a coin toss. Martin typed /game gta v and
 * got the PS3 list with no way to reach the PS5 one — different np_comm_id,
 * different trophy set, different rarity, same name.
 *
 * PSN gives each edition its own np_comm_id, so they are genuinely separate
 * games that happen to share a title. Ordering: the one YOU own wins, because
 * that is the one you meant; then the one most of the server owns, because that
 * is the one being talked about.
 */
export const gameVersions = (env, title, accountId = null) =>
  all(
    env,
    `SELECT g.np_comm_id, g.title, g.platform, g.trophy_count,
            (SELECT COUNT(*) FROM member_games mg WHERE mg.np_comm_id = g.np_comm_id) AS owners,
            (SELECT COUNT(*) FROM member_games mg
              WHERE mg.np_comm_id = g.np_comm_id AND mg.psn_account_id = ?) AS mine
       FROM games g
      WHERE g.title = ? COLLATE NOCASE
      ORDER BY mine DESC, owners DESC, g.trophy_count DESC, g.np_comm_id ASC
      LIMIT 25`,
    [accountId ?? '', title],
  );

/**
 * Set or clear the unobtainable flag on every edition of a title.
 *
 * By title rather than by np_comm_id on purpose — see flagGame(). Returns how
 * many rows were touched so the reply can say "all 3 editions", which is the
 * only way a mod finds out the PS3 version existed.
 */
/**
 * @param on        mark it dead now
 * @param closesAt  ms timestamp it dies, or null
 *
 * `on` and `closesAt` are independent. A game can be dead (on), dying
 * (closesAt), both — a mod who knows it is already broken AND knows the servers
 * go in March — or neither, which clears everything.
 *
 * EVERY EDITION, matched on title: Sea of Thieves on PS4 and PS5 are separate
 * np_comm_ids and the servers do not close on one of them.
 */
/**
 * Give somebody the supporter star, or take it away.
 *
 * COSMETIC, AND IT MUST STAY THAT WAY. This writes two columns that nothing in
 * the scoring reads. If a future change ever makes points, rank, tier or the
 * order of a list depend on either of them, the board stops being a record of
 * what people earned and becomes something buyable — which is the one thing it
 * cannot survive being.
 *
 * NO PAYMENT DATA. Ko-fi holds the money. All that arrives here is a number of
 * months a mod typed in, so there is nothing in this table worth stealing.
 *
 * `supporter_since` is stamped only on the way UP from zero, and never cleared
 * by a later change, so "since March" keeps meaning the first time they helped
 * rather than the last time a mod touched the row.
 */
export async function setSupporter(env, discordId, months) {
  const m = Math.max(0, Math.floor(Number(months) || 0));
  const res = await env.DB.prepare(
    `UPDATE members
        SET supporter_months = ?,
            supporter_since = CASE
              WHEN ? > 0 AND supporter_since IS NULL THEN ?
              ELSE supporter_since END
      WHERE discord_id = ?`,
  )
    .bind(m, m, Date.now(), String(discordId))
    .run();
  return res?.meta?.changes ?? 0;
}

export async function setUnobtainable(env, title, { on, note, by, closesAt = null, npCommId = null }) {
  /**
   * ONE EDITION, OR ALL OF THEM.
   *
   * Every edition remains the default, because a server shutdown does kill the
   * PS4 and PS5 lists together and making mods flag each one would guarantee
   * they miss the version nobody here owns yet.
   *
   * But `npCommId` had to become possible. Sea of Thieves on PS4 can die while
   * the PS5 list carries on, and until now the only way to say that was to flag
   * both and be wrong about one. A mod who picks a version means that version.
   */
  const scoped = Boolean(npCommId);
  const rows = scoped
    ? await all(env, 'SELECT np_comm_id FROM games WHERE np_comm_id = ?', [npCommId])
    : await all(env, 'SELECT np_comm_id FROM games WHERE title = ? COLLATE NOCASE', [title]);

  const touched = on || closesAt !== null;
  await env.DB.prepare(
    `UPDATE games
        SET unobtainable = ?, unobtainable_note = ?, closes_at = ?,
            flagged_by = ?, flagged_at = ?
      WHERE ${scoped ? 'np_comm_id = ?' : 'title = ? COLLATE NOCASE'}`,
  )
    .bind(
      on ? 1 : 0,
      note ?? null,
      closesAt ?? null,
      touched ? by ?? null : null,
      touched ? Date.now() : null,
      scoped ? npCommId : title,
    )
    .run();
  return rows.length;
}

/** Flag or clear ONE trophy. Returns whether a row actually moved. */
export async function setTrophyUnobtainable(env, npCommId, trophyId, { on, note, by }) {
  const res = await env.DB.prepare(
    `UPDATE trophies
        SET unobtainable = ?, unobtainable_note = ?, flagged_by = ?, flagged_at = ?
      WHERE np_comm_id = ? AND trophy_id = ?`,
  )
    .bind(on ? 1 : 0, on ? note ?? null : null, on ? by ?? null : null, on ? Date.now() : null,
          npCommId, Number(trophyId))
    .run();
  return (res?.meta?.changes ?? 0) > 0;
}

/**
 * Flag or clear a trophy BY NAME across every edition of a title.
 *
 * WHY NAME AND NOT ID. Regional stacks are separate np_comm_ids: WWE All Stars
 * PS3 and WWE All Stars PS3 (JP) are two games that happen to be the same game.
 * Their trophy ids usually line up, but "usually" is not a thing to flag data
 * on, and a remaster with a reordered list would silently mark the wrong
 * trophy. A moderator saying "Rail Hydra is broken" means the trophy called
 * Rail Hydra, in whichever stacks have one, so that is what this matches.
 *
 * An edition without a trophy by that name is simply not touched, which is the
 * correct outcome rather than an error: it does not have the broken trophy.
 *
 * COLLATE NOCASE on the name for the same reason every other lookup on this
 * board has it. Returns how many trophy rows moved, across all editions.
 */
export async function setTrophyUnobtainableByName(env, title, name, { on, note, by }) {
  const res = await env.DB.prepare(
    `UPDATE trophies
        SET unobtainable = ?, unobtainable_note = ?, flagged_by = ?, flagged_at = ?
      WHERE name = ? COLLATE NOCASE
        AND np_comm_id IN (SELECT np_comm_id FROM games WHERE title = ? COLLATE NOCASE)`,
  )
    .bind(on ? 1 : 0, on ? note ?? null : null, on ? by ?? null : null, on ? Date.now() : null,
          name, title)
    .run();
  return res?.meta?.changes ?? 0;
}

/**
 * How many flagged trophies each of these editions has, in one query.
 *
 * The game flag is a rollup of its trophies, so flagging across eight stacks
 * means eight games to bring into line. Asking per edition would be eight round
 * trips for a number SQLite can group in one pass, and the partial index on
 * `unobtainable = 1` means it only ever walks flagged rows.
 */
export const deadCountsByEdition = (env, npCommIds) =>
  npCommIds.length
    ? all(
        env,
        `SELECT np_comm_id, COUNT(*) AS dead, MIN(name) AS one
           FROM trophies
          WHERE unobtainable = 1
            AND np_comm_id IN (${npCommIds.map(() => '?').join(',')})
          GROUP BY np_comm_id`,
        npCommIds,
      )
    : Promise.resolve([]);

/**
 * The flagged trophies in one game, rarest first.
 *
 * Index-backed by `idx_trophies_dead`, which is partial — there are a million
 * trophy rows and this only ever wants the handful that are flagged.
 */
export const deadTrophies = (env, npCommId) =>
  all(
    env,
    `SELECT trophy_id, name, type, unobtainable_note
       FROM trophies
      WHERE np_comm_id = ? AND unobtainable = 1
      ORDER BY trophy_id ASC`,
    [npCommId],
  );

/**
 * Trophies in one game, for the /flag autocomplete.
 *
 * Scoped to a single np_comm_id, so this reads one game's list — 40 rows
 * typically, ~120 at the worst — never the table. LIKE is escaped for the same
 * reason searchMembers is: `_` is a single-character wildcard and trophy names
 * are full of them.
 */
export const searchTrophies = (env, npCommId, query, limit = 25) => {
  const term = String(query ?? '').replace(/[\\%_]/g, (c) => `\\${c}`);
  return all(
    env,
    `SELECT trophy_id, name, type, unobtainable
       FROM trophies
      WHERE np_comm_id = ?
        AND (? = '' OR name LIKE ? ESCAPE '\\' COLLATE NOCASE)
      ORDER BY unobtainable DESC, trophy_id ASC
      LIMIT ?`,
    [npCommId, term, `%${term}%`, limit],
  );
};

/**
 * Flag or clear EVERY trophy in a title, or in one edition of it.
 *
 * For a game that is wholly gone. JFL__Leon's argument, with XDefiant as the
 * proof: it is entirely online, the servers closed in June 2025, and the page
 * said "SOME trophies here can no longer be earned" over a trophy list that
 * looked completely ordinary. Clicking into a dead game made it look less
 * serious rather than more.
 *
 * NOT WHAT A BLANK TROPHY FIELD MEANS, deliberately. Leaving it blank is what a
 * mod does when they mean "this game has a problem and I am about to name which
 * trophies" — inFAMOUS 2 is 4 of 52. Making blank mean "all" would have that
 * mod marking 48 good trophies dead with no way back but unflagging them one at
 * a time. It is an explicit pick in the dropdown instead.
 */
export async function setAllTrophies(env, { title, npCommId = null }, { on, note, by }) {
  const res = await env.DB.prepare(
    `UPDATE trophies
        SET unobtainable = ?, unobtainable_note = ?, flagged_by = ?, flagged_at = ?
      WHERE ${
        npCommId
          ? 'np_comm_id = ?'
          : 'np_comm_id IN (SELECT np_comm_id FROM games WHERE title = ? COLLATE NOCASE)'
      }`,
  )
    .bind(on ? 1 : 0, on ? note ?? null : null, on ? by ?? null : null, on ? Date.now() : null,
          npCommId ?? title)
    .run();
  return res?.meta?.changes ?? 0;
}

/**
 * Clear every trophy flag on a title, or on one edition of it.
 *
 * WHY THIS EXISTS. `/flag <game>` with nothing else says "Flag cleared" and
 * turns the game green — and it only ever touched the games row. A mod who
 * flagged a trophy, then ran the obvious undo, was told the game was completable
 * again while the trophy kept its warning on every page. A false success is
 * worse than an error: nobody goes looking for a bug they have been told is
 * fixed.
 *
 * Returns how many flags were actually lifted, so the reply can say so rather
 * than claiming a clean-up that did nothing.
 */
export async function clearTrophyFlags(env, { title, npCommId = null }) {
  const res = await env.DB.prepare(
    npCommId
      ? `UPDATE trophies SET unobtainable = 0, unobtainable_note = NULL,
                flagged_by = NULL, flagged_at = NULL
          WHERE np_comm_id = ? AND unobtainable = 1`
      : `UPDATE trophies SET unobtainable = 0, unobtainable_note = NULL,
                flagged_by = NULL, flagged_at = NULL
          WHERE unobtainable = 1
            AND np_comm_id IN (SELECT np_comm_id FROM games WHERE title = ? COLLATE NOCASE)`,
  )
    .bind(npCommId ?? title)
    .run();
  return res?.meta?.changes ?? 0;
}

/** One trophy, by game and id. Needed to name a trophy after clearing its flag. */
export const trophyRow = (env, npCommId, trophyId) =>
  first(
    env,
    'SELECT trophy_id, name, type, unobtainable, unobtainable_note FROM trophies WHERE np_comm_id = ? AND trophy_id = ?',
    [npCommId, Number(trophyId)],
  );

export const gameById = (env, npCommId) =>
  first(env, 'SELECT * FROM games WHERE np_comm_id = ?', [npCommId]);

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

/**
 * Game title autocomplete.
 *
 * Three faults in the original, all visible in one screenshot: it returned the
 * same title once per platform (eight identical rows of "%"), it ranked purely
 * by title length so the junk floated to the top, and with an empty box it
 * offered the shortest titles in a 20,000-game database rather than anything to
 * do with the person typing.
 *
 * GROUP BY dedupes. The CASE puts titles that START with what you typed above
 * ones that merely contain it, so "spider" offers Spider-Man before
 * Rise of the Spiders.
 */
/**
 * The autocomplete behind /flag and /game.
 *
 * TWO THINGS WERE WRONG WITH THIS AND THEY WERE THE SAME THING.
 *
 * It searched all 26,042 games. A mid-word LIKE cannot use the title index, so
 * every keystroke read the whole table, grouped it and sorted it — call it
 * 200,000 rows to type one game name. That is a tenth of the bot's entire daily
 * budget spent on a dropdown.
 *
 * And it ordered by LENGTH(title), which was meant to float exact matches and
 * instead buried them: typing "mine" offered the five shortest titles on PSN
 * containing those letters, from a global catalogue, and Minecraft was not
 * among them. Fast would not have saved it — the list was wrong.
 *
 * `local_started > 0` fixes both at once. It cuts 26,042 rows to about 514 and
 * it cuts them to exactly the right 514: you cannot usefully flag, or ask about,
 * a game nobody on this server owns. Ordering by how many people here own it
 * then puts the game they almost certainly mean at the top.
 *
 * Still no index needed. Five hundred rows is smaller than one /rank.
 */
export const searchGames = (env, query, limit = 25) =>
  all(
    env,
    `SELECT title, MAX(local_started) AS owners FROM games
      WHERE local_started > 0
        AND title LIKE ? COLLATE NOCASE
        AND TRIM(COALESCE(title, '')) <> ''
      GROUP BY title COLLATE NOCASE
      ORDER BY CASE WHEN title LIKE ? COLLATE NOCASE THEN 0 ELSE 1 END,
               owners DESC, LENGTH(title) ASC, title ASC
      LIMIT ?`,
    [`%${query}%`, `${query}%`, limit],
  );

/**
 * What to offer before they've typed anything: their own games, most recently
 * played first. Nobody opens /game to look up a title they don't own.
 */
export const myRecentGames = (env, accountId, limit = 25) =>
  all(
    env,
    `SELECT g.title, MAX(mg.last_played_at) AS played
       FROM member_games mg
       JOIN games g ON g.np_comm_id = mg.np_comm_id
      WHERE mg.psn_account_id = ? AND TRIM(COALESCE(g.title, '')) <> ''
      GROUP BY g.title COLLATE NOCASE
      ORDER BY played DESC
      LIMIT ?`,
    [accountId, limit],
  );

export const gameTrophies = (env, npCommId) =>
  all(
    env,
    // local_earned is needed by the "N/M here" line on /game. It was missing
    // from this list, so that line rendered 0 for every trophy in every game
    // regardless of what the rescore had counted.
    'SELECT trophy_id, name, type, earned_rate, points, local_earned FROM trophies WHERE np_comm_id = ?',
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
            SUM(CASE WHEN progress = 100 THEN 1 ELSE 0 END) AS completed
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
    // `progress = 100` is 100% COMPLETION, not platinum ownership. It was
    // called `platted` and the card said "have platted this", which is wrong
    // twice over: it misdescribes what is counted, and it cannot be true at all
    // for a game with no platinum — DLC-only lists and plenty of small titles.
    // The number was always right; only the word was wrong.
    completed: row?.completed ?? 0,
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
  // Four genuinely different questions. `quick` used to be "fewest trophies
  // left", which returned almost exactly the same list as `nearly` — a game at
  // 98% has two trophies left, so the two sorts agreed on everything and one
  // button was wasted. Points-per-remaining-trophy is the question neither of
  // the others answers: where is the best return for the least work.
  const order = {
    value: 'remaining_points DESC',
    nearly: 'mg.progress DESC, remaining_points DESC',
    quick: 'remaining_points * 1.0 / MAX(remaining_trophies, 1) DESC, remaining_points DESC',
    rare: 'plat_rate ASC, remaining_points DESC',
    // batzclaw: "if you dont want to do the big points games but have a lot of
    // small little point games could we have that show up also."
    //
    // The other four all point at the same shelf from different angles — the
    // biggest prize, the nearest finish, the best rate, the rarest plat — and
    // every one of them buries a member whose library is a hundred cheap games.
    // This is the only sort that says "clear the small stuff", which for a lot
    // of people is the realistic evening.
    //
    // ASC, but the WHERE clause below already excludes worthless games, so this
    // returns the cheapest games that are still WORTH something rather than a
    // page of zeroes.
    small: 'remaining_points ASC, mg.progress DESC',
  }[sort] ?? 'remaining_points DESC';

  return all(
    env,
    `SELECT g.title,
            g.np_comm_id,
            mg.progress,
            (g.max_points - mg.points)              AS remaining_points,
            (g.trophy_count - mg.earned_total)      AS remaining_trophies,
            (SELECT t.earned_rate FROM trophies t
              WHERE t.np_comm_id = g.np_comm_id AND t.type = 'platinum' LIMIT 1) AS plat_rate,
            g.unobtainable,
            g.unobtainable_note
       FROM member_games mg
       JOIN games g ON g.np_comm_id = mg.np_comm_id
      WHERE mg.psn_account_id = ?
        AND mg.progress < 100
        AND g.max_points IS NOT NULL
        AND (g.trophy_count - mg.earned_total) > 0
        ${
          // Only the ascending sort needs this, and it needs it badly. Every
          // other sort pushes worthless games to the bottom for free; 'small'
          // would put them at the TOP and hand back five rows of "+0 points",
          // which is the exact screenshot that started the shovelware
          // conversation in the first place.
          sort === 'small' ? 'AND (g.max_points - mg.points) > 0' : ''
        }
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
/**
 * Everybody a member is watching, in one query.
 *
 * `rank IS NOT NULL` keeps somebody mid-first-scan out of the board rather than
 * rendering them with a blank position. They stay ON the list — the id is still
 * stored — they just do not appear until they have a rank, which is the same
 * rule every other list on this board follows.
 *
 * At most five ids, so the IN() list can never approach D1's parameter ceiling.
 */
export const rivalRows = (env, accountIds) =>
  accountIds.length
    ? all(
        env,
        `SELECT * FROM members
          WHERE psn_account_id IN (${accountIds.map(() => '?').join(',')})
            AND rank IS NOT NULL
          ORDER BY rank ASC`,
        accountIds,
      )
    : Promise.resolve([]);

/**
 * Their Twitch channel, or NULL to stop watching.
 *
 * Stored lowercased because that is what Twitch matches on, and because the
 * uniqueness check below would otherwise let "Pelzio" and "pelzio" both exist.
 */
export const setTwitch = (env, accountId, login) =>
  env.DB.prepare('UPDATE members SET twitch_login = ? WHERE psn_account_id = ?')
    .bind(login ? String(login).toLowerCase() : null, accountId)
    .run();

/** Whoever has claimed this channel, if anybody. */
export const memberByTwitch = (env, login) =>
  first(
    env,
    'SELECT psn_account_id, psn_online_id FROM members WHERE twitch_login = ? COLLATE NOCASE',
    [String(login ?? '').toLowerCase()],
  );

/** Save the list. One column, one row, no join table — see migrations/014. */
export const setRivals = (env, discordId, json) =>
  env.DB.prepare('UPDATE members SET rivals = ? WHERE discord_id = ?')
    .bind(json, String(discordId))
    .run();

/**
 * Registered hunters, for the /rivals autocomplete.
 *
 * Seventy rows on the whole table, so this is a scan of nothing and needs no
 * index. `rank IS NOT NULL` matches what the board will actually show — there
 * is no point offering somebody you cannot then display.
 */
export const searchMembers = (env, query, limit = 25) => {
  /*
   * ESCAPED, because PSN IDs are full of underscores and `_` is LIKE's own
   * single-character wildcard. Typing "JFL__Leon" without this searches for
   * "JFL" then any two characters then "Leon" — which happens to match the
   * person you meant, and also matches JFLxxLeon if one ever existed. On a
   * seventy-row table nobody would ever notice being quietly wrong, which is
   * exactly the kind of bug that survives for years.
   */
  const term = String(query ?? '').replace(/[\\%_]/g, (c) => `\\${c}`);
  return all(
    env,
    `SELECT psn_account_id, psn_online_id, rank FROM members
      WHERE rank IS NOT NULL
        AND psn_online_id LIKE ? ESCAPE '\\' COLLATE NOCASE
      ORDER BY CASE WHEN psn_online_id LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 0 ELSE 1 END,
               rank ASC
      LIMIT ?`,
    [`%${term}%`, `${term}%`, limit],
  );
};

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
