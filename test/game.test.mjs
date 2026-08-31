import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The game page, rendered against fake rows.
 *
 * ASSERT ON THE ELEMENT, NEVER ON THE CLASS. This is the third time that
 * lesson has been paid for on this site: an accent strip shipped with CSS and
 * no element, and every test passed because it checked the row's class name.
 * The stylesheet is INLINED into every page, so `out.includes('spoilbox')` is
 * true whether or not a checkbox was ever rendered. Everything below looks for
 * the tag.
 *
 * The stub reads the SQL it is handed and answers accordingly, so the page has
 * to issue the queries it actually issues or the assertions fail.
 */
const mod = await import('../functions/game/[id].js');

const DAY = 86400000;

const GAME = {
  np_comm_id: 'NPWR07110_00', title: 'Bloodborne', platform: 'PS4',
  icon_url: 'https://x.test/bb.png', trophy_count: 4, has_platinum: 1,
  max_points: 4200, estimated: 0, unobtainable: 0, unobtainable_note: null,
  flagged_at: null, closes_at: null, local_started: 3, refreshed_at: Date.now(),
};

const TROPHIES = [
  { trophy_id: 0, name: 'Bloodborne', detail: 'Collect all trophies.', type: 'platinum',
    icon_url: 'https://x.test/p.png', hidden: 0, earned_rate: 4.21, points: 900, local_earned: 1 },
  { trophy_id: 1, name: 'Blood Rapture', detail: 'Kill Mergo\'s Wet Nurse.', type: 'gold',
    icon_url: null, hidden: 0, earned_rate: 31.2, points: 300, local_earned: 2 },
  // The secret one. Its name is a plot point, which is the entire feature.
  { trophy_id: 2, name: 'Childhood\'s Beginning', detail: 'Became an infant Great One.',
    type: 'gold', icon_url: null, hidden: 1, earned_rate: 12.5, points: 420, local_earned: 0 },
  // No rarity published by PSN.
  { trophy_id: 3, name: 'Ill-Omened Nightmare', detail: null, type: 'bronze',
    icon_url: null, hidden: 0, earned_rate: null, points: 15, local_earned: 3 },
];

const OWNERS = [
  { psn_online_id: 'th3finalgamer--', avatar_url: 'https://x.test/a.png', rank: 3,
    progress: 100, points: 4200, earned_total: 4, earned_platinum: 1, earned_gold: 2,
    earned_silver: 0, earned_bronze: 1, last_played_at: Date.now() - DAY,
    last_earned_at: 1739318400000 },
  { psn_online_id: 'JFL__Leon', avatar_url: null, rank: 27,
    progress: 41, points: 900, earned_total: 2, earned_platinum: 0, earned_gold: 1,
    earned_silver: 0, earned_bronze: 1, last_played_at: Date.now() - 9 * DAY,
    last_earned_at: Date.now() - 9 * DAY },
  { psn_online_id: 'Wilko', avatar_url: null, rank: 12,
    progress: 0, points: 0, earned_total: 0, earned_platinum: 0, earned_gold: 0,
    earned_silver: 0, earned_bronze: 0, last_played_at: null, last_earned_at: null },
];

let lastTrophySql = '';

const fakeEnv = ({ game = GAME, byTitle = null, trophies = TROPHIES, owners = OWNERS } = {}) => ({
  DB: {
    prepare(sql) {
      if (sql.includes('FROM trophies')) {
        lastTrophySql = sql;
        return {
          bind: () => ({ all: async () => ({ results: trophies }), first: async () => trophies[0] }),
        };
      }
      if (sql.includes('FROM member_games')) {
        return { bind: () => ({ all: async () => ({ results: owners }) }) };
      }
      // games, by id or by title
      const row = sql.includes('COLLATE NOCASE') ? byTitle : game;
      return { bind: () => ({ first: async () => row, all: async () => ({ results: [] }) }) };
    },
  },
});

