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

/**
 * What a trophy is worth when PSN has told us NOTHING about the game.
 *
 * 152 games in the database have not a single rated trophy — Sony returns no
 * rarity figure at all for them. They are mostly old PS3 titles: Red Faction:
 * Armageddon, Euro Fishing, Grand Ages Medieval. Scoring them zero says "this
 * game is worthless", which is a claim we have no evidence for; the truth is we
 * don't know. So they get what a TYPICAL trophy is worth instead, and the
 * estimate is replaced by a real figure the moment local rarity lands.
 *
 * The numbers are measured, not chosen — median earn rate per type across
 * 124,869 trophies in games we know contain real challenge (shovelware
 * excluded), run through the normal curve:
 *
 *   bronze   26.9%  ->  2
 *   silver   26.3%  ->  2
 *   gold     35.7%  ->  1
 *   platinum 16.2%  ->  5
 *
 * Note gold comes out COMMONER than bronze — that is not noise, the mean says
 * it too (35.83% vs 32.78%). Golds are usually "finish chapter eight", earned
 * by everyone who plays; bronzes hide the missables and the grind. So trophy
 * type barely predicts rarity, and inventing a bronze < silver < gold ladder
 * here would be pretending to a precision the data does not support — as well
 * as putting a gold worth 1 next to a bronze worth 2 on the same card.
 *
 * Hence: one value for everything, and a higher one for the platinum, which is
 * the only type the data genuinely separates.
 *
 * Deliberately conservative. A 59-trophy game lands around 120 points — real,
 * modest, and nowhere near enough to be worth farming if the guess is wrong.
 */
export const UNRATED_FALLBACK = { platinum: 5, gold: 2, silver: 2, bronze: 2 };

export const fallbackPoints = (type) => UNRATED_FALLBACK[type] ?? 2;

/**
 * Score every trophy in ONE game together.
 *
 * Per-trophy scoring alone cannot answer two questions that need the whole
 * game in view, and both of them came straight from Martin:
 *
 * 1. "Spider-Man has easy trophies in it, no problem — it also has hard ones."
 *    Putting the suit on is earned by 98% of players and pays nothing under
 *    the curve. But it is still a trophy in a real game, and a board of 157
 *    backlog entries all reading "+0 points" tells the member nothing. So any
 *    trophy in a game that contains at least one genuinely hard trophy is
 *    worth AT LEAST 1.
 *
 *    Measured before shipping: this hands the whole board under 3% and moves
 *    nobody's rank. Lucas +2.08%, Pelzio +2.77%, everyone else under 0.35%.
 *
 * 2. Shovelware must stay at zero. A game where no trophy anywhere is earned
 *    by under half of players gets NO floor — every trophy stays worth nothing,
 *    however many of them there are. That is the whole anti-shovelware
 *    mechanism and it is why a timer was never needed: the system never asks
 *    "is this game hard", it asks "is this trophy hard", forty times a game.
 *
 * The floor only ever applies to trophies we have real rarity for. An unrated
 * trophy sitting inside a partly-rated game stays at zero — otherwise a
 * shovelware title with a couple of missing figures could buy itself a value
 * through the back door.
 *
 * @param {Array<{type:string, rate:number|null}>} trophies - every trophy in the game
 * @returns the same objects with `points` and `estimated` set
 */
