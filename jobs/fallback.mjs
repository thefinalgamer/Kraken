/**
 * The weekly safety net.
 *
 * The original bot ran a full refresh every two weeks if nobody triggered an
 * update, so inactive members' cards didn't go stale and the board didn't drift
 * into fiction. Kept, but weekly rather than fortnightly: with the server
 * growing past twenty, smaller and more frequent bites finish the whole list
 * instead of rolling half of it over every time.
 *
 * FAIRNESS. Members are taken oldest-first, and `last_attempt_at` is stamped
 * BEFORE each scan starts rather than after it succeeds. That matters: if the
 * job is killed partway through somebody — GitHub's ceiling, a hung PSN call —
 * an "update on success" design leaves them still the oldest, so they consume
 * the budget again on the next run and everybody behind them starves forever,
 * silently. Being TRIED is enough to lose your turn.
 *
 * The job stops well before GitHub's six-hour ceiling, so a large server simply
 * picks up where it left off next time.
 */

import { spawn } from 'node:child_process';
import { D1 } from './lib/d1.mjs';
import { buildWeeklyDigest } from './lib/digest.mjs';
import { postWeeklyDigest } from './lib/discord.mjs';

const env = process.env;
const BUDGET_MS = 5 * 60 * 60 * 1000; // stop after five hours

const db = new D1({
  accountId: env.CF_ACCOUNT_ID,
  databaseId: env.CF_D1_DATABASE_ID,
  apiToken: env.CF_API_TOKEN,
});

const started = Date.now();

const members = await db.query(
  `SELECT discord_id, psn_online_id, last_update_at
     FROM members
    WHERE last_scan_ok = 1
    ORDER BY COALESCE(last_attempt_at, last_update_at, 0) ASC`,
);

console.log(`Fortnightly refresh: ${members.length} members, oldest first.`);

let done = 0;
let failed = 0;

for (const member of members) {
  if (Date.now() - started > BUDGET_MS) {
    console.log(`Time budget reached after ${done}. The rest roll into the next run.`);
    break;
  }

  try {
    // Stamped first, on purpose. See the fairness note at the top of the file.
    await db.run('UPDATE members SET last_attempt_at = ? WHERE discord_id = ?', [
      Date.now(),
      member.discord_id,
    ]);
    await runScan(member.discord_id);
    done++;
    console.log(`  [${done}/${members.length}] ${member.psn_online_id}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${member.psn_online_id}: ${err.message}`);
    // A private profile or a delisted game shouldn't stop the whole sweep.
  }
}

console.log(`Refreshed ${done}, failed ${failed}, in ${Math.round((Date.now() - started) / 60000)} minutes.`);

// The week, in one card. This is the only moment it can honestly be written:
// the sweep has just been round everybody, so "earned this week" covers the
// whole server rather than the handful who ran /update.
//
// Best-effort, and last on purpose. The refresh is the job that matters and it
// has already succeeded by the time we get here; a Discord problem must not
// turn a completed five-hour sweep red.
try {
  const blocks = await buildWeeklyDigest(db);
  if (blocks) {
    await postWeeklyDigest(blocks);
    console.log('Weekly digest posted.');
  } else {
    console.log('Nothing happened this week — no digest posted.');
  }
} catch (err) {
  console.error('Could not post the weekly digest (the refresh itself was fine):', err.message);
}

/**
 * Each member is scanned in its own process so one bad profile can't take the
 * sweep down, and so memory doesn't creep across hundreds of scans.
 */
function runScan(discordId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['jobs/scan.mjs'], {
      env: { ...env, TARGET_DISCORD_ID: discordId, INTERACTION_TOKEN: '' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.on('error', reject);
  });
}
