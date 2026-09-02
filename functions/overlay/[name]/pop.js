/**
 * The trophy pop, as its own browser source. GET /overlay/<name>/pop
 *
 * SEPARATE FROM THE BAR ON PURPOSE. Martin: "i would like that on its own
 * source so people can place it where every they like". A streamer's layout is
 * theirs, the bar wants an edge and the pop wants a corner, and welding the two
 * together would mean anybody who liked one and not the other got neither.
 *
 * It shows nothing almost all of the time. That is the correct behaviour for a
 * transparent box sitting over somebody's gameplay: it is empty until a trophy
 * lands, then it is loud for eight seconds, then it is empty again.
 *
 * HOW IT KNOWS. `member_trophies` (migration 016) records when each trophy was
 * earned, written by the scan. This asks for anything newer than the marker in
 * `members.overlay_seen_at` (migration 018), shows the newest, and moves the
 * marker past it so it cannot pop twice.
 *
 * WHICH MEANS IT FIRES WHEN THE SCAN RUNS, not the instant the console chimes.
 * Until PSN is polled live for people who are streaming, a trophy pops when
 * their update goes through. That is a smaller feature than it will eventually
 * be, and it is honest: nothing here can hurt the board, because nothing here
 * talks to PSN.
 */

import { esc, n } from '../../_lib/page.js';
import { displayBanked } from '../../../shared/scoring.mjs';

/**
 * TWENTY SECONDS, not sixty.
 *
 * The bar can be a minute stale without anybody noticing a number. A
 * celebration cannot: a pop that turns up a minute after the trophy is a pop
 * arriving during a different sentence. Twenty is the compromise between that
 * and hammering the database on behalf of an empty box.
 */
const REFRESH = 20;

/**
 * Nothing older than half an hour is worth announcing.
 *
 * Somebody plays offline all evening, syncs at midnight, and forty trophies
 * land at once. Without a ceiling the overlay would work through them one
 * every twenty seconds for a quarter of an hour, long after anybody watching
 * had gone. The marker still moves past all of them, so the backlog is skipped
 * rather than queued.
 */
const FRESH_MS = 30 * 60 * 1000;

const MEMBER = `
  SELECT psn_account_id, psn_online_id, completion, rank, prev_rank, overlay_seen_at
    FROM members
   WHERE psn_online_id = ? COLLATE NOCASE
     AND rank IS NOT NULL
   LIMIT 1`;

/**
 * The newest trophy this overlay has not shown.
 *
 * Reads idx_member_trophies_recent, so it is one row rather than a walk
 * through everything they have ever earned.
 */
const NEWEST = `
  SELECT mt.np_comm_id, mt.trophy_id, mt.earned_at,
         t.name, t.type, t.points,
         g.title AS game
    FROM member_trophies mt
    JOIN trophies t ON t.np_comm_id = mt.np_comm_id AND t.trophy_id = mt.trophy_id
    LEFT JOIN games g ON g.np_comm_id = mt.np_comm_id
   WHERE mt.psn_account_id = ?
     AND mt.earned_at > ?
   ORDER BY mt.earned_at DESC
   LIMIT 1`;

/**
 * Where the frames live, and how many there are. See tools/trophy-frames.py.
 *
 * NOT UNDER /overlay/. They were, and they were invisible, because a Pages
 * Function beats a static file on the same path: a request for
 * /overlay/gold.png went to the /overlay/<name> route, which looked for a
 * hunter called "gold.png", found nobody and served an empty bar. The image
 * never existed as far as the browser was concerned, so the pop had a hole
 * where the trophy goes.
 *
 * Anything static this feature needs lives OUTSIDE the route's own prefix.
 */
const FRAMES = 36;
const FRAME = 104;
const METALS = { platinum: 'plat', gold: 'gold', silver: 'silver', bronze: 'bronze' };

