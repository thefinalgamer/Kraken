/**
 * Deciding that a goal has been hit, or has run out of time.
 *
 * Run at the end of every scan (for the member just scanned) and every rescore
 * (for everybody), because those are the two things that move the numbers a
 * goal reads. Nothing else needs to: a goal's CURRENT value is never stored,
 * the page reads it live off the members row. This only records the moment it
 * finished, freezes the number it finished on, and says who to congratulate.
 *
 * SAFE ON A DATABASE WITHOUT MIGRATION 037. A missing table means no goals, not
 * a failed scan. Anything else is rethrown, the same seatbelt every column
 * added since 019 carries.
 */
import { goalSettlement } from '../../shared/goals.mjs';

const OPEN_SQL = (scoped) => `
  SELECT g.id, g.psn_account_id, g.kind, g.target, g.start_value, g.created_at,
         g.deadline_at, g.reached_at, g.ended_at,
         m.psn_online_id, m.discord_id, m.points, m.completion,
         m.platinum, m.gold, m.silver, m.bronze, m.completed
    FROM goals g
    JOIN members m ON m.psn_account_id = g.psn_account_id
   WHERE g.reached_at IS NULL AND g.ended_at IS NULL${scoped ? ' AND g.psn_account_id = ?' : ''}`;

const REACHED_SQL =
  'UPDATE goals SET reached_at = ?, final_value = ? WHERE id = ? AND reached_at IS NULL AND ended_at IS NULL';
const ENDED_SQL =
  'UPDATE goals SET ended_at = ?, final_value = ? WHERE id = ? AND reached_at IS NULL AND ended_at IS NULL';

const isMissingTable = (err) => /no such table: goals/i.test(String(err?.message ?? err ?? ''));

/**
 * Settle open goals. Returns the ones just REACHED, each with the member's
 * name, for the caller to announce. Missed goals are frozen quietly: nobody
 * wants their miss posted to the server.
 *
 * `accountId` narrows it to one member, which is what a scan wants.
 */
export async function settleGoals(db, { accountId = null, now = Date.now() } = {}) {
  let open;
  try {
    open = await db.query(OPEN_SQL(!!accountId), accountId ? [accountId] : []);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }

  const reached = [];
  for (const row of open) {
    const s = goalSettlement(row, row, now);
    if (!s) continue;
    await db.run(s.reached ? REACHED_SQL : ENDED_SQL, [s.at, s.value, row.id]);
    if (s.reached) reached.push({ ...row, reached_at: s.at, final_value: s.value });
  }
  return reached;
}
