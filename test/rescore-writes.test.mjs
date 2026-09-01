import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * node:sqlite ARRIVED IN NODE 22.5, and this file was written on 22 and pushed
 * to a CI running 20 — where the import threw, took the whole file with it, and
 * failed a deploy for a reason that had nothing to do with the change.
 *
 * The workflows now pin 22. The guard stays anyway, because the next person to
 * run these on an older Node should get four skipped tests and a sentence
 * explaining why, not a red build and a stack trace. The source checks below do
 * not need SQLite and always run, so the guards are still asserted even where
 * the SQL cannot be executed.
 */
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Older Node. The SQL tests skip; the source tests do not.
}
const needsSqlite = { skip: DatabaseSync ? false : 'node:sqlite needs Node 22.5 or newer' };

/**
 * The nightly job's write volume.
 *
 * WRITES ARE THE ONE NUMBER NEAR A LIMIT. Reads sit at four percent of their
 * allowance; writes were at fifty-four, and almost all of it was the rescore
 * setting columns to the values they already held — seven hundred thousand
 * rows a night whether anything moved or not.
 *
 * Two halves. The first asserts every whole-table statement in the job carries
 * a guard, so a new one cannot be added without noticing. The second runs the
 * actual SQL against real SQLite and counts the rows it writes, because a
 * guard that is present but wrong is worse than no guard at all.
 */
const SRC = readFileSync(
  fileURLToPath(new URL('../jobs/rescore.mjs', import.meta.url)),
  'utf8',
);

test('every nightly write is guarded by the value it is about to set', () => {
  // Pulled out by the column each statement writes, so the failure message
  // names the one that lost its guard.
  const guards = [
    ['local_started', /local_started IS NOT/],
    ['local_earned', /local_earned IS NOT/],
    ['estimated', /WHERE estimated IS NOT/],
    ['max_points', /WHERE max_points IS NOT/],
    ['completion_weight', /WHERE completion_weight IS NOT/],
  ];
  for (const [col, re] of guards) {
    assert.match(SRC, re, `${col} is rewritten every night whether it moved or not`);
  }

  // The two that were already right, so a refactor cannot quietly drop them.
  assert.match(SRC, /Only write trophies whose value actually moved/);
  assert.match(SRC, /Only rows whose value actually moved/);
});

// ------------------------------------------------------------ real SQL ----

const fixture = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE games(np_comm_id TEXT PRIMARY KEY, max_points INTEGER,
      estimated INTEGER NOT NULL DEFAULT 0, completion_weight INTEGER NOT NULL DEFAULT 0,
      local_started INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE trophies(np_comm_id TEXT, trophy_id INTEGER, type TEXT, earned_rate REAL,
      points INTEGER, local_earned INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(np_comm_id, trophy_id));
    INSERT INTO games VALUES ('A', 100, 0, 120, 3), ('B', 0, 1, 0, 0);
    INSERT INTO trophies VALUES ('A',1,'gold',5.0,100,3), ('A',2,'bronze',60.0,0,3);
  `);
  return db;
};

const rowsWritten = (db, sql) => {
  db.prepare(sql).run();
  return db.prepare('SELECT changes() AS c').get().c;
};

const MAX_POINTS = `
  UPDATE games SET max_points =
    (SELECT COALESCE(SUM(t.points),0) FROM trophies t WHERE t.np_comm_id = games.np_comm_id)
  WHERE max_points IS NOT
    (SELECT COALESCE(SUM(t.points),0) FROM trophies t WHERE t.np_comm_id = games.np_comm_id)`;

const ESTIMATED = `
  UPDATE games SET estimated = CASE WHEN NOT EXISTS (
    SELECT 1 FROM trophies t WHERE t.np_comm_id = games.np_comm_id AND t.earned_rate > 0)
    THEN 1 ELSE 0 END
  WHERE estimated IS NOT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM trophies t WHERE t.np_comm_id = games.np_comm_id AND t.earned_rate > 0)
    THEN 1 ELSE 0 END)`;

test('a rescore where nothing moved writes nothing', needsSqlite, () => {
  // The ordinary night. Nobody started or finished anything, no rarity drifted,
  // and the job should cost zero writes rather than seven hundred thousand.
  const db = fixture();
  assert.equal(rowsWritten(db, MAX_POINTS), 0, 'max_points');
  assert.equal(rowsWritten(db, ESTIMATED), 0, 'estimated');
  assert.equal(
    rowsWritten(db, "UPDATE games SET local_started = 3 WHERE np_comm_id IN ('A') AND local_started IS NOT 3"),
    0,
    'local_started',
  );
  assert.equal(
    rowsWritten(
      db,
      "UPDATE trophies SET local_earned = 3 WHERE (np_comm_id, trophy_id) IN (VALUES ('A',1),('A',2)) AND local_earned IS NOT 3",
    ),
    0,
    'local_earned',
  );
});

test('and a rescore where something moved still writes it', needsSqlite, () => {
  // The guard must not be so clever it stops the job working. This is the half
  // that would fail if IS NOT were the wrong comparison.
  const db = fixture();
  db.prepare('UPDATE trophies SET points = 250 WHERE np_comm_id = ? AND trophy_id = ?').run('A', 1);

  assert.equal(rowsWritten(db, MAX_POINTS), 1, 'only the game whose sum changed');
  assert.equal(
    db.prepare("SELECT max_points FROM games WHERE np_comm_id='A'").get().max_points,
    250,
    'and it holds the new value',
  );
  assert.equal(
    rowsWritten(
      db,
      "UPDATE trophies SET local_earned = 5 WHERE (np_comm_id, trophy_id) IN (VALUES ('A',1),('A',2)) AND local_earned IS NOT 5",
    ),
    2,
    'both trophies whose count moved',
  );
});

test('a NULL column counts as different, not as equal', needsSqlite, () => {
  // `=` returns NULL against NULL, so a plain comparison would skip exactly the
  // rows that most need writing — the ones added by an older build before the
  // column existed. IS NOT is null-safe; that is why it is used.
  const db = fixture();
  db.prepare("UPDATE games SET max_points = NULL WHERE np_comm_id = 'A'").run();
  assert.equal(rowsWritten(db, MAX_POINTS), 1, 'a null total is repaired');
});
