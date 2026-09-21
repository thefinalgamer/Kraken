import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GOAL_KINDS, MAX_ACTIVE_GOALS, parseDeadline, goalProblem, goalStatus, goalSettlement,
  goalTitle, fmt, rate,
} from '../shared/goals.mjs';
import { settleGoals } from '../jobs/lib/goals.mjs';
import { bodyOf } from './helpers.mjs';

/**
 * PERSONAL GOALS. /goal in Discord, cards on the hunter page.
 *
 * Asked for by PrimalxFear on 8 September: "im close to 200k, and set that as a
 * goal for end of month... or set completion rate goal till end of year".
 * Martin, 21 September: everybody can see everybody's.
 *
 * The rules live in shared/goals.mjs and are shared by the bot, the page and
 * the jobs, so most of what is checked here is that they agree: the bot must
 * never congratulate somebody the page still says is short.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 21, 12); // 21 September 2026, midday

const PRIMAL = {
  psn_account_id: 'acc-primal', psn_online_id: 'PrimalxFear', discord_id: 'd-primal',
  points: 197760, completion: 76.55, platinum: 728, gold: 3000, silver: 5000, bronze: 12000,
  completed: 690, last_update_at: NOW - DAY,
};

const goal = (over = {}) => ({
  id: 1, kind: 'points', target: 200000, start_value: 184120,
  created_at: NOW - 20 * DAY, deadline_at: NOW + 9 * DAY,
  reached_at: null, ended_at: null, final_value: null, ...over,
});

// ------------------------------------------------------------- the dates ---

test('dates are read in UK order, because the server is British', () => {
  // 1/10/2026 is the first of October to everybody here, not the tenth of January.
  const at = parseDeadline('1/10/2026');
  assert.equal(new Date(at).getUTCMonth(), 9, 'October');
  assert.equal(new Date(at).getUTCDate(), 1);
});

test('a deadline means the END of the day named, so "by the 30th" includes the 30th', () => {
  const at = parseDeadline('30/09/2026');
  assert.equal(at, Date.UTC(2026, 8, 30) + DAY - 1);
});

test('ISO dates and two-digit years work too', () => {
  assert.equal(parseDeadline('2026-12-31'), parseDeadline('31/12/2026'));
  assert.equal(parseDeadline('31/12/26'), parseDeadline('31/12/2026'));
  assert.equal(parseDeadline('31.12.2026'), parseDeadline('31/12/2026'));
});

test('a date that does not exist is refused, not rolled into the next month', () => {
  // JavaScript left to itself turns 31 February into 3 March.
  assert.equal(parseDeadline('31/02/2027'), null);
  assert.equal(parseDeadline('end of month'), null);
  assert.equal(parseDeadline(''), null);
});

// ------------------------------------------------------ setting a goal ---

test('a goal has to be somewhere you have not got to yet', () => {
  // Otherwise the next scan would post "hit their goal" for doing nothing.
  const msg = goalProblem({ kind: 'platinum', target: 700, deadline: null, member: PRIMAL, now: NOW });
  assert.match(msg, /already on \*\*728\*\*/);
  assert.equal(goalProblem({ kind: 'platinum', target: 1000, deadline: null, member: PRIMAL, now: NOW }), null);
});

test('completion cannot go past 100, and counts must be whole numbers', () => {
  assert.match(goalProblem({ kind: 'completion', target: 101, member: PRIMAL, now: NOW }), /up to 100/);
  assert.equal(goalProblem({ kind: 'completion', target: 80.5, member: PRIMAL, now: NOW }), null);
  assert.match(goalProblem({ kind: 'platinum', target: 800.5, member: PRIMAL, now: NOW }), /whole number/);
});

test('the date has to be in the future and within five years', () => {
  const base = { kind: 'points', target: 250000, member: PRIMAL, now: NOW };
  assert.match(goalProblem({ ...base, deadline: NOW - DAY }), /already gone/);
  assert.match(goalProblem({ ...base, deadline: NOW + 6 * 365 * DAY }), /five years/);
  assert.equal(goalProblem({ ...base, deadline: NOW + 30 * DAY }), null);
  assert.equal(goalProblem({ ...base, deadline: null }), null, 'no date is fine');
});

