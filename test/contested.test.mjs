import test from 'node:test';
import assert from 'node:assert/strict';

import { contestedBlocks, digestBlocks, blockChars } from '../shared/ui.mjs';
import {
  rankContested,
  CONTESTED_SQL,
  CONTESTED_LIMIT,
  CONTESTED_MIN_OWNERS,
} from '../shared/contested.mjs';
import { localMultiplier } from '../shared/scoring.mjs';

const s = (block) => JSON.stringify(block);

// --------------------------------------------------------------- ranking ---

test('the multiplier shown is the one the scoring uses', () => {
  const [row] = rankContested([{ title: 'Bloodborne', local_started: 7, platted_here: 1 }]);
  assert.equal(row.multiplier, localMultiplier(1, 7));
  assert.ok(row.multiplier > 1, 'a game nobody has finished pays more than normal');
});

test('a settled game is back to ×1', () => {
  // Everyone who owns it has platted it. Nothing to be stuck on.
  const [row] = rankContested([{ title: 'Sekiro', local_started: 5, platted_here: 5 }]);
  assert.equal(row.multiplier, 1);
});

test('the SQL asks for exactly two parameters, in the documented order', () => {
  // The Worker and the rescore both bind (minOwners, limit) positionally, so a
  // stray placeholder here would silently swap them and return one row.
  assert.equal((CONTESTED_SQL.match(/\?/g) ?? []).length, 2);
  assert.match(CONTESTED_SQL, /local_started >= \?/);
  assert.match(CONTESTED_SQL, /LIMIT \?/);
  // The three exclusions that keep the board meaningful.
  assert.match(CONTESTED_SQL, /type = 'platinum'/);
  assert.match(CONTESTED_SQL, /max_points > 0/);
  assert.match(CONTESTED_SQL, /local_earned < g\.local_started/);
});

test('Martin asked for ten', () => {
  assert.equal(CONTESTED_LIMIT, 10);
  assert.ok(CONTESTED_MIN_OWNERS >= 3, 'a contest needs a crowd');
});

// ------------------------------------------------------------ the board ----

const game = (over = {}) => ({
  title: 'Bloodborne',
  local_started: 7,
  platted_here: 1,
  multiplier: 2.41,
  unobtainable: 0,
  ...over,
});

test('the board counts who is still in it', () => {
  const out = s(contestedBlocks([game()]));
  assert.match(out, /Contested right now/);
  assert.match(out, /Bloodborne/);
  assert.match(out, /×2\.41/);
  assert.match(out, /7 own it/);
  assert.match(out, /1 platted/);
  assert.match(out, /6\*\* still in it/);
});

test('an empty board says so rather than showing nothing', () => {
  const out = s(contestedBlocks([]));
  assert.match(out, /Nothing is contested/);
});

test('ten games fit inside a Discord message', () => {
  const rows = Array.from({ length: CONTESTED_LIMIT }, (_, i) =>
    game({ title: `A fairly long game title, number ${i}`, multiplier: 3 - i / 10 }),
  );
  const block = contestedBlocks(rows);
  assert.ok(blockChars([block]) < 4000, 'inside the 4,000-character limit');
});

test('a flagged game carries its warning onto the board', () => {
  assert.match(s(contestedBlocks([game({ unobtainable: 1 })])), /⚠️/);
});

// ---------------------------------------------------------------- digest ---

const week = (over = {}) => ({
  range: '18 – 25 August',
  climber: { onlineId: 'N7_Maxxi', from: 7, to: 4, points: 18204 },
  faller: { onlineId: 'Ragowit', from: 9, to: 12 },
  rarestPlat: { title: 'Bloodborne', rate: 0.42, onlineId: 'LucasDiasC' },
  toughest: { title: 'Sekiro', points: 2140, onlineId: 'RabbitSquared' },
  contested: { title: 'Bloodborne', stuck: 6 },
  completed: 14,
  points: 214880,
  members: 63,
  joined: 4,
  ...over,
});

test('a full week prints every line', () => {
  const out = s(digestBlocks(week()));
  assert.match(out, /The week on Platinum Intel/);
  // N7\\_Maxxi, not N7_Maxxi: the underscore is escaped so Discord prints it
  // instead of reading _Maxxi_ as the start of an italic run.
  assert.match(out, /N7\\\\_Maxxi.*7th.*4th/);
  assert.match(out, /Ragowit/);
  assert.match(out, /0\.42%/);
  assert.match(out, /Sekiro/);
  assert.match(out, /14\*\* games taken to 100%/);
  assert.match(out, /63 of us/);
  assert.match(out, /4\*\* joined/);
});

test('crossing a completion point is deliberately not in it', () => {
  // Martin: "i would remove Crossed a point it will end up getting too
  // cluttered". With sixty-odd members it would have been half the card.
  assert.doesNotMatch(s(digestBlocks(week())), /[Cc]rossed a point/);
});

test('the first digest has no movement to report and drops those lines', () => {
  // No snapshot from last week means no baseline. Printing "Biggest climber:
  // nobody" reads as a broken bot; leaving it out reads as a quiet week.
  const out = s(digestBlocks(week({ climber: null, faller: null })));
  assert.doesNotMatch(out, /Biggest climber/);
  assert.doesNotMatch(out, /Biggest fall/);
  assert.match(out, /Finished/, 'the rest of the card still prints');
});

test('an empty week still renders a card that reads like English', () => {
  const out = s(
    digestBlocks({
      range: '18 – 25 August',
      climber: null, faller: null, rarestPlat: null, toughest: null, contested: null,
      completed: 0, points: 0, members: 0, joined: 0,
    }),
  );
  assert.match(out, /exactly where you left it/);
});
