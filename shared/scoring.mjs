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
   * Rarity floor, guarding the division for genuinely rare trophies.
   */
  floorPercent: 0.02,

  /**
   * What an UNRATED trophy is worth — one PSN reports as 0.00%.
   *
   * This is not a hypothetical. PSNProfiles hides trophies past the 255th in a
   * title, and PSN itself returns 0.00% for large swathes of them — every Sea
   * of Thieves trophy after Season 13, for instance.
   *
   * The reasoning for zero: if a player has earned a trophy, the proportion of
   * players who have earned it cannot be zero. A 0.00% rate on an earned trophy
   * is therefore missing data, not extreme rarity.
   *
   * The asymmetry decides it. Scoring unknown as zero undervalues a genuinely
   * brutal new trophy until PSN fills the figure in — and that corrects itself
   * automatically. Scoring it as maximum rarity hands someone 2,000 points a
   * trophy, hundreds of thousands across a title like SoT, and that does not
   * correct itself. It just wrecks the leaderboard and starts an argument.
   */
  unratedPoints: 0,
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
  const rate = Number(earnedRatePercent);

  // Unrated — see DEFAULT_SCORING.unratedPoints. Must be checked before the
  // floor is applied, or 0.00% clamps to 0.02% and scores maximum rarity.
  if (!Number.isFinite(rate) || rate <= 0) return cfg.unratedPoints;

  const pct = Math.max(rate, cfg.floorPercent);
  const raw = Math.floor(100 / pct - 1);
  return Math.min(Math.max(raw, 0), cfg.cap);
}

/** True when PSN gave us no usable rarity for this trophy. */
export const isUnrated = (earnedRatePercent) => {
  const rate = Number(earnedRatePercent);
  return !Number.isFinite(rate) || rate <= 0;
};

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
