/**
 * Fill in trophy names, descriptions and icons for games that have none.
 *
 * WHY THIS EXISTS. The scan backfills names as it goes, capped at 60 games per
 * run, and only for games it happened to be scanning anyway. That was the right
 * call for the bot: names cost one extra PSN call each, they never change, and
 * nothing in Discord needs them urgently.
 *
 * Then we counted. 25,608 of 25,928 games have no names at all. 98.8%. At the
 * scan's pace the gap would not close this year, because a repeat update only
 * touches games whose trophy count moved, and those are already named.
 *
 * A trophy list is the whole point of a game page on the website. "Trophy #14"
 * is not a trophy list. So this walks the backlog directly.
 *
 * ORDERED BY HOW MANY MEMBERS OWN THE GAME. Sea of Thieves before a visual
 * novel one person bought in a sale. That is what makes the job useful after
 * the first run rather than the fifth: the pages people will actually open work
 * straight away, and the long tail fills in behind them.
 *
 * RESUMABLE BY CONSTRUCTION. It selects games that have no named trophy, so a
 * game it has finished is a game it will never pick again. Kill it, re-run it,
 * run it four times in a row — it always continues rather than restarting.
 * Nothing needs to remember where it got to.
 *
 * SAFE TO RUN ALONGSIDE ANYTHING. It writes only name, detail and icon_url.
 * Rarity belongs to the scan and points belong to the rescore, and neither
 * column is touched here. The worst a collision can do is waste a PSN call.
 *
 *   Actions -> Admin -> Run workflow -> task: backfill-names
 */

import { D1 } from './lib/d1.mjs';
import { PsnClient } from './lib/psn.mjs';

const env = process.env;

// Stop before the RUNNER does. admin.yml sets timeout-minutes: 120, so a
// 300-minute budget never fires and GitHub kills the job instead, which shows
// as a red failed run for work that actually succeeded. 110 leaves ten minutes
// of headroom and lets the job finish on its own terms with a proper summary.
//
// Nothing is lost either way — every game is written as it is named, and the
// next run picks up exactly where this one stopped — but a green tick that
// means "done for now" is worth more than a red cross that means the same.
const BUDGET_MS = Number(env.NAMES_BUDGET_MINUTES || 110) * 60 * 1000;

// How many games to claim at a time. Small enough that the ordering stays
// meaningful as counts change under us, large enough not to spend the run
// asking D1 for more work.
const PAGE = 200;

const db = new D1({
  accountId: env.CF_ACCOUNT_ID,
  databaseId: env.CF_D1_DATABASE_ID,
  apiToken: env.CF_API_TOKEN,
});

const started = Date.now();

async function connect() {
  const stored = await db.getState('psn_tokens');
  const psn = new PsnClient({
    npsso: env.PSN_NPSSO || undefined,
    refreshToken: stored?.refreshToken,
    onTokens: (state) => db.setState('psn_tokens', state),
  });
  await psn.authenticate();
  return psn;
}

/**
 * Games with no named trophy, most-owned first.
 *
 * NOT EXISTS rather than a LEFT JOIN with a NULL check: a game whose trophies
 * are half named is already served by whatever named the other half, and
 * fetching it again would spend a PSN call to write the same rows.
 */
const NEXT_GAMES = `
  SELECT g.np_comm_id, g.title, g.platform, g.local_started, g.trophy_count
    FROM games g
   WHERE NOT EXISTS (
           SELECT 1 FROM trophies t
            WHERE t.np_comm_id = g.np_comm_id AND t.name IS NOT NULL
         )
     AND EXISTS (SELECT 1 FROM trophies t WHERE t.np_comm_id = g.np_comm_id)
   ORDER BY g.local_started DESC, g.trophy_count DESC, g.np_comm_id ASC
   LIMIT ?`;

