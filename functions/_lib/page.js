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
  --ink:#e6efec; --soft:#93a8a6; --faint:#63797a;
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

header.top{
  display:flex;align-items:center;gap:14px;flex-wrap:wrap;
  padding:22px 0 18px;border-bottom:1px solid var(--rule);margin-bottom:22px;
}
.mark{
  width:38px;height:38px;border-radius:50%;flex:0 0 38px;
  border:2px solid var(--kraken);display:grid;place-items:center;font-size:19px;
}
.brand{font-size:19px;font-weight:700;letter-spacing:-.01em;margin:0}
.brand span{color:var(--faint);font-weight:400}
.stats{margin-left:auto;color:var(--soft);font-size:13.5px;font-variant-numeric:tabular-nums}

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
.hero{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:0 0 18px}
.bigav{width:72px;height:72px;border-radius:50%;flex:0 0 72px;background:var(--edge);object-fit:cover}
.who h1{margin:0;font-size:23px;letter-spacing:-.015em}
.who .sub{margin:3px 0 0;color:var(--soft);font-size:13.5px}
.facts{display:flex;gap:26px;margin:0 0 0 auto;flex-wrap:wrap}
.facts div{text-align:right}
.facts dt{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.facts dd{margin:2px 0 0;font-size:19px;font-weight:700;font-variant-numeric:tabular-nums}

/* The four trophy counts. Drawn, not fetched — see trophyGlyph(). */
.cups{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0 18px;padding:9px 14px;
  border:1px solid var(--edge);border-radius:10px;background:var(--panel)}
.cup{display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums;font-size:15px;font-weight:600}
.cup svg{width:17px;height:17px;flex:0 0 17px;display:block}
.cup.p{color:#7fd6f5} .cup.g{color:#f0c419} .cup.s{color:#c9ccd1} .cup.b{color:#e08a4a}

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

/* The accent bar, copied from the old site because it was the best thing on it.
   Blue = the platinum is in. Green = everything is, DLC included. Nothing at
   all otherwise, so the eye only lands on finished work. */
td.bar{width:4px;padding:0;background:transparent}
tr.plat td.bar{background:#4a9eff}
tr.full td.bar{background:var(--up)}

td.gi,th.gi{width:1%;padding-right:0}
.ico{width:40px;height:40px;border-radius:6px;display:block;background:var(--edge);object-fit:cover}
.of-max{color:var(--faint);font-weight:400}

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
.gt .meta{display:block;font-size:11.5px;color:var(--faint);margin-top:1px}
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

footer{margin-top:26px;color:var(--faint);font-size:13px;line-height:1.7}
footer b{color:var(--soft);font-weight:500}
.empty{padding:40px;text-align:center;color:var(--soft)}
@media (max-width:640px){
  .hide-s{display:none}
  th,td{padding:8px 9px}
}
`;

export function page({ title, body, description = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
<meta name="color-scheme" content="dark">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="mark">🐙</div>
    <p class="brand"><a href="/" style="text-decoration:none">Kraken</a> <span>· Platinum Intel</span></p>
  </header>
  ${body}
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
