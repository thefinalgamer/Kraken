import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Find a hunter on the boards. Martin, 22 September: "a search bar for the
 * leaderboard... highlight the person or bring you to them".
 *
 * It runs in the browser against rows already on the page, so the thing worth
 * pinning here is that both boards carry it and that it asks the database for
 * nothing extra.
 */
const rows = Array.from({ length: 3 }, (_, i) => ({
  rank: i + 1, prev_rank: i + 1, psn_online_id: ['Pelzio', 'JFL__Leon', 'UncleUrbi'][i], country: 'GB',
  avatar_url: null, points: 1000 - i, completion: 80, platinum: 1, gold: 1, silver: 1, bronze: 1,
  projects: 10, completed: 5, supporter_months: 0, live_trophies: 1, last_live_at: Date.now(),
}));

const envCounting = () => {
  let queries = 0;
  return {
    get queries() { return queries; },
    DB: {
      prepare() {
        queries += 1;
        const a = { all: async () => ({ results: rows }), first: async () => null };
        return { ...a, bind: () => a };
      },
    },
  };
};

for (const [label, path, url] of [
  ['all-time board', '../functions/leaderboard.js', 'https://x.test/leaderboard'],
  ['streamers board', '../functions/leaderboard/streamers.js', 'https://x.test/leaderboard/streamers'],
]) {
  test(`the ${label} has a find box`, async () => {
    const mod = await import(path);
    const res = await mod.onRequestGet({ env: envCounting(), request: new Request(url) });
    const out = await res.text();
    assert.match(out, /<form class="find boardfind" role="search"/);
    assert.match(out, /id="bfq"/);
    assert.match(out, /Open their profile/, 'and it offers the way through to them');
    assert.ok(!/onsubmit=|onclick=/.test(out), 'no inline handlers');
  });
}

test('finding somebody costs the database nothing', async () => {
  const mod = await import('../functions/leaderboard.js');
  const env = envCounting();
  await mod.onRequestGet({ env, request: new Request('https://x.test/leaderboard') });
  const before = env.queries;
  const { boardFind } = await import('../functions/_lib/page.js');
  assert.ok(!/fetch\(/.test(boardFind()), 'the box never calls the server');
  assert.equal(before, 1, 'the board is still one query');
});
