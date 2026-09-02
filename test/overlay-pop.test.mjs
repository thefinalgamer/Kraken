import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bodyOf } from './helpers.mjs';
import { displayBanked } from '../shared/scoring.mjs';

/**
 * The trophy pop. GET /overlay/<name>/pop
 *
 * Its own source, so it can be placed anywhere, which means it has to survive
 * being empty for hours at a time and must never leave anything on the screen
 * it did not mean to.
 */
const mod = await import('../functions/overlay/[name]/pop.js');

const MIN = 60000;
const NOW = Date.now();

const MEMBER = {
  psn_account_id: 'acct-1', psn_online_id: 'Pelzio', completion: 92.55,
  rank: 2, prev_rank: 3, overlay_seen_at: NOW - 60 * MIN,
};

const TROPHY = {
  np_comm_id: 'NPWR_INDY', trophy_id: 12, earned_at: NOW - 2 * MIN,
  name: 'Grail Diary Complete', type: 'gold', points: 445,
  game: 'Indiana Jones and the Great Circle',
};

let writes = [];

const fakeEnv = ({ member = MEMBER, trophy = TROPHY, throwOnLog = false } = {}) => ({
  DB: {
    prepare(sql) {
      return {
        bind: (...args) => ({
          first: async () => {
            if (sql.includes('FROM members')) return member;
            if (throwOnLog) throw new Error('no such table: member_trophies');
            return trophy;
          },
          run: async () => {
            writes.push({ sql, args });
            return { success: true };
          },
        }),
      };
    },
  },
});

const render = async (opts = {}, qs = '') => {
  writes = [];
  const res = await mod.onRequestGet({
    env: fakeEnv(opts),
    request: new Request(`https://platinumintel.co.uk/overlay/Pelzio/pop${qs}`),
    params: { name: 'Pelzio' },
  });
  return { res, out: await res.text(), writes };
};

const isEmpty = (out) =>
  bodyOf(out).replace(/<\/style>|<\/head>|<body>|<\/body>|<\/html>|\s/g, '') === '';

test('it shows a trophy earned two minutes ago', async () => {
  const { out } = await render();
  const body = bodyOf(out);
  assert.match(body, /Grail Diary Complete/);
  assert.match(body, /Indiana Jones/, 'and which game it came from');
  const paid = displayBanked(TROPHY.points, MEMBER.completion);
  assert.match(body, new RegExp(`\\+${paid.toLocaleString('en-GB')}`), 'banked, not raw');
  assert.match(body, /overlay\/gold\.png/, 'with the gold frames');
});

test('a trophy pops once and never again', async () => {
  /**
   * The page repaints every twenty seconds. Without the marker, a trophy
   * earned at 9:04 would pop again at 9:04:20 and 9:04:40, and a celebration
   * that repeats is not a celebration.
   */
  const { writes: w } = await render();
  const move = w.find((x) => x.sql.includes('overlay_seen_at'));
  assert.ok(move, 'the marker moves');
  assert.deepEqual(move.args, [TROPHY.earned_at, 'acct-1'], 'to this trophy, for this member');
});

test('the very first run shows nothing and starts the clock', async () => {
  /**
   * Adding the source must not fire their most recent platinum from March at
   * an audience with no idea what they are looking at.
   */
  const { out, writes: w } = await render({ member: { ...MEMBER, overlay_seen_at: null } });
  assert.ok(isEmpty(out), 'nothing on screen');
  const move = w.find((x) => x.sql.includes('overlay_seen_at'));
  assert.ok(move, 'but the marker is set');
  assert.ok(Math.abs(move.args[0] - Date.now()) < 5000, 'to now, not to zero');
});

test('a night of offline trophies is skipped, not queued', async () => {
  /**
   * Somebody plays offline and syncs forty trophies at midnight. Without a
   * ceiling the overlay would work through them one every twenty seconds for a
   * quarter of an hour, long after anybody watching had gone.
   */
  const stale = { ...TROPHY, earned_at: NOW - 90 * MIN };
  const { out, writes: w } = await render({ trophy: stale });
  assert.ok(isEmpty(out), 'too old to announce');
  assert.equal(
    w.find((x) => x.sql.includes('overlay_seen_at'))?.args[0],
    stale.earned_at,
    'and the marker still moves past it',
  );
});

