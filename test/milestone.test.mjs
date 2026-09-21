import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * THE PLATINUM COUNTDOWN ON THE PANEL, run against a real SQLite database.
 *
 * Martin, 22 September, on Pig_Gamer_145's panel: "2 trophies to go - Remnant:
 * From the Ashes - for their 186th platinum". Pig had the base game done and the
 * platinum already in the cabinet; the 2 were DLC trophies. The query counted
 * the whole game and never asked whether the platinum was earned.
 *
 * A text match on the SQL could not have caught that, so this one runs it. It
 * skips itself on a Node without node:sqlite rather than failing the build.
 */
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const src = await import('node:fs/promises').then((fs) =>
  fs.readFile(new URL('../functions/api/hunter/[name].js', import.meta.url), 'utf8'));
const { FINISHABLE_SQL } = await import('../shared/votes.mjs');
const MILESTONE = src.match(/const MILESTONE = `([\s\S]*?)`;/)[1].replace('${FINISHABLE_SQL}', FINISHABLE_SQL);

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE games (np_comm_id TEXT PRIMARY KEY, title TEXT, icon_url TEXT, has_platinum INTEGER,
                        trophy_count INTEGER, max_points INTEGER, unobtainable INTEGER DEFAULT 0);
    CREATE TABLE trophies (np_comm_id TEXT, trophy_id INTEGER, type TEXT, group_id TEXT,
                           unobtainable INTEGER DEFAULT 0);
    CREATE TABLE member_games (psn_account_id TEXT, np_comm_id TEXT, progress INTEGER,
                               earned_total INTEGER, earned_platinum INTEGER, earned_ids TEXT);
  `);
  return d;
}

/** A game: `base` non-platinum base trophies, a platinum, and `dlc` DLC ones. */
function game(d, id, { base, dlc = 0, maxPoints = 1000 }) {
  d.prepare('INSERT INTO games VALUES (?,?,?,?,?,?,0)').run(id, id, null, 1, base + 1 + dlc, maxPoints);
  let n = 0;
  d.prepare('INSERT INTO trophies (np_comm_id, trophy_id, type, group_id) VALUES (?,?,?,?)').run(id, n++, 'platinum', 'default');
  for (let i = 0; i < base; i++) d.prepare('INSERT INTO trophies (np_comm_id, trophy_id, type, group_id) VALUES (?,?,?,?)').run(id, n++, 'bronze', 'default');
  for (let i = 0; i < dlc; i++) d.prepare('INSERT INTO trophies (np_comm_id, trophy_id, type, group_id) VALUES (?,?,?,?)').run(id, n++, 'gold', '001');
}

/** A member holding the listed trophy ids. */
function holds(d, id, ids, total) {
  const plat = ids.includes(0) ? 1 : 0;
  const progress = Math.floor((ids.length / total) * 100);
  d.prepare('INSERT INTO member_games VALUES (?,?,?,?,?,?)')
    .run('pig', id, progress, ids.length, plat, JSON.stringify(ids));
}

const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const run = (d) => d.prepare(MILESTONE).get('pig', 60, 10) ?? null;

test('a platinum already earned is never counted down to, however much DLC is left', { skip: !DatabaseSync }, () => {
  // Remnant: 40 base + plat, 10 DLC. Pig has the plat and 8 of the 10 DLC.
  const d = db();
  game(d, 'REMNANT', { base: 40, dlc: 10 });
  holds(d, 'REMNANT', [...range(0, 41), ...range(41, 49)], 51);
  assert.equal(run(d), null, 'no countdown to a platinum they already have');
});

test('the count is base-game trophies only, not DLC', { skip: !DatabaseSync }, () => {
  // 3 base trophies short of the plat, and every DLC trophy untouched.
  const d = db();
  game(d, 'G', { base: 30, dlc: 20 });
  holds(d, 'G', range(1, 28), 51);
  const r = run(d);
  assert.equal(r.title, 'G');
  assert.equal(r.need, 3, 'the 20 DLC trophies are not part of the platinum');
});

test('the nearest platinum wins', { skip: !DatabaseSync }, () => {
  const d = db();
  game(d, 'FAR', { base: 30 });
  holds(d, 'FAR', range(1, 25), 31);
  game(d, 'NEAR', { base: 30 });
  holds(d, 'NEAR', range(1, 30), 31);
  assert.equal(run(d).title, 'NEAR');
  assert.equal(run(d).need, 1);
});

test('too far off is no countdown at all', { skip: !DatabaseSync }, () => {
  const d = db();
  game(d, 'G', { base: 50 });
  holds(d, 'G', range(1, 20), 51);
  assert.equal(run(d), null);
});

test('a flagged game is never shown, and the next real one is', { skip: !DatabaseSync }, () => {
  // GTA V, 22 September: 2 to go, and flagged. A countdown nobody can finish.
  const d = db();
  game(d, 'GTAV', { base: 50 });
  holds(d, 'GTAV', range(1, 49), 51);
  game(d, 'REAL', { base: 30 });
  holds(d, 'REAL', range(1, 25), 31);

  d.prepare('UPDATE trophies SET unobtainable = 1 WHERE np_comm_id = ? AND trophy_id = 50').run('GTAV');
  assert.equal(run(d).title, 'REAL', 'one flagged trophy is enough to rule the game out');

  d.prepare('UPDATE trophies SET unobtainable = 0').run();
  d.prepare('UPDATE games SET unobtainable = 1 WHERE np_comm_id = ?').run('GTAV');
  assert.equal(run(d).title, 'REAL', 'and so is the game flag');
});
