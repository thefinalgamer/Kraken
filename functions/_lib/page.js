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
  return `<div class="deep" aria-hidden="true">${out.join('')}</div>`;
}

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

/* The logo sits dead centre with the navigation either side of it. Three
   equal columns rather than flex, so the mark stays centred on the PAGE and
   does not drift when one side has more links than the other. */
header.top{
  display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;
  padding:18px 0 16px;border-bottom:1px solid var(--rule);margin-bottom:24px;
}
header.top nav{display:flex;gap:22px;align-items:center;min-width:0}
header.top nav.r{justify-content:flex-end}
header.top nav a,header.top nav span{
  font-size:14px;letter-spacing:.01em;text-decoration:none;white-space:nowrap;
}
header.top nav a{color:var(--soft)}
header.top nav a:hover{color:var(--kraken)}
header.top nav a.on{color:var(--kraken);font-weight:600}
/* Pages that do not exist yet are NOT links. A dead anchor that 404s is worse
   than a label that says it is coming. */
header.top nav .soon{color:var(--faint);cursor:default;opacity:.55}

.mark{
  display:flex;align-items:center;gap:10px;text-decoration:none;justify-self:center;
}
/* No CSS ring around it — the artwork brings its own, and two concentric
   circles at 36px is mud. */
.mark img{width:38px;height:38px;flex:0 0 38px;display:block}
.mark b{font-size:17px;font-weight:700;letter-spacing:-.01em}
.stats{color:var(--soft);font-size:13.5px;font-variant-numeric:tabular-nums}
@media (max-width:720px){
  header.top{grid-template-columns:1fr;justify-items:center;gap:10px}
  header.top nav{order:2} header.top nav.r{order:3;justify-content:center}
  .mark{order:1}
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

/* The accent strip, from the old site. Blue = the platinum is in, green =
   everything is, DLC included, nothing at all otherwise.

   ON THE RIGHT, FULL HEIGHT, which is where Esto had it. On the left it was
   fighting the icon for the same edge; on the right it closes the row off and
   the eye reads it as the row's verdict rather than as decoration in front of
   the artwork. Four pixels — enough to see down a page of fifty, not enough to
   shout over the game itself. */
td.bar,th.bar{width:4px;padding:0;background:transparent}
tr.plat td.bar{background:#4a9eff}
tr.full td.bar{background:var(--up)}

/* Chunkier rows — scoped to the game table only, so the 64-row leaderboard
   stays dense. The 40px icon and 9px padding fitted more games on a screen than
   anybody wanted; a library is browsed, not audited. */
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
.gt{white-space:normal;min-width:220px}
.tname{font-weight:600}
.gt .meta{display:block;font-size:12px;color:var(--faint);margin-top:2px}
.warn{color:var(--brass);cursor:help}
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

details.numbers{margin:0 0 18px}
details.numbers summary{cursor:pointer;color:var(--soft);font-size:13px;padding:4px 0}
details.numbers summary:hover{color:var(--kraken)}

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
  .deep i{animation:none;opacity:var(--o)}
}
/* Everything the page actually says sits above it. */
.wrap{position:relative;z-index:1}

/* The site credit, on every page. PLACEHOLDER LINK until Martin's domain is
   finished — see the to-do list in the project doc. It renders as plain text
   rather than a dead anchor, because a link that goes nowhere is worse than no
   link, and swapping the text for an href later is a one-line change. */
.credit{
  margin-top:44px;padding:22px 0 0;border-top:1px solid var(--rule);
  text-align:center;color:var(--faint);font-size:12.5px;
}
.credit .by{display:flex;align-items:center;justify-content:center;gap:8px}
.credit .by b{color:var(--soft);font-weight:600}
.credit .logo{width:22px;height:22px;flex:0 0 22px;opacity:.85}
.credit .small{display:block;margin-top:7px;opacity:.8}

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
const NAV_LEFT = [
  { href: '/', label: 'Leaderboard', key: 'board' },
  { label: 'Games', key: 'games' },
];
const NAV_RIGHT = [
  { label: 'Contested', key: 'contested' },
  // The door. Everything else on this site is a window.
  { href: 'https://discord.com/invite/gdSqDYrXaH', label: 'Discord', key: 'discord', out: true },
];

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

export function page({ title, body, description = '', here = '' }) {
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
<div class="wrap">
  <header class="top">
    <nav class="l">${navLinks(NAV_LEFT, here)}</nav>
    <a class="mark" href="/" aria-label="Kraken home"><img src="/Kraken.png" alt="" width="38" height="38"><b>Kraken</b></a>
    <nav class="r">${navLinks(NAV_RIGHT, here)}</nav>
  </header>
  ${body}
  <div class="credit">
    <span class="by">Brought to you by <b>Happy Squid Studios</b></span>
    <span class="small">Kraken scores PlayStation trophies for Platinum Intel. Joining happens in Discord.</span>
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
      'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge}`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