test('an unknown kind is refused rather than stored', () => {
  assert.match(goalProblem({ kind: 'vibes', target: 10, member: PRIMAL, now: NOW }), /Pick what the goal is for/);
});

test('every kind reads a column the members row already has', () => {
  // Nothing about a goal needs a new number, which is why it costs no PSN calls.
  assert.deepEqual(Object.keys(GOAL_KINDS).sort(),
    ['completed', 'completion', 'platinum', 'points', 'trophies']);
  assert.equal(GOAL_KINDS.trophies.value(PRIMAL), 728 + 3000 + 5000 + 12000);
  assert.equal(GOAL_KINDS.completed.value(PRIMAL), 690);
});

// ------------------------------------------------------ reading a goal ---

test('progress is measured from where they started, not from zero', () => {
  // 197,760 of 200,000 is 98.9% and says nothing. 13,640 of the 15,880 they set
  // out to gain is 86%, which is the number worth watching.
  const s = goalStatus(goal(), PRIMAL, NOW);
  assert.equal(s.state, 'active');
  assert.equal(Math.floor(s.percent), 85);
  assert.equal(s.remaining, 2240);
  assert.equal(s.daysLeft, 9);
});

test('going backwards sits the bar at zero rather than below it', () => {
  // Points re-price overnight and completion drops when you start a game.
  const s = goalStatus(goal({ start_value: 199000 }), { ...PRIMAL, points: 198000 }, NOW);
  assert.equal(s.percent, 0);
});

test('the pace compares what they need per day with what they have actually done', () => {
  // 13,640 in 20 days is 682 a day. 2,240 in 9 days needs 249. On pace.
  assert.equal(goalStatus(goal(), PRIMAL, NOW).pace, 'on');
  // Same target, only 100 points gained in 20 days: behind.
  assert.equal(goalStatus(goal({ start_value: 197660 }), PRIMAL, NOW).pace, 'behind');
});

test('no pace judgement in the first day, and none without a deadline', () => {
  assert.equal(goalStatus(goal({ created_at: NOW - 3_600_000 }), PRIMAL, NOW).pace, null);
  assert.equal(goalStatus(goal({ deadline_at: null }), PRIMAL, NOW).pace, null);
});

test('a goal the live number has passed reads as reached before any job has run', () => {
  // The page and the bot must agree, even in the gap before the next rescore.
  assert.equal(goalStatus(goal({ target: 190000 }), PRIMAL, NOW).state, 'reached');
});

test('a finished goal keeps the number it finished on', () => {
  const s = goalStatus(goal({ ended_at: NOW - DAY, final_value: 199100 }), { ...PRIMAL, points: 250000 }, NOW);
  assert.equal(s.state, 'missed');
  assert.equal(s.current, 199100, 'not whatever the row says months later');
});

test('titles and numbers are written the way the site writes them', () => {
  assert.equal(goalTitle({ kind: 'points', target: 200000 }), '200,000 points');
  assert.equal(goalTitle({ kind: 'completion', target: 80 }), '80.00% completion');
  assert.equal(fmt('completion', 76.559), '76.55', 'floored, like every percentage here');
  assert.equal(rate(0.534), '0.53');
  assert.equal(rate(248.9), '249');
});

// ---------------------------------------------------- settling a goal ---

test('settlement: reached, missed, or nothing to do', () => {
  assert.deepEqual(goalSettlement(goal({ target: 190000 }), PRIMAL, NOW),
    { reached: true, value: 197760, at: NOW });
  assert.deepEqual(goalSettlement(goal({ deadline_at: NOW - 1 }), PRIMAL, NOW),
    { reached: false, value: 197760, at: NOW });
  assert.equal(goalSettlement(goal(), PRIMAL, NOW), null);
  assert.equal(goalSettlement(goal({ target: 1, reached_at: NOW - DAY }), PRIMAL, NOW), null,
    'an already-settled goal is never settled twice, or it would be posted twice');
});

