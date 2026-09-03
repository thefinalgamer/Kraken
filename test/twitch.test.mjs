import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checkLive, isLive, LIVE_STALE_MS } from '../worker/src/twitch.mjs';

/**
 * The live check.
 *
 * It is one request every five minutes and it does not matter on its own. What
 * it protects is the thing that comes next: the trophy pop wants PSN asked
 * every ten seconds while somebody streams, and doing that for a board that is
 * mostly asleep would put the board's own PSN access at risk. So most of these
 * tests are about it failing safely rather than about it working.
 */

const MIN = 60000;

const MEMBERS = [
  { psn_account_id: 'a1', twitch_login: 'pelzio', live_since: null },
  { psn_account_id: 'a2', twitch_login: 'jfl__leon', live_since: 1000 },
  { psn_account_id: 'a3', twitch_login: 'th3finalgamer', live_since: null },
];

/** A D1 that records every write, and a fetch that answers as Twitch. */
function harness({
  members = MEMBERS,
  streams = [],
  tokenRow = null,
  tokenStatus = 200,
  streamStatus = 200,
} = {}) {
  const writes = [];
  const calls = [];

  const env = {
    TWITCH_CLIENT_ID: 'id',
    TWITCH_CLIENT_SECRET: 'secret',
    DB: {
      prepare(sql) {
        const stmt = {
          sql,
          args: [],
          bind(...a) { stmt.args = a; return stmt; },
          async first() {
            if (sql.includes('worker_state')) return tokenRow;
            return null;
          },
          async all() { return { results: members }; },
          async run() { writes.push({ sql, args: stmt.args }); return { success: true }; },
        };
        return stmt;
      },
      async batch(list) {
        for (const s of list) writes.push({ sql: s.sql, args: s.args });
        return list.map(() => ({ success: true }));
      },
    },
  };

  globalThis.fetch = async (url, opts) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('id.twitch.tv')) {
      return {
        ok: tokenStatus === 200,
        status: tokenStatus,
        json: async () => ({ access_token: 'tok', expires_in: 5000000 }),
      };
    }
    return {
      ok: streamStatus === 200,
      status: streamStatus,
      json: async () => ({ data: streams }),
    };
  };

  return { env, writes, calls };
}

const live = (login, extra = {}) => ({
  user_login: login, type: 'live', started_at: '2026-09-02T20:00:00Z', ...extra,
});

test('one request covers the whole board', async () => {
  // Twitch takes a hundred logins at a time. Asking per member would be
  // seventy requests every five minutes to answer a question about two people.
  const { env, calls } = harness({ streams: [live('pelzio')] });
  await checkLive(env);

  const streamCalls = calls.filter((c) => c.includes('helix/streams'));
  assert.equal(streamCalls.length, 1, 'one call, not one per member');
  for (const login of ['pelzio', 'jfl__leon', 'th3finalgamer']) {
    assert.ok(streamCalls[0].includes(`user_login=${login}`), `${login} was asked about`);
  }
});

test('it writes who came on and who went off, and nothing else', async () => {
  /**
   * Pelzio just went live and Leon just went off. The third member was off and
   * stayed off, so his `live_since` must not be rewritten: every member still
   * gets a `live_checked_at` stamp, because "we asked and they are off" is
   * different information from "we have not asked since Tuesday".
   */
  const { env, writes } = harness({ streams: [live('pelzio')] });
  await checkLive(env);

  // Scoped to member writes: the token cache is a run() too, and counting it
  // here made this test fail with an off by one that had nothing to do with
  // anybody going live.
  const members = writes.filter((w) => w.sql.includes('UPDATE members'));
  const changed = members.filter((w) => w.sql.includes('live_since = ?'));
  const touched = members.filter((w) => !w.sql.includes('live_since = ?'));

  assert.equal(changed.length, 2, 'two states moved');
  assert.deepEqual(changed.map((w) => w.args.at(-1)).sort(), ['a1', 'a2']);
  assert.equal(changed.find((w) => w.args.at(-1) === 'a1').args[0],
    Date.parse('2026-09-02T20:00:00Z'), 'live since the stream started, not since we noticed');
  assert.equal(changed.find((w) => w.args.at(-1) === 'a2').args[0], null, 'and off is null');

  assert.equal(touched.length, 1, 'the unchanged one is only stamped');
  assert.match(touched[0].sql, /live_checked_at = \?/);
});