export function scoreGameTrophies(trophies, cfg = DEFAULT_SCORING) {
  const anyRated = trophies.some((t) => !isUnrated(t.rate));

  // Sony gave us nothing for this game. Estimate the lot.
  if (!anyRated) {
    return trophies.map((t) => ({ ...t, points: fallbackPoints(t.type), estimated: true }));
  }

  const scored = trophies.map((t) => ({
    ...t,
    points: isUnrated(t.rate) ? cfg.unratedPoints : trophyPoints(t.rate, cfg),
    estimated: false,
  }));

  // Does anything in here ask something of the player?
  if (scored.some((t) => t.points > 0)) {
    for (const t of scored) {
      if (!isUnrated(t.rate) && t.points === 0) t.points = 1;
    }
  }

  return scored;
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
 * THE COMPLETION MULTIPLIER — layer three of the scoring model.
 *
 * A game is worth 1,000 and your overall completion is 70%, so you bank 700.
 * Clear the backlog and the rest comes to you on a later update.
 *
 * This is what Esto's original bot did, confirmed independently by two people
 * from opposite ends. RabbitSquared: "he just worked out your points then x the
 * completion". Martin: "when you /update it goes through and gives you that
 * extra bit you first missed off with worse completion."
 *
 * The decisive argument that it must be a PERSONAL multiplier rather than
 * anything to do with rarity: Martin and Rabbit played many of the same games,
 * and Martin remembers earning more from them because his completion was
 * higher. Rarity is shared — same game, same server, same rarity for both
 * players — so no rarity model of any kind can pay one of them more than the
 * other. Only a personal multiplier can. That is elimination, not curve-fitting.
 *
 * Three properties worth understanding before anyone changes this:
 *
 * 1. LIVE, NOT BANKED. Applied at scan time against current completion, never
 *    stored per trophy. That is what makes climbing feel good — your entire
 *    back catalogue re-prices at once, and you gain points on games you have
 *    not touched in years. A banked version would need a stored multiplier per
 *    trophy, would break every rescan, and would deliver none of the payoff.
 *
 * 2. IT IS A DEBT MODEL, and that is the selling point. Starting a 45-trophy
 *    game and popping one tutorial trophy drops your completion, so everything
 *    you own pays slightly less. Going back and finishing that same game pays
 *    twice: once for the trophies, once for the percentage. Starting things
 *    costs you, finishing things pays. That is "reward the backlog" delivered
 *    by a single multiply.
 *
 * 3. NO CLIFFS, EVER. Use the true percentage, never a rounded or banded one.
 *    Esto's bot rounded completion to whole percent, which is why Rabbit
 *    remembers scores lurching — "if you went up by 1% it went up a big chunk".
 *    That was a bug. At Martin's score a whole-percent step is ~1,375 points;
 *    at true precision it is ~14 points per 0.01%. Same system, no lurches.
 *
 *    Tiers and thresholds are worse still. A +10% band at 75% means someone at
 *    75.1% who buys a game and pops the tutorial trophy falls to 74.9% and
 *    loses thousands instantly — which teaches people to stop starting games,
 *    the exact opposite of trophy hunting. Keep milestones cosmetic.
 *
 * Floored, like every other percentage on the board: nobody is ever paid for a
 * completion point they have not finished earning.
 *
 * @param {number} rawPoints - the rarity-weighted sum, before completion
 * @param {number} completionPercent - overall completion, e.g. 49.2
 */
export function applyCompletion(rawPoints, completionPercent) {
  const raw = Number(rawPoints) || 0;
  const c = Number(completionPercent);
  if (!Number.isFinite(c) || c <= 0) return 0;
  return Math.floor((raw * Math.min(c, 100)) / 100);
}

/**
 * Split a member's points change into the three things that actually caused
 * it, so the update card can explain a number instead of just showing one.
 *
 * With the completion multiplier live there are three moving parts, and they
 * feel completely different to the person reading the card:
 *
 *   earned  - new trophies, priced at the completion you had before
 *   backlog - your whole library re-priced because your completion moved
 *   drift   - trophies you already owned becoming more or less rare
 *
 * `backlog` is the one that matters. It is the reward for clearing old games,
 * and it is invisible unless the card names it — the points arrive attached to
 * games the member did not touch this session, so without a label it reads as
 * the bot inventing numbers.
 *
 * The algebra, so nobody has to rederive it. Score is raw x c:
 *
 *   after - before = raw1.c1 - raw0.c0
 *                  = (earnedRaw + driftRaw).c0  +  raw1.(c1 - c0)
 *
 * The first term is trophy movement valued at the old rate; the second is the
 * re-pricing. They sum exactly, so the three parts always reconcile to net and
 * the card can never show a split that does not add up.
 */
export function explainDelta({
  earnedRaw = 0,
  rawBefore = 0,
  rawAfter = 0,
  completionBefore = 0,
  completionAfter = 0,
} = {}) {
  const c0 = (Number(completionBefore) || 0) / 100;
  const c1 = (Number(completionAfter) || 0) / 100;
  const driftRaw = rawAfter - rawBefore - earnedRaw;

  const earned = Math.round(earnedRaw * c0);
  const drift = Math.round(driftRaw * c0);
  const backlog = Math.round(rawAfter * (c1 - c0));

  // Net comes from the stored scores, not from summing the parts, so the
  // headline figure is always the truth even if rounding nudges a component.
  const net = applyCompletion(rawAfter, completionAfter) - applyCompletion(rawBefore, completionBefore);

  return { earned, backlog, drift, net };
}

/**
 * Trophy weight for COMPLETION — Sony's own values, with the platinum excluded.
 *
 * The exclusion is the important part, and it is not a fudge. A platinum is
 * awarded automatically for earning every other trophy in a game; it is not an
 * independent achievement, so counting it counts the same work twice.
 *
 * It also happens to be what PSNProfiles does. Solving for the weights that
 * reproduce four members' published completion percentages puts the platinum
 * weight at exactly zero:
 *
 *   plain trophy count            worst error 1.89 points
 *   300/90/30/15 (plat included)  worst error 1.84
 *   180/90/30/15 (plat included)  worst error 1.26
 *   90/30/15, platinum excluded   worst error 0.52   <- this
 *
 * Rabbit is what proves it: 321 platinums available and 129 earned, so any
 * model that weights platinums at all crushes him while PSNProfiles does not
 * move. The half-point that remains is the trophies Kraken counts and
 * PSNProfiles does not index — it hides everything past the 255th in a title.
 */
export function completionWeight({ gold = 0, silver = 0, bronze = 0 } = {}) {
  return gold * 90 + silver * 30 + bronze * 15;
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
