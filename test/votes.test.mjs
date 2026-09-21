import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { tally, parseOptions, voterId, FINISHABLE_SQL, VOTE_SOURCES } from '../shared/votes.mjs';
import { verifyExtensionToken, signExtensionToken } from '../functions/_lib/twitch-jwt.js';

/**
 * VOTES. The streamer opens one with /vote start in Discord, viewers vote on
 * the Twitch panel, the streamer closes it with /vote end.
 *
 * Agreed with Martin on 21 September. The rules checked here are the ones he
 * set: three sources, no broken games in backlog or random, no timer, results
 * hidden until you have voted, one vote each that cannot be changed, and the
 * winner NOT put on the overlay by itself.
 */

// ------------------------------------------------------------ the rules ---

test('a tally lists every option, most votes first, zeros included', () => {
  const t = tally(['a', 'b', 'c'], [{ np_comm_id: 'b', n: 3 }, { np_comm_id: 'a', n: 1 }]);
  assert.deepEqual(t.rows.map((r) => [r.id, r.votes, r.percent]), [['b', 3, 75], ['a', 1, 25], ['c', 0, 0]]);
  assert.equal(t.total, 4);
  assert.equal(t.winner, 'b');
});

test('a tie is reported as a tie, not settled by a hidden rule', () => {
  // Picking one by list order or first voter would be the bot deciding
  // something chat did not.
  const t = tally(['a', 'b', 'c'], [{ np_comm_id: 'a', n: 2 }, { np_comm_id: 'c', n: 2 }]);
  assert.equal(t.winner, null);
  assert.deepEqual(t.tied, ['a', 'c']);
});

test('no votes means no winner and no tie', () => {
  const t = tally(['a', 'b'], []);
  assert.equal(t.winner, null);
  assert.deepEqual(t.tied, []);
  assert.equal(t.total, 0);
});

test('a broken options column is an empty ballot, never a crash', () => {
  assert.deepEqual(parseOptions('not json'), []);
  assert.deepEqual(parseOptions('{"a":1}'), []);
  assert.deepEqual(parseOptions('["NPWR1", 5, ""]'), ['NPWR1']);
});

test('only logged-in viewers can vote', () => {
  // "A" ids change every visit, so letting them vote is one vote per refresh.
  assert.equal(voterId('U12345abc'), 'U12345abc');
  assert.equal(voterId('A98765'), null);
  assert.equal(voterId(''), null);
  assert.equal(voterId('U12; DROP TABLE'), null);
});

test('"finishable" rules out the game flag AND any flagged trophy', () => {
  assert.match(FINISHABLE_SQL, /COALESCE\(g\.unobtainable, 0\) = 0/);
  assert.match(FINISHABLE_SQL, /NOT EXISTS \(SELECT 1 FROM trophies t/);
});

test('the three sources Martin asked for, and only those', () => {
  assert.deepEqual(Object.keys(VOTE_SOURCES), ['list', 'backlog', 'random']);
});

// ------------------------------------------------------- the Twitch token ---

const SECRET = Buffer.from('a test secret that is not the real one').toString('base64');
const future = () => Math.floor(Date.now() / 1000) + 3600;

test('a genuine token is read', async () => {
  const token = await signExtensionToken(
    { channel_id: '123', opaque_user_id: 'Uabc', role: 'viewer', exp: future() }, SECRET);
  const claims = await verifyExtensionToken(token, SECRET);
  assert.equal(claims.channel_id, '123');
  assert.equal(claims.opaque_user_id, 'Uabc');
});

test('a token signed with anything else is refused', async () => {
  const other = Buffer.from('somebody else').toString('base64');
  const token = await signExtensionToken({ channel_id: '123', exp: future() }, other);
  assert.equal(await verifyExtensionToken(token, SECRET), null);
});

test('an expired token is refused', async () => {
  const token = await signExtensionToken({ channel_id: '123', exp: 1000 }, SECRET);
  assert.equal(await verifyExtensionToken(token, SECRET), null);
});

test('a token that swaps the channel after signing is refused', async () => {
  const token = await signExtensionToken({ channel_id: '123', exp: future() }, SECRET);
  const [h, , sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ channel_id: '999', exp: future() })).toString('base64url');
  assert.equal(await verifyExtensionToken(`${h}.${forged}.${sig}`, SECRET), null);
});

