import test from 'node:test';
import assert from 'node:assert/strict';

import { settleLocalRarity, SETTLE_GAME_LIMIT } from '../jobs/lib/settle.mjs';
import { trophyPoints, localMultiplier } from '../shared/scoring.mjs';

/**
 * A stand-in for D1 that answers the three queries settleLocalRarity() asks and
 * records every statement it writes.
 *
 * The point of testing this against a fake rather than a real database is that
 * the thing worth proving is not the SQL — it is the decision. Martin earned
 * eight trophies on a game his brother owns and his brother lost nothing, and
 * the fix has to make somebody who is not scanning lose points. That is what
 * these assertions check.
 */
function fakeDb({ memberGames, trophies, members }) {
  const written = [];
  return {
    statements: written,
    async query(sql, params = []) {
      if (/FROM member_games/.test(sql) && /earned_ids/.test(sql)) {
        // The real query aliases points AS was_points, and getting that wrong
        // in the fake made a member with nothing earned look like a change.
        return memberGames
          .filter((r) => params.includes(r.np_comm_id))
          .map((r) => ({ ...r, was_points: r.points }));
      }
      if (/json_group_array/.test(sql) && /FROM trophies/.test(sql)) {
        const games = [...new Set(trophies.map((t) => t.np_comm_id))].filter((g) =>
          params.includes(g),
        );
        return games.map((g) => ({
          np_comm_id: g,
          defs: JSON.stringify(
            trophies
              .filter((t) => t.np_comm_id === g)
              .map((t) => [t.trophy_id, t.type, t.earned_rate, t.points]),
          ),
        }));
      }
      if (/FROM members/.test(sql)) {
        return members.filter((m) => params.includes(m.psn_account_id));
      }
      return [];
    },
    async run(sql) {
      written.push(sql);
    },
    async runBatch(list) {
      written.push(...list);
    },
  };
}

/** Two members own the same game. Only one of them is scanning. */
function board() {
  return {
    memberGames: [
      { psn_account_id: 'martin', np_comm_id: 'NPWR001', earned_ids: '[1,2]', points: 0 },
      { psn_account_id: 'wilko', np_comm_id: 'NPWR001', earned_ids: '[1,2]', points: 0 },
      { psn_account_id: 'rabbit', np_comm_id: 'NPWR001', earned_ids: '[]', points: 0 },
    ],
    trophies: [
      // 3% worldwide, so genuinely worth something before local rarity touches it.
      { np_comm_id: 'NPWR001', trophy_id: 1, type: 'gold', earned_rate: 3, points: 999 },
      { np_comm_id: 'NPWR001', trophy_id: 2, type: 'silver', earned_rate: 3, points: 999 },
    ],
    members: [
      { psn_account_id: 'wilko', psn_online_id: 'YT-WilkoX', raw_points: 100, points: 100, completion: 50 },
      { psn_account_id: 'rabbit', psn_online_id: 'Rabbit', raw_points: 100, points: 100, completion: 50 },
    ],
  };
}

test('settling re-prices the game for everyone who owns it', async () => {
  const data = board();
  const db = fakeDb(data);
  const out = await settleLocalRarity(db, ['NPWR001'], { skipAccountId: 'martin' });

  assert.equal(out.games, 1);
  assert.ok(out.trophies > 0, 'the trophies were re-valued');

  // Three members own the game, two of them hold each trophy.
  const sql = db.statements.join('\n');
  assert.match(sql, /UPDATE games SET local_started = 3/);
  assert.match(sql, /UPDATE trophies SET local_earned = 2/);

  // The value the fake started from (999) was nonsense, so every trophy moved.
  const expected = Math.round(trophyPoints(3) * localMultiplier(2, 3));
  assert.match(sql, new RegExp(`UPDATE trophies SET points = ${expected}\\b`));
});

test('the member being scanned is left for their own recompute', async () => {
  const data = board();
  const db = fakeDb(data);
  await settleLocalRarity(db, ['NPWR001'], { skipAccountId: 'martin' });

  const sql = db.statements.join('\n');
  assert.ok(
    !/psn_account_id = 'martin'/.test(sql),
    "the scanning member's rows are rebuilt by recomputeMemberPoints, not here",
  );
  assert.match(sql, /UPDATE member_games SET points = \d+ WHERE psn_account_id = 'wilko'/);
});

test('somebody who is not scanning has their total rewritten', async () => {
  const data = board();
  const db = fakeDb(data);
  const out = await settleLocalRarity(db, ['NPWR001'], { skipAccountId: 'martin' });

  // This is the whole bug, as an assertion. Wilko did not run anything; his
  // score moved because Martin played. His next /update reports it as drift.
  const moved = out.members.map((m) => m.onlineId);
  assert.ok(moved.includes('YT-WilkoX'), `expected Wilko to move, got ${JSON.stringify(out.members)}`);

  // Rabbit owns the game but has earned nothing in it, so his total cannot
  // change — owning something is not the same as holding its trophies.
  assert.ok(!moved.includes('Rabbit'), 'a member with no earned trophies here should not move');

  assert.match(db.statements.join('\n'), /UPDATE members SET points = \d+ WHERE psn_account_id = 'wilko'/);
});

test('a first scan is handed back to the nightly rescore', async () => {
  const db = fakeDb(board());
  const many = Array.from({ length: SETTLE_GAME_LIMIT + 1 }, (_, i) => `NPWR${i}`);
  const out = await settleLocalRarity(db, many);

  assert.equal(out.skipped, many.length);
  assert.equal(db.statements.length, 0, 'nothing is written when the job is handed over');
});

test('no games means no work', async () => {
  const db = fakeDb(board());
  const out = await settleLocalRarity(db, []);
  assert.equal(out.games, 0);
  assert.equal(db.statements.length, 0);
});
