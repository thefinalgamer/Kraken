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
 * The two that matter most are the sort whitelist and the search escaping.
 * Both take a string off the query string and put it near SQL, and both would
 * fail silently and totally rather than noisily.
 */
const mod = await import('../functions/hunter/[name].js');

const MEMBER = {
  psn_account_id: 'acc-1', psn_online_id: 'JFL__Leon', country: 'GB',
  avatar_url: 'https://example.test/a.png', rank: 27, prev_rank: 28,
  points: 186406, reported_points: 186406,
  completion: 87.45, platinum: 310, gold: 2041,
  silver: 2397, bronze: 6462, projects: 354, completed: 319,
  last_update_at: Date.now(),
};

const GAMES = [
  // Finished, platinum in → the GREEN bar.
  { np_comm_id: 'NPWR1', title: 'Bloodborne', platform: 'PS4', icon_url: 'https://x.test/b.png',
    max_points: 4200, unobtainable: 0, unobtainable_note: null, trophy_count: 40,
    points: 4200, progress: 100, earned_total: 40, earned_platinum: 1,
    last_earned_at: Date.now() - 86400000 },
  // Platinum in but not everything → the BLUE bar.
  { np_comm_id: 'NPWR2', title: 'Sea of Thieves', platform: 'PS5', icon_url: null,
    max_points: 9000, unobtainable: 1, unobtainable_note: 'Servers closed', trophy_count: 100,
    points: 1500, progress: 41, earned_total: 41, earned_platinum: 1,
    last_earned_at: Date.now() - 8 * 86400000 },
  // Finished, worth nothing → green bar, and a plain zero rather than a fraction.
  { np_comm_id: 'NPWR3', title: 'Bunny Mahjo', platform: 'PS4', icon_url: null,
    max_points: 0, unobtainable: 0, unobtainable_note: null, trophy_count: 30,
    points: 0, progress: 100, earned_total: 30, earned_platinum: 1, last_earned_at: null },
  // Started, no platinum → no bar at all.
  { np_comm_id: 'NPWR4', title: 'Neverwinter', platform: 'PS4', icon_url: null,
    max_points: 38522, unobtainable: 1, unobtainable_note: 'Servers closed', trophy_count: 70,
    points: 92, progress: 11, earned_total: 8, earned_platinum: 0,
    last_earned_at: Date.now() - 400 * 86400000 },
];

/**
 * Three updates, newest first, exactly as the query returns them.
 *
 * The deltas are deliberately not all positive: a member's score goes down when
 * they start something new, and a history that cannot go down is not a history
 * of this board.
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

test('the four trophy counts are drawn, not fetched from Discord', async () => {
  const { out } = await render('JFL__Leon');

  for (const [cls, count] of [['p', '310'], ['g', '2,041'], ['s', '2,397'], ['b', '6,462']]) {
    assert.ok(out.includes(`class="cup ${cls}"`), `${cls} cup missing`);
    assert.ok(out.includes(count), `${count} missing`);
  }
  assert.ok(out.includes('<svg viewBox="0 0 24 24"'), 'the cup is inline SVG');

  // The whole point of drawing them. A hotlink to Discord's CDN is four extra
  // requests and a dependency that fails silently on somebody else's schedule.
  assert.ok(!out.includes('cdn.discordapp.com'), 'nothing is fetched from Discord');

  // The single lumped total is gone — it said nothing these four do not.
  assert.ok(!out.includes('>Trophies<'), 'no combined trophy count');
});

test('the accent bar marks finished work and nothing else', async () => {
  const { out } = await render('JFL__Leon');
  const rows = out.split('<tr').slice(1);
  const rowFor = (title) => rows.find((r) => r.includes(title));

  assert.match(rowFor('Bloodborne'), /^ class="full"/, '100% is green');
  assert.match(rowFor('Bunny Mahjo'), /^ class="full"/, '100% worth nothing is still green');
  assert.match(rowFor('Sea of Thieves'), /^ class="plat"/, 'platinum but unfinished is blue');
  assert.match(rowFor('Neverwinter'), /^>/, 'no platinum, no bar');
});

test('points read as earned out of the full completion, like the backlog does', async () => {
  const { out } = await render('JFL__Leon');

  assert.ok(out.includes('1,500 <span class="of-max">/ 9,000</span>'), 'Sea of Thieves');
  assert.ok(out.includes('4,200 <span class="of-max">/ 4,200</span>'), 'a finished game shows both');

  // The old second column is gone. Forty rows of "done" was noise, and the
  // fraction says the same thing without a word in it.
  assert.ok(!out.includes('Worth finishing</th>'), 'no worth-finishing column');
  assert.ok(!out.includes('>done<'), 'nothing says done');
  assert.ok(!out.includes('pays nothing'), 'a zero is a zero');
});

/**
 * The progress bar.
 *
 * WIDTH IS `progress` AND ONLY `progress`. The obvious version segments the bar
 * by trophies earned — a bronze stripe, then silver, then gold — but PSN's
 * progress percentage is weighted and the raw counts are not, so the stripes
 * would add up to a different width than the number printed next to them. A bar
 * arguing with its own label is worse than no bar.
 *
 * The COLOUR is the best trophy in the cabinet, so one bar answers both "how
 * far along" and "how far up" without either encoding lying about the other.
 */