test('nothing to show means an empty page, never a leftover card', async () => {
  const { out, res } = await render({ trophy: null });
  assert.ok(isEmpty(out));
  assert.match(res.headers.get('cache-control'), /no-store/, 'and it asks again next time');
  assert.match(out, /<meta http-equiv="refresh" content="20">/, 'still repainting');
});

test('the card removes itself rather than sitting there until the refresh', async () => {
  const { out } = await render();
  // One run, filling forwards, so the last keyframe (invisible) is what sticks.
  assert.match(out, /animation:popin [\d.]+s [^;]*1 forwards/, 'plays once and stays gone');
  assert.match(out, /100%\{opacity:0/, 'ending invisible');
});

test('the climb shows only when they actually moved up', async () => {
  const up = bodyOf((await render()).out);
  assert.match(up, /class="climb"/, '3rd to 2nd is worth saying');
  assert.match(up, /3<sup>rd<\/sup>/);
  assert.match(up, /2<sup>nd<\/sup>/);

  const flat = bodyOf((await render({ member: { ...MEMBER, prev_rank: 2 } })).out);
  assert.ok(!flat.includes('class="climb"'), 'standing still is not a climb');

  const down = bodyOf((await render({ member: { ...MEMBER, prev_rank: 1, rank: 2 } })).out);
  assert.ok(!down.includes('class="climb"'), 'and losing a place is not announced');
});

test('test mode loops, says it is a test, and touches nothing', async () => {
  /**
   * You cannot position a box you only see once every few hours. Martin: "i
   * dont know if i can set up a quick test thing or not".
   */
  const { out, writes: w } = await render({}, '?test=platinum');
  const body = bodyOf(out);
  assert.match(body, /class="pop demo"/, 'looping');
  assert.match(body, /Test trophy/i, 'and honest about what it is');
  assert.match(body, /overlay\/plat\.png/, 'in the metal asked for');
  assert.ok(!out.includes('http-equiv="refresh"'), 'no reload fighting the loop');
  assert.deepEqual(w, [], 'a test must not move anybody real marker');
});

test('a junk metal in test mode falls back rather than 404ing the image', async () => {
  const body = bodyOf((await render({}, '?test=../../etc/passwd')).out);
  assert.match(body, /overlay\/gold\.png/, 'whitelisted, never interpolated');
  assert.ok(!body.includes('passwd'), 'and nothing from the query reaches the markup');
});

test('it carries no branding, like the bar', async () => {
  const { out } = await render();
  for (const brand of ['Platinum Intel', 'platinumintel', 'kraken', 'discord.gg']) {
    assert.ok(!out.toLowerCase().includes(brand.toLowerCase()), `"${brand}" is on the pop`);
  }
});

test('the background is transparent and nothing scrolls', async () => {
  const { out } = await render();
  assert.match(out, /html,body\{margin:0;background:transparent;overflow:hidden\}/);
  assert.ok(!out.includes('<script'), 'no JavaScript in a browser source');
});

test('a database without the trophy log renders empty instead of erroring', async () => {
  /**
   * Migrations 016 and 018 might not have run. An overlay is the last place
   * that should turn into a stack trace on somebody's stream.
   */
  const { res, out } = await render({ throwOnLog: true });
  assert.equal(res.status, 200);
  assert.ok(isEmpty(out));
});

test('the frames it points at are actually committed', async () => {
  for (const metal of ['plat', 'gold', 'silver', 'bronze']) {
    const buf = await readFile(new URL(`../public/overlay/${metal}.png`, import.meta.url));
    assert.ok(buf.length > 10000, `${metal}.png looks empty`);
    // 36 frames of 104px, so the strip is 3744 wide. The PNG header carries the
    // dimensions at a fixed offset, which is enough to catch a half-written or
    // resized strip without a decoder.
    assert.equal(buf.readUInt32BE(16), 104 * 36, `${metal}.png is not 36 frames`);
    assert.equal(buf.readUInt32BE(20), 104, `${metal}.png is not 104 tall`);
  }

  const gen = await readFile(new URL('../tools/trophy-frames.py', import.meta.url), 'utf8');
  assert.match(gen, /FRAMES = 36/, 'and the generator still agrees');
  assert.match(gen, /SIZE  = 104/);
});
