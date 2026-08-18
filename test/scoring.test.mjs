import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trophyPoints,
  isUnrated,
  gamePoints,
  remainingValue,
  explainDelta,
  applyCompletion,
  flatPoints,
  DEFAULT_SCORING,
  completionWeight,
} from '../shared/scoring.mjs';

const UNCAPPED = { ...DEFAULT_SCORING, cap: Infinity };

test('matches the PSN100 reference values', () => {
  assert.equal(trophyPoints(50, UNCAPPED), 1);
  assert.equal(trophyPoints(10, UNCAPPED), 9);
  assert.equal(trophyPoints(1, UNCAPPED), 99);
  assert.equal(trophyPoints(0.1, UNCAPPED), 999);
});

test('rarer trophies are always worth at least as much', () => {
  let previous = 0;
  for (const rate of [90, 50, 25, 10, 5, 2, 1, 0.5, 0.1]) {
    const pts = trophyPoints(rate, UNCAPPED);
    assert.ok(pts >= previous, `${rate}% should not be worth less than the tier above`);
    previous = pts;
  }
});

test('the cap stops one glitched trophy dominating a leaderboard', () => {
  // At the rarity floor an uncapped trophy is worth nearly 5,000 points —
  // more than a hundred ordinary platinums.
  assert.equal(trophyPoints(0.02, UNCAPPED), 4999);
  assert.equal(trophyPoints(0.02), 2000);

  // The cap only bites below roughly 0.05%.
  assert.equal(trophyPoints(0.05, UNCAPPED), 1999);
  assert.equal(trophyPoints(0.05), 1999);

  // A 2.71% trophy is nowhere near it, so normal scoring is untouched.
  assert.equal(trophyPoints(2.71), trophyPoints(2.71, UNCAPPED));
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
  assert.equal(gamePoints(defs, [0, 1, 2]), 109);
  assert.equal(gamePoints(defs, [0]), 1);
  assert.equal(gamePoints(defs, []), 0);
});

test('remaining value drives /game and /backlog', () => {
  const defs = [
    { trophyId: 0, earnedRate: 50 },
    { trophyId: 1, earnedRate: 10 },
    { trophyId: 2, earnedRate: 1 },
  ];
  assert.deepEqual(remainingValue(defs, [0]), { points: 108, count: 2 });
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

test('reproduces the observed points-per-trophy band', () => {
  // Every member card in the old screenshots lands between 8.6 and 10.6
  // points per trophy, implying an average rarity near 9-10%. A collection
  // built at that average rarity must land in the same band.
  const defs = Array.from({ length: 1000 }, (_, i) => ({
    trophyId: i,
    // spread around 10% the way a real library does
    earnedRate: [2, 5, 8, 10, 12, 15, 20, 30, 45, 60][i % 10],
  }));
  const total = gamePoints(defs, defs.map((d) => d.trophyId));
  const perTrophy = total / defs.length;
  assert.ok(
    perTrophy > 6 && perTrophy < 16,
    `expected the realistic 6-16 band, got ${perTrophy.toFixed(2)}`,
  );
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
