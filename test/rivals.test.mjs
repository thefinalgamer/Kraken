import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  MAX_RIVALS, parseRivals, serialiseRivals, addRival, removeRival,
} from '../shared/rivals.mjs';
import { rivalBlocks } from '../shared/ui.mjs';

/**
 * Rivals.
 *
 * The rules are in shared/ so they can be tested without building a fake
 * Discord interaction — which is the whole reason they are not sitting in the
 * command handler.
 */

test('a mangled column renders an empty list, never an error', () => {
  // The column is text written by an earlier version of this code. A member's
  // watchlist is a decoration; a row that cannot be parsed must not take their
  // card down with it.
  for (const bad of [null, undefined, '', 'not json', '{"a":1}', '[1,2,3]', '[null]', '42']) {
    assert.deepEqual(parseRivals(bad), [], `${String(bad)} should be no rivals`);
  }
  assert.deepEqual(parseRivals('["a","b"]'), ['a', 'b']);
});

test('a list that grew past the cap in an older build is truncated, not rejected', () => {
  const nine = JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  assert.equal(parseRivals(nine).length, MAX_RIVALS);
});

test('duplicates cannot survive a round trip', () => {
  assert.deepEqual(parseRivals(serialiseRivals(['a', 'a', 'b', 'b'])), ['a', 'b']);
});

test('you cannot watch yourself', () => {
  // The top row of the board is already you. Adding yourself would show you
  // twice and print "level with you" against your own name.
  const { error } = addRival([], 'me', { self: 'me' });
  assert.match(error, /already on your own list/);
});

test('adding somebody twice says so instead of silently doing nothing', () => {
  const { ids, error } = addRival(['a'], 'a', { name: 'Leon' });
  assert.deepEqual(ids, ['a'], 'the list is unchanged');
  assert.match(error, /Leon is already one of your rivals/);
});

test('the sixth rival is refused, and told how to make room', () => {
  const full = ['a', 'b', 'c', 'd', 'e'];
  const { ids, error } = addRival(full, 'f');
  assert.deepEqual(ids, full);
  assert.match(error, /limit/);
  assert.match(error, /\/rivals remove/, 'and names the way out');
});

test('an unknown hunter is a clear message, not a crash', () => {
  // The autocomplete offers real members, but somebody can type anything.
  const { error } = addRival([], undefined);
  assert.match(error, /could not find that hunter/);
});

test('removing somebody who is not on the list says so', () => {
  const { ids, error } = removeRival(['a'], 'z', { name: 'Chez' });
  assert.deepEqual(ids, ['a']);
  assert.match(error, /Chez is not on your list/);
});

test('removing works and leaves the rest alone', () => {
  const { ids, error } = removeRival(['a', 'b', 'c'], 'b');
  assert.equal(error, null);
  assert.deepEqual(ids, ['a', 'c']);
});

// ------------------------------------------------------------- the board ---

const ME = { psn_account_id: 'me', psn_online_id: 'th3finalgamer--', rank: 12, points: 186406,
  completion: 87.45 };
const THEM = [
  { psn_account_id: 'r1', psn_online_id: 'Pelziowo', rank: 1, points: 859207, completion: 94.7 },
  { psn_account_id: 'r2', psn_online_id: 'MRTheChez', rank: 40, points: 120000, completion: 61.2 },
  { psn_account_id: 'r3', psn_online_id: 'JFL__Leon', rank: 12, points: 186406, completion: 87.4 },
];

test('the board is sorted by rank and includes you', () => {
  // Sorted by rank rather than by gap, so the list does not reshuffle every
  // time somebody plays and you lose track of where people sit.
  const out = JSON.stringify(rivalBlocks(ME, THEM, 70));
  const order = ['Pelziowo', 'th3finalgamer', 'MRTheChez'];
  let last = -1;
  for (const name of order) {
    const i = out.indexOf(name);
    assert.ok(i > last, `${name} is out of rank order`);
    last = i;
  }
});

test('the board leads with the gap, because a gap is a target', () => {
  const out = JSON.stringify(rivalBlocks(ME, THEM, 70));
  assert.match(out, /672,801/, 'how far ahead the leader is');
  assert.match(out, /66,406/, 'how far behind Chez is');
  assert.match(out, /you/, 'and which row is yours');
});

test('somebody on identical points is level, not ahead or behind', () => {
  // JFL__Leon has exactly the same score. "0 ahead" would be nonsense.
  const out = JSON.stringify(rivalBlocks(ME, THEM, 70));
  assert.match(out, /level with you/);
});

test('a rival mid-first-scan cannot break the board', () => {
  // rivalRows filters on rank IS NOT NULL, but the renderer is defensive too:
  // it is the last thing between a half-written row and a member's card.
  const out = rivalBlocks(ME, [...THEM, { psn_account_id: 'x', psn_online_id: 'New', rank: null }], 70);
  assert.ok(!JSON.stringify(out).includes('"New"'));
});

test('the PSN id is escaped for Discord markdown', () => {
  // JFL__Leon is the name that broke the board once already: __x__ is underline
  // in Discord and PSN allows underscores.
  const out = JSON.stringify(rivalBlocks(ME, THEM, 70));
  assert.match(out, /JFL\\\\_\\\\_Leon/, 'the underscores are escaped');
});

test('the bot never tells anybody their rivals list is private', async () => {
  /**
   * The list renders on the hunter page, which anybody can open. The Discord
   * reply is still ephemeral, so "only you can see this message" stays true —
   * but the list it contains is not secret, and the bot said it was for as long
   * as the website half was unbuilt.
   *
   * Asserted against the source rather than a rendered reply because building a
   * whole interaction to read one footer is more fake than this is. If the
   * wording is ever softened back, this fails and asks why.
   */
  const src = await readFile(new URL('../worker/src/index.mjs', import.meta.url), 'utf8');
  const claims = src.match(/-# Private[^']*/g) || [];
  assert.deepEqual(claims, [], `the bot still promises privacy it does not keep: ${claims}`);
  assert.match(src, /the list shows on your hunter page/, 'and says where it actually shows');
});
