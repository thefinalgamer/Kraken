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
import {
  isUnrated, explainDelta, completionWeight, applyCompletion, scoreGameTrophies,
} from '../shared/scoring.mjs';
import { memberCompletion } from './lib/completion.mjs';
import { settleLocalRarity } from './lib/settle.mjs';
import {
  postUpdateResult,
  postProjects,
  postUpdateFailure,
  postMovements,
  publishLeaderboard,
  warnTokenExpiry,
  syncTierRoles,
} from './lib/discord.mjs';

/**
 * How long cached rarity stays good for.
 *
 * Was 14 days, which turned out to be far too eager: a member's whole library
 * is first scanned on one day, so it all expires on one day, and that update
 * grinds through the entire stale budget. Trophy rarity moves like a glacier —
 * a game that was 3% last month is 3% this month — so a month costs nothing in
 * accuracy and roughly halves the background refreshing.
 */
const GAME_CACHE_TTL_MS = Number(process.env.GAME_CACHE_TTL_DAYS || 30) * 24 * 60 * 60 * 1000;

/**
 * Most stale-rarity refreshes allowed in a single update. Games the member has
 * actually played are never subject to this — they're always scanned. This only
 * caps the background job of keeping rarity current, so no single update can
 * balloon back to first-scan length.
 */
const STALE_REFRESH_BUDGET = Number(process.env.STALE_REFRESH_BUDGET) || 150;

/**
 * How long an ESTIMATED game stays good for — one whose trophies PSN has
 * published no rarity for, so its points come from UNRATED_FALLBACK.
 *
 * Much shorter than the normal TTL, because the two things that land in this
 * bucket behave very differently. Old PS3 titles will never get figures and
 * re-checking them is nearly free (there are only ~150). New releases —
 * Assassin's Creed Black Flag Resynced was the one that made this obvious —
 * get real rarity within weeks of launch, and on a 30-day cache they would sit
 * on a guess for a month after the truth was available.
 *
 * Checking every three days costs a handful of calls and means a new game is
 * priced properly almost as soon as Sony prices it.
 */
const ESTIMATE_TTL_MS = Number(process.env.ESTIMATE_TTL_DAYS || 3) * 24 * 60 * 60 * 1000;

/**
 * How many games may have their trophy NAMES fetched in a single scan.
 *
 * `earnedForTitle` — the one call this scan makes per game — returns rarity and
 * earned state but NOT trophy names. Only `titleTrophies` returns those, and
 * until now nothing in the codebase called it, so `trophies.name` was never
 * populated for anything this build scanned. That is the whole cause of
 * "1. null · bronze" on /game and of rarest_name staying null after a scan;
 * the queries were always fine, the column was simply empty.
 *
 * Names are immutable, so a game pays this exactly once ever and then never
 * again for anybody. The cap exists so the first pass over a large library
 * doesn't double that scan's call count — the remainder is picked up by the
 * next update, and by other members who own the same games.
 */
const NAME_BACKFILL_PER_SCAN = Number(process.env.NAME_BACKFILL_PER_SCAN || 60);

/**
 * A PSN profile's About Me, for the bio verification code.
 *
 * psn-api has shuffled this between the top level and a nested `profile` object
 * across versions, so check both rather than break on a dependency bump.
 */
async function readAboutMe(psn, onlineId) {
  try {
    const res = await psn.profile(onlineId);
    return String(res?.aboutMe ?? res?.profile?.aboutMe ?? '');
  } catch (err) {
    console.error('Could not read About Me', err);
    return '';
  }
}

const env = process.env;
const db = new D1({
  accountId: env.CF_ACCOUNT_ID,
  databaseId: env.CF_D1_DATABASE_ID,
  apiToken: env.CF_API_TOKEN,
});

