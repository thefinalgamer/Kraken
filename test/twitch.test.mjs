import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checkLive, isLive, LIVE_STALE_MS, lookupChannels } from '../worker/src/twitch.mjs';

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
  // The pin clear is its own statement, deliberately outside the batch, so it
  // is counted on its own rather than mistaken for a third state change.
  const pins = members.filter((w) => w.sql.includes('live_pin = NULL'));
  const touched = members.filter(
    (w) => !w.sql.includes('live_since = ?') && !w.sql.includes('live_pin = NULL'),
  );

  assert.equal(changed.length, 2, 'two states moved');
  assert.deepEqual(changed.map((w) => w.args.at(-1)).sort(), ['a1', 'a2']);
  assert.equal(changed.find((w) => w.args.at(-1) === 'a1').args[0],
    Date.parse('2026-09-02T20:00:00Z'), 'live since the stream started, not since we noticed');
  assert.equal(changed.find((w) => w.args.at(-1) === 'a2').args[0], null, 'and off is null');

  assert.equal(touched.length, 1, 'the unchanged one is only stamped');
  assert.match(touched[0].sql, /live_checked_at = \?/);
});

test('going off air takes the game pin with it, and only for whoever went off', async () => {
  /**
   * A pin nobody clears is a bar that lies for a week, which is worse than the
   * bug /setgame fixes. Leon is the one who went off, so Leon is the only one
   * whose pin goes - Pelzio just came ON and is the person most likely to have
   * set one two minutes ago.
   */
  const { env, writes } = harness({ streams: [live('pelzio')] });
  await checkLive(env);

  const pins = writes.filter((w) => w.sql.includes('live_pin = NULL'));
  assert.equal(pins.length, 1, 'one statement, for everybody who ended');
  assert.deepEqual(pins[0].args, ['a2'], 'and only Leon is in it');
});

test('nobody going off air means no pin statement at all', async () => {
  // The ordinary tick. It must not cost a write to clear nothing.
  const { env, writes } = harness({ streams: [live('pelzio'), live('jfl__leon')] });
  await checkLive(env);
  assert.equal(writes.filter((w) => w.sql.includes('live_pin')).length, 0);
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

const workerSrc = () => readFileSync(
  fileURLToPath(new URL('../worker/src/index.mjs', import.meta.url)), 'utf8',
);

/** One function's body, from its declaration to the next one. */
const fnBody = (src, name) => {
  const at = src.indexOf(`async function ${name}(`);
  assert.notEqual(at, -1, `${name} exists`);
  const next = src.indexOf('\nasync function ', at + 1);
  const plain = src.indexOf('\nfunction ', at + 1);
  const ends = [next, plain].filter((i) => i > 0);
  return src.slice(at, ends.length ? Math.min(...ends) : src.length);
};

/** A Twitch that answers helix/users with whatever `users` says exists. */
function userHarness(users = []) {
  const calls = [];
  const env = {
    TWITCH_CLIENT_ID: 'id',
    TWITCH_CLIENT_SECRET: 'secret',
    DB: {
      prepare: () => ({
        bind: () => ({ async first() { return null; }, async run() { return {}; } }),
        async first() { return null; },
        async run() { return {}; },
      }),
    },
  };
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('id.twitch.tv')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 5e6 }) };
    }
    calls.push(new URL(href));
    const q = new URL(href).searchParams;
    const wantIds = new Set(q.getAll('id'));
    const wantLogins = new Set(q.getAll('login'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: users.filter((u) => wantIds.has(u.id) || wantLogins.has(u.login)),
      }),
    };
  };
  return { env, calls };
}

test('a whole board of channels is one request, not one each', async () => {
  /**
   * The reason /twitch sync can exist as a slash command at all. A Discord
   * interaction has three seconds; nine sequential lookups would not fit, and
   * seventy-five certainly would not.
   */
  const { env, calls } = userHarness([
    { id: '1', login: 'pelzio' },
    { id: '2', login: 'jfl__leon' },
    { id: '3', login: 'th3finalgamer' },
  ]);

  const out = await lookupChannels(env, {
    ids: ['1'],
    logins: ['jfl__leon', 'th3finalgamer'],
  });

  assert.equal(calls.length, 1, 'one call to helix/users');
  assert.deepEqual(calls[0].searchParams.getAll('id'), ['1']);
  assert.deepEqual(calls[0].searchParams.getAll('login'), ['jfl__leon', 'th3finalgamer']);
  assert.equal(out.byId.get('1').login, 'pelzio');
  assert.equal(out.byLogin.get('jfl__leon').id, '2');
});

