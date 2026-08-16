import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trophyPoints,
  gamePoints,
  remainingValue,
  explainDelta,
  flatPoints,
  DEFAULT_SCORING,
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

test('never divides by zero on PSN reporting 0% for a brand-new trophy', () => {
  const pts = trophyPoints(0);
  assert.ok(Number.isFinite(pts));
  assert.equal(pts, DEFAULT_SCORING.cap);
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

test('a negative update is explained, not just reported', () => {
  // RabbitSquared's Update No. 94: three trophies earned, still lost 1,008.
  const d = explainDelta(184, -1008);
  assert.equal(d.earned, 184);
  assert.equal(d.drift, -1192);
  assert.ok(d.drift < 0, 'drift must be negative for the explanation to make sense');
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