async function main() {
  // Trimmed, because this arrives from a hand-typed Actions input as often as
  // from the Worker. A trailing space is invisible in the input box AND in the
  // error message, so an id that looks identical to the one in the database
  // silently matches nothing — which reads as "this member doesn't exist" and
  // sends you hunting for a deleted row that was never deleted.
  const discordId = String(env.TARGET_DISCORD_ID ?? '').trim();
  const interactionToken = env.INTERACTION_TOKEN || null;

  if (!/^\d{5,}$/.test(discordId)) {
    console.error(
      `"${env.TARGET_DISCORD_ID}" is not a Discord user id. ` +
        'Enable Developer Mode, right-click the member, Copy User ID — it is a long number. ' +
        '(A PSN name or a channel id will not work.)',
    );
    process.exit(1);
  }

  const member = await db.one('SELECT * FROM members WHERE discord_id = ?', [discordId]);
  if (!member) {
    // Quoted deliberately: whitespace and lookalike characters are the usual
    // cause, and neither shows up in a bare printout.
    console.error(`No registered member for discord id "${discordId}" (${discordId.length} chars)`);
    const known = await db.query(
      'SELECT discord_id, psn_online_id FROM members ORDER BY psn_online_id',
    );
    console.error(
      known.length
        ? `Registered members:\n${known.map((m) => `  ${m.discord_id}  ${m.psn_online_id}`).join('\n')}`
        : 'There are no registered members at all.',
    );
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
    // Ownership check, and the reason this happens BEFORE anything is written:
    // without it, /register was first-come-first-served and anyone could claim
    // anyone. The Worker can't read a PSN profile — no credentials — so the
    // check lands here, as the first thing the scan does.
    //
    // Only runs for the bio route. The "link with Discord" route has already
    // set verified_at, because Discord made them sign in to Sony directly and
    // that is stronger evidence than a string in a bio.
    if (member.verify_code && !member.verified_at) {
      const aboutMe = await readAboutMe(psn, account.onlineId);
      if (!aboutMe.toUpperCase().includes(member.verify_code.toUpperCase())) {
        throw new Error(
          `Couldn't find \`${member.verify_code}\` in ${account.onlineId}'s About Me. ` +
            `Add it (Profile → Edit Profile → About Me), give PSN a minute to catch up, ` +
            `then run \`/verify\` again.`,
        );
      }
      await db.run(
        "UPDATE members SET verified_at = ?, verify_method = 'bio', verify_code = NULL WHERE discord_id = ?",
        [Date.now(), discordId],
      );
      member.verified_at = Date.now();
      console.log(`Verified ${account.onlineId} via About Me code`);
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

  // Captured BEFORE the scan, because scanMember() writes last_update_at as its
  // final act. A first scan marks a member's entire library as newly started —
  // Pelziowo joining would announce 15,411 games he finished with years ago —
  // so #new-projects has to know the difference.
  const isFirstScan = !member.last_update_at;

  try {
    const result = await scanMember(psn, member, updateNo);
    result.updateNo = updateNo;
    result.durationSeconds = Math.round((Date.now() - started) / 1000);

    await finaliseUpdate(updateNo, result, member);
    const movements = await recomputeRanks();

    // Everything past this point is ANNOUNCING the result, not producing it.
    // The scan is done and the database is written; a Discord problem must not
    // undo that. This exact case bit us once — a six-hour scan of a 15,000-game
    // library finished cleanly and was then marked "failed" because the bot
    // lacked Send Messages permission in one channel. Data safe, run red,
    // update row wrongly flagged, and no obvious way to tell the difference.
    //
    // So: announce on a best-effort basis, log loudly if it fails, and let the
    // job succeed regardless. A missing message is a nuisance. A lost scan is
    // six hours and a member's whole library.
    const announce = async (what, fn) => {
      try {
        await fn();
      } catch (err) {
        const missingAccess = /Missing Access|50001|403/.test(String(err?.message ?? ''));
        console.error(
          `WARNING: ${what} could not be posted to Discord — the scan itself was fine.\n` +
            `  ${err?.message ?? err}` +
            (missingAccess
              ? '\n  This looks like a permissions problem. Give Kraken View Channel, ' +
                'Send Messages, Embed Links and Read Message History on that channel.'
              : ''),
        );
      }
    };

    await announce('the update card', () => postUpdateResult({ member, result, interactionToken }));

    // #new-projects and #completed. Reads only what the scan already wrote, so
    // it costs one query and cannot affect the result either way.
    await announce('the project cards', () =>
      postProjects(db, member, result, { first: isFirstScan }),
    );
    if (movements.length) await announce('the rank movements', () => postMovements(movements));

    // Rewrite the living board in #leaderboard. Everyone is on it, split across
    // as many messages as it takes, each edited in place rather than reposted.
    await announce('the leaderboard', async () => {
      const board = await db.query(
        `SELECT discord_id, psn_online_id, points, completion, rank, prev_rank
           FROM members
          WHERE rank IS NOT NULL AND last_update_at IS NOT NULL
          ORDER BY rank ASC`,
      );

      // Only whoever actually moved, plus the member who just scanned — a full
      // pass costs one Discord call per member and a tier change is rare.
      //
      // EXCEPT when the board has grown. Tier boundaries are percentages, so
      // one new member can push somebody from Gold to Silver without their rank
      // moving at all. That is invisible to the movements list, so a change in
      // the member count forces a full pass.
      const lastSize = Number(await db.getState('tier_role_board_size', 0)) || 0;
      const fullPass = board.length !== lastSize;
      if (fullPass) await db.setState('tier_role_board_size', board.length);

      await announce('the tier roles', () =>
        syncTierRoles(
          board,
          fullPass
            ? null
            : new Set([member.discord_id, ...movements.map((mv) => mv.discordId)]),
        ),
      );
      await publishLeaderboard(board, {
        get: (k, fallback) => db.getState(k, fallback),
        set: (k, v) => db.setState(k, v),
      });
    });

    const daysLeft = psn.daysUntilReauth();
    if (daysLeft !== null && daysLeft <= 3) {
      await announce('the token expiry warning', () => warnTokenExpiry(daysLeft));
    }

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

    // Tell the member, in Discord, before the job dies. Otherwise their
    // "queued" message sits there forever and the bot just looks broken.
    await postUpdateFailure({ member, updateNo, error: err, interactionToken });

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

  // WHAT THE MEMBER WAS LAST TOLD, not what they are worth right now.
  //
  // These differ, and the difference is the whole economy. The rescore job
  // rewrites members.points every time it runs — that is how local rarity
  // reaches the board — so diffing against the live row silently cancels out
  // every change caused by somebody else. Martin earned eight trophies on a
  // game his brother owns, the rescore correctly took three points off Wilko,
  // and Wilko's next update reported "Points: 0" because by then the loss was
  // already on both sides of the subtraction.
  //
  // Diffing against the last REPORTED figures instead means anything that
  // happened between two updates surfaces on the next one, bucketed by
  // explainDelta() as `drift` — which is exactly what it is.
  //
  // NULL means this member has not been reported to since the column existed,
  // so fall back to the live row. That understates one update for everybody
  // currently on the board and is correct from then on; the alternative is
  // inventing a first-update delta out of history nobody recorded.
  const before = {
    platinum: member.platinum,
    gold: member.gold,
    silver: member.silver,
    bronze: member.bronze,
    completion: member.reported_completion ?? member.completion,
    points: member.reported_points ?? member.points,
    // The rarity sum before the completion multiplier. Older rows predate the
    // column, so fall back to the stored score rather than reading zero and
    // reporting the member's entire library as this session's gain.
    rawPoints: member.reported_raw_points ?? member.raw_points ?? member.points,
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
    'SELECT np_comm_id, earned_total, progress, points, scanned_at, earned_ids ' +
      'FROM member_games WHERE psn_account_id = ?',
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
  const estimateCutoff = Date.now() - ESTIMATE_TTL_MS;
  const estimated = new Set();
  const freshness = new Map();
  // Games whose trophy rows have no names. `earnedForTitle` does not return
  // them — only `titleTrophies` does — and until now nothing called it, so
  // `trophies.name` was never written for anything scanned by this build. See
  // backfillNames().
  const unnamed = new Set();
  // Chunked, because D1 rejects any statement with more than 100 bound
  // parameters and a member with 800 games would otherwise build an IN()
  // clause with 800 of them.
  const CHUNK = D1.chunkSize(1);
  for (let i = 0; i < gameRows.length; i += CHUNK) {
    const slice = gameRows.slice(i, i + CHUNK);
    const cached = await db.query(
      `SELECT g.np_comm_id, g.refreshed_at, g.estimated,
              EXISTS (SELECT 1 FROM trophies t
                       WHERE t.np_comm_id = g.np_comm_id AND t.name IS NOT NULL) AS has_names
         FROM games g
        WHERE g.np_comm_id IN (${placeholders(slice.length)})`,
      slice.map((t) => t.npCommunicationId),
    );
    for (const r of cached) {
      freshness.set(r.np_comm_id, r.refreshed_at);
      if (r.estimated) estimated.add(r.np_comm_id);
      if (!r.has_names) unnamed.add(r.np_comm_id);
    }
  }
  const stale = new Set(
    gameRows
      .filter((t) => {
        const by = estimated.has(t.npCommunicationId) ? estimateCutoff : cutoff;
        return (freshness.get(t.npCommunicationId) ?? 0) < by;
      })
      .map((t) => t.npCommunicationId),
  );

  // ONE call per game, not two. The user-earned endpoint returns every trophy
  // in the title — earned or not — each carrying trophyEarnedRate and
  // trophyRare. So it answers "what did they earn" and "how rare is it" at the
  // same time, and the separate definitions call is redundant.
  //
  // A game needs that call if the member's earned count moved (their progress
  // changed) or the cached rarity has gone stale (the world moved). Everything
  // else is answered from the database for free.
  const changedIds = new Set(needsEarnedScan.map((t) => t.npCommunicationId));
  const changed = gameRows.filter((t) => changedIds.has(t.npCommunicationId));

  // Stale rarity is refreshed on a BUDGET, oldest first.
  //
  // Without this, a member's whole library goes stale on the same day — 14 days
  // after their first scan — and every fortnightly update costs as much as the
  // first one did. Capping it means updates stay in the 2-3 minute range
  // forever, and rarity rolls through the library a slice at a time instead.
  //
  // Popular games are kept fresh for nothing by other members' scans; this
  // budget really only matters for titles a single member owns.
  const staleOnly = gameRows
    .filter((t) => !changedIds.has(t.npCommunicationId) && stale.has(t.npCommunicationId))
    .sort(
      (a, b) =>
        (freshness.get(a.npCommunicationId) ?? 0) - (freshness.get(b.npCommunicationId) ?? 0),
    )
    .slice(0, STALE_REFRESH_BUDGET);

  // Self-heal. A scan that dies partway can leave a game recorded in
  // member_games with no matching rows in `trophies` — progress saved, rarity
  // never written. Those games then score zero forever, because they are
  // neither "changed" nor "stale" and nothing would ever look at them again.
  // Points quietly collapse and no error is raised anywhere.
  const orphans = await db.query(
    `SELECT mg.np_comm_id
       FROM member_games mg
       LEFT JOIN trophies t ON t.np_comm_id = mg.np_comm_id
      WHERE mg.psn_account_id = ? AND mg.earned_total > 0
      GROUP BY mg.np_comm_id
     HAVING COUNT(t.trophy_id) = 0`,
    [accountId],
  );
  const orphanIds = new Set(orphans.map((r) => r.np_comm_id));
  const repairs = gameRows.filter(
    (t) =>
      orphanIds.has(t.npCommunicationId) &&
      !changedIds.has(t.npCommunicationId) &&
      !staleOnly.some((s) => s.npCommunicationId === t.npCommunicationId),
  );
  if (repairs.length) {
    console.log(`  repairing ${repairs.length} games with missing rarity data`);
  }

  const toScan = [...changed, ...staleOnly, ...repairs];
  const deferred = stale.size - changedIds.size - staleOnly.length;

  const estimateMinutes = Math.max(1, Math.ceil(toScan.length / (psn.limiter.max / 15)));
  console.log(
    `${member.psn_online_id}: ${titles.length} games — ${toScan.length} to scan ` +
      `(${changed.length} changed, ${staleOnly.length} stale rarity` +
      (deferred > 0 ? `, ${deferred} deferred to next update` : '') +
      `) — roughly ${estimateMinutes} min`,
  );

  const changelog = [];
  const stats = { unrated: 0, gamesWithUnrated: 0, named: 0 };
  let done = 0;
  // Fetching names costs one extra PSN call per game, so it is capped per scan.
  // Names never change, so a game only ever pays this once and the backlog
  // drains across successive updates rather than blocking any single one.
  let nameBudget = NAME_BACKFILL_PER_SCAN;
  for (const t of toScan) {
    // Only write the shared rarity rows when they're actually absent or stale.
    // The PSN response carries them regardless, but re-writing rows another
    // member already cached burns D1's daily write allowance for nothing — and
    // for a big library that allowance is the binding constraint, not the API.
    const needsRarityWrite =
      !freshness.has(t.npCommunicationId) || stale.has(t.npCommunicationId);
    // A game needs names if it has none stored, or if we have never seen it at
    // all. Only ever true once per game across the whole server.
    const needsNames =
      nameBudget > 0 &&
      (unnamed.has(t.npCommunicationId) || !freshness.has(t.npCommunicationId));
    if (needsNames) nameBudget -= 1;
    const entry = await scanGame(
      psn, accountId, t, prior.get(t.npCommunicationId), needsRarityWrite, stats, needsNames,
    );
    if (entry) changelog.push(entry);
    if (++done % 50 === 0) console.log(`  ${done}/${toScan.length} games`);
  }

  if (stats.named) {
    console.log(`  fetched trophy names for ${stats.named} games`);
  }

  if (stats.unrated) {
    console.log(
      `  ${stats.unrated} unrated trophies (0.00%) across ${stats.gamesWithUnrated} games ` +
        `— scored as 0, see DEFAULT_SCORING.unratedPoints`,
    );
  }

  // Settle local rarity for the games this session actually moved.
  //
  // This is layer two finally reaching people in real time. Earning a trophy
  // makes it commoner here, which makes it worth less to everybody else who
  // holds it — and until now that only happened at 03:00, which is exactly why
  // Martin's Black Flag test showed Wilko losing nothing. Scoped to the changed
  // games so it costs a second rather than the rescore's several minutes; the
  // nightly job still recounts the whole board and remains the authority.
  //
  // Deliberately BEFORE recomputeMemberPoints(), so the member in front of us
  // is priced against the counts their own play just changed.
  await settleLocalRarity(db, changelog.map((c) => c.np_comm_id), { skipAccountId: accountId });

  // Recompute every game's points from stored ids against current rarity.
  // Pure database work — this is where drift shows up.
  const pointsByGame = await recomputeMemberPoints(accountId);

  // Price the new trophies at what they are worth NOW, after the settle. Until
  // this runs every changelog entry says points_gained: 0.
  await priceTheChangelog(changelog);

  const totals = await rollUp(summary, titles, pointsByGame, accountId);
  const pointsEarned = changelog.reduce((n, c) => n + c.points_gained, 0);
  const delta = explainDelta({
    earnedRaw: pointsEarned,
    rawBefore: before.rawPoints,
    rawAfter: totals.rawPoints,
    completionBefore: before.completion,
    completionAfter: totals.completion,
  });

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

  return {
    before,
    after: totals,
    delta,
    changelog,
    gamesChanged: changelog.length,
    repaired: repairs.length,
  };
}

/**
 * Fill in trophy names, details and icons for one game.
 *
 * A second PSN call, and the only place in the codebase that calls
 * `titleTrophies`. It is worth the call because the name is what makes a
 * trophy a thing rather than a row: "Biggest earners left" and the rarest-trophy
 * brag line on /rank are both unreadable without it.
 *
 * Only ever runs for a game with no names stored, so the cost is one call per
 * game across the entire server, forever — not one per member per game.
 *
 * Never throws. A missing name is cosmetic; a scan that dies trying to fetch
 * one is not.
 */
async function backfillNames(psn, title, stats = null) {
  try {
    const defs = await psn.titleTrophies(
      title.npCommunicationId,
      title.trophyTitlePlatform,
    );
    const named = defs.filter((t) => t.trophyName);
    if (!named.length) return;

    // name/detail/icon only. Rarity and points are owned by the earned-trophies
    // path and the rescore job respectively, and must not be touched here.
    const cols = ['np_comm_id', 'trophy_id', 'name', 'detail', 'icon_url'];
    const perChunk = D1.chunkSize(cols.length);
    for (let i = 0; i < named.length; i += perChunk) {
      const slice = named.slice(i, i + perChunk);
      await db.run(
        `INSERT INTO trophies (${cols.join(',')})
         VALUES ${slice.map(() => '(?,?,?,?,?)').join(',')}
         ON CONFLICT(np_comm_id, trophy_id) DO UPDATE SET
           name = excluded.name,
           detail = excluded.detail,
           icon_url = excluded.icon_url`,
        slice.flatMap((t) => [
          title.npCommunicationId,
          t.trophyId,
          t.trophyName ?? null,
          t.trophyDetail ?? null,
          t.trophyIconUrl ?? null,
        ]),
      );
    }
    if (stats) stats.named += 1;
  } catch (err) {
    console.error(`  could not fetch trophy names for ${title.trophyTitleName}:`, err.message);
  }
}

/**
 * Scan one game for one member, in a single PSN call.
 *
 * `getUserTrophiesEarnedForTitle` returns EVERY trophy in the title, whether
 * earned or not, and each one carries trophyEarnedRate and trophyRare. That
 * single response therefore populates three things at once: the shared game
 * record, the shared rarity data, and this member's earned list. The separate
 * getTitleTrophies call this used to make was pure duplication.
 */
async function scanGame(
  psn, accountId, title, was, needsRarityWrite = true, stats = null, needsNames = false,
) {
  let trophies;
  try {
    trophies = await psn.earnedForTitle(
      accountId,
      title.npCommunicationId,
      title.trophyTitlePlatform,
    );
  } catch (err) {
    if (err instanceof PsnPrivateError) return null; // delisted or region-locked
    throw err;
  }
  if (!trophies.length) return null;

  // Visibility on unrated trophies — PSN returns 0.00% for anything it has no
  // rarity figure for, and those score nothing by design. Worth knowing how
  // much of a member's library that covers.
  if (stats) {
    const unrated = trophies.filter((t) => isUnrated(t.trophyEarnedRate)).length;
    if (unrated) {
      stats.unrated += unrated;
      stats.gamesWithUnrated += 1;
    }
  }

  // Scored a whole game at a time, not trophy by trophy, because two of the
  // rules need the rest of the game in view: the floor of 1 for easy trophies
  // in real games, and the estimate for games PSN has no rarity for at all.
  // See scoreGameTrophies().
  const rated = scoreGameTrophies(
    trophies.map((t) => ({
      id: t.trophyId,
      type: t.trophyType ?? null,
      hidden: t.trophyHidden ? 1 : 0,
      rate: t.trophyEarnedRate != null ? Number(t.trophyEarnedRate) : null,
      earned: Boolean(t.earned),
      // PSN sends the date with every earned trophy and we used to discard it.
      // It costs nothing to keep — same response, same call — and it cannot be
      // recovered later without rescanning everybody. See
      // migrations/006-trophy-timestamps.sql for what it is eventually for.
      earnedAt: t.earned && t.earnedDateTime ? Date.parse(t.earnedDateTime) : null,
    })),
  );

  // -- shared game record + rarity ------------------------------------------
  // Skipped entirely when another member already cached this game recently.
  // The PSN response carries the rarity either way, but re-writing rows that
  // haven't changed burns D1's 100,000-writes-a-day allowance for nothing —
  // and on a large library that allowance binds long before the API does.
  if (needsRarityWrite) {
    // ON CONFLICT, not INSERT OR REPLACE. REPLACE deletes the row and writes a
    // new one, which would silently reset `local_started` to its default every
    // time a game's rarity was refreshed — quietly destroying the local rarity
    // data on the most-played games first.
    await db.run(
      `INSERT INTO games
         (np_comm_id, np_service_name, title, platform, icon_url,
          trophy_count, has_platinum, max_points, estimated, completion_weight,
          refreshed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(np_comm_id) DO UPDATE SET
         np_service_name = excluded.np_service_name,
         title = excluded.title,
         platform = excluded.platform,
         icon_url = excluded.icon_url,
         trophy_count = excluded.trophy_count,
         has_platinum = excluded.has_platinum,
         max_points = excluded.max_points,
         estimated = excluded.estimated,
         completion_weight = excluded.completion_weight,
         refreshed_at = excluded.refreshed_at`,
      [
        title.npCommunicationId,
        title.npServiceName ?? null,
        title.trophyTitleName,
        title.trophyTitlePlatform ?? null,
        title.trophyTitleIconUrl ?? null,
        rated.length,
        rated.some((t) => t.type === 'platinum') ? 1 : 0,
        rated.reduce((n, t) => n + t.points, 0),
        // Flagged so the next scan re-checks it in days rather than a month.
        rated.some((t) => t.estimated) ? 1 : 0,
        // What this game contributes to a member's completion denominator.
        // Stored here so the rescore job can recompute completion from the
        // database — before this, only a full rescan could move the number.
        rated.reduce((n, t) => n + completionWeight({ [t.type]: 1 }), 0),
        Date.now(),
      ],
    );

    // ON CONFLICT rather than INSERT OR REPLACE, because this endpoint doesn't
    // return trophy names — replacing would wipe the ones backfillNames() has
    // filled in.
    const cols = ['np_comm_id', 'trophy_id', 'type', 'hidden', 'earned_rate', 'points'];
    const perChunk = D1.chunkSize(cols.length);
    for (let i = 0; i < rated.length; i += perChunk) {
      const slice = rated.slice(i, i + perChunk);
      await db.run(
        `INSERT INTO trophies (${cols.join(',')})
         VALUES ${slice.map(() => '(?,?,?,?,?,?)').join(',')}
         ON CONFLICT(np_comm_id, trophy_id) DO UPDATE SET
           type = excluded.type,
           hidden = excluded.hidden,
           earned_rate = excluded.earned_rate`,
      // NOTE: `points` is deliberately NOT updated on conflict, and neither is
      // local_earned. Once local rarity is live, a trophy's value depends on
      // what the whole server has earned, so it belongs to the rescore job
      // which sees every member at once. A scan writing a global-only figure
      // here would undo the blend for whichever games that member happened to
      // touch — and two members would disagree about what one trophy is worth
      // depending on who scanned last. New rows still get a sensible global
      // value on insert, which is exactly right: a game nobody here owns has no
      // local evidence yet.
        slice.flatMap((t) => [
          title.npCommunicationId, t.id, t.type, t.hidden, t.rate, t.points,
        ]),
      );
    }
  }

  if (needsNames) await backfillNames(psn, title, stats);

  // -- this member's progress ----------------------------------------------
  const mine = rated.filter((t) => t.earned);
  const earnedIds = mine.map((t) => t.id);
  const counts = { platinum: 0, gold: 0, silver: 0, bronze: 0 };
  for (const t of mine) if (counts[t.type] !== undefined) counts[t.type]++;
  const progress = title.progress ?? 0;
  const points = mine.reduce((n, t) => n + t.points, 0);

  // The span between their first and last trophy in this game. NULL when
  // unknown — a row scanned before this existed, or a game with no dated
  // trophies — which must never be confused with "finished in no time".
  const stamps = mine.map((t) => t.earnedAt).filter((n) => Number.isFinite(n));
  const firstEarned = stamps.length ? Math.min(...stamps) : null;
  const lastEarned = stamps.length ? Math.max(...stamps) : null;

  await db.run(
    `INSERT OR REPLACE INTO member_games
       (psn_account_id, np_comm_id, progress, earned_total,
        earned_platinum, earned_gold, earned_silver, earned_bronze,
        earned_ids, points, last_played_at, first_earned_at, last_earned_at,
        scanned_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      accountId, title.npCommunicationId, progress, earnedIds.length,
      counts.platinum, counts.gold, counts.silver, counts.bronze,
      JSON.stringify(earnedIds), points,
      title.lastUpdatedDateTime ? Date.parse(title.lastUpdatedDateTime) : null,
      firstEarned, lastEarned,
      Date.now(),
    ],
  );

  const gained = earnedIds.length - (was?.earned_total ?? 0);
  if (was && gained === 0 && was.progress === progress) return null; // rarity-only refresh

  // WHICH trophies are new, not how many points they were worth a moment ago.
  //
  // This used to return `Math.max(0, points - was.points)` and that comparison
  // was between two different currencies. `points` is computed here with local
  // rarity switched OFF (scanGame passes local = null on purpose, because a
  // scan cannot see the whole server), while `was.points` was written by the
  // rescore WITH the multiplier applied. On any game the server is stuck on,
  // the new unboosted figure is smaller than the old boosted one, the
  // subtraction goes negative, Math.max clamps it to zero — and the member is
  // told they earned nothing.
  //
  // That is exactly what happened to JFL__Leon: a bronze on Sea of Thieves, a
  // game with a live multiplier, reported as "you earned nothing this session"
  // while 1,587 points arrived as drift.
  //
  // So the ids travel instead, and settleUp() prices them once the settle job
  // has written the final numbers. The trophies are the fact; the price is
  // whatever it is by the time everything has run.
  const before = new Set(safeJson(was?.earned_ids, []));
  return {
    np_comm_id: title.npCommunicationId,
    title: title.trophyTitleName,
    kind: !was ? 'new' : progress === 100 && was.progress !== 100 ? 'completed' : 'progress',
    trophies_gained: gained,
    new_trophy_ids: earnedIds.filter((id) => !before.has(id)),
    points_gained: 0, // priced later, see priceTheChangelog()
    progress_from: was?.progress ?? 0,
    progress_to: progress,
  };
}

/**
 * What the trophies earned this session are actually worth.
 *
 * Runs AFTER settleLocalRarity(), which is the whole point. By then
 * trophies.points holds the final blended value for every game that moved, so
 * summing the new ids gives a figure that matches the member's score instead of
 * a snapshot taken half way through the job.
 *
 * Anything the new trophies do not explain stays in `drift`, which is correct:
 * the rest of the movement really is other people playing.
 */
async function priceTheChangelog(changelog) {
  const games = changelog.filter((c) => c.new_trophy_ids?.length);
  if (!games.length) return;

  // Paged at 80 for D1's 100-parameter ceiling. A repeat update touches a
  // handful of games; a first scan can touch thousands, and a card that fails
  // to render because one statement was too wide is a silent loss.
  const priceOf = new Map();
  const ids = games.map((c) => c.np_comm_id);
  for (let i = 0; i < ids.length; i += 80) {
    const slice = ids.slice(i, i + 80);
    const rows = await db.query(
      `SELECT np_comm_id, trophy_id, points FROM trophies
        WHERE np_comm_id IN (${slice.map(() => '?').join(',')})`,
      slice,
    );
    for (const r of rows) priceOf.set(`${r.np_comm_id} ${r.trophy_id}`, r.points ?? 0);
  }

  for (const c of changelog) {
    let total = 0;
    for (const id of c.new_trophy_ids ?? []) {
      total += priceOf.get(`${c.np_comm_id} ${id}`) ?? 0;
    }
    c.points_gained = total;
  }
}

/**
 * Recompute this member's points for every game from stored earned ids against
 * the current cached rarity. No PSN calls — this is a join.
 */
async function recomputeMemberPoints(accountId) {
  const rows = await db.query(
    `SELECT mg.np_comm_id, mg.earned_ids, mg.points AS was_points,
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
    updates.push([points, accountId, row.np_comm_id, row.was_points ?? null]);
  }

  // Only write rows whose value actually moved. On a repeat update almost
  // nothing has, so this turns hundreds of writes into a handful.
  let written = 0;
  for (const [points, acct, game, was] of updates) {
    if (points === was) continue;
    await db.run(
      'UPDATE member_games SET points = ? WHERE psn_account_id = ? AND np_comm_id = ?',
      [points, acct, game],
    );
    written++;
  }
  if (written) console.log(`  ${written}/${updates.length} game scores changed`);
  return byGame;
}

/**
 * The rarest trophy this member actually owns.
 *
 * One query, run once per scan and cached on the members row, because doing
 * it per card render would mean this join four times for a single
 * /leaderboard page.
 *
 * Unrated trophies (0.00%) are excluded deliberately — PSN reports 0 for
 * anything it has no figure for, and "0.00%" would win this contest every
 * time while meaning nothing. See DEFAULT_SCORING.unratedPoints.
 */
async function findRarestTrophy(accountId) {
  try {
    const row = await db.one(
      `SELECT t.name, t.earned_rate, g.title
         FROM member_games mg
         JOIN trophies t ON t.np_comm_id = mg.np_comm_id
         LEFT JOIN games g ON g.np_comm_id = mg.np_comm_id
        WHERE mg.psn_account_id = ?
          AND t.earned_rate > 0
          AND EXISTS (
                SELECT 1 FROM json_each(mg.earned_ids) je
                 WHERE je.value = t.trophy_id
              )
        ORDER BY t.earned_rate ASC
        LIMIT 1`,
      [accountId],
    );
    return row ?? null;
  } catch (err) {
    // A missing rarest trophy is a cosmetic loss, not a failed scan.
    console.error('Could not resolve rarest trophy', err);
    return null;
  }
}

// ------------------------------------------------------------- rollups -----

async function rollUp(summary, titles, pointsByGame, accountId) {
  const earned = summary?.earnedTrophies ?? {};
  const completed = titles.filter((t) => (t.progress ?? 0) === 100).length;

  // Completion now comes from the database rather than from PSN's title list,
  // because worthless games have to be excluded and only the database knows
  // which those are. Same weights as before — Sony's values with the PLATINUM
  // EXCLUDED, see completionWeight() — just filtered. One definition, shared
  // with the rescore job, in lib/completion.mjs.
  const { completion } = await memberCompletion(db, accountId);

  let rawPoints = 0;
  for (const p of pointsByGame.values()) rawPoints += p;

  // memberCompletion() already floors to two places.
  const completionPct = completion;

  return {
    platinum: earned.platinum ?? 0,
    gold: earned.gold ?? 0,
    silver: earned.silver ?? 0,
    bronze: earned.bronze ?? 0,
    completion: completionPct,
    // Two numbers, deliberately. `rawPoints` is what the trophies are worth;
    // `points` is what this member actually banks at their current completion.
    // Storing both is what lets an update say "+14,203 because your completion
    // went from 49.00% to 52.10%" instead of showing an unexplained jump on
    // games nobody touched.
    rawPoints,
    points: applyCompletion(rawPoints, completionPct),
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
       points_earned = ?, points_backlog = ?, points_drift = ?, games_changed = ?,
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
      delta.backlog,
      delta.drift,
      result.gamesChanged,
      result.durationSeconds,
      updateNo,
    ],
  );

  const rarest = await findRarestTrophy(member.psn_account_id);

  await db.run(
    `UPDATE members SET
       platinum = ?, gold = ?, silver = ?, bronze = ?,
       completion = ?, points = ?, raw_points = ?, projects = ?, completed = ?,
       reported_points = ?, reported_raw_points = ?, reported_completion = ?,
       rarest_name = ?, rarest_rate = ?, rarest_game = ?,
       last_update_at = ?, last_scan_ok = 1
     WHERE discord_id = ?`,
    [
      after.platinum, after.gold, after.silver, after.bronze,
      after.completion, after.points, after.rawPoints, after.projects, after.completed,
      // The same three numbers again, under different names. `points` is what
      // this member is worth and the rescore will overwrite it freely; these
      // are what the card in front of them says, and only an update may change
      // them. The gap between the two pairs is what the next update reports as
      // drift — see migrations/009-reported-snapshot.sql.
      after.points, after.rawPoints, after.completion,
      rarest?.name ?? null, rarest?.earned_rate ?? null, rarest?.title ?? null,
      Date.now(), member.discord_id,
    ],
  );

  if (rarest) {
    console.log(`  rarest owned: ${rarest.name} (${rarest.earned_rate}%) — ${rarest.title ?? '?'}`);
  }
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
          discordId: rows[i].discord_id,
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
