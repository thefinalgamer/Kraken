import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trophyPoints,
  isUnrated,
  gamePoints,
  remainingValue,
  explainDelta,
  applyCompletion,
  scoreGameTrophies,
  blendedRate,
  UNRATED_FALLBACK,
  flatPoints,
  DEFAULT_SCORING,
  completionWeight,
} from '../shared/scoring.mjs';

const UNCAPPED = { ...DEFAULT_SCORING, cap: Infinity };

test('the curve is flat enough that ordinary games are worth playing', () => {
  // The change of August 19th. The old curve made a 0.1% trophy worth 333x a
  // 25% platinum, so beating Bloodborne paid 3 points and one dead
  // server-shutdown trophy paid a thousand — a board that measured who owned
  // the most ultra-rares rather than who hunted best.
  assert.equal(trophyPoints(25), 3);
  assert.equal(trophyPoints(10), 9);
  assert.equal(trophyPoints(1), 59);
  assert.equal(trophyPoints(0.1), 279);

  // Ultra-rares stay clearly the best thing on the board, just not the ONLY
  // thing. Guard the ratio rather than the values, so retuning `scale` alone
  // never trips this.
  // Guard the RANGE, not a figure — the exponent is a dial between two failure
  // modes and both ends are real. Too steep and the board is "who owns the most
  // ultra-rares"; too flat and owning thousands of abandoned cheap games beats
  // hunting, which is what 0.5 actually produced.
  const ratio = trophyPoints(0.1) / trophyPoints(25);
  assert.ok(ratio > 60 && ratio < 180, `0.1% is worth ${ratio.toFixed(0)}x a 25% platinum`);
});

test('nothing over half of players have is worth anything', () => {
  // The anti-shovelware line, and the most load-bearing number in the file.
  // 16,200 of 20,238 games in the real database score zero because of it, and
  // the rarest trophy in all of them is 50.1%.
  assert.equal(trophyPoints(50), 0);
  assert.equal(trophyPoints(50.1), 0);
  assert.equal(trophyPoints(90), 0);

  // ...and it is a step down to zero, not a cliff off a large number.
  assert.equal(trophyPoints(49.9), 1);
});

test('rarer trophies are always worth at least as much', () => {
  let previous = 0;
  for (const rate of [90, 50, 25, 10, 5, 2, 1, 0.5, 0.1]) {
    const pts = trophyPoints(rate, UNCAPPED);
    assert.ok(pts >= previous, `${rate}% should not be worth less than the tier above`);
    previous = pts;
  }
});

test('no single trophy can dominate a leaderboard', () => {
  // Under the old curve one 0.02% trophy was worth 4,999 points — more than a
  // hundred ordinary platinums — and only an explicit cap held it back. The
  // square-root curve does the job itself: the worst case at the rarity floor
  // is under 1,000, so the cap no longer binds at all.
  // The curve holds the line on its own at this scale — the rarity floor pays
  // about 1,300, so the cap does not bind. It stays as a backstop for whoever
  // raises the scale or the exponent without rechecking.
  assert.equal(trophyPoints(0.02), trophyPoints(0.02, UNCAPPED));

  // Which is the property that actually matters: the rarest trophy in the world
  // is worth a few good games, not a career.
  assert.ok(trophyPoints(0.02) < trophyPoints(5) * 100);
});

test('unrated trophies score nothing, not everything', () => {
  // PSN returns 0.00% for trophies it has no rarity data for — every Sea of
  // Thieves trophy past Season 13, among others. Clamping those to the rarity
  // floor would score them at maximum rarity, so a member who earned 200 of
  // them would bank 400,000 points and break the leaderboard outright.
  assert.equal(trophyPoints(0), 0);
  assert.equal(trophyPoints(null), 0);
  assert.equal(trophyPoints(undefined), 0);
  assert.equal(trophyPoints(NaN), 0);
  assert.equal(trophyPoints(-1), 0);

  assert.ok(isUnrated(0));
  assert.ok(isUnrated(null));
  assert.ok(!isUnrated(0.01));

  // A real rate, however tiny, still scores
  assert.ok(trophyPoints(0.01) > 0);
});

