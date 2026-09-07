import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { applyCompletion } from '../shared/scoring.mjs';

/**
 * The JSON API. GET /api/hunter/<name>
 *
 * ONE ENDPOINT FOR THE WHOLE PANEL, because a Twitch panel is drawn by every
 * viewer on a channel at once and four round trips per viewer to fill one
 * 318-pixel box is three too many.
 *
 * The tests that matter here are the ones about what it must NOT do: invent a
 * number, leak an id, or fall over because a later migration has not run.
 */
const mod = await import('../functions/api/hunter/[name].js');

const MEMBER = {
  psn_account_id: 'acct-1', psn_online_id: 'JFL__Leon', avatar_url: null,
  rank: 31, points: 184751, raw_points: 260580, completion: 70.9,
  platinum: 214, gold: 960, silver: 2278, bronze: 7634,
  projects: 314, completed: 158,
  rarest_name: 'Ashen Blood', rarest_rate: 0.31, rarest_game: 'Bloodborne',
  twitch_login: 'jfl__leon', live_since: null, live_checked_at: Date.now(),
  live_viewers: null, live_play: null,
  last_stream_start: Date.now() - 9e6, last_stream_end: Date.now() - 6e6,
  last_update_at: Date.now() - 3600000,
};

const PLAYING = {
  np_comm_id: 'NPWR_GOY', title: 'Ghost of Yotei', platform: 'PS5',
  icon_url: 'https://x.test/goy.png', trophy_count: 30, max_points: 168,
  local_started: 4, unobtainable: 0, closes_at: null,
  points: 47, progress: 36, earned_total: 13, plat_local: 0,
};

const fake = (o = {}) => ({
  DB: {
    prepare(sql) {
      const st = {
        bind: () => st,
        async first() {
          if (/COUNT\(\*\) AS c FROM members/.test(sql)) return { c: 75 };
          if (/FROM members/.test(sql) && /rank = \?/.test(sql)) return o.ahead ?? null;
          if (/FROM members/.test(sql)) return 'member' in o ? o.member : MEMBER;
          if (/has_platinum = 1/.test(sql)) return o.milestone ?? null;
          return 'playing' in o ? o.playing : PLAYING;
        },
        async all() {
          if (/closes_at IS NOT NULL/.test(sql)) return { results: o.closing ?? [] };
          if (/FROM wishlist/.test(sql)) {
            if (o.noWishlist) throw new Error('no such table: wishlist');
            return { results: o.list ?? [] };
          }
          if (/rank BETWEEN/.test(sql)) return { results: o.around ?? [] };
          return { results: o.top ?? [] };
        },
      };
      return st;
    },
  },
});

const get = async (o, name = 'JFL__Leon') => {
  const res = await mod.onRequestGet({ params: { name }, env: fake(o) });
  return { res, body: JSON.parse(await res.text()) };
};

test('one fetch answers the whole panel', async () => {
  const { res, body } = await get({});
  assert.equal(res.status, 200);

  for (const key of ['hunter', 'live', 'playing', 'chase', 'milestone', 'closing', 'list', 'board']) {
    assert.ok(key in body, `${key} is missing, so a tab would need a second request`);
  }
  assert.equal(body.hunter.name, 'JFL__Leon');
  assert.equal(body.hunter.rank, 31);
  assert.equal(body.hunter.of, 75);
  assert.equal(body.hunter.cabinet.platinum, 214);
});

test('it carries nothing the website does not already print', async () => {
  /**
   * The rule that matters most in a public endpoint with no key. Every figure
   * in here is on a page that needs no login; an account id, a discord id or a
   * token would not be, and none of them has any business on a Twitch panel.
   */
  const { body } = await get({});
  const flat = JSON.stringify(body);

  assert.ok(!flat.includes('acct-1'), 'no psn account id');
  assert.ok(!/discord/i.test(flat), 'no discord anything');
  assert.ok(!/token|npsso|secret/i.test(flat), 'and obviously no credentials');
});

test('it is cached at the edge and open to any origin', async () => {
  /**
   * A Twitch extension runs on an origin nobody can predict, so the header has
   * to be open. The cache is what makes that affordable: three hundred viewers
   * a minute becomes two database reads.
   */
  const { res } = await get({});
  assert.match(res.headers.get('cache-control'), /max-age=30/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('content-type'), /application\/json/);
});

test('an unknown hunter is a 404, not an empty panel', async () => {
  const { res, body } = await get({ member: null });
  assert.equal(res.status, 404);
  assert.match(body.error, /no such hunter/);
});

// ------------------------------------------------------------- the live ----

const playNote = (points, over = {}) =>
  JSON.stringify({
    id: 'NPWR_GOY', at: Date.now(), counts: true,
    progress: 44, platinum: 0, gold: 3, silver: 5, bronze: 8, points,
    ...over,
  });

