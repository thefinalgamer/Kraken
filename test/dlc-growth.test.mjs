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

test('PSN disagreeing about progress is a reason to rescan on its own', () => {
  /**
   * MRTHECHEZ, 10 SEPTEMBER. He owns Diablo IV twice and Kraken showed 83% on
   * one stack and 72% on the other, with the SAME twenty-six trophies on both.
   * Same trophies cannot be two percentages.
   *
   * Diablo added DLC: the list went from 38 trophies to 46, so his twenty-six
   * stopped being 83% and became 72%. His earned count never moved, so
   * `earned_total` still matched what was stored, so nothing ever looked at the
   * game again and the stale figure sat there for months.
   *
   * `getUserTitles` returns `progress` for every game on every scan. It is
   * Sony's own weighted figure, it was in hand the whole time, and it was only
   * ever read when some OTHER reason had already triggered a scan of that game.
   */
  assert.match(code, /const drifted = was && was\.progress !== \(t\.progress \?\? 0\)/,
    'stored progress is compared against what PSN says now');
  assert.match(code, /was\.earned_total !== earnedTotal \|\| was\.scanned_at == null \|\| drifted/,
    'and a disagreement joins the other reasons to rescan');
});

test('a grown game skips the refresh budget', () => {
  /**
   * `staleOnly` is capped so an update cannot balloon into a full rescan, which
   * is right for rarity going gently out of date. A game that changed SIZE is
   * not slightly old, it is wrong now: the member holds trophies nothing has a
   * definition for, against a denominator that moved. So it goes in with the
   * changed games, which are never capped.
   */
  assert.match(
    code,
    /const changedIds = new Set\(\[\s*\.\.\.needsEarnedScan\.map\(\(t\) => t\.npCommunicationId\),\s*\.\.\.grown,\s*\]\)/,
    'grown games are scanned, not queued',
  );
  assert.ok(
    code.indexOf('const grown') < code.indexOf('const changedIds'),
    'and grown is computed before anything reads it',
  );
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

/* ---- 13 September: Borderlands 4's DLC stacks in the base game ---- */

test('a game that gained trophies is asked for their names and packs too', () => {
  /**
   * MRTheChez: Borderlands 4's two new stacks *"seem to be placed with 0 points
   * in the base game section"*.
   *
   * The growth fix pulled the new trophies in through the EARNED path, which
   * carries type, rarity and points and NOT name or group_id. So they landed
   * nameless, with a null group, and a null group reads as the base game. The
   * names call was never made because `has_names` asks whether the game has ANY
   * name — and the base game's hundred trophies all had one.
   *
   * The same all-or-nothing shape as the original Zenless bug, one table along.
   */
  assert.match(code, /t\.name IS NULL OR t\.group_id IS NULL/, 'it looks for the gaps');
  assert.match(code, /name_gaps/);
  assert.match(code, /!r\.has_names \|\| r\.name_gaps/, 'either one means ask PSN');
});

test('a grown game does not wait its turn in the name budget', () => {
  /**
   * The budget drains a backlog of never-named games gently across updates,
   * which is right for a backlog and wrong for a game holding trophies the
   * member earned tonight. Sixty games ahead of it in the queue would mean the
   * DLC sat nameless in the base game section for weeks.
   */
  assert.match(code, /const grownNow = grown\.has\(t\.npCommunicationId\)/);
  assert.match(code, /needsNames =\s*\n?\s*grownNow \|\|/, 'growth comes first');
  assert.match(code, /if \(needsNames && !grownNow\) nameBudget -= 1/,
    'and it does not spend the budget it skipped');
});

test('the names call still writes the group, which is the half that was missing', () => {
  assert.match(code, /group_id = excluded\.group_id/);
  assert.match(code, /t\.trophyGroupId \?\? 'default'/);
});

test('games already sitting with gaps get a names-only pass of their own', () => {
  /**
   * The fix above only helps a game the scan was going to touch anyway. Once
   * the growth fix has pulled the new trophies in, the stored count matches
   * PSN, so the game is not grown, not stale, and not scanned -- and its
   * nameless stacks would sit in the base game section until somebody happened
   * to earn something in it. This pass costs one PSN call per game and no
   * earned call at all.
   */
  assert.match(code, /const gaps = gameRows\.filter\(/);
  assert.match(code, /!scanned\.has\(t\.npCommunicationId\) && unnamed\.has\(t\.npCommunicationId\)/);
  assert.match(code, /await backfillNames\(psn, t, stats\)/);
  assert.match(code, /if \(nameBudget <= 0\) break/, 'and it stays inside the same budget');
});

test('a new DLC pack gets its NAME too, not just its group', () => {
  /**
   * Second half of the Borderlands 4 report. With group ids filled in, the two
   * stacks moved out of the base game and into their own sections -- headed
   * "DLC 5" and "DLC 6", because the pack names live in `trophy_groups` and
   * only the backfill job had ever written that table. A pack stayed unnamed
   * until somebody pressed a button in Actions.
   */
  assert.match(code, /async function namePacks\(psn, title, defs\)/);
  assert.match(code, /await namePacks\(psn, title, named\)/, 'called when names are fetched');
  assert.match(code, /INSERT INTO trophy_groups/);
  assert.match(code, /t\.trophyGroupId\)\.filter\(\(g\) => g && g !== 'default'\)/,
    'the base game is never asked about');
  assert.match(code, /SELECT group_id FROM trophy_groups WHERE np_comm_id = \?/,
    'and it only pays the PSN call when a pack is actually missing');
});
