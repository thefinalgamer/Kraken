import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The front page.
 *
 * It is five queries fired together, so the stub answers by looking at the SQL
 * it is handed. The tests that matter are the ones asserting it PRINTS stored
 * numbers rather than working anything out: the contested line in particular is
 * a subtraction of two columns and must never become a scoring decision.
 */
const mod = await import('../functions/index.js');

const TOTALS = { hunters: 64, points: 12809536, platinum: 68060, projects: 25928, completed: 9871 };

const TOP = [
  { rank: 1, prev_rank: 1, psn_online_id: 'coregamer1998', country: 'GB', avatar_url: null,
    points: 847332, completion: 90.18 },
  { rank: 2, prev_rank: 1, psn_online_id: 'RobThanatos', country: null, avatar_url: 'https://x.test/a.png',
    points: 784515, completion: 85.55 },
  { rank: 3, prev_rank: 4, psn_online_id: 'JFL__Leon', country: 'GB', avatar_url: null,
    points: 186406, completion: 87.45 },
];

const CONTESTED = [
  { np_comm_id: 'N1', title: 'Sea of Thieves', platform: 'PS5', local_started: 9,
    platted_here: 3, unobtainable: 0 },
  { np_comm_id: 'N2', title: 'Neverwinter', platform: 'PS4', local_started: 5,
    platted_here: 0, unobtainable: 1 },
];

const FINISHED = [
  { title: 'Bloodborne', np_comm_id: 'N3', psn_online_id: 'JFL__Leon', finished_at: Date.now() - 86400000 },
  { title: 'Sekiro', np_comm_id: 'N4', psn_online_id: 'Ziune', finished_at: Date.now() - 5 * 86400000 },
];

const NEWEST = [
  { psn_online_id: 'ThoseGooberPlats', country: 'US', avatar_url: null, rank: 44,
    registered_at: Date.now() - 2 * 86400000 },
];

const fakeEnv = (o = {}) => ({
  DB: {
    prepare(sql) {
      const pick = () => {
        if (sql.includes('COUNT(*)')) return { first: async () => o.totals ?? TOTALS };
        if (sql.includes('FROM update_changelog')) return { all: async () => ({ results: o.finished ?? FINISHED }) };
        if (sql.includes('JOIN trophies')) return { all: async () => ({ results: o.contested ?? CONTESTED }) };
        if (sql.includes('ORDER BY registered_at')) return { all: async () => ({ results: o.newest ?? NEWEST }) };
        return { all: async () => ({ results: o.top ?? TOP }) };
      };
      return { ...pick(), bind: () => pick() };
    },
  },
});

const render = async (o) => {
  const res = await mod.onRequestGet({ env: fakeEnv(o) });
  return { res, out: await res.text() };
};

test('the front page leads with what this is and where to go', async () => {
  const { res, out } = await render();
  assert.equal(res.status, 200);

  assert.ok(out.includes('Platinum Intel'), 'names the server');
  assert.ok(out.includes('href="/leaderboard"'), 'sends you to the board');
  assert.ok(out.includes('discord.com/invite/gdSqDYrXaH'), 'and to Discord');

  // No top bar here. The front page carries the same four links as buttons in
  // the middle, and drawing the header too would be the navigation twice on one
  // screen.
  assert.ok(!out.includes('<header class="top">'), 'no header on the door');
  assert.ok(out.includes('class="doornav"'), 'buttons instead');
  assert.ok(out.includes('class="doormark"'), 'and the mark, big');

  // All four routes appear, built or not, so a page can never exist in one
  // navigation and be missing from the other.
  for (const label of ['Leaderboards', 'Games', 'Contested', 'Discord']) {
    assert.ok(out.includes(`>${label}<`), `${label} missing from the door`);
  }
  // Games is a door now. Contested is still the one that is not, and it stays a
  // label rather than a link that 404s.
  assert.ok(out.includes('href="/games"'), 'the index is reachable from the door');
  assert.ok(out.includes('<span class="soon">Contested</span>'), 'unbuilt stays a label');
});

test('the panels are still under the door', async () => {
  // The door is judged on the first visit; the panels are why anybody comes
  // back to the front page rather than straight past it.
  const { out } = await render();
  assert.ok(out.includes('Most contested'));
  assert.ok(out.includes('Just finished'));
  assert.ok(out.includes('Newest hunters'));
  assert.ok(out.includes('Leading the board'));
});

test('the totals are the stored ones, grouped', async () => {
  const { out } = await render();
  assert.ok(out.includes('12,809,536'), 'points');
  assert.ok(out.includes('68,060'), 'platinums');
  assert.ok(out.includes('>64<'), 'hunters');

  // These two are SUMS ACROSS MEMBERS, so the labels must not claim distinct
  // counts. 83,809 games owned between 64 people is true; "83,809 games
  // tracked" was not, when the database holds about 26,000.
  assert.ok(out.includes('Games owned'), 'sum, and labelled as one');
  assert.ok(out.includes('100% completions'), 'completions, not distinct games');
  assert.ok(!out.includes('Games tracked'), 'the misleading label is gone');
  assert.ok(!out.includes('Taken to 100%'));
});

test('the top five link through to their pages, with tiers', async () => {
  const { out } = await render();
  for (const m of TOP) {
    assert.ok(out.includes(`/hunter/${encodeURIComponent(m.psn_online_id)}`), `${m.psn_online_id} link`);
  }
  assert.ok(out.includes('1st') && out.includes('3rd'), 'ordinals');
  assert.ok(out.includes('847,332'), 'points');

  // The tier chip was cut: it squeezed names into "RobTha..." and a truncated
  // name is the one thing in the row you cannot infer from context.
  assert.ok(!out.includes('mini-tier'), 'no tier chip crowding the name');
  assert.ok(out.includes('RobThanatos'), 'names print in full');
});

test('contested never suggests a game nobody can finish', async () => {
  // Asserted on the QUERY, not on the stub's rows: the stub returns whatever it
  // is handed, so checking the output would only prove the fake behaved. The
  // clause is the thing that has to exist.
  let seen = '';
  const env = {
    DB: {
      prepare(sql) {
        if (sql.includes('JOIN trophies')) seen = sql;
        const pick = () => ({
          first: async () => TOTALS,
          all: async () => ({ results: sql.includes('JOIN trophies') ? CONTESTED : [] }),
        });
        return { ...pick(), bind: () => pick() };
      },
    },
  };
  await mod.onRequestGet({ env });
  assert.match(seen, /g\.unobtainable = 0/);
});

test('contested prints two stored numbers and works nothing out', async () => {
  const { out } = await render();
  // 9 own it, 3 have platted it. The page subtracts, and that is the whole of
  // its arithmetic — no multiplier, no re-pricing.
  assert.ok(out.includes('6 of 9 still in it'), 'Sea of Thieves');
  assert.ok(out.includes('5 of 5 still in it'), 'nobody has finished Neverwinter');
  // The flag markup still exists for anywhere else it is needed; the board
  // itself simply never selects a flagged game any more.
});

test('a hostile game title cannot inject markup', async () => {
  const { out } = await render({
    contested: [{ ...CONTESTED[0], title: '<script>alert(1)</script>' }],
  });
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(!out.includes('<script>alert(1)</script>'));
});

test('an empty server renders rather than crashing', async () => {
  const { res, out } = await render({
    totals: { hunters: 0, points: 0, platinum: 0, projects: 0, completed: 0 },
    top: [], contested: [], finished: [], newest: [],
  });
  assert.equal(res.status, 200);
  assert.ok(out.includes('Nobody has finished a scan yet'));
  assert.ok(out.includes('Nothing contested right now'));
});
