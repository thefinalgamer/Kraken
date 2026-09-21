import test from 'node:test';
import assert from 'node:assert/strict';
import { unlinkMember } from '../worker/src/db.mjs';

/**
 * UNLINKING SOMEBODY HAS TO TAKE THEIR WHOLE LIBRARY, NOT JUST THEIR ROW.
 *
 * For the life of the project this was one statement, DELETE FROM members, and
 * nothing anywhere deleted the five tables that hang off a member. Every person
 * a mod ever unlinked left their entire library behind.
 *
 * It is not a tidiness problem. `games.local_started` counts rows in
 * member_games, and that count is the denominator of the local rarity
 * multiplier. Orphaned rows are ghost owners: they make a game look more widely
 * owned than it is, which changes what its trophies pay EVERYBODY.
 *
 * One member unlinked on 24 August left 207 games and 4 updates behind. It sat
 * there skewing the board until 19 September, when an orphan check written for
 * an unrelated reason tripped over it.
 *
 * These tests drive the real function against a fake D1, so they check what it
 * SENDS rather than how it is written.
 */

/** A D1 stand-in that records every statement and batch it is handed. */
const fakeDb = (member) => {
  const prepared = [];
  const batches = [];
  const stmt = (sql) => ({
    sql,
    args: [],
    bind(...args) { this.args = args; return this; },
    async first() { return sql.startsWith('SELECT') ? member : null; },
    async run() { return { success: true }; },
    async all() { return { results: [] }; },
  });
  return {
    prepared,
    batches,
    env: {
      DB: {
        prepare(sql) { const s = stmt(sql); prepared.push(s); return s; },
        async batch(list) { batches.push(list); return list.map(() => ({ success: true })); },
      },
    },
  };
};

const MEMBER = { discord_id: '1209055977207365693', psn_account_id: '5848119741484892593', psn_online_id: 'GhostOwner' };

/** Every table a member has rows in. Miss one and it becomes a ghost owner. */
const TABLES = [
  'update_changelog',
  'updates',
  'member_trophies',
  'member_games',
  'wishlist',
  'stream_windows',
  'members',
];

const runUnlink = async () => {
  const db = fakeDb(MEMBER);
  const returned = await unlinkMember(db.env, MEMBER.discord_id);
  const batch = db.batches[0] ?? [];
  return { db, returned, batch, sql: batch.map((s) => s.sql) };
};

test('it deletes from every table a member has rows in', async () => {
  const { sql } = await runUnlink();
  for (const table of TABLES) {
    assert.ok(
      sql.some((s) => s.startsWith(`DELETE FROM ${table} `)),
      `nothing deletes from ${table}, so unlinking leaves rows behind there`,
    );
  }
  assert.equal(sql.length, TABLES.length, `expected ${TABLES.length} deletes, got ${sql.length}`);
});

test('update_changelog goes before updates, or its rows are orphaned', async () => {
  // It is keyed to updates.id. Delete the updates first and the changelog rows
  // have nothing left to identify them by -- which is exactly the trap that
  // caught us doing this by hand in the D1 console.
  const { sql } = await runUnlink();
  const changelog = sql.findIndex((s) => s.startsWith('DELETE FROM update_changelog'));
  const updates = sql.findIndex((s) => s.startsWith('DELETE FROM updates'));
  assert.ok(changelog >= 0 && updates >= 0);
  assert.ok(changelog < updates, 'the changelog has to go first');
});

