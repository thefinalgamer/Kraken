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
   * The rate at or above which a trophy is worth NOTHING.
   *
   * This is the anti-shovelware mechanism and the single most load-bearing
   * number in the file. Games where no trophy anywhere clears this line score
   * zero in total — 16,200 of the 20,238 games in the database, including
   * every one of Pelziowo's 13,000 asset flips. Verified: the rarest trophy in
   * all of them is 50.1%.
   *
   * It arrived by accident. The original curve was floor(100/pct - 1), which
   * happens to return 0 above 50%, and nobody designed that. It is still a
   * better rule than anything deliberate would have been, because it asks
   * "is this trophy hard" rather than "is this game hard", and millions of
   * players answer it for free.
   *
   * DO NOT RAISE THIS without re-running the shovelware measurements in
   * claude/scoring-model.md §7.
   */
  zeroAbovePercent: 50,

  /**
   * How steep the curve is below that line. THE dial for what kind of board
   * this is.
   *
   * The old curve was effectively exponent 1.0 — value proportional to 1/rate —
   * which made a 0.1% trophy worth 333x a 25% platinum. The consequence was a
   * board that measured "who owns the most ultra-rare trophies" rather than
   * "who is the best hunter": beating Bloodborne paid 3 points while one dead
   * server-shutdown trophy paid a thousand, and an ordinary good game was worth
   * about as much as nothing.
   *
   * 0.65 brings that ratio to roughly 100x. Ultra-rares stay clearly the most
   * valuable thing on the board — they just stop being the ONLY thing on it.
   *
   * IT WAS 0.5 FOR ABOUT AN HOUR AND THAT WAS TOO FAR. The measured result:
   * Pelziowo's long tail of 1,988 small games grew 93% while N7_Maxxi's
   * genuinely hard trophies LOST 3%, and Pelzio — 15,411 games — passed Maxxi,
   * who has 350. Exactly the outcome Martin had ruled out: "i dont care if
   * pelzio is first as long as its not from shovelware."
   *
   * The mechanism is the blind spot in §7 of the scoring doc. Rarity measures
   * who BOTHERED, not what it took. A cheap game bought in a sale and never
   * played shows 30% earn rates — not because it is hard, but because 70% of
   * buyers never opened it. Flattening the curve is precisely what makes that
   * band lucrative, and it is the band those libraries are full of.
   *
   * So the exponent is a genuine dial between two failure modes, and neither
   * end is safe:
   *
   *   too high (1.0)  the board is "who owns the most ultra-rares" and an
   *                   ordinary good game is worth nothing
   *   too low  (0.5)  the 20-50% band pays enough that owning thousands of
   *                   abandoned cheap games beats hunting
   *
   * Judge a change by Pelziowo-vs-Maxxi and by the share of a score coming
   * from the 20-50% band, not by the synthetic-library ratio — a model built
   * from banded counts predicted Maxxi comfortably ahead at 0.5, and he was not.
   * The rescore job takes minutes; measure, do not model.
   *
   * This is also the closest we can get to Esto's original. His numbers came
   * from LOCAL rarity — started_by / earned_by inside a 19-member server — so
   * the rarest possible trophy was 19x its base and the whole system was
   * bounded by the member count. That is why his cards sat in a tight
   * 8.87-10.59 points-per-trophy band across players holding 3,687 to 16,548
   * trophies, where Kraken's spread was nearly twice as wide. Global rarity has
   * no such ceiling, so the flattening has to be done explicitly.
   */
  exponent: 0.65,

  /**
   * Scale. Sets the size of the numbers, not their shape — the shape is
   * entirely `exponent`.
   *
   * 5 is not a matter of taste. Two members have cards from ESTO'S ORIGINAL
   * BOT — RabbitSquared on 47,873 and YT-WilkoX on 39,057 — so the scale can be
   * checked against the only real evidence that exists:
   *
   *   scale 20   Rabbit 226,170 (4.72x his old score)   WilkoX 168,323 (4.31x)
   *   scale 10   Rabbit 113,085 (2.36x)                 WilkoX  84,161 (2.15x)
   *   scale  5   Rabbit  56,542 (1.18x)                 WilkoX  42,080 (1.08x)
   *   scale  4   Rabbit  45,234 (0.94x)                 WilkoX  33,664 (0.86x)
   *
   * At 5 both land just above where they were, which is what should happen —
   * they have each earned trophies in the years since. Two independent members,
   * two independent matches.
   *
   * Anyone changing this: re-derive it the same way. The old cards are the only
   * ground truth this project has for absolute scale, and there will never be
   * any more of them.
   */
  scale: 5,

  /**
   * Ceiling on a single trophy. At scale 5 the rarity floor pays about 1,300, so
   * this does not bind — kept as a backstop for anyone who raises the scale or
   * the exponent without rechecking. One glitched or server-shutdown trophy must
   * never outweigh a career.
   */
  cap: 2000,

  /**
   * Rarity floor, guarding the division for genuinely rare trophies.
   */
  floorPercent: 0.02,

  /**
   * What an UNRATED trophy is worth — one PSN reports as 0.00% or omits.
   *
   * Zero HERE, but see scoreGameTrophies(): when a whole game is unrated, every
   * trophy in it gets UNRATED_FALLBACK instead. This value only applies to an
   * unrated trophy sitting inside a game we do have rarity for, where the
   * evidence we have says the game is shovelware.
   *
   * The reasoning for zero: if a player has earned a trophy, the proportion of
   * players who have earned it cannot be zero. A 0.00% rate on an earned trophy
   * is therefore missing data, not extreme rarity.
   *
   * The asymmetry decides it. Scoring unknown as zero undervalues a genuinely
   * brutal new trophy until PSN fills the figure in — and that corrects itself.
   * Scoring it as maximum rarity hands someone 2,000 points a trophy, hundreds
   * of thousands across a title like Sea of Thieves, and that does not correct
   * itself. It just wrecks the leaderboard and starts an argument.
   */
  unratedPoints: 0,
};

