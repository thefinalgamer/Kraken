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
 * WHAT JUMPS THE QUEUE: a game with an announced closing date sorts above
 * everything else, soonest first. Contest is about how stuck we are; a deadline
 * is about how long we have, and a deadline beats a difficulty ranking every
 * time. A game with three weeks left is the most useful row this board can
 * show, and burying it under a permanently-hard game nobody is in a rush about
 * would waste the only urgency Kraken has.
 *
 * A game whose date has PASSED is excluded like any other dead one — the
 * nightly rescore sets unobtainable = 1 the night it expires, so it leaves this
 * board on its own without a second rule here.
 *
 * WHAT IS EXCLUDED:
 *
 *   flagged unobtainable
 *                     Martin: "whos going to want to go for that when they
 *                     cant get it". A board headed "most contested" is a
 *                     suggestion, and suggesting a game whose platinum is dead
 *                     is worse than suggesting nothing. Warface, FIFA 10 and
 *                     F.E.A.R. 2 sat at the top of it — servers off, eleven of
 *                     eleven owners permanently stuck, which is not a contest,
 *                     it is a wall.
 *
 *                     NOTE this is a CURATION decision, not a scoring one. Those
 *                     games still carry their local rarity and still pay their
 *                     owners exactly what they did before; they are simply not
 *                     recommended to anybody. Scoring never looks at this file.
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
         g.closes_at,
         t.local_earned AS platted_here
    FROM games g
    JOIN trophies t
      ON t.np_comm_id = g.np_comm_id AND t.type = 'platinum'
   WHERE g.local_started >= ?
     AND t.local_earned < g.local_started
     AND g.max_points > 0
     AND g.unobtainable = 0
   ORDER BY CASE WHEN g.closes_at IS NOT NULL THEN 0 ELSE 1 END,
            g.closes_at ASC,
            (g.local_started + 0.5) / (t.local_earned + 0.5) DESC,
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