test('a rerun is not somebody at a console', async () => {
  const { env, writes } = harness({ streams: [live('pelzio', { type: 'rerun' })] });
  await checkLive(env);
  const changed = writes.filter((w) => w.sql.includes('live_since = ?'));
  // Only Leon, who genuinely went off. Pelzio's rerun is not a stream.
  assert.deepEqual(changed.map((w) => w.args.at(-1)), ['a2']);
});

test('a failed check leaves the last answer alone', async () => {
  /**
   * Writing "nobody is live" because Twitch returned a 503 would take the fast
   * polling away mid stream, and the person it happened to would have no idea
   * why their overlay went quiet. Stale and honest beats fresh and wrong.
   */
  const { env, writes } = harness({ streamStatus: 503 });
  const summary = await checkLive(env);
  assert.match(summary, /check failed/);
  assert.deepEqual(writes.filter((w) => w.sql.includes('members')), [], 'nothing written');
});

test('no credentials means it does nothing and says so', async () => {
  const { env } = harness();
  delete env.TWITCH_CLIENT_ID;
  assert.match(await checkLive(env), /no credentials/);
});

test('nobody with a channel set costs no requests', async () => {
  const { env, calls } = harness({ members: [] });
  assert.match(await checkLive(env), /nobody has a channel/);
  assert.deepEqual(calls, [], 'not even a token fetch');
});

test('the token is cached rather than fetched every five minutes', async () => {
  const fresh = { value: 'cached', expires_at: Date.now() + 3600000 };
  const { env, calls } = harness({ streams: [], tokenRow: fresh });
  await checkLive(env);
  assert.ok(!calls.some((c) => c.includes('id.twitch.tv')), 'no token request');

  // An expiring token is replaced rather than used up to the last second.
  const stale = { value: 'old', expires_at: Date.now() + 5000 };
  const two = harness({ streams: [], tokenRow: stale });
  await checkLive(two.env);
  assert.ok(two.calls.some((c) => c.includes('id.twitch.tv')), 'a new one is fetched');
});

test('a live answer expires if nobody confirms it', async () => {
  /**
   * `live_since` on its own would be a lie the moment the cron stopped: a
   * stream that ended while the check was broken would stay live forever, and
   * the thing reading this decides whether to hammer PSN.
   */
  const now = Date.now();
  assert.equal(isLive({ live_since: now - MIN, live_checked_at: now - MIN }, now), true);
  assert.equal(
    isLive({ live_since: now - MIN, live_checked_at: now - LIVE_STALE_MS - 1 }, now),
    false,
    'an unconfirmed live answer goes cold',
  );
  assert.equal(isLive({ live_since: null, live_checked_at: now }, now), false);
  assert.equal(isLive(null, now), false);
});