test('a title full of unrated trophies is worth nothing, not a fortune', () => {
  const sot = Array.from({ length: 200 }, (_, i) => ({ trophyId: i, earnedRate: 0 }));
  assert.equal(gamePoints(sot, sot.map((t) => t.trophyId)), 0);

  // and it does not distort /backlog either
  assert.deepEqual(remainingValue(sot, []), { points: 0, count: 200 });
});

test('game points only count what was actually earned', () => {
  const defs = [
    { trophyId: 0, earnedRate: 50 },   // 1
    { trophyId: 1, earnedRate: 10 },   // 9
    { trophyId: 2, earnedRate: 1 },    // 99
  ];
  // 50% -> 0, 10% -> 9, 1% -> 59
  assert.equal(gamePoints(defs, [0, 1, 2]), 68);
  assert.equal(gamePoints(defs, [0]), 0);
  assert.equal(gamePoints(defs, []), 0);
});

test('remaining value drives /game and /backlog', () => {
  const defs = [
    { trophyId: 0, earnedRate: 50 },
    { trophyId: 1, earnedRate: 10 },
    { trophyId: 2, earnedRate: 1 },
  ];
  assert.deepEqual(remainingValue(defs, [0]), { points: 68, count: 2 });
  assert.deepEqual(remainingValue(defs, [0, 1, 2]), { points: 0, count: 0 });
});

test('a negative update is explained, not just shown', () => {
  // The scenario that started this: 184 points of new trophies, score still
  // fell 1,008, because everything they already owned got more common.
  const d = explainDelta({
    earnedRaw: 184, rawBefore: 100000, rawAfter: 98992,
    completionBefore: 100, completionAfter: 100,
  });
  assert.equal(d.earned, 184);
  assert.equal(d.drift, -1192);
  assert.equal(d.net, -1008);
  assert.ok(d.drift < 0, 'drift must be negative for the explanation to make sense');
});

test('the completion multiplier pays what Esto paid', () => {
  // The sentence Martin and Rabbit both remembered, as a test.
  assert.equal(applyCompletion(1000, 70), 700);
  assert.equal(applyCompletion(1000, 100), 1000);
  assert.equal(applyCompletion(1000, 0), 0);
  // Floored, never rounded — nobody is paid for a percent they have not finished.
  assert.equal(applyCompletion(1000, 70.09), 700);
  assert.equal(applyCompletion(226198, 49), 110837);
});

test('clearing the backlog pays out across the whole library', () => {
  // No new trophies at all: completion alone rose from 49% to 60%. Every game
  // re-prices, and the member must be told that is what happened.
  const d = explainDelta({
    earnedRaw: 0, rawBefore: 460000, rawAfter: 460000,
    completionBefore: 49, completionAfter: 60,
  });
  assert.equal(d.earned, 0);
  assert.equal(d.drift, 0);
  assert.equal(d.backlog, 50600);
  assert.equal(d.net, 50600);
});

test('starting a game costs you, and the split says so', () => {
  // Popped one common trophy in a big new game: a few points earned, but
  // completion dipped, so the library re-prices downwards.
  const d = explainDelta({
    earnedRaw: 60, rawBefore: 460000, rawAfter: 460060,
    completionBefore: 49.2, completionAfter: 49.0,
  });
  assert.ok(d.earned > 0, 'the trophy still paid something');
  assert.ok(d.backlog < 0, 'but the dip cost more');
  assert.ok(d.net < 0);
});

test('the three parts always reconcile to the headline number', () => {
  // If the split ever disagreed with the total, the card would be arguing with
  // itself in front of the member.
  const cases = [
    [1200, 300000, 302400, 40.5, 41.2],
    [0, 900000, 899000, 99.11, 99.11],
    [50000, 10000, 60000, 12.5, 30.0],
    [0, 500000, 500000, 70, 70],
  ];
  for (const [earnedRaw, rawBefore, rawAfter, c0, c1] of cases) {
    const d = explainDelta({
      earnedRaw, rawBefore, rawAfter, completionBefore: c0, completionAfter: c1,
    });
    const sum = d.earned + d.backlog + d.drift;
    assert.ok(
      Math.abs(sum - d.net) <= 2,
      `parts ${sum} vs net ${d.net} — the card would show a split that does not add up`,
    );
  }
});
test('the old bot was not using flat per-type points', () => {
  // If it were, RabbitSquared would have scored 155,505 rather than 47,873.
  const flat = flatPoints({ platinum: 76, gold: 474, silver: 1153, bronze: 3697 });
  assert.equal(flat, 155505);
  assert.ok(flat > 47873 * 3, 'flat scoring overshoots the real figure threefold');
});

