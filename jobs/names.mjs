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

// Stop well before GitHub's six-hour ceiling. A job killed by the runner is a
// job whose last few writes are anyone's guess; a job that stops itself is not.
const BUDGET_MS = Number(env.NAMES_BUDGET_MINUTES || 300) * 60 * 1000;

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
        game.np_comm_id,
        t.trophyId,
        t.trophyName ?? null,
        t.trophyDetail ?? null,
        t.trophyIconUrl ?? null,
      ]),
    );
  }
  return named.length;
}

// ------------------------------------------------------------------ run ----

const remaining = await db.one(
  `SELECT COUNT(*) AS c FROM games g
    WHERE NOT EXISTS (
      SELECT 1 FROM trophies t WHERE t.np_comm_id = g.np_comm_id AND t.name IS NOT NULL)
      AND EXISTS (SELECT 1 FROM trophies t WHERE t.np_comm_id = g.np_comm_id)`,
);
console.log(`${remaining?.c ?? '?'} games still have no trophy names.`);
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

const mins = Math.round((Date.now() - started) / 60000);
console.log(
  `\nNamed ${done} games (${trophies} trophies) in ${mins} minutes. ` +
    `${failed} failed, ${empty} have no names published by PSN.`,
);

const left = await db.one(
  `SELECT COUNT(*) AS c FROM games g
    WHERE NOT EXISTS (
      SELECT 1 FROM trophies t WHERE t.np_comm_id = g.np_comm_id AND t.name IS NOT NULL)
      AND EXISTS (SELECT 1 FROM trophies t WHERE t.np_comm_id = g.np_comm_id)`,
);
console.log(`${left?.c ?? '?'} games still to go.`);
