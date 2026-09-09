import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * A game that gains trophies after we last looked at it.
 *
 * PELZIOWO, 9 SEPTEMBER. He streamed Zenless Zone Zero for five and a half
 * hours, earned seven DLC trophies, and scored nothing at all for any of them —
 * not on the streamers board and not on the main one. Leon found it from the
 * outside in one line: *"Looks like your system hasnt got the new zenless dlc
 * trophies yet. He is 111/104 lol"*.
 *
 * The definitions were written before Sony added the DLC. Twelve members own the
 * game, so `refreshed_at` never got thirty days old, so `needsRarityWrite` was
 * false on every scan since and the definitions were never re-read. The board
 * had literally never heard of those seven trophies.
 *
 * `scan.mjs` runs main() at import, so these read it as text — the same way
 * test/trophy-log.test.mjs does, for the same reason.
 */
const scan = await readFile(new URL('../jobs/scan.mjs', import.meta.url), 'utf8');

/** Comments stripped, so a guard cannot pass on its own explanation. */
const code = scan.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('PSN already tells us how big a trophy list is, and the scan now reads it', () => {
  /**
   * THE SIGNAL WAS IN HAND AND UNREAD. `getUserTitles` returns
   * `definedTrophies` for every game on every scan, so the size of each trophy
   * list arrives before we decide whether to look at it. Nothing had ever
   * looked at that field.
   */
  assert.match(code, /sumTrophies\(t\.definedTrophies\)/, 'it reads what PSN says the game holds');
  assert.match(code, /g\.trophy_count/, 'and what we think it holds');
  assert.match(code, /defined !== stored/, 'and treats a disagreement as stale');
});

test('a disagreement forces the definitions to be rewritten', () => {
  /**
   * The whole point. `needsRarityWrite` is `!freshness.has() || stale.has()`,
   * so putting a grown game into `stale` is what makes the write happen — and
   * the game is already being scanned anyway, because the member's earned count
   * moved. No extra PSN call, no extra pass.
   */
  assert.match(code, /if \(grown\.has\(t\.npCommunicationId\)\) return true;/,
    'a grown game is stale regardless of the clock');
  assert.match(
    code,
    /needsRarityWrite\s*=\s*\n?\s*!freshness\.has\(t\.npCommunicationId\) \|\| stale\.has\(t\.npCommunicationId\)/,
    'and stale is what unlocks the definitions write',
  );
});

test('a missing definedTrophies cannot mark the whole library stale', () => {
  /**
   * THE GUARD THAT MATTERS MOST. If a PSN response ever omits the field,
   * `sumTrophies` returns 0, every game would "disagree" with its stored count,
   * and one ordinary update would become a full rescan of an entire library —
   * hundreds of API calls and D1 writes, for nothing.
   */
  assert.match(code, /defined > 0/, 'no field, no opinion');
  assert.match(code, /stored > 0/, 'and a game we have never scanned is handled elsewhere');
});

test('it complements the orphan self-heal rather than duplicating it', () => {
  /**
   * There was already a repair for games with NO definitions at all — it asks
   * `HAVING COUNT(t.trophy_id) = 0`. Zenless had a hundred and four of them and
   * was missing seven, so it was never an orphan and that heal could not see
   * it. All-or-nothing checks miss the case where a thing grew.
   */
  assert.match(code, /HAVING COUNT\(t\.trophy_id\) = 0/, 'the orphan heal is still there');
  assert.ok(
    code.indexOf('const grown') < code.indexOf('const staleOnly'),
    'and growth is decided before the refresh budget is spent, so it is never cut',
  );
});

test('the definitions insert still leaves prices to the rescore', () => {
  /**
   * A new trophy row gets a global-only price on insert, which is right: a
   * trophy nobody here has earned has no local evidence yet. What must NOT
   * happen is the scan overwriting `points` on the rows that already exist,
   * because that would undo the local blend for whichever games one member
   * happened to touch.
   */
  /**
   * There are TWO inserts into `trophies` — this one for rarity, and
   * backfillNames() for names and icons. Anchoring on "INSERT INTO trophies"
   * found the wrong one, which is its own small lesson about grepping for a
   * string that appears twice.
   */
  const at = code.indexOf("const cols = ['np_comm_id', 'trophy_id', 'type'");
  assert.notEqual(at, -1, 'the rarity insert is where it was');
  const block = code.slice(at, code.indexOf('if (needsNames)', at));
  assert.match(block, /ON CONFLICT\(np_comm_id, trophy_id\) DO UPDATE SET/);
  assert.ok(!/\bpoints = excluded\.points/.test(block), 'points belong to the rescore');
  assert.ok(!/local_earned = excluded/.test(block), 'and so does local_earned');
});