test('the cron is registered, and it is the only scheduled work', () => {
  const toml = readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8');
  assert.match(toml, /\[triggers\][\s\S]*?crons = \["\*\/5 \* \* \* \*"\]/, 'every five minutes');
  assert.match(toml, /TWITCH_CLIENT_ID/, 'and the secrets are documented');

  const src = readFileSync(
    fileURLToPath(new URL('../worker/src/index.mjs', import.meta.url)), 'utf8',
  );
  const fn = src.slice(src.indexOf('async scheduled('), src.indexOf('async fetch('));
  assert.match(fn, /checkLive\(env\)/, 'the tick asks Twitch');
  assert.match(fn, /catch\(/, 'and a failing cron never throws into the void');
  assert.ok(!/dispatchScan|getUserTitles/.test(fn), 'no heavy work crept into the Worker');
});

test('only the member themselves can set their channel', () => {
  /**
   * A member telling the board they stream is the consent step for everything
   * downstream. Nobody switches that on for somebody else, which is why the
   * command has no member option for mods to aim at.
   */
  const src = readFileSync(
    fileURLToPath(new URL('../worker/src/index.mjs', import.meta.url)), 'utf8',
  );
  const fn = src.slice(src.indexOf('async function twitch('), src.indexOf('async function overlay('));
  assert.match(fn, /db\.memberByDiscordId\(env, userId\)/, 'it is always about the caller');
  assert.ok(!/opt\('member'\)|MANAGE_/.test(fn), 'no mod path, no permission gate to widen');

  const cmds = readFileSync(
    fileURLToPath(new URL('../jobs/register-commands.mjs', import.meta.url)), 'utf8',
  );
  const block = cmds.slice(cmds.indexOf("name: 'twitch'"), cmds.indexOf("name: 'overlay'"));
  assert.ok(!block.includes("name: 'member'"), 'and none registered either');
});

test('the end of a stream is remembered, not just forgotten', async () => {
  /**
   * `live_since` is about right now and goes null the moment somebody is off,
   * which is useless for what happens next: they stream for four hours, go off,
   * and THEN run /update. The scan writes those trophies with the stream long
   * over and nothing is left to say anybody was watching.
   */
  const { env, writes } = harness({ streams: [] });
  await checkLive(env);

  // a2 was live in the fixture and is not any more.
  const ended = writes.find(
    (w) => w.sql.includes('last_stream_start') && w.args.at(-1) === 'a2',
  );
  assert.ok(ended, 'the window is written when the stream stops');
  assert.equal(ended.args[6], 1000, 'from when it started');
  assert.ok(ended.args[7] > Date.now() - 5000, 'to now');
});

test('a stream that is still running does not get an end written', async () => {
  const { env, writes } = harness({ streams: [live('jfl__leon')] });
  await checkLive(env);
  assert.ok(
    !writes.some((w) => w.sql.includes('last_stream_start') && w.args.at(-1) === 'a2'),
    'nothing is closed while it is open',
  );
});

test('trophies that arrive after the stream still get marked', async () => {
  /**
   * THE CATCH-UP SWEEP. The poll marks things while somebody is on air; this is
   * for the rows that only turn up afterwards. It runs on the five minute tick
   * for anybody whose stream finished in the last twelve hours.
   */
  const now = Date.now();
  const { env, writes } = harness({
    members: [{
      psn_account_id: 'a9', twitch_login: 'pelzio', live_since: null, live_game: null,
      last_stream_start: now - 4 * 60 * 60000,
      last_stream_end: now - 30 * 60000,
    }],
    streams: [],
  });
  await checkLive(env);

  const sweep = writes.find((w) => w.sql.includes('UPDATE member_trophies SET on_stream'));
  assert.ok(sweep, 'the window is swept');
  assert.equal(sweep.args[0], 'a9');
  assert.equal(sweep.args[1], now - 4 * 60 * 60000, 'from the start of that stream');
  assert.ok(
    sweep.args[2] > Number(now - 30 * 60000),
    'to a little past the end, because a trophy in the last minute lands after Twitch notices',
  );
  assert.match(sweep.sql, /COALESCE\(on_stream, 0\) = 0/, 'and it leaves marked rows alone');
});

test('a stream from last week is not swept forever', async () => {
  const now = Date.now();
  const { env, writes } = harness({
    members: [{
      psn_account_id: 'a9', twitch_login: 'pelzio', live_since: null, live_game: null,
      last_stream_start: now - 7 * 86400000,
      last_stream_end: now - 7 * 86400000 + 3600000,
    }],
    streams: [],
  });
  await checkLive(env);
  assert.ok(!writes.some((w) => w.sql.includes('UPDATE member_trophies')), 'twelve hours is the limit');
});