test('"alg: none" and other algorithms are refused, not obeyed', async () => {
  const h = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ channel_id: '123', exp: future() })).toString('base64url');
  assert.equal(await verifyExtensionToken(`${h}.${p}.`, SECRET), null);
  assert.equal(await verifyExtensionToken('garbage', SECRET), null);
  assert.equal(await verifyExtensionToken('', SECRET), null);
  assert.equal(await verifyExtensionToken('a.b.c', ''), null, 'no secret configured, no votes');
});

// ------------------------------------------------------------- the API ---

const api = await import('../functions/api/vote.js');

const MEMBER = { psn_account_id: 'acc-leon', psn_online_id: 'JFL__Leon' };
const GAMES = {
  NPWR_Y0: { np_comm_id: 'NPWR_Y0', title: 'Yakuza 0', icon_url: null, platform: 'PS4', max_points: 884, trophy_count: 52, progress: null, earned_total: null },
  NPWR_SR: { np_comm_id: 'NPWR_SR', title: 'Saints Row', icon_url: null, platform: 'PS5', max_points: 3955, trophy_count: 40, progress: 25, earned_total: 10 },
  NPWR_MD: { np_comm_id: 'NPWR_MD', title: 'Minecraft Dungeons', icon_url: null, platform: 'PS4', max_points: 8843, trophy_count: 30, progress: 50, earned_total: 15 },
};

/** A D1 stand-in holding one vote and its ballots. */
const apiEnv = ({ vote, ballots = [], member = MEMBER, secret = SECRET } = {}) => {
  const store = { vote, ballots: ballots.map((b) => ({ ...b })) };
  return {
    store,
    env: {
      TWITCH_EXTENSION_SECRET: secret,
      DB: {
        prepare(sql) {
          let args = [];
          const s = {
            bind(...a) { args = a; return s; },
            async first() {
              if (sql.includes('FROM members')) return args[0] === '4242' ? member : null;
              if (sql.includes('FROM votes')) return store.vote ?? null;
              if (sql.includes('FROM vote_ballots WHERE vote_id = ? AND voter = ?')) {
                return store.ballots.find((b) => b.vote_id === args[0] && b.voter === args[1]) ?? null;
              }
              return null;
            },
            async all() {
              if (sql.includes('GROUP BY np_comm_id')) {
                const m = new Map();
                for (const b of store.ballots.filter((x) => x.vote_id === args[0])) {
                  m.set(b.np_comm_id, (m.get(b.np_comm_id) ?? 0) + 1);
                }
                return { results: [...m].map(([np_comm_id, n]) => ({ np_comm_id, n })) };
              }
              if (sql.includes('FROM games g')) {
                return { results: args.slice(1).map((id) => GAMES[id]).filter(Boolean) };
              }
              return { results: [] };
            },
            async run() {
              if (sql.startsWith('INSERT OR IGNORE INTO vote_ballots')) {
                const [vote_id, voter, np_comm_id] = args;
                if (!store.ballots.some((b) => b.vote_id === vote_id && b.voter === voter)) {
                  store.ballots.push({ vote_id, voter, np_comm_id });
                }
              }
              return { meta: { changes: 1 } };
            },
          };
          return s;
        },
      },
    },
  };
};

const OPEN = {
  id: 7, source: 'list', options: JSON.stringify(['NPWR_Y0', 'NPWR_SR', 'NPWR_MD']),
  opened_at: Date.now() - 60_000, closed_at: null, winner: null, total: null,
};

