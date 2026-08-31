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