/** One game's names, written straight in. Mirrors backfillNames() in scan.mjs. */
async function nameGame(psn, game) {
  const defs = await psn.titleTrophies(game.np_comm_id, game.platform);
  const named = defs.filter((t) => t.trophyName);
  if (!named.length) return 0;

  // group_id rides along on the SAME call. It was being thrown away, which is
  // why Minecraft arrived as 136 trophies in one heap while the console shows a
  // base game and eight expansion packs. See migrations/012.
  const cols = ['np_comm_id', 'trophy_id', 'name', 'detail', 'icon_url', 'group_id'];
  const perChunk = D1.chunkSize(cols.length);
  for (let i = 0; i < named.length; i += perChunk) {
    const slice = named.slice(i, i + perChunk);
    await db.run(
      `INSERT INTO trophies (${cols.join(',')})
       VALUES ${slice.map(() => '(?,?,?,?,?,?)').join(',')}
       ON CONFLICT(np_comm_id, trophy_id) DO UPDATE SET
         name = excluded.name,
         detail = excluded.detail,
         icon_url = excluded.icon_url,
         group_id = excluded.group_id`,
      slice.flatMap((t) => [
        game.np_comm_id,
        t.trophyId,
        t.trophyName ?? null,
        t.trophyDetail ?? null,
        t.trophyIconUrl ?? null,
        t.trophyGroupId ?? 'default',
      ]),
    );
  }
  return named.length;
}

// ------------------------------------------------------------------ run ----

/**
 * Games whose trophies span more than one group, and whose packs are not named.
 *
 * THE SPLIT IS FREE; THE NAMES ARE NOT. `trophyGroupId` arrives on the same
 * call that fetches names and rarity, so knowing that Minecraft has nine groups
 * costs nothing. Knowing that group "004" is called "Expansion Pack 4" is a
 * second endpoint, one call per game.
 *
 * So this runs ONLY for games that actually have packs — a few dozen of the
 * five hundred here rather than all of them — and only once each, because a
 * pack name never changes. The base game is skipped: every game has a "default"
 * group and the page calls it "Base game" without asking anybody.
 */
const NEXT_GROUPS = `
  SELECT g.np_comm_id, g.title, g.platform,
         COUNT(DISTINCT t.group_id) AS groups
    FROM games g
    JOIN trophies t ON t.np_comm_id = g.np_comm_id
   WHERE t.group_id IS NOT NULL
     AND NOT EXISTS (
           SELECT 1 FROM trophy_groups tg WHERE tg.np_comm_id = g.np_comm_id)
   GROUP BY g.np_comm_id
  HAVING COUNT(DISTINCT t.group_id) > 1
   ORDER BY g.local_started DESC, g.np_comm_id ASC
   LIMIT ?`;

/** One game's pack names, written straight in. */
async function nameGroups(psn, game) {
  const groups = await psn.titleTrophyGroups(game.np_comm_id, game.platform);
  if (!groups.length) return 0;

  const cols = ['np_comm_id', 'group_id', 'name', 'icon_url', 'fetched_at'];
  const perChunk = D1.chunkSize(cols.length);
  const now = Date.now();
  for (let i = 0; i < groups.length; i += perChunk) {
    const slice = groups.slice(i, i + perChunk);
    await db.run(
      `INSERT INTO trophy_groups (${cols.join(',')})
       VALUES ${slice.map(() => '(?,?,?,?,?)').join(',')}
       ON CONFLICT(np_comm_id, group_id) DO UPDATE SET
         name = excluded.name,
         icon_url = excluded.icon_url,
         fetched_at = excluded.fetched_at`,
      slice.flatMap((gr) => [
        game.np_comm_id,
        gr.trophyGroupId ?? 'default',
        gr.trophyGroupName ?? null,
        gr.trophyGroupIconUrl ?? null,
        now,
      ]),
    );
  }
  return groups.length;
}

/**
 * How much is left, split two ways.
 *
 * `total` is every game in the database. `owned` is the ones somebody here
 * actually has, and it is the only one that matters: the website only ever
 * shows a game page for a game one of us owns, so once `owned` reaches zero the
 * job is finished for every practical purpose. The remaining thousands are
 * games nobody has touched, sitting in the table because one member owns a
 * bundle or a delisted edition, and naming them changes nothing anybody sees.
 *
 * Written as one query with two conditional sums rather than two queries,
 * because D1 bills on rows read and this scans the same rows either way.
 */
const PROGRESS = `
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN g.local_started > 0 THEN 1 ELSE 0 END) AS owned
    FROM games g
   WHERE NOT EXISTS (
           SELECT 1 FROM trophies t
            WHERE t.np_comm_id = g.np_comm_id AND t.name IS NOT NULL)
     AND EXISTS (SELECT 1 FROM trophies t WHERE t.np_comm_id = g.np_comm_id)`;

