import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

/**
 * A GAME CAN LEAVE A LIBRARY, AND NOTHING HERE EVER BELIEVED THAT.
 *
 * PSN lets a member delete a trophy list they have earned nothing in.
 * Shinlight deleted Hawken on 19 September and it stayed on his Kraken profile,
 * because the scan only ever upserts what PSN RETURNS -- a game that stops
 * being returned is simply never touched again.
 *
 * Third instance of the same blind spot this month, and worth naming as a
 * family rather than three bugs:
 *
 *   Warhawk        PSN dropped 37 trophy ROWS, we kept them (migration 034)
 *   unlinkMember   a mod removed a MEMBER, we kept their whole library
 *   Hawken         a member deleted a GAME, we kept the row
 *
 * Every one of them was "we only ever add". `scan.mjs` runs main() at import,
 * so this reads it as text, exactly as test/dlc-growth.test.mjs does.
 */
const scan = await readFile(new URL('../jobs/scan.mjs', import.meta.url), 'utf8');

/** The pruning block on its own, so nothing below can match code elsewhere. */
const prune = () => {
  const from = scan.indexOf('GAMES THE MEMBER HAS DELETED FROM THEIR OWN PSN PROFILE');
  assert.ok(from > 0, 'the scan no longer prunes deleted games at all');
  const to = scan.indexOf('// Which games need work, and why.', from);
  assert.ok(to > from, 'the pruning block has moved and this test cannot find its end');
  return scan.slice(from, to);
};

test('it only ever removes a game with NOTHING earned in it', () => {
  /**
   * The guard that makes this safe. A row with nothing earned holds no trophy,
   * no point and no completion, so removing it cannot cost anybody anything.
   * Pruning on "PSN did not mention it" alone would mean one short response
   * costing somebody real progress.
   */
  const block = prune();
  assert.match(block, /Number\(r\.earned_total \|\| 0\) === 0/,
    'the filter no longer checks that nothing was earned');
  assert.match(block, /COALESCE\(earned_total, 0\) = 0/,
    'the DELETE itself must carry the guard too, not just the JavaScript');
});

test('it never prunes off an empty answer from PSN', () => {
  // titles coming back empty is a broken request, not an empty library. Pruning
  // off it would delete every 0% row the member has, which is the one outcome
  // here that could not be undone by rescanning.
  const block = prune();
  assert.match(block, /if \(titles\.length\)/, 'an empty PSN response could wipe every 0% row');
});

test('the delete is scoped to the one member being scanned', () => {
  const block = prune();
  assert.match(block, /WHERE psn_account_id = \?/, 'the delete is not scoped to a member');
  assert.match(block, /\[accountId, \.\.\.slice\]/, 'and the account id has to be bound first');
});

test('it compares against what PSN actually returned', () => {
  const block = prune();
  assert.match(block, /new Set\(titles\.map\(\(t\) => t\.npCommunicationId\)\)/,
    'it has to build the live set from the PSN response');
  assert.match(block, /!stillThere\.has\(r\.np_comm_id\)/,
    'and remove exactly what is no longer in it');
});

test('it chunks, because a library can be sixteen thousand games', () => {
  // D1 rejects a statement with more than about a hundred bound parameters, and
  // LucasDiasC had 16,211 games. An unchunked IN list is the failure that has
  // already cost this codebase a silent catch once, on the trophy log.
  const block = prune();
  assert.match(block, /D1\.chunkSize\(1\) - 1/, 'the page size must leave room for accountId');
  assert.match(block, /for \(let i = 0; i < deleted\.length; i \+= perChunk\)/, 'it does not chunk');
});