test('the curve compresses the gap between hunters, the way Esto\'s did', () => {
  // The one unexplained gap in the whole model: every member card from the old
  // bot landed between 8.87 and 10.59 points per trophy across players holding
  // 3,687 to 16,548 trophies — a 1.19x spread. Kraken's was 1.90x.
  //
  // His system was BOUNDED: local rarity in a 19-member server tops out at
  // 19x, so no trophy could run away with it. Global rarity has no ceiling, so
  // the compression has to come from the exponent instead. This asserts the
  // direction rather than a figure, because the figure depends on `scale`.
  const OLD = { ...DEFAULT_SCORING, zeroAbovePercent: 100, exponent: 1, scale: 1 };

  // Two libraries of the same size: one built on ultra-rares, one on the
  // ordinary good games most people actually play.
  const rareHunter = Array.from({ length: 500 }, (_, i) => ({
    trophyId: i, earnedRate: [0.1, 0.5, 1, 2, 5][i % 5],
  }));
  const normalHunter = Array.from({ length: 500 }, (_, i) => ({
    trophyId: i, earnedRate: [8, 12, 18, 25, 35][i % 5],
  }));

  const spread = (cfg) =>
    gamePoints(rareHunter, rareHunter.map((d) => d.trophyId), cfg) /
    gamePoints(normalHunter, normalHunter.map((d) => d.trophyId), cfg);

  const before = spread(OLD);
  const after = spread(DEFAULT_SCORING);

  assert.ok(
    after < before / 2,
    `the gap should close: was ${before.toFixed(1)}x, now ${after.toFixed(1)}x`,
  );

  // But the rare hunter must still be comfortably ahead — flattening the curve
  // is meant to make ordinary games count, not to make rarity stop mattering.
  assert.ok(after > 2, `rarity still has to win: only ${after.toFixed(1)}x`);
});

test('completion weighting excludes platinums', () => {
  // A platinum is awarded for earning everything else, so counting it would
  // count the same work twice — and PSNProfiles agrees, which is what makes
  // our number match theirs.
  assert.equal(completionWeight({ platinum: 1, gold: 0, silver: 0, bronze: 0 }), 0);
  assert.equal(completionWeight({ gold: 1 }), 90);
  assert.equal(completionWeight({ silver: 1 }), 30);
  assert.equal(completionWeight({ bronze: 1 }), 15);
  assert.equal(completionWeight({}), 0);

  // RabbitSquared's real figures — the member who disproved every model that
  // gave platinums any weight at all. PSNProfiles publishes 49.20%.
  const earned  = { platinum: 129, gold: 786,  silver: 1781, bronze: 5414 };
  const defined = { platinum: 321, gold: 1566, silver: 3811, bronze: 10923 };
  const pct = (completionWeight(earned) / completionWeight(defined)) * 100;
  assert.ok(Math.abs(pct - 49.20) < 0.6, `expected ~49.20, got ${pct.toFixed(2)}`);
});

// ------------------------------------------- game-level scoring rules ------

const game = (...specs) => specs.map(([type, rate], i) => ({ id: i + 1, type, rate }));

test('shovelware stays worth exactly nothing', () => {
  // Waifu Impact 2: nothing in it is earned by under half of players. This is
  // the single most important assertion in the file — it is the whole
  // anti-shovelware mechanism, and Pelziowo owns 13,000 games like this.
  const scored = scoreGameTrophies(
    game(['bronze', 95], ['bronze', 88], ['silver', 74], ['gold', 61], ['platinum', 58]),
  );
  assert.equal(scored.reduce((n, t) => n + t.points, 0), 0);
});

