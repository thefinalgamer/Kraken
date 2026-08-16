/**
 * The fortnightly safety net.
 *
 * The original bot ran a full refresh every two weeks if nobody triggered an
 * update, so inactive members' cards didn't go stale and the board didn't drift
 * into fiction. Kept exactly.
 *
 * Members are refreshed oldest-first and the job stops well before GitHub's
 * six-hour ceiling, so a large server simply picks up where it left off on the
 * next run rather than failing halfway.
 */

import { spawn } from 'node:child_process';
import { D1 } from './lib/d1.mjs';

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
    ORDER BY COALESCE(last_update_at, 0) ASC`,
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
