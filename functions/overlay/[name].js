/**
 * The stream overlay bar. GET /overlay/<psn online id>
 *
 * A browser source for OBS, not a page on the site. It has no header, no
 * footer, no navigation and no background: it is one line of numbers that sits
 * on top of somebody's gameplay.
 *
 * IT CARRIES NO BRANDING, AND THAT IS THE DESIGN. No mark, no server name, no
 * address. Martin's rule, and he is right about it:
 *
 *   "i dont want it to be OH LET ME BRAND YOUR CHANNEL"
 *
 * An overlay that advertises somebody else's Discord comes off the layout in a
 * week. This one earns its place by being useful to the streamer, and it gets
 * found the way these always get found: chat asks what the bar is and the
 * streamer answers. That is a better funnel than a logo, because the person
 * asking already wants it.
 *
 * THREE ZONES, and the middle is the only one that can be switched off:
 *
 *   left    the game on screen, from their own library
 *   middle  ours: what the game has paid them, the multiplier, their position
 *   right   their cabinet, which is what every other overlay shows
 *
 * WHAT IT DOES NOT KNOW YET. "The game on screen" is really "the last game the
 * scan saw them play", so it moves when they run /update rather than when they
 * change disc. The live version of that needs PSN polled once a minute while
 * they stream, which is a later step and carries a real risk (see
 * claude/stream-overlay-spec.md). Everything here reads D1 and nothing else,
 * so this step cannot hurt the board.
 */

import { esc, n } from '../_lib/page.js';
import { displayBanked } from '../../shared/scoring.mjs';
import { localMultiplier } from '../../shared/scoring.mjs';

/**
 * How often OBS repaints it.
 *
 * A meta refresh rather than a script, because the whole site ships no
 * JavaScript and a browser source has no reason to be the exception. Sixty
 * seconds is well inside how often the numbers can actually change: the scan
 * runs nightly, and even the live version of this could only move once a
 * minute.
 */
const REFRESH = 60;

const MEMBER = `
  SELECT psn_account_id, psn_online_id, rank, points, completion,
         platinum, gold, silver, bronze, projects, completed
    FROM members
   WHERE psn_online_id = ? COLLATE NOCASE
     AND rank IS NOT NULL
   LIMIT 1`;

/**
 * The one game they touched most recently.
 *
 * ONE ROW, and it has to stay one row. This runs every sixty seconds for as
 * long as somebody streams, so a version that reads their whole library would
 * cost more on its own than the rest of the site put together. Migration 017
 * adds the index this ORDER BY needs.
 *
 * The platinum's local_earned comes from a subquery rather than a join because
 * a join would multiply the row out and then need a GROUP BY to put it back.
 */
const PLAYING = `
  SELECT g.np_comm_id, g.title, g.platform, g.icon_url, g.trophy_count,
         g.max_points, g.local_started, g.unobtainable,
         mg.points, mg.progress, mg.earned_total,
         (SELECT t.local_earned FROM trophies t
           WHERE t.np_comm_id = g.np_comm_id AND t.type = 'platinum'
           LIMIT 1) AS plat_local
    FROM member_games mg
    JOIN games g ON g.np_comm_id = mg.np_comm_id
   WHERE mg.psn_account_id = ?
   ORDER BY COALESCE(mg.last_played_at, mg.last_earned_at, 0) DESC
   LIMIT 1`;

/** Ranked members, for the "of 70". Stored, never counted per request. */
const TOTAL = `
  SELECT COUNT(*) AS c FROM members
   WHERE rank IS NOT NULL AND last_update_at IS NOT NULL`;

const CUP = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M6 2h12v6a6 6 0 0 1-12 0V2z"/>
  <path d="M6 4H4a2 2 0 0 0-2 2v1a5 5 0 0 0 3.8 4.9l.5-2A3 3 0 0 1 4 7V6h2V4z"/>
  <path d="M18 4h2a2 2 0 0 1 2 2v1a5 5 0 0 1-3.8 4.9l-.5-2A3 3 0 0 0 20 7V6h-2V4z"/>
  <path d="M11 14h2v4h-2z"/><path d="M7 20h10v2H7z"/></svg>`;

const CLOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;

const STACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1"/>
  <rect x="3" y="11" width="18" height="5" rx="1"/><path d="M6 18h12"/></svg>`;

