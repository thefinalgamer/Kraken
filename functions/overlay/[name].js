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

import { esc, n, barShade, SHADE_VAR, mendQuery } from '../_lib/page.js';
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
         platinum, gold, silver, bronze, projects, completed, live_play,
         live_since, live_checked_at
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
         mg.earned_platinum, mg.earned_gold, mg.earned_silver, mg.earned_bronze,
         (SELECT t.local_earned FROM trophies t
           WHERE t.np_comm_id = g.np_comm_id AND t.type = 'platinum'
           LIMIT 1) AS plat_local
    FROM member_games mg
    JOIN games g ON g.np_comm_id = mg.np_comm_id
   WHERE mg.psn_account_id = ?
   ORDER BY COALESCE(mg.last_played_at, mg.last_earned_at, 0) DESC
   LIMIT 1`;

/**
 * One named game, for when the live poll knows better than the scan does.
 *
 * LEFT JOIN, because somebody can be twenty minutes into a game the scan has
 * never seen. The row still renders: the title and the cover come from `games`,
 * and the numbers come from the poll rather than from `member_games`.
 */
const ONE_GAME = `
  SELECT g.np_comm_id, g.title, g.platform, g.icon_url, g.trophy_count,
         g.max_points, g.local_started, g.unobtainable,
         mg.points, mg.progress, mg.earned_total,
         mg.earned_platinum, mg.earned_gold, mg.earned_silver, mg.earned_bronze,
         (SELECT t.local_earned FROM trophies t
           WHERE t.np_comm_id = g.np_comm_id AND t.type = 'platinum'
           LIMIT 1) AS plat_local
    FROM games g
    LEFT JOIN member_games mg
      ON mg.np_comm_id = g.np_comm_id AND mg.psn_account_id = ?
   WHERE g.np_comm_id = ?
   LIMIT 1`;

/**
 * How long a live note is trusted.
 *
 * The poll only runs while somebody is streaming with the overlay up, so the
 * moment they stop, this stops being written. Fifteen minutes later the bar
 * quietly goes back to what the scan knows, rather than insisting forever that
 * they are still on the game they finished last night.
 */
const LIVE_PLAY_MS = 15 * 60 * 1000;

/**
 * How many of this game's trophies landed during THIS stream.
 *
 * A COUNT, and one of the very few on this project. The usual objection is
 * scale: counting over `games` reads a 26,000 row table to print a number
 * nobody asked for. This reads a handful of rows through
 * idx_member_trophies_recent, scoped to one member, one game and one evening,
 * and there is no stored figure to print instead because "since they went
 * live" is a window that only exists while they are live.
 */
const ON_STREAM = `
  SELECT COUNT(*) AS c FROM member_trophies
   WHERE psn_account_id = ?
     AND np_comm_id = ?
     AND earned_at >= ?`;

/** Ranked members, for the "of 70". Stored, never counted per request. */
const TOTAL = `
  SELECT COUNT(*) AS c FROM members
   WHERE rank IS NOT NULL AND last_update_at IS NOT NULL`;

/**
 * The person one place above them.
 *
 * "32nd of 71" says where you are. It does not say whether 31st is a thousand
 * points away or forty, which is the question anybody looking at their own rank
 * is actually asking, and the one that makes a stream chase something.
 *
 * One row, straight off the rank. Nothing is computed here beyond a
 * subtraction of two stored numbers.
 */
const AHEAD = `
  SELECT rank, points FROM members
   WHERE rank = ? AND rank IS NOT NULL
   LIMIT 1`;

const CUP = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M6 2h12v6a6 6 0 0 1-12 0V2z"/>
  <path d="M6 4H4a2 2 0 0 0-2 2v1a5 5 0 0 0 3.8 4.9l.5-2A3 3 0 0 1 4 7V6h2V4z"/>
  <path d="M18 4h2a2 2 0 0 1 2 2v1a5 5 0 0 1-3.8 4.9l-.5-2A3 3 0 0 0 20 7V6h-2V4z"/>
  <path d="M11 14h2v4h-2z"/><path d="M7 20h10v2H7z"/></svg>`;

const CLOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;

/**
 * Games started against finished.
 *
 * THREE GREY RECTANGLES WERE UNREADABLE at overlay size. A controller inside a
 * ring says "games" instantly to anybody who has held a pad. Martin, holding
 * the PS5 card icon up against the old one: "i love this icon with controller
 * and ring around it i think it would make a much better icon".
 */
const PAD = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <circle cx="12" cy="12" r="10.2" fill="none" stroke="var(--accent)" stroke-width="1.9"/>
  <path fill="currentColor" fill-rule="evenodd" d="M8.5 9.4h7c1.8 0 3.2 1.5 3.35 3.3l.2 2.2
    c.1 1.05-.65 1.9-1.65 1.9-.5 0-1-.22-1.32-.62l-1.2-1.48H9.12l-1.2 1.48
    c-.32.4-.82.62-1.32.62-1 0-1.75-.85-1.65-1.9l.2-2.2C5.3 10.9 6.7 9.4 8.5 9.4z
    M8.55 11.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z
    M15.45 11.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/>
</svg>`;

/** 1st, 2nd, 3rd, and the four teens that break the pattern. */
const ordinalMark = (v) => {
  const i = Math.abs(Math.floor(Number(v) || 0)) % 100;
  if (i >= 11 && i <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[i % 10] ?? 'th';
};

const STYLES = `
:root{
  /* WHITE, NOT GREY. Martin: "the gray text is almost impossible to see with
     backgrounds so keep it white". He is right, and it is the one place on this
     project where the site's palette does not transfer: a page has a dark
     surface behind it and this has whatever the game is doing. Everything is
     white or near white now, and the hierarchy is carried by weight, size and a
     shadow instead of by fading text out. */
  --ink:#ffffff; --soft:#eaf2f0; --faint:#d3dedb;
  --accent:#20b899; --brass:#f0c357;
  --plat:#a9cdff; --gold:#f2c65a; --silver:#dbe3e6; --bronze:#e0a06a;
  /* PURPLE MEANS TONIGHT. It is the one colour on this bar that belongs to
     Twitch rather than to PlayStation, which is the point: everything in it was
     earned while people were watching. */
  --live:#b07dff;
  --pad-cut:#0b1416;
}
*{box-sizing:border-box}
html,body{margin:0;background:transparent}
body{
  /* SIZE IS A DIAL NOW. Everything below is in em off this one number, so
     ?scale=125 makes the whole bar bigger without a single value being tuned
     by hand. People said the text was small; people also stream at 1080 and at
     1440, so one fixed size was never going to suit both. */
  font-size:calc(15px * var(--s, 1));
  font-family:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  line-height:1.35;color:var(--ink);-webkit-font-smoothing:antialiased;user-select:none;
}
.bar{
  position:fixed;left:0;right:0;display:flex;align-items:center;
  height:calc(3.2em);padding:0 .8em;
  background:linear-gradient(180deg,rgba(8,16,15,.74) 0%,rgba(8,16,15,.93) 100%);
  backdrop-filter:blur(6px);
  /* The shadow does the heavy lifting over a bright game. Every scrap of text
     sits on its own dark edge, so nothing depends on the panel behind it. */
  text-shadow:0 1px 2px rgba(0,0,0,.9), 0 0 6px rgba(0,0,0,.5);
}
.bar.bottom{bottom:0;box-shadow:0 -10px 24px rgba(0,0,0,.34)}
.bar.top{top:0;box-shadow:0 10px 24px rgba(0,0,0,.34)}
/* FLEX:NONE, AND THIS IS THE OVERLAP BUG.
   Every segment is white-space:nowrap, and a nowrap flex item that is allowed
   to shrink does not wrap and does not clip: it keeps its text at full width
   and slides it over its neighbour. So "00.0h" sat on top of the boost chip and
   the chase sat on top of the cabinet, and nothing anywhere reported a problem.
   Segments now hold their size and the bar sheds whole segments instead, in the
   order below. Clipping is the last resort rather than the first symptom. */