const tokenFor = (opaque, channel = '4242') =>
  signExtensionToken({ channel_id: channel, opaque_user_id: opaque, role: 'viewer', exp: future() }, SECRET);

const get = async (env, opaque = 'Uviewer1', channel) => {
  const res = await api.onRequestGet({
    request: new Request('https://x.test/api/vote', {
      headers: { authorization: `Bearer ${await tokenFor(opaque, channel)}` },
    }),
    env,
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
};

const post = async (env, option, opaque = 'Uviewer1', vote = 7) => {
  const res = await api.onRequestPost({
    request: new Request('https://x.test/api/vote', {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(opaque)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ vote, option }),
    }),
    env,
  });
  return { status: res.status, body: await res.json() };
};

test('BEFORE you vote, the counts are not sent at all', async () => {
  const { env } = apiEnv({
    vote: OPEN,
    ballots: [{ vote_id: 7, voter: 'Uother', np_comm_id: 'NPWR_SR' }],
  });
  const { body, headers } = await get(env);
  assert.equal(body.vote.canVote, true);
  assert.equal(body.vote.results, null, 'hidden until picked');
  assert.ok(!JSON.stringify(body).includes('"votes"'), 'not a single count leaves the server');
  assert.deepEqual(body.vote.options.map((o) => o.id), ['NPWR_Y0', 'NPWR_SR', 'NPWR_MD'],
    'in the streamer\'s order, so the order gives nothing away');
  assert.equal(headers.get('cache-control'), 'no-store', 'per viewer, so never cached');
});

test('AFTER you vote, you see the results, leader first, with your pick marked', async () => {
  const { env, store } = apiEnv({
    vote: OPEN,
    ballots: [{ vote_id: 7, voter: 'Uother', np_comm_id: 'NPWR_SR' }],
  });
  const { status, body } = await post(env, 'NPWR_SR');
  assert.equal(status, 200);
  assert.equal(store.ballots.length, 2);
  assert.equal(body.vote.mine, 'NPWR_SR');
  assert.equal(body.vote.canVote, false);
  assert.equal(body.vote.results.total, 2);
  assert.equal(body.vote.options[0].id, 'NPWR_SR', 'the leader on top');
});

test('one vote each, and it cannot be changed', async () => {
  const { env, store } = apiEnv({ vote: OPEN });
  await post(env, 'NPWR_Y0');
  await post(env, 'NPWR_MD');
  assert.deepEqual(store.ballots.map((b) => b.np_comm_id), ['NPWR_Y0']);
});

test('logged-out viewers see the vote but cannot vote', async () => {
  const { env, store } = apiEnv({ vote: OPEN });
  const seen = await get(env, 'A_anon_123');
  assert.equal(seen.body.vote.loggedIn, false);
  assert.equal(seen.body.vote.canVote, false);
  const tried = await post(env, 'NPWR_Y0', 'A_anon_123');
  assert.equal(tried.status, 403);
  assert.equal(store.ballots.length, 0);
});

test('a vote for something not on the ballot is refused', async () => {
  const { env, store } = apiEnv({ vote: OPEN });
  const r = await post(env, 'NPWR_SOMETHING_ELSE');
  assert.equal(r.status, 400);
  assert.equal(store.ballots.length, 0);
});

test('a closed vote takes no more votes, and shows everyone the result', async () => {
  const closed = { ...OPEN, closed_at: Date.now() - 60_000, winner: 'NPWR_MD', total: 1 };
  const { env, store } = apiEnv({ vote: closed, ballots: [{ vote_id: 7, voter: 'Ux', np_comm_id: 'NPWR_MD' }] });
  const r = await post(env, 'NPWR_Y0');
  assert.equal(r.status, 409);
  assert.equal(store.ballots.length, 1);
  const seen = await get(env, 'Unever_voted');
  assert.equal(seen.body.vote.open, false);
  assert.equal(seen.body.vote.winner, 'NPWR_MD');
  assert.ok(seen.body.vote.results, 'a finished vote is no secret');
});