/** A stand-in for the jobs' D1 REST client. */
const jobDb = (rows, { fail = null } = {}) => {
  const runs = [];
  const queries = [];
  return {
    runs,
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (fail) throw new Error(fail);
      return rows;
    },
    async run(sql, params) { runs.push({ sql, params }); },
  };
};

test('the job marks reached goals, freezes missed ones, and returns only the reached', async () => {
  const hit = { ...goal({ id: 7, target: 190000 }), ...PRIMAL };
  const miss = { ...goal({ id: 8, deadline_at: NOW - 1 }), ...PRIMAL };
  const going = { ...goal({ id: 9 }), ...PRIMAL };
  const db = jobDb([hit, miss, going]);

  const reached = await settleGoals(db, { now: NOW });
  assert.deepEqual(reached.map((g) => g.id), [7], 'a miss is never announced');
  assert.equal(db.runs.length, 2);
  assert.match(db.runs[0].sql, /SET reached_at/);
  assert.deepEqual(db.runs[0].params, [NOW, 197760, 7]);
  assert.match(db.runs[1].sql, /SET ended_at/);
  // Guarded, so two jobs racing cannot settle one goal twice.
  for (const r of db.runs) assert.match(r.sql, /reached_at IS NULL AND ended_at IS NULL/);
});

test('a scan settles only the member it scanned', async () => {
  const db = jobDb([]);
  await settleGoals(db, { accountId: 'acc-primal', now: NOW });
  assert.match(db.queries[0].sql, /g\.psn_account_id = \?/);
  assert.deepEqual(db.queries[0].params, ['acc-primal']);
});

test('no goals table is no goals, never a failed scan', async () => {
  assert.deepEqual(await settleGoals(jobDb([], { fail: 'D1 query failed (400): no such table: goals' })), []);
  await assert.rejects(settleGoals(jobDb([], { fail: 'D1 query failed (500): boom' })), /boom/);
});

test('the channel post names the hunter, the goal, and how long it took', async () => {
  process.env.DISCORD_UPDATES_CHANNEL_ID = 'chan-updates';
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const { postGoalsReached } = await import('../jobs/lib/discord.mjs');
    await postGoalsReached([{
      psn_online_id: 'PrimalxFear', kind: 'points', target: 200000, start_value: 184120,
      final_value: 200310, created_at: NOW - 25 * DAY, reached_at: NOW, deadline_at: NOW + 5 * DAY,
    }]);
    await postGoalsReached([]);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1, 'one post, and nothing at all when nobody hit anything');
  assert.match(sent[0].url, /chan-updates/);
  const words = JSON.stringify(sent[0].body);
  assert.match(words, /PrimalxFear\*\* hit their goal: \*\*200,000 points/);
  assert.match(words, /in 25 days, with 5 days to spare/);
  assert.ok(!/<@/.test(words), 'a name, not a ping: the rescore runs at three in the morning');
});

// -------------------------------------------------------- the bot, /goal ---

const worker = (await import('../worker/src/index.mjs')).default;

const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PUBLIC_HEX = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex');

/** A goals table in memory, and a members table of one. */
const botEnv = (member = PRIMAL, { goals = [], missingTable = false } = {}) => {
  const store = goals.map((g) => ({ ...g }));
  let nextId = 100;
  const miss = () => { throw new Error('D1_ERROR: no such table: goals'); };
  return {
    store,
    env: {
      DISCORD_PUBLIC_KEY: PUBLIC_HEX,
      DB: {
        prepare(sql) {
          let args = [];
          const stmt = {
            bind(...a) { args = a; return stmt; },
            async first() {
              if (sql.includes('FROM members WHERE discord_id')) return member;
              return null;
            },
            async all() {
              if (sql.includes('FROM goals')) {
                if (missingTable) miss();
                return { results: store.filter((g) => g.psn_account_id === args[0]) };
              }
              return { results: [] };
            },
            async run() {
              if (sql.startsWith('INSERT INTO goals')) {
                if (missingTable) miss();
                const [psn_account_id, kind, target, start_value, created_at, deadline_at] = args;
                store.push({ id: nextId++, psn_account_id, kind, target, start_value, created_at, deadline_at,
                  reached_at: null, ended_at: null, final_value: null });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith('DELETE FROM goals')) {
                const i = store.findIndex((g) => g.psn_account_id === args[0] && g.id === args[1]);
                if (i >= 0) store.splice(i, 1);
                return { meta: { changes: i >= 0 ? 1 : 0 } };
              }
              return { meta: { changes: 0 } };
            },
          };
          return stmt;
        },
      },
    },
  };
};

