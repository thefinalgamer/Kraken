import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The backfill job's queries.
 *
 * Static, because the job wants a live D1 and a PSN session and cannot be
 * imported here. Crude, but it pins the two mistakes that have already cost a
 * run each — a backfill selecting on the wrong thing, and an aggregate too
 * expensive to return.
 */
const SRC = readFileSync(
  fileURLToPath(new URL('../jobs/names.mjs', import.meta.url)),
  'utf8',
);

const query = (name) => {
  const i = SRC.indexOf(`const ${name} = \``);
  assert.ok(i > 0, `${name} is missing from the job`);
  return SRC.slice(i, SRC.indexOf('`;', i));
};

test('the group backfill selects on missing group ids, not missing names', () => {
  // The first version selected games with NO NAMED TROPHY, and by then every
  // game had names — so the job looked at the backlog, correctly found it
  // empty, and stopped without writing a single group id. A backfill has to
  // select on the thing it is backfilling.
  const q = query('NEXT_UNGROUPED');
  assert.match(q, /t\.group_id IS NOT NULL/, 'it looks for group ids');
  assert.match(q, /NOT EXISTS/, 'and picks the games that have none');
  assert.ok(!/t\.name IS NOT NULL/.test(q), 'it does not select on names');
});

test('the pack-name query never counts distinct groups', () => {
  // COUNT(DISTINCT group_id) > 1 means visiting every trophy on the server —
  // about a million rows, with no index that can help, because counting
  // distinct values means looking at all of them. It returned nothing and the
  // pass ended silently, which is how an expensive query fails: not with an
  // error, with an empty result.
  const q = query('NEXT_GROUPS');
  assert.ok(!/COUNT\(DISTINCT/i.test(q), 'no distinct count');
  assert.ok(!/HAVING/i.test(q), 'and no HAVING to force one');

  // "Has a trophy outside the default group" is the same question, and
  // idx_trophies_group from migration 012 covers exactly those rows.
  assert.match(q, /group_id <> 'default'/, 'it uses the indexed condition');
});

test('the indexed condition matches the index that exists', () => {
  // If these two ever drift, the query silently goes back to a table scan.
  const mig = readFileSync(
    fileURLToPath(new URL('../migrations/012-trophy-groups.sql', import.meta.url)),
    'utf8',
  );
  assert.match(mig, /idx_trophies_group/);
  assert.match(mig, /group_id IS NOT NULL AND group_id <> 'default'/);
  const q = query('NEXT_GROUPS');
  assert.match(q, /group_id IS NOT NULL/);
  assert.match(q, /group_id <> 'default'/);
});

test('the group pass cannot eat the whole budget', () => {
  // It did, twice. The pack-name pass then never ran, so every DLC on the site
  // read "DLC 1" and nothing said why.
  assert.match(SRC, /GROUP_BUDGET_MS = BUDGET_MS \* 0\.8/, 'a reserve exists');
  assert.match(SRC, /Date\.now\(\) - started > GROUP_BUDGET_MS/, 'and is enforced');
});

test('both passes are resumable by construction', () => {
  // Every run must continue rather than restart: kill it, re-run it, run it
  // four times, and it always picks up where it stopped. Both queries select
  // rows that do not yet have what the pass writes, so a finished game is a
  // game the query can never pick again.
  for (const name of ['NEXT_GAMES', 'NEXT_UNGROUPED', 'NEXT_GROUPS']) {
    assert.match(query(name), /NOT EXISTS/, `${name} would re-do finished work`);
  }
});

test('the backfill can also repair a game that is only PARTLY named', async () => {
  /**
   * Every other query in this job asks an all-or-nothing question: a game with
   * NO named trophy, a game with NO group ids. A game named in August that
   * gained eight DLC trophies in September has both, so nothing here could see
   * the eight rows that had neither -- and a NULL group id draws as the base
   * game. MRTheChez found it as Borderlands 4's two stacks sitting in the base
   * game section, worth nothing.
   */
  assert.match(SRC, /const NEXT_PARTIAL = /);
  assert.match(SRC, /t\.name IS NULL OR t\.group_id IS NULL/);
  assert.match(SRC, /g\.local_started > 0[\s\S]{0,200}t\.name IS NULL OR t\.group_id IS NULL/,
    'owned games only, same as the group pass');
  assert.match(SRC, /stuck\.add\(game\.np_comm_id\)/,
    'a game PSN publishes no names for is skipped rather than asked forever');
});

test('pack names are chased per PACK, not per game', () => {
  /**
   * The third all-or-nothing check in this codebase, and the one Martin saw
   * last: NEXT_GROUPS asked whether the game had ANY row in trophy_groups.
   * Borderlands 4 was named when it had four packs, so a fifth and a sixth were
   * never fetched and the page headed them "DLC 5" and "DLC 6".
   */
  const q = query('NEXT_GROUPS');
  assert.match(q, /tg\.np_comm_id = t\.np_comm_id\s*\n?\s*AND tg\.group_id = t\.group_id/,
    'the pack has to match, not just the game');
  assert.match(q, /t\.group_id <> 'default'/, 'and the base game is not a pack');
});
