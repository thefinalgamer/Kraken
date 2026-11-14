import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  searchKey, searchTerm, titleMatchSql, titleContains, titleStartsWith,
} from '../shared/search.mjs';

/**
 * TYPING A GAME'S NAME SHOULD FIND THE GAME.
 *
 * PrimalxFear, 14 November: *"I noticed that you need to type special
 * characters when searching a game like Far Cry 6. if you search Far Cry 6 you
 * cannot find the game. is there a way to fix this so it searches without
 * special characters?"*
 *
 * Search was `title LIKE '%far cry 6%'` against a stored `Far Cry(R) 6`. The
 * (R) sits between "Cry" and " 6", so the substring never matched. The query
 * was fine; the title holds a character nobody types.
 *
 * Measured before building: 3,030 of the 9,787 games on the index page carry a
 * symbol, apostrophe or colon that a natural search could miss. A third of what
 * a member can browse was unreachable by name.
 *
 * EVERY TITLE BELOW IS A REAL ROW out of the live database, and the typed form
 * beside it is what a person would actually write. Every single pair failed
 * before migration 043.
 */

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

/** [ stored title, what somebody types ] */
const REAL = [
  ['Far Cry® 6', 'far cry 6'],
  ['EA SPORTS™UFC®3', 'ea sports ufc 3'],
  ['Crysis®2', 'crysis 2'],
  ['LittleBigPlanet™2', 'littlebigplanet 2'],
  ["Assassin's Creed® Chronicles: China", 'assassins creed chronicles china'],
  ['Uncharted 4: A Thief’s End™', "a thief's end"],
  ["Marvel's Spider-Man 2", 'marvels spider man 2'],
  ['F.E.A.R. 2: Project Origin', 'fear 2'],
  ['Warhammer 40,000: Darktide', 'warhammer 40000'],
  ['Ghost of Yōtei', 'ghost of yotei'],
  ['ABZÛ', 'abzu'],
  ['Little Dragons Café', 'little dragons cafe'],
  ['DARK SOULS™ Ⅱ: Scholar of the First Sin', 'dark souls ii scholar'],
  ['Disney•Pixar Toy Story Mania!', 'disney pixar toy story'],
  ['WATCH_DOGS® 2', 'watch dogs 2'],
  ['Tom Clancy’s The Division®2', 'tom clancys the division 2'],
  ['Ratchet & Clank: Rift Apart', 'ratchet clank rift apart'],
  ['女神異聞錄３ Reload', '3 reload'],
];

test('every one of these is a real title that could not be found by typing it', () => {
  for (const [title, typed] of REAL) {
    assert.ok(
      searchKey(title).includes(searchKey(typed)),
      `${JSON.stringify(title)} keyed as "${searchKey(title)}", which does not contain "${searchKey(typed)}"`,
    );
  }
});

test('and the old comparison genuinely missed them, so this is not a tautology', () => {
  /**
   * The guard on the guard. A normaliser that returned the empty string would
   * pass the test above for every row in the table, so prove the pairs were
   * actually broken: the raw substring test is what shipped until today, and
   * not one of these would have matched under it.
   */
  const missed = REAL.filter(([title, typed]) => !title.toLowerCase().includes(typed.toLowerCase()));
  assert.equal(missed.length, REAL.length, 'every pair above failed the old raw LIKE');
});

test('a symbol between two words becomes a gap, never nothing', () => {
  // `EA SPORTS(TM)UFC(R)3` has no spaces in it at all. Deleting the marks gives
  // "easportsufc3", which is no more typeable than what we started with.
  assert.equal(searchKey('EA SPORTS™UFC®3'), 'ea sports ufc 3');
  assert.equal(searchKey('Crysis®2'), 'crysis 2');
});

test('an apostrophe vanishes instead, because "marvel s" is nobody\'s search', () => {
  assert.equal(searchKey("Marvel's Spider-Man"), 'marvels spider man');
  // Both apostrophes are in use in the live data, so both have to land here.
  assert.equal(searchKey('Uncharted 4: A Thief’s End™'), searchKey("Uncharted 4: A Thief's End"));
  // Full stops come along for the ride and pay for themselves.
  assert.equal(searchKey('F.E.A.R. 2'), 'fear 2');
  assert.equal(searchKey('Dr. Mario'), 'dr mario', 'the space survives the full stop');
});