/**
 * Points for a single trophy.
 *
 *     points = scale x ((zeroAbove / rate) ^ exponent  -  1)
 *
 * The "- 1" is what makes it continuous: a trophy at exactly the threshold is
 * worth zero rather than falling off a cliff from some large number. Below the
 * threshold everything is worth at least 1, so the boundary stays exactly where
 * the shovelware measurements say it is.
 *
 * @param {number} earnedRatePercent - PSN's `trophyEarnedRate`, e.g. 2.71 for 2.71%
 * @returns {number} whole points
 *
 *   50%   ->    0     over half of players have it — not an achievement
 *   40%   ->    2
 *   25%   ->    8     a decent platinum
 *   10%   ->   25
 *    5%   ->   43
 *    1%   ->  121
 *  0.1%   ->  427
 * 0.01%   -> 1394
 */
export function trophyPoints(earnedRatePercent, cfg = DEFAULT_SCORING) {
  const rate = Number(earnedRatePercent);

  // Unrated — see DEFAULT_SCORING.unratedPoints. Must be checked before the
  // floor is applied, or 0.00% clamps to 0.02% and scores maximum rarity.
  if (!Number.isFinite(rate) || rate <= 0) return cfg.unratedPoints;

  const pct = Math.max(rate, cfg.floorPercent);
  if (pct >= cfg.zeroAbovePercent) return 0;

  const raw = cfg.scale * (Math.pow(cfg.zeroAbovePercent / pct, cfg.exponent) - 1);
  return Math.max(1, Math.min(Math.round(raw), cfg.cap));
}

/**
 * LOCAL RARITY — layer two. How many of us started it, versus finished it.
 *
 * Martin, on what the old board felt like:
 *
 *   "i remember going oh this is a good game, 'omg my points you started it????'
 *    it was good times"
 *
 * That is the whole design brief. A game gets more valuable the moment someone
 * else picks it up and is still stuck on it, and settles back down when they
 * finish. Points visibly move because of what other people are doing, which is
 * what turns a leaderboard into an economy instead of a spreadsheet.
 *
 *     multiplier = ((started + s) / (finished + s)) ^ p,  capped
 *
 * This is Esto's shape, straight from the reconstruction of his site:
 * `flat points x (started_by / earned_by)`. Two properties come from that form
 * and both matter:
 *
 * 1. IT CAN NEVER GO BELOW 1. `finished` can never exceed `started`, so a
 *    trophy everybody here has earned is worth exactly its Sony value — never
 *    less. Devaluing a trophy because you earned it is not an economy, it is a
 *    penalty for playing, and an earlier attempt at this layer did exactly that
 *    and cost N7_Maxxi 85% of his score in one rescore.
 *
 * 2. THE BONUS DECAYS AS PEOPLE FINISH. Two of us own it and one is stuck:
 *    1.29x. He finishes: back to 1.00x. That is Martin's "our members
 *    completing games was making each others worth less" — falling from
 *    inflated back to normal.
 *
 * On the constants:
 *
 * - `p = 0.5`. The raw ratio is far too violent at this size — one person
 *   buying a game would double what it is worth to everyone who owns it. The
 *   square root turns that into a noticeable nudge rather than a lurch.
 * - `s = 0.5` smooths the tiny counts, so 1-of-1 is exactly 1.00x rather than
 *   an artefact, and 0-finished does not divide by zero.
 * - `cap = 3`. Esto's could reach 19x with nineteen members and no ceiling.
 *   A trophy none of us can do being worth three times Sony's price is a real
 *   prize without letting one obscure game outweigh a career.
 *
 * REPLACED a shrinkage estimator that asked "is this rarer here than Sony says".
 * That was statistically tidier and completely wrong for this server: at
 * nineteen members two people can never out-evidence millions, so it did
 * nothing at all — 87 points across the entire board. This reacts to the second
 * person who picks up a game, which is the point.
 */
