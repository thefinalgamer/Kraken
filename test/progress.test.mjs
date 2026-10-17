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
  assert.match(src, /let progress = titleProgress\(title\)/);
});

test('never above 100, never below 0', () => {
  assert.equal(titleProgress({ progress: 150 }), 100);
  assert.equal(titleProgress({ progress: -5 }), 0);
});

test('an empty title entry is re-derived from the trophies we fetched ourselves', async () => {
  /**
   * Shinlight, 17 October: "With my last update I got a game that gone from
   * 100% to 0%. The game is Monster of the Deep: Final Fantasy XV Chinese
   * Stack." He held all 36 of 36 and the row still said 36 — the percentage
   * was the only casualty.
   *
   * titleProgress repairs a zero that disagrees with the counts beside it. It
   * cannot repair a title entry with NO counts: with nothing to weigh it hands
   * the zero back, which is the honest answer from that source. Sony had sent
   * the whole entry empty, which is also why his changelog line read
   * NPWR14023_00 rather than a name.
   *
   * Inside scanGame() there is a better source already in hand — the per-game
   * trophy call that found the 36 — so the same function runs again over counts
   * we did the counting for. One row in the database had this.
   */
  const scan = await readFile(new URL('../jobs/scan.mjs', import.meta.url), 'utf8');
  const code = scan.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  assert.match(code, /if \(progress === 0 && mine\.length\)/, 'only when Sony gave us nothing');
  assert.match(code, /for \(const t of rated\) if \(defined\[t\.type\]/, 'counts the list itself');
  assert.match(
    code,
    /titleProgress\(\{ progress: 0, earnedTrophies: counts, definedTrophies: defined \}\)/,
    'and reuses the tested function rather than inventing a second one',
  );
});

test('all of them earned is a hundred, whatever the title entry said', () => {
  // Shinlight's exact shape, through the function that now gets the counts.
  const all = { platinum: 1, gold: 2, silver: 8, bronze: 25 };
  assert.equal(titleProgress({ progress: 0, earnedTrophies: all, definedTrophies: all }), 100);

  // And a part-finished one is weighted, never zero and never a hundred.
  const some = { platinum: 0, gold: 1, silver: 2, bronze: 5 };
  const got = titleProgress({ progress: 0, earnedTrophies: some, definedTrophies: all });
  assert.ok(got > 0 && got < 100, `expected a real percentage, got ${got}`);
});