test('a channel Twitch does not know is simply absent, not guessed at', async () => {
  /**
   * A typo, a deleted account and a suspended one all come back the same way:
   * not in the response. The sync reports them by name rather than writing
   * anything, because there is nothing true to write.
   */
  const { env } = userHarness([{ id: '1', login: 'pelzio' }]);
  const out = await lookupChannels(env, { logins: ['pelzio', 'nobodyhere'] });

  assert.ok(out.byLogin.has('pelzio'));
  assert.ok(!out.byLogin.has('nobodyhere'), 'no invented row');
  assert.equal(out.byLogin.size, 1);
});

test('a rename comes back under the id, with the new name on it', async () => {
  /**
   * The case nothing else on the board can see. The id is permanent, so the
   * panel keeps working; the login is not, so the live check quietly stops
   * finding them. Asking by id is what notices.
   */
  const { env } = userHarness([{ id: '9', login: 'newname' }]);
  const out = await lookupChannels(env, { ids: ['9'] });

  assert.equal(out.byId.get('9').login, 'newname', 'Twitch reports the current name');
});

test('no credentials means no request and no answer, not a crash', async () => {
  const { calls } = userHarness([{ id: '1', login: 'pelzio' }]);
  const out = await lookupChannels({ DB: {} }, { logins: ['pelzio'] });

  assert.equal(out.byLogin.size, 0);
  assert.equal(out.byId.size, 0);
  assert.equal(calls.length, 0, 'nothing was asked');
});

test('nothing to look up asks nothing', async () => {
  const { env, calls } = userHarness([]);
  const out = await lookupChannels(env, { ids: [], logins: [] });
  assert.equal(calls.length, 0);
  assert.equal(out.byId.size, 0);
});

test('the plain /twitch is still only ever about the caller', () => {
  /**
   * A member telling the board they stream is the consent step for everything
   * downstream, and that has not changed. What changed is that nine members who
   * HAD consented were broken: /twitch only started resolving the numeric
   * channel id when the panel needed one, so everybody who linked before that
   * had a working fast poll and a panel reading "Channel not linked".
   *
   * So a mod path exists now. This test guards the half that must not move: the
   * ordinary path, the one members run, still reads the caller and nothing else.
   */
  const fn = fnBody(workerSrc(), 'twitchSelf');
  assert.match(fn, /db\.memberByDiscordId\(env, userId\)/, 'it is always about the caller');
  assert.ok(!/isMod|permissions/.test(fn), 'and carries no permission gate to widen');
});

test('every mod path on /twitch is gated, and the gate is one definition', () => {
  const src = workerSrc();
  for (const name of ['twitchFor', 'twitchSync', 'twitchList']) {
    assert.match(
      fnBody(src, name),
      /if \(!isMod\(interaction\)\) return errorReply/,
      `${name} checks Manage Server before doing anything`,
    );
  }

  /**
   * ONE DEFINITION OF THE GATE. It was written out longhand inside unlink() and
   * copied here would have been the second copy; the third would have been the
   * one that drifted.
   */
  assert.equal(
    (src.match(/const isMod = /g) ?? []).length, 1,
    'isMod is defined exactly once',
  );
  assert.match(fnBody(src, 'unlink'), /isMod\(interaction\)/, 'unlink uses it too');
});

test('a mod cannot take a channel off one member and give it to another', () => {
  /**
   * Two rows holding one twitch_id makes memberByTwitchId pick whichever comes
   * back first, so a panel shows a stranger's trophies and nothing anywhere says
   * it is wrong. Refusing and naming the holder is the whole cost of never doing
   * that silently.
   */
  const fn = fnBody(workerSrc(), 'twitchFor');
  assert.match(fn, /db\.memberByTwitch\(env, login\)/, 'it checks who holds the channel');
  assert.match(
    fn,
    /taken && taken\.psn_account_id !== them\.psn_account_id[\s\S]{0,400}?return errorReply/,
    'and refuses rather than reassigning',
  );
});

test('the sync cannot hand one channel to two members either', () => {
  /**
   * The same invariant from the other direction. Nine unresolved logins go to
   * Twitch at once; if two of them come back as the same channel, or one matches
   * an id somebody already holds, filling both in would create the duplicate the
   * check above exists to prevent.
   */
  const fn = fnBody(workerSrc(), 'twitchSync');
  assert.match(fn, /claimed/, 'ids already spoken for are tracked');
  assert.match(fn, /claimed\.has\(hit\.id\)/, 'and a clash is detected');
  assert.match(fn, /clashed\.push/, 'and reported rather than written');
});