export const LOCAL_RARITY = { exponent: 0.5, smoothing: 0.5, cap: 3 };

/**
 * @param {number} finished - members here who have this trophy
 * @param {number} started  - members here who own the game
 * @returns {number} a multiplier >= 1
 */
export function localMultiplier(finished = 0, started = 0, cfg = LOCAL_RARITY) {
  const done = Math.max(0, Number(finished) || 0);
  // Guard against a count that outruns its denominator. It should be
  // impossible, but if it ever happened the ratio would drop below 1 and start
  // devaluing trophies — the exact failure this layer is shaped to avoid.
  const owned = Math.max(done, Number(started) || 0);
  if (!owned) return 1;

  const { exponent, smoothing, cap } = cfg;
  const ratio = (owned + smoothing) / (done + smoothing);
  return Math.min(cap, Math.max(1, ratio ** exponent));
}

/**
 * What a trophy is worth when PSN has told us NOTHING about the game.
 *
 * 152 games have not a single rated trophy — Sony publishes no rarity for them
 * at all. Two very different populations land here: old PS3 titles that will
 * never get figures (Red Faction: Armageddon, Euro Fishing), and brand-new
 * releases Sony has not computed yet (Assassin's Creed Black Flag Resynced).
 * Scoring them zero claims the game is worthless, which is a claim we have no
 * evidence for — the truth is we do not know.
 *
 * Measured, not chosen. Median earn rate per type across 124,869 trophies in
 * games known to contain real challenge (shovelware excluded), run through the
 * curve above:
 *
 *   bronze   26.9%  ->  7
 *   silver   26.3%  ->  8
 *   gold     35.7%  ->  4
 *   platinum 16.2%  -> 15
 *
 * Note gold comes out COMMONER than bronze — the mean agrees (35.83% vs
 * 32.78%). Golds are usually "finish chapter eight", earned by everyone who
 * plays; bronzes hide the missables. So trophy type barely predicts rarity, and
 * inventing a bronze < silver < gold ladder would be pretending to a precision
 * the data does not support, as well as putting a gold worth 1 next to a bronze
 * worth 2 on the same card.
 *
 * Hence one value for everything and a higher one for the platinum, which is
 * the only type the data genuinely separates.
 *
 * RECALCULATE THESE IF THE CURVE CHANGES. They are the curve applied to fixed
 * rarities, so a new exponent or scale silently makes them wrong.
 *
 * Deliberately conservative: if the guess is wrong it is too low, never worth
 * farming. Games flagged `games.estimated` are re-checked every three days
 * rather than every thirty, so a new release is priced properly almost as soon
 * as Sony prices it.
 */
export const UNRATED_FALLBACK = { platinum: 5, gold: 2, silver: 2, bronze: 2 };

export const fallbackPoints = (type) => UNRATED_FALLBACK[type] ?? 2;

/**
 * Score every trophy in ONE game together.
 *
 * Per-trophy scoring alone cannot answer two questions that need the whole
 * game in view, and both came straight from Martin:
 *
 * 1. "Spider-Man has easy trophies in it, no problem — it also has hard ones."
 *    Putting the suit on is earned by 98% of players and pays nothing under the
 *    curve. But it is still a trophy in a real game, and a backlog of 157
 *    entries all reading "+0 points" tells the member nothing. So any trophy in
 *    a game containing at least one genuinely hard trophy is worth AT LEAST 1.
 *
 * 2. Shovelware must stay at zero. A game where no trophy anywhere is earned by
 *    under half of players gets NO floor — every trophy in it stays worth
 *    nothing, however many there are. That is the whole anti-shovelware
 *    mechanism, and why a time limit was never needed: the system never asks
 *    "is this game hard", it asks "is this trophy hard", forty times a game.
 *
 * The floor only ever applies to trophies we have real rarity for. An unrated
 * trophy inside a partly-rated game stays at zero — otherwise a shovelware
 * title with a couple of missing figures could buy value through the back door.
 *
 * @param {Array<{type:string, rate:number|null}>} trophies - every trophy in the game
 * @returns the same objects with `points` and `estimated` set
 */
