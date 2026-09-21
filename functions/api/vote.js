/**
 * The panel's vote. GET /api/vote, POST /api/vote
 *
 * WHO IS ASKING COMES FROM TWITCH'S SIGNED TOKEN, and nothing else. The panel
 * sends it as `Authorization: Bearer <token>`; the token says which channel the
 * panel is on and gives the viewer an opaque id. The channel in the token is
 * the only channel this will talk about, so nobody can vote on somebody else's
 * stream by changing a URL.
 *
 * RESULTS ARE HIDDEN UNTIL YOU HAVE VOTED. That is why this is per viewer and
 * never cached: the same vote looks different to somebody who has voted and
 * somebody who has not. Martin: "the hidden until picked is FUCKING GOLDEN".
 *
 * LOGGED-OUT VIEWERS SEE THE VOTE BUT CANNOT VOTE. Their opaque id changes
 * every visit, so a vote from them would be one vote per refresh.
 *
 * A closed vote stays up for RESULT_SHOWN_MS as the "up next" card, then the
 * panel's Vote tab goes away until the next one.
 */
import { verifyExtensionToken } from '../_lib/twitch-jwt.js';
import { secureUrl } from '../_lib/page.js';
import {
  VOTE_SOURCES, RESULT_SHOWN_MS, parseOptions, tally, voterId,
} from '../../shared/votes.mjs';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export async function onRequestOptions() {
  return new Response(null, { headers: { ...HEADERS, 'access-control-max-age': '86400' } });
}

const MEMBER = `
  SELECT psn_account_id, psn_online_id FROM members
   WHERE twitch_id = ? AND rank IS NOT NULL LIMIT 1`;

const LATEST = `
  SELECT id, source, options, opened_at, closed_at, winner, total
    FROM votes WHERE psn_account_id = ? ORDER BY opened_at DESC LIMIT 1`;

const COUNTS =
  'SELECT np_comm_id, COUNT(*) AS n FROM vote_ballots WHERE vote_id = ? GROUP BY np_comm_id';

const MINE = 'SELECT np_comm_id FROM vote_ballots WHERE vote_id = ? AND voter = ?';

const CAST =
  'INSERT OR IGNORE INTO vote_ballots (vote_id, voter, np_comm_id, cast_at) VALUES (?,?,?,?)';

const gamesSql = (count) => `
  SELECT g.np_comm_id, g.title, g.icon_url, g.platform, g.max_points, g.trophy_count,
         mg.progress, mg.earned_total
    FROM games g
    LEFT JOIN member_games mg ON mg.np_comm_id = g.np_comm_id AND mg.psn_account_id = ?
   WHERE g.np_comm_id IN (${Array.from({ length: count }, () => '?').join(',')})`;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function who(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return verifyExtensionToken(token, env.TWITCH_EXTENSION_SECRET);
}

/**
 * Everything the Vote tab draws, for this viewer.
 *
 * `results` is null while the vote is open and this viewer has not voted, and
 * that null is the whole of "hidden until you vote" - the counts never leave
 * the server, so there is nothing in the panel for a curious viewer to dig out.
 */
async function state(env, member, voter, now = Date.now()) {
  const v = await env.DB.prepare(LATEST).bind(member.psn_account_id).first();
  if (!v) return { vote: null };
  const closed = num(v.closed_at) || null;
  if (closed && now - closed > RESULT_SHOWN_MS) return { vote: null };

  const options = parseOptions(v.options);
  if (!options.length) return { vote: null };

  const [games, counts, mine] = await Promise.all([
    env.DB.prepare(gamesSql(options.length)).bind(member.psn_account_id, ...options).all(),
    env.DB.prepare(COUNTS).bind(v.id).all(),
    voter ? env.DB.prepare(MINE).bind(v.id, voter).first() : Promise.resolve(null),
  ]);
  const byId = new Map((games?.results ?? []).map((g) => [g.np_comm_id, g]));
  const t = tally(options, counts?.results ?? []);
  const show = !!closed || !!mine;

  const game = (id) => {
    const g = byId.get(id) ?? {};
    const progress = num(g.progress);
    return {
      id,
      title: g.title ?? 'Unknown game',
      icon: secureUrl(g.icon_url) || null,
      platform: g.platform ?? null,
      progress,
      started: g.progress !== null && g.progress !== undefined,
      left: Math.max(0, num(g.trophy_count) - num(g.earned_total)),
      points: num(g.max_points),
    };
  };

  return {
    vote: {
      id: v.id,
      source: v.source,
      label: VOTE_SOURCES[v.source]?.label ?? '',
      question: VOTE_SOURCES[v.source]?.question ?? 'What should I play next?',
      open: !closed,
      closedAt: closed,
      // Listed in the order the streamer's list had them until results show,
      // so the order itself gives nothing away.
      options: (show ? t.rows.map((r) => r.id) : options).map(game),
      mine: mine?.np_comm_id ?? null,
      canVote: !closed && !!voter && !mine,
      loggedIn: !!voter,
      results: show
        ? { total: t.total, rows: t.rows.map((r) => ({ id: r.id, votes: r.votes, percent: r.percent })) }
        : null,
      winner: closed ? v.winner ?? null : null,
      tied: closed && !v.winner ? t.tied : [],
    },
  };
}

async function context(request, env) {
  if (!env.TWITCH_EXTENSION_SECRET) return { error: json({ error: 'votes are not set up' }, 503) };
  const claims = await who(request, env);
  if (!claims) return { error: json({ error: 'not from the panel' }, 401) };
  const channel = String(claims.channel_id);
  if (!/^\d{1,20}$/.test(channel)) return { error: json({ error: 'bad channel' }, 400) };
  const member = await env.DB.prepare(MEMBER).bind(channel).first().catch(() => null);
  if (!member) return { error: json({ vote: null }) };
  return { member, voter: voterId(claims.opaque_user_id) };
}

export async function onRequestGet({ request, env }) {
  const c = await context(request, env);
  if (c.error) return c.error;
  try {
    return json(await state(env, c.member, c.voter));
  } catch {
    // No votes tables yet (038), or D1 hiccupped: no Vote tab, never a broken panel.
    return json({ vote: null });
  }
}

export async function onRequestPost({ request, env }) {
  const c = await context(request, env);
  if (c.error) return c.error;
  if (!c.voter) return json({ error: 'log in to Twitch to vote' }, 403);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  const pick = String(body?.option ?? '');

  try {
    const v = await env.DB.prepare(LATEST).bind(c.member.psn_account_id).first();
    if (!v || v.closed_at) return json({ error: 'this vote has closed', ...(await state(env, c.member, c.voter)) }, 409);
    if (Number(body?.vote) && Number(body.vote) !== Number(v.id)) {
      return json({ error: 'that vote has been replaced', ...(await state(env, c.member, c.voter)) }, 409);
    }
    if (!parseOptions(v.options).includes(pick)) return json({ error: 'not on this ballot' }, 400);

    // INSERT OR IGNORE against (vote_id, voter): a second vote, or a
    // double-click, changes nothing. One vote, and it cannot be changed.
    await env.DB.prepare(CAST).bind(v.id, c.voter, pick, Date.now()).run();
    return json(await state(env, c.member, c.voter));
  } catch {
    return json({ error: 'could not record that' }, 500);
  }
}
