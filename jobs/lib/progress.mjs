/**
 * A game's percentage, from what PSN's title list says about it.
 *
 * NORMALLY THIS IS SONY'S OWN FIGURE, verbatim bar the clamp. It is weighted
 * the way PlayStation weights it, it is free with every scan, and it is the
 * number members see on their consoles.
 *
 * EXCEPT WHEN SONY SAYS 0 AND THE COUNTS SAY OTHERWISE. 22 September:
 * Shinlight's update card read "Completed: -2". Tales of Graces f (50/50) and
 * Dengeki Bunko (59/59), both PS3, had come back from PSN at progress 0 with
 * every trophy earned in the very same response. A D1 check found two more,
 * both Nurse_Feel_Good's, both PS4, both fully earned at 0%. Four rows, no
 * other pattern: PSN occasionally omits or zeroes the field.
 *
 * Nobody with trophies in a game is at 0% of it, so a zero alongside earned
 * trophies is a missing number, not a real one. Then the percentage is worked
 * out from the counts PSN sent beside it: all of them earned is exactly 100,
 * anything less is Sony's point weights and never below 1.
 *
 * ONLY THEN. Any non-zero figure from Sony is trusted as before, clamped to
 * 0..100 (see the note in scan.mjs on Sony's 102%).
 */
const WEIGHT = { platinum: 180, gold: 90, silver: 30, bronze: 15 };

const sum = (t = {}) =>
  (t.platinum ?? 0) + (t.gold ?? 0) + (t.silver ?? 0) + (t.bronze ?? 0);

const weigh = (t = {}) =>
  Object.entries(WEIGHT).reduce((n, [k, w]) => n + (Number(t[k]) || 0) * w, 0);

export const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0));

export function titleProgress(title) {
  const psn = clampPct(title?.progress);
  if (psn > 0) return psn;

  const earned = sum(title?.earnedTrophies);
  const defined = sum(title?.definedTrophies);
  if (!earned || !defined) return psn;
  if (earned >= defined) return 100;

  const total = weigh(title.definedTrophies);
  if (!total) return psn;
  return Math.max(1, Math.min(99, Math.floor((weigh(title.earnedTrophies) / total) * 100)));
}
