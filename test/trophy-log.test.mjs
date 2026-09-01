import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The trophy log write.
 *
 * There is no feature on top of this yet, on purpose: the recent-trophy strip
 * cannot show anything until weeks of rows exist, and the write had to ship
 * first because the data is only free going forward. These tests exist so the
 * write does not quietly rot in the gap between now and then.
 */
const scan = await readFile(new URL('../jobs/scan.mjs', import.meta.url), 'utf8');
const migration = await readFile(new URL('../migrations/016-trophy-log.sql', import.meta.url), 'utf8');

const block = scan.slice(scan.indexOf('THE TROPHY LOG'), scan.indexOf('const gained ='));

test('the log is a table of its own, keyed per member', () => {
  // `trophies` is the GAME's trophy list, shared by everybody who owns it.
  // When a given member earned one is per member, so it cannot live there.
  assert.match(migration, /CREATE TABLE IF NOT EXISTS member_trophies/);
  assert.match(migration, /PRIMARY KEY \(psn_account_id, np_comm_id, trophy_id\)/,
    'one row per member per trophy, so a rescan cannot duplicate');
  assert.match(migration, /ON member_trophies\(psn_account_id, earned_at DESC\)/,
    'the only question it will be asked is "what did they earn most recently"');
});

test('an existing game logs only what is new', () => {
  // The prior row already carries earned_ids and the scan already loads it, so
  // the diff costs nothing. Writing the whole list every scan would rewrite
  // thousands of unchanged rows a night.
  assert.match(block, /previouslyHad\.has\(t\.id\)/, 'diffed against what they had');
  assert.match(block, /JSON\.parse\(was\.earned_ids\)/, 'from the row already in hand');
});

test('a game seen for the first time is capped to ninety days', () => {
  /**
   * Without the cap, one newcomer's first scan writes their entire history:
   * MRTheChez owns 1,512 games. The board already runs near half of D1's
   * monthly write allowance, and ninety days is everything the strip will ever
   * show, so the rest would be paid for and never read.
   */
  assert.match(block, /90 \* 24 \* 60 \* 60 \* 1000/, 'ninety days');
  assert.match(block, /t\.earnedAt >= floor/, 'and it gates the first-sight branch');
});

test('a mangled earned_ids column does not get read as "all of it"', () => {
  // If we cannot tell what they had before, treating the game as unseen and
  // letting the cap decide is safe. Assuming they had nothing would write their
  // whole history for that game.
  assert.match(block, /previouslyHad = null/, 'unknown rather than empty');
  const parse = block.slice(block.indexOf('JSON.parse'), block.indexOf('const CAP_MS'));
  assert.match(parse, /catch/, 'a bad column is caught');
  assert.ok(!/previouslyHad = new Set\(\)/.test(block), 'never falls back to an empty set');
});

test('the write can never take a scan down', () => {
  /**
   * A scan that dies because migration 016 has not been run yet would stop the
   * nightly job over a decoration. This is the same seatbelt the game page uses
   * for its own missing columns.
   */
  assert.match(block, /try \{/, 'the whole write is guarded');
  assert.match(block, /catch \(err\)/, 'and the failure is caught');
  assert.match(block, /trophy log skipped/, 'and said out loud in the log');
});

test('a rescan keeps the date it first recorded', () => {
  // A rescan re-offers trophies already logged. The stored date is the one to
  // keep: PSN's own earnedDateTime does not change, but INSERT OR REPLACE would
  // churn the row for nothing.
  assert.match(block, /INSERT OR IGNORE INTO member_trophies/);
});

test('nothing renders from the log yet, and that is deliberate', async () => {
  /**
   * A placeholder sitting empty on seventy profiles is worse than no strip. The
   * page will render it once there are rows to render, which is why no site
   * code touches this table today. If that changes, this test should be the
   * thing that gets deleted along with it.
   */
  const page = await readFile(new URL('../functions/_lib/page.js', import.meta.url), 'utf8');
  const hunter = await readFile(new URL('../functions/hunter/[name].js', import.meta.url), 'utf8');
  for (const [name, src] of [['page.js', page], ['hunter', hunter]]) {
    assert.ok(!src.includes('member_trophies'), `${name} reads the log before it has anything in it`);
  }
});