test('(TM) is removed before the normalising, not after', () => {
  /**
   * NFKC maps (TM) to the letters "tm". Normalising first would key
   * `DARK SOULS(TM): REMASTERED` as "dark souls tm remastered", which is still
   * unfindable by anybody searching for it. Order of operations, in one assert.
   */
  assert.equal(searchKey('DARK SOULS™: REMASTERED'), 'dark souls remastered');
  assert.ok(!searchKey('HEAVY RAIN™').includes('tm'), 'no stray letters left behind');
});

test('the single-character Roman numerals are real, and 17 games use them', () => {
  // `DARK SOULS(TM) II` does not contain two capital i's. It contains U+2161.
  assert.notEqual('Ⅱ', 'II', 'the fixture really is the single character');
  assert.equal(searchKey('DARK SOULS™ Ⅱ'), 'dark souls ii');
});

test('accents come off Latin, and stay on everything else', () => {
  assert.equal(searchKey('Ghost of Yōtei'), 'ghost of yotei');
  assert.equal(searchKey('ABZÛ'), 'abzu');

  /**
   * THE WART THIS AVOIDS. Decomposing the whole string and dropping every
   * combining mark is the obvious way to fold accents, and it also strips the
   * dakuten off Japanese kana: マブラヴ becomes マフラウ, a different word
   * matching nothing a reader would type. Hence the Latin-only sweep.
   */
  assert.equal(searchKey('マブラヴ photonmelodies♮'), 'マブラヴ photonmelodies');
  assert.ok(searchKey('金色ラブリッチェ').includes('ラブリッチェ'), 'kana survive intact');
});

test('a title that is nothing but decoration keys as empty, and says so', () => {
  assert.equal(searchKey('???'), '');
  assert.equal(searchKey('   '), '');
  assert.equal(searchKey(null), '');
  // '' is a real answer meaning "there is nothing typeable here", and the
  // callers treat it as no search rather than as a search for nothing.
  assert.equal(searchTerm('!!!'), '', 'not "%%", which would return the whole table');
});

test('35 titles carry a newline, and it is just more whitespace', () => {
  // `(root)Letter` is stored with one on the end. It broke nothing visible,
  // which is how it survived this long.
  assert.equal(searchKey('√Letter\n'), 'letter');
  assert.equal(searchKey('a\tb'), 'a b');
});

test('LIKE wildcards cannot survive into the term', () => {
  // Somebody typing "100%" must not match every game on the board.
  assert.equal(searchTerm('100%'), '%100%', 'the percent is gone, not escaped');
  assert.equal(searchTerm('a_b'), '%a b%');

  // The raw fallback arm still escapes, because it compares the untouched title.
  assert.deepEqual(titleContains('100%_x'), ['%100 x%', '%100\\%\\_x%']);
});

test('the fragment carries both arms and both are bound', () => {
  const sql = titleMatchSql('g.');
  assert.match(sql, /g\.title_search LIKE \? ESCAPE/, 'the key arm');
  assert.match(sql, /g\.title_search IS NULL AND g\.title LIKE \?/, 'and the pre-backfill fallback');
  assert.equal(titleContains('x').length, 2, 'two arms, two arguments');
  assert.equal(titleStartsWith('x').length, 2);
  assert.deepEqual(titleStartsWith('Far Cry'), ['far cry%', 'Far Cry%']);
});

/* ---- the two halves of the write path ---- */

