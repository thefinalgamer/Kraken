import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * A GAME WITH NO NAME MUST NOT STOP A SCAN.
 *
 * 22 September, Pelziowo: 15,482 games, 152 to scan, and the run died on
 * "NOT NULL constraint failed: games.title" after twelve minutes. PSN had
 * returned a title with no `trophyTitleName`; the code turned that into null
 * and handed it to a NOT NULL column.
 *
 * Two things have to hold: nothing null ever reaches that column, and the
 * stand-in never overwrites a real title we already have. The second is an
 * upsert clause, so it is run here against a real SQLite rather than matched
 * as text.
 */
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const src = await readFile(new URL('../jobs/scan.mjs', import.meta.url), 'utf8');

test('no title from PSN means the id stands in, never null', () => {
  assert.match(src, /const titleOrId = \(title\) =>/);
  assert.match(src, /cleanTitle\(title\?\.trophyTitleName\) \?\? String\(title\?\.npCommunicationId/);
  assert.match(src, /titleOrId\(title\),/, 'and the insert binds it');
  assert.ok(!/cleanTitle\(title\.trophyTitleName\),/.test(src), 'the nullable version is gone from the binds');
});

/** The games upsert, lifted out of the scan and pointed at a real database. */
const upsert = () => {
  const from = src.indexOf('`INSERT INTO games');
  const to = src.indexOf('`,', from);
  return src
    .slice(from + 1, to)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

test('the stand-in never overwrites a title we already hold', { skip: !DatabaseSync }, () => {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE games (np_comm_id TEXT PRIMARY KEY, np_service_name TEXT, title TEXT NOT NULL,
      title_psn TEXT, title_locked INTEGER DEFAULT 0, platform TEXT, icon_url TEXT,
      trophy_count INTEGER, has_platinum INTEGER, max_points INTEGER, estimated INTEGER,
      completion_weight INTEGER, refreshed_at INTEGER);
  `);
  const sql = upsert();
  const run = (id, title) =>
    d.prepare(sql).run(id, 'NPWR_S', title, 'PS4', null, 10, 1, 100, 0, 100, Date.now());

  // First sight of a nameless game: it lands under its id rather than failing.
  run('NPWR123', 'NPWR123');
  assert.equal(d.prepare('SELECT title FROM games').get().title, 'NPWR123');

  // PSN answers properly later, and the real name takes over.
  run('NPWR123', 'Ratchet & Clank');
  assert.equal(d.prepare('SELECT title FROM games').get().title, 'Ratchet & Clank');

  // Then PSN has another bad day. The name must survive it.
  run('NPWR123', 'NPWR123');
  const row = d.prepare('SELECT title, title_psn FROM games').get();
  assert.equal(row.title, 'Ratchet & Clank', 'a nameless response never wipes a name');
  assert.equal(row.title_psn, 'Ratchet & Clank', "and Sony's own copy is kept too");
});

test('a locked title still wins over everything', { skip: !DatabaseSync }, () => {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE games (np_comm_id TEXT PRIMARY KEY, np_service_name TEXT, title TEXT NOT NULL,
      title_psn TEXT, title_locked INTEGER DEFAULT 0, platform TEXT, icon_url TEXT,
      trophy_count INTEGER, has_platinum INTEGER, max_points INTEGER, estimated INTEGER,
      completion_weight INTEGER, refreshed_at INTEGER);
  `);
  const sql = upsert();
  d.prepare(sql).run('NPWR9', 'NPWR_S', 'Sony Abbrev', 'PS4', null, 10, 1, 100, 0, 100, Date.now());
  d.prepare('UPDATE games SET title = ?, title_locked = 1').run('The Name Martin Set');
  d.prepare(sql).run('NPWR9', 'NPWR_S', 'Sony Abbrev', 'PS4', null, 10, 1, 100, 0, 100, Date.now());
  assert.equal(d.prepare('SELECT title FROM games').get().title, 'The Name Martin Set');
});
