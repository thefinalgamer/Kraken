import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWeeklyDigest } from '../jobs/lib/digest.mjs';

/**
 * The weekly digest's rank movement.
 *
 * THE BUG THIS FILE EXISTS FOR. Movement was last week's board rank minus this
 * week's, which stops being zero-sum the moment the field changes size. One new
 * member landing at 30th pushes everybody below down a place: forty-five people
 * "fell", nobody climbed, and the card printed a Biggest fall with no Biggest
 * climber next to it.
 *
 * Batzclaw, in the server: "Do you have the biggest climber in ranking as I
 * noticed it had the biggest fall?" On a leaderboard those two are the same
 * event seen from both ends, so one without the other is always a bug.
 */

/** A db stub shaped like jobs/lib/d1.mjs, answering by what the SQL asks for. */
const fakeDb = ({ board, was }) => ({
  async one(sql) {
    if (/FROM members m/.test(sql)) return { c: 0 }; // nobody joined, unless said
    return { points: 5000, completed: 2, members: 3 };
  },
  async query(sql) {
    if (/FROM members/.test(sql)) return board;
    return []; // completions, contested
  },
  async getState() {
    return was;
  },
  async setState() {},
});

const member = (discord_id, psn_online_id, rank, points) =>
  ({ discord_id, psn_online_id, rank, points });

/** The rendered card as one string, so assertions can read it. */
const cardOf = (blocks) => JSON.stringify(blocks);

const run = (board, was) => buildWeeklyDigest(fakeDb({ board, was }));

test('a new member arriving does not push everybody into a fall', async () => {
  /**
   * The exact shape Batzclaw saw. Newbie joins at 2nd, so Bee and Cat each slip
   * one place on the raw board without doing a single thing. Nobody gained on
   * anybody, so there is no news, and the card must say nothing rather than
   * naming a faller who did nothing wrong.
   */
  const was = [
    ['1', { rank: 1, points: 900 }],
    ['2', { rank: 2, points: 800 }],
    ['3', { rank: 3, points: 700 }],
  ];
  const board = [
    member('1', 'Ant', 1, 900),
    member('9', 'Newbie', 2, 850),
    member('2', 'Bee', 3, 800),
    member('3', 'Cat', 4, 700),
  ];

  const card = cardOf(await run(board, was));
  assert.ok(!card.includes('Biggest fall'), 'nobody fell by standing still');
  assert.ok(!card.includes('Biggest climber'), 'and nobody climbed either');
});

test('a real overtake reports BOTH ends of it', async () => {
  /**
   * The half that has to keep working. Cat passed Bee on points, which is one
   * event seen from two sides, and a digest that names only one of them is the
   * bug from the other direction.
   */
  const was = [
    ['1', { rank: 1, points: 900 }],
    ['2', { rank: 2, points: 800 }],
    ['3', { rank: 3, points: 700 }],
  ];
  const board = [
    member('1', 'Ant', 1, 900),
    member('3', 'Cat', 2, 850),
    member('2', 'Bee', 3, 800),
  ];

  const card = cardOf(await run(board, was));
  assert.match(card, /Biggest climber/);
  assert.match(card, /Cat.*3rd.*2nd/s, 'and it prints their real board ranks');
  assert.match(card, /Biggest fall/);
  assert.match(card, /Bee/);
});

test('an overtake still reports both ends when somebody joined the same week', async () => {
  /**
   * The case that proves the fix rather than just the absence of the bug. Cat
   * genuinely passed Bee, AND a newcomer landed above all of them. The raw
   * board ranks are now shifted for everyone, and the real movement still has
   * to come through.
   */
  const was = [
    ['1', { rank: 1, points: 900 }],
    ['2', { rank: 2, points: 800 }],
    ['3', { rank: 3, points: 700 }],
  ];
  const board = [
    member('9', 'Newbie', 1, 5000),
    member('1', 'Ant', 2, 900),
    member('3', 'Cat', 3, 850),
    member('2', 'Bee', 4, 800),
  ];

  const card = cardOf(await run(board, was));
  assert.match(card, /Biggest climber/, 'the climb survives the newcomer');
  /**
   * Cat started 3rd and is still 3rd, because the newcomer took a place above
   * them at the same moment they took one from Bee. They moved; the ruler moved
   * with them. An arrow would print "3rd → 3rd", so the words say what happened.
   */
  assert.match(card, /Cat\*\* - up 1 place to 3rd/, 'phrased, not arrowed');
  assert.ok(!card.includes('3rd → 3rd'), 'and never as an arrow to itself');
  assert.match(card, /Biggest fall/);
  assert.match(card, /Bee/);
  // Ant slipped 1st -> 2nd on the raw board and did nothing. They are not news.
  assert.ok(!card.includes('Ant'), 'and the person merely displaced is not named');
});

test('somebody leaving does not promote everybody into a climb', async () => {
  // The mirror of the first case, and the one nobody would think to check.
  const was = [
    ['1', { rank: 1, points: 900 }],
    ['2', { rank: 2, points: 800 }],
    ['3', { rank: 3, points: 700 }],
  ];
  const board = [member('2', 'Bee', 1, 800), member('3', 'Cat', 2, 700)];

  const card = cardOf(await run(board, was));
  assert.ok(!card.includes('Biggest climber'), 'nobody earned that');
  assert.ok(!card.includes('Biggest fall'));
});

test('the first digest has no baseline and reports no movement', async () => {
  const board = [member('1', 'Ant', 1, 900), member('2', 'Bee', 2, 800)];
  const card = cardOf(await run(board, null));
  assert.ok(!card.includes('Biggest climber'));
  assert.ok(!card.includes('Biggest fall'));
});

test('the biggest mover wins, not the first one found', async () => {
  const was = [
    ['1', { rank: 1, points: 900 }],
    ['2', { rank: 2, points: 800 }],
    ['3', { rank: 3, points: 700 }],
    ['4', { rank: 4, points: 600 }],
  ];
  // Dog goes 4th to 1st, three places. Cat goes 3rd to 2nd, one place.
  const board = [
    member('4', 'Dog', 1, 1000),
    member('3', 'Cat', 2, 850),
    member('1', 'Ant', 3, 900),
    member('2', 'Bee', 4, 800),
  ];

  const card = cardOf(await run(board, was));
  assert.match(card, /Biggest climber.*Dog/s);
  assert.ok(!/Biggest climber[^\n]*Cat/.test(card), 'the smaller climb is not the headline');
  // Ant fell two places by being passed twice, Bee fell two as well; either is a
  // real fall. What matters is that a fall was found at all.
  assert.match(card, /Biggest fall/);
});
