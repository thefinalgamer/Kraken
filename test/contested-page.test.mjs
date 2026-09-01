import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bodyOf } from './helpers.mjs';
import { localMultiplier } from '../shared/scoring.mjs';
import { CONTESTED_MIN_OWNERS } from '../shared/contested.mjs';

/**
 * The contested PAGE. `contested.test.mjs` next door covers the shared module
 * and the Discord card; this covers /contested on the website.
 *
 * THE FIRST TEST IS THE IMPORTANT ONE. This page copies its definition from
 * shared/contested.mjs rather than importing the SQL — it needs extra columns
 * in the SELECT — so the two can drift. If they do, members get one answer from
 * `/contested` in Discord and a different one on the site, and neither looks
 * wrong on its own. So every WHERE and ORDER BY term is compared, not eyeballed.
 */
const mod = await import('../functions/contested.js');

const DAY = 86400000;

const GAMES = [
  // Nine own it, three finished — the middling case, mid-table.
  { np_comm_id: 'NPWR_ELDEN', title: 'Elden Ring', platform: 'PS5', icon_url: null,
    trophy_count: 42, max_points: 8400, estimated: 0, local_started: 9,
    unobtainable: 0, unobtainable_note: null, closes_at: null,
    platted_here: 3, plat_points: 279, plat_rate: 2.4 },
  // Nobody here has finished it at all.
  { np_comm_id: 'NPWR_WALL', title: 'Ghost Runner', platform: 'PS4', icon_url: null,
    trophy_count: 30, max_points: 3000, estimated: 0, local_started: 5,
    unobtainable: 0, unobtainable_note: null, closes_at: null,
    platted_here: 0, plat_points: 140, plat_rate: 0.9 },
  // Closing in six days. Must outrank both, whatever its ratio.
  { np_comm_id: 'NPWR_CLOCK', title: 'Sea of Thieves', platform: 'PS5', icon_url: null,
    trophy_count: 100, max_points: 9000, estimated: 0, local_started: 4,
    unobtainable: 0, unobtainable_note: null, closes_at: Date.now() + 6 * DAY,
    platted_here: 3, plat_points: 88, plat_rate: 8.7 },
];

const NEAR = [
  { np_comm_id: 'NPWR_ELDEN', progress: 94, psn_online_id: 'JFL__Leon' },
  { np_comm_id: 'NPWR_ELDEN', progress: 61, psn_online_id: 'Snolib' },
  { np_comm_id: 'NPWR_CLOCK', progress: 40, psn_online_id: 'th3finalgamer--' },
  // NPWR_WALL deliberately has nobody, to exercise the empty branch.
];

let lastSql = '';
let lastBind = [];
let lastNearBind = [];
let lastNearSql = '';

const fakeEnv = ({ games = GAMES, near = NEAR } = {}) => ({
  DB: {
    prepare(sql) {
      return {
        bind: (...args) => {
          if (sql.includes('FROM member_games')) {
            lastNearSql = sql;
            lastNearBind = args;
            return { all: async () => ({ results: near }) };
          }
          lastSql = sql;
          lastBind = args;
          return { all: async () => ({ results: games }) };
        },
      };
    },
  },
});

const render = async (opts, query = '') => {
  const res = await mod.onRequestGet({
    env: fakeEnv(opts),
    request: new Request(`https://kraken.test/contested${query}`),
  });
  return { res, out: await res.text() };
};

/** Whitespace-insensitive, so two SQL strings compare as logic not layout. */
const norm = (s) => s.replace(/\s+/g, ' ').trim();

test('the definition matches shared/contested.mjs exactly', async () => {
  const canonical = await readFile(new URL('../shared/contested.mjs', import.meta.url), 'utf8');
  const canonSql = norm(canonical.slice(canonical.indexOf('SELECT g.np_comm_id')));

  await render();
  const pageSql = norm(lastSql);

  for (const clause of [
    'g.local_started >= ?',
    't.local_earned < g.local_started',
    'g.max_points > 0',
    'g.unobtainable = 0',
    "t.np_comm_id = g.np_comm_id AND t.type = 'platinum'",
  ]) {
    assert.ok(canonSql.includes(clause), `canonical has: ${clause}`);
    assert.ok(pageSql.includes(clause), `the page is missing: ${clause}`);
  }

  const orderOf = (sql) => norm(sql.slice(sql.indexOf('ORDER BY'), sql.indexOf('LIMIT')));
  assert.equal(orderOf(pageSql), orderOf(canonSql), 'the ORDER BY must be identical');
});

test('the minimum owner count comes from the shared module, not a literal', async () => {
  // A contest needs a crowd, and the threshold is a definition rather than a
  // page-level preference. Hard-coding 3 here is how the two drift apart.
  await render();
  assert.equal(lastBind[0], CONTESTED_MIN_OWNERS);
});