test('the progress bar fills to the percentage and is coloured by the best trophy', async () => {
  const games = [
    { ...GAMES[0], title: 'Green', progress: 100, earned_platinum: 1 },
    { ...GAMES[0], title: 'Platinum', progress: 84, earned_platinum: 1 },
    { ...GAMES[0], title: 'Golden', progress: 60, earned_platinum: 0, earned_gold: 3 },
    { ...GAMES[0], title: 'Silvery', progress: 30, earned_platinum: 0, earned_gold: 0, earned_silver: 2 },
    { ...GAMES[0], title: 'Bronzey', progress: 4, earned_platinum: 0, earned_gold: 0, earned_silver: 0, earned_bronze: 1 },
  ];
  const { out } = await render('JFL__Leon', '', { games });

  assert.ok(out.includes('class="fill ok" style="width:100%"'), 'finished is green');
  assert.ok(out.includes('class="fill p" style="width:84%"'), 'platinum');
  assert.ok(out.includes('class="fill g" style="width:60%"'), 'gold');
  assert.ok(out.includes('class="fill s" style="width:30%"'), 'silver');
  assert.ok(out.includes('class="fill b" style="width:4%"'), 'bronze');
});

test('a nonsense progress value cannot escape the bar', async () => {
  const games = [
    { ...GAMES[0], title: 'Broken', progress: 5000 },
    { ...GAMES[1], title: 'Negative', progress: -20 },
  ];
  const { out } = await render('JFL__Leon', '', { games });
  assert.ok(out.includes('style="width:100%"'), 'clamped at the top');
  assert.ok(out.includes('style="width:0%"'), 'clamped at the bottom');
  assert.ok(!out.includes('5000%'), 'and the label is clamped too');
});

test('worth finishing survives as a sort even without a column', async () => {
  await render('JFL__Leon', '?sort=worth');
  assert.ok(lastGamesSql.includes('(g.max_points - mg.points) DESC'), lastGamesSql);
});

test('the unobtainable flag and its note reach the page', async () => {
  const { out } = await render('JFL__Leon');
  assert.ok(out.includes('&#9888;'), 'warning triangle');
  assert.ok(out.includes('Servers closed'), 'the note, as a tooltip');
});

test('sort is a whitelist, never interpolated', async () => {
  await render('JFL__Leon', '?sort=progress');
  assert.ok(lastGamesSql.includes('mg.progress DESC'), lastGamesSql);

  // The injection attempt falls back to the default rather than reaching SQL.
  await render('JFL__Leon', `?sort=${encodeURIComponent('title; DROP TABLE members;--')}`);
  assert.ok(!lastGamesSql.includes('DROP'), 'the string never reached the query');
  assert.ok(lastGamesSql.includes('mg.points DESC'), 'fell back to the default sort');
});

test('search is bound, escaped, and only added when asked for', async () => {
  await render('JFL__Leon');
  assert.ok(!lastGamesSql.includes('LIKE'), 'no filter when not searching');

  await render('JFL__Leon', '?q=batman');
  assert.ok(lastGamesSql.includes('g.title LIKE ? ESCAPE'), lastGamesSql);
  assert.equal(lastBind[1], '%batman%', 'bound as a parameter, not spliced in');

  // LIKE has its own wildcards. Somebody searching for "100%" must not match
  // their entire library, and "_" must not match any single character.
  await render('JFL__Leon', `?q=${encodeURIComponent('100%_x')}`);
  assert.equal(lastBind[1], '%100\\%\\_x%');
});