export function scoreGameTrophies(trophies, cfg = DEFAULT_SCORING, local = null) {
  const anyRated = trophies.some((t) => !isUnrated(t.rate));

  if (!anyRated) {
    return trophies.map((t) => ({ ...t, points: fallbackPoints(t.type), estimated: true }));
  }

  // `local` is { started, earned: Map(trophyId -> count) }, or null to score on
  // Sony's figures alone. Null is the honest answer during a scan: local counts
  // move every time anybody plays, so the rescore job owns the multiplier and
  // applies it to the whole board at once. Scoring one member's games against
  // counts that shift under them would make two members disagree about what the
  // same trophy is worth depending on who scanned last.
  const boost = (t) =>
    local ? localMultiplier(local.earned.get(t.id) ?? 0, local.started) : 1;

  const scored = trophies.map((t) => ({
    ...t,
    points: isUnrated(t.rate)
      ? cfg.unratedPoints
      : Math.min(cfg.cap, Math.round(trophyPoints(t.rate, cfg) * boost(t))),
    estimated: false,
  }));

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
 * 3. IT PAYS IN WHOLE PERCENTAGE POINTS, and that is a deliberate reversal.
 *
 *    This used to pay at true precision, and the note here argued hard for it:
 *    Esto's bot rounded to whole percent, Rabbit remembered scores lurching,
 *    and lurching was filed as a bug. Martin, running the server: "right now we
 *    have payouts happening every 0.01% so it's only 14 points. People are
 *    asking for that bigger cliff."
 *
 *    They are asking for the lurch. It was never a bug — it was the reward
 *    landing hard enough to feel, and 14 points arriving invisibly is not a
 *    reward at all. Reaching 92% should be an event.
 *
 *    The old argument against cliffs was really an argument against BANDS, and
 *    it does not carry across. A +10% band at 75% means someone at 75.1% who
 *    pops one tutorial trophy falls to 74.9% and loses thousands — so people
 *    stop starting games, the exact opposite of trophy hunting. A one-point
 *    step cannot do that: the most it can ever cost is a single percent of your
 *    score, the same amount it just paid. The debt model is untouched. Keep
 *    BANDS cosmetic; a step is fine.
 *
 *    COMPLETION_STEP is the whole of it. Set it to 0.01 and true precision is
 *    back, no other change required.
 *
 * Floored, like every other percentage on the board: nobody is ever paid for a
 * completion point they have not finished earning. 91.98% pays exactly what 91%
 * pays, and the card says so — see nextCompletionStep().
 *
 * @param {number} rawPoints - the rarity-weighted sum, before completion
 * @param {number} completionPercent - overall completion, e.g. 49.2
 */
export const COMPLETION_STEP = 1;

/** The completion a member is actually PAID at: theirs, rounded down to a step. */
export function paidCompletion(completionPercent) {
  const c = Number(completionPercent);
  if (!Number.isFinite(c) || c <= 0) return 0;
  const step = COMPLETION_STEP > 0 ? COMPLETION_STEP : 0.01;
  return Math.min(100, Math.floor(Math.min(c, 100) / step) * step);
}

/**
 * The next completion figure that actually pays, for the card to aim at.
 * Returns null at 100% — there is nothing left to reach.
 */
export function nextCompletionStep(completionPercent) {
  const paid = paidCompletion(completionPercent);
  if (paid >= 100) return null;
  const step = COMPLETION_STEP > 0 ? COMPLETION_STEP : 0.01;
  return Math.round(Math.min(100, paid + step) * 100) / 100;
}

export function applyCompletion(rawPoints, completionPercent) {
  const raw = Number(rawPoints) || 0;
  const c = Number(completionPercent);
  if (!Number.isFinite(c) || c <= 0) return 0;
  return Math.floor((raw * paidCompletion(c)) / 100);
}

/**
 * What a member banks from a raw figure — FOR DISPLAY ONLY.
 *
 * `applyCompletion` is the scoring function and returns 0 for a completion it
 * cannot use, which is right when computing a score: no completion, no points.
 * It is badly wrong on a page. A member whose completion has not been written
 * yet — mid-first-scan, or a row an older build left behind — would render as
 * zero on every game they own, and "all my points vanished" is a far worse bug
 * to ship than a figure that has not had the multiplier applied yet.
 *
 * So this falls back to the raw number and lets the caller notice. Callers pair
 * it with `bankedNote()` so the explainer disappears at the same moment the
 * multiplier does, rather than printing "\u00d7 0.00% completion" underneath.
 */
export function displayBanked(raw, completionPercent) {
  const r = Number(raw) || 0;
  const c = Number(completionPercent);
  if (!Number.isFinite(c) || c <= 0) return r;
  return applyCompletion(r, c);
}

/** True when there is a real multiplier worth explaining to the reader. */
export const hasCompletion = (completionPercent) => {
  const c = Number(completionPercent);
  return Number.isFinite(c) && c > 0;
};

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
  // The PAID completion, not the true one. applyCompletion() steps to whole
  // percentage points, so net does too — and if the three parts were computed
  // against the unstepped figure they would not add up to it. The card would
  // then show a split arguing with its own headline. See COMPLETION_STEP.
  const c0 = paidCompletion(completionBefore) / 100;
  const c1 = paidCompletion(completionAfter) / 100;
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
