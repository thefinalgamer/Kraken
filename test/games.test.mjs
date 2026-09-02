import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The games index, rendered against fake rows.
 *
 * The two that matter are the pager and the sort whitelist. The pager never
 * counts — it asks for one row more than it shows — and getting that wrong is
 * silent: the page still renders, it just reads twenty-six thousand rows to do
 * it. So the stub records what LIMIT it was handed.
 */
const mod = await import('../functions/games.js');

const DAY = 86400000;

const ROWS = [
  { np_comm_id: 'NPWR1', title: 'Bloodborne', platform: 'PS4', icon_url: 'https://x.test/b.png',
    trophy_count: 40, max_points: 4200, estimated: 0, unobtainable: 0, unobtainable_note: null,
    closes_at: null, local_started: 12 },
  { np_comm_id: 'NPWR2', title: 'Sea of Thieves', platform: 'PS5', icon_url: null,
    trophy_count: 100, max_points: 9000, estimated: 0, unobtainable: 0, unobtainable_note: 'MP',
    closes_at: Date.now() + 9 * DAY, local_started: 4 },
  { np_comm_id: 'NPWR3', title: 'Neverwinter', platform: 'PS4', icon_url: null,
    trophy_count: 70, max_points: 38522, estimated: 1, unobtainable: 1,
    unobtainable_note: 'Servers closed', closes_at: null, local_started: 1 },
];

let lastSql = '';
let lastBind = [];

const fakeEnv = (rows) => ({
  DB: {
    prepare(sql) {
      lastSql = sql;
      return {
        bind: (...args) => {
          lastBind = args;
          return { all: async () => ({ results: rows }) };
        },
      };
    },
  },
});

const render = async (rows = ROWS, query = '') => {
  const res = await mod.onRequestGet({
    env: fakeEnv(rows),
    request: new Request(`https://kraken.test/games${query}`),
  });
  return { res, out: await res.text() };
};

test('the index lists games and links every one of them', async () => {
  const { res, out } = await render();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control'), /max-age=300/);

  for (const g of ROWS) {
    assert.ok(out.includes(g.title), `${g.title} missing`);
    assert.ok(
      out.includes(`href="/game/${g.np_comm_id}"`),
      `${g.title} is not a link — an index nobody can click through is a list`,
    );
  }
  assert.ok(out.includes('38,522'), 'points are grouped');
  assert.ok(out.includes('12 <span class="of-max">hunters</span>'), 'plural');
  assert.ok(out.includes('1 <span class="of-max">hunter</span>'), 'and singular');
});

test('the pager asks for one more row than it shows and never counts', async () => {
  await render();
  /**
   * The rule is "never count the RESULT SET", not "never write the word COUNT".
   * Counting 26,000 games to print "of 520" reads 26,000 rows on every view;
   * that is what this guards. The one COUNT allowed is over `trophies WHERE
   * unobtainable = 1`, which is served by a PARTIAL index holding only flagged
   * rows: dozens of them, and it is what tells a wholly dead game from a
   * partly broken one.
   */
  assert.ok(!/COUNT\([\s\S]{0,80}FROM games/i.test(lastSql), 'never counts the games table');
  const counts = lastSql.match(/COUNT\(/g) || [];
  assert.ok(counts.length <= 1, `expected at most the flagged-trophy count, saw ${counts.length}`);
  if (counts.length) {
    assert.match(lastSql, /COUNT\(\*\) AS dead\s*\n?\s*FROM trophies WHERE unobtainable = 1/,
      'and the only one is the partial-index count');
  }
  assert.equal(lastBind[0], 51, 'fifty shown, fifty-one asked for');
  assert.equal(lastBind[1], 0, 'first page starts at zero');
});

test('page 3 offsets by a hundred', async () => {
  await render(ROWS, '?page=3');
  assert.equal(lastBind[1], 100);
});

test('a short page shows no Next link', async () => {
  const { out } = await render(ROWS);
  assert.ok(!out.includes('Next'), 'three rows is not a full page');
});

test('a full page plus one shows Next but claims no total', async () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ ...ROWS[0], np_comm_id: `N${i}` }));
  const { out } = await render(many);
  assert.ok(out.includes('Next'), 'there is a next page');
  assert.ok(out.includes('Page 1'), 'and it says which page this is');
  assert.ok(!/Page 1 of/.test(out), 'but never "of N" — nothing counted it');
  // Count the game links, not <tr> — the header is a row too, and counting it
  // was this assertion failing for a reason that had nothing to do with paging.
  assert.equal(
    (out.match(/href="\/game\/N\d+"/g) || []).length,
    50,
    'the fifty-first row is fetched to prove Next exists, and never rendered',
  );
});