.zone{display:flex;align-items:center;min-width:0;flex:none}
.seg{flex:none}
.bar{overflow:hidden}
.zone.mid{margin:0 auto;padding:0 .25em;
  border-left:1px solid rgba(255,255,255,.16);
  border-right:1px solid rgba(255,255,255,.16)}
.mid .seg + .seg{border-left:0}
.spacer{flex:1}
.seg{display:flex;align-items:center;gap:.6em;padding:0 .85em;white-space:nowrap}
.seg + .seg{border-left:1px solid rgba(255,255,255,.16)}
.cover{width:2.1em;height:2.1em;border-radius:.28em;flex:none;object-fit:cover;
  border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.08)}
.game{font-weight:700;max-width:22ch;overflow:hidden;text-overflow:ellipsis}
.plat-chip{font-size:.72em;letter-spacing:.08em;padding:.15em .4em;border-radius:.22em;
  background:rgba(255,255,255,.16);color:var(--ink);font-weight:800}
.num{font-variant-numeric:tabular-nums;font-weight:600}
.pctv{font-size:.86em;font-variant-numeric:tabular-nums;color:var(--soft)}
.track{width:4.6em;height:.36em;border-radius:99px;background:rgba(255,255,255,.24);
  overflow:hidden;flex:none}
.fill{display:block;height:100%;border-radius:99px;background:var(--accent)}
/* The share of the filled bar that happened on stream, laid over the end of it.
   The bar's total width still equals the percentage printed beside it; this
   only says how much of that was tonight. */
.fill .live{
  position:absolute;right:0;top:0;bottom:0;border-radius:99px;background:var(--live);
  box-shadow:0 0 6px rgba(176,125,255,.75);
}
.track{position:relative}
.fill{position:relative}
.onstream{
  color:var(--live);font-weight:800;font-variant-numeric:tabular-nums;font-size:.86em;
}
.ic{width:1em;height:1em;flex:none;opacity:.92}
.ic.pad{width:1.35em;height:1.35em;opacity:1}
.ic svg{width:100%;height:100%;display:block}
.cups{display:flex;align-items:center;gap:.85em}
.cups span{display:flex;align-items:center;gap:.3em;font-weight:700;
  font-variant-numeric:tabular-nums}
.cups svg{width:1.05em;height:1.05em}
.c-plat{color:var(--plat)} .c-gold{color:var(--gold)}
.c-silv{color:var(--silver)} .c-bron{color:var(--bronze)}
/* The same four metals against the game on screen, which is what the board
   shows for a person and nothing showed for the game they are actually
   playing. */
.gcups{display:flex;align-items:center;gap:.6em;font-size:.9em}
.pts{font-weight:800;font-variant-numeric:tabular-nums}
.pts .max{color:var(--soft);font-weight:500}
.rank{font-variant-numeric:tabular-nums;font-weight:800;color:var(--brass);font-size:1.1em}
.rank sup{font-size:.6em;top:-.55em}
.of{color:var(--soft);font-size:.82em}
/* HOW FAR TO THE NEXT ONE. "32nd of 71" says where you are and nothing about
   whether 31st is forty points away or four thousand, which is the only
   question anybody looks at their own rank to answer. */
.gap{color:var(--ink);font-size:.82em;font-variant-numeric:tabular-nums;opacity:.92}
.gap b{color:var(--brass);font-weight:800}
.mult small{font-weight:700;font-size:.78em;letter-spacing:.06em;text-transform:uppercase;
  opacity:.92;margin-left:.35em}