const call = async (env, options = [], type = 2) => {
  const body = JSON.stringify({
    type,
    data: { name: 'goal', options },
    member: { user: { id: 'd-primal' } },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = Buffer.from(
    await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + body)),
  ).toString('hex');
  const res = await worker.fetch(
    new Request('https://kraken.test/', {
      method: 'POST', body,
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': timestamp },
    }),
    env,
    { waitUntil() {} },
  );
  return res.json();
};

/** Every piece of text in a components-v2 reply, joined. */
const textOf = (reply) => JSON.stringify(reply.data ?? reply);

test('/goal sets a goal, starting from the number they are on right now', async () => {
  const { env, store } = botEnv();
  const reply = await call(env, [
    { name: 'for', value: 'points' }, { name: 'target', value: 200000 }, { name: 'by', value: '31/12/2030' },
  ]);
  assert.equal(store.length, 1);
  assert.equal(store[0].start_value, 197760, 'the start is the live row, not zero');
  assert.equal(store[0].deadline_at, parseDeadline('31/12/2030'));
  assert.match(textOf(reply), /Goal set: 200,000 points/);
  assert.match(textOf(reply), /2,240 points\*\* to go/);
});

test('/goal refuses a target they have already passed, and saves nothing', async () => {
  const { env, store } = botEnv();
  const reply = await call(env, [{ name: 'for', value: 'platinum' }, { name: 'target', value: 500 }]);
  assert.equal(store.length, 0);
  assert.match(textOf(reply), /already on/);
});

test('/goal refuses a date it cannot read, rather than setting one with no date', async () => {
  const { env, store } = botEnv();
  const reply = await call(env, [
    { name: 'for', value: 'points' }, { name: 'target', value: 250000 }, { name: 'by', value: 'next month' },
  ]);
  assert.equal(store.length, 0);
  assert.match(textOf(reply), /did not make sense/);
});

test('/goal caps how many can run at once', async () => {
  const goals = Array.from({ length: MAX_ACTIVE_GOALS }, (_, i) =>
    goal({ id: i + 1, psn_account_id: 'acc-primal', target: 300000 + i, deadline_at: null }));
  const { env, store } = botEnv(PRIMAL, { goals });
  const reply = await call(env, [{ name: 'for', value: 'points' }, { name: 'target', value: 400000 }]);
  assert.equal(store.length, MAX_ACTIVE_GOALS);
  assert.match(textOf(reply), /the most at once/);
});

test('/goal remove only removes their own', async () => {
  const mine = goal({ id: 5, psn_account_id: 'acc-primal' });
  const theirs = goal({ id: 6, psn_account_id: 'acc-someone-else' });
  const { env, store } = botEnv(PRIMAL, { goals: [mine, theirs] });

  const refused = await call(env, [{ name: 'remove', value: '6' }]);
  assert.match(textOf(refused), /not one of yours/);
  assert.equal(store.length, 2);

  await call(env, [{ name: 'remove', value: '5' }]);
  assert.deepEqual(store.map((g) => g.id), [6]);
});

test('/goal on its own lists them, with how far through each one is', async () => {
  const { env } = botEnv(PRIMAL, { goals: [goal({ psn_account_id: 'acc-primal', created_at: Date.now() - 20 * DAY, deadline_at: Date.now() + 9 * DAY })] });
  const reply = await call(env);
  assert.match(textOf(reply), /Your goals/);
  assert.match(textOf(reply), /200,000 points/);
  assert.match(textOf(reply), /2,240 points to go/);
});