const report = (row, label) => {
  const total = Number(row?.total ?? 0);
  const owned = Number(row?.owned ?? 0);
  if (!total) {
    console.log(`${label}: nothing left. Every game with trophies has names.`);
    return;
  }
  console.log(
    `${label}: ${total.toLocaleString('en-GB')} games still unnamed, ` +
      `${owned.toLocaleString('en-GB')} of them owned by somebody here.`,
  );
  if (!owned) {
    console.log('  Every game anybody here owns is named. The rest is long tail —');
    console.log('  nothing on the website is waiting on it.');
  }
};

const remaining = await db.one(PROGRESS);
report(remaining, 'Before');
console.log(`Budget ${Math.round(BUDGET_MS / 60000)} minutes, ${env.PSN_RATE_LIMIT || 600} PSN calls per 15 min.\n`);

const psn = await connect();

let done = 0;
let trophies = 0;
let failed = 0;
let empty = 0;
let out = false;

while (!out) {
  const games = await db.query(NEXT_GAMES, [PAGE]);
  if (!games.length) {
    console.log('\nNothing left. Every game with trophies has names.');
    break;
  }

  for (const game of games) {
    if (Date.now() - started > BUDGET_MS) {
      console.log('\nTime budget reached. Run it again to carry on.');
      out = true;
      break;
    }

    try {
      const n = await nameGame(psn, game);
      if (n === 0) {
        // PSN has the game but publishes no names for it. Rare, and permanent —
        // it will be selected again on the next run and skipped again. Cheap
        // enough not to need a marker column.
        empty++;
      } else {
        done++;
        trophies += n;
      }
    } catch (err) {
      failed++;
      console.error(`  x ${game.title}: ${err.message}`);
    }

    if ((done + failed + empty) % 50 === 0) {
      const mins = Math.round((Date.now() - started) / 60000);
      const rate = done / Math.max(1, (Date.now() - started) / 60000);
      console.log(
        `  ${done} named (${trophies} trophies) · ${failed} failed · ${empty} unpublished · ` +
          `${mins} min · ~${Math.round(rate)}/min`,
      );
    }
  }
}

/**
 * Second pass: what the DLC packs are called.
 *
 * AFTER the names, deliberately. Trophy names are what a game page cannot be
 * built without; pack headings are what makes it match the console. If the
 * budget runs out here, the site still works and the next run picks these up —
 * the query selects games with no rows in trophy_groups, so it is resumable by
 * construction exactly like the pass above.
 */
let packs = 0;
let packGames = 0;
while (Date.now() - started <= BUDGET_MS) {
  const games = await db.query(NEXT_GROUPS, [PAGE]);
  if (!games.length) break;

  for (const game of games) {
    if (Date.now() - started > BUDGET_MS) break;
    try {
      const n = await nameGroups(psn, game);
      if (n) {
        packGames++;
        packs += n;
      } else {
        // The endpoint is missing from this version of psn-api, so no game will
        // ever return groups and the loop would spin through every one of them
        // spending a PSN call each. Stop at the first empty answer.
        console.log('  PSN trophy groups unavailable — packs will show as "Pack 1".');
        packGames = -1;
        break;
      }
    } catch (err) {
      console.error(`  x groups for ${game.title}: ${err.message}`);
    }
  }
  if (packGames < 0) break;
}
if (packGames > 0) {
  console.log(`\nNamed ${packs} DLC packs across ${packGames} games.`);
}

const mins = Math.round((Date.now() - started) / 60000);
console.log(
  `\nNamed ${done} games (${trophies} trophies) in ${mins} minutes. ` +
    `${failed} failed, ${empty} have no names published by PSN.`,
);

const left = await db.one(PROGRESS);
report(left, 'After');

// How many more runs. Measured from THIS run's actual rate rather than a
// guess, so it gets more honest the longer the job goes on, and it counts
// only owned games because those are the ones that gate anything.
const ownedLeft = Number(left?.owned ?? 0);
if (ownedLeft > 0 && done > 0) {
  const perRun = Math.max(1, Math.round((done / Math.max(1, mins)) * (BUDGET_MS / 60000)));
  console.log(
    `\nAt this run's pace (~${perRun.toLocaleString('en-GB')} games per full run), ` +
      `roughly ${Math.ceil(ownedLeft / perRun)} more run${Math.ceil(ownedLeft / perRun) === 1 ? '' : 's'} ` +
      'to finish the games people own.',
  );
}