test('it touches member_games and nothing else', () => {
  /**
   * Deliberately narrow. A 0% game has no member_trophies rows to begin with,
   * so reaching into other tables here would be scope this cannot justify --
   * and every table it does not touch is a table it cannot damage.
   */
  const block = prune();
  const deletes = [...block.matchAll(/DELETE FROM (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(deletes, ['member_games']);
});

test('it says what it removed', () => {
  // A scan that silently deletes rows is a scan nobody can audit. This is the
  // only place a member's library shrinks without somebody asking it to.
  const block = prune();
  assert.match(block, /console\.log\(/, 'a silent delete is an unauditable one');
  assert.match(block, /PSN no longer lists them/);
});

test('the stale rows leave the prior map too', () => {
  // `prior` is read further down to decide what needs a deep scan. Leaving a
  // just-deleted game in it would have the rest of the scan reasoning about a
  // row that is no longer there.
  const block = prune();
  assert.match(block, /for \(const id of deleted\) prior\.delete\(id\)/);
});

/* ---- the other half of the same set: games that were HIDDEN ---- */

/**
 * PSN lets a member hide a trophy list, and a hidden list is not returned by
 * the API -- so from our side it looks exactly like a deleted one. Somebody
 * sitting on a 40% game they would rather nobody saw can hide it and watch
 * their PlayStation completion rise.
 *
 * IT GAINS THEM NOTHING HERE, and that is the point worth protecting. The
 * prune above refuses to touch a row with anything earned in it, so a hidden
 * game keeps its row and keeps counting in both halves of their completion.
 * This half does not close a hole. It makes one visible.
 */
const hiddenBlock = () => {
  const from = scan.indexOf('GAMES THAT WENT MISSING BUT HAVE TROPHIES IN THEM');
  assert.ok(from > 0, 'the scan no longer records hidden games');
  const to = scan.indexOf('// Which games need work, and why.', from);
  assert.ok(to > from, 'the hidden block has moved and this test cannot find its end');
  return scan.slice(from, to);
};

test('the hidden half looks at games WITH trophies, the exact opposite of the prune', () => {
  const block = hiddenBlock();
  assert.match(block, /Number\(r\.earned_total \|\| 0\) > 0/,
    'it must select the games the prune refuses to touch');
  assert.match(block, /!stillThere\.has\(r\.np_comm_id\)/);
});

test('it records WHEN a game went missing, and never moves that date', () => {
  /**
   * How long it has been gone is the only part that means anything. Sony
   * delisted Warhawk's operation packs outright and a short PSN response drops
   * things too, so one day is probably Sony and a fortnight is a decision.
   * Rewriting the date on every scan would erase exactly that signal.
   */
  const block = hiddenBlock();
  assert.match(block, /hidden_at = COALESCE\(hidden_at, \?\)/,
    'the original date has to survive later scans');
});

test('a game that comes back stops being missing', () => {
  // Otherwise the first blip would mark somebody forever.
  const block = hiddenBlock();
  assert.match(block, /hidden_at = NULL/, 'nothing ever clears the flag');
  assert.match(block, /\.filter\(\(id\) => stillThere\.has\(id\)\)/,
    'it has to clear exactly the ones PSN returned again');
});

test('it never deletes anything', () => {
  // A hidden game keeps its row and keeps counting. That is the whole reason
  // hiding gains nobody anything, and it must not quietly become a prune.
  const block = hiddenBlock();
  assert.ok(!/DELETE FROM/.test(block), 'the hidden half must only ever mark, never remove');
});

test('it cannot take the scan down on a database without migration 036', () => {
  // Same seatbelt every column added since 019 carries: a missing column loses
  // the feature, never the scan.
  const block = hiddenBlock();
  assert.match(block, /try \{/);
  assert.match(block, /hidden_at\|no such column/i, 'the catch has to let a missing column through');
  assert.match(block, /throw err/, 'and rethrow anything that is not that');
});

test('migration 036 adds the column the scan writes', () => {
  const mig = readFileSync(
    new URL('../migrations/036-hidden-games.sql', import.meta.url), 'utf8',
  );
  assert.match(mig, /ALTER TABLE member_games ADD COLUMN hidden_at/);
});

test('tools/hiding.sql reads what the scan writes', () => {
  /**
   * The query and the column are written in different files and nothing else
   * connects them. If either is renamed, Martin gets an error in the D1 console
   * rather than an empty table, which is a much worse way to find out.
   */
  const sql = readFileSync(new URL('../tools/hiding.sql', import.meta.url), 'utf8');
  assert.match(sql, /mg\.hidden_at IS NOT NULL/, 'it must select on the flag');
  assert.match(sql, /AS days/, 'and surface how long it has been gone, which is the signal');
  assert.ok(!/earned_total\s*=\s*0/.test(sql), 'hidden games are the ones WITH trophies');
});
