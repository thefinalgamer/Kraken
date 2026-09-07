import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renameGame } from '../worker/src/db.mjs';

/**
 * `/flag namechange:` and the lock behind it.
 *
 * THE BUG THIS FEATURE FIXES IS A SILENT ONE. Sony's abbreviations land in
 * `games.title` and two of them were wrong enough that Leon reported them. The
 * obvious fix - edit the row in the D1 console - works right up until anybody
 * who owns the game runs /update, because the scan's upsert ends
 * `title = excluded.title` and Sony's name walks back in with nothing to show
 * that it did.
 *
 * So the half of this worth testing hardest is not the command. It is that a
 * locked title SURVIVES THE SCAN'S OWN SQL, which is why the upsert below is
 * read out of jobs/scan.mjs rather than retyped: a test that asserts against a
 * copy of the statement passes forever while the real one drifts.
 */
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Older Node. The SQL tests skip; the source checks do not.
}
const needsSqlite = { skip: DatabaseSync ? false : 'node:sqlite needs Node 22.5 or newer' };

const SCAN = readFileSync(fileURLToPath(new URL('../jobs/scan.mjs', import.meta.url)), 'utf8');
const WORKER = readFileSync(
  fileURLToPath(new URL('../worker/src/index.mjs', import.meta.url)),
  'utf8',
);
const MIGRATION = readFileSync(
  fileURLToPath(new URL('../migrations/026-title-override.sql', import.meta.url)),
  'utf8',
);

/**
 * A D1-shaped face on node:sqlite, because worker/src/db.mjs speaks
 * prepare().bind().all()/first()/run() and nothing else.
 */
const d1 = (db) => ({
  DB: {
    prepare: (sql) => ({
      bind: (...params) => ({
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        first: async () => db.prepare(sql).get(...params) ?? null,
        run: async () => db.prepare(sql).run(...params),
      }),
    }),
  },
});

const fixture = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE games(
      np_comm_id TEXT PRIMARY KEY, np_service_name TEXT, title TEXT, platform TEXT,
      icon_url TEXT, trophy_count INTEGER, has_platinum INTEGER, max_points INTEGER,
      estimated INTEGER, completion_weight INTEGER, refreshed_at INTEGER);
    INSERT INTO games (np_comm_id, title, platform) VALUES
      ('NPWR001', 'MARVEL S SPIDER-MAN', 'PS4'),
      ('NPWR002', 'MARVEL S SPIDER-MAN', 'PS5'),
      ('NPWR003', 'Bloodborne', 'PS4');
  `);
  // The migration itself, run as the live database will run it.
  for (const stmt of MIGRATION.split(';')) {
    const s = stmt.replace(/^\s*--.*$/gm, '').trim();
    if (s) db.exec(s);
  }
  return db;
};

/** The scan's real games upsert, lifted from the job rather than retyped. */
const upsert = () => {
  const at = SCAN.indexOf('`INSERT INTO games');
  assert.ok(at > 0, 'the scan still has a games upsert');
  const sql = SCAN.slice(at + 1, SCAN.indexOf('`', at + 1));
  assert.match(sql, /title_locked/, 'and it still reads the lock');
  return sql.replace(/\?/g, () => '?');
};

const scanWrites = (db, { npCommId, title, platform }) =>
  db.prepare(upsert()).run(npCommId, null, title, platform, null, 0, 0, 0, 0, 0, Date.now());

const titleOf = (db, id) =>
  db.prepare('SELECT title, title_psn, title_locked FROM games WHERE np_comm_id = ?').get(id);

// ------------------------------------------------------------ the lock ----

test('the scan overwrites an unlocked title, exactly as it always has', needsSqlite, () => {
  // The half that must NOT change. A game nobody has renamed still follows PSN,
  // including when PSN itself fixes a name.
  const db = fixture();
  scanWrites(db, { npCommId: 'NPWR003', title: 'Bloodborne GOTY', platform: 'PS4' });
  const row = titleOf(db, 'NPWR003');
  assert.equal(row.title, 'Bloodborne GOTY');
  assert.equal(row.title_psn, 'Bloodborne GOTY', 'and PSN\'s name is recorded either way');
});

test('a locked title survives the scan, which is the whole point', needsSqlite, async () => {
  const db = fixture();
  await renameGame(d1(db), { npCommId: 'NPWR001' }, "Marvel's Spider-Man");

  // PSN comes back with its own spelling, the way it does on every update.
  scanWrites(db, { npCommId: 'NPWR001', title: 'MARVEL S SPIDER-MAN', platform: 'PS4' });

  const row = titleOf(db, 'NPWR001');
  assert.equal(row.title, "Marvel's Spider-Man", 'the rename held');
  assert.equal(row.title_psn, 'MARVEL S SPIDER-MAN', 'and PSN\'s name is still on record');
});

// --------------------------------------------------------- the command ----