test('a database without migration 037 gets a sentence, not SQLite', async () => {
  const { env } = botEnv(PRIMAL, { missingTable: true });
  const reply = await call(env, [{ name: 'for', value: 'points' }, { name: 'target', value: 250000 }]);
  assert.match(textOf(reply), /037-goals\.sql/);
});

test('the remove picker offers their goals and nothing else', async () => {
  const { env } = botEnv(PRIMAL, { goals: [goal({ id: 5, psn_account_id: 'acc-primal' })] });
  const reply = await call(env, [{ name: 'remove', value: '', focused: true }], 4);
  assert.deepEqual(reply.data.choices.map((c) => c.value), ['5']);
  assert.match(reply.data.choices[0].name, /200,000 points/);
});

// --------------------------------------------------------- the hunter page ---

const hunter = await import('../functions/hunter/[name].js');

const pageEnv = (goals) => ({
  DB: {
    prepare(sql) {
      const answer = () => {
        if (sql.includes('FROM goals')) {
          return {
            all: async () => {
              if (goals === null) throw new Error('D1_ERROR: no such table: goals');
              return { results: goals };
            },
          };
        }
        if (sql.includes('FROM members')) {
          if (sql.includes('COUNT(*)')) return { first: async () => ({ c: 75 }) };
          if (sql.includes('ORDER BY rank ASC')) return { all: async () => ({ results: [] }) };
          const m = { ...PRIMAL, rank: 5, prev_rank: 5, projects: 800, reported_points: PRIMAL.points,
            country: 'GB', avatar_url: null, supporter_months: 0, rivals: null };
          if (!sql.includes('rivals')) return { first: async () => null, all: async () => ({ results: [] }) };
          return { first: async () => m, all: async () => ({ results: [m] }) };
        }
        return { first: async () => null, all: async () => ({ results: [] }) };
      };
      return { ...answer(), bind: () => answer() };
    },
  },
});

const render = async (goals, path = '/hunter/PrimalxFear') => {
  const res = await hunter.onRequestGet({
    params: { name: 'PrimalxFear' }, env: pageEnv(goals), request: new Request(`https://x.test${path}`),
  });
  return { status: res.status, body: bodyOf(await res.text()) };
};

test('the goals panel sits beside rivals, with a card per goal', async () => {
  const { status, body } = await render([
    goal({ id: 1, created_at: Date.now() - 20 * DAY, deadline_at: Date.now() + 9 * DAY }),
    goal({ id: 2, kind: 'platinum', target: 700, start_value: 655, reached_at: Date.now() - 5 * DAY, final_value: 700 }),
  ]);
  assert.equal(status, 200);
  assert.match(body, /<details class="numbers rivals goals">/);
  assert.match(body, /<summary>Goals<span class="soon-tag">1 running<\/span>/);
  assert.match(body, /200,000 points/);
  assert.match(body, /Current <b>197,760<\/b>/);
  assert.match(body, /class="goal reached"/);
  assert.match(body, />Finished</, 'finished goals get their own heading');
  const toolrow = body.slice(body.indexOf('<div class="toolrow">'));
  assert.ok(toolrow.indexOf('Rivals') < toolrow.indexOf('Goals'), 'right next to rivals');
});

test('an empty panel teaches the command, the way the rivals one does', async () => {
  const { body } = await render([]);
  assert.match(body, /none yet/);
  assert.match(body, /<code>\/goal<\/code> in Discord/);
});

test('no goals table costs the panel, never the page', async () => {
  const { status, body } = await render(null);
  assert.equal(status, 200);
  assert.ok(!/class="numbers rivals goals"/.test(body));
});

test('goals are on the first page only, like rivals', async () => {
  const { body } = await render([goal()], '/hunter/PrimalxFear?page=2');
  assert.ok(!/class="numbers rivals goals"/.test(body), 'page 2 must not claim they have no goals');
});

test('goal titles are escaped like everything else from the database', async () => {
  // Kinds come from a fixed list, so an unknown one renders nothing at all.
  const { body } = await render([goal({ kind: '<script>' })]);
  assert.ok(!body.includes('<script>'));
});
