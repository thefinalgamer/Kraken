/**
 * The HTML shell every page sits in.
 *
 * No framework and no build step, on purpose. This site renders four read-only
 * pages from a database that already holds every number it needs — a framework
 * would add node_modules, a build, and a second thing to keep current, in
 * exchange for nothing. Cloudflare Pages Functions run the same runtime the
 * Worker already uses, so this is the same JavaScript the rest of Kraken is
 * written in.
 *
 * THE STYLES ARE INLINE. One request, no round trip, no cache to invalidate
 * when a colour changes. It is a few kilobytes and it makes the page paint in
 * one pass.
 */

/** Anything from the database goes through this before it reaches the page. */
export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const n = (v) => Number(v ?? 0).toLocaleString('en-GB');

/**
 * Floored, never rounded, exactly as the bot does it.
 *
 * If the site rounded 74.996% up to 75.00% while Discord floored it to 74.99%,
 * the same member would see two different numbers for the same thing and would
 * be right to trust neither.
 */
export const pct = (v) => `${(Math.floor(Number(v ?? 0) * 100) / 100).toFixed(2)}%`;

/** 'GB' becomes 🇬🇧 by offsetting into the regional indicator block. */
export function flag(code) {
  const cc = String(code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * Tiers. MUST agree with tierFor() in shared/ui.mjs.
 *
 * Copied rather than imported because Pages Functions bundle from their own
 * directory and reaching up into shared/ is a build-config fight for eight
 * lines. If the shares or the floors ever change, they change in both places —
 * the scoring spec has the canonical version.
 */
export const TIER = {
  platinum: { name: 'Platinum', color: '#5fc0f0' },
  gold: { name: 'Gold', color: '#f0c419' },
  silver: { name: 'Silver', color: '#b9bbbe' },
  bronze: { name: 'Bronze', color: '#e07b39' },
};

export function tierFor(rank, total) {
  if (!rank || !total) return 'bronze';
  if (rank === 1) return 'platinum';
  const goldMax = Math.max(3, Math.ceil(total * 0.1));
  const silverMax = Math.max(10, Math.ceil(total * 0.33));
  if (rank <= goldMax) return 'gold';
  if (rank <= silverMax) return 'silver';
  return 'bronze';
}

/**
 * A trophy, drawn here rather than fetched from Discord.
 *
 * The obvious move was to hotlink the server's custom emoji from
 * cdn.discordapp.com so the site and the cards match exactly. That is four
 * extra requests per page, four new environment variables to configure, and a
 * standing dependency on Discord continuing to serve images to a domain that
 * is not Discord — which they throttle. The failure mode is four broken images
 * one Tuesday with nothing in any log to say why.
 *
 * At seventeen pixels a trophy is a silhouette and a colour. This is both, it
 * costs one inline path, and it cannot break.
 *
 * `currentColor` on purpose: the .cup class carries the metal, so the count and
 * the cup are always the same colour and there is one place to change it.
 */
export const trophyGlyph = () =>
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
  '<path d="M6 2h12v6a6 6 0 0 1-12 0V2z"/>' +
  '<path d="M6 4H4a2 2 0 0 0-2 2v1a5 5 0 0 0 3.8 4.9l.5-2A3 3 0 0 1 4 7V6h2V4z"/>' +
  '<path d="M18 4h2a2 2 0 0 1 2 2v1a5 5 0 0 1-3.8 4.9l-.5-2A3 3 0 0 0 20 7V6h-2V4z"/>' +
  '<path d="M11 14h2v4h-2z"/><path d="M7 20h10v2H7z"/></svg>';

/** One count with its cup. `metal` is p | g | s | b. */
export const cup = (metal, count, label) =>
  `<span class="cup ${metal}" title="${esc(label)}">${trophyGlyph()}${n(count)}</span>`;

/**
 * The four counts in a row, small, for a game.
 *
 * Zeroes are DIMMED rather than hidden. A row that only shows what you have
 * changes shape from game to game and the eye has to re-read it every line; a
 * fixed four with the empties greyed scans in one movement down the column, and
 * "no golds in this one" is itself worth seeing.
 */
export const miniCups = (p, g, s, b) =>
  `<span class="mini">${[
    ['p', p, 'Platinum'],
    ['g', g, 'Gold'],
    ['s', s, 'Silver'],
    ['b', b, 'Bronze'],
  ]
    .map(
      ([metal, count, label]) =>
        `<span class="mc ${metal}${Number(count) ? '' : ' off'}" title="${esc(label)}">` +
        `${trophyGlyph()}${n(count)}</span>`,
    )
    .join('')}</span>`;

/**
 * Bioluminescence. Specks of light drifting up out of the dark.
 *
 * DETERMINISTIC, not random. A seeded generator rather than Math.random, so the
 * same page renders byte-identical every time — which matters because these
 * responses sit in Cloudflare's edge cache for five minutes and a page that
 * differs on every request is a page that can never be compared, diffed or
 * tested. The pattern looks scattered; it just always scatters the same way.
 *
 * NO JAVASCRIPT. Each mote carries its own duration and a NEGATIVE animation
 * delay, which starts it mid-flight rather than all forty launching together on
 * load. Transform and opacity only, so the browser does it on the GPU and never
 * touches layout.
 *
 * It is at the very bottom of the page and behind everything, so at worst it is
 * ignored. That is the right ceiling for decoration.
 */
const MOTES = 44;
const CUPS = 6;

export function motes() {
  // Lehmer generator. Any fixed seed does; 7 looked best.
  let s = 7;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;

  const out = [];
  for (let i = 0; i < MOTES; i++) {
    const size = (rnd() * 3.4 + 1.3).toFixed(1);
    const left = (rnd() * 100).toFixed(1);
    const start = (rnd() * 62).toFixed(1);
    const peak = (rnd() * 0.55 + 0.35).toFixed(2);
    const dur = (rnd() * 22 + 15).toFixed(1);
    const delay = (-rnd() * 34).toFixed(1);
    const blur = (rnd() * 11 + 5).toFixed(0);
    const rise = (rnd() * 110 + 150).toFixed(0);
    out.push(
      `<i style="--sz:${size}px;--x:${left}%;--y:${start}%;--o:${peak};` +
        `--dur:${dur}s;--delay:${delay}s;--blur:${blur}px;--rise:-${rise}px"></i>`,
    );
  }

  /**
   * A few trophies drifting up with the light.
   *
   * DELIBERATELY FEW, and dimmer than the motes. The joke only works if you
   * catch it — six of them among forty-four specks reads as "was that a trophy?"
   * and rewards a second look. Twenty would read as clip art falling upward.
   *
   * No glow on these: a shape with a halo turns into a blob, and the whole point
   * is that the silhouette is recognisable.
   */
  for (let i = 0; i < CUPS; i++) {
    const size = (rnd() * 9 + 11).toFixed(0);
    const left = (rnd() * 100).toFixed(1);
    const start = (rnd() * 55).toFixed(1);
    const peak = (rnd() * 0.16 + 0.12).toFixed(2);
    const dur = (rnd() * 20 + 26).toFixed(1);
    const delay = (-rnd() * 46).toFixed(1);
    const rise = (rnd() * 120 + 170).toFixed(0);
    const spin = (rnd() * 26 - 13).toFixed(0);
    out.push(
      `<b style="--sz:${size}px;--x:${left}%;--y:${start}%;--o:${peak};` +
        `--dur:${dur}s;--delay:${delay}s;--rise:-${rise}px;--tilt:${spin}deg">` +
        `${trophyGlyph()}</b>`,
    );
  }

  return `<div class="deep" aria-hidden="true">${out.join('')}</div>`;
}

/**
 * Dead, dying, fine — MIRRORED from shared/closing.mjs.
 *
 * Copied for the same reason tierFor() and the contested query are copied: the
 * Pages bundle cannot reach up into shared/ without dragging the scoring module
 * in behind it. The rules are one-liners and the tests pin them on both sides,
 * but this is the second place they live, and if one changes so must the other.
 */
export const DAY_MS = 86400000;
export const URGENT_DAYS = 30;

export function closingState(game, now = Date.now()) {
  if (Number(game?.unobtainable) === 1) return 'dead';
  const at = Number(game?.closes_at);
  if (!Number.isFinite(at) || at <= 0) return 'fine';
  return at <= now ? 'dead' : 'closing';
}

export function closingLabel(closesAt, now = Date.now()) {
  const at = Number(closesAt);
  if (!Number.isFinite(at) || at <= 0) return '';
  if (at <= now) return 'closed';
  const d = Math.ceil((at - now) / DAY_MS);
  if (d === 1) return 'closes tomorrow';
  if (d <= 90) return `closes in ${d} days`;
  return `closes on ${new Date(at).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  })}`;
}

export const isUrgent = (closesAt, now = Date.now()) => {
  const at = Number(closesAt);
  if (!Number.isFinite(at) || at <= now) return false;
  return Math.ceil((at - now) / DAY_MS) <= URGENT_DAYS;
};

/**
 * A d20, drawn as ten shaded faces.
 *
 * NOT WEBGL. A real physics die means three.js plus a physics engine — some six
 * hundred kilobytes and a canvas — to make a shape fall over on a page whose
 * entire stylesheet is a few kilobytes. This is the same illusion for nothing:
 * an icosahedron has exactly ten faces visible head-on, so ten triangles with
 * light coming from the top left read as a solid object, and the tumble does
 * the rest.
 *
 * The geometry is the standard d20 projection: a hexagonal outline, a face
 * triangle in the middle, and the ring of faces between them.
 */
const D20_FACES = [
  // [points, fill]  — lit from the top left, so upper-left faces are brightest.
  ['50,4 10,27 50,32', '#3ee0bd'],
  ['50,4 90,27 50,32', '#2fcfae'],
  ['90,27 50,32 76,70', '#23b89a'],
  ['90,27 90,73 76,70', '#1a9a80'],
  ['90,73 50,96 76,70', '#137964'],
  ['50,96 76,70 24,70', '#0f6353'],
  ['50,96 10,73 24,70', '#12775f'],
  ['10,73 24,70 10,27', '#1b9c81'],
  ['10,27 50,32 24,70', '#28c0a1'],
  // The face pointing at you, brightest, so the eye reads a solid.
  ['50,32 76,70 24,70', '#4bf0cb'],
];

export const d20 = () =>
  '<span class="d20" aria-hidden="true"><svg viewBox="0 0 100 100">' +
  D20_FACES.map(
    ([pts, fill]) =>
      `<polygon points="${pts}" fill="${fill}" stroke="#0a2f28" stroke-width="1.6" ` +
      'stroke-linejoin="round"/>',
  ).join('') +
  '</svg></span>';

/**
 * The address of a game.
 *
 * ONE FUNCTION, because five pages render a game title and every one of them
 * was building this string by hand until the game page existed. The id is a
 * PSN identifier like `NPWR07110_00` — safe characters only — but it is still
 * encoded, because "safe today" is how a URL builder becomes an injection in
 * eighteen months when Sony changes a format.
 */
export const gameHref = (id, as = '') =>
  `/game/${encodeURIComponent(String(id ?? ''))}` +
  (as ? `?as=${encodeURIComponent(String(as))}` : '');

/**
 * The way back, at the TOP of the page.
 *
 * There was one at the bottom, under the trophy list, which on a game with a
 * hundred and thirty-six trophies is four screens of scrolling away — so the
 * only usable way back was the browser's own button, and a site whose
 * navigation is the browser chrome has no navigation. It is a link and not a
 * history.back() because it must say WHERE it goes before it is clicked.
 */
export const crumb = (href, label) =>
  `<nav class="crumb"><a href="${esc(href)}">&lsaquo; ${esc(label)}</a></nav>`;

export const ordinal = (v) => {
  const num = Number(v);
  if (!Number.isFinite(num)) return String(v ?? '');
  const s = ['th', 'st', 'nd', 'rd'];
  const k = num % 100;
  return num + (s[(k - 20) % 10] || s[k] || s[0]);
};

const STYLES = `
:root{
  --deep:#08100f; --ground:#0c1618; --panel:#122024; --edge:#1c3036;
  --ink:#e6efec; --soft:#93a8a6; --faint:#7d939a;
  /* --faint was #63797a, which measured 3.61:1 against the panel. WCAG AA wants
     4.5:1 for text this size, so every timestamp, trophy count and axis label on
     the site was below the line — Martin noticed before any tooling did.
     #7d939a is 5.18:1 and still sits clearly behind --soft (6.67) and
     --ink (14.25), so the three-step hierarchy survives the fix. */
  --kraken:#20b899; --brass:#d8ab3e; --rule:#16272b;
  --up:#4ec98a; --down:#e0645f;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--ground);color:var(--ink);
  font:16px/1.55 "Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;
}
a{color:inherit}
.wrap{max-width:1080px;margin:0 auto;padding:0 clamp(12px,3vw,24px) 72px}

/* THE HEADER IS FULL-BLEED, and that is why it now reads as a header.
   Sitting it inside .wrap made it a row of links floating in the content
   column; a band that runs edge to edge with its own surface is the thing
   every site has at the top, and the eye knows what it is before reading it.

   The logo still sits dead centre of the PAGE — three equal columns rather
   than flex, so it cannot drift when one side has more links than the other. */
header.top{
  background:linear-gradient(180deg,#0e1a1d,#0b1517);
  border-bottom:1px solid var(--edge);margin-bottom:30px;
}
.topin{
  max-width:1080px;margin:0 auto;padding:20px clamp(12px,3vw,24px);
  display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;
}
header.top nav{display:flex;gap:30px;align-items:center;min-width:0}
header.top nav.r{justify-content:flex-end}
header.top nav a,header.top nav span{
  font-size:15px;font-weight:500;letter-spacing:.015em;text-decoration:none;white-space:nowrap;
}
header.top nav a{color:var(--soft)}
header.top nav a:hover{color:var(--kraken)}
header.top nav a.on{color:var(--kraken);font-weight:600}
/* Pages that do not exist yet are NOT links. A dead anchor that 404s is worse
   than a label that says it is coming. */
header.top nav .soon{color:var(--faint);cursor:default;opacity:.55}

.mark{
  display:flex;align-items:center;gap:13px;text-decoration:none;justify-self:center;
}
/* No CSS ring around it — the artwork brings its own, and two concentric
   circles at this size is mud. */
.mark img{width:60px;height:60px;flex:0 0 60px;display:block}
.mark b{font-size:26px;font-weight:700;letter-spacing:-.015em}
.stats{color:var(--soft);font-size:13.5px;font-variant-numeric:tabular-nums}
@media (max-width:720px){
  .topin{grid-template-columns:1fr;justify-items:center;gap:12px;padding:16px}
  header.top nav{order:2;gap:22px} header.top nav.r{order:3;justify-content:center}
  .mark{order:1}
  .mark img{width:48px;height:48px;flex:0 0 48px}
  .mark b{font-size:22px}
}

.tablewrap{overflow-x:auto;border:1px solid var(--edge);border-radius:10px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--rule);white-space:nowrap}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:#16262b}
th{
  font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);
  font-weight:600;cursor:pointer;user-select:none;position:sticky;top:0;background:var(--panel);
}
th:hover{color:var(--kraken)}
th[aria-sort]{color:var(--kraken)}
th.num,td.num{text-align:right}
th:focus-visible{outline:2px solid var(--kraken);outline-offset:-2px}

td.rank{color:var(--faint);font-size:13px;width:1%}
.hunter{display:flex;align-items:center;gap:9px;min-width:0}
.av{width:26px;height:26px;border-radius:50%;flex:0 0 26px;background:var(--edge);object-fit:cover}
.name{font-weight:600;overflow:hidden;text-overflow:ellipsis}
.tier{
  font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;
  padding:2px 7px;border-radius:99px;border:1px solid currentColor;
}
.pts{font-weight:700}
.move{font-size:12px;width:1%}
.move.u{color:var(--up)} .move.d{color:var(--down)} .move.s{color:var(--faint)}
.tro{color:var(--soft);font-size:13px}


/* ---- hunter page ---- */
/* Name and face centred, the way a profile reads. The numbers used to sit up
   here too and were competing with it; they live in the bar below now. */
.hero{display:flex;flex-direction:column;align-items:center;text-align:center;gap:9px;margin:4px 0 16px}
.bigav{width:76px;height:76px;border-radius:50%;background:var(--edge);object-fit:cover}
.hero h1{margin:0;font-size:26px;letter-spacing:-.015em}
.hero .sub{margin:0;color:var(--soft);font-size:13.5px;display:flex;align-items:center;gap:9px}

/* One bar: what they have won on the left, what it is worth on the right. */
.cups{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:0 0 18px;padding:10px 16px;
  border:1px solid var(--edge);border-radius:10px;background:var(--panel)}
.cup{display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums;font-size:15px;font-weight:600}
.cup svg{width:17px;height:17px;flex:0 0 17px;display:block}
.cup.p{color:#7fd6f5} .cup.g{color:#f0c419} .cup.s{color:#c9ccd1} .cup.b{color:#e08a4a}

/* Each stat is centred over its own value rather than right-aligned. FINISHED
   is much wider than POINTS, so right-aligning pinned its label to the page
   edge and left it hanging away from the number it belongs to. */
.facts{display:flex;gap:26px;margin:0 0 0 auto;flex-wrap:wrap}
.facts div{text-align:center}
.facts dt{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.facts dd{margin:1px 0 0;font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}
@media (max-width:640px){ .facts{margin:6px 0 0;width:100%;justify-content:space-between;gap:12px} }

/* Search. A form, submitted with Enter — never on keystroke. Every search is a
   full scan of that member's library, so live filtering would be thirty
   queries for one word. */
.find{display:flex;gap:8px;margin:0 0 12px}
.find input{flex:1 1 auto;min-width:0;background:var(--panel);color:var(--ink);
  border:1px solid var(--edge);border-radius:8px;padding:7px 11px;font:inherit;font-size:14px}
.find input:focus{outline:none;border-color:var(--kraken)}
.find button{background:var(--panel);color:var(--soft);border:1px solid var(--edge);
  border-radius:8px;padding:7px 14px;font:inherit;font-size:13.5px;cursor:pointer}
.find button:hover{color:var(--ink);border-color:var(--faint)}
.found{color:var(--faint);font-size:13px;margin:0 0 12px}
.found a{color:var(--kraken)}

.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}
.tab{
  font-size:12.5px;padding:5px 11px;border-radius:99px;text-decoration:none;
  color:var(--soft);border:1px solid var(--edge);white-space:nowrap;
}
.tab:hover{color:var(--ink);border-color:var(--faint)}
.tab.on{color:var(--deep);background:var(--kraken);border-color:var(--kraken);font-weight:600}

/* The accent strip, from the old site, on the right and full height.

   IT NOW MATCHES THE PROGRESS BAR AND APPEARS ON EVERY ROW. Blue-or-green-or-
   nothing left a ragged column of gaps beside every game somebody had merely
   started; the strip carries the same shade as the fill, so the column reads
   unbroken all the way down and says the same thing twice rather than two
   different things once.

   STICKY, so it survives a phone. The table scrolls sideways on a narrow
   screen and the strip is the last cell, which meant it sat permanently off
   the right-hand edge — the one place the design was doing the most work was
   the one place nobody could see it. position:sticky pins it to the viewport
   edge while everything else slides underneath. */
td.bar,th.bar{width:4px;padding:0;background:transparent}
tr.sh-b  td.bar{background:#e08a4a}
tr.sh-s  td.bar{background:#c9ccd1}
tr.sh-g  td.bar{background:#f0c419}
tr.sh-p  td.bar{background:#4a9eff}
tr.sh-ok td.bar{background:var(--up)}
/* Nothing earned yet: the track colour, so the column has no hole in it but
   does not claim a trophy that was never won. */
tr.sh-none td.bar{background:var(--rule)}

/* Chunkier rows — scoped to the game table only, so the 64-row leaderboard
   stays dense. The 40px icon and 9px padding fitted more games on a screen than
   anybody wanted; a library is browsed, not audited. */
/* border-collapse: separate. Kept from the sticky attempt below — it changes
   nothing visually because every border is on the cells already. */
.games{border-collapse:separate;border-spacing:0}

/* ON A PHONE THE STRIP MOVES TO THE LEFT EDGE, and this is the third attempt.
   position:sticky on the last <td> was the elegant version and it did not work
   on a real handset, twice. The table scrolls sideways, the strip is the last
   cell, and the right edge of that table is simply somewhere the phone never
   shows without scrolling.

   The left edge, though, is where every phone starts. So on narrow screens the
   right-hand cell is hidden and the colour becomes a border on the first cell
   instead — no sticky, no scroll container, nothing that can quietly stop
   working. Different edge on mobile than desktop is a small inconsistency and
   an invisible strip is a missing feature; the trade is not close. */
@media (max-width:640px){
  .games td.bar,.games th.bar{display:none}
  .games td.gi{border-left:4px solid var(--rule);padding-left:10px}
  .games tr.sh-b  td.gi{border-left-color:#e08a4a}
  .games tr.sh-s  td.gi{border-left-color:#c9ccd1}
  .games tr.sh-g  td.gi{border-left-color:#f0c419}
  .games tr.sh-p  td.gi{border-left-color:#4a9eff}
  .games tr.sh-ok td.gi{border-left-color:var(--up)}
}
.games th,.games td{padding:14px 14px}
.games td.gi,.games th.gi{width:1%;padding-right:0}
.games .ico{width:56px;height:56px;border-radius:8px;display:block;background:var(--edge);object-fit:cover}
.games .tname{font-size:15.5px}
.games td.bar,.games th.bar{padding:0}
.of-max{color:var(--faint);font-weight:400}

/* PS4 / PS5, as a chip. It was grey text lost in the metadata line and it is
   the first thing anybody looks for when they own a game twice. */
.plat-chip{
  display:inline-block;font-size:10px;font-weight:700;letter-spacing:.06em;
  padding:2px 6px;border-radius:5px;border:1px solid var(--edge);
  background:var(--ground);color:var(--soft);vertical-align:1px;margin-right:7px;
}

/* The per-game trophy breakdown. Zeroes dimmed, never dropped — see miniCups(). */
.mini{display:inline-flex;gap:9px;align-items:center;margin-left:2px}
.mc{display:inline-flex;align-items:center;gap:3px;font-size:12px;font-weight:600;
  font-variant-numeric:tabular-nums}
.mc svg{width:11px;height:11px;flex:0 0 11px;display:block}
.mc.p{color:#7fd6f5} .mc.g{color:#f0c419} .mc.s{color:#c9ccd1} .mc.b{color:#e08a4a}
.mc.off{color:var(--faint);opacity:.5}
.tcount{display:block;font-size:12px;color:var(--faint);margin-top:4px;font-variant-numeric:tabular-nums}

/* The progress bar. Fills to the progress percentage; the colour is the best
   trophy earned, and green once the whole game is done. */
td.prog{min-width:112px}
.track{display:block;height:4px;border-radius:99px;background:var(--rule);margin-top:5px;overflow:hidden}
.fill{display:block;height:100%;border-radius:99px}
.fill.b{background:#e08a4a} .fill.s{background:#c9ccd1}
.fill.g{background:#f0c419} .fill.p{background:#7fd6f5}
.fill.ok{background:var(--up)}
.gt{white-space:normal;min-width:220px;position:relative}
.tname{font-weight:600}
.gt .meta{display:block;font-size:12px;color:var(--faint);margin-top:2px}
.warn{color:var(--brass);cursor:help}
/* Dying is not dead, so it does not wear the dead colour. Amber for "you have
   time", the brass warning for "you do not". */
.clock{color:var(--kraken)}
.clock.soon{color:#f0c419}
.flagwrap.clock summary{color:inherit}
.flagwrap.clock summary:hover{background:rgba(32,184,153,.14)}
.flagwrap.clock.soon summary:hover{background:rgba(240,196,25,.16)}
.closes{
  display:block;font-size:11.5px;font-weight:600;margin-top:3px;color:#f0c419;
}
.closes.later{color:var(--kraken)}

/* The unobtainable note, tappable.
   A title attribute is invisible on a touch screen, so on a phone there was no
   way at all to find out WHY a game was flagged. <details> opens on tap, click
   and keyboard, costs no JavaScript, and gives the note somewhere to live. */
/* The note is a POPOVER, not an inline block.
   Opened inline it grew inside its own inline-block, shoving the icon up off
   the title's baseline and squeezing the game name sideways. Hanging it below
   the row on absolute position keeps every other pixel exactly where it was
   whether it is open or shut. */
.flagwrap{display:inline-block;vertical-align:middle;margin-left:6px}
.flagwrap summary{
  list-style:none;cursor:pointer;color:var(--brass);display:inline-block;
  /* A 24px target. The glyph is 14px, which is under every touch guideline
     going, and this is a control people are meant to find. */
  padding:2px 6px;margin:-2px -6px;border-radius:6px;
}
.flagwrap summary::-webkit-details-marker{display:none}
.flagwrap summary:hover{background:rgba(216,171,62,.14)}
.flagwrap[open] summary{background:rgba(216,171,62,.18)}
.flagnote{
  position:absolute;left:0;top:calc(100% + 6px);z-index:6;
  padding:9px 11px;border-radius:8px;
  background:var(--deep);border:1px solid var(--edge);
  box-shadow:0 8px 24px rgba(0,0,0,.45);
  color:var(--soft);font-size:12.5px;font-weight:400;line-height:1.5;
  white-space:normal;width:max-content;max-width:min(42ch,70vw);
}
.flagnote b{color:var(--ink)}
.done{color:var(--up);font-weight:600}
.zero{color:var(--faint)}

.pager{display:flex;align-items:center;gap:16px;justify-content:center;margin:16px 0 0;font-size:13.5px}
.pager a{color:var(--kraken);text-decoration:none}
.pager a:hover{text-decoration:underline}
.pager .of{color:var(--faint)}

.name a{color:inherit;text-decoration:none}
.name a:hover{color:var(--kraken);text-decoration:underline}


/* ---- where the points came from ---- */
.split{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 18px;padding:0;list-style:none}
.split li{flex:1 1 160px;border:1px solid var(--edge);border-radius:9px;padding:9px 12px;background:var(--panel)}
.split .k{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);display:block}
.split .v{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;display:block;margin-top:1px}
.split .d{font-size:11.5px;color:var(--faint);display:block;margin-top:2px}
.split .pos{color:var(--up)} .split .neg{color:var(--down)}

/* ---- the dice ---- */
/* The trigger sits IN the row with "Show the numbers" and Rivals, which is what
   that row was half-empty for. */
.toolrow{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:0 0 14px}
.toolrow details.numbers{margin:0}
.rollcta{display:inline-flex;align-items:center;gap:7px;color:var(--kraken);
  text-decoration:none;font-weight:600;font-size:13.5px;white-space:nowrap}
.rollcta:hover{text-decoration:underline}
.rollcta .d20{width:18px;height:18px}

/* THE THROW.
   It falls in from above the panel, lands, bounces twice and settles — once,
   then it stops. A die that never settles is a spinner, and a spinner means
   "still loading" to everybody who has ever used a computer.

   Transform and opacity only, so the browser does the whole thing on the
   compositor and never touches layout. The shadow underneath is a separate
   element squashing on each impact, which is most of why it reads as weight
   rather than as a picture sliding down the screen. */
.d20{display:inline-block;line-height:0;position:relative}
.d20 svg{width:100%;height:100%;display:block;filter:drop-shadow(0 3px 5px rgba(0,0,0,.5))}

.rolled .d20{width:46px;height:46px;animation:throw 1.15s cubic-bezier(.3,.7,.4,1) both}
.rolled .d20::after{
  content:"";position:absolute;left:12%;right:12%;bottom:-7px;height:7px;
  border-radius:50%;background:rgba(0,0,0,.55);filter:blur(3px);
  animation:landshadow 1.15s cubic-bezier(.3,.7,.4,1) both;
}
@keyframes throw{
  0%   {transform:translate3d(-46px,-150px,0) rotate(-620deg) scale(.5); opacity:0}
  12%  {opacity:1}
  /* first contact */
  42%  {transform:translate3d(0,0,0) rotate(-26deg) scale(1.06)}
  /* big bounce */
  56%  {transform:translate3d(4px,-30px,0) rotate(12deg) scale(.97)}
  70%  {transform:translate3d(0,0,0) rotate(4deg) scale(1.04)}
  /* small bounce */
  82%  {transform:translate3d(1px,-9px,0) rotate(-3deg) scale(.99)}
  92%  {transform:translate3d(0,0,0) rotate(0) scale(1.01)}
  100% {transform:translate3d(0,0,0) rotate(0) scale(1)}
}
@keyframes landshadow{
  0%   {opacity:0;   transform:scale(.3)}
  40%  {opacity:0;   transform:scale(.5)}
  /* squashes wide on each impact, shrinks while the die is in the air */
  44%  {opacity:.62; transform:scale(1.18)}
  56%  {opacity:.24; transform:scale(.66)}
  70%  {opacity:.55; transform:scale(1.08)}
  82%  {opacity:.3;  transform:scale(.82)}
  100% {opacity:.45; transform:scale(1)}
}
/* The picks land after the die does, one after another, so it reads as a result
   rather than as a page that happened to contain a die. */
.rolls li{animation:land .42s ease-out both}
.rolls li:nth-child(2){animation-delay:.09s}
.rolls li:nth-child(3){animation-delay:.18s}
@keyframes land{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}

@media (prefers-reduced-motion:reduce){
  .rolled .d20,.rolls li{animation:none}
}
.panel.roll{margin:0 0 18px}
.panel.roll h2{gap:9px}
.panel.roll h2 .d20{color:var(--kraken)}
.rlabel{margin:12px 0 6px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--faint);font-weight:700}
.rlabel:first-of-type{margin-top:2px}
ul.rolls{list-style:none;margin:0;padding:0}
ul.rolls li{display:flex;gap:12px;align-items:center;padding:9px 0;border-bottom:1px solid var(--rule)}
ul.rolls li:last-child{border-bottom:none}
ul.rolls .ico{width:48px;height:48px;flex:0 0 48px;border-radius:8px}
ul.rolls .rb{min-width:0}
ul.rolls .t{display:block;font-weight:600;font-size:15px}
ul.rolls .s{display:block;color:var(--faint);font-size:12.5px;margin-top:2px}
ul.rolls .s b{color:var(--soft)}

details.numbers{margin:0 0 18px}
details.numbers summary{cursor:pointer;color:var(--soft);font-size:13px;padding:4px 0}
details.numbers summary:hover{color:var(--kraken)}
/* Holding the space for the private board so the layout does not jump when it
   lands, and so somebody asks about it before it exists. */
.soon-tag{
  margin-left:14px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--faint);border:1px solid var(--edge);border-radius:99px;padding:2px 9px;
  opacity:.7;
}

/* ---- the deep ----
   Bioluminescence at the foot of every page. The gradient does the depth; the
   motes do the life. Fixed to the viewport bottom rather than the document, so
   it is there on a short page and still there after scrolling a long one.

   POINTER-EVENTS NONE and z-index 0: it must never intercept a click or sit in
   front of a word. It is the floor of the room, not furniture. */
.deep{
  position:fixed;left:0;right:0;bottom:0;height:min(46vh,420px);
  pointer-events:none;z-index:0;overflow:hidden;
  background:linear-gradient(180deg,transparent 0%,#0a1315 55%,#060c0d 100%);
}
.deep i{
  position:absolute;display:block;border-radius:50%;background:var(--kraken);
  width:var(--sz);height:var(--sz);left:var(--x);bottom:var(--y);opacity:0;
  box-shadow:0 0 var(--blur) 0 var(--kraken),0 0 calc(var(--blur) * 2) 0 rgba(32,184,153,.45);
  animation:drift var(--dur) linear var(--delay) infinite;
  will-change:transform,opacity;
}
.deep b{
  position:absolute;display:block;color:var(--kraken);
  width:var(--sz);height:var(--sz);left:var(--x);bottom:var(--y);opacity:0;
  animation:driftcup var(--dur) linear var(--delay) infinite;
  will-change:transform,opacity;
}
.deep b svg{width:100%;height:100%;display:block}
@keyframes driftcup{
  0%   {transform:translateY(0) rotate(var(--tilt));        opacity:0}
  16%  {                                                    opacity:var(--o)}
  70%  {                                                    opacity:var(--o)}
  100% {transform:translateY(var(--rise)) rotate(calc(var(--tilt) * -1));opacity:0}
}
@keyframes drift{
  0%   {transform:translateY(0);        opacity:0}
  14%  {                                opacity:var(--o)}
  72%  {                                opacity:var(--o)}
  100% {transform:translateY(var(--rise));opacity:0}
}
/* Anybody who has asked their system for less motion gets the light without the
   movement. The effect is atmosphere, and atmosphere is not worth making
   somebody queasy for. */
@media (prefers-reduced-motion:reduce){
  .deep i,.deep b{animation:none;opacity:var(--o)}
}
/* Everything the page actually says sits above it. */
.wrap,header.top{position:relative;z-index:1}

/* The site credit, on every page. PLACEHOLDER LINK until Martin's domain is
   finished — see the to-do list in the project doc. It renders as plain text
   rather than a dead anchor, because a link that goes nowhere is worse than no
   link, and swapping the text for an href later is a one-line change. */
.credit{
  margin-top:44px;padding:20px 0 0;border-top:1px solid var(--rule);
  display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;
  color:var(--faint);font-size:12.5px;
}
.credit .by{text-align:center}
.credit .by b{color:var(--soft);font-weight:600}
/* Sony's name appears on this site constantly — platforms, trophies, the whole
   premise. The disclaimer is not decoration; it is the sentence that makes it
   obvious this is a fan project. Bottom left, quiet, on every page. */
.credit .legal{text-align:left;line-height:1.5;opacity:.85}
.credit .end{text-align:right}
@media (max-width:720px){
  .credit{grid-template-columns:1fr;text-align:center}
  .credit .legal,.credit .end{text-align:center}
}

/* ---- front page ---- */
/* The front page has NO top bar. It carries the same four links as buttons in
   the middle instead, so the navigation is not drawn twice on one screen. It is
   the only page on the site shaped this way, which is deliberate rather than an
   oversight: a door and a room do not need the same furniture. */
.wrap.bare{padding-top:7vh}
.doormark{width:132px;height:132px;display:block;margin:0 auto}
.doornav{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin:8px 0 0}
.doornav a,.doornav span{
  padding:11px 22px;border-radius:10px;border:1px solid var(--edge);text-decoration:none;
  font-size:15px;font-weight:600;color:var(--ink);background:var(--panel);
}
.doornav a:hover{border-color:var(--kraken);color:var(--kraken)}
.doornav .primary{background:var(--kraken);border-color:var(--kraken);color:var(--deep)}
.doornav .primary:hover{filter:brightness(1.08);color:var(--deep);border-color:var(--kraken)}
.doornav .soon{color:var(--faint);opacity:.55;background:transparent;cursor:default}

.hero.home{text-align:center;gap:14px;margin:10px 0 26px}
.hero.home h1{font-size:clamp(28px,4.8vw,44px);line-height:1.14;margin:0;max-width:18ch}
.hero.home h1 span{color:var(--kraken)}
.lede{margin:0;max-width:62ch;color:var(--soft);font-size:15.5px;line-height:1.6}
.cta{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin:6px 0 0}
.btn{
  display:inline-block;padding:10px 20px;border-radius:9px;text-decoration:none;
  border:1px solid var(--edge);color:var(--ink);font-size:14.5px;font-weight:600;
}
.btn:hover{border-color:var(--faint)}
.btn.primary{background:var(--kraken);border-color:var(--kraken);color:var(--deep)}
.btn.primary:hover{filter:brightness(1.08)}

.totals{
  display:flex;flex-wrap:wrap;gap:10px;margin:30px 0 22px;padding:0;list-style:none;
}
.totals div{
  flex:1 1 150px;border:1px solid var(--edge);border-radius:10px;background:var(--panel);
  padding:12px 14px;text-align:center;
}
.totals dt{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.totals dd{margin:3px 0 0;font-size:21px;font-weight:700;font-variant-numeric:tabular-nums}

/* Two columns, so four panels land as a tidy 2x2 rather than three across with
   one stranded underneath. auto-fit did that: it fitted three at 1100px and
   left "Newest hunters" alone in a half-empty row. */
.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
@media (max-width:860px){ .cols{grid-template-columns:1fr} }
.panel{border:1px solid var(--edge);border-radius:10px;background:var(--panel);padding:14px 16px 16px}
.panel h2{
  margin:0 0 10px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--faint);font-weight:700;display:flex;align-items:center;gap:10px;
}
.panel h2 a{margin-left:auto;color:var(--kraken);text-decoration:none;
  font-size:11px;letter-spacing:.06em;text-transform:none;font-weight:600}
.panel h2 a:hover{text-decoration:underline}
.panel .empty{padding:14px 0;color:var(--soft);text-align:left}
.panel .note{margin:10px 0 0;color:var(--faint);font-size:12px;line-height:1.55}

ol.top{list-style:none;margin:0;padding:0}
ol.top li{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--rule)}
ol.top li:last-child{border-bottom:none}
ol.top .pos{color:var(--faint);font-size:12.5px;width:2.4em;flex:0 0 auto}
/* min-width:0 is what actually lets this ellipsis. Without it the flex item
   refuses to shrink below its content and the NAME is what gets cut, which is
   the one thing in the row nobody can guess from context. */
ol.top .who{font-weight:600;text-decoration:none;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;min-width:0;flex:1 1 auto}
ol.top .who:hover{color:var(--kraken)}
ol.top .val{margin-left:auto;font-weight:700;font-variant-numeric:tabular-nums}

ul.feed{list-style:none;margin:0;padding:0}
ul.feed li{padding:7px 0;border-bottom:1px solid var(--rule)}
ul.feed li:last-child{border-bottom:none}
ul.feed .t{display:block;font-weight:600;font-size:14.5px}
ul.feed .t a{text-decoration:none}
ul.feed .t a:hover{color:var(--kraken)}
ul.feed .s{display:block;color:var(--faint);font-size:12.5px;margin-top:1px}
ul.feed .s a{color:var(--soft);text-decoration:none}
ul.feed .s a:hover{color:var(--kraken)}
ul.feed.people li{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;
  column-gap:10px;align-items:center}
ul.feed.people .av{grid-row:1 / span 2;width:30px;height:30px;flex:0 0 30px}

/* ---- the game page ----
   The first page here whose subject is a game rather than a person, so it gets
   the same furniture as a hunter — a hero, a cabinet bar, sort tabs, one table
   — and none of its own. A site where every page invents a layout is four
   sites. */
.ghero{display:flex;align-items:center;gap:18px;margin:4px 0 16px}
.bigico{width:96px;height:96px;border-radius:12px;flex:0 0 96px;background:var(--edge);
  object-fit:cover;box-shadow:0 6px 18px rgba(0,0,0,.4)}
.gh{min-width:0}
.gh h1{margin:0;font-size:clamp(21px,3.4vw,30px);letter-spacing:-.015em;line-height:1.2}
.gh h1 .plat-chip{vertical-align:middle;margin-right:9px}
.gh .sub{margin:5px 0 0;color:var(--soft);font-size:14px;display:flex;align-items:center;
  gap:9px;flex-wrap:wrap}
.gh .sub b{color:var(--ink);font-weight:700}
@media (max-width:520px){
  .ghero{gap:13px}
  .bigico{width:66px;height:66px;flex:0 0 66px}
}

/* The index and any other page with a title but no face. */
.hero.plain{align-items:flex-start;text-align:left;gap:5px;margin:6px 0 16px}
.hero.plain .sub{color:var(--soft)}

/* A guess, labelled. PSN publishes no rarity for some games — usually ones
   released this week — so the bot prices those from the trophy mix alone. The
   number is still the number; the word beside it is the difference between a
   scoring system and a scoring argument. */
.est{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--brass);
  border:1px solid var(--edge);border-radius:99px;padding:2px 8px;font-weight:600}
.est.sm{margin-left:7px;padding:1px 6px;font-size:9.5px}

/* THE DEADLINE, FULL WIDTH, ABOVE EVERYTHING.
   In a table this is an icon, because a table has forty rows and forty
   sentences is a wall. On the page ABOUT that one game it is a sentence, at the
   top, before the trophy list — you cannot make an informed decision about a
   game after you have read its trophy list. Same two states as everywhere:
   the triangle is a closed door, the clock is an invitation with a deadline. */
p.warn{display:flex;gap:11px;align-items:flex-start;margin:0 0 16px;padding:11px 14px;
  border:1px solid var(--edge);border-radius:10px;background:var(--panel);
  font-size:13.5px;line-height:1.55;color:var(--soft);cursor:auto}
p.warn .mk{font-size:17px;line-height:1.2;flex:0 0 auto}
p.warn b{color:var(--ink);font-weight:600}
p.warn.dead{border-color:rgba(216,171,62,.4)}
p.warn.clock{border-color:rgba(32,184,153,.4)}
p.warn.clock.soon{border-color:rgba(240,196,25,.45)}

/* ---- the trophy list ----
   PS5 CARDS, NOT A TABLE. The console draws a trophy as a wide card with a
   slight lean and a hairline of dark between each one, and everybody on this
   server has scrolled thousands of them on a DualSense. A table of the same
   information is correct and reads like a spreadsheet; the cards read like the
   thing people already know, and the lean is most of why.

   The skew is on the CARD and unskewed on its contents, which is the only way
   to get a parallelogram without italicising every word inside it. Three
   degrees — enough to see, not enough to make the icons look broken. */
.tlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.tc{
  position:relative;transform:skewX(-3deg);border-radius:5px;overflow:hidden;
  background:var(--panel);border:1px solid var(--edge);
}
.tcin{
  transform:skewX(3deg);display:flex;align-items:center;gap:14px;
  padding:11px 20px 11px 16px;
}
/* The metal, as the left edge of the card. Same vocabulary as the accent strip
   on every table: colour means which trophy, never how far along. */
.tc::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--rule)}
.tc.m-p::before{background:#4a9eff}
.tc.m-g::before{background:#f0c419}
.tc.m-s::before{background:#c9ccd1}
.tc.m-b::before{background:#e08a4a}

.tic{width:52px;height:52px;flex:0 0 52px;border-radius:8px;display:block;
  background:var(--edge);object-fit:cover}
span.tic{display:flex;align-items:center;justify-content:center}
span.tic svg{width:26px;height:26px}
.tcb{min-width:0;flex:1 1 auto}
.tcb .tname{display:block;font-weight:700;font-size:15px;color:var(--soft)}
.tcb .tdet{display:block;font-size:12.5px;color:var(--faint);margin-top:2px;
  line-height:1.45;max-width:70ch}

/* A HEADER, because the table had one and the cards do not.
   "28 / 30" with nothing above it is a riddle. Three words once, at the top,
   answer it for the whole page — and the widths and gaps are the same numbers
   as .tcr below, so the labels sit over their own columns. */
.tlhead{display:flex;justify-content:flex-end;gap:22px;padding:0 20px 7px 0;
  font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);
  font-weight:700}
.tlhead span{text-align:right}
.tlhead .h-rare{min-width:82px}
.tlhead .h-local{min-width:64px}
.tlhead .h-pts{min-width:52px}
@media (max-width:720px){ .tlhead{display:none} }

/* BRIGHTNESS, NOT HUE, and this replaces a pink.
   The first version ramped through pink, purple and blue. Nobody could say what
   pink meant, because it meant nothing — PlayStation has no colour language for
   rarity, so the ramp was inventing one and then not printing the legend. The
   word beside the number IS the legend, and it was already there.
   Now the only encoding is weight and brightness: the rarer it is, the more it
   stands out, on the same three-step text hierarchy as the rest of the site.
   Nothing to look up, and it still scans down the column. */
.rb{display:block;font-weight:600;font-variant-numeric:tabular-nums;color:var(--soft)}
.rb.ur{color:#fff;font-weight:800}
.rb.vr{color:var(--ink);font-weight:700}
.rb.r{color:var(--ink)}
.rb.u{color:var(--soft)}
.rb.c{color:var(--faint);font-weight:500}
.rb.none{color:var(--faint);font-weight:500}
.rl{display:block;font-size:11px;color:var(--faint);margin-top:3px;letter-spacing:.02em}
.tc.got .rb.c,.tc.got .rb.none{color:var(--soft)}

/* The rarity, the local count and the points, right-aligned in fixed columns so
   the eye can run straight down them the way it could in the table. */
.tcr{display:flex;align-items:center;gap:22px;flex:0 0 auto;text-align:right}
.tcr .rare{min-width:82px}
/* NO BAR HERE ANY MORE. There was a progress bar under this count and it was
   answering a question nobody asked: it filled with how many OTHER people had
   the trophy, so your own finished trophy sat under a half-empty bar. The
   fraction says the same thing and cannot be misread as your progress. */
.tcr .local{min-width:64px;font-variant-numeric:tabular-nums;font-weight:600;
  color:var(--soft)}
.tcr .local .of-max{font-weight:400}
.tcr .lcap{display:block;font-size:11px;color:var(--faint);margin-top:3px}
.tcr .tpts{min-width:52px;font-weight:700;font-variant-numeric:tabular-nums;
  font-size:16px;color:var(--soft)}

/* EARNED. On the console an earned trophy is lit and an unearned one is not,
   and that difference does more work than any label. The wash is the metal,
   fading out to the right so the text stays readable over it. */
.tc.got{border-color:rgba(255,255,255,.14);background:#16252a}
.tc.got .tcb .tname{color:#fff}
.tc.got .tcb .tdet{color:var(--soft)}
.tc.got .tpts,.tc.got .local{color:var(--ink)}
/* The four are NOT the same strength, because the four colours are not equally
   loud on a dark ground. Silver at the same opacity as bronze reads brighter
   than gold, which would make the cheapest trophies the most eye-catching thing
   on the page — so silver is pulled well down and the rest are trimmed until a
   screen full of earned bronzes stops looking like one brown block. */
.tc.got.m-p{background:linear-gradient(100deg,rgba(74,158,255,.26),rgba(74,158,255,.04) 55%,transparent)}
.tc.got.m-g{background:linear-gradient(100deg,rgba(240,196,25,.24),rgba(240,196,25,.04) 55%,transparent)}
.tc.got.m-s{background:linear-gradient(100deg,rgba(201,204,209,.14),rgba(201,204,209,.03) 55%,transparent)}
.tc.got.m-b{background:linear-gradient(100deg,rgba(224,138,74,.22),rgba(224,138,74,.04) 55%,transparent)}
/* A green tick on the right edge, because on a phone the wash is the first
   thing a dim screen loses. */
.tc.got::after{content:"";position:absolute;right:0;top:0;bottom:0;width:4px;background:var(--up)}

/* Only dim the unearned ones when somebody's trophies are actually being shown.
   With no viewer set, nothing here is "not done" — it is just a trophy list,
   and half-fading all of it would be a lie about a page nobody is signed in to. */
.tlist.viewing .tc:not(.got){opacity:.62}

/* Whose list this is. */
.viewbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px;
  padding:8px 14px;border:1px solid var(--edge);border-radius:99px;background:var(--panel);
  font-size:13px;color:var(--soft);width:fit-content;max-width:100%}
.viewbar b{color:var(--ink)}
.viewbar .av{width:22px;height:22px;flex:0 0 22px}
.viewbar a{color:var(--kraken);text-decoration:none}
.viewbar a:hover{text-decoration:underline}
.vchip{font-size:11.5px;color:var(--faint);border:1px solid var(--edge);border-radius:99px;
  padding:2px 10px;text-decoration:none;white-space:nowrap}
.vchip:hover{color:var(--kraken);border-color:var(--kraken)}
.vchip.on{color:var(--deep);background:var(--kraken);border-color:var(--kraken);font-weight:600}

/* A DLC pack, exactly as the console groups them. */
.tgroup{display:flex;align-items:center;gap:12px;margin:22px 0 9px;
  font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);
  font-weight:700}
.tgroup:first-of-type{margin-top:0}
.tgroup img{width:26px;height:26px;border-radius:5px;flex:0 0 26px;object-fit:cover}
.tgroup .gcount{margin-left:auto;letter-spacing:0;text-transform:none;font-weight:500}

.crumb{margin:0 0 12px;font-size:13px}
.crumb a{color:var(--faint);text-decoration:none}
.crumb a:hover{color:var(--kraken)}

@media (max-width:720px){
  /* The skew goes on a phone. A parallelogram costs horizontal room on both
     sides, and there is none — the flourish is not worth clipping a name.

     A GRID, NOT A WRAPPED FLEX ROW. Letting the flex line wrap put the icon
     alone on the first line with forty pixels of nothing beside it, because a
     flex item that is told to take the full width takes it. Two columns with
     the icon spanning both rows keeps the name next to its own trophy — the
     same shape the feed lists on the front page already use. */
  .tc{transform:none}
  .tcin{transform:none;display:grid;grid-template-columns:auto 1fr;
    column-gap:12px;row-gap:9px;align-items:start;padding:11px 13px}
  .tic{grid-row:1 / span 2;width:42px;height:42px;flex:0 0 42px}
  .tcb{min-width:0;grid-column:2}
  .tcr{grid-column:2;justify-content:space-between;gap:10px;text-align:left;
    align-items:flex-end}
  .tcr .rare,.tcr .local,.tcr .tpts{min-width:0}
  .tcr .tpts{text-align:right}
}

/* ---- secret trophies ----
   BLURRED, NOT WITHHELD. The text is in the HTML, exactly as it is on every
   other trophy site, because a reveal that costs a round trip is a reveal
   nobody clicks. What the blur buys is not secrecy from somebody determined —
   it is that you cannot be spoiled BY ACCIDENT while scrolling a game you have
   not played, which is the whole of the actual risk.

   A checkbox and a sibling selector: no JavaScript, works on a phone, and it is
   one control for the page instead of a button on every row. The input is
   off-screen rather than display:none, because a hidden input cannot be
   focused and the label would stop working from a keyboard. */
.spoilbox{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.spoillabel{display:inline-flex;align-items:center;gap:8px;cursor:pointer;
  color:var(--soft);font-size:13px;border:1px solid var(--edge);border-radius:99px;
  padding:5px 13px;background:var(--panel);user-select:none}
.spoillabel::before{content:"\\2609";font-size:14px;line-height:1;color:var(--faint)}
.spoillabel:hover{color:var(--ink);border-color:var(--faint)}
.spoilbox:focus-visible + .toolrow .spoillabel{outline:2px solid var(--kraken);outline-offset:2px}
.spoilbox:checked + .toolrow .spoillabel{color:var(--kraken);border-color:var(--kraken)}
.spoilbox:checked + .toolrow .spoillabel::before{content:"\\25C9";color:var(--kraken)}

.secret .spoil{filter:blur(5px);opacity:.75;transition:filter .18s ease,opacity .18s ease}
/* The row keeps its shape while blurred — the text is still there, just
   unreadable — so revealing does not reflow the table under the reader's
   thumb. */
.spoilbox:checked ~ .tlist .secret .spoil,
.spoilbox:checked ~ .tgroup + .tlist .secret .spoil,
.spoilbox:checked ~ .tablewrap .secret .spoil{filter:none;opacity:1}
.secretmark{display:inline-block;margin-top:5px;font-size:10px;letter-spacing:.08em;
  text-transform:uppercase;color:var(--brass);border:1px solid var(--edge);
  border-radius:99px;padding:2px 8px}
@media (prefers-reduced-motion:reduce){ .secret .spoil{transition:none} }

/* The index stripe. A game on its own has no progress — only a clock. */
tr.st-dead  td.bar{background:var(--brass)}
tr.st-soon  td.bar{background:#f0c419}
tr.st-clock td.bar{background:var(--kraken)}
tr.st-none  td.bar{background:var(--rule)}
@media (max-width:640px){
  .games tr.st-dead  td.gi{border-left-color:var(--brass)}
  .games tr.st-soon  td.gi{border-left-color:#f0c419}
  .games tr.st-clock td.gi{border-left-color:var(--kraken)}
}

/* ---- who here has it ---- */
.games a.tname{color:inherit;text-decoration:none}
.games a.tname:hover{color:var(--kraken);text-decoration:underline}
.games a.who{color:inherit;text-decoration:none;font-weight:600;font-size:15px}
.games a.who:hover{color:var(--kraken);text-decoration:underline}
.games .av{width:34px;height:34px;flex:0 0 34px}
ul.feed a.t{color:inherit;text-decoration:none}
ul.feed a.t:hover{color:var(--kraken)}
ul.rolls a.t{color:inherit;text-decoration:none}
ul.rolls a.t:hover{color:var(--kraken)}

footer{margin-top:26px;color:var(--faint);font-size:13px;line-height:1.7}
footer b{color:var(--soft);font-weight:500}
.empty{padding:40px;text-align:center;color:var(--soft)}
@media (max-width:640px){
  .hide-s{display:none}
  th,td{padding:8px 9px}
}
`;

/**
 * The navigation.
 *
 * `here` marks the current page. Everything not built yet is a SPAN, not an
 * anchor — a link that 404s teaches people the site is broken, while a dimmed
 * label teaches them it is coming. They flip to real links as the pages land.
 */
/**
 * ONE list of what this site has, rendered two ways.
 *
 * The header splits it left and right around the logo; the front page draws the
 * same four as buttons. Keeping it as a single array means a page can never
 * exist in one navigation and not the other, which is exactly the bug that
 * turns up six months later when somebody adds a route in a hurry.
 */
export const NAV = [
  { href: '/leaderboard', label: 'Leaderboard', key: 'board' },
  { href: '/games', label: 'Games', key: 'games' },
  { label: 'Contested', key: 'contested' },
  // The door. Everything else on this site is a window.
  { href: 'https://discord.com/invite/gdSqDYrXaH', label: 'Discord', key: 'discord', out: true },
];
const NAV_LEFT = NAV.slice(0, 2);
const NAV_RIGHT = NAV.slice(2);

/**
 * `rel="noopener noreferrer"` on the outbound link is not superstition: without
 * noopener the page we open gets a handle on ours through window.opener and can
 * navigate it somewhere else. Discord would not, but the habit is what protects
 * the link we add without thinking about it in eight months.
 */
const navLinks = (items, here) =>
  items
    .map((i) => {
      if (!i.href) return `<span class="soon" title="Coming soon">${esc(i.label)}</span>`;
      const attrs = i.out ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${esc(i.href)}"${i.key === here ? ' class="on"' : ''}${attrs}>${esc(i.label)}</a>`;
    })
    .join('');

/**
 * The same four, as buttons, for the front page.
 *
 * Unbuilt pages stay spans here too. A door with a dead handle on it is worse
 * than a door with three handles and a label saying the fourth is coming.
 */
export const navButtons = () =>
  NAV.map((i) => {
    if (!i.href) return `<span class="soon">${esc(i.label)}</span>`;
    const attrs = i.out ? ' target="_blank" rel="noopener noreferrer"' : '';
    const cls = i.key === 'board' ? ' class="primary"' : '';
    return `<a href="${esc(i.href)}"${cls}${attrs}>${esc(i.label)}</a>`;
  }).join('');

/**
 * @param bare  suppress the top bar. The front page carries its own navigation
 *   as buttons in the middle of the page, and drawing the header as well would
 *   be the same four links twice on one screen.
 */
export function page({ title, body, description = '', here = '', bare = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
<meta name="color-scheme" content="dark">
<link rel="icon" href="/Kraken.png" type="image/png">
<link rel="apple-touch-icon" href="/Kraken.png">
<style>${STYLES}</style>
</head>
<body>
${motes()}
${
  bare
    ? ''
    : `<header class="top">
  <div class="topin">
    <nav class="l">${navLinks(NAV_LEFT, here)}</nav>
    <a class="mark" href="/" aria-label="Kraken home"><img src="/Kraken.png" alt="" width="60" height="60"><b>Kraken</b></a>
    <nav class="r">${navLinks(NAV_RIGHT, here)}</nav>
  </div>
</header>`
}
<div class="wrap${bare ? ' bare' : ''}">
  ${body}
  <div class="credit">
    <span class="legal">Kraken is a fan project and is not affiliated with,<br>
      endorsed by or connected to Sony or PlayStation.</span>
    <span class="by">Brought to you by <b>Happy Squid Studios</b></span>
    <span class="end">Joining happens in Discord.</span>
  </div>
</div>
</body>
</html>`;
}

export const html = (markup, { status = 200, maxAge = 300 } = {}) =>
  new Response(markup, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // maxAge 0 means genuinely never store it, not "store it for no seconds":
      // a random picker served from any cache is not random.
      'Cache-Control': maxAge > 0
        ? `public, max-age=${maxAge}, s-maxage=${maxAge}`
        : 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
