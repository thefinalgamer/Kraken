import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The hunter page, rendered against fake rows.
 *
 * The fake reads the SQL it is handed and answers accordingly, which is ugly
 * but keeps the tests honest: the page has to issue the queries it actually
 * issues, in the shape it actually issues them, or the stub returns nothing and
 * the assertions fail.
 *
 * The one that matters most is the sort whitelist. `sort` comes off the query
 * string and picks an ORDER BY fragment; if a stray refactor ever interpolated
 * it instead of looking it up, anybody with a browser would own the database.
 */
const mod = await import('../functions/hunter/[name].js');

const MEMBER = {
  psn_account_id: 'acc-1', psn_online_id: 'JFL__Leon', country: 'GB',
  avatar_url: 'https://example.test/a.png', rank: 27, prev_rank: 28,
  points: 186406, completion: 87.45, platinum: 310, gold: 2041,
  silver: 2397, bronze: 6462, projects: 354, completed: 319,
  last_update_at: Date.now(),
};

const GAMES = [
  { np_comm_id: 'NPWR1', title: 'Bloodborne', platform: 'PS4', icon_url: 'https://x.test/b.png',
    max_points: 4200, unobtainable: 0, unobtainable_note: null, trophy_count: 40,
    points: 4200, progress: 100, earned_total: 40, last_earned_at: Date.now() - 86400000 },
  { np_comm_id: 'NPWR2', title: 'Sea of Thieves', platform: 'PS5', icon_url: null,
    max_points: 9000, unobtainable: 1, unobtainable_note: 'Servers closed', trophy_count: 100,
    points: 1500, progress: 41, earned_total: 41, last_earned_at: Date.now() - 8 * 86400000 },
  { np_comm_id: 'NPWR3', title: 'Bunny Mahjo', platform: 'PS4', icon_url: null,
    max_points: 0, unobtainable: 0, unobtainable_note: null, trophy_count: 30,
    points: 0, progress: 100, earned_total: 30, last_earned_at: null },
];

/**
 * Three updates, newest first, exactly as the query returns them.
 *
 * The deltas are deliberately not all positive: a member's score goes down when
 * they start something new, and a curve that cannot go down is not a curve of
 * this board.
 */
const DAY = 86400000;
const T0 = 1750000000000;
const UPDATES = [
  { id: 3, started_at: T0 + 20 * DAY, finished_at: T0 + 20 * DAY + 60000, d_points: 6406,
    points_earned: 8000, points_backlog: -1000, points_drift: -594 },
  { id: 2, started_at: T0 + 10 * DAY, finished_at: T0 + 10 * DAY + 60000, d_points: -2000,
    points_earned: 500, points_backlog: -2400, points_drift: -100 },
  { id: 1, started_at: T0, finished_at: T0 + 900000, d_points: 182000,
    points_earned: 182000, points_backlog: 0, points_drift: 0 },
];

let lastGamesSql = '';
let lastBind = [];

const fakeEnv = ({ member = MEMBER, games = GAMES, updates = UPDATES } = {}) => ({
  DB: {
    prepare(sql) {
      const answer = (args) => {
        if (sql.includes('FROM members')) {
          return sql.includes('COUNT(*)')
            ? { first: async () => ({ c: 64 }), all: async () => ({ results: [] }) }
            : { first: async () => member, all: async () => ({ results: member ? [member] : [] }) };
        }
        if (sql.includes('FROM updates')) {
          return { first: async () => updates[0], all: async () => ({ results: updates }) };
        }
        lastGamesSql = sql;
        lastBind = args;
        return { first: async () => games[0], all: async () => ({ results: games }) };
      };
      return { ...answer([]), bind: (...args) => answer(args) };
    },
  },
});

const render = async (name, query = '', opts) => {
  const res = await mod.onRequestGet({
    params: { name },
    env: fakeEnv(opts),
    request: new Request(`https://kraken.test/hunter/${name}${query}`),
  });
  return { res, out: await res.text() };
};

test('a hunter page shows who they are and what they own', async () => {
  const { res, out } = await render('JFL__Leon');

  assert.equal(res.status, 200);
  assert.ok(out.includes('JFL__Leon'), 'the name, with its underscores intact');
  assert.ok(out.includes('🇬🇧'), 'country flag');
  assert.ok(out.includes('27th'), 'rank as an ordinal');
  assert.ok(out.includes('186,406'), 'points, grouped');
  assert.ok(out.includes('87.45%'), 'completion, floored');
  assert.ok(out.includes('319') && out.includes('354'), 'finished / started');

  for (const g of GAMES) assert.ok(out.includes(g.title), `${g.title} missing`);
});

test('the unobtainable flag and its note reach the page', async () => {
  const { out } = await render('JFL__Leon');
  assert.ok(out.includes('&#9888;'), 'warning triangle');
  assert.ok(out.includes('Servers closed'), 'the note, as a tooltip');
});