test('the sort whitelist is a whitelist', async () => {
  await render(ROWS, '?sort=closing');
  assert.match(lastSql, /closes_at ASC/);
  assert.match(lastSql, /CASE WHEN g\.closes_at IS NULL THEN 1/, 'undated games sort last');

  await render(ROWS, '?sort=" OR 1=1--');
  assert.match(lastSql, /g\.local_started DESC/, 'falls back to the default');
  assert.ok(!lastSql.includes('OR 1=1'));
});

test('search escapes LIKE wildcards', async () => {
  await render(ROWS, '?q=100%25');
  // Somebody searching "100%" must not match every game in the index.
  assert.equal(lastBind[0], '%100\\%%');
  assert.match(lastSql, /LIKE \? ESCAPE/);
});

test('search is capped and trimmed', async () => {
  await render(ROWS, `?q=${encodeURIComponent(' ' + 'a'.repeat(200))}`);
  assert.equal(lastBind[0].length, 60 + 2, 'sixty characters plus the two wildcards');
});

test('only games somebody here owns are listed', async () => {
  await render();
  assert.match(lastSql, /local_started > 0/);
});

test('a closing game says when, in words as well as an icon', async () => {
  const { out } = await render();
  assert.ok(out.includes('&#8987;') || out.includes('&#128338;'), 'the clock mark');
  assert.match(out, /class="closes/, 'and the deadline spelled out');
});

test('the stripe carries the clock, and only the clock', async () => {
  // Assert on the ROW, not on the stylesheet. The CSS is inlined into every
  // page, so searching for "st-soon" alone passes on a page with no rows.
  const { out } = await render();
  assert.match(out, /<tr class="st-soon">[\s\S]{0,900}Sea of Thieves/, 'six days is urgent');
  assert.match(out, /<tr class="st-dead">[\s\S]{0,900}Neverwinter/, 'a flagged game is dead');
  assert.match(out, /<tr class="st-none">[\s\S]{0,900}Bloodborne/, 'no deadline, no colour');
});

test('an empty search says so', async () => {
  const { out } = await render([], '?q=zzzz');
  assert.ok(out.includes('No games matching'));
});

test('a hostile game title cannot inject markup', async () => {
  const { out } = await render([{ ...ROWS[0], title: '<img src=x onerror=alert(1)>' }]);
  assert.ok(out.includes('&lt;img'));
  assert.ok(!out.includes('<img src=x'));
});

test('a hostile icon url cannot break out of its attribute', async () => {
  const { out } = await render([{ ...ROWS[0], icon_url: '" onerror="alert(1)' }]);
  assert.ok(!out.includes('onerror="alert'));
});

test('a wholly dead game gets a red mark, a partly broken one stays brass', async () => {
  /**
   * JFL__Leon's screenshot: XDefiant and WWE 2K24 side by side in the index,
   * identical warning marks, and one of them was entirely unearnable. In a list
   * of forty games the colour is the only thing separating "skip four of these"
   * from "do not start this at all".
   */
  const rows = [
    { ...ROWS[0], np_comm_id: 'DEAD', title: 'XDefiant', trophy_count: 13,
      unobtainable: 1, unobtainable_note: 'Servers closed 4 June 2025', dead_trophies: 13 },
    { ...ROWS[0], np_comm_id: 'PART', title: 'WWE 2K24', trophy_count: 52,
      unobtainable: 1, unobtainable_note: '4 trophies unobtainable', dead_trophies: 4 },
  ];
  const { out } = await render(rows);

  assert.match(out, /XDefiant[\s\S]{0,400}?|class="mk dead whole"/, 'the dead one is marked whole');
  assert.ok(out.includes('class="mk dead whole"'), 'red mark present');
  assert.ok(out.includes('class="mk dead"'), 'and the brass one is still brass');
  assert.equal((out.match(/class="mk dead whole"/g) || []).length, 1, 'exactly one of them');
});

test('a game with no flagged trophies is never called whole', async () => {
  // dead_trophies is null when nothing is flagged, and null >= trophy_count
  // must not come out true.
  const { out } = await render([
    { ...ROWS[0], unobtainable: 1, unobtainable_note: 'flagged by hand',
      trophy_count: 40, dead_trophies: null },
  ]);
  assert.ok(out.includes('class="mk dead"'), 'still marked');
  assert.ok(!out.includes('mk dead whole'), 'but not as wholly gone');
});

test('the flagged count is derived, never a stored column', async () => {
  // A column would need a migration and could drift from the trophies it
  // describes. The subquery reads the PARTIAL index, so it walks flagged rows
  // only: dozens, not a million.
  await render();
  assert.match(lastSql, /FROM trophies WHERE unobtainable = 1/, 'counted from the index');
  assert.match(lastSql, /LEFT JOIN/, 'and joined, so an unflagged game still lists');
});