test('points move while they play, using the board\'s own arithmetic', async () => {
  /**
   * Swap the game's stale share of raw_points for what the poll priced it at,
   * then run the WHOLE total through applyCompletion exactly as the rescore
   * does. Flooring once, where the rescore floors once, is what makes the panel
   * agree with the update that follows it.
   */
  const priced = 47 + 300;
  const expected = applyCompletion(260580 - 47 + priced, 70.9);

  const { body } = await get({
    member: { ...MEMBER, live_play: playNote(priced) },
    ahead: { rank: 30, psn_online_id: 'DebbyWebbyUwU', points: 193870 },
  });

  assert.equal(body.hunter.points, expected, 'the live figure');
  assert.equal(body.hunter.storedPoints, 184751, 'and the stored one, beside it');
  assert.equal(body.chase.gap, 193870 - expected, 'the chase closes as they play');
  assert.equal(body.chase.past, false);
});

test('overtaking is reported without awarding the rank', async () => {
  // Ranks are the rescore's to give. The panel can say the gap is gone.
  const { body } = await get({
    member: { ...MEMBER, live_play: playNote(47 + 40000) },
    ahead: { rank: 30, psn_online_id: 'DebbyWebbyUwU', points: 193870 },
  });
  assert.equal(body.chase.past, true);
  assert.equal(body.chase.gap, 0, 'never a negative gap');
  assert.equal(body.hunter.rank, 31, 'and the rank has not moved');
});

test('a pinned game with no counts keeps the scan\'s figures', async () => {
  // /setgame can name a game PSN has not caught up with. Merging zeroes over
  // real numbers would be a worse lie than a stale one.
  const { body } = await get({
    member: { ...MEMBER, live_play: playNote(0, { counts: false, points: null }) },
  });
  assert.equal(body.playing.progress, 36, 'the stored progress');
  assert.equal(body.playing.earned, 13);
});

test('no live note at all means the stored figures, unchanged', async () => {
  const { body } = await get({});
  assert.equal(body.hunter.points, 184751);
  assert.equal(body.playing.progress, 36);
});

test('live is off unless Twitch confirmed it recently', async () => {
  const stale = await get({
    member: { ...MEMBER, live_since: Date.now() - 3600000, live_checked_at: Date.now() - 3600000 },
  });
  assert.equal(stale.body.live.on, false, 'a check nobody has made in an hour is not proof');

  const on = await get({
    member: { ...MEMBER, live_since: Date.now() - 600000, live_checked_at: Date.now() - 30000 },
  });
  assert.equal(on.body.live.on, true);
});

// -------------------------------------------------------- the additions ----

test('a milestone only appears when it is within reach', async () => {
  const { body } = await get({
    milestone: { title: 'Returnal', icon_url: null, trophy_count: 30, earned_total: 28, need: 2 },
  });
  assert.equal(body.milestone.need, 2);
  assert.equal(body.milestone.at, 215, 'their 215th platinum, counted off the cabinet');
  assert.equal(body.milestone.kind, 'platinum');

  const none = await get({});
  assert.equal(none.body.milestone, null, 'and it is absent rather than empty');
});

test('the milestone query is bounded, or it would always have something to say', async () => {
  // A panel that always has something to say is a panel that never says
  // anything. The bound is what makes it a countdown.
  const src = await readFile(new URL('../functions/api/hunter/[name].js', import.meta.url), 'utf8');
  assert.match(src, /MILESTONE_WITHIN\s*=\s*\d+/);
  assert.match(src, /BETWEEN 1 AND \?/, 'and the SQL uses it');
  assert.match(src, /has_platinum = 1/, 'platinums only, not round numbers');
});

test('closing games count what is left, not what the game is worth', async () => {
  const { body } = await get({
    closing: [{
      np_comm_id: 'N1', title: '2XKO', icon_url: null,
      closes_at: Date.now() + 2 * 86400000,
      max_points: 400, trophy_count: 12, progress: 66, earned_total: 8, points: 160,
    }],
  });
  assert.equal(body.closing[0].left, 4, 'trophies still to get');
  assert.equal(body.closing[0].points, 240, 'and the points still on the table');
});

test('the board comes back collapsed, not as 75 rows', async () => {
  // 318 pixels wide. A full board is a scroll nobody does.
  const { body } = await get({
    top: [{ rank: 1, psn_online_id: 'coregamer1998', avatar_url: null, points: 850613 }],
    around: [{ rank: 30, psn_online_id: 'DebbyWebbyUwU', avatar_url: null, points: 193870 }],
  });
  assert.equal(body.board.top[0].name, 'coregamer1998');
  assert.equal(body.board.around[0].rank, 30);

  const src = await readFile(new URL('../functions/api/hunter/[name].js', import.meta.url), 'utf8');
  assert.match(src, /prepare\(TOP\)\.bind\(5\)/, 'five at the top');
});

test('a database without the wishlist table still serves the panel', async () => {
  /**
   * The seatbelt every feature since migration 019 carries. An empty list is a
   * panel with one quiet tab; a thrown query is no panel at all, on somebody's
   * channel, in front of their viewers.
   */
  const { res, body } = await get({ noWishlist: true });
  assert.equal(res.status, 200);
  assert.deepEqual(body.list, []);
  assert.equal(body.hunter.name, 'JFL__Leon', 'and the rest is untouched');
});

test('CORS preflight is answered', async () => {
  const res = await mod.onRequestOptions();
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-methods'), /GET/);
});