test('the sync asks by id where it has one, so a rename is noticed', () => {
  /**
   * A Twitch id is permanent and a login is not. Somebody who renames their
   * channel keeps working on the panel (which matches the id) and silently
   * vanishes from the live check (which matches the login). Asking Twitch what
   * the id is called NOW is the only thing that ever notices.
   */
  const fn = fnBody(workerSrc(), 'twitchSync');
  assert.match(fn, /ids: rows\.filter\(\(r\) => id\(r\)\)/, 'rows with an id are asked by id');
  assert.match(fn, /logins: rows\.filter\(\(r\) => !id\(r\)\)/, 'and only the rest by login');
  assert.match(fn, /renamed\.push/, 'a changed login is recorded');
});

test('the mod options are registered, and do not hide the command from members', () => {
  const cmds = readFileSync(
    fileURLToPath(new URL('../jobs/register-commands.mjs', import.meta.url)), 'utf8',
  );
  /**
   * COMMENTS STRIPPED FIRST. The comment explaining why
   * default_member_permissions is NOT used contains the phrase, so scanning the
   * raw text failed on its own explanation. Fourth time this session; every
   * guard that greps source has to read code rather than prose.
   */
  const block = cmds
    .slice(cmds.indexOf("name: 'twitch'"), cmds.indexOf("name: 'wishlist'"))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  for (const opt of ['member', 'sync', 'list']) {
    assert.ok(block.includes(`name: '${opt}'`), `${opt} is registered`);
  }

  /**
   * default_member_permissions is per COMMAND, not per option. Putting it on
   * /twitch to gate the three mod options would hide the whole command from the
   * members whose command it mostly is.
   */
  assert.ok(
    !block.includes('default_member_permissions'),
    'the command itself stays open to everybody',
  );
  assert.ok(
    block.split("name: 'channel'")[1].includes("required: false"),
    'and the members option is still optional, because bare is how you turn it off',
  );
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

// ------------------------------------------------------ the channel id ----

test('a live stream teaches us its channel id, for free', async () => {
  /**
   * `user_id` arrives in the same helix/streams response the live check already
   * reads, so a member who streams links their channel to the Twitch panel
   * without being asked and without an extra request.
   */
  const { env, writes } = harness({ streams: [live('pelzio', { user_id: '44322889' })] });
  await checkLive(env);

  const ids = writes.filter((w) => w.sql.includes('twitch_id = ?'));
  assert.equal(ids.length, 1, 'one write, for the one member whose id we learned');
  assert.deepEqual(ids[0].args, ['44322889', 'a1']);
});

test('an id we already hold is not written again', async () => {
  // Same rule as every other write in this function: only what actually moved.
  const known = [
    { psn_account_id: 'a1', twitch_login: 'pelzio', twitch_id: '44322889', live_since: 1000 },
  ];
  const { env, writes } = harness({
    members: known,
    streams: [live('pelzio', { user_id: '44322889' })],
  });
  await checkLive(env);

  assert.equal(
    writes.filter((w) => w.sql.includes('twitch_id = ?')).length,
    0,
    'nothing to learn, nothing written',
  );
});

test('a channel that changed hands is corrected', async () => {
  // Somebody renaming a channel onto a different id, or a login being reused.
  const stale = [
    { psn_account_id: 'a1', twitch_login: 'pelzio', twitch_id: 'old-id', live_since: 1000 },
  ];
  const { env, writes } = harness({
    members: stale,
    streams: [live('pelzio', { user_id: '44322889' })],
  });
  await checkLive(env);

  const ids = writes.filter((w) => w.sql.includes('twitch_id = ?'));
  assert.deepEqual(ids[0].args, ['44322889', 'a1']);
});

test('the id write sits outside the batch, like the pin clear', () => {
  /**
   * `twitch_id` arrives in migration 029 and a batch is all or nothing. Folded
   * into the writes above, a database that has not run it would lose the entire
   * live check rather than one id.
   */
  const src = readFileSync(
    fileURLToPath(new URL('../worker/src/twitch.mjs', import.meta.url)), 'utf8',
  );
  const after = src.slice(src.indexOf('await env.DB.batch(writes)'));
  assert.match(after, /twitch_id = \? WHERE psn_account_id/, 'written after the batch');
  assert.match(after.slice(after.indexOf('twitch_id')), /catch\(\(\) => \{\}\)/, 'and guarded');
});
