import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * A GAME YOU HAVE NEVER TOUCHED TAKES NOTHING FROM YOU AND GIVES NOTHING.
 *
 * PrimalxFear, 12 October:
 *
 *   "0% games should not count towards completion or any point system.
 *    1 trophy / 1% upwards only.
 *    We noticed if you delete 0% games you get points and that is cheasable.
 *    say the seasonal is about to begin, i start 20 games before it start at 0%
 *    and get my completion rate down. Then when it starts i delete those games
 *    and BOOM 1st place because i got points.
 *    Also you can fuck someone over, start games that other people started and
 *    later delete them giving them -decay."
 *
 * Martin: "0% games shouldnt effect you i agree, regardless if people move or
 * not it shouldnt be a thing."
 *
 * THREE EXPLOITS, TWO HALVES OF A FIX. Deleting for points and the pre-season
 * setup are both completion; moving somebody else's score by starting their
 * games is local rarity. Ship one half and the other survives, so both are
 * tested here together.
 *
 * Measured before building: 780 never-started rows out of 76,634, across 74
 * members. Nobody had a stockpile — the heaviest holders were small libraries
 * with ordinary backlogs. The rule is not a response to cheating that happened,
 * it is removing the reason for it to start once a season has a start date.
 */

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const { COMPLETION_SQL } = await import('../jobs/lib/completion.mjs');

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE games (np_comm_id TEXT PRIMARY KEY, max_points INTEGER,
                        completion_weight INTEGER);
    CREATE TABLE member_games (psn_account_id TEXT, np_comm_id TEXT, earned_total INTEGER,
                               earned_gold INTEGER DEFAULT 0, earned_silver INTEGER DEFAULT 0,
                               earned_bronze INTEGER DEFAULT 0);
  `);
  return d;
}

/** A game worth something, with `weight` of completion in it. */
const game = (d, id, weight) =>
  d.prepare('INSERT INTO games VALUES (?,?,?)').run(id, 1000, weight);

/** What this member holds in it. `bronze` bronzes, nothing else. */
const owns = (d, id, bronze) =>
  d.prepare('INSERT INTO member_games VALUES (?,?,?,?,?,?)')
    .run('acct-1', id, bronze, 0, 0, bronze);

const completionOf = (d) => {
  const row = d.prepare(COMPLETION_SQL).get('acct-1');
  const earned = Number(row.earned) || 0;
  const defined = Number(row.defined) || 0;
  return defined ? Math.floor((earned / defined) * 10000) / 100 : 0;
};

test('a game with nothing earned in it is outside completion entirely', { skip: !DatabaseSync }, () => {
  /**
   * The whole of exploits one and two. Before this, owning an untouched game
   * dragged completion DOWN, and completion multiplies the entire score — so
   * deleting one paid, and PSN allows deleting precisely the lists you have
   * earned nothing in.
   */
  const d = db();
  game(d, 'PLAYED', 1500);
  owns(d, 'PLAYED', 50);          // 50 bronzes = 750 of 1500 weight
  const before = completionOf(d);

  game(d, 'UNTOUCHED', 3000);
  owns(d, 'UNTOUCHED', 0);
  const after = completionOf(d);

  assert.equal(before, 50, 'half of the one game they have played');
  assert.equal(after, before, 'and adding an untouched game changes nothing at all');
});

test('so deleting it is worth exactly nothing', { skip: !DatabaseSync }, () => {
  // The move Primal described, run both ways round. If the two numbers differ
  // by a single hundredth there is still a reason to delete.
  const d = db();
  game(d, 'PLAYED', 1500);
  owns(d, 'PLAYED', 50);
  game(d, 'A', 3000); owns(d, 'A', 0);
  game(d, 'B', 9000); owns(d, 'B', 0);
  const holding = completionOf(d);

  d.prepare("DELETE FROM member_games WHERE np_comm_id IN ('A','B')").run();
  assert.equal(completionOf(d), holding, 'the oldest exploit on the board, closed');
});

test('one trophy is enough to count, however little the percentage says', { skip: !DatabaseSync }, () => {
  /**
   * The precision that matters. PSN's progress is WEIGHTED, so a single bronze
   * in a ninety-trophy list still reads as 0% — and a rule written against the
   * percentage would quietly exclude somebody who had genuinely started.
   * `earned_total > 0` is the honest test.
   */
  const d = db();
  game(d, 'PLAYED', 1500);
  owns(d, 'PLAYED', 50);
  game(d, 'BARELY', 1500);
  owns(d, 'BARELY', 1);           // one bronze: 15 of 1500, reads as 0% on PSN

  assert.equal(completionOf(d), 25.5, 'counted, both halves of it');
});

test('a worthless game is still worthless, as it was before', { skip: !DatabaseSync }, () => {
  // The rule from 19 August is untouched: max_points = 0 stays out whether or
  // not anything was earned in it.
  const d = db();
  game(d, 'PLAYED', 1500);
  owns(d, 'PLAYED', 50);
  d.prepare('INSERT INTO games VALUES (?,?,?)').run('SHOVEL', 0, 3000);
  owns(d, 'SHOVEL', 100);

  assert.equal(completionOf(d), 50, 'shovelware neither helps nor hurts');
});

test('local rarity counts owners who have earned something, not owners', async () => {
  /**
   * The third exploit, and the half that is easy to forget. `local_started` is
   * the denominator of local rarity, so adding yourself to a game as a
   * non-finisher changes what it pays EVERYBODY who owns it — a lever on other
   * people's scores needing no deletion and costing nothing to pull.
   *
   * Read as text because countLocalRarity() pages a live D1 and is not
   * importable in isolation; the behaviour it guards is one line.
   */
  const src = await readFile(new URL('../jobs/rescore.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  assert.match(code, /SELECT np_comm_id, earned_total, earned_ids FROM member_games/,
    'the count comes back with the query');
  assert.match(
    code,
    /if \(\(Number\(row\.earned_total\) \|\| 0\) > 0\) \{\s*started\.set\(/,
    'and only an owner who earned something is counted as one',
  );
});

test('the two halves ship together or the fix is half a fix', async () => {
  // Completion alone leaves exploit three untouched; local rarity alone leaves
  // one and two. Neither file is allowed to drift back on its own.
  const completion = await readFile(new URL('../jobs/lib/completion.mjs', import.meta.url), 'utf8');
  const rescore = await readFile(new URL('../jobs/rescore.mjs', import.meta.url), 'utf8');

  assert.match(completion, /AND mg\.earned_total > 0/, 'completion half');
  assert.match(rescore, /Number\(row\.earned_total\) \|\| 0\) > 0/, 'local rarity half');
});

/* ---- the one hole the 0% rule does not cover ---- */

test('the scan records what PSN counts against what it will show', async () => {
  /**
   * Martin, 12 October: "if player two joins us but before he joins us he
   * deletes all his shit to make himself look good... anyway we can see this?"
   *
   * Deleting is already dead: PSN only permits it on a list you have earned
   * nothing in, and those now count for nothing. HIDING has no such limit, and
   * somebody who hides a half-finished game before registering arrives with it
   * simply absent — no history, nothing to compare against.
   *
   * The account summary and the titles call answer different questions and
   * ought to agree. Where they do not, the difference is trophies PSN counts on
   * the profile and will not list a game for. It works on a first scan, which
   * is the case nothing else covers.
   *
   * A NUMBER, NOT AN ACCUSATION, and stored as two numbers and a date with no
   * flag: Sony delists games, regional stacks move, short responses drop
   * titles. Migration 042.
   */
  const src = await readFile(new URL('../jobs/scan.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  assert.match(
    code,
    /const visibleTrophies = titles\.reduce\(\(n, t\) => n \+ sumTrophies\(t\.earnedTrophies\), 0\)/,
    'it adds up what the games actually show',
  );
  assert.match(code, /summary_trophies = \?, visible_trophies = \?/, 'and stores both sides');

  // Best-effort: the columns arrive in 042, and a database without them must
  // lose the measurement rather than the scan.
  assert.match(code, /visible_trophies[\s\S]{0,260}?\.catch\(\(\) => \{\}\)/, 'never fatal');

  // Nothing member-facing may read it. The same rule migration 036 carries.
  const faq = await readFile(new URL('../shared/faq.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(faq, /summary_trophies|visible_trophies/, 'no badge, no card, no mention');
});
