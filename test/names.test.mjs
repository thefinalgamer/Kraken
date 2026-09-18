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
  assert.match(SRC, /seen\.add\(game\.np_comm_id\)/,
    'a game gets one attempt per run rather than being asked forever');
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

/** The gaps pass on its own, so the assertions below cannot match code elsewhere. */
const gapsPass = () => {
  const from = SRC.indexOf('const GAPS_LEFT');
  assert.ok(from > 0, 'the gaps pass is missing from the job');
  const to = SRC.indexOf('if (unfillable)', from);
  assert.ok(to > from, 'the gaps pass no longer reports what it could not fill');
  return SRC.slice(from, to);
};

test('the gaps pass gives each game ONE attempt per run', () => {
  /**
   * The bug this replaces: the pass remembered only the games PSN returned
   * NOTHING for. Warhawk holds 94 trophy rows and PSN publishes names for 57,
   * so every attempt came back with 57 names, counted as a repair, and left
   * the other 37 as NULL as it found them. NEXT_PARTIAL then selected the same
   * game again, and again, for the entire eighty-eight minute reserve.
   *
   * A whole pass, running nightly, spending PSN calls, fixing nothing - and
   * starving the pack-name pass below it, which is why DLC headings stalled.
   */
  const pass = gapsPass();

  assert.ok(!/stuck/.test(pass), 'the old did-PSN-answer guard is gone');
  assert.match(pass, /const seen = new Set\(\)/);

  // Marked before the fetch, so one-attempt-each survives a throw too.
  const mark = pass.indexOf('seen.add(game.np_comm_id)');
  const fetch = pass.indexOf('await nameGame(psn, game)');
  assert.ok(mark > 0 && fetch > 0, 'the pass still attempts each game once');
  assert.ok(mark < fetch, 'the game is marked seen BEFORE the attempt, not after');

  // And the batch is filtered by it, or marking would achieve nothing.
  assert.match(pass, /filter\(\(g\) => !seen\.has\(g\.np_comm_id\)\)/);
});

test('the gaps pass counts progress, not whether PSN replied', () => {
  // "It answered" and "it helped" are different questions. Only the second one
  // can tell a repair from a game that will never be repairable.
  const pass = gapsPass();
  assert.match(pass, /const before = /, 'it measures the gap before');
  assert.match(pass, /const after = /, 'and after');
  assert.match(pass, /if \(after < before\) repaired/,
    'a repair is a gap that actually shrank');
});

test('a game the gaps pass cannot fill is named in the log', () => {
  /**
   * Warhawk sat broken for weeks because nothing said so. The pass reported
   * "filled in missing names for 1 game" every single run while leaving all 37
   * rows untouched, so the log agreed with itself and nobody looked.
   */
  const pass = gapsPass();
  assert.match(pass, /if \(after > 0\)/, 'it notices rows it did not fill');
  assert.match(pass, /unfillable/, 'and counts them');
  assert.match(pass, /console\.log\([\s\S]{0,200}game\.title/,
    'and names the game rather than reporting a bare total');
});

test('GAPS_LEFT asks about one game, using the columns the pass fills', () => {
  const q = query('GAPS_LEFT');
  assert.match(q, /np_comm_id = \?/, 'one game at a time, not a table scan');
  assert.match(q, /name IS NULL OR group_id IS NULL/,
    'the same gap NEXT_PARTIAL selects on, or the two could disagree forever');
});

const PSN = readFileSync(
  fileURLToPath(new URL('../jobs/lib/psn.mjs', import.meta.url)),
  'utf8',
);

test('titleTrophies can ask for ONE pack, and still defaults to all', () => {
  /**
   * The call always hardcoded "all" as the trophy group id. For Warhawk, a PS3
   * title from 2007, "all" returns 57 of the 94 trophies we hold and omits its
   * operation packs entirely. Naming the pack is the only way to reach them.
   */
  assert.match(PSN, /async titleTrophies\(npCommunicationId, platform, groupId = 'all'\)/,
    'the group id is a parameter with the old behaviour as its default');
  assert.match(PSN, /getTitleTrophies,\s*\n\s*npCommunicationId,\s*\n\s*groupId,/,
    'and it is the id that gets passed, not the literal "all"');
  assert.ok(!/getTitleTrophies,\s*\n\s*npCommunicationId,\s*\n\s*'all',/.test(PSN),
    'the hardcoded "all" is gone');
});

test('the second attempt asks for each pack by id', () => {
  assert.match(SRC, /async function nameByPack\(psn, game\)/);
  assert.match(SRC, /titleTrophyGroups\(game\.np_comm_id, game\.platform\)/,
    'it learns the pack ids from PSN rather than guessing them');
  assert.match(SRC, /if \(id === 'default'\) continue/,
    'the base game is what the first attempt already fetched');
  assert.match(SRC, /titleTrophies\(game\.np_comm_id, game\.platform, id\)/,
    'and each pack is fetched by its own id');
});

test('the pack fetch records which pack a trophy came from', () => {
  // Asked for BY ID, the id is the only thing that says which pack these
  // trophies belong to. Defaulting them to "default" would file a game's DLC
  // under its base game, which is the bug group ids exist to prevent.
  assert.match(SRC, /async function writeNames\(game, defs, groupId\)/);
  assert.match(SRC, /t\.trophyGroupId \?\? groupId \?\? 'default'/);
});

test('the second attempt runs ONLY for a game the first one could not finish', () => {
  // It costs one call per pack on top of the first. Every game on the board
  // would be several thousand calls a run to learn nothing.
  const pass = gapsPass();
  assert.match(pass, /afterAll > 0 \? await nameByPack\(psn, game\) : null/,
    'gated on the first attempt having left something behind');
});