.mult{display:inline-flex;align-items:center;padding:.15em .55em;border-radius:99px;
  background:rgba(240,195,87,.18);border:1px solid rgba(240,195,87,.5);
  color:var(--brass);font-weight:800;font-variant-numeric:tabular-nums;font-size:.95em}
.warn{color:#ff7b74;font-weight:800}
.hold{opacity:.5}
.miss{padding:0 .9em;color:var(--soft)}
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
  /**
   * THE NUMBER ON ITS OWN. It read "x1.13 7 stuck" and the tail was doing more
   * harm than good: seven words of explanation on a bar with no room, for a
   * thing chat asks about anyway. The number is the hook; the streamer is the
   * answer.
   */
  /**
   * ONE WORD, NOT SEVEN. It read "x1.13 7 stuck", which was an explanation
   * nobody had room for; then it read "x1.13", which meant nothing at all to
   * somebody watching. "Boost" says what it does to a stranger and still fits
   * inside the pill.
   */
  return `<span class="seg"><span class="mult">&times;${mult.toFixed(
    2,
  )} <small>boost</small></span></span>`;
}

function leftZone(g, { points = '', onStream = 0 } = {}) {
  if (!g) {
    return `<span class="zone"><span class="miss">Nothing scanned yet</span></span>`;
  }
  const total = Number(g.trophy_count) || 0;
  const got = Number(g.earned_total) || 0;
  const progress = Math.max(0, Math.min(100, Number(g.progress) || 0));

  /**
   * The four metals for THE GAME ON SCREEN.
   *
   * The board has always shown a person's cabinet and nothing ever showed the
   * same breakdown for the thing they are actually playing. A zero is left out
   * rather than printed: a game with no platinum should not show a blank
   * platinum, and half the bar's width goes on noughts otherwise.
   */
  const metals = [
    ['c-plat', g.earned_platinum, 'var(--plat)'],
    ['c-gold', g.earned_gold, 'var(--gold)'],
    ['c-silv', g.earned_silver, 'var(--silver)'],
    ['c-bron', g.earned_bronze, 'var(--bronze)'],
  ];

  /**
   * THE BAR CLIMBS: bronze, silver, gold, platinum if it is in, green at 100.
   *
   * The rule itself lives in barShade so this bar and the two on the website
   * cannot disagree, which they already had: a finished game went green there
   * and stayed platinum here, and Leon has both open at once.
   *
   * NOT SEGMENTS, still. Splitting the bar into coloured bands BY TROPHY TYPE
   * was the other obvious reading and it cannot be honest: PSN's progress
   * percentage is weighted and the trophy counts are not, so the segments would
   * add up to a different width than the number printed beside them.
   */
  const fill = SHADE_VAR[barShade(g)] ?? 'var(--accent)';

  const cups = metals
    .filter(([, v]) => Number(v) > 0)
    .map(([cls, v]) => `<span class="${cls}">${CUP}${n(v)}</span>`)
    .join('');

  /**
   * The purple tail: the share of the FILLED bar that landed tonight.
   *
   * Trophy counts, not the weighted percentage, so it is an approximation of a
   * weighted thing. That is honest enough because the bar's total width still
   * equals the number printed beside it; only the split inside it is by count.
   * Getting this exactly right would mean re-deriving PSN's own weighting, and
   * being wrong about THAT would move the number people read.
   */
  const live = Math.max(0, Number(onStream) || 0);
  const share = got > 0 ? Math.min(1, live / got) : 0;

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
      <span class="track"><i class="fill" style="width:${progress.toFixed(
        2,
      )}%;background:${fill}">${
    share > 0 ? `<i class="live" style="width:${(share * 100).toFixed(2)}%"></i>` : ''
  }</i></span>
      <span class="pctv">${progress.toFixed(2)}%</span>
      ${live > 0 ? `<span class="onstream">+${n(live)} live</span>` : ''}
    </span>
    ${cups ? `<span class="seg s-gcups"><span class="cups gcups">${cups}</span></span>` : ''}
    <span class="seg hold">
      <span class="ic">${CLOCK}</span><span class="num">00.0h</span>
    </span>
    ${points}
  </span>`;
}

/**
 * The points for the game moved LEFT, next to the game they belong to, and
 * they are still part of "ours": hiding the middle with ?mid=0 takes them with
 * it. Martin: "could we have the game points how much its worth on the left
 * hand side next to the time, still count it as the middle section so if people
 * hide our side of things it hides".
 */
function gamePoints(m, g) {
  if (!g) return '';
  const max = displayBanked(g.max_points, m.completion);
  const got = displayBanked(g.points, m.completion);
  return `<span class="seg">
    <span class="pts">${n(got)}<span class="max"> / ${n(max)}</span></span>
  </span>`;
}

/**
 * Ours: what the game is paying extra, where they sit, and how far the next
 * place is.
 */
function midZone(m, g, total, ahead) {
  return `<span class="zone mid">
    ${g ? multiplierChip(g) : ''}
    <span class="seg">
      <span class="rank">${n(m.rank)}<sup>${ordinalMark(m.rank)}</sup></span>
      <span class="of">of ${n(total)}</span>
    </span>
    ${
      /**
       * The chase. Only when there is somebody to chase: first place gets
       * nothing rather than a "0 to 0th", and a member the rescore has not
       * placed yet gets nothing rather than a wrong number.
       */
      ahead
        ? `<span class="seg s-gap"><span class="gap"><b>${n(
            Math.max(0, Number(ahead.points) - Number(m.points)),
          )}</b> to ${n(ahead.rank)}${ordinalMark(ahead.rank)}</span></span>`
        : ''
    }
  </span>`;
}

function rightZone(m) {
  const done = Number(m.completed) || 0;
  const started = Number(m.projects) || 0;
  const pc = Number(m.completion);
  return `<span class="zone">
    <span class="seg s-comp">
      <span class="ic pad">${PAD}</span>
      <span class="num">${n(done)}/${n(started)}</span>
      ${Number.isFinite(pc) && pc > 0 ? `<span class="pctv">${pc.toFixed(2)}%</span>` : ''}
    </span>
    <span class="seg s-cab">
      <span class="cups">
        <span class="c-plat">${CUP}${n(m.platinum)}</span>
        <span class="c-gold">${CUP}${n(m.gold)}</span>
        <span class="c-silv">${CUP}${n(m.silver)}</span>
        <span class="c-bron">${CUP}${n(m.bronze)}</span>
      </span>
    </span>
  </span>`;
}

/**
 * WHAT THE BAR DROPS WHEN IT RUNS OUT OF ROOM.
 *
 * The scale dial made this unavoidable. Everything is sized in em, so
 * ?scale=150 asks for half again as much width, and JFL__Leon's bar wanted
 * 2,640 pixels of content inside a 1,920 pixel canvas. No arrangement of that
 * fits. Something has to go, and the only question is what and in what order.
 *
 * MEASURED, NOT GUESSED. Taken off a rendered bar, in design pixels at scale 1:
 *
 *   title 339 (at the 22ch clamp) · progress 234 · game cups 126 · hours 98
 *   game points 101 · boost 140 · rank 100 · chase 113 · completion 181
 *   cabinet 319
 *
 * SIZED AGAINST THE REAL TITLE. "Indiana Jones and the Great Circle" and "2XKO"
 * are two hundred pixels apart, and a fixed worst-case ladder would strip the
 * cabinet off the 2XKO bar to make room for characters it does not have. The
 * server knows the title, so the estimate uses it.
 *
 * BREAKPOINTS IN REAL PIXELS, computed here. A CSS media query cannot see --s:
 * `em` inside one means the browser's initial font size, not the page's. The
 * server knows the scale, so it does the arithmetic and emits plain pixel
 * breakpoints, which work in whatever Chromium your OBS happens to ship with
 * rather than only in the ones new enough for container queries.
 *
 * THE ORDER IS A JUDGEMENT AND IS MEANT TO BE ARGUED WITH. It is by value per
 * pixel, not by importance alone:
 *
 *   1. padding    nobody can see it go
 *   2. the hours  a placeholder for a board that does not exist yet
 *   3. the cabinet 319 pixels, the biggest single thing on the bar, and the one
 *                 fact here that is also on your profile page
 *   4. the title  clamped shorter, never removed
 *   5. game cups  the same four metals sit two segments to the right
 *   6. the chase  the rank beside it carries most of the meaning alone
 *
 * Never dropped: the game, the progress, the points, the rank, and the boost
 * chip, which only shows up when it has something to say.
 */
const TITLE_CLAMP = 22;
const TITLE_SHORT = 14;
const TITLE_TINY = 8;
const titleWidth = (title, ch) => 95 + 11.1 * Math.min(String(title ?? '').length, ch);

/**
 * SIX PER CENT OF SLACK, because this is an estimate of a thing the browser
 * measures for real. Fonts fall back, digits are wider in some weights than
 * others, and a member with a five figure trophy count is wider than one with
 * three. Erring high means a breakpoint fires a few pixels early, which nobody
 * can see; erring low means the bar overflows, which everybody can.
 */
const SLACK = 1.06;

function responsive(scale, { title, mid, chase }) {
  const natural =
    (titleWidth(title, TITLE_CLAMP) +
      234 + 126 + 98 + 101 + 181 + 319 +
      (mid ? 140 + 100 + (chase ? 113 : 0) : 0)) *
    SLACK;

  // Each step says what it saves. The breakpoint for a step is whatever is
  // still on the bar when everything above it has already gone.
  const steps = [
    [90, '.seg{padding:0 .55em}'],
    [98, '.seg.hold{display:none}'],
    [319, '.seg.s-cab{display:none}'],
    [
      titleWidth(title, TITLE_CLAMP) - titleWidth(title, TITLE_SHORT),
      `.game{max-width:${TITLE_SHORT}ch}`,
    ],
    [126, '.seg.s-gcups{display:none}'],
    [113, '.seg.s-gap{display:none}'],
    /**
     * BELOW HERE IS A BAR NOBODY SHOULD BE ASKING FOR: 200 per cent on a 1280
     * canvas is a strip a tenth of the screen tall. It still has to degrade
     * rather than spill, because the scale is clamped at 200 and anything the
     * clamp allows is something somebody will type.
     */
    [181, '.seg.s-comp{display:none}'],
    [140, '.mult{display:none}'],
    [
      titleWidth(title, TITLE_SHORT) - titleWidth(title, TITLE_TINY),
      `.game{max-width:${TITLE_TINY}ch}`,
    ],
  ];

  let left = natural;
  const out = [];
  for (const [saves, rule] of steps) {
    if (saves <= 0) continue;
    // A little slack so a bar that only just fits is not left touching both
    // edges with nothing between the segments.
    out.push(`@media (max-width:${Math.round(left * scale) + 8}px){${rule}}`);
    left -= saves;
  }
  return '\n' + out.join('\n');
}

/** A bare document. No shared page chrome, because this is not a page. */
const doc = (body, scale = 1, fit = '') => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${REFRESH}">
<title>overlay</title>
<style>${STYLES}</style>
<style>:root{--s:${scale}}${fit}</style>
</head><body>${body}</body></html>`;