test('an easy trophy in a real game is worth 1, not 0', () => {
  // Spider-Man. "Be Greater" is earned by 98% of players and pays nothing on
  // the curve, but the game also contains a 4% trophy — so it is a real game
  // and everything in it counts for something.
  const scored = scoreGameTrophies(
    game(['bronze', 98], ['bronze', 71], ['gold', 25], ['platinum', 4]),
  );
  assert.equal(scored[0].points, 1, '"Be Greater" should be worth 1');
  assert.equal(scored[1].points, 1);
  assert.equal(scored[2].points, 3, 'the 25% trophy keeps its real value');
  assert.equal(scored[3].points, 21);
});

test('one hard trophy is what separates a real game from shovelware', () => {
  // The exact boundary, both sides of it. 50.1% is the rarest trophy found in
  // any of the 16,200 zero-value games in the real database.
  const justShovelware = scoreGameTrophies(game(['bronze', 90], ['platinum', 50.1]));
  assert.equal(justShovelware.reduce((n, t) => n + t.points, 0), 0);

  const justReal = scoreGameTrophies(game(['bronze', 90], ['platinum', 49.9]));
  assert.ok(justReal.reduce((n, t) => n + t.points, 0) > 0);
  assert.equal(justReal[0].points, 1, 'the common trophy is carried by the rare one');
});

test('games PSN knows nothing about are estimated, not zeroed', () => {
  // Red Faction: Armageddon — 59 trophies, not one rated. 152 games are like
  // this. Scoring them zero claims they are worthless; we simply do not know.
  const scored = scoreGameTrophies(
    game(['bronze', null], ['silver', null], ['gold', null], ['platinum', null]),
  );
  assert.ok(scored.every((t) => t.estimated));
  assert.equal(scored[0].points, UNRATED_FALLBACK.bronze);
  assert.equal(scored[3].points, UNRATED_FALLBACK.platinum);
  assert.ok(scored.reduce((n, t) => n + t.points, 0) > 0);
});

test('a 59-trophy unknown game lands in the small-game band', () => {
  // Sanity on magnitude. Real games on the board average 3,900-5,900 points;
  // small ones 77-280. An estimate must land in the second group — if a guess
  // is wrong it should be too low, never worth farming.
  const trophies = [
    ...Array.from({ length: 47 }, () => ['bronze', null]),
    ...Array.from({ length: 8 }, () => ['silver', null]),
    ...Array.from({ length: 3 }, () => ['gold', null]),
    ['platinum', null],
  ];
  const total = scoreGameTrophies(game(...trophies)).reduce((n, t) => n + t.points, 0);
  // Roughly what 59 median-rarity trophies are worth: real, modest, and well
  // below the 3,900-5,900 that a substantial game scores.
  assert.ok(total > 60 && total < 300, `estimated at ${total} points`);
});

test('a partly-rated game does not get free value through the back door', () => {
  // Otherwise a shovelware title with a few missing rarity figures could buy
  // itself a score. Unrated trophies only get an estimate when the game has NO
  // rarity at all — here the known trophies say plainly that it is shovelware.
  const scored = scoreGameTrophies(
    game(['bronze', 95], ['bronze', null], ['silver', 80], ['platinum', null]),
  );
  assert.equal(scored.reduce((n, t) => n + t.points, 0), 0);
  assert.ok(scored.every((t) => !t.estimated));
});

test('the floor never touches unrated trophies in a rated game', () => {
  const scored = scoreGameTrophies(game(['platinum', 2], ['bronze', 99], ['bronze', null]));
  assert.equal(scored[0].points, 36, 'the rare one is untouched');
  assert.equal(scored[1].points, 1, 'the common one gets the floor');
  assert.equal(scored[2].points, 0, 'the unknown one gets nothing');
});