test('a result stays up for two days, then the Vote tab goes away', async () => {
  const old = { ...OPEN, closed_at: Date.now() - 49 * 3_600_000, winner: 'NPWR_MD', total: 1 };
  const { env } = apiEnv({ vote: old });
  assert.equal((await get(env)).body.vote, null);
});

test('a vote from another channel\'s panel sees nothing of this one', async () => {
  const { env } = apiEnv({ vote: OPEN });
  assert.equal((await get(env, 'Uviewer1', '1111')).body.vote, null);
});

test('no token, or a forged one, is refused before the database is asked anything', async () => {
  const { env } = apiEnv({ vote: OPEN });
  const res = await api.onRequestGet({ request: new Request('https://x.test/api/vote'), env });
  assert.equal(res.status, 401);
});

test('no secret configured means votes are off, said plainly', async () => {
  const { env } = apiEnv({ vote: OPEN, secret: '' });
  const res = await api.onRequestGet({ request: new Request('https://x.test/api/vote'), env });
  assert.equal(res.status, 503);
});

test('the browser may send the token across origins', async () => {
  const res = await api.onRequestOptions();
  assert.match(res.headers.get('access-control-allow-headers'), /authorization/);
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
});

// ------------------------------------------------------ the bot, /vote ---

const worker = (await import('../worker/src/index.mjs')).default;
const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PUBLIC_HEX = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex');

const STREAMER = {
  discord_id: 'd-leon', psn_account_id: 'acc-leon', psn_online_id: 'JFL__Leon',
  last_update_at: Date.now(), twitch_id: '4242',
};

/** A D1 stand-in for the Worker side: votes, ballots, backlog, wishlist, games. */
const botEnv = ({ member = STREAMER, votes = [], ballots = [], backlog = [], wishlist = [], random = [], broken = [] } = {}) => {
  const db = { votes: votes.map((v) => ({ ...v })), ballots, backlog: [...backlog] };
  let nextId = 50;
  return {
    db,
    env: {
      DISCORD_PUBLIC_KEY: PUBLIC_HEX,
      DB: {
        prepare(sql) {
          let args = [];
          const s = {
            bind(...a) { args = a; return s; },
            async first() {
              if (sql.includes('FROM members WHERE discord_id')) return member;
              if (sql.includes('FROM votes WHERE psn_account_id')) {
                return [...db.votes].sort((a, b) => b.opened_at - a.opened_at)[0] ?? null;
              }
              if (sql.startsWith('SELECT * FROM games WHERE np_comm_id')) {
                return GAMES[args[0]] ?? (args[0].startsWith('NPWR') ? { np_comm_id: args[0], title: args[0] } : null);
              }
              if (sql.includes('AS ok FROM games g')) return { ok: broken.includes(args[0]) ? 0 : 1 };
              return null;
            },
            async all() {
              if (sql.includes('FROM vote_backlog')) {
                return { results: db.backlog.map((id) => ({ np_comm_id: id, title: GAMES[id]?.title ?? id, finishable: broken.includes(id) ? 0 : 1 })) };
              }
              if (sql.includes('FROM wishlist')) return { results: wishlist.map((id) => ({ np_comm_id: id, title: id })) };
              if (sql.includes('ORDER BY RANDOM()')) return { results: random.map((id) => ({ np_comm_id: id })) };
              if (sql.includes('GROUP BY np_comm_id')) {
                const m = new Map();
                for (const b of db.ballots.filter((x) => x.vote_id === args[0])) m.set(b.np_comm_id, (m.get(b.np_comm_id) ?? 0) + 1);
                return { results: [...m].map(([np_comm_id, n]) => ({ np_comm_id, n })) };
              }
              if (sql.includes('SELECT np_comm_id, title FROM games')) {
                return { results: args.map((id) => ({ np_comm_id: id, title: GAMES[id]?.title ?? id })) };
              }
              return { results: [] };
            },
            async run() {
              if (sql.startsWith('INSERT INTO votes')) {
                db.votes.push({ id: nextId++, psn_account_id: args[0], source: args[1], options: args[2], opened_at: args[3], closed_at: null });
              }
              if (sql.startsWith('UPDATE votes SET closed_at')) {
                const v = db.votes.find((x) => x.id === args[3] && !x.closed_at);
                if (v) Object.assign(v, { closed_at: args[0], winner: args[1], total: args[2] });
                return { meta: { changes: v ? 1 : 0 } };
              }
              if (sql.startsWith('INSERT OR IGNORE INTO vote_backlog')) {
                if (db.backlog.includes(args[1])) return { meta: { changes: 0 } };
                db.backlog.unshift(args[1]);
              }
              if (sql.startsWith('DELETE FROM vote_backlog')) db.backlog = db.backlog.filter((x) => x !== args[1]);
              return { meta: { changes: 1 } };
            },
          };
          return s;
        },
      },
    },
  };
};

