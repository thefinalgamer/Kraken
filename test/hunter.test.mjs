import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyOf } from './helpers.mjs';

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

/**
 * The other hunter, for the head to head panel.
 *
 * Higher points and LOWER completion than Leon on purpose. That pair is the
 * whole reason the panel refuses to compare points game by game: the multiplier
 * means the same trophies are worth different amounts to these two.
 */
const OTHER = {
  psn_account_id: 'acc-2', psn_online_id: 'MRTheChez', country: 'US',
  avatar_url: 'https://example.test/c.png', rank: 3,
  points: 194669, reported_points: 194669, completion: 62.1,
  projects: 1512, completed: 900, supporter_months: 0,
};

// A game they both own, where MRTheChez is done and Leon has barely started.
const VS_AHEAD_ROWS = [
  { np_comm_id: 'NPWR9', title: 'Elden Ring', platform: 'PS5', icon_url: null,
    max_points: 12000, trophy_count: 42,
    my_points: 900, my_progress: 18, my_trophies: 9,
    their_points: 12000, their_progress: 100, their_trophies: 42 },
];

// A game only MRTheChez has. No `my_` columns at all, which is what tells the
// row renderer to draw one bar instead of two.
const VS_THEIRS_ROWS = [
  { np_comm_id: 'NPWR8', title: 'Nioh 2', platform: 'PS4', icon_url: null,
    max_points: 8000, trophy_count: 70,
    their_points: 4000, their_progress: 55, their_trophies: 40 },
];

let lastGamesSql = '';
let lastBind = [];
let lastRivalBind = [];
let vsQueries = 0;