test('the closing row reads as urgent before a single date is read', async () => {
  /**
   * The ORDERING itself is pinned by the first test, against the canonical SQL
   * — SQLite does the sorting and the fake returns rows verbatim, so asserting
   * order here would only be testing the fixture. What IS this page's job is
   * turning that order into something readable at a glance: the stripe.
   */
  const { out } = await render({
    // As the database would hand them over: deadline first.
    games: [GAMES[2], GAMES[0], GAMES[1]],
  });
  const body = bodyOf(out);

  assert.ok(body.indexOf('Sea of Thieves') < body.indexOf('Elden Ring'), 'rendered in order');
  assert.match(body, /<tr class="st-soon">[\s\S]{0,1400}Sea of Thieves/, 'six days is urgent');
  assert.match(body, /<tr class="st-none">[\s\S]{0,1400}Elden Ring/, 'no deadline, no colour');
  assert.match(body, /class="closes"/, 'and the deadline is spelled out, not only shaded');
});

test('the multiplier is the one the scoring applies, computed not reimplemented', async () => {
  const { out } = await render();
  const body = bodyOf(out);

  const expected = localMultiplier(3, 9);
  assert.ok(body.includes(`&times;${expected.toFixed(2)}`), `expected ×${expected.toFixed(2)}`);

  // Two decimals always. ×1.00 and ×1.40 are different situations, and rounding
  // both to "×1" would flatten the only figure here that moves week to week.
  assert.ok(!/&times;\d+<\/td>/.test(body), 'never a bare integer multiplier');
});

test('who is closest is named, and their absence is said plainly', async () => {
  const { out } = await render();
  const body = bodyOf(out);

  // "Six of nine are stuck" is a statistic. "Six of nine, and Leon is on 94%"
  // is a race — that difference is the reason this page exists.
  assert.ok(body.includes('JFL__Leon'), 'the leader is named');
  assert.ok(body.includes('94%'), 'with how far along they are');
  assert.ok(!body.includes('Snolib'), 'the runner-up is not — one name, not a list');
  assert.ok(body.includes('href="/hunter/JFL__Leon"'), 'and it links through');

  // "nobody has started" claimed more than the query knows — the empty branch
  // means no ranked owner sits under 100%, not that nobody has touched it.
  assert.ok(body.includes('no progress yet'), 'an empty game says so rather than going blank');
});

test('the closest lookup is one query for the whole page, scoped to its rows', async () => {
  // Twenty-five round trips to name twenty-five people would cost more in
  // latency than the entire rest of the page costs in rows.
  await render();
  assert.deepEqual(
    [...lastNearBind].sort(),
    ['NPWR_CLOCK', 'NPWR_ELDEN', 'NPWR_WALL'],
    'exactly the ids on this page, and nothing else',
  );
});

test('the closest query excludes people who have finished, and the unranked', async () => {
  /**
   * This asserted `!lastSql.includes('member_games')`, which tested the FAKE's
   * routing and would have passed with no exclusion at all. Assert the query.
   *
   * Somebody at 100% has finished and is not part of the contest, whatever the
   * platinum row says about them; a member mid-first-scan is not somebody you
   * are racing yet, which is the same rule every other list on the site uses.
   */
  await render();
  assert.match(lastNearSql, /mg\.progress < 100/, 'finishers are out');
  assert.match(lastNearSql, /m\.rank IS NOT NULL/, 'and so is anybody unranked');
  assert.match(lastNearSql, /ORDER BY mg\.progress DESC/, 'the leader comes first');
});

test('the pager asks for one more row than it shows and never counts', async () => {
  await render();
  assert.ok(!lastSql.includes('COUNT('), 'no COUNT(*) — that reads the whole join');
  assert.equal(lastBind[1], 26, 'twenty-five shown, twenty-six asked for');
  assert.equal(lastBind[2], 0, 'first page starts at zero');

  await render(undefined, '?page=3');
  assert.equal(lastBind[2], 50, 'page 3 offsets by fifty');
});

test('a full page plus one shows Next but claims no total', async () => {
  const many = Array.from({ length: 26 }, (_, i) => ({ ...GAMES[0], np_comm_id: `N${i}` }));
  const { out } = await render({ games: many });
  const body = bodyOf(out);
  assert.ok(body.includes('Next'), 'there is a next page');
  assert.ok(!/Page 1 of/.test(body), 'but never "of N" — nothing counted it');
  assert.equal(
    (body.match(/href="\/game\/N\d+"/g) || []).length,
    25,
    'the twenty-sixth row proves Next exists and is never rendered',
  );
});

test('positions continue across pages rather than restarting at one', async () => {
  // A board where page 2 starts at "1" again is two boards.
  const { out } = await render(undefined, '?page=2');
  assert.match(bodyOf(out), /class="pos">26</, 'page 2 opens at 26');
});

test('an empty board explains itself instead of showing a bare table', async () => {
  const { out } = await render({ games: [] });
  assert.ok(out.includes('Nothing is contested right now'));
  assert.ok(!bodyOf(out).includes('<tbody>'), 'and draws no table at all');
});

test('a hostile game title cannot inject markup', async () => {
  const { out } = await render({ games: [{ ...GAMES[0], title: '<img src=x onerror=alert(1)>' }] });
  assert.ok(out.includes('&lt;img'));
  assert.ok(!out.includes('<img src=x'));
});

test('a hostile PSN id cannot break out of the closest link', async () => {
  const { out } = await render({
    near: [{ np_comm_id: 'NPWR_ELDEN', progress: 90, psn_online_id: '"><script>alert(1)</script>' }],
  });
  assert.ok(!out.includes('<script>alert(1)'));
});
