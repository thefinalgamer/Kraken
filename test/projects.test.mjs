import test from 'node:test';
import assert from 'node:assert/strict';

import { projectBlocks, blockChars } from '../shared/ui.mjs';

const member = { psn_online_id: 'th3finalgamer--', discord_id: '1' };

const game = (over = {}) => ({
  np_comm_id: 'NPWR001',
  title: 'Bloodborne',
  platform: 'PS4',
  icon_url: null,
  trophy_count: 41,
  max_points: 1847,
  local_started: 6,
  completed_here: 2,
  estimated: 0,
  unobtainable: 0,
  unobtainable_note: null,
  progress: 4,
  earned_total: 2,
  member_points: 30,
  days_taken: null,
  ...over,
});

/** Every TextDisplay in a block tree, flattened, so assertions can read it. */
const textOf = (block) => JSON.stringify(block);

test('one new game gets the full card', () => {
  const b = projectBlocks(member, 'new', [game()]);
  const s = textOf(b);
  assert.match(s, /th3finalgamer-- started Bloodborne/);
  assert.match(s, /41 trophies/);
  assert.match(s, /1,847 points at 100%/);
  assert.match(s, /6 own it/);
  assert.match(s, /2 finished/);
  assert.match(s, /Your progress\*\* 4%/);
});

test('a completion says where you came in', () => {
  const b = projectBlocks(member, 'completed', [game({ completed_here: 3, member_points: 1847, days_taken: 122 })]);
  const s = textOf(b);
  assert.match(s, /100%'d Bloodborne/);
  assert.match(s, /1,847 of 1,847 points/);
  assert.match(s, /122 days/);
});

test('the first person here to finish something is told so', () => {
  const b = projectBlocks(member, 'completed', [
    game({ completed_here: 1, member_points: 1847 }),
    game({ np_comm_id: 'NPWR002', title: 'Sekiro', completed_here: 1, member_points: 900 }),
  ]);
  assert.match(textOf(b), /first here to finish it/);
});

test('an unflagged game carries no warning, a flagged one does', () => {
  assert.doesNotMatch(textOf(projectBlocks(member, 'new', [game()])), /cannot be earned/);

  const flagged = projectBlocks(member, 'new', [
    game({ unobtainable: 1, unobtainable_note: 'Servers closed May 2024, 3 MP trophies.' }),
  ]);
  const s = textOf(flagged);
  assert.match(s, /cannot be earned/);
  assert.match(s, /Servers closed May 2024/);
});

test('a weekend of play is one message, not thirty', () => {
  // Martin asked for every new game to be announced, with no shovelware filter.
  // That is only survivable if a batch collapses into a single card — otherwise
  // somebody syncing a fortnight away buries the channel.
  const many = Array.from({ length: 30 }, (_, i) =>
    game({ np_comm_id: `NPWR${i}`, title: `Game ${i}`, max_points: 1000 - i }),
  );
  const b = projectBlocks(member, 'new', many);
  assert.equal(b.components.length, 1, 'one text block, not one section per game');
  assert.match(textOf(b), /started 30 games/);
});

test('the most valuable games survive truncation', () => {
  // Ordering is the caller's job, so this checks the card keeps the order it is
  // given rather than reversing it — the trimmed tail must be the cheap end.
  const many = Array.from({ length: 200 }, (_, i) =>
    game({ np_comm_id: `NPWR${i}`, title: `A very long game title number ${i}`, max_points: 5000 - i }),
  );
  const b = projectBlocks(member, 'new', many);
  const s = textOf(b);
  assert.match(s, /A very long game title number 0\b/, 'the priciest one is kept');
  assert.match(s, /and \d+ more/, 'and the rest are counted, not silently dropped');
  assert.ok(blockChars([b]) < 4000, 'inside Discord’s character limit');
});

test('nothing to announce means no card at all', () => {
  assert.equal(projectBlocks(member, 'new', []), null);
  assert.equal(projectBlocks(member, 'new', undefined), null);
});