test('a game worth nothing says so rather than showing a number', async () => {
  const { out } = await render('JFL__Leon');
  assert.ok(out.includes('pays nothing'));
  // Bloodborne is finished, so there is nothing left to gain from it.
  assert.ok(out.includes('>done<'));
});

test('sort is a whitelist, never interpolated', async () => {
  await render('JFL__Leon', '?sort=worth');
  assert.ok(lastGamesSql.includes('(g.max_points - mg.points) DESC'), lastGamesSql);

  // The injection attempt falls back to the default rather than reaching SQL.
  await render('JFL__Leon', `?sort=${encodeURIComponent('title; DROP TABLE members;--')}`);
  assert.ok(!lastGamesSql.includes('DROP'), 'the string never reached the query');
  assert.ok(lastGamesSql.includes('mg.points DESC'), 'fell back to the default sort');
});

test('pages are 50 at a time and the offset follows the page number', async () => {
  await render('JFL__Leon', '?page=3');
  assert.deepEqual(lastBind, ['acc-1', 50, 100]);

  // 354 projects is 8 pages. Page 99 clamps to the last one rather than
  // querying past the end and showing an empty table.
  await render('JFL__Leon', '?page=99');
  assert.deepEqual(lastBind, ['acc-1', 50, 350]);

  // Nonsense clamps to the first page instead of producing NaN OFFSET.
  await render('JFL__Leon', '?page=-4');
  assert.deepEqual(lastBind, ['acc-1', 50, 0]);
});

test('an unknown hunter is a 404, not a crash', async () => {
  const { res, out } = await render('NobodyAtAll', '', { member: null });
  assert.equal(res.status, 404);
  assert.ok(out.includes('No hunter called'));
});

test('a hostile game title cannot inject markup', async () => {
  const nasty = [{ ...GAMES[0], title: '<script>alert(1)</script>', icon_url: '" onerror="alert(1)' }];
  const { out } = await render('JFL__Leon', '', { games: nasty });
  assert.ok(out.includes('&lt;script&gt;'), 'title escaped');
  assert.ok(!out.includes('<script>alert(1)</script>'), 'not rendered as a tag');
  assert.ok(!out.includes('onerror="alert(1)"'), 'attribute escaped');
});

/**
 * The curve.
 *
 * MEMBER carries 186,406 points and no `reported_points`, so the anchor is
 * 186,406 and the deltas walk backwards from it:
 *
 *   after  update 3 = 186,406      (the anchor — must equal the card)
 *   after  update 2 = 180,000      (186,406 − 6,406)
 *   after  update 1 = 182,000      (180,000 − −2,000)
 *
 * There is deliberately no fourth point at zero. Nobody was measured before
 * their first scan, and a line climbing from zero draws a wall that never
 * happened.
 */
test('the curve is rebuilt from the deltas and ends where the card does', async () => {
  const { out } = await render('JFL__Leon');
  const m = out.match(/data-points="([^"]+)"/);
  assert.ok(m, 'the chart rendered');

  const pts = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.equal(pts.length, 3, 'one point per update, no synthetic zero');
  assert.deepEqual(pts.map((p) => p[1]), [182000, 180000, 186406]);

  // The right-hand edge is the anchor. If this ever drifts, the graph is
  // telling somebody a different number to the one Discord shows them.
  assert.equal(pts[pts.length - 1][1], 186406);
});

test('the split covers the movement, not the first scan that set the baseline', async () => {
  const { out } = await render('JFL__Leon');
  assert.ok(out.includes('From trophies'));

  // 500 + 8,000. The first scan's 182,000 is excluded on purpose: it is where
  // the graph starts, not something that happened during it.
  assert.ok(out.includes('+8,500'), 'earned since the baseline');
  assert.ok(!out.includes('+190,500'), 'the first scan is not counted as movement');
  assert.ok(out.includes('\u22123,400'), 'completion cost them 3,400, shown as a minus');
  assert.ok(out.includes('\u2212694'), 'drift cost them 694');
});

test('a member with one update gets no chart at all', async () => {
  const { out } = await render('JFL__Leon', '', { updates: [UPDATES[0]] });
  assert.ok(!out.includes('data-points'), 'two points is the floor for a trend');
  assert.ok(!out.includes('From trophies'));
});

test('a brand new member with no updates does not crash', async () => {
  const { res, out } = await render('JFL__Leon', '', { updates: [] });
  assert.equal(res.status, 200);
  assert.ok(!out.includes('data-points'));
  assert.ok(out.includes('Bloodborne'), 'the game list still renders');
});

test('the chart is only queried on the first page', async () => {
  const { out } = await render('JFL__Leon', '?page=2');
  assert.ok(!out.includes('data-points'), 'page 2 is the table, not the curve');
});

test('the numbers behind the chart are reachable without hovering', async () => {
  const { out } = await render('JFL__Leon');
  assert.ok(out.includes('Show the numbers'));
  assert.ok(out.includes('186,406'), 'the latest value is in the table too');
});