test('renaming hits every edition sharing the name, like the flag does', needsSqlite, async () => {
  /**
   * Renaming the PS5 stack and leaving the PS4 one on Sony's abbreviation
   * splits a title that /flag, the versions dropdown and the game card all
   * group BY NAME. So the default is the whole title.
   */
  const db = fixture();
  const moved = await renameGame(d1(db), { title: 'MARVEL S SPIDER-MAN' }, "Marvel's Spider-Man");

  assert.equal(moved.length, 2, 'both editions');
  for (const id of ['NPWR001', 'NPWR002']) {
    assert.equal(titleOf(db, id).title, "Marvel's Spider-Man");
  }
  assert.equal(titleOf(db, 'NPWR003').title, 'Bloodborne', 'and nothing else moved');
});

test('a version scopes the rename to one edition', needsSqlite, async () => {
  const db = fixture();
  await renameGame(d1(db), { title: 'MARVEL S SPIDER-MAN', npCommId: 'NPWR002' }, 'Spider-Man PS5');

  assert.equal(titleOf(db, 'NPWR002').title, 'Spider-Man PS5');
  assert.equal(titleOf(db, 'NPWR001').title, 'MARVEL S SPIDER-MAN', 'the PS4 list is untouched');
});

test('reset puts PSN\'s name back and lets the scan have the column again', needsSqlite, async () => {
  const db = fixture();
  await renameGame(d1(db), { npCommId: 'NPWR001' }, 'Something Else Entirely');
  await renameGame(d1(db), { npCommId: 'NPWR001' }, null);

  const row = titleOf(db, 'NPWR001');
  assert.equal(row.title, 'MARVEL S SPIDER-MAN', 'back to PSN');
  assert.notEqual(row.title_locked, 1, 'and unlocked');

  scanWrites(db, { npCommId: 'NPWR001', title: 'MARVELS SPIDER-MAN', platform: 'PS4' });
  assert.equal(titleOf(db, 'NPWR001').title, 'MARVELS SPIDER-MAN', 'the scan owns it again');
});

test('a game discovered after the migration can still be undone', needsSqlite, async () => {
  /**
   * The row inserted by a fresh scan has never been through the upsert, so its
   * `title_psn` is null. Without the backfill in renameGame, undoing a rename
   * on one of these would COALESCE to nothing and blank the title.
   */
  const db = fixture();
  db.prepare('INSERT INTO games (np_comm_id, title, platform) VALUES (?,?,?)')
    .run('NPWR004', 'ASTRO BOT', 'PS5');
  assert.equal(titleOf(db, 'NPWR004').title_psn, null, 'the fixture really is unbackfilled');

  await renameGame(d1(db), { npCommId: 'NPWR004' }, 'Astro Bot');
  await renameGame(d1(db), { npCommId: 'NPWR004' }, null);
  assert.equal(titleOf(db, 'NPWR004').title, 'ASTRO BOT', 'and it came back rather than blanking');
});

test('renaming a game nobody has returns nothing rather than writing anything', needsSqlite, async () => {
  const db = fixture();
  assert.deepEqual(await renameGame(d1(db), { title: 'Not A Game' }, 'Anything'), []);
});

// ----------------------------------------------------------- the gates ----

const flagSrc = (() => {
  const at = WORKER.indexOf('async function flagGame');
  const end = WORKER.indexOf('async function ', at + 10);
  return WORKER.slice(at, end === -1 ? undefined : end);
})();

test('the rename is owner only, and says so rather than failing quietly', () => {
  assert.match(flagSrc, /DISCORD_OWNER_ID/, 'gated on the owner id');
  assert.match(flagSrc, /owner only/i, 'and refuses out loud');
  // The fallback matters as much as the gate: an unconfigured deploy must not
  // hand a rename to every Manage Messages mod, which is the permission the
  // command as a whole carries.
  assert.match(flagSrc, /MANAGE_GUILD\) === MANAGE_GUILD/, 'falls back to Manage Server');
});

test('namechange refuses to run alongside a flag rather than doing half of it', () => {
  // The same class of bug parseClosingDate refuses a bad date for: the owner
  // believes they did two things and finds out later they did one.
  assert.match(flagSrc, /One thing at a time/);
});

test('a missing migration is named, not printed as SQLite', () => {
  assert.match(flagSrc, /026-title-override/);
});

test('the option is registered, and the scan reads the lock it sets', () => {
  const reg = readFileSync(
    fileURLToPath(new URL('../jobs/register-commands.mjs', import.meta.url)),
    'utf8',
  );
  assert.match(reg, /name: 'namechange'/, 'Discord knows about the option');
  assert.match(WORKER, /rename: opt\('namechange'\)/, 'and the handler is given it');
  assert.match(
    SCAN,
    /title = CASE WHEN games\.title_locked = 1 THEN games\.title ELSE excluded\.title END/,
    'the scan leaves a locked title alone',
  );
  assert.match(SCAN, /title_psn = excluded\.title/, 'and records PSN\'s name either way');
});
