/**
 * What the server is collectively stuck on.
 *
 * ONE definition, used by two very different callers: the Worker answers
 * `/contested` through its D1 binding, and the rescore job publishes the
 * standing board through the REST API. They must never disagree about what
 * "contested" means, so the query lives here and each side only supplies its
 * own driver.
 *
 * WHY THE PLATINUM. Local rarity is per trophy — a game has no single
 * multiplier, it has forty. But "we are all stuck on this" is a statement about
 * the platinum specifically: people who own the game and have not finished it.
 * So the board ranks on the plat's own figure, which is a number the scoring
 * genuinely uses, rather than an average invented to have something to print.
 *
 * WHAT IS EXCLUDED, and why each one matters:
 *
 *   no platinum       nothing to be stuck on; a trophy list with no summit
 *   max_points = 0    shovelware. Three people owning an unplatted Arcade
 *                     Archives title is not a contest, and without this the
 *                     board would be nothing else — there are thousands of them
 *                     and almost nobody bothers finishing them
 *   fewer than 3 owners
 *                     two owners and no finisher prices at the cap, which is
 *                     true but says nothing about the server. A contest needs
 *                     a crowd
 *   everybody platted it
 *                     settled, back to ×1, off the board
 */

import { localMultiplier } from './scoring.mjs';

/** A contest needs a crowd. Below this it is one person's backlog. */
export const CONTESTED_MIN_OWNERS = 3;

/** Martin: "i would say 10 games and not 5". */
export const CONTESTED_LIMIT = 10;

/**
 * Ordered by the plat's local ratio.
 *
 * The ORDER BY deliberately omits the exponent and the cap that
 * localMultiplier() applies. Both are monotonic, so they cannot change the
 * ordering — and leaving them out keeps this to arithmetic SQLite does without
 * complaint. The real multiplier is computed in rankContested() below, from the
 * same function the scoring uses, so the number on the card is never a
 * reimplementation of the number in the database.
 *
 * Two bound parameters: minimum owners, then row limit.
 */
export const CONTESTED_SQL = `
  SELECT g.np_comm_id,
         g.title,
         g.platform,
         g.trophy_count,
         g.max_points,
         g.local_started,
         g.unobtainable,
         g.unobtainable_note,
         t.local_earned AS platted_here
    FROM games g
    JOIN trophies t
      ON t.np_comm_id = g.np_comm_id AND t.type = 'platinum'
   WHERE g.local_started >= ?
     AND t.local_earned < g.local_started
     AND g.max_points > 0
   ORDER BY (g.local_started + 0.5) / (t.local_earned + 0.5) DESC,
            g.local_started DESC,
            g.max_points DESC
   LIMIT ?`;

/** Attach the multiplier the scoring actually applies. */
export function rankContested(rows = []) {
  return rows.map((r) => ({
    ...r,
    multiplier: localMultiplier(r.platted_here ?? 0, r.local_started ?? 0),
  }));
}
