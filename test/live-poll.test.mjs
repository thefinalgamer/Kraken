import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { pollMember, POLL_EVERY_MS, CALLS_PER_MINUTE, BACKOFF_MS } from '../worker/src/live.mjs';

/**
 * The live poll.
 *
 * Almost every test here is about the poll NOT happening. One PSN account sits
 * behind every scan this project runs, and a loop with no floor under it is the
 * single bug in this system that could take the nightly update away from
 * seventy people to make a card appear eight seconds sooner for one.
 */

const MIN = 60000;
const NOW = Date.now();

const LIVE_MEMBER = {
  psn_account_id: 'acct-1',
  psn_online_id: 'JFL__Leon',
  live_since: NOW - 40 * MIN,
  live_checked_at: NOW - MIN,
  psn_polled_at: NOW - 60000,
};

/** A D1 and a PSN, both fake, both recording what they were asked. */
function harness({
  member = LIVE_MEMBER,
  state = {},
  known = [{ np_comm_id: 'NPWR_A', earned_total: 40 }],
  // What the board has priced for the game, straight out of `trophies`.
  priced = [{ trophy_id: 11, points: 22 }, { trophy_id: 12, points: 23 },
    { trophy_id: 13, points: 99 }],
  titles = [{
    npCommunicationId: 'NPWR_A',
    trophyTitleName: 'inFAMOUS 2',
    trophyTitlePlatform: 'PS3',
    earnedTrophies: { bronze: 30, silver: 8, gold: 4, platinum: 0 },
  }],
  trophies = [
    { trophyId: 11, earned: true, earnedDateTime: new Date(NOW - 30000).toISOString() },
    { trophyId: 12, earned: true, earnedDateTime: new Date(NOW - 5 * 3600000).toISOString() },
    { trophyId: 13, earned: false },
  ],
  rateLimit = false,
} = {}) {
  const writes = [];
  const calls = [];

  const env = {
    PSN_NPSSO: 'npsso',
    DB: {
      prepare(sql) {
        const stmt = {
          sql,
          args: [],
          bind(...a) { stmt.args = a; return stmt; },
          async first() {
            if (sql.includes('worker_state')) return state[stmt.args[0]] ?? null;
            return null;
          },
          async all() {
            // Two queries reach `all` now: the stored counts, and the prices
            // the poll sums to work out what the game has paid so far.
            if (sql.includes('FROM trophies')) return { results: priced };
            return { results: known };
          },
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

  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/authorize')) {
      return { status: 302, headers: new Headers({ location: 'x://redirect?code=abc' }) };
    }
    if (href.includes('/token')) {
      return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    }
    if (rateLimit) return { ok: false, status: 429, json: async () => ({}) };
    if (href.includes('trophyTitles')) {
      return { ok: true, status: 200, json: async () => ({ trophyTitles: titles }) };
    }
    return { ok: true, status: 200, json: async () => ({ trophies }) };
  };

  return { env, writes, calls, member };
}

const psnCalls = (calls) => calls.filter((c) => c.includes('m.np.playstation.com'));

test('a live member with a new trophy gets it written within seconds', async () => {
  const { env, writes, calls, member } = harness();
  const out = await pollMember(env, member);

  assert.match(out, /1 recent in inFAMOUS 2/);
  assert.equal(psnCalls(calls).length, 2, 'the cheap call, then one game');

  const inserts = writes.filter((w) => w.sql.includes('INSERT INTO member_trophies'));
  assert.equal(inserts.length, 1, 'only the trophy earned half a minute ago');
  assert.deepEqual(inserts[0].args.slice(0, 3), ['acct-1', 'NPWR_A', 11]);
});

test('an old trophy in the same game is left to the scan', async () => {
  /**
   * A first poll on somebody with years of history must not import their life
   * into the log, and a trophy from five hours ago is not news on a stream.
   */
  const { env, writes } = harness();
  await pollMember(env, LIVE_MEMBER);
  // Scoped to the INSERT: the sweep that marks on_stream also mentions this
  // table, and counting it here made this read like the filter had broken.
  const ids = writes
    .filter((w) => w.sql.includes('INSERT INTO member_trophies'))
    .map((w) => w.args[2]);
  assert.deepEqual(ids, [11], 'the five hour old one is not written');
});

test('somebody who is not streaming is never polled', async () => {
  // The whole point of the Twitch check: a browser source left open on a spare
  // monitor for a fortnight must cost nothing.
  const { env, calls } = harness();
  const off = { ...LIVE_MEMBER, live_since: null };
  assert.equal(await pollMember(env, off), 'poll: not live');
  assert.deepEqual(psnCalls(calls), []);
});

test('a live answer nobody has confirmed lately does not count as live', async () => {
  const { env, calls } = harness();
  const stale = { ...LIVE_MEMBER, live_checked_at: NOW - 60 * MIN };
  assert.equal(await pollMember(env, stale), 'poll: not live');
  assert.deepEqual(psnCalls(calls), []);
});

test('ten seconds between looks, whatever the page does', async () => {
  /**
   * The overlay refreshes every ten seconds and OBS can be told to refresh
   * whenever it likes. The floor lives in the database because a Worker has no
   * memory between requests.
   */
  const { env, calls } = harness();
  const justNow = { ...LIVE_MEMBER, psn_polled_at: NOW - 2000 };
  assert.equal(await pollMember(env, justNow), 'poll: too soon');
  assert.deepEqual(psnCalls(calls), []);
  assert.ok(POLL_EVERY_MS >= 10000, 'and the floor is not lower than the refresh');
});

test('the clock is stamped before the work, not after', async () => {
  /**
   * Two requests landing in the same second would otherwise both read the old
   * timestamp, both decide they were allowed, and both call PSN.
   */
  const { env, writes } = harness();
  await pollMember(env, LIVE_MEMBER);
  const stamp = writes.findIndex((w) => w.sql.includes('psn_polled_at'));
  const insert = writes.findIndex((w) => w.sql.includes('member_trophies'));
  assert.ok(stamp >= 0 && (insert === -1 || stamp < insert), 'stamped first');
});

test('the board has a ceiling for the whole minute, not per person', async () => {
  const { env, calls } = harness({
    state: { psn_budget: { value: String(CALLS_PER_MINUTE), expires_at: NOW + 30000 } },
  });
  assert.equal(await pollMember(env, LIVE_MEMBER), 'poll: budget spent');
  assert.deepEqual(psnCalls(calls), []);
});

test('a spent budget from a minute ago is not a spent budget', async () => {
  const { env } = harness({
    state: { psn_budget: { value: '999', expires_at: NOW - 1000 } },
  });
  assert.match(await pollMember(env, LIVE_MEMBER), /recent in/, 'the counter resets itself');
});

test('a 429 stops the feature for everybody, not just the person who caused it', async () => {
  /**
   * The limit is on the account and the account is the board's. Fifteen minutes
   * of no live pops costs nothing next to a scan that cannot run tonight.
   */
  const { env, writes } = harness({ rateLimit: true });
  assert.match(await pollMember(env, LIVE_MEMBER), /rate limited, everything paused/);

  const stop = writes.find((w) => w.args[0] === 'psn_backoff');
  assert.ok(stop, 'the stop is written');
  assert.ok(stop.args[2] - Date.now() > BACKOFF_MS - 5000, 'for a quarter of an hour');
});

test('while backed off, nothing is polled at all', async () => {
  const { env, calls } = harness({
    state: { psn_backoff: { value: 'rate limited', expires_at: NOW + 5 * MIN } },
  });
  assert.equal(await pollMember(env, LIVE_MEMBER), 'poll: backed off');
  assert.deepEqual(psnCalls(calls), []);
});

test('no credential means the feature simply does not exist', async () => {
  const { env, calls } = harness();
  delete env.PSN_NPSSO;
  assert.equal(await pollMember(env, LIVE_MEMBER), 'poll: no credential');
  assert.deepEqual(calls, []);
});

test('a game whose count has not moved costs one call, not two', async () => {
  // The cheap call carries the earned counts, which is the whole reason it is
  // the first one. Fetching a trophy list to discover nothing happened would
  // double the cost of every quiet ten seconds.
  const { env, calls } = harness({
    known: [{ np_comm_id: 'NPWR_A', earned_total: 42 }],
  });
  assert.equal(await pollMember(env, LIVE_MEMBER), 'poll: nothing new');
  assert.equal(psnCalls(calls).length, 1);
});

test('the write cannot fight the scan for the same row', async () => {
  /**
   * The nightly scan writes this table from the other direction, on a different
   * machine, so the two must never need to coordinate.
   *
   * It was INSERT OR IGNORE, which was fine until the on_stream flag existed:
   * if the scan happened to write the row first, the row would be correct and
   * the flag would be missing forever, and this is the only code that knows
   * anybody was watching. ON CONFLICT keeps the collision harmless AND sets the
   * flag either way.
   */
  const { env, writes } = harness();
  await pollMember(env, LIVE_MEMBER);
  const insert = writes.find((w) => w.sql.includes('INSERT INTO member_trophies'));
  assert.match(insert.sql, /ON CONFLICT\(psn_account_id, np_comm_id, trophy_id\)/);
  assert.match(insert.sql, /DO UPDATE SET on_stream = 1/);
});

test('only the poll can say a trophy was earned on air', async () => {
  // The scan writes the same table and has no idea whether anybody was
  // watching, so it must never set this flag.
  const scan = readFileSync(
    fileURLToPath(new URL('../jobs/scan.mjs', import.meta.url)), 'utf8',
  );
  assert.ok(!/on_stream/.test(scan), 'the scan does not touch it');

  const live = readFileSync(
    fileURLToPath(new URL('../worker/src/live.mjs', import.meta.url)), 'utf8',
  );
  assert.match(live, /on_stream/, 'and the poll is where it comes from');
});

test('the doorbell is fire and forget, and the brakes are on the far side', () => {
  /**
   * The overlay rings the Worker and does not wait: a page that waited on Sony
   * would be a browser source that goes blank whenever Sony is slow. The
   * endpoint has no authentication, which is safe precisely because it does
   * nothing at all unless the member is live and the clock allows it.
   */
  const src = readFileSync(
    fileURLToPath(new URL('../worker/src/index.mjs', import.meta.url)), 'utf8',
  );
  const route = src.slice(src.indexOf("if (path.startsWith('/poll/'))"), src.indexOf("if (path.startsWith('/poll/')) ") + 1200);
  assert.match(route, /ctx\.waitUntil\(/, 'the work outlives the response');
  assert.match(route, /pollMember\(env, m\)/);

  const pop = readFileSync(
    fileURLToPath(new URL('../functions/overlay/[name]/pop.js', import.meta.url)), 'utf8',
  );
  assert.match(pop, /waitUntil\(\s*fetch\(`\$\{worker\}\/poll\//, 'the page never awaits it');
  assert.match(pop, /const REFRESH = 10;/, 'and the heartbeat is ten seconds');

  /**
   * PAGES AND THE WORKER HAVE DIFFERENT ENVIRONMENTS. WORKER_BASE_URL is
   * declared in wrangler.toml, which configures the Worker; this file runs on
   * Pages and never sees it, so in production it was undefined and the
   * doorbell rang nowhere. The address is public, so it defaults in code
   * rather than becoming another thing to set in another dashboard.
   */
  assert.match(pop, /env\.WORKER_BASE_URL \|\| 'https:\/\//, 'it has an address without being told one');
});


test('everything earned since they went live gets marked, however it arrived', async () => {
  /**
   * THE BUG THIS EXISTS FOR. The flag was set only on rows the poll inserted
   * itself, which missed almost everything: trophies the nightly scan wrote
   * when an update ran, trophies earned in the first minutes before the poll
   * noticed, anything outside the twenty minute window. Leon streamed a whole
   * session of 2XKO and not one trophy came out purple.
   *
   * `live_since` is Twitch's own stream start, so "since they went live" is not
   * a guess, and running it on every poll means it heals rather than depending
   * on catching the moment.
   */
  const { env, writes } = harness();
  await pollMember(env, LIVE_MEMBER);

  const sweep = writes.find((w) => w.sql.includes('UPDATE member_trophies SET on_stream'));
  assert.ok(sweep, 'the sweep runs');
  assert.deepEqual(sweep.args, ['acct-1', LIVE_MEMBER.live_since], 'this member, this stream');
  assert.match(sweep.sql, /COALESCE\(on_stream, 0\) = 0/, 'and it leaves marked rows alone');
});

test('the sweep runs even on a quiet look, not only when a trophy lands', async () => {
  // A trophy written by the scan mid stream would otherwise wait for the member
  // to earn another one before anything noticed it.
  const { env, writes } = harness({ known: [{ np_comm_id: 'NPWR_A', earned_total: 42 }] });
  assert.equal(await pollMember(env, LIVE_MEMBER), 'poll: nothing new');
  assert.ok(
    writes.some((w) => w.sql.includes('UPDATE member_trophies SET on_stream')),
    'still swept',
  );
});

test('the poll prices the game so the overlay points move with the trophies', async () => {
  /**
   * THE BUG, in Martin's words: Leon earned two trophies on stream, "he was at
   * 245/295 pts but it stuck he waited 10 mins and then had to do /update".
   * The counts and the bar were live, the points were not, and nothing on the
   * bar said so.
   *
   * A LOOKUP, NOT A CALCULATION. The scan prices a game as a plain sum of
   * `trophies.points` over the trophies held. This sums the same column over
   * the same set, so it lands on the number the scan would and invents nothing.
   */
  const { env, writes } = harness();
  await pollMember(env, LIVE_MEMBER);

  const plays = writes.filter((w) => w.sql.includes('live_play'));
  const last = JSON.parse(plays[plays.length - 1].args[0]);
  // 11 and 12 are held at 22 and 23; 13 is not earned and must not be counted.
  assert.equal(last.points, 45, 'priced from the same column the scan uses');

  assert.ok(
    !writes.some((w) => /UPDATE member_games|INTO member_games/.test(w.sql)),
    'and member_games is still never written, which is the rule that protects the score',
  );
});

test('an unpriced game keeps the scan figure rather than showing a confident zero', async () => {
  // A title nobody here has ever scanned has no rows in `trophies`. A bar
  // reading 0 / 0 would be worse than one reading a stale but real number.
  const { env, writes } = harness({ priced: [] });
  await pollMember(env, LIVE_MEMBER);

  const plays = writes.filter((w) => w.sql.includes('live_play'));
  const last = JSON.parse(plays[plays.length - 1].args[0]);
  assert.equal(last.points, null, 'nothing claimed about a game nobody has scanned');
});

test('a poll that finds nothing new keeps the points it already worked out', async () => {
  /**
   * The live note is rewritten every ten seconds and only the counts are cheap
   * enough to recompute that often. Without carrying the figure forward, the
   * first quiet poll would blank it and the bar would flick back to the scan's
   * number a few seconds after showing the right one.
   */
  const { env, writes } = harness({
    known: [{ np_comm_id: 'NPWR_A', earned_total: 42 }],
    member: { ...LIVE_MEMBER, live_play: JSON.stringify({ id: 'NPWR_A', points: 45 }) },
  });
  await pollMember(env, { ...LIVE_MEMBER, live_play: JSON.stringify({ id: 'NPWR_A', points: 45 }) });

  const plays = writes.filter((w) => w.sql.includes('live_play'));
  assert.equal(JSON.parse(plays[0].args[0]).points, 45, 'carried, not blanked');
});

test('changing game does not carry the last game points across', async () => {
  const { env, writes } = harness();
  await pollMember(env, {
    ...LIVE_MEMBER,
    live_play: JSON.stringify({ id: 'NPWR_SOMETHING_ELSE', points: 9999 }),
  });

  const plays = writes.filter((w) => w.sql.includes('live_play'));
  assert.notEqual(JSON.parse(plays[0].args[0]).points, 9999, 'a clean slate for a new game');
});
