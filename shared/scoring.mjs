/**
 * Rarity-weighted trophy scoring.
 *
 * Reverse-engineered from the original Nahasis bot. Three members' cards from
 * the old screenshots, with collection sizes ranging from 3,687 to 16,548
 * trophies, all land between 8.6 and 10.6 points per trophy:
 *
 *   RabbitSquared      5,400 trophies    47,873 pts    8.87/trophy
 *   YT-WilkoX          3,687 trophies    39,057 pts   10.59/trophy
 *   ALMIGHTYSHARKSTR  16,548 trophies   154,302 pts    9.32/trophy
 *
 * A flat per-type model (300/90/30/15) overshoots all three by roughly 3x, so
 * the old bot was definitely rarity-weighted. The tight points-per-trophy band
 * across very different collection sizes matches `1/x - 1` — the same formula
 * PSN100 uses. Keeping it means nobody's score changes when the bot comes back.
 */

export const DEFAULT_SCORING = {
  /**
   * Ceiling on a single trophy. Uncapped, a 0.01% trophy is worth 9,999 points,
   * so one broken or server-shutdown trophy can outweigh a member's entire back
   * catalogue. 2,000 corresponds to a 0.05% trophy — still extraordinarily rare.
   * Set to Infinity to match PSN100 exactly.
   */
  cap: 2000,

  /**
   * Rarity floor. PSN occasionally reports 0% for brand-new or glitched
   * trophies, which would divide by zero.
   */
  floorPercent: 0.02,
};

/**
 * Points for a single trophy.
 * @param {number} earnedRatePercent - PSN's `trophyEarnedRate`, e.g. 2.71 for 2.71%
 * @returns {number} whole points
 *
 *   50%   -> 1
 *   10%   -> 9
 *    5%   -> 19
 *    1%   -> 99
 *    0.1% -> 999
 */
export function trophyPoints(earnedRatePercent, cfg = DEFAULT_SCORING) {
  const pct = Math.max(Number(earnedRatePercent) || cfg.floorPercent, cfg.floorPercent);
  const raw = Math.floor(100 / pct - 1);
  return Math.min(Math.max(raw, 0), cfg.cap);
}

/**
 * Total points for a set of earned trophies within one game.
 * @param {Array<{trophyId:number, earnedRate:number}>} definitions - all trophies in the game
 * @param {Set<number>|number[]} earnedIds - trophy ids this member has earned
 */
export function gamePoints(definitions, earnedIds, cfg = DEFAULT_SCORING) {
  const earned = earnedIds instanceof Set ? earnedIds : new Set(earnedIds);
  let total = 0;
  for (const def of definitions) {
    if (earned.has(def.trophyId)) total += trophyPoints(def.earnedRate, cfg);
  }
  return total;
}

/**
 * What a game is still worth to a member — the whole point of /game and /backlog.
 * Returns the points for everything they have NOT yet earned.
 */
export function remainingValue(definitions, earnedIds, cfg = DEFAULT_SCORING) {
  const earned = earnedIds instanceof Set ? earnedIds : new Set(earnedIds);
  let points = 0;
  let count = 0;
  for (const def of definitions) {
    if (!earned.has(def.trophyId)) {
      points += trophyPoints(def.earnedRate, cfg);
      count += 1;
    }
  }
  return { points, count };
}

/**
 * Split a member's points change into the two things that actually caused it,
 * so the update embed can explain a negative number instead of just showing one.
 *
 * @param {number} pointsFromNewTrophies - points for trophies earned since last update
 * @param {number} totalDelta - overall change in their score
 */
export function explainDelta(pointsFromNewTrophies, totalDelta) {
  const drift = totalDelta - pointsFromNewTrophies;
  return {
    earned: pointsFromNewTrophies,
    drift, // negative when the world caught up on trophies they already had
    net: totalDelta,
  };
}

/** PSNProfiles-style flat points, shown alongside as a familiar second number. */
export function flatPoints({ platinum = 0, gold = 0, silver = 0, bronze = 0 }) {
  return platinum * 300 + gold * 90 + silver * 30 + bronze * 15;
}

/** Rarity band names, matching PSN's own `trophyRare` values. */
export const RARITY_BANDS = ['Ultra rare', 'Very rare', 'Rare', 'Common'];

export function rarityBand(earnedRatePercent) {
  const p = Number(earnedRatePercent);
  if (p < 2) return 0;   // Ultra rare
  if (p < 10) return 1;  // Very rare
  if (p < 25) return 2;  // Rare
  return 3;              // Common
}
