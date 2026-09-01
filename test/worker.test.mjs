import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Static checks on the Worker.
 *
 * These exist because of a real incident: a refactor replaced a range of text
 * that ran further than intended and deleted five commands and every button
 * handler — /rank, /leaderboard, /game, /backlog, View profile and
 * handleComponent — all at once. `node --check` passed, because the file was
 * still valid JavaScript. The unit tests passed, because they only covered
 * shared/. It shipped, and the first sign of trouble would have been a member
 * pressing a button.
 *
 * The Worker can't be imported here — it wants a Cloudflare env binding and a
 * D1 database — so these read the source instead. Crude, but they catch the
 * one failure mode that actually happened: a switch dispatching to something
 * that no longer exists.
 */
const SRC = readFileSync(
  fileURLToPath(new URL('../worker/src/index.mjs', import.meta.url)),
  'utf8',
);

const declared = () => {
  const names = new Set();
  for (const m of SRC.matchAll(/(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
  for (const m of SRC.matchAll(/const\s+(\w+)\s*=/g)) names.add(m[1]);
  for (const m of SRC.matchAll(/import\s*\{([^}]+)\}/gs)) {
    for (const part of m[1].split(',')) names.add(part.trim().split(/\s+as\s+/).pop());
  }
  return names;
};

test('every slash command dispatches to a function that exists', () => {
  const names = declared();
  const block = SRC.slice(SRC.indexOf('async function handleCommand'));
  const cases = [...block.matchAll(/case '([\w-]+)':\s*return (\w+)\(/g)];

  assert.ok(cases.length >= 8, `expected the full command list, found ${cases.length}`);
  for (const [, command, fn] of cases) {
    assert.ok(names.has(fn), `/${command} calls ${fn}(), which is not defined anywhere`);
  }
});

test('every button dispatches to a function that exists', () => {
  const names = declared();
  const start = SRC.indexOf('async function handleComponent');
  assert.ok(start > 0, 'handleComponent is missing — every button in the bot is dead');

  const block = SRC.slice(start, start + 4000);
  for (const [, fn] of block.matchAll(/return (?:\{ \.\.\.update\(\(await )?(\w+)\(/g)) {
    if (['update', 'reply', 'errorReply'].includes(fn)) continue;
    assert.ok(names.has(fn), `a button calls ${fn}(), which is not defined anywhere`);
  }
});

test('the commands members actually use are all still present', () => {
  // Named explicitly, so deleting one is a failing test rather than a silent
  // regression. Every one of these was lost in the incident above.
  for (const fn of [
    'rank', 'leaderboard', 'game', 'backlog', 'profile', 'changelog',
    'register', 'verify', 'unlink', 'runUpdate', 'addMember',
    'handleComponent', 'handleAutocomplete', 'dispatchScan',
  ]) {
    assert.match(
      SRC,
      new RegExp(`(?:async\\s+)?function\\s+${fn}\\b`),
      `${fn}() has gone missing from the Worker`,
    );
  }
});

// -------------------------------------------------------- autocomplete ----

/**
 * The dropdown on /flag and /game, which Discord fires PER KEYSTROKE.
 *
 * Real behavioural tests rather than source greps, because what was wrong here
 * was not a missing function — it was a query reading the whole games table,
 * twenty-six thousand rows at a time, to build a list that then had the wrong
 * games in it.
 */
const dbmod = await import('../worker/src/db.mjs');

let lastSql = '';
let lastArgs = [];
const spyEnv = (rows = []) => ({
  DB: {
    prepare(sql) {
      lastSql = sql;
      return {
        bind: (...args) => {
          lastArgs = args;
          return { all: async () => ({ results: rows }) };
        },
      };
    },
  },
});

test('the game search only reads games somebody here owns', async () => {
  // 26,042 rows per keystroke was a tenth of the bot's daily budget spent on a
  // dropdown. This cuts it to about 514 — and to exactly the right 514, since a
  // game nobody here owns cannot usefully be flagged or asked about.
  await dbmod.searchGames(spyEnv(), 'minecraft', 25);
  assert.match(lastSql, /local_started > 0/, 'unowned games are not searched');
  assert.match(lastSql, /LIKE \? COLLATE NOCASE/, 'still a case-insensitive match');
  assert.equal(lastArgs[0], '%minecraft%', 'mid-word matches still work');
  assert.equal(lastArgs[1], 'minecraft%', 'and prefix matches sort first');
});

test('the game search offers the most-owned match first, not the shortest', async () => {
  // Ordering by LENGTH(title) buried the answer: typing "mine" offered the five
  // shortest titles on PSN containing those letters, and Minecraft was not
  // among them. Speed would not have saved that list — it was wrong.
  await dbmod.searchGames(spyEnv(), 'mine', 25);
  const order = lastSql.slice(lastSql.indexOf('ORDER BY'));
  assert.ok(
    order.indexOf('owners DESC') < order.indexOf('LENGTH(title)'),
    'how many of us own it outranks how short the name is',
  );
});

/**
 * The body of handleAutocomplete, bounded by the divider that follows it.
 *
 * This used to be `.slice(0, 4000)`, which is a guess about how long the
 * function is, and adding /flag's version and trophy branches pushed the game
 * branch past it. A test that fails because unrelated code grew is a test that
 * gets deleted.
 */
const autocompleteBody = () => {
  const start = SRC.indexOf('async function handleAutocomplete');
  const end = SRC.indexOf('// ------', start);
  return SRC.slice(start, end === -1 ? undefined : end);
};

test('game autocomplete asks the database nothing until two characters are typed', () => {
  // Discord fires the moment the field is focused. A bare focus and a single
  // letter both have better answers than a search, and a search for "a" is a
  // lottery over every game ever released.
  //
  // The MEMBER branch has no such floor and does not need one: the members
  // table is seventy rows, so a one-letter search there is a scan of nothing.
  assert.match(SRC, /const MIN_QUERY = 2/, 'the floor exists');
  assert.match(
    autocompleteBody(),
    /focused\.length < MIN_QUERY/,
    'and the handler checks it before searching games',
  );
});

test('autocomplete answers only for fields it populates', () => {
  // A future option with autocomplete switched on and no handler should get an
  // empty list, not silently get a list of game titles.
  assert.match(SRC, /GAME_FIELDS = new Set\(\['game', 'title'\]\)/);
  assert.match(SRC, /MEMBER_FIELDS = new Set\(\['add', 'remove'\]\)/);
  assert.match(autocompleteBody(), /GAME_FIELDS\.has\(option\.name\)/);
});

test('the member picker is scoped to /rivals, not to any option called add', () => {
  // "add" and "remove" are ordinary words. Keying on the option name alone
  // would hand a list of PSN IDs to some future /flag add: option.
  const fn = SRC.slice(SRC.indexOf('async function handleAutocomplete'));
  assert.match(
    fn.slice(0, 4000),
    /interaction\.data\.name === 'rivals' && MEMBER_FIELDS\.has/,
    'the command name is part of the test',
  );
});

test('/game shows what the member banks, not the game\'s raw worth', async () => {
  /**
   * The bug Martin and JFL__Leon found by comparing notes: both ran /game on
   * Borderlands 2 and both were told 1,400. Rarity is shared, so the raw figure
   * is identical for anybody holding the same trophies — but the card's heading
   * is the word "you", and at 70.41% and 91.44% they bank 980 and 1,274.
   *
   * /backlog has always multiplied. This asserts the /game card does too, and
   * that the working is shown the same way /rank shows it.
   */
  const src = SRC;

  assert.match(src, /function worthLine\(member, banked, fullValue, remaining\)/,
    'the line is a named function, so it can be reasoned about in one place');
  assert.match(src, /worthLine\(member, banked, fullValue, worth\)/, 'and the card calls it');
  assert.ok(
    !/\*\*Worth to you:\*\* \$\{n\(banked\)\} of \$\{n\(fullValue\)\}/.test(
      src.slice(src.indexOf('const owners = await db.gameOwners')),
    ),
    'the raw pair is no longer printed under that heading',
  );
  assert.match(src, /rarity points \\u00d7 \$\{pct\(c\)\} completion/,
    'and the multiplier is explained, not silently applied');
});

test('per-trophy values are never multiplied', async () => {
  // A trophy's worth is a property of the trophy and identical for everyone.
  // Multiplying a 1-point trophy by anybody's completion floors it to nothing,
  // and the top-three list becomes three zeroes.
  const src = SRC;
  const top = src.slice(src.indexOf('const top = ['), src.indexOf('const owners = await db.gameOwners'));
  assert.ok(top.includes('n(t.points)'), 'the trophy list prints the stored value');
  assert.ok(!top.includes('applyCompletion'), 'and does not scale it');
});

/* ---------------------------------------------------------------------------
 * /flag gained a version and a trophy.
 *
 * The gap mods hit: /flag could only say "this whole title is broken", and it
 * said it about every edition at once. Sea of Thieves on PS4 can die while the
 * PS5 list carries on, and there was no way to say so.
 * ------------------------------------------------------------------------ */

test('/flag takes a version and a trophy, both optional', () => {
  const reg = readFileSync(
    fileURLToPath(new URL('../jobs/register-commands.mjs', import.meta.url)), 'utf8',
  );
  const start = reg.indexOf("name: 'flag'");
  // From `options:`, not from the command name — otherwise the command's own
  // `name: 'flag'` pairs with the game option's `required: true`.
  const flag = reg.slice(reg.indexOf('options: [', start), reg.indexOf("name: 'supporter'"));

  for (const field of ['version', 'trophy']) {
    assert.ok(flag.includes(`name: '${field}'`), `${field} option exists`);
  }
  // Optional, so every /flag a mod runs today keeps working unchanged — all
  // editions remains the default because a shutdown usually does kill them all.
  const opts = [...flag.matchAll(/name: '(\w+)',[\s\S]*?required: (\w+)/g)]
    .map((m) => [m[1], m[2]]);
  assert.deepEqual(
    opts.filter(([, req]) => req === 'true').map(([nm]) => nm),
    ['game'],
    'only the game is required',
  );
  assert.match(flag, /name: 'version'[\s\S]*?autocomplete: true/, 'version autocompletes');
  assert.match(flag, /name: 'trophy'[\s\S]*?autocomplete: true/, 'so does trophy');
});

test('the version and trophy pickers read the options already filled in', () => {
  // Discord sends every option value on an autocomplete interaction, not just
  // the focused one. That is the only reason a dependent dropdown works without
  // storing anything between keystrokes.
  const body = autocompleteBody();
  assert.match(body, /FLAG_FIELDS\.has\(option\?\.name\)/, 'scoped to /flag');
  assert.match(body, /interaction\.data\.options\?\.find\(\(o\) => o\.name === name\)/,
    'reads sibling options');
  assert.match(body, /db\.gameVersions\(env, title\)/, 'versions come from the chosen game');
  assert.match(body, /db\.searchTrophies\(env, npCommId, focused/, 'trophies from the chosen edition');
});

test('a trophy on a multi-edition title refuses to guess which edition', () => {
  // Trophy ids are only unique inside one np_comm_id. Guessing would flag the
  // wrong game's trophy and nobody would find out.
  const fn = SRC.slice(SRC.indexOf('async function flagTrophy'), SRC.indexOf('async function flagGame'));
  assert.match(fn, /editions\.length > 1/, 'it counts the editions');
  assert.match(fn, /Pick a `version` as well/, 'and says so rather than picking one');
});

test('flagging a trophy never touches points', () => {
  /**
   * Martin's rule, and it is settled: "we cant take points away from people for
   * earning something that no longer achievable." The flag is a warning to
   * whoever comes next, not a repricing.
   */
  const rescore = readFileSync(
    fileURLToPath(new URL('../jobs/rescore.mjs', import.meta.url)), 'utf8',
  );

  /**
   * The rescore DOES touch `games.unobtainable` — that is the nightly rollover
   * flipping a game dead once its announced closing date passes, and it moves
   * no points. What must never appear is the TROPHY flag reaching the scoring,
   * because that is the version of this feature Martin ruled out.
   */
  assert.ok(!/FROM trophies[\s\S]{0,400}unobtainable/.test(rescore),
    'the rescore never selects the trophy flag');
  assert.ok(!/unobtainable[\s\S]{0,120}points/.test(rescore),
    'and no flag column sits near a points calculation');

  /**
   * Asserting the WORD "points" is absent was the first attempt and it was
   * wrong — the reply says "Nobody loses points for having earned it", which is
   * the sentence most worth keeping. Assert on the db calls instead: the only
   * two writes this handler makes are the two flags.
   */
  const fn = SRC.slice(SRC.indexOf('async function flagTrophy'), SRC.indexOf('async function flagGame'));
  const calls = [...fn.matchAll(/db\.(\w+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    [...new Set(calls)],
    ['deadTrophies', 'gameVersions', 'setTrophyUnobtainable', 'setUnobtainable', 'trophyRow'],
    'two flag writes and three reads — nothing that can move a score',
  );
  assert.match(fn, /Nobody loses points for having earned it/,
    'and the mod is told so in the reply');
});

test('the game flag is rolled up from its trophies, and cleared with the last one', () => {
  // A mod who marks a trophy broken has said the game cannot be completed.
  // Making them run /flag twice is how a game ends up with a dead trophy and no
  // warning on it — and a hand-set flag would never come off when it was fixed.
  const fn = SRC.slice(SRC.indexOf('async function flagTrophy'), SRC.indexOf('async function flagGame'));
  assert.match(fn, /db\.deadTrophies\(env, target\.np_comm_id\)/, 'counts what is actually flagged');
  assert.match(fn, /on: dead\.length > 0/, 'game flag follows the count, in both directions');
  assert.match(fn, /npCommId: target\.np_comm_id/, 'and only on the edition that owns the trophy');
});

test('a closing date on a single trophy is refused, not ignored', () => {
  // Same class of bug parseClosingDate exists to prevent: a mod believes they
  // set a countdown, it never appears, nobody finds out until the servers go.
  const fn = SRC.slice(SRC.indexOf('async function flagTrophy'), SRC.indexOf('async function flagGame'));
  assert.match(fn, /if \(closesAt\) \{[\s\S]{0,200}errorReply/, 'it errors');
});

test('a typed-in version is checked against the database, not trusted', () => {
  // A mod can type into an autocomplete box instead of picking from it.
  const fn = SRC.slice(SRC.indexOf('async function flagGame'));
  assert.match(fn.slice(0, 6000), /db\.gameById\(env, wanted\)/, 'the id is looked up');
  assert.match(fn.slice(0, 6000), /is not an edition I know/, 'and rejected if it is not real');
  assert.match(fn.slice(0, 6000), /Pick the game again/, 'and if it belongs to another title');
});

test('a closing date with a note counts down — it does not kill the game today', () => {
  /**
   * The bug this replaces: `on: Boolean(clean)` meant the obvious command —
   *
   *   /flag <game> closes:2027-03-15 note:"Servers shut down"
   *
   * — marked the game unobtainable that night, eighteen months early, and the
   * countdown the mod thought they were setting never mattered because the game
   * was already dead. A note is now the REASON for the countdown.
   */
  const fn = SRC.slice(SRC.indexOf('async function flagGame'));
  assert.match(fn.slice(0, 9000), /on: Boolean\(clean\) && !closesAt/,
    'a date means not yet, whatever else was typed');
  assert.ok(!/on: Boolean\(clean\),/.test(fn.slice(0, 9000)),
    'and the old unconditional form is gone');
});

test('a note with no date still means broken now', () => {
  // The other half. A moderator writing a note and no date is saying the game
  // is already gone, which is what /flag was built for.
  const fn = SRC.slice(SRC.indexOf('async function flagGame'));
  assert.match(fn.slice(0, 9000), /### ⚠️ \$\{match\.title\} flagged/, 'the dead reply exists');
  assert.ok(!/Also counting down/.test(fn.slice(0, 9000)),
    'and it no longer mentions a countdown, because that path cannot be reached');
});

test('the countdown reply carries the reason and says nothing is dead yet', () => {
  const fn = SRC.slice(SRC.indexOf('async function flagGame'));
  const window = fn.slice(0, 9000);
  assert.match(window, /if \(closesAt\) \{/, 'one branch for every dated flag');
  assert.match(window, /clean \? `\\n\\n> \$\{clean\}` : ''/, 'the mod\'s words are shown back');
  assert.match(window, /Nothing is unobtainable yet/, 'and the state is stated plainly');
});

test('a closing date is scoped to one edition when a version is given', () => {
  // Sea of Thieves on PS4 can die while the PS5 list carries on. The date has
  // to follow the same scoping the dead flag does, or a mod scopes the flag and
  // silently sets a countdown on all three editions anyway.
  const fn = SRC.slice(SRC.indexOf('async function flagGame'));
  const call = fn.slice(fn.indexOf('db.setUnobtainable'), fn.indexOf('if (!clean && !closesAt)'));
  assert.match(call, /closesAt,/, 'the date goes through');
  assert.match(call, /npCommId: edition\?\.np_comm_id \?\? null/, 'with the edition beside it');
});
