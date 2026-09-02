import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Titles are stored clean.
 *
 * THE BUG THIS EXISTS FOR was invisible from every angle a person could look
 * at it. PSN sends Uncharted 2 on PS3 as "Uncharted 2: Among Thieves™ ",
 * with a space on the end, and the scan stored it exactly as sent. Discord
 * trims whatever it sends back, so the value out of the game dropdown was one
 * character shorter than the row it came from, and every exact match on that
 * title missed.
 *
 * What JFL__Leon saw: the game dropdown offered Uncharted 2, he picked it, and
 * the version and trophy dropdowns underneath both said "No options match your
 * search" for a game with 23 owners and 71 trophies. Nothing in the reply, no
 * error, no clue. It took a LENGTH(title) in the D1 console to see it: 28
 * characters where the title is 27.
 *
 * The stray space also splits the autocomplete's GROUP BY title, so the same
 * game appears twice in the list looking identical both times.
 */
const scan = await readFile(new URL('../jobs/scan.mjs', import.meta.url), 'utf8');

/** The helper, extracted and run rather than pattern-matched. */
const cleanTitle = (() => {
  const line = scan.split('\n').find((l) => l.startsWith('const cleanTitle ='));
  assert.ok(line, 'the scan still has a cleanTitle');
  // eslint-disable-next-line no-eval
  return eval(`(${line.slice(line.indexOf('=') + 1).replace(/;\s*$/, '')})`);
})();

test('a trailing space never reaches the database', () => {
  assert.equal(cleanTitle('Uncharted 2: Among Thieves™ '), 'Uncharted 2: Among Thieves™');
  assert.equal(cleanTitle('  Bloodborne  '), 'Bloodborne');
});

test('runs of whitespace collapse, including the non-breaking kind', () => {
  // PSN uses U+00A0 in a handful of Japanese titles, which looks identical on
  // screen and matches nothing anybody types.
  assert.equal(cleanTitle('Sly 3:  Honor Among Thieves'), 'Sly 3: Honor Among Thieves');
  assert.equal(cleanTitle('Yakuza 5'), 'Yakuza 5');
});

test('a title that is nothing but whitespace stays NULL', () => {
  // The empty string would pass the autocomplete filters that exist to keep
  // blank rows out of the dropdown, and print as a nameless row on the site.
  assert.equal(cleanTitle('   '), null);
  assert.equal(cleanTitle(null), null);
  assert.equal(cleanTitle(undefined), null);
});

test('an ordinary title is returned untouched', () => {
  for (const t of ['Bloodborne', 'Uncharted 2: Among Thieves™ Remastered', 'LittleBigPlanet 3']) {
    assert.equal(cleanTitle(t), t);
  }
});

test('the scan writes the cleaned title, not the raw one', () => {
  /**
   * The helper is worthless if the INSERT still binds the raw field, and this
   * is the exact shape of a mistake already made once in this codebase: an
   * edit script that threw part way through left functions/games.js selecting
   * a column the code below it had already stopped expecting.
   */
  const at = scan.indexOf('INSERT INTO games');
  // Bounded FROM the insert, not from the top of the file. `needsNames` also
  // appears in the function signature above it, so a plain indexOf hands back
  // an empty slice and every assertion below passes on nothing.
  const insert = scan.slice(at, scan.indexOf('needsNames', at));
  assert.ok(insert.length > 200, 'the slice actually covers the write');
  assert.match(insert, /cleanTitle\(title\.trophyTitleName\)/, 'the games row is cleaned');
  assert.ok(
    !/^\s*title\.trophyTitleName,$/m.test(insert),
    'and the raw field is not bound anywhere in that write',
  );
});