const render = async (opts = {}, query = '') => {
  const res = await mod.onRequestGet({
    params: { id: opts.id ?? 'NPWR07110_00' },
    env: fakeEnv(opts),
    request: new Request(`https://kraken.test/game/NPWR07110_00${query}`),
  });
  return { res, out: await res.text() };
};

test('the page renders the game, its trophies and its owners', async () => {
  const { res, out } = await render();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control'), /max-age=300/);

  assert.ok(out.includes('Bloodborne'), 'title');
  assert.ok(out.includes('4,200'), 'max points');
  assert.ok(out.includes('Blood Rapture'), 'a trophy name');
  assert.ok(out.includes('Kill Mergo'), 'a trophy description');
  for (const o of OWNERS) assert.ok(out.includes(o.psn_online_id), `${o.psn_online_id} missing`);
  assert.ok(out.includes('href="/hunter/th3finalgamer--"'), 'owners link to their pages');
});

test('the cabinet counts trophy types from the rows, not from trophy_count', async () => {
  // One platinum, two gold, zero silver, one bronze. The fixture's trophy_count
  // agrees, but the counting must come from the list or a game with a missing
  // trophy row would print a cabinet that does not add up to its own table.
  const { out } = await render();
  const cabinet = out.slice(out.indexOf('class="cups"'), out.indexOf('class="tabs"'));
  assert.match(cabinet, /Platinum">.*?1</s, 'one platinum');
  assert.match(cabinet, /Gold">.*?2</s, 'two gold');
  assert.match(cabinet, /Silver">.*?0</s, 'no silver');
});

test("Sony's rarity bands, and its words", async () => {
  const { out } = await render();
  assert.ok(out.includes('Ultra rare'), '4.21% is ultra rare');
  assert.ok(out.includes('Uncommon'), '31.2% is uncommon');
  assert.ok(out.includes('Rare'), '12.5% is rare');
  assert.ok(out.includes('Not published'), 'a null rate says so rather than printing 0%');
  assert.ok(!out.includes('0.00%'), 'and never prints it as zero percent');
});

test('the local column counts people here, not percentages of the world', async () => {
  const { out } = await render();
  // Three owners in the fixture, so the denominator is three every time.
  assert.ok(out.includes('/ 3</span>'), 'denominator is the number of owners listed');
  assert.ok(out.includes('nobody here'), 'a trophy nobody here has says so');
  assert.ok(out.includes('one of us'), 'and one person is named as one person');
});

test('the denominator is the owners listed, not the stored local_started', async () => {
  // local_started counts members mid-first-scan too, and those are not in the
  // panel below. Printing "1 / 3" above a list of two people is a bug that
  // looks exactly like a bug.
  const { out } = await render({ owners: OWNERS.slice(0, 2) });
  assert.ok(out.includes('/ 2</span>'), 'two owners listed means a denominator of two');
  assert.ok(!out.includes('/ 3</span>'), 'the stored 3 is not used');
});

test('a secret trophy is blurred behind a real checkbox', async () => {
  const { out } = await render();

  // THE ELEMENT, not the class. The stylesheet is inlined, so searching for
  // "spoilbox" alone would pass on a page with no checkbox on it at all.
  assert.match(out, /<input type="checkbox" id="spoilers" class="spoilbox">/, 'the input exists');
  assert.match(out, /<label for="spoilers"/, 'and its label');
  assert.ok(out.includes('Reveal 1 secret trophy'), 'singular, and counted');

  // The blurred row must carry the class the stylesheet blurs, AND the text
  // must be inside the element that gets blurred.
  assert.match(out, /class="tr-g secret"/, 'the secret row is marked');
  assert.match(
    out,
    /<span class="spoil">[\s\S]{0,200}Childhood/,
    'the secret name is inside the blurred span',
  );
});

test('the checkbox is a sibling of the table, or the reveal does nothing', async () => {
  // `:checked ~ .tablewrap` only reaches siblings. If the input is ever wrapped
  // in the toolrow div with its label, the blur never lifts and every other
  // assertion in this file still passes.
  const { out } = await render();
  const input = out.indexOf('class="spoilbox"');
  const toolrow = out.indexOf('class="toolrow"');
  const table = out.indexOf('class="tablewrap"', input);
  assert.ok(input > -1 && toolrow > input, 'the input comes before the toolrow');
  assert.ok(
    !out.slice(toolrow, table).includes('class="spoilbox"'),
    'the input is not inside the toolrow',
  );
});

test('no secrets means no toggle', async () => {
  const { out } = await render({ trophies: TROPHIES.filter((t) => !t.hidden) });
  assert.ok(!out.includes('<input type="checkbox"'), 'no control for nothing to reveal');
});

test('the sort whitelist is a whitelist', async () => {
  await render({}, '?sort=here');
  assert.match(lastTrophySql, /t\.local_earned ASC/);

  // Anything not in the list falls back to PSN order rather than reaching SQL.
  await render({}, '?sort=; DROP TABLE trophies--');
  assert.match(lastTrophySql, /t\.trophy_id ASC/);
  assert.ok(!lastTrophySql.includes('DROP TABLE'));
});

test('a game with a deadline says so above the trophy list', async () => {
  const { out } = await render({
    game: { ...GAME, closes_at: Date.now() + 12 * DAY, unobtainable_note: 'Servers close in May' },
  });
  const warn = out.indexOf('class="warn');
  const table = out.indexOf('<table');
  assert.ok(warn > -1 && warn < table, 'the deadline is above the list, not below it');
  assert.ok(out.includes('Servers close in May'), 'the note a mod typed is shown');
});

test('a dead game gets the warning, not the clock', async () => {
  const { out } = await render({ game: { ...GAME, unobtainable: 1, unobtainable_note: 'MP closed' } });
  assert.ok(out.includes('warn dead'), 'the dead treatment');
  assert.ok(out.includes('&#9888;'), 'the triangle');
  assert.ok(!out.includes('&#8987;'), 'and not the hourglass');
});

test('an estimated game admits it', async () => {
  const { out } = await render({ game: { ...GAME, estimated: 1 } });
  assert.ok(out.includes('estimated'), 'the word is on the page');
});

test('a title in the URL falls back to a title lookup', async () => {
  const { out } = await render({ id: 'Bloodborne', game: null, byTitle: GAME });
  assert.ok(out.includes('Blood Rapture'), 'the page rendered from the title match');
});

test('an unknown game is a 404 that explains itself', async () => {
  const { res, out } = await render({ id: 'nope', game: null, byTitle: null });
  assert.equal(res.status, 404);
  assert.ok(out.includes('is in the index') || out.includes('No game called'));
  assert.ok(out.includes('/games'), 'and offers a way out');
});

test('a game nobody here owns still renders', async () => {
  const { out } = await render({ owners: [] });
  assert.ok(out.includes('Nobody on the board owns this one yet'));
  assert.ok(out.includes('Blood Rapture'), 'the trophy list is still there');
});

test('a game with no trophy rows says why rather than rendering an empty table', async () => {
  const { out } = await render({ trophies: [] });
  assert.ok(out.includes('No trophy list for this game yet'));
});

test('a hostile trophy name cannot inject markup', async () => {
  const { out } = await render({
    trophies: [{ ...TROPHIES[0], name: '<img src=x onerror=alert(1)>', detail: '"><script>x' }],
  });
  assert.ok(out.includes('&lt;img'), 'escaped');
  assert.ok(!out.includes('<img src=x'), 'not rendered as a tag');
  assert.ok(!out.includes('<script>x'), 'and neither is the detail');
});

test('a hostile game title cannot break out of the description meta tag', async () => {
  const { out } = await render({ game: { ...GAME, title: '" onload="alert(1)' } });
  assert.ok(!out.includes('onload="alert'));
});
