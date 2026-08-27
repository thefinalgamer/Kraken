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
    <p class="brand"><a href="/" style="text-decoration:none">Hunters Lodge</a> <span>· Platinum Intel</span></p>
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