const call = async (env, options = [], type = 2) => {
  const body = JSON.stringify({ type, data: { name: 'vote', options }, member: { user: { id: 'd-leon' } } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = Buffer.from(
    await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + body)),
  ).toString('hex');
  const res = await worker.fetch(
    new Request('https://kraken.test/', {
      method: 'POST', body, headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': timestamp },
    }),
    env, { waitUntil() {} },
  );
  return res.json();
};
const words = (r) => JSON.stringify(r.data ?? r);

test('/vote start: list puts their wishlist to chat', async () => {
  const { env, db } = botEnv({ wishlist: ['NPWR_Y0', 'NPWR_SR', 'NPWR_MD'] });
  const r = await call(env, [{ name: 'start', value: 'list' }]);
  assert.equal(db.votes.length, 1);
  assert.deepEqual(JSON.parse(db.votes[0].options), ['NPWR_Y0', 'NPWR_SR', 'NPWR_MD']);
  assert.match(words(r), /Vote open: My list/);
  assert.match(words(r), /no timer/);
});

test('/vote start: backlog skips anything flagged broken', async () => {
  const { env, db } = botEnv({ backlog: ['NPWR_Y0', 'NPWR_SR', 'NPWR_DEAD'], broken: ['NPWR_DEAD'] });
  await call(env, [{ name: 'start', value: 'backlog' }]);
  assert.deepEqual(JSON.parse(db.votes[0].options).sort(), ['NPWR_SR', 'NPWR_Y0']);
});

test('/vote start: random uses the finishable-only pick', async () => {
  const src = await readFile(new URL('../worker/src/db.mjs', import.meta.url), 'utf8');
  const q = src.slice(src.indexOf('export const randomUnfinished'), src.indexOf('export const voteBacklog'));
  assert.match(q, /COALESCE\(mg\.progress, 0\) < 100/, 'unfinished only');
  assert.match(q, /FINISHABLE_SQL/, 'and never a broken game');

  const { env, db } = botEnv({ random: ['NPWR_Y0', 'NPWR_SR', 'NPWR_MD'] });
  await call(env, [{ name: 'start', value: 'random' }]);
  assert.equal(db.votes[0].source, 'random');
});

test('a vote needs at least two games', async () => {
  const { env, db } = botEnv({ wishlist: ['NPWR_Y0'] });
  const r = await call(env, [{ name: 'start', value: 'list' }]);
  assert.equal(db.votes.length, 0);
  assert.match(words(r), /at least 2 games/);
});

test('one vote open at a time', async () => {
  const { env, db } = botEnv({ wishlist: ['NPWR_Y0', 'NPWR_SR'], votes: [{ ...OPEN, psn_account_id: 'acc-leon' }] });
  const r = await call(env, [{ name: 'start', value: 'list' }]);
  assert.equal(db.votes.length, 1);
  assert.match(words(r), /already have a vote open/);
});

