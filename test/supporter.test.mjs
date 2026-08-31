import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The supporter star.
 *
 * THE FIRST TEST IN THIS FILE IS THE IMPORTANT ONE. Everything else here is
 * about a glyph; that one is about whether money can move a row on the board.
 */
import { supporterTier, supporterLabel, SUPPORTER_TIERS } from '../shared/supporter.mjs';
import { supporterMark } from '../shared/ui.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('nothing in the scoring reads a supporter column', () => {
  // A star is a thank-you. The moment points, rank, tier or an ORDER BY depends
  // on months paid, the board stops being a record of what people earned and
  // becomes something you can buy into — and that is the one thing it cannot
  // survive being. This test is the line, in a place a refactor has to notice.
  for (const file of [
    '../shared/scoring.mjs',
    '../jobs/rescore.mjs',
    '../jobs/scan.mjs',
    '../shared/contested.mjs',
  ]) {
    assert.ok(
      !/supporter/i.test(read(file)),
      `${file} mentions supporters — scoring must never read them`,
    );
  }

  // And the board's own query may select the column to draw it, but must not
  // order by it.
  const board = read('../functions/leaderboard.js');
  assert.ok(board.includes('supporter_months'), 'the board reads it to draw the star');
  assert.ok(
    !/ORDER BY[\s\S]{0,120}supporter/i.test(board),
    'but never sorts by it',
  );
});

test('the tiers step at 1, 3, 6 and 12 months', () => {
  assert.equal(supporterTier(0), null, 'nobody starts with a star');
  assert.equal(supporterTier(1).name, 'Bronze');
  assert.equal(supporterTier(2).name, 'Bronze');
  assert.equal(supporterTier(3).name, 'Silver');
  assert.equal(supporterTier(5).name, 'Silver');
  assert.equal(supporterTier(6).name, 'Gold');
  assert.equal(supporterTier(11).name, 'Gold');
  assert.equal(supporterTier(12).name, 'Platinum');
  assert.equal(supporterTier(400).name, 'Platinum', 'and it stops at the top');
});

test('a missing or nonsense month count is simply not a supporter', () => {
  // This runs inside a table row on a page that must render for everybody. A
  // decoration is never worth a broken page.
  for (const bad of [null, undefined, '', 'lots', NaN, -5, {}]) {
    assert.equal(supporterTier(bad), null, `${String(bad)} should be no star`);
  }
});

test('the star only ever goes up', () => {
  // Permanent by construction: the tier is derived from a total that a mod only
  // ever raises, so nobody has one taken off them and the site never has to
  // know whether a payment is still live.
  const months = SUPPORTER_TIERS.map((t) => t.months);
  assert.deepEqual(months, [...months].sort((a, b) => b - a), 'thresholds descend');
  let last = 0;
  for (let m = 1; m <= 24; m++) {
    const rank = SUPPORTER_TIERS.length - SUPPORTER_TIERS.indexOf(supporterTier(m));
    assert.ok(rank >= last, `tier went backwards at ${m} months`);
    last = rank;
  }
});

test('the label names the tier and the months', () => {
  assert.equal(supporterLabel(1), 'Bronze supporter · 1 month');
  assert.equal(supporterLabel(8), 'Gold supporter · 8 months');
  assert.equal(supporterLabel(0), '');
});

test('Discord gets a plain star, never a trophy emoji', () => {
  // The four metal emoji are TROPHY emoji. The gold one beside a name would say
  // "gold trophies" on a card already covered in trophy counts.
  assert.equal(supporterMark(8), ' ⭐');
  assert.equal(supporterMark(0), '');
  assert.ok(!supporterMark(12).includes(':gold:'));
  assert.ok(!supporterMark(12).includes(':platinum:'));
});

test('the mod command sets a total rather than adding to one', () => {
  // Re-running a command after Discord times out is the most ordinary thing in
  // the world and it must never double somebody's star.
  const db = read('../worker/src/db.mjs');
  const fn = db.slice(db.indexOf('export async function setSupporter'));
  assert.match(fn.slice(0, 900), /SET supporter_months = \?/, 'assigns, never increments');
  assert.ok(!/supporter_months\s*\+/.test(fn.slice(0, 900)), 'no += anywhere');
});

test('the confirmation tells the mod it is cosmetic', () => {
  // The pressure to make supporters "worth something" arrives later and always
  // sounds reasonable at the time. The place to hold the line is where the
  // decision gets made, not in a comment nobody opens.
  const worker = read('../worker/src/index.mjs');
  const fn = worker.slice(worker.indexOf('async function setSupporterStar'));
  assert.match(fn.slice(0, 2200), /Cosmetic only/);
  assert.match(fn.slice(0, 2200), /points, rank, tier/);
});

test('the star is drawn wherever a name is drawn', () => {
  for (const [file, what] of [
    ['../functions/leaderboard.js', 'the board'],
    ['../functions/hunter/[name].js', 'a hunter page'],
    ['../shared/ui.mjs', 'the Discord card'],
  ]) {
    assert.match(read(file), /supporter/i, `${what} does not show the star`);
  }
});