test('common trophies never outweigh a genuinely rare one', () => {
  // The floor — every trophy in a real game is worth at least 1 — cannot shrink
  // with `scale`, because 1 is the smallest integer there is. So the smaller the
  // scale, the more a pile of common trophies is worth RELATIVE to a hard one:
  //
  //   45 easy trophies vs one 4% trophy:  scale 20 -> 45 v 83
  //                                       scale 10 -> 45 v 42
  //                                       scale  5 -> 45 v 21
  //
  // At the chosen scale of 5 the commons do outweigh a 4% trophy, and that is a
  // known, accepted cost of matching Esto's numbers — see `scale` in
  // shared/scoring.mjs. What must NOT happen is commons outweighing a genuinely
  // rare trophy, because that would make grinding tutorials beat hunting.
  const spiderman = game(
    ...Array.from({ length: 45 }, () => ['bronze', 80]),
    ['platinum', 1],
  );
  const scored = scoreGameTrophies(spiderman);
  const fromEasy = scored.filter((t) => t.rate === 80).reduce((n, t) => n + t.points, 0);
  const fromHard = scored.find((t) => t.rate === 1).points;

  assert.equal(fromEasy, 45, 'each easy trophy is worth exactly the floor');
  assert.ok(
    fromHard > fromEasy,
    `one 1% trophy (${fromHard}) must beat 45 tutorial trophies (${fromEasy}) — ` +
      'if this fails, the scale has been dropped too far and volume beats skill',
  );
});

// --------------------------------------------------- local rarity ---------

test('with no local evidence, Sony\'s figure is used unchanged', () => {
  // The property that makes it safe to ship at seven members: a game nobody
  // here owns scores exactly as it did before local rarity existed.
  assert.equal(blendedRate(2.71, 0, 0), 2.71);
  assert.equal(blendedRate(45, 0, 0), 45);
});

test('a trophy the whole server has earned loses its value', () => {
  // "our members completing games was making each others worth less" — the
  // sentence this layer exists to reproduce.
  const g = 2.71;
  const rates = [1, 3, 10, 50].map((n) => blendedRate(g, n, n));
  for (let i = 1; i < rates.length; i++) {
    assert.ok(rates[i] > rates[i - 1], 'each new member who earns it makes it commoner here');
  }
  assert.ok(rates.at(-1) > 50, 'once the server has ground it down it is worth nothing');
});

test('a trophy nobody here can do becomes more valuable, not less', () => {
  // The other half of the economy, and the reason DLC was where the money was
  // on Esto's board: fifty of us own it, one of us finished it.
  const g = 2.71;
  assert.ok(blendedRate(g, 1, 50) < g, 'rarer here than Sony says');
  assert.ok(trophyPoints(blendedRate(g, 1, 50)) > trophyPoints(g));
  assert.ok(trophyPoints(blendedRate(g, 1, 200)) > trophyPoints(blendedRate(g, 1, 50)));
});

test('local rarity converges as the sample grows, and never lurches', () => {
  // One formula the whole way — no switchover, no cliff at any member count.
  const g = 5;
  let previous = blendedRate(g, 1, 1);
  for (let n = 2; n <= 300; n++) {
    const r = blendedRate(g, n, n);
    assert.ok(Math.abs(r - previous) < 12, `a jump of ${(r - previous).toFixed(1)} at ${n} members`);
    previous = r;
  }
});

test('a drifted count can never produce negative points', () => {
  // Counters can disagree if a scan dies mid-write. More earners than owners is
  // nonsense, but it must degrade to a harmless number rather than a rate above
  // 100% coming back out of the curve as a negative score.
  const r = blendedRate(2.71, 99, 3);
  assert.ok(r > 0 && r <= 100, `blended rate went to ${r}`);
  assert.ok(trophyPoints(r) >= 0);
});

test('unrated trophies are not invented into existence by local rarity', () => {
  // A trophy PSN has no figure for stays unrated — local evidence cannot
  // manufacture a rarity for something we have no baseline for.
  // Both come back as 0, which isUnrated() already treats as "no data" — so
  // they fall through to the unrated path rather than being scored.
  assert.equal(blendedRate(0, 5, 5), 0);
  assert.equal(blendedRate(null, 5, 5), 0);
  assert.ok(isUnrated(blendedRate(null, 5, 5)));
});

test('the scan and the rescore price a game differently, on purpose', () => {
  // A scan passes no local counts, so it scores on Sony's figures alone; the
  // rescore passes them and prices against the whole server. If these ever
  // silently became the same call, local rarity would start depending on who
  // scanned last.
  const trophies = [{ id: 1, type: 'platinum', rate: 2.71 }];
  const globalOnly = scoreGameTrophies(trophies);
  const withLocal = scoreGameTrophies(trophies, undefined, {
    started: 20,
    earned: new Map([[1, 20]]),
  });
  assert.ok(withLocal[0].points < globalOnly[0].points);
});