export async function onRequestGet({ env, request, params }) {
  const url = mendQuery(new URL(request.url));
  const name = decodeURIComponent(params.name ?? '');

  // Whitelisted, never interpolated. `top` and `bottom` are the only two
  // answers and anything else is somebody guessing at a query string.
  const pos = url.searchParams.get('pos') === 'top' ? 'top' : 'bottom';
  // The middle is opt-out rather than opt-in: a member who has not read any of
  // this should still see the part that makes it ours.
  const showMid = url.searchParams.get('mid') !== '0';

  /**
   * ?scale=125 makes everything bigger.
   *
   * "text is very small" came back from more than one person, and the reason
   * one number cannot fix it is that people stream at 1080 and at 1440 with
   * layouts of every size. The whole bar is sized in em off one root value, so
   * this is a dial rather than a redesign, clamped so nobody can hand a
   * streamer a URL that draws a bar taller than their game.
   */
  const raw = url.searchParams.get('scale');
  /**
   * An ABSENT parameter is not a zero. `Number(null)` is 0, which is perfectly
   * finite, so the first version of this line clamped a plain URL with no
   * scale on it to the minimum and drew everybody's bar at 70 per cent.
   */
  const asked = raw == null || raw.trim() === '' ? NaN : Number(raw);
  const scale = Number.isFinite(asked) ? Math.min(200, Math.max(70, asked)) / 100 : 1;

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

  /**
   * THE LIVE NOTE WINS WHEN IT IS FRESH.
   *
   * `live_play` is written by the poll every few seconds while they stream: the
   * game they last touched and PSN's own counts for it. The scan's row is the
   * fallback and stays the source of every number that turns into points.
   *
   * A note that fails to parse is a note that never existed. This is an
   * overlay on somebody's stream and there is no version of a broken JSON blob
   * that is worth an exception.
   */
  let live = null;
  try {
    const parsed = JSON.parse(member.live_play || 'null');
    if (parsed?.id && Date.now() - Number(parsed.at) < LIVE_PLAY_MS) live = parsed;
  } catch {
    live = null;
  }

  const [playing, totals] = await Promise.all([
    live
      ? env.DB.prepare(ONE_GAME).bind(member.psn_account_id, live.id).first().catch(() => null)
      : env.DB.prepare(PLAYING).bind(member.psn_account_id).first(),
    env.DB.prepare(TOTAL).first(),
  ]);

  /**
   * The scan's row, wearing the poll's numbers.
   *
   * Everything that is a COUNT comes from the live note, because it is seconds
   * old and the stored one is from their last update. Everything that is a
   * PRICE stays exactly as the scan left it: points are the rescore's to
   * decide, and an overlay guessing at them would be the one place on this
   * whole project where a number is invented rather than printed.
   */
  const shown = playing && live
    ? {
        ...playing,
        progress: live.progress,
        earned_total: live.platinum + live.gold + live.silver + live.bronze,
        earned_platinum: live.platinum,
        earned_gold: live.gold,
        earned_silver: live.silver,
        earned_bronze: live.bronze,
      }
    : playing;

  /**
   * Only while they are actually on air. Off stream there is no "tonight" to
   * count, and the query is skipped rather than returning a zero nobody asked
   * for.
   */
  const streaming = Number(member.live_since) > 0
    && Date.now() - (Number(member.live_checked_at) || 0) < LIVE_PLAY_MS;

  const onStream = streaming && shown?.np_comm_id
    ? Number(
        (
          await env.DB.prepare(ON_STREAM)
            .bind(member.psn_account_id, shown.np_comm_id, Number(member.live_since))
            .first()
            .catch(() => null)
        )?.c,
      ) || 0
    : 0;

  const ahead = Number(member.rank) > 1
    ? await env.DB.prepare(AHEAD).bind(Number(member.rank) - 1).first().catch(() => null)
    : null;

  const body = `<div class="bar ${pos}">
    ${leftZone(shown, { points: showMid ? gamePoints(member, shown) : '', onStream })}
    ${showMid ? midZone(member, shown, totals?.c ?? 0, ahead) : '<span class="spacer"></span>'}
    ${rightZone(member)}
  </div>`;

  return new Response(
    doc(body, scale, responsive(scale, {
      title: shown?.title,
      mid: showMid,
      chase: !!ahead,
    })),
    {
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
    },
  );
}