test('no Twitch channel linked means no vote, with the reason', async () => {
  const { env, db } = botEnv({ member: { ...STREAMER, twitch_id: null }, wishlist: ['NPWR_Y0', 'NPWR_SR'] });
  const r = await call(env, [{ name: 'start', value: 'list' }]);
  assert.equal(db.votes.length, 0);
  assert.match(words(r), /\/twitch/);
});

test('/vote end posts the winner PUBLICLY and touches nothing else', async () => {
  const { env, db } = botEnv({
    votes: [{ ...OPEN, psn_account_id: 'acc-leon' }],
    ballots: [
      { vote_id: 7, np_comm_id: 'NPWR_MD' }, { vote_id: 7, np_comm_id: 'NPWR_MD' },
      { vote_id: 7, np_comm_id: 'NPWR_Y0' },
    ],
  });
  const r = await call(env, [{ name: 'end', value: true }]);
  assert.equal(db.votes[0].winner, 'NPWR_MD');
  assert.equal(db.votes[0].total, 3);
  assert.match(words(r), /Chat has spoken: Minecraft Dungeons/);
  assert.ok(!((r.data.flags ?? 0) & 64), 'not ephemeral: the channel sees it');
});

test('/vote end on a tie says so', async () => {
  const { env, db } = botEnv({
    votes: [{ ...OPEN, psn_account_id: 'acc-leon' }],
    ballots: [{ vote_id: 7, np_comm_id: 'NPWR_MD' }, { vote_id: 7, np_comm_id: 'NPWR_Y0' }],
  });
  const r = await call(env, [{ name: 'end', value: true }]);
  assert.equal(db.votes[0].winner, null);
  assert.match(words(r), /It is a tie/);
});

test('the winner is never pinned to the overlay', async () => {
  // Martin: people often pick for the NEXT stream.
  const src = await readFile(new URL('../worker/src/index.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function vote('), src.indexOf('async function goal('));
  assert.ok(fn.length > 2000);
  assert.ok(!/setPin|live_pin|pollMember/.test(fn), 'the vote must not touch the overlay pin');
});

test('the backlog refuses broken games at the door', async () => {
  const { env, db } = botEnv({ broken: ['NPWR_DEAD'] });
  const r = await call(env, [{ name: 'add', value: 'NPWR_DEAD' }]);
  assert.equal(db.backlog.length, 0);
  assert.match(words(r), /cannot get any more/);
  await call(env, [{ name: 'add', value: 'NPWR_SR' }]);
  assert.deepEqual(db.backlog, ['NPWR_SR']);
  await call(env, [{ name: 'remove', value: 'NPWR_SR' }]);
  assert.deepEqual(db.backlog, []);
});

test('the command is registered with the three sources and no timer option', async () => {
  const reg = (await readFile(new URL('../jobs/register-commands.mjs', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const block = reg.slice(reg.indexOf("name: 'vote'"), reg.indexOf("name: 'overlay'"));
  for (const v of ['list', 'backlog', 'random']) assert.match(block, new RegExp(`value: '${v}'`));
  assert.ok(!/minutes|timer|duration/i.test(block), 'no timer, on Martin\'s word');
});

// ------------------------------------------------------------- the panel ---

test('the panel sends the Twitch token with every vote call', async () => {
  const js = await readFile(new URL('../twitch/panel.js', import.meta.url), 'utf8');
  assert.match(js, /Authorization: 'Bearer ' \+ state\.token/);
  assert.match(js, /state\.token = auth\.token/);
  assert.match(js, /https:\/\/platinumintel\.co\.uk\/api\/vote/);
});

test('vote options are buttons, never links', async () => {
  const js = await readFile(new URL('../twitch/panel.js', import.meta.url), 'utf8');
  const fn = js.slice(js.indexOf('function tabVote'), js.indexOf('function voteResult'));
  assert.match(fn, /el\('button', 'opt'\)/);
});