test('the search key follows the title through the same CASE, branch for branch', async () => {
  /**
   * THE DRIFT THIS CATCHES. `title` and `title_search` are decided by two CASE
   * expressions in the games upsert, and they have to agree: the title is what
   * a member sees and the key is what they search by, so a branch where the two
   * disagree is a game displayed under one name and findable under another.
   *
   * Keeping a locked title while taking Sony's key would make /flag namechange
   * appear to work and quietly break search for that game. Anybody adding a
   * condition to one CASE has to add it to the other, and this is what says so.
   */
  const src = await readFile(new URL('../jobs/scan.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');

  const branch = (col) => {
    const at = code.indexOf(`\n         ${col} = CASE`);
    assert.ok(at > -1, `${col} is not written by a CASE any more`);
    return code.slice(at, code.indexOf(' END,', at) + ' END'.length);
  };

  const title = branch('title');
  const key = branch('title_search');
  assert.equal(
    (key.match(/WHEN /g) ?? []).length,
    (title.match(/WHEN /g) ?? []).length,
    'the two CASE expressions have drifted apart - see migration 043',
  );
  assert.match(key, /games\.title_locked = 1 THEN games\.title_search/, 'a locked key is kept');
  assert.match(key, /ELSE excluded\.title_search END/, 'and otherwise Sony wins, as with the title');
  assert.match(code, /searchKey\(titleOrId\(title\)\),/, 'and the insert binds it');
});

test('a rename rewrites the key from the title that actually landed', async () => {
  /**
   * Both branches of renameGame need this and only one could compute it up
   * front: the unlock branch restores `COALESCE(title_psn, title)`, decided
   * inside SQL and different per row when the rename matched on title and
   * caught a whole stack of editions. Reading the result back is the one
   * version that is right for both.
   */
  const src = await readFile(new URL('../worker/src/db.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /UPDATE games SET title_search = \? WHERE np_comm_id = \?/);
  assert.match(code, /\.bind\(searchKey\(g\.title\), g\.np_comm_id\)/, 'from the row, not from the input');
});

/* ---- end to end, against a real database ---- */

test('Far Cry 6 is findable by typing Far Cry 6', { skip: !DatabaseSync }, () => {
  /**
   * The whole report, run against real SQLite with the real fragment and the
   * real arguments. Nothing here is a stand-in except the size of the table.
   */
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE games (np_comm_id TEXT PRIMARY KEY, title TEXT, title_search TEXT)');
  const add = d.prepare('INSERT INTO games VALUES (?,?,?)');
  REAL.forEach(([title], i) => add.run(`NPWR${i}`, title, searchKey(title)));

  const find = (typed) =>
    d.prepare(`SELECT title FROM games WHERE ${titleMatchSql()}`).all(...titleContains(typed));

  assert.deepEqual(find('far cry 6').map((r) => r.title), ['Far Cry® 6']);
  assert.deepEqual(find('Far Cry 6').map((r) => r.title), ['Far Cry® 6'], 'and the case is ignored');
  assert.deepEqual(find('marvels spider man').map((r) => r.title), ["Marvel's Spider-Man 2"]);
  assert.deepEqual(find('ghost of yotei').map((r) => r.title), ['Ghost of Yōtei']);
  assert.equal(find('a game nobody owns').length, 0, 'and it still says no when it means no');
});

test('the fallback arm keeps search working before the backfill has run', { skip: !DatabaseSync }, () => {
  /**
   * Migration 043 adds the column; `npm run backfill-search` fills it. Between
   * the two, every key is NULL. Without the second arm the search box would
   * return nothing at all for everybody during that window, which is a worse
   * regression than the bug being fixed.
   */
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE games (np_comm_id TEXT PRIMARY KEY, title TEXT, title_search TEXT)');
  d.prepare('INSERT INTO games VALUES (?,?,NULL)').run('NPWR1', 'Far Cry® 6');

  const find = (typed) =>
    d.prepare(`SELECT title FROM games WHERE ${titleMatchSql()}`).all(...titleContains(typed));

  assert.equal(find('far cry').length, 1, 'the old behaviour still works');
  assert.equal(find('far cry 6').length, 0, 'including the old bug, which the backfill is what fixes');

  d.prepare('UPDATE games SET title_search = ?').run(searchKey('Far Cry® 6'));
  assert.equal(find('far cry 6').length, 1, 'and the moment the key lands, it is fixed');
});