const fakeEnv = ({
  onStream = [], member = MEMBER, games = GAMES, updates = UPDATES, rivals = [],
  vsMember = null, vsAhead = [], vsTheirs = [] } = {}) => ({
  DB: {
    prepare(sql) {
      /**
       * COUNTED HERE, not inside `answer`.
       *
       * `prepare` below returns `{ ...answer([]), bind }`, so `answer` runs
       * twice for every query and a counter inside it reported six queries for
       * three. Counting on `prepare` counts what the page actually asked the
       * database for, which is the number the test is about.
       */
      if (
        (sql.includes('FROM members') && !sql.includes('COUNT(*)') && !sql.includes('rivals')) ||
        sql.includes('them.progress > mine.progress') ||
        sql.includes('NOT EXISTS')
      ) {
        vsQueries += 1;
      }
      const answer = (args) => {
        if (sql.includes('psn_account_id IN (')) {
          lastRivalBind = args;
          return { all: async () => ({ results: rivals }) };
        }
        if (sql.includes('FROM members')) {
          if (sql.includes('COUNT(*)')) {
            return { first: async () => ({ c: 64 }), all: async () => ({ results: [] }) };
          }
          /**
           * BOTH member lookups are `FROM members WHERE psn_online_id = ?`, so
           * the compare lookup swallowed the page's own and every page 404'd.
           * `rivals` is in one column list and not the other, which is the only
           * honest thing to split them on here.
           */
          if (!sql.includes('rivals')) {
            return {
              first: async () => vsMember,
              all: async () => ({ results: vsMember ? [vsMember] : [] }),
            };
          }
          return { first: async () => member, all: async () => ({ results: member ? [member] : [] }) };
        }
        if (sql.includes('them.progress > mine.progress')) {
          return { all: async () => ({ results: vsAhead }) };
        }
        if (sql.includes('NOT EXISTS')) {
          return { all: async () => ({ results: vsTheirs }) };
        }
        if (sql.includes('FROM updates')) {
          return { first: async () => updates[0], all: async () => ({ results: updates }) };
        }
        /**
         * The live counts read the trophy log, and they run AFTER the library
         * query. Letting them fall through here overwrote `lastGamesSql`, and
         * five sort and paging tests started failing with a complaint about a
         * query that had nothing to do with sorting.
         */
        if (sql.includes('FROM member_trophies')) {
          return { all: async () => ({ results: onStream }) };
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

  // The strip cell itself must exist, not just the row class. An earlier version
  // had the CSS and no element, so every bar was invisible and every test still
  // passed — the class was the hook, and the hook was all anything checked.
  assert.ok(out.includes('<td class="bar"></td>'), 'the strip cell is rendered');
  // And it is the LAST cell in the row, on the right, where Esto had it.
  assert.match(out, /<td class="bar"><\/td>\s*<\/tr>/, 'the strip closes the row');
  // The strip now matches the progress bar and appears on EVERY row. The old
  // blue-or-green-or-nothing left a gap beside every merely-started game, which
  // members read as dead space.
  assert.match(rowFor('Bloodborne'), /^ class="sh-ok"/, '100% is green');
  assert.match(rowFor('Bunny Mahjo'), /^ class="sh-ok"/, '100% worth nothing is still green');
  assert.match(rowFor('Sea of Thieves'), /^ class="sh-p"/, 'platinum but unfinished is blue');
  assert.match(rowFor('Neverwinter'), /^ class="sh-b"/, 'bronzes earned, so bronze');

  // No row is ever without one.
  assert.equal(
    (out.match(/<td class="bar"><\/td>/g) || []).length,
    (out.match(/<tr class="sh-/g) || []).length,
    'every row has a strip',
  );
});

test('a game with nothing earned gets the track colour, not a bronze', async () => {
  const untouched = [{ ...GAMES[3], title: 'Untouched', earned_total: 0, earned_bronze: 0,
    earned_silver: 0, earned_gold: 0, earned_platinum: 0, progress: 0 }];
  const { out } = await render('JFL__Leon', '', { games: untouched });
  assert.ok(out.includes('<tr class="sh-none">'), 'no hole in the column, no trophy claimed');
});

test('the unobtainable note rides the symbol, and never becomes a popup again', async () => {
  const { out } = await render('JFL__Leon');
  const body = bodyOf(out);

  /**
   * THIRD PLACE THIS NOTE HAS LIVED, and the history is why the assertions
   * below look the way they do.
   *
   *   1. a `title` on the symbol   — invisible on a phone
   *   2. a <details> popup          — absolutely positioned inside .tablewrap,
   *                                   whose overflow-x:auto promotes the other
   *                                   axis, so opening one turned the table into
   *                                   a scroll box. Leon found it in a day.
   *   3. an inline line under the title
   *   4. back to `title`, deliberately
   *
   * Martin, on (3): a good note is a bad table row. "4 Trophies Unobtainable -
   * UGC Servers Shutdown 31st August 2026" is longer than the game title, wraps,
   * and pushes every row below it down, so in a list of forty games the
   * exception shouts louder than the games.
   *
   * The phone problem from (1) is real and is answered elsewhere rather than
   * pretended away: the game page prints the note in full, guarded by its own
   * test in game.test.mjs. What must never come back is (2).
   */
  assert.match(
    body,
    /class="mk dead" title="Some trophies in this game can no longer be earned.\nServers closed"/,
    'the count leads, the mod keeps the second line',
  );
  assert.ok(!body.includes('class="gnote"'), 'and no longer a line that pushes the table around');
  assert.ok(!body.includes('flagwrap'), 'no popup');
  assert.ok(!body.includes('flagnote'), 'and nothing positioned over the table');
  assert.ok(body.includes('&#9888;'), 'the mark is still beside the title');
});

test('a wholly dead game says so before it says why', async () => {
  /**
   * Martin put two rows side by side. GTA V, flagged trophy by trophy, hovered
   * into "27 trophies can no longer be earned." Fall Guys, flagged with "every
   * trophy", hovered into the moderator's paragraph about a free-to-play
   * re-release in May 2022, and you had to read all of it to learn that the
   * whole game was gone. Both are dead; only one of them opened with it.
   *
   * The lead sentence is now DERIVED from the counts, so it is the same shape
   * whichever way the flag got there, and the moderator's words follow it.
   */
  const dead = [{
    ...GAMES[1],
    title: 'Fall Guys',
    trophy_count: 35,
    dead_trophies: 35,
    unobtainable_note: 'Replaced with a free-to-play version and the old servers were cut off.',
  }];
  const { out } = await render('JFL__Leon', '', { games: dead });
  const body = bodyOf(out);

  assert.match(
    body,
    /title="All 35 trophies in this game can no longer be earned."/,
    'the count, on its own',
  );
  assert.match(body, /class="mk dead whole"/, 'and it is the red mark, not the brass one');

  /**
   * ONE LINE, NOT TWO. Leon asked for the reason to come off this hover once he
   * saw it: on a game where nothing can be earned the why changes nothing you
   * would do about it, and the game page still prints it in full. A partly
   * broken game is the opposite case and is covered by the test above.
   */
  assert.ok(!body.includes('Replaced with a free-to-play'), 'the reason stays off the red hover');
});

test('a generated count is not printed twice', async () => {
  /**
   * Flagging trophies one at a time writes the game a note that is itself a
   * count, which is where the good version of this sentence came from. Leading
   * with a derived count and then appending that stored one would read
   * "27 trophies can no longer be earned. 27 trophies can no longer be earned."
   */
  const dead = [{
    ...GAMES[1],
    title: 'Grand Theft Auto V',
    trophy_count: 59,
    dead_trophies: 27,
    unobtainable_note: '27 trophies can no longer be earned.',
  }];
  const body = bodyOf((await render('JFL__Leon', '', { games: dead })).out);

  assert.match(body, /title="27 trophies can no longer be earned."/, 'said once');
  assert.ok(!body.includes('earned.\n27 trophies'), 'and not echoed underneath itself');
});

test('points read as earned out of the full completion, like the backlog does', async () => {
  const { out } = await render('JFL__Leon');

  /**
   * BANKED, NOT RAW. Leon is at 87.45%, so Sea of Thieves stores 1,500 of
   * 9,000 and pays him 1,305 of 7,830. The stored pair is the game's price
   * list — identical for anybody holding the same trophies — and printing it
   * under a column headed "Points" told two members with very different
   * completions that they were getting the same number. They were not.
   */
  assert.ok(out.includes('1,305 <span class="of-max">/ 7,830</span>'), 'Sea of Thieves, banked');
  assert.ok(out.includes('3,654 <span class="of-max">/ 3,654</span>'), 'a finished game shows both');
  assert.ok(!out.includes('1,500 <span class="of-max">/ 9,000</span>'), 'never the raw pair');

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
  assert.ok(out.includes('Servers closed'), 'and the note it opens');
});

test('sort is a whitelist, never interpolated', async () => {
  await render('JFL__Leon', '?sort=progress');
  assert.ok(lastGamesSql.includes('mg.progress DESC'), lastGamesSql);

  // The injection attempt falls back to the default rather than reaching SQL.
  await render('JFL__Leon', `?sort=${encodeURIComponent('title; DROP TABLE members;--')}`);
  assert.ok(!lastGamesSql.includes('DROP'), 'the string never reached the query');
  assert.ok(lastGamesSql.includes('mg.last_played_at'), 'fell back to the default sort');
});

test('the default sort is last played', async () => {
  // Opening on points shows the same five games at the top of every hunter
  // forever. Last played is the only ordering that moves when they play.
  await render('JFL__Leon');
  // last PLAYED, not last trophy earned. Sorting on last_earned_at put a game
  // Wilko had not touched in sixteen months above one he played that week,
  // because that was when its final trophy happened to pop.
  assert.ok(
    lastGamesSql.includes('COALESCE(mg.last_played_at, mg.last_earned_at, 0) DESC'),
    lastGamesSql,
  );
});

test('the platform is a chip and the trophy breakdown is on every row', async () => {
  const { out } = await render('JFL__Leon');
  assert.ok(out.includes('<span class="plat-chip">PS5</span>'), 'PS5 chip');
  assert.ok(out.includes('<span class="plat-chip">PS4</span>'), 'PS4 chip');

  // Bloodborne: 40 of 40, nothing left. Neverwinter: 8 of 70, 62 to go.
  assert.ok(out.includes('40 / 40'), 'earned out of total');
  assert.ok(out.includes('8 / 70'), 'and on an unfinished one');
  // "38 to go" was a third number saying what the other two already said.
  assert.ok(!out.includes('to go'), 'no remainder text');

  // Zero counts are dimmed rather than dropped, so the row shape never changes.
  assert.ok(out.includes('class="mc g off"'), 'a zero gold is greyed, not hidden');
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


/**
 * The clock.
 *
 * The whole point of the feature, in Martin's words: "one icon says this is
 * already dead / one icon says ive got time to do this - this icon at a glance
 * people think oh ill do it". So the two states must never look alike, and a
 * game with a future date must NOT be marked dead.
 */
const DAYS = 86400000;

test('a closing game is an invitation, not a warning', async () => {
  const soon = [{ ...GAMES[0], title: 'Closing Soon', unobtainable: 0,
    unobtainable_note: null, closes_at: Date.now() + 12 * DAYS }];
  const { out } = await render('JFL__Leon', '', { games: soon });

  assert.ok(out.includes('closes in 12 days'), 'the countdown is said out loud');
  assert.ok(out.includes('&#8987;'), 'hourglass, not a warning triangle');
  assert.ok(!out.includes('&#9888;'), 'and definitely not both');
  // "still earnable until then" lived in the popup. The countdown itself now
  // carries that meaning: a date you can still reach IS the invitation, and the
  // game page spells it out in full for anybody who wants the sentence.
  assert.ok(!bodyOf(out).includes('gnote'), 'a closing game gets no warning note');
});

test('near and far deadlines read differently', async () => {
  const far = [{ ...GAMES[0], title: 'Later', unobtainable: 0, unobtainable_note: null,
    closes_at: Date.now() + 200 * DAYS }];
  const { out } = await render('JFL__Leon', '', { games: far });

  // A clock face for scheduled, an hourglass for running out. Two hundred days
  // away is a diary entry, not a panic.
  assert.ok(out.includes('&#128338;'), 'clock face');
  assert.ok(!out.includes('&#8987;'), 'no hourglass this far out');
  assert.match(out, /closes on \d+ \w+ \d{4}/, 'a date, not a countdown');
});

test('a passed date is dead, and a mod flag beats any date', async () => {
  const expired = [{ ...GAMES[0], title: 'Gone', unobtainable: 0,
    unobtainable_note: null, closes_at: Date.now() - DAYS }];
  const a = await render('JFL__Leon', '', { games: expired });
  assert.ok(a.out.includes('&#9888;'), 'past its date is dead');
  assert.ok(!a.out.includes('closes in'), 'and has no countdown');

  // A mod has looked at the game; a date is a prediction typed weeks ago.
  const both = [{ ...GAMES[0], title: 'Broken', unobtainable: 1,
    unobtainable_note: 'Broken by a patch', closes_at: Date.now() + 90 * DAYS }];
  const b = await render('JFL__Leon', '', { games: both });
  assert.ok(b.out.includes('&#9888;'), 'the human wins');
  assert.ok(b.out.includes('Broken by a patch'));
  assert.ok(!b.out.includes('closes in'), 'no countdown beside a closed door');
});

test('a game with no date carries no mark at all', async () => {
  const clean = [{ ...GAMES[0], title: 'Fine', unobtainable: 0,
    unobtainable_note: null, closes_at: null }];
  const { out } = await render('JFL__Leon', '', { games: clean });
  // Assert on the ELEMENT, not the class name: the stylesheet is inlined into
  // every page, so "flagwrap" appears whether or not any game uses it. This is
  // the same trap that let the invisible pip ship.
  assert.ok(!out.includes('<details class="flagwrap'), 'nothing to say, so nothing said');
  assert.ok(!out.includes('&#9888;') && !out.includes('&#8987;'), 'no marks');
});


test('the row says when it was last played, matching the sort', async () => {
  // The column and the ordering have to tell the same story about a row, or one
  // of them is lying. Both read last_played_at now.
  const g = [{ ...GAMES[0], title: 'Recent',
    last_played_at: Date.now() - 2 * 86400000,      // played this week
    last_earned_at: Date.now() - 480 * 86400000 }]; // last trophy ages ago
  const { out } = await render('JFL__Leon', '', { games: g });
  assert.ok(out.includes('2 days ago'), 'shows when it was played');
  assert.ok(!out.includes('1 years ago'), 'not when it last paid out');
});


/**
 * The dice.
 *
 * The costly mistakes are both invisible if you only look at the page: an
 * ORDER BY RANDOM() over 26,000 games, and a random picker sitting in a cache.
 * So these assert on the QUERIES and the HEADERS, not on which games came back.
 */
const rollEnv = (opts = {}) => {
  const seen = { sqls: [] };
  const env = {
    DB: {
      prepare(sql) {
        seen.sqls.push(sql);
        const pick = () => ({
          first: async () => {
            if (sql.includes('MAX(rowid)')) return { m: 26000 };
            if (sql.includes('FROM members')) return sql.includes('COUNT(*)') ? { c: 64 } : MEMBER;
            if (sql.includes('FROM games\n   WHERE rowid')) return opts.wild ?? WILD;
            return MEMBER;
          },
          all: async () => ({
            results: sql.includes('FROM member_games mg')
              ? (sql.includes('RANDOM()') ? (opts.backlog ?? [GAMES[3]]) : GAMES)
              : sql.includes('FROM updates') ? UPDATES : [],
          }),
        });
        return { ...pick(), bind: () => pick() };
      },
    },
  };
  return { env, seen };
};

const WILD = { np_comm_id: 'W1', title: 'Wild One', platform: 'PS5', icon_url: null,
  max_points: 5000, trophy_count: 40, unobtainable: 0, closes_at: null, local_started: 2 };

const roll = async (opts) => {
  const { env, seen } = rollEnv(opts);
  const res = await mod.onRequestGet({
    params: { name: 'JFL__Leon' }, env,
    request: new Request('https://kraken.test/hunter/JFL__Leon?roll=123'),
  });
  return { res, out: await res.text(), seen };
};

test('nothing is dealt until somebody asks', async () => {
  const { out } = await render('JFL__Leon');
  assert.ok(out.includes('Deal the cards'), 'the invitation is there');
  assert.ok(!out.includes('What should'), 'but no cards were drawn');
  assert.ok(!bodyOf(out).includes('class="deck"'), 'and no deck rendered');
  // It shares the row with Show the numbers and Rivals, which is what that
  // half-empty row was for.
  assert.ok(out.includes('<div class="toolrow">'));
});

test('a roll never touches a cache', async () => {
  const { res } = await roll();
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  // Five minutes in the edge cache would hand everybody the same three games
  // and return the same three on the next click.
  assert.ok(!res.headers.get('Cache-Control').includes('max-age=300'));
});

test('wildcards jump to a rowid instead of sorting 26,000 games', async () => {
  const { seen } = await roll();
  const wild = seen.sqls.find((q) => q.includes('WHERE rowid >='));
  assert.ok(wild, 'the rowid jump is used');
  assert.ok(!wild.includes('ORDER BY RANDOM()'), 'never a full-table shuffle');
  assert.ok(wild.includes('ORDER BY rowid'), 'stops at the first match');
  assert.ok(seen.sqls.some((q) => q.includes('MAX(rowid)')), 'needs the ceiling');
});

test('the picker refuses to suggest junk or dead games', async () => {
  const { seen } = await roll();
  const backlog = seen.sqls.find((q) => q.includes('mg.progress < 100'));

  // Without this it cheerfully recommends shovelware worth nothing, which is
  // the exact advice this whole board exists to stop people taking.
  assert.ok(backlog.includes('g.max_points > mg.points'), 'must be worth finishing');
  assert.ok(backlog.includes('g.unobtainable = 0'), 'and still finishable');

  const wild = seen.sqls.find((q) => q.includes('WHERE rowid >='));
  assert.ok(wild.includes('max_points > 0'));
  assert.ok(wild.includes('unobtainable = 0'));
  assert.ok(wild.includes('NOT EXISTS'), 'and not something they already own');
});

test('a deal renders both pools and a way to deal again', async () => {
  const { out } = await roll();
  const body = bodyOf(out);

  // "THEIR backlog", never "yours". The site has no idea who is reading it, so
  // dealing on Leon's page draws Leon's games and must say so.
  assert.ok(body.includes('What should JFL__Leon play?'));
  assert.ok(body.includes("JFL__Leon's backlog"));
  assert.ok(!body.includes('your backlog'), 'never claims the reader owns them');

  // Which pool a card came from is said ON THE CARD now, not in a heading above
  // a separate list, because the deal has to read as one gesture.
  assert.ok(body.includes('>Backlog<'), 'the backlog chip');
  assert.ok(body.includes('>Wildcard<'), 'and the wildcard chip');
  assert.ok(body.includes('Wild One'), 'the wildcard itself');
  assert.ok(body.includes('Deal again'));
});

test('the deal is one deck, numbered so the animation can chain', async () => {
  /**
   * Every phase of the sequence is animation-delay arithmetic off --i and
   * --last: without them the cards all fly in from the same offset, land
   * together, and turn at once. The markup carrying them is not decoration.
   */
  const { out } = await roll();
  const body = bodyOf(out);

  const last = body.match(/class="deck" style="--last:(\d+)"/);
  assert.ok(last, 'the deck declares how many cards it holds');

  const slots = [...body.matchAll(/class="slot" style="--i:(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(slots, [...slots.keys()], 'every card is numbered in order from zero');
  assert.equal(Number(last[1]), slots.length - 1, '--last is the index of the final card');
  assert.equal((body.match(/class="dcard"/g) || []).length, slots.length, 'one card per slot');
});

test('the page still ships no JavaScript', async () => {
  /**
   * The card deal is four chained animations and it was built without a line of
   * script, which is the only reason it costs nothing to serve. This site has
   * never shipped any and the moment one <script> appears the next feature
   * argues it may as well have some too.
   */
  const { out } = await roll();
  assert.ok(!/<script/i.test(out), 'no script tag');
  assert.ok(!/\son[a-z]+="/i.test(out), 'and no inline handlers either');
});

test('every game title is a link to that game', async () => {
  // A library that cannot be clicked through is a screenshot. The game page
  // exists; the hunter page is the main way anybody reaches it.
  const { out } = await render();
  for (const g of GAMES) {
    // ?as= carries whose page you came from, so the game page can light up
    // THEIR earned trophies before there is any such thing as being signed in.
    assert.ok(
      out.includes(`href="/game/${g.np_comm_id}?as=JFL__Leon"`),
      `${g.title} is not a link to its page`,
    );
  }
});

/* ---------------------------------------------------------------------------
 * Rivals.
 *
 * Set in Discord, rendered here, and PUBLIC — anybody can open anybody's page
 * and read their watchlist. That was a deliberate choice rather than an
 * oversight, so the tests say so out loud: if this ever needs to become private
 * again, these are the assertions that have to be argued with first.
 * ------------------------------------------------------------------------ */

const RIVALS = [
  { psn_account_id: 'acc-2', psn_online_id: 'th3finalgamer--', avatar_url: null,
    rank: 32, points: 175881, supporter_months: 0 },
  { psn_account_id: 'acc-3', psn_online_id: 'Snolib', avatar_url: null,
    rank: 40, points: 99449, supporter_months: 0 },
];

const withRivals = (extra = {}) => ({
  member: { ...MEMBER, rivals: JSON.stringify(['acc-2', 'acc-3']) },
  rivals: RIVALS,
  ...extra,
});

test('rivals render, with the gap measured from the hunter whose page it is', async () => {
  const { out } = await render('JFL__Leon', '', withRivals());
  // bodyOf, because the stylesheet is inlined into every page and a CSS
  // comment explaining the ahead/behind colours contains the word "ahead".
  // This negative assertion passed against the comment, not against a row.
  const body = bodyOf(out);

  assert.ok(body.includes('th3finalgamer--'), 'the rival is named');
  assert.ok(body.includes('Snolib'), 'and so is the second one');

  // Leon has 186,406. th3finalgamer-- has 175,881 — 10,525 BEHIND Leon, even
  // though on th3finalgamer's own Discord card Leon shows as ahead. Same two
  // numbers, opposite sign, because the page belongs to Leon.
  assert.ok(body.includes('10,525 behind'), 'measured from Leon, not from the reader');
  assert.ok(body.includes('86,957 behind'), 'and Snolib the same way');
  assert.ok(!body.includes('ahead'), 'nobody here is ahead of Leon');
});

test('the hunter appears in their own rivals list, marked', async () => {
  const { out } = await render('JFL__Leon', '', withRivals());
  assert.match(out, /<tr class="isme">/, 'their own row is marked');
  assert.ok(out.includes('this hunter'), 'and labelled — never "you", the site has no idea who is reading');
  assert.ok(!out.includes('>you<'), 'the one word this page cannot honestly say');
});

test('rivals are ordered by rank, not by gap', async () => {
  // Rank order does not reshuffle when somebody plays, so the list stays
  // readable at a glance. Leon is 27th, so he leads his own list.
  const { out } = await render('JFL__Leon', '', withRivals());
  const body = bodyOf(out);
  const order = [...body.matchAll(/class="rk">(\d+)</g)].map((x) => Number(x[1]));
  assert.deepEqual(order, [27, 32, 40], 'ascending rank, hunter folded in');
});

test('a hunter with no rivals gets no panel at all', async () => {
  const { out } = await render('JFL__Leon');
  const body = bodyOf(out);
  assert.ok(!body.includes('rivaltab'), 'no empty table');
  assert.ok(!/<summary>Rivals/.test(body), 'and no summary promising one');
});

test('the "soon" placeholder is gone', async () => {
  // It said Rivals · soon for weeks. Shipping the feature and leaving the
  // teaser is a bug people notice immediately.
  const { out } = await render('JFL__Leon', '', withRivals());
  assert.ok(!bodyOf(out).includes('&middot; soon'), 'the teaser is retired');
  assert.ok(bodyOf(out).includes('2 of 5'), 'replaced by a real count');
});

test('a mangled rivals column renders a page, not an error', async () => {
  // The column is text written by an older build. A watchlist that cannot be
  // parsed must cost the page its panel and nothing else.
  const { res, out } = await render('JFL__Leon', '', {
    member: { ...MEMBER, rivals: '{not json at all' },
  });
  assert.equal(res.status, 200);
  assert.ok(out.includes('Bloodborne'), 'the library still renders');
  assert.ok(!bodyOf(out).includes('rivaltab'));
});

test('rivals are fetched by account id, and only on the first unsearched page', async () => {
  await render('JFL__Leon', '', withRivals());
  assert.deepEqual(lastRivalBind, ['acc-2', 'acc-3'], 'ids, never names — people rename on PSN');

  lastRivalBind = [];
  await render('JFL__Leon', '?page=3', withRivals());
  assert.deepEqual(lastRivalBind, [], 'page 3 does not pay for the same five rows again');

  lastRivalBind = [];
  await render('JFL__Leon', '?q=blood', withRivals());
  assert.deepEqual(lastRivalBind, [], 'nor does a search');
});

test('a hostile rival name cannot inject markup', async () => {
  const { out } = await render('JFL__Leon', '', withRivals({
    rivals: [{ ...RIVALS[0], psn_online_id: '<img src=x onerror=alert(1)>' }],
  }));
  assert.ok(out.includes('&lt;img'), 'escaped');
  assert.ok(!out.includes('<img src=x'), 'and not live');
});

test('every rival is a link through to their own page', async () => {
  const { out } = await render('JFL__Leon', '', withRivals());
  // A watchlist you cannot click through is a list of names.
  assert.ok(out.includes('href="/hunter/th3finalgamer--"'), 'and the dashes survive encoding');
  assert.ok(out.includes('href="/hunter/Snolib"'));
});

test('somebody above the hunter reads as ahead, in the other colour', async () => {
  // The other half of the branch. Every rival in the fixture above sits below
  // Leon, so without this the "ahead" arm was never once rendered.
  const { out } = await render('JFL__Leon', '', withRivals({
    rivals: [{ ...RIVALS[0], psn_online_id: 'MRTheChez', rank: 3, points: 500000 }],
  }));
  const body = bodyOf(out);
  assert.ok(body.includes('313,594 ahead'), 'the difference, said the right way round');
  assert.ok(body.includes('class="gup"'), 'and green, matching the arrows in Discord');
  assert.match(body, /class="rk">3<[\s\S]*class="rk">27</, 'rank 3 sorts above rank 27');
});

/* ---------------------------------------------------------------------------
 * The platform filter.
 *
 * Martin dealt himself four PS3 games in a row. The picker was not broken: it
 * was drawing from a pool he could not act on, which wastes the deal just as
 * effectively.
 * ------------------------------------------------------------------------ */

const rollPlat = async (query) => {
  const { env, seen } = rollEnv();
  const res = await mod.onRequestGet({
    params: { name: 'JFL__Leon' }, env,
    request: new Request(`https://kraken.test/hunter/JFL__Leon${query}`),
  });
  return { out: await res.text(), seen };
};

test('a platform filter reaches both halves of the deal', async () => {
  // Filtering the backlog and leaving the wildcards unfiltered would hand back
  // three PS5 games and two of whatever, which looks like the filter is broken.
  const { seen } = await rollPlat('?roll=1&plat=ps5');
  const backlog = seen.sqls.find((q) => q.includes('mg.progress < 100'));
  const wild = seen.sqls.find((q) => q.includes('WHERE rowid >='));

  assert.match(backlog, /g\.platform LIKE '%' \|\| \? \|\| '%'/, 'the backlog is narrowed');
  assert.match(wild, /platform LIKE '%' \|\| \? \|\| '%'/, 'and so are the wildcards');
});

test('the platform is matched with LIKE, so cross-gen games survive', async () => {
  /**
   * PSN joins platforms for a cross-gen title: one column reading "PS4,PS5".
   * An exact match would hide every one of those from BOTH filters, which is a
   * silent wrong answer. None of the four whitelist values is a substring of
   * another, so a contains-match cannot collide.
   */
  const { seen } = await rollPlat('?roll=1&plat=ps4');
  const backlog = seen.sqls.find((q) => q.includes('mg.progress < 100'));
  assert.ok(!/platform = \?/.test(backlog), 'never an equals match');
});

test('an unfiltered deal adds no clause at all', async () => {
  // The filter is optional and must leave the original query untouched when it
  // is not set, or every deal pays for a LIKE nobody asked for.
  const { seen } = await rollPlat('?roll=1');
  const backlog = seen.sqls.find((q) => q.includes('mg.progress < 100'));
  assert.ok(!backlog.includes('platform LIKE'), 'no clause when no filter');
});

test('a junk platform is ignored rather than breaking the page', async () => {
  // Somebody editing the URL by hand should get a normal deal.
  const { out, seen } = await rollPlat('?roll=1&plat=" OR 1=1--');
  const backlog = seen.sqls.find((q) => q.includes('mg.progress < 100'));
  assert.ok(!backlog.includes('platform LIKE'), 'falls back to no filter');
  assert.ok(!backlog.includes('OR 1=1'), 'and the value never reaches the SQL');
  assert.ok(out.includes('What should JFL__Leon play?'), 'the page still deals');
});

test('the chips say which one is on, and every one is a fresh deal', async () => {
  const { out } = await rollPlat('?roll=1&plat=ps3');
  const body = bodyOf(out);
  const row = body.slice(body.indexOf('class="platrow"'), body.indexOf('</div>', body.indexOf('class="platrow"')));

  assert.match(row, /class="tab on"[^>]*>PS3</, 'the chosen one is lit');
  assert.ok(row.includes('>All<'), 'and there is a way back to everything');
  for (const label of ['PS5', 'PS4', 'PS3', 'Vita']) {
    assert.ok(row.includes(`>${label}<`), `${label} chip missing`);
  }
  // Changing platform IS a new deal: leaving the old cards under a different
  // chip would show five games that do not match the filter now lit.
  assert.ok((row.match(/roll=/g) || []).length === 5, 'every chip carries its own roll');
});

test('the deal link keeps the filter you chose', async () => {
  // Otherwise "Deal again" quietly drops you back to everything.
  const { out } = await rollPlat('?roll=1&plat=ps5');
  const body = bodyOf(out);
  // The first version of this was /Deal again[\s\S]{0,80}|plat=ps5/, an
  // alternation: the left half matched on its own and the assertion passed
  // whether or not the filter survived at all.
  // Assert the anchors themselves. Slicing backwards from the words "Deal
  // again" landed inside the card icon's SVG, which is markup between the href
  // and the label and says nothing about either.
  assert.match(body, /<a class="rollcta" href="[^"]*plat=ps5"/, 'the toolrow link keeps it');
  assert.match(body, /<a href="[^"]*plat=ps5[^"]*">Deal again/, 'and so does the one on the panel');
});

test('an empty filtered deal explains itself and offers a way out', async () => {
  // `null` would fall through `opts.wild ?? WILD` and hand back a game, so the
  // deal would not have been empty and this branch would never have run.
  const { env } = rollEnv({ backlog: [], wild: false });
  const res = await mod.onRequestGet({
    params: { name: 'JFL__Leon' }, env,
    request: new Request('https://kraken.test/hunter/JFL__Leon?roll=1&plat=vita'),
  });
  const body = bodyOf(await res.text());
  assert.ok(body.includes('Nothing on <b>Vita</b> to deal'), 'names the platform');
  assert.match(body, /Deal from everything/, 'and does not strand you there');
});

/* ---- head to head ---- */

const compare = (query, opts = {}) => {
  vsQueries = 0;
  return render('JFL__Leon', query, {
    vsMember: OTHER, vsAhead: VS_AHEAD_ROWS, vsTheirs: VS_THEIRS_ROWS, ...opts,
  });
};

test('nothing is compared until somebody asks', async () => {
  const { out } = await compare('');

  assert.equal(vsQueries, 0, 'no compare query runs on a plain page view');
  assert.ok(!out.includes('Head to head'), 'and no panel');
  // The way in is still on the page, though, or the feature does not exist.
  assert.ok(out.includes('name="vs"'), 'the compare box is there');
});

test('a comparison names both hunters and the gap between them', async () => {
  const { out } = await compare('?vs=MRTheChez');
  const body = bodyOf(out);

  assert.ok(body.includes('Head to head'), 'the panel opens');
  assert.ok(body.includes('JFL__Leon') && body.includes('MRTheChez'), 'both names');
  // 194,669 - 186,406. Measured from the hunter whose page this is, the same
  // rule the rivals panel follows.
  assert.ok(body.includes('8,263'), 'the gap, grouped');
  assert.ok(body.includes('ahead'), 'and which way round it runs');
  assert.ok(body.includes('3rd'), "the challenger's rank");
});

test('the rows compare progress and trophies, never points', async () => {
  const { out } = await compare('?vs=MRTheChez');
  const body = bodyOf(out);

  assert.ok(body.includes('Elden Ring'), 'the shared game they are ahead on');
  assert.ok(body.includes('9 v 42 of 42 trophies'), 'trophies, both ways round');
  assert.match(body, /class="vsb mine"[\s\S]*?width:18%/, "this hunter's bar");
  assert.match(body, /class="vsb them"[\s\S]*?width:100%/, "the challenger's bar");

  /**
   * THE WHOLE REASON THE PANEL IS SHAPED THIS WAY. Leon is on 87.45% and
   * MRTheChez on 62.10%, so the same trophies pay them different amounts. A
   * points column beside one game would read as a bug to anybody who did not
   * already know that, so there isn't one, and the panel says why.
   */
  assert.ok(
    body.includes("multiplies every game by the hunter's own completion"),
    'the panel explains why points are not per game',
  );
});

test('games the hunter has never touched are offered, with one bar', async () => {
  const { out } = await compare('?vs=MRTheChez');
  const body = bodyOf(out);

  assert.ok(body.includes('Nioh 2'), 'the game only the challenger owns');
  assert.ok(body.includes('40 of 70 trophies'), 'counted once, because there is only one of them');

  const row = body.split('<li class="vsrow"').find((r) => r.includes('Nioh 2'));
  assert.ok(!row.includes('vsb mine'), 'no bar for a library that has no row');
});

test('comparing somebody against themselves is refused politely', async () => {
  // Same account id as the page member. Names alone would not do: PSN ids are
  // matched NOCASE, so "jfl__leon" is the same hunter and must be caught too.
  const { out } = await compare('?vs=JFL__Leon', { vsMember: { ...MEMBER } });
  const body = bodyOf(out);

  assert.ok(body.includes('That is the same hunter'), 'says so');
  assert.ok(!body.includes('Head to head'), 'and does not draw the panel');
});

test('comparing against nobody says so and keeps the page', async () => {
  const { res, out } = await compare('?vs=Nobody', { vsMember: null });
  const body = bodyOf(out);

  assert.equal(res.status, 200, 'still the hunter page, not a 404');
  assert.ok(body.includes('No hunter called <b>Nobody</b>'), 'names what was typed');
  assert.ok(body.includes('Bloodborne'), 'the library is still underneath');
});

test('a hostile hunter name cannot inject markup through the compare box', async () => {
  const { out } = await compare('?vs=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E', {
    vsMember: null,
  });
  /**
   * ESCAPED, NOT ABSENT. The string comes back on the page twice, in the
   * message and in the box it was typed into, and both times it has to read as
   * the text somebody typed rather than run as markup. So the assertion is that
   * no tag was built, not that the characters are gone.
   */
  assert.ok(!/<img[^>]*onerror/i.test(out), 'no tag is built from it');
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), 'it is shown as text');
});

/**
 * THE LIMIT IS NOT A COST CONTROL, and these two tests are what stops somebody
 * later "optimising" it into one.
 *
 * Both compare queries end in ORDER BY on a computed expression, so every
 * matching row is produced and sorted before the LIMIT applies. Twelve rows
 * costs what four hundred costs. The short list is a readability decision and
 * the long one is a display switch, which is why `all=1` adds no query.
 */
const many = (n) =>
  Array.from({ length: n }, (_, i) => ({
    np_comm_id: `M${i}`, title: `Game ${i}`, platform: 'PS5', icon_url: null,
    max_points: 5000 - i, trophy_count: 40,
    my_points: 100, my_progress: 10, my_trophies: 4,
    their_points: 4000, their_progress: 90, their_trophies: 36,
  }));

test('a long comparison is cut to a readable list, with a way to see the rest', async () => {
  const { out } = await compare('?vs=MRTheChez', { vsAhead: many(60), vsTheirs: many(60) });
  const body = bodyOf(out);

  assert.equal((body.match(/class="vsrow"/g) || []).length, 20, '12 shared and 8 of theirs');
  assert.ok(body.includes('Show every game they are ahead on'), 'and a way through to the rest');
  assert.ok(body.includes('all=1'), 'which is a plain link, not a script');
});

test('asking for all of it adds no queries, only rows', async () => {
  const { out } = await compare('?vs=MRTheChez&all=1', { vsAhead: many(60), vsTheirs: many(60) });
  const body = bodyOf(out);

  assert.equal((body.match(/class="vsrow"/g) || []).length, 120, 'everything the stub had');
  assert.equal(vsQueries, 3, 'the same three queries as the short version');
  assert.ok(!body.includes('Show every game'), 'and nothing left to expand');
});

test('a comparison that fits shows no expander at all', async () => {
  const { out } = await compare('?vs=MRTheChez');
  assert.ok(!bodyOf(out).includes('Show every game'), 'one spare row is how it knows');
});

test('a comparison is only two extra queries, and only when asked', async () => {
  await compare('?vs=MRTheChez');
  // The lookup, the shared games, the games only they have. Three, and no more:
  // this reads two libraries, so a fourth would want a reason.
  assert.equal(vsQueries, 3, 'lookup plus the two lists');
});