test('it is ONE batch, so a failure halfway cannot half-delete somebody', async () => {
  const { db, batch } = await runUnlink();
  assert.equal(db.batches.length, 1, 'seven separate awaits are seven chances to stop halfway');
  assert.ok(batch.length > 1);

  // The only loose statements should be the member lookup that runs first and
  // the goals and votes deletes, which stay outside on purpose (see below):
  // ballots before the votes they hang off.
  const loose = db.prepared.filter((s) => !batch.includes(s));
  assert.deepEqual(loose.map((s) => s.sql), [
    'SELECT * FROM members WHERE discord_id = ?',
    'DELETE FROM goals WHERE psn_account_id = ?',
    'DELETE FROM vote_ballots WHERE vote_id IN (SELECT id FROM votes WHERE psn_account_id = ?)',
    'DELETE FROM votes WHERE psn_account_id = ?',
    'DELETE FROM vote_backlog WHERE psn_account_id = ?',
  ]);
});

/**
 * GOALS GO TOO, but outside the batch. The goals table arrives in migration
 * 037, and a D1 batch is all-or-nothing: one missing table inside it would stop
 * a mod unlinking anybody at all on a database that has not run 037.
 */
test('their goals are deleted, bound to their account', async () => {
  const { db } = await runUnlink();
  const del = db.prepared.find((s) => s.sql.startsWith('DELETE FROM goals '));
  assert.ok(del, 'nothing deletes their goals, so they would be left behind');
  assert.deepEqual(del.args, [MEMBER.psn_account_id]);
});

test('a database without migration 037 can still unlink somebody', async () => {
  const db = fakeDb(MEMBER);
  const prepare = db.env.DB.prepare;
  db.env.DB.prepare = (sql) => {
    const s = prepare(sql);
    if (sql.startsWith('DELETE FROM goals')) {
      s.run = async () => { throw new Error('D1_ERROR: no such table: goals'); };
    }
    return s;
  };
  await unlinkMember(db.env, MEMBER.discord_id);
  assert.equal(db.batches.length, 1, 'the missing table stopped the real unlink');
});

test('any other goals error still stops it, rather than being swallowed', async () => {
  const db = fakeDb(MEMBER);
  const prepare = db.env.DB.prepare;
  db.env.DB.prepare = (sql) => {
    const s = prepare(sql);
    if (sql.startsWith('DELETE FROM goals')) {
      s.run = async () => { throw new Error('D1_ERROR: database is locked'); };
    }
    return s;
  };
  await assert.rejects(unlinkMember(db.env, MEMBER.discord_id), /locked/);
});

test('every delete is bound to that member and nobody else', async () => {
  const { batch } = await runUnlink();
  for (const s of batch) {
    assert.equal(s.args.length, 1, `${s.sql} binds ${s.args.length} values, expected exactly 1`);
    const expected = s.sql.includes('FROM members ') ? MEMBER.discord_id : MEMBER.psn_account_id;
    assert.equal(s.args[0], expected, `${s.sql} is bound to the wrong id`);
  }
});

test('the members row goes last', async () => {
  // Everything else binds psn_account_id directly, so this is belt and braces
  // rather than load-bearing -- but if anyone ever reintroduces a lookup
  // through members, deleting it first would silently spare all the rest.
  const { sql } = await runUnlink();
  assert.ok(sql[sql.length - 1].startsWith('DELETE FROM members '), 'members must be last');
});

test('an unknown member is left entirely alone', async () => {
  const db = fakeDb(null);
  const returned = await unlinkMember(db.env, 'nobody');
  assert.equal(returned, null);
  assert.equal(db.batches.length, 0, 'it ran deletes for somebody who does not exist');
});

test('it still returns the member, because the reply names them', async () => {
  const { returned } = await runUnlink();
  assert.equal(returned.psn_online_id, 'GhostOwner');
});

test('the reply no longer promises their history stays', async () => {
  /**
   * The old copy said "Their scan history stays put." That was true when this
   * deleted one row, and became a lie the moment it stopped. When a code path
   * changes, the words on it have to be re-read -- this codebase has been
   * caught by that twice before.
   */
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../worker/src/index.mjs', import.meta.url), 'utf8');
  assert.ok(!/scan history stays put/.test(src), 'the reply still says the history survives');
  assert.match(src, /re-prices on the next rescore/,
    'and it should say the board is stale until a rescore');
});
