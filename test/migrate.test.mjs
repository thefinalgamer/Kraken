import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import {
  runMigrations, splitStatements, alreadyThere, BASELINE, BASELINE_TABLE,
} from '../jobs/lib/migrations.mjs';

/**
 * The migrate button. It used to run every file every time and die on the
 * first ALTER TABLE that had already been applied, so nobody used it and every
 * migration became a paste into the D1 console. See jobs/lib/migrations.mjs.
 */

const dir = new URL('../migrations/', import.meta.url);
const real = async () => {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(new URL(name, dir), 'utf8') })));
};

/** A database that remembers its ledger and can be told which tables exist. */
function fakeDb({ ledger = [], tables = [], failOn = null } = {}) {
  const recorded = new Set(ledger);
  const ran = [];
  return {
    ran,
    recorded,
    async query(sql, params = []) {
      if (/FROM schema_migrations/.test(sql)) return [...recorded].map((name) => ({ name }));
      if (/sqlite_master/.test(sql)) return tables.includes(params[0]) ? [{ name: params[0] }] : [];
      return [];
    },
    async run(sql, params = []) {
      if (/INSERT OR IGNORE INTO schema_migrations/.test(sql)) { recorded.add(params[0]); return; }
      if (/CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) return;
      if (failOn && failOn.test(sql)) throw new Error(failOn.message ?? 'D1 query failed (400): boom');
      ran.push(sql);
    },
  };
}
const quiet = { log: () => {} };

test('the first run on the live database records 001-030 and runs only what is new', async () => {
  const files = await real();
  const db = fakeDb({ tables: [BASELINE_TABLE] });
  const out = await runMigrations(db, files, quiet);

  assert.ok(out.baselined.includes('001-verification.sql'));
  assert.ok(out.baselined.includes(BASELINE));
  assert.ok(!out.baselined.some((n) => n > BASELINE), 'nothing after the baseline is assumed');
  assert.deepEqual(out.applied, files.map((f) => f.name).filter((n) => n > BASELINE).sort());
  assert.ok(!db.ran.some((s) => /ALTER TABLE members ADD COLUMN raw_points/.test(s)),
    '003 is never re-run on the live database');
});

test('the second press does nothing at all', async () => {
  const files = await real();
  const db = fakeDb({ ledger: files.map((f) => f.name), tables: [BASELINE_TABLE] });
  const out = await runMigrations(db, files, quiet);
  assert.deepEqual(out.applied, []);
  assert.deepEqual(db.ran, []);
});

test('a fresh database with no wishlist table gets every migration', async () => {
  const files = await real();
  const db = fakeDb({ tables: [] });
  const out = await runMigrations(db, files, quiet);
  assert.deepEqual(out.baselined, []);
  assert.equal(out.applied.length, files.length);
});

test('a column somebody already pasted in by hand is skipped, not fatal', async () => {
  const files = [{ name: '099-x.sql', sql: 'ALTER TABLE members ADD COLUMN x INTEGER;\nCREATE INDEX IF NOT EXISTS i ON members(x);' }];
  const failOn = /ADD COLUMN x/;
  failOn.message = 'D1 query failed (400) after 1 attempt: duplicate column name: x: SQLITE_ERROR';
  const db = fakeDb({ ledger: ['000'], failOn });
  const out = await runMigrations(db, files, quiet);
  assert.deepEqual(out.applied, ['099-x.sql'], 'recorded as applied');
  assert.equal(db.ran.length, 1, 'and the rest of the file still ran');
});

test('any other error stops the run and leaves the file unrecorded', async () => {
  const files = [
    { name: '099-a.sql', sql: 'CREATE TABLE brokn (;' },
    { name: '100-b.sql', sql: 'CREATE TABLE IF NOT EXISTS fine (a INTEGER);' },
  ];
  const db = fakeDb({ ledger: ['000'], failOn: /brokn/ });
  await assert.rejects(runMigrations(db, files, quiet));
  assert.ok(!db.recorded.has('099-a.sql'), 'retried next time');
  assert.ok(!db.recorded.has('100-b.sql'), 'and nothing after it ran out of order');
});

test('comments are stripped before splitting, so prose semicolons cannot break a file', () => {
  assert.deepEqual(
    splitStatements('-- one; two\nCREATE TABLE a (x INTEGER);\n/* three; */\nCREATE INDEX i ON a(x);'),
    ['CREATE TABLE a (x INTEGER)', 'CREATE INDEX i ON a(x)'],
  );
});

test('no migration hides a semicolon or a comment marker inside a string', async () => {
  for (const f of await real()) {
    const code = f.sql.replace(/--[^\n]*/g, '');
    for (const lit of code.match(/'[^']*'/g) ?? []) {
      assert.ok(!/;|--/.test(lit), `${f.name}: ${lit} would split wrongly`);
    }
    assert.ok(splitStatements(f.sql).length > 0, `${f.name} has no statements`);
  }
});

test('alreadyThere recognises what D1 actually says', () => {
  assert.ok(alreadyThere(new Error('duplicate column name: live_pin: SQLITE_ERROR')));
  assert.ok(alreadyThere(new Error('table wishlist already exists')));
  assert.ok(!alreadyThere(new Error('no such table: members')));
});

test('the button runs the script, and the loop is gone from the workflow', async () => {
  const yml = await readFile(new URL('../.github/workflows/admin.yml', import.meta.url), 'utf8');
  const step = yml.slice(yml.indexOf("inputs.task == 'migrate'"), yml.indexOf('Backfill trophy names'));
  assert.match(step, /npm run migrate/);
  assert.match(step, /CF_D1_DATABASE_ID/);
  assert.doesNotMatch(step, /for f in migrations/);
});