test('pages are 50 at a time and the offset follows the page number', async () => {
  // 51 is fetched, not 50: the extra row is how Next knows it exists without
  // a COUNT(*) over the whole library.
  await render('JFL__Leon', '?page=3');
  assert.deepEqual(lastBind, ['acc-1', 51, 100]);

  // 354 projects is 8 pages. Page 99 clamps to the last one rather than
  // querying past the end and showing an empty table.
  await render('JFL__Leon', '?page=99');
  assert.deepEqual(lastBind, ['acc-1', 51, 350]);

  // Nonsense clamps to the first page instead of producing NaN OFFSET.
  await render('JFL__Leon', '?page=-4');
  assert.deepEqual(lastBind, ['acc-1', 51, 0]);
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

test('a hostile search term cannot inject markup either', async () => {
  const { out } = await render('JFL__Leon', `?q=${encodeURIComponent('"><script>alert(1)</script>')}`);
  assert.ok(!out.includes('<script>alert(1)</script>'), 'echoed back escaped');
  assert.ok(out.includes('&lt;script&gt;'));
});

/**
 * The split.
 *
 * MEMBER reports 186,406 points, so the anchor is 186,406 and the deltas walk
 * backwards from it:
 *
 *   after update 3 = 186,406      (the anchor — must equal the card)
 *   after update 2 = 180,000      (186,406 − 6,406)
 *   after update 1 = 182,000      (180,000 − −2,000)
 *
 * There is no synthetic point at zero. Nobody was measured before their first
 * scan, and inventing one drew a climb that never happened.
 */
test('the split covers the movement, not the first scan that set the baseline', async () => {
  const { out } = await render('JFL__Leon');
  assert.ok(out.includes('From trophies'));

  // 500 + 8,000. The first scan's 182,000 is excluded on purpose: it is where
  // the history starts, not something that happened during it.
  assert.ok(out.includes('+8,500'), 'earned since the baseline');
  assert.ok(!out.includes('+190,500'), 'the first scan is not counted as movement');
  assert.ok(out.includes('−3,400'), 'completion cost them 3,400, shown as a minus');
  assert.ok(out.includes('−694'), 'drift cost them 694');
});

test('the drift tile names the server, not "the world"', async () => {
  const { out } = await render('JFL__Leon');
  assert.ok(out.includes('From the server'));
  assert.ok(out.includes('others starting and finishing your games'));
  assert.ok(!out.includes('From the world'));
});

test('there is no chart, and nothing left over from the one there was', async () => {
  const { out } = await render('JFL__Leon');
  assert.ok(!out.includes('data-points'), 'the chart is gone');
  assert.ok(!out.includes('viewBox="0 0 720'), 'and its geometry with it');
  assert.ok(!out.includes('<script>'), 'and the script that drove it');
});

test('the numbers behind the split are still reachable', async () => {
  const { out } = await render('JFL__Leon');
  assert.ok(out.includes('Show the numbers'));
  assert.ok(out.includes('186,406'), 'the latest value is in the table');
});

test('a member with one update gets no split at all', async () => {
  const { out } = await render('JFL__Leon', '', { updates: [UPDATES[0]] });
  // The oldest update sets the baseline and is excluded, so with one update
  // every figure would be zero — three tiles saying nothing.
  assert.ok(!out.includes('From trophies'));
});

test('a brand new member with no updates does not crash', async () => {
  const { res, out } = await render('JFL__Leon', '', { updates: [] });
  assert.equal(res.status, 200);
  assert.ok(!out.includes('From trophies'));
  assert.ok(out.includes('Bloodborne'), 'the game list still renders');
});

test('history is skipped on later pages and during a search', async () => {
  const a = await render('JFL__Leon', '?page=2');
  assert.ok(!a.out.includes('From trophies'), 'page 2 is the table');

  const b = await render('JFL__Leon', '?q=blood');
  assert.ok(!b.out.includes('From trophies'), 'a search is a search');
});
