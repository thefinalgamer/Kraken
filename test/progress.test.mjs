import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { titleProgress } from '../jobs/lib/progress.mjs';

/**
 * PSN SOMETIMES SENDS 0% FOR A GAME WITH EVERY TROPHY EARNED.
 *
 * 22 September: Shinlight's update read "Completed: -2", because Tales of
 * Graces f (50/50) and Dengeki Bunko (59/59) came back at progress 0. A D1
 * check found Nurse_Feel_Good had two more. Four rows, all fully earned.
 */
const t = (progress, earned, defined) => ({ progress, earnedTrophies: earned, definedTrophies: defined });

test('Tales of Graces f: every trophy earned, PSN says 0, it is 100', () => {
  const all = { platinum: 1, gold: 2, silver: 10, bronze: 37 };
  assert.equal(titleProgress(t(0, all, all)), 100);
  assert.equal(titleProgress(t(undefined, all, all)), 100, 'a missing field is the same bug');
  assert.equal(titleProgress(t(null, all, all)), 100);
});

test('any real figure from Sony is still Sony\'s', () => {
  const def = { platinum: 1, gold: 2, silver: 10, bronze: 37 };
  assert.equal(titleProgress(t(41, { bronze: 20 }, def)), 41);
  assert.equal(titleProgress(t(102, def, def)), 100, 'and still clamped');
});

test('a zero with nothing earned is a real zero', () => {
  assert.equal(titleProgress(t(0, {}, { bronze: 30 })), 0);
});

test('partly earned and zeroed: worked out from the counts, never shown as 0', () => {
  const def = { platinum: 1, gold: 2, silver: 10, bronze: 37 };
  const p = titleProgress(t(0, { bronze: 10 }, def));
  assert.ok(p >= 1 && p < 100, `got ${p}`);
});

test('the scan uses it, so the completed count is right too', async () => {
  const src = await readFile(new URL('../jobs/scan.mjs', import.meta.url), 'utf8');
  assert.match(src, /t\.progress = titleProgress\(t\)/);
  assert.match(src, /const progress = titleProgress\(title\)/);
});

test('never above 100, never below 0', () => {
  assert.equal(titleProgress({ progress: 150 }), 100);
  assert.equal(titleProgress({ progress: -5 }), 0);
});