const ordinalMark = (v) => {
  const i = Math.abs(Math.floor(Number(v) || 0)) % 100;
  if (i >= 11 && i <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[i % 10] ?? 'th';
};

const STYLES = `
:root{
  --ink:#e6efec; --soft:#93a8a6; --faint:#7d939a; --up:#4ec98a; --brass:#d8ab3e;
  --plat:#8fbcff; --gold:#e0b544; --silver:#c3ccd0; --bronze:#c8814a;
}
*{box-sizing:border-box}
html,body{margin:0;background:transparent;overflow:hidden}
body{
  font:13.5px/1.4 "Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  color:var(--ink);-webkit-font-smoothing:antialiased;user-select:none;
}
.pop{
  position:fixed;left:0;top:0;
  /* A CEILING, so the card cannot grow past the box somebody sized for it. A
     trophy called "Complete every side quest in the Valley of the Kings" would
     otherwise push the points off the edge of their source. */
  max-width:520px;
  display:flex;align-items:stretch;overflow:hidden;border-radius:10px;
  background:linear-gradient(180deg,rgba(18,32,36,.97),rgba(8,16,15,.97));
  border:1px solid rgba(230,239,236,.14);
  box-shadow:0 16px 38px rgba(0,0,0,.55);
  /* IT LEAVES AND IT STAYS GONE. One run, filling forwards, so the card is not
     sitting on the gameplay waiting for the next refresh to take it away.
     NO BACKTICKS IN THIS COMMENT: the whole stylesheet is a template literal
     and a stray one ends it mid sentence. That has cost a build twice. */
  animation:popin 8.4s cubic-bezier(.16,.74,.24,1) 1 forwards;
}
/* Test mode loops, because you cannot position something you can only see once. */
.pop.demo{animation-iteration-count:infinite}
@keyframes popin{
  0%{opacity:0;transform:translate3d(-26px,0,0) scale(.97)}
  4%{opacity:1;transform:none}
  84%{opacity:1;transform:none}
  92%{opacity:0;transform:translate3d(-14px,0,0)}
  100%{opacity:0;transform:translate3d(-26px,0,0) scale(.97)}
}
.box{
  width:118px;flex:none;display:grid;place-items:center;
  background:radial-gradient(72% 72% at 50% 40%,
    color-mix(in srgb, var(--metal) 28%, transparent), transparent 72%);
  border-right:1px solid rgba(230,239,236,.10);
}
/* THIRTY SIX REAL RENDERS, stepped through. Not a spinning icon: every frame is
   the cup lit and rasterised from an actual angle, which is why it stays sharp
   while it turns. tools/trophy-frames.py builds them. */
.cup{
  width:${FRAME}px;height:${FRAME}px;background-repeat:no-repeat;
  background-size:${FRAME * FRAMES}px ${FRAME}px;
  animation:turn 6s steps(${FRAMES}) infinite;
}
@keyframes turn{ to{ background-position:-${FRAME * FRAMES}px 0 } }
.body{display:flex;align-items:center;gap:18px;padding:16px 18px;min-width:0}
.name{font-weight:700;font-size:17px;max-width:26ch;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.game{color:var(--soft);font-size:12px;margin-top:2px;max-width:26ch;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.gain{text-align:right;padding-left:16px;border-left:1px solid rgba(230,239,236,.12)}
.gain b{display:block;color:var(--up);font-size:18px;font-variant-numeric:tabular-nums;
  line-height:1.15}
.gain span{display:block;color:var(--faint);font-size:10.5px;letter-spacing:.1em;
  text-transform:uppercase}
.edge{width:6px;flex:none;background:var(--metal);opacity:.9}
/* THE RANK LINE, only when they actually moved up. It is the reason any of this
   is worth building: every overlay on Twitch can show a trophy, and this is the
   only one that can say somebody got overtaken. */
.climb{display:flex;align-items:center;gap:7px;margin-top:5px;
  font-variant-numeric:tabular-nums;font-weight:800;color:var(--brass);font-size:13px}
.climb .was{color:var(--faint);font-weight:600;text-decoration:line-through;
  text-decoration-thickness:1px}
.climb sup{font-size:8px;top:-.5em}
`;

const doc = (body, refresh) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>pop</title>
<style>${STYLES}</style>
</head><body>${body}</body></html>`;

/** Empty, and never cached, so the next refresh asks again. */
const nothing = () =>
  new Response(doc('', REFRESH), {
    headers: {
      'content-type': 'text/html;charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });

function card({ metal, name, game, points, climb, demo }) {
  const slug = METALS[metal] ?? 'bronze';
  return `<div class="pop${demo ? ' demo' : ''}" style="--metal:var(--${slug === 'plat' ? 'plat' : slug})">
    <span class="box">
      <span class="cup" style="background-image:url(/trophy/${slug}.png)"></span>
    </span>
    <span class="body">
      <span>
        <span class="name">${esc(name)}</span>
        ${game ? `<span class="game">${esc(game)}</span>` : ''}
        ${
          climb
            ? `<span class="climb"><span class="was">${n(climb.from)}<sup>${ordinalMark(
                climb.from,
              )}</sup></span> &rsaquo; ${n(climb.to)}<sup>${ordinalMark(climb.to)}</sup></span>`
            : ''
        }
      </span>
      ${
        points > 0
          ? `<span class="gain"><b>+${n(points)}</b><span>points</span></span>`
          : ''
      }
    </span>
    <span class="edge"></span>
  </div>`;
}

export async function onRequestGet({ env, request, params }) {
  const url = new URL(request.url);
  const name = decodeURIComponent(params.name ?? '');

  /**
   * TEST MODE, because you cannot place a box you can only see once every few
   * hours. `?test=gold` loops a fake card forever so the source can be dragged
   * into position, and it says TEST on it so nobody watching thinks somebody
   * just earned something called Test.
   */
  const test = url.searchParams.get('test');
  if (test) {
    const metal = Object.keys(METALS).includes(test) ? test : 'gold';
    return new Response(
      doc(
        card({
          metal,
          name: 'Test trophy',
          game: 'Drag me where you want me',
          points: 412,
          climb: { from: 3, to: 2 },
          demo: true,
        }),
        // No refresh in test mode. The loop is doing the work and a reload
        // would just restart it mid animation.
        0,
      ),
      {
        headers: {
          'content-type': 'text/html;charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        },
      },
    );
  }

  const member = await env.DB.prepare(MEMBER).bind(name).first().catch(() => null);
  if (!member) return nothing();

  const now = Date.now();

  /**
   * A FIRST RUN SHOWS NOTHING, and sets the marker to now.
   *
   * The alternative is that adding the source fires their most recent
   * platinum, which might be from March, at an audience with no idea what they
   * are looking at.
   */
  if (member.overlay_seen_at == null) {
    await env.DB.prepare('UPDATE members SET overlay_seen_at = ? WHERE psn_account_id = ?')
      .bind(now, member.psn_account_id)
      .run()
      .catch(() => {});
    return nothing();
  }

  /**
   * The whole read is wrapped, because migration 016 and 018 may not have run
   * on a given database yet and an overlay is the last place that should
   * become a stack trace. Same seatbelt the flags have.
   */
  let row = null;
  try {
    row = await env.DB.prepare(NEWEST)
      .bind(member.psn_account_id, Number(member.overlay_seen_at) || 0)
      .first();
  } catch {
    return nothing();
  }
  if (!row) return nothing();

  // Move the marker whether or not this one is fresh enough to show, so a
  // backlog is skipped rather than played out one card at a time.
  await env.DB.prepare('UPDATE members SET overlay_seen_at = ? WHERE psn_account_id = ?')
    .bind(Number(row.earned_at), member.psn_account_id)
    .run()
    .catch(() => {});

  if (now - Number(row.earned_at) > FRESH_MS) return nothing();

  /**
   * The climb, from the numbers the rescore already stores. `prev_rank` is
   * where they were before the last update, so this is true for every pop
   * belonging to that update rather than to this exact trophy. That is the
   * honest limit of it until PSN is polled live, and it is still the only
   * overlay anywhere that can say it at all.
   */
  const from = Number(member.prev_rank);
  const to = Number(member.rank);
  const climb = Number.isFinite(from) && Number.isFinite(to) && from > to ? { from, to } : null;

  return new Response(
    doc(
      card({
        metal: String(row.type ?? '').toLowerCase(),
        name: row.name || `Trophy #${row.trophy_id}`,
        game: row.game,
        points: displayBanked(row.points, member.completion),
        climb,
      }),
      REFRESH,
    ),
    {
      headers: {
        'content-type': 'text/html;charset=utf-8',
        // NEVER CACHED. A cached pop is either a celebration nobody sees or the
        // same one twice, and this endpoint writes on the way through.
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    },
  );
}