/** 1st, 2nd, 3rd, and the four teens that break the pattern. */
const ordinalMark = (v) => {
  const i = Math.abs(Math.floor(Number(v) || 0)) % 100;
  if (i >= 11 && i <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[i % 10] ?? 'th';
};

const STYLES = `
:root{
  --ink:#e6efec; --soft:#93a8a6; --faint:#7d939a;
  /* Named for what it does, not for whose site it came from. The word
     appears nowhere in this document, including in a variable nobody sees,
     because the no-branding rule is easier to keep when it is absolute. */
  --accent:#20b899; --brass:#d8ab3e;
  --plat:#8fbcff; --gold:#e0b544; --silver:#c3ccd0; --bronze:#c8814a;
}
*{box-sizing:border-box}
/* TRANSPARENT, deliberately. A browser source paints whatever the body says,
   so a background colour here would put a black slab across the gameplay. */
html,body{margin:0;background:transparent}
body{
  font:13.5px/1.4 "Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  color:var(--ink);-webkit-font-smoothing:antialiased;
  /* Nothing here should ever be selectable or draggable inside OBS. */
  user-select:none;
}
.bar{
  position:fixed;left:0;right:0;display:flex;align-items:center;
  height:44px;padding:0 12px;
  background:linear-gradient(180deg,rgba(8,16,15,.70) 0%,rgba(8,16,15,.92) 100%);
  backdrop-filter:blur(6px);
}
.bar.bottom{bottom:0;box-shadow:0 -10px 24px rgba(0,0,0,.30)}
.bar.top{top:0;box-shadow:0 10px 24px rgba(0,0,0,.30)}
.zone{display:flex;align-items:center;min-width:0}
.zone.mid{margin:0 auto;padding:0 4px;
  border-left:1px solid rgba(230,239,236,.09);
  border-right:1px solid rgba(230,239,236,.09)}
.mid .seg + .seg{border-left:0}
.spacer{flex:1}
.seg{display:flex;align-items:center;gap:9px;padding:0 13px;white-space:nowrap}
.seg + .seg{border-left:1px solid rgba(230,239,236,.09)}
.cover{width:30px;height:30px;border-radius:4px;flex:none;object-fit:cover;
  border:1px solid rgba(230,239,236,.16);background:rgba(230,239,236,.06)}
.game{font-weight:600;max-width:26ch;overflow:hidden;text-overflow:ellipsis}
.plat-chip{font-size:10px;letter-spacing:.08em;padding:2px 5px;border-radius:3px;
  background:rgba(230,239,236,.10);color:var(--soft);font-weight:700}
.num{font-variant-numeric:tabular-nums}
.pctv{color:var(--faint);font-size:12px;font-variant-numeric:tabular-nums}
.track{width:66px;height:5px;border-radius:99px;background:rgba(230,239,236,.14);
  overflow:hidden;flex:none}
.fill{display:block;height:100%;border-radius:99px;background:var(--accent)}
.ic{width:13px;height:13px;opacity:.72;flex:none}
.cups{display:flex;align-items:center;gap:13px}
.cups span{display:flex;align-items:center;gap:5px;font-weight:600;
  font-variant-numeric:tabular-nums}
.cups svg{width:14px;height:14px}
.c-plat{color:var(--plat)} .c-gold{color:var(--gold)}
.c-silv{color:var(--silver)} .c-bron{color:var(--bronze)}
.pts{font-weight:700;font-variant-numeric:tabular-nums}
.pts .max{color:var(--faint);font-weight:400}
.rank{font-variant-numeric:tabular-nums;font-weight:800;color:var(--brass);font-size:15px}
.rank sup{font-size:9px;top:-.55em}
.of{color:var(--faint);font-size:11.5px}
.mult{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:99px;
  background:rgba(216,171,62,.14);border:1px solid rgba(216,171,62,.42);
  color:var(--brass);font-weight:800;font-variant-numeric:tabular-nums;font-size:13px}
.mult small{font-weight:600;font-size:10.5px;color:#c39a3c}
.warn{color:#e0645f;font-weight:700}
/* THE HOURS SLOT, held open for the streaming board. It is drawn dim and
   empty rather than left out, so the day the number arrives nothing else on
   the bar shifts sideways to make room for it. */
.hold{opacity:.42}
.miss{padding:0 14px;color:var(--soft)}
`;

/**
 * The multiplier, only when it is doing something.
 *
 * A chip reading exactly 1.00 is noise: it takes space on a bar with no room
 * to spare in order to say "nothing unusual". It appears when the game is
 * genuinely worth more here than its trophies say, and disappears otherwise.
 */
function multiplierChip(g) {
  const owners = Number(g.local_started) || 0;
  const done = Number(g.plat_local) || 0;
  if (owners < 3) return '';
  const mult = localMultiplier(done, owners);
  if (mult < 1.005) return '';
  const stuck = Math.max(0, owners - done);
  return `<span class="seg"><span class="mult">&times;${mult.toFixed(2)}
    <small>${n(stuck)} stuck</small></span></span>`;
}

function leftZone(g) {
  if (!g) {
    return `<span class="zone"><span class="miss">Nothing scanned yet</span></span>`;
  }
  const total = Number(g.trophy_count) || 0;
  const got = Number(g.earned_total) || 0;
  const progress = Math.max(0, Math.min(100, Number(g.progress) || 0));
  return `<span class="zone">
    <span class="seg">
      ${
        g.icon_url
          ? `<img class="cover" src="${esc(g.icon_url)}" alt="" width="30" height="30">`
          : '<span class="cover"></span>'
      }
      ${g.platform ? `<span class="plat-chip">${esc(g.platform)}</span>` : ''}
      <span class="game">${esc(g.title)}</span>
      ${Number(g.unobtainable) === 1 ? '<span class="warn" title="Flagged">&#9888;</span>' : ''}
    </span>
    <span class="seg">
      <span class="ic">${CUP}</span>
      <span class="num">${n(got)}/${n(total)}</span>
      <span class="track"><i class="fill" style="width:${progress.toFixed(2)}%"></i></span>
      <span class="pctv">${progress.toFixed(2)}%</span>
    </span>
    <span class="seg hold">
      <span class="ic">${CLOCK}</span><span class="num">00.0h</span>
    </span>
  </span>`;
}

/**
 * Ours. Points first, because they sit next to the game and they are about the
 * game; rank last, because it is about the person and it is the part a
 * streamer might not want leading.
 */
function midZone(m, g, total) {
  if (!g) return '';
  const completion = m.completion;
  const max = displayBanked(g.max_points, completion);
  const got = displayBanked(g.points, completion);
  return `<span class="zone mid">
    <span class="seg">
      <span class="pts">${n(got)}<span class="max"> / ${n(max)}</span></span>
    </span>
    ${multiplierChip(g)}
    <span class="seg">
      <span class="rank">${n(m.rank)}<sup>${ordinalMark(m.rank)}</sup></span>
      <span class="of">of ${n(total)}</span>
    </span>
  </span>`;
}

function rightZone(m) {
  const done = Number(m.completed) || 0;
  const started = Number(m.projects) || 0;
  const pc = Number(m.completion);
  return `<span class="zone">
    <span class="seg">
      <span class="ic">${STACK}</span>
      <span class="num">${n(done)}/${n(started)}</span>
      ${Number.isFinite(pc) && pc > 0 ? `<span class="pctv">${pc.toFixed(2)}%</span>` : ''}
    </span>
    <span class="seg">
      <span class="cups">
        <span class="c-plat">${CUP}${n(m.platinum)}</span>
        <span class="c-gold">${CUP}${n(m.gold)}</span>
        <span class="c-silv">${CUP}${n(m.silver)}</span>
        <span class="c-bron">${CUP}${n(m.bronze)}</span>
      </span>
    </span>
  </span>`;
}

/** A bare document. No shared page chrome, because this is not a page. */
const doc = (body) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${REFRESH}">
<title>overlay</title>
<style>${STYLES}</style>
</head><body>${body}</body></html>`;

export async function onRequestGet({ env, request, params }) {
  const url = new URL(request.url);
  const name = decodeURIComponent(params.name ?? '');

  // Whitelisted, never interpolated. `top` and `bottom` are the only two
  // answers and anything else is somebody guessing at a query string.
  const pos = url.searchParams.get('pos') === 'top' ? 'top' : 'bottom';
  // The middle is opt-out rather than opt-in: a member who has not read any of
  // this should still see the part that makes it ours.
  const showMid = url.searchParams.get('mid') !== '0';

  const member = await env.DB.prepare(MEMBER).bind(name).first();
  if (!member) {
    /**
     * 404 WITH AN EMPTY BODY, not an error card.
     *
     * A wrong name in OBS must show nothing at all. A visible "no such hunter"
     * banner would sit across somebody's gameplay for a whole stream, and they
     * would not necessarily know where it came from.
     */
    return new Response(doc(''), {
      status: 404,
      headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const [playing, totals] = await Promise.all([
    env.DB.prepare(PLAYING).bind(member.psn_account_id).first(),
    env.DB.prepare(TOTAL).first(),
  ]);

  const body = `<div class="bar ${pos}">
    ${leftZone(playing)}
    ${showMid && playing ? midZone(member, playing, totals?.c ?? 0) : '<span class="spacer"></span>'}
    ${rightZone(member)}
  </div>`;

  return new Response(doc(body), {
    headers: {
      'content-type': 'text/html;charset=utf-8',
      /**
       * THIRTY SECONDS, not the five minutes every other page gets.
       *
       * The bar is refreshing itself every sixty, so a five minute cache would
       * mean four of those five requests repainted the same numbers. Half the
       * refresh interval is the longest a viewer could see a stale figure
       * while still letting two streamers on the same page share a hit.
       */
      'cache-control': 'public, max-age=30',
      // It is going into somebody else's OBS, so no referrer and no sniffing.
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}
