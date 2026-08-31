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

test('autocomplete asks the database nothing until two characters are typed', () => {
  // Discord fires the moment the field is focused. A bare focus and a single
  // letter both have better answers than a search, and a search for "a" is a
  // lottery over every game ever released.
  assert.match(SRC, /const MIN_QUERY = 2/, 'the floor exists');
  const fn = SRC.slice(SRC.indexOf('async function handleAutocomplete'));
  assert.match(
    fn.slice(0, 2000),
    /focused\.length < MIN_QUERY/,
    'and the handler checks it before searching',
  );
});

test('autocomplete answers only for fields it populates', () => {
  // A future option with autocomplete switched on and no handler should get an
  // empty list, not silently get a list of game titles.
  assert.match(SRC, /AUTOCOMPLETE_FIELDS = new Set\(\['game', 'title'\]\)/);
  const fn = SRC.slice(SRC.indexOf('async function handleAutocomplete'));
  assert.match(fn.slice(0, 2000), /AUTOCOMPLETE_FIELDS\.has\(option\.name\)/);
});
