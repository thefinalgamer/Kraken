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
 * The sentence behind the warning triangle in a list.
 *
 * TWO GAMES, TWO COMPLETELY DIFFERENT TOOLTIPS, and that was the bug. GTA V
 * was flagged trophy by trophy, so the rollup wrote itself a note and the row
 * read "27 trophies can no longer be earned." Fall Guys was flagged with
 * "every trophy", so the stored note was the moderator's own sentence and the
 * row hovered into a paragraph about a free-to-play re-release in May 2022.
 * Both games are dead; only one of them said so in the first four words.
 *
 * The count is DERIVED here rather than read out of the note, so the lead
 * sentence is the same shape however the flag got there.
 *
 * A WHOLLY DEAD GAME GETS THE ONE LINE AND NOTHING ELSE. JFL__Leon, having
 * asked for the count in the first place: "take out the bottom line, just the
 * top line only". He is right, and the reason is that on a game where nothing
 * at all can be earned the reason changes nothing you would do about it. You
 * are not picking your way around four broken trophies, you are not starting
 * it, and the sentence has already told you so.
 *
 * A PARTLY BROKEN GAME KEEPS ITS NOTE, because there the note is the useful
 * half: "4 trophies unobtainable, UGC servers shut down 31st August 2026" says
 * WHICH ones and is the difference between avoiding a game and avoiding a
 * corner of it. The moderator's words are printed in full on the game page
 * either way, so nothing anybody typed is ever lost.
 *
 * `\n` in a title attribute is a real line break in every browser that shows
 * titles at all. Phones show none of this, which is why the game page carries
 * the same information as text.
 */
/**
 * WHAT COLOUR IS THIS PROGRESS BAR.
 *
 * ONE FUNCTION, THREE SURFACES. The hunter page, the game page and the overlay
 * each computed this themselves and had already drifted: the website turned a
 * finished game green and the overlay never did, so the same game was two
 * colours depending on which window Leon had open. Anything that draws a game
 * bar calls this now.
 *
 * THE RULE IS THE PERCENTAGE, NOT THE METALS, and that was a real decision
 * rather than the obvious one. Colouring by the best trophy earned meant the
 * bar could jump to gold in the first hour and then never move again for
 * twenty, which on an overlay that is on screen for a four hour stream is dead
 * pixels. Bands climb. Martin: "for people who dont stream they want to see
 * that climb".
 *
 * The cost is that the colour now says the same thing as the number printed
 * beside it. That is accepted, because the bar's second job belongs to purple:
 * a streamer's bar goes purple for the share earned on air, and most of this
 * server streams everything, so for them the colour is the badge and the bands
 * are what the rest of us get. Two audiences, one bar, neither wasted.
 *
 * PLATINUM STILL OVERRIDES. A platinum in a game with DLC left is a fact no
 * percentage can express: 70% with the plat in is a different thing from 70%
 * without it. Green is 100% and only 100%.
 */
const BAND_SILVER = 40;
const BAND_GOLD = 70;

export function barShade(g) {
  const progress = Math.max(0, Math.min(100, Number(g?.progress) || 0));
  if (progress >= 100) return 'ok';
  if (Number(g?.earned_platinum) > 0) return 'p';
  if (progress >= BAND_GOLD) return 'g';
  if (progress >= BAND_SILVER) return 's';
  // A game touched at all is bronze, even where PSN's weighting rounds the
  // percentage to nothing. An untouched one takes the bare track.
  if (progress > 0 || Number(g?.earned_total) > 0) return 'b';
  return 'none';
}

/**
 * The same six answers as a colour, for the overlay, which has its own palette
 * and no stylesheet in common with the site.
 */
export const SHADE_VAR = {
  b: 'var(--bronze)', s: 'var(--silver)', g: 'var(--gold)',
  p: 'var(--plat)', ok: 'var(--accent)', none: 'var(--accent)',
};

/**
 * A SECOND QUESTION MARK IS A TYPO, SO TREAT IT AS ONE.
 *
 * JFL__Leon spent a morning on `?pos=top?scale=150`. That is not a broken link
 * in any way a browser will tell you about: `pos` comes back as the string
 * "top?scale=150", which is not "top" so the bar quietly moves to the bottom,
 * and `scale` comes back null so the size is quietly ignored. Two settings lost
 * and no error anywhere. He and Martin went round OBS transforms and source
 * heights for twenty minutes.
 *
 * These links are typed by hand into a text box in OBS, where being wrong is
 * invisible until you are live. A literal `?` inside a value is always a
 * mistake, because a real one would arrive as %3F, so every one after the first
 * is what the person meant to be an `&`.
 *
 * MENDED, NOT REJECTED. An error message would be better than silence, but a
 * bar that works is better than both, and there is nobody to show an error to:
 * the audience is a browser source with no address bar.
 */
export function mendQuery(url) {
  if (!url.search.includes('?', 1)) return url;
  url.search = url.search.replace(/\?/g, (m, i) => (i === 0 ? m : '&'));
  return url;
}

const GENERATED_NOTE = /can no longer be earned|has unobtainable trophies/i;

export function deadTitle(g) {
  const total = Number(g.trophy_count) || 0;
  const dead = Number(g.dead_trophies || 0);
  const whole = total > 0 && dead >= total;

  const lead = whole
    ? `All ${total} troph${total === 1 ? 'y' : 'ies'} in this game can no longer be earned.`
    : dead > 0
      ? `${dead} troph${dead === 1 ? 'y' : 'ies'} can no longer be earned.`
      : 'Some trophies in this game can no longer be earned.';

  if (whole) return lead;

  // A note that is itself a generated count adds nothing but a second copy of
  // the line above it.
  const note = String(g.unobtainable_note ?? '').trim();
  return note && !GENERATED_NOTE.test(note) ? `${lead}\n${note}` : lead;
}

/**
 * A d20. TWENTY TRIANGLES IN ACTUAL THREE DIMENSIONS.
 *
 * The first version was ten flat polygons in an SVG, shaded to LOOK like a
 * solid and tumbled with a 2D rotation. It read well enough, and it was a
 * drawing of a die rather than a die — spin it and the illusion is over,
 * because a flat thing rotating is still flat.
 *
 * This is the real shape. Twenty equilateral triangles placed on the faces of
 * an icosahedron with matrix3d, inside a preserve-3d context, so the browser
 * does genuine perspective on genuine geometry. It rotates on any axis and
 * stays a solid from every angle, because it IS one.
 *
 * AND IT COSTS ABOUT THREE KILOBYTES. Rejecting three.js was right — six
 * hundred kilobytes and a WebGL canvas to drop a shape on a page whose entire
 * stylesheet is a few KB. What was wrong was concluding that no 3D was
 * affordable. CSS has had 3D transforms for over a decade and they cost
 * nothing but the numbers.
 *
 * THE MATHS IS PRE-COMPUTED, NOT DERIVED AT RUNTIME. Face positions, in-plane
 * rotations and per-face lighting are all baked into the transforms below by a
 * generator, so the browser evaluates twenty static matrices and no JavaScript
 * ever runs. Regenerating them is a script, not an edit — hand-tweaking one of
 * these matrices will simply put a hole in the solid.
 *
 * The lighting is baked to each FACE rather than to the world, which is
 * physically wrong: turn the die and the light turns with it. It does not
 * matter for a second of tumbling, and the throw ends on a whole number of
 * turns so the die comes to rest in the same orientation it started — lit from
 * the top left, which is the only frame anybody actually looks at.
 */
const D20_FACES = 20;

export const d20 = () =>
  '<span class="d20" aria-hidden="true"><span class="dscale"><span class="dspin">' +
  '<i></i>'.repeat(D20_FACES) +
  '</span></span></span>';

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

/**
 * The supporter star. A five-pointed star inside a ring.
 *
 * MIRRORED FROM shared/supporter.mjs, exactly as TIER is, because Pages
 * Functions bundle from their own directory. If the thresholds change they
 * change in both places — the shared file is the canonical one.
 *
 * A GLYPH, NEVER A WORD. The leaderboard already has a column reading GOLD and
 * SILVER for rank, so a supporter badge that also SAID gold would be two metal
 * rankings on one row meaning different things. A small star cannot be confused
 * with a bordered pill; only the tooltip spells it out.
 *
 * COSMETIC. It sits beside a name and touches nothing that decides an order.
 */
const SUPPORTER_TIERS = [
  { months: 12, key: 'p', name: 'Platinum' },
  { months: 6, key: 'g', name: 'Gold' },
  { months: 3, key: 's', name: 'Silver' },
  { months: 1, key: 'b', name: 'Bronze' },
];

export function supporterTier(months) {
  const m = Math.floor(Number(months) || 0);
  if (m < 1) return null;
  return SUPPORTER_TIERS.find((t) => m >= t.months) ?? null;
}

/**
 * `aria-hidden` on the drawing and a real label on the wrapper: a screen reader
 * hears "Gold supporter, 8 months" once, rather than reading out a star path.
 */
export function supporterStar(months) {
  const tier = supporterTier(months);
  if (!tier) return '';
  const m = Math.floor(Number(months) || 0);
  const label = `${tier.name} supporter \u00b7 ${m} month${m === 1 ? '' : 's'}`;
  return (
    `<span class="star ${tier.key}" title="${esc(label)}" role="img" aria-label="${esc(label)}">` +
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="10.6" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
    '<path fill="currentColor" d="M12 5.4l1.94 3.93 4.34.63-3.14 3.06.74 4.32L12 15.3l-3.88 2.04.74-4.32L5.72 9.96l4.34-.63z"/>' +
    '</svg></span>'
  );
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
  /* Tonight. Used only for things that happened in front of an audience, which
     is why it is nowhere else on the site. */
  --live:#b07dff;
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
.wrap{max-width:1280px;margin:0 auto;padding:0 clamp(12px,3vw,24px) 72px}
/* 1080 was a reading measure, and most of this site is not prose — it is
   tables and trophy cards with four numbers on the right, which had a
   hand's width of nothing down both sides on any real monitor. Long game
   titles and descriptions stop wrapping at 1280 and nothing else changes. */

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

.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px;align-items:center}
/* Centred under the mark, for the one page whose tabs are the page's subject
   rather than a control on it. Everywhere else the tabs sort a list that is
   already there, so they belong at the left edge with it. */
.tabs.centre{justify-content:center;margin:0 0 18px}
.tab{
  font-size:12.5px;padding:5px 11px;border-radius:99px;text-decoration:none;
  color:var(--soft);border:1px solid var(--edge);white-space:nowrap;
}
.tab:hover{color:var(--ink);border-color:var(--faint)}
.tab.on{color:var(--deep);background:var(--kraken);border-color:var(--kraken);font-weight:600}
/* A TAB THAT IS NOT A LINK, because the board behind it does not exist yet.
   Dimmed, dashed, no hover, no cursor — everything about it says "not now"
   before anybody wastes a click on it. Same rule as the unbuilt entries in the
   header: a dead handle is worse than a note saying the door is coming.
   The word rides inside the tab rather than beside it so the row cannot wrap
   into a label orphaned from the thing it labels. */
.tab.soon{
  color:var(--faint);border-style:dashed;cursor:default;opacity:.75;
  display:inline-flex;align-items:center;gap:8px;
}
.tab.soon:hover{color:var(--faint);border-color:var(--edge)}
.tab.soon i{
  font-style:normal;font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--brass);border:1px solid var(--edge);border-radius:99px;padding:1px 7px;
}

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
.fill{display:block;height:100%;border-radius:99px;position:relative}
.track{position:relative}
/* Earned in front of an audience, on the end of the fill. Purple is used
   nowhere else on this site, so it needs no legend. */
.fill .onair{
  position:absolute;right:0;top:0;bottom:0;border-radius:99px;background:var(--live);
}
.livecount{
  display:block;margin-top:2px;color:var(--live);font-size:11px;font-weight:700;
  letter-spacing:.02em;
}
.fill.b{background:#e08a4a} .fill.s{background:#c9ccd1}
.fill.g{background:#f0c419} .fill.p{background:#7fd6f5}
.fill.ok{background:var(--up)}
.gt{white-space:normal;min-width:220px;position:relative}
.tname{font-weight:600}
.gt .meta{display:block;font-size:12px;color:var(--faint);margin-top:2px}
/* Dying is not dead, so it does not wear the dead colour. Amber for "you have
   time", the brass warning for "you do not". */
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
/* The mark beside a game title, and the line under it.
   THIS REPLACED A POPUP, and the popup is worth remembering: it was a
   <details> whose panel was absolutely positioned inside .tablewrap. That
   wrapper sets overflow-x:auto so a wide table can scroll on a phone — and CSS
   promotes the other axis to auto the moment one axis stops being visible,
   so a panel hanging below the table quietly turned the table into a scroll
   box. Reading a flag meant scrolling a container nobody knew existed.
   A mark and a sentence cannot overflow anything. */
.mk{margin-left:6px;vertical-align:middle;cursor:help}
.mk.dead{color:var(--brass)}
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
/* ALIGN TO THE TOP, NOT THE MIDDLE.
   With align-items:center, opening "Show the numbers" made its <details> tall
   and every sibling centred itself against that new height, so Rivals and the
   deal link slid half a table down the page and snapped back when it shut.
   Aligned to the start, the three summaries stay on one line and the open panel
   grows underneath without touching anything beside it. */
.toolrow{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;margin:0 0 14px}
/* Matching the 4px the <details> summaries carry, so the three sit on one line
   rather than one riding a few pixels high. */
.toolrow .rollcta{padding:4px 0}
.toolrow details.numbers{margin:0}
.rollcta{display:inline-flex;align-items:center;gap:7px;color:var(--kraken);
  text-decoration:none;font-weight:600;font-size:13.5px;white-space:nowrap}
.rollcta:hover{text-decoration:underline}
.rollcta .d20{width:18px;height:18px;flex:0 0 18px}

/* THE THROW.
   It falls in from above the panel, tumbles, bounces twice and settles — once,
   then it stops. A die that never settles is a spinner, and a spinner means
   "still loading" to everybody who has ever used a computer.

   Three nested elements, each with one job, because they change for different
   reasons: the stage holds the perspective and the layout box, the scaler sets
   how big the die is, and only the spinner is animated. Putting the size on the
   same element as the animation means the keyframes have to restate it, and the
   first thing anybody forgets when editing a keyframe is the bit that was only
   there to stop the die changing size.

   Transform and opacity only, so the browser does the whole thing on the
   compositor and never touches layout. The shadow underneath is a separate
   element squashing on each impact, which is most of why it reads as weight
   rather than as a picture sliding down the screen. */
.d20{display:inline-block;position:relative;width:18px;height:18px;
  perspective:360px;vertical-align:-3px}
.dscale{position:absolute;left:50%;top:50%;transform-style:preserve-3d;
  transform:scale(.36)}
.dspin{display:block;width:0;height:0;position:relative;transform-style:preserve-3d}
/* Each face is an equilateral triangle whose transform-origin is its own
   centroid, so the matrices below only have to say where that centroid goes and
   which way the face points. */
.dspin i{
  position:absolute;width:26px;height:22.517px;left:-13px;top:-15.011px;
  clip-path:polygon(50% 0,100% 100%,0 100%);
  transform-origin:50% 66.667%;
  backface-visibility:hidden;
}
.dspin i:nth-child(1){transform:matrix3d(0.31829,-0.83329,0.515,0,-0.77843,0.11357,0.66486,0,-0.57735,-0.57735,-0.57735,0,-11.34481,-11.34481,-11.34481,1);background:rgb(33,173,139)}
.dspin i:nth-child(2){transform:matrix3d(1.03,0,0,0,0,-0.36753,0.9622,0,0,-0.93417,-0.35682,0,0,-18.35629,-7.01148,1);background:rgb(39,209,168)}
.dspin i:nth-child(3){transform:matrix3d(-0.83329,-0.515,0.31829,0,-0.4811,0.89201,0.18376,0,-0.35682,0,-0.93417,0,-7.01148,0,-18.35629,1);background:rgb(14,76,61)}
.dspin i:nth-child(4){transform:matrix3d(-0.83329,0.515,-0.31829,0,0.4811,0.89201,0.18376,0,0.35682,0,-0.93417,0,7.01148,0,-18.35629,1);background:rgb(14,76,61)}
.dspin i:nth-child(5){transform:matrix3d(0.31829,0.83329,-0.515,0,0.77843,0.11357,0.66486,0,0.57735,-0.57735,-0.57735,0,11.34481,-11.34481,-11.34481,1);background:rgb(14,76,61)}
.dspin i:nth-child(6){transform:matrix3d(0,0,1.03,0,-0.36753,0.9622,0,0,-0.93417,-0.35682,0,0,-18.35629,-7.01148,0,1);background:rgb(46,246,198)}
.dspin i:nth-child(7){transform:matrix3d(0.83329,-0.515,0.31829,0,0.11357,0.66486,0.77843,0,-0.57735,-0.57735,0.57735,0,-11.34481,-11.34481,11.34481,1);background:rgb(61,255,255)}
.dspin i:nth-child(8){transform:matrix3d(0.515,-0.31829,-0.83329,0,0.89201,0.18376,0.4811,0,0,-0.93417,0.35682,0,0,-18.35629,7.01148,1);background:rgb(57,255,244)}
.dspin i:nth-child(9){transform:matrix3d(-0.31829,-0.83329,0.515,0,0.18376,0.4811,0.89201,0,-0.93417,0.35682,0,0,-18.35629,7.01148,0,1);background:rgb(20,109,87)}
.dspin i:nth-child(10){transform:matrix3d(-0.515,0.31829,0.83329,0,0.66486,0.77843,0.11357,0,-0.57735,0.57735,-0.57735,0,-11.34481,11.34481,-11.34481,1);background:rgb(14,76,61)}
.dspin i:nth-child(11){transform:matrix3d(0.83329,0.515,0.31829,0,-0.4811,0.89201,-0.18376,0,-0.35682,0,0.93417,0,-7.01148,0,18.35629,1);background:rgb(45,239,192)}
.dspin i:nth-child(12){transform:matrix3d(-0.31829,-0.83329,-0.515,0,0.77843,0.11357,-0.66486,0,0.57735,-0.57735,0.57735,0,11.34481,-11.34481,11.34481,1);background:rgb(38,201,162)}
.dspin i:nth-child(13){transform:matrix3d(0.83329,-0.515,-0.31829,0,0.4811,0.89201,-0.18376,0,0.35682,0,0.93417,0,7.01148,0,18.35629,1);background:rgb(30,161,130)}
.dspin i:nth-child(14){transform:matrix3d(-0.83329,-0.515,-0.31829,0,0.11357,-0.66486,0.77843,0,-0.57735,0.57735,0.57735,0,-11.34481,11.34481,11.34481,1);background:rgb(19,104,84)}
.dspin i:nth-child(15){transform:matrix3d(0.515,0.31829,0.83329,0,0.89201,-0.18376,-0.4811,0,0,0.93417,-0.35682,0,0,18.35629,-7.01148,1);background:rgb(14,76,61)}
.dspin i:nth-child(16){transform:matrix3d(-0.515,-0.31829,0.83329,0,0.89201,-0.18376,0.4811,0,0,0.93417,0.35682,0,0,18.35629,7.01148,1);background:rgb(14,76,61)}
.dspin i:nth-child(17){transform:matrix3d(-0.31829,0.83329,0.515,0,0.77843,-0.11357,0.66486,0,0.57735,0.57735,-0.57735,0,11.34481,11.34481,-11.34481,1);background:rgb(14,76,61)}
.dspin i:nth-child(18){transform:matrix3d(0,0,-1.03,0,0.36753,0.9622,0,0,0.93417,-0.35682,0,0,18.35629,-7.01148,0,1);background:rgb(14,76,61)}
.dspin i:nth-child(19){transform:matrix3d(-0.31829,0.83329,-0.515,0,-0.18376,0.4811,0.89201,0,0.93417,0.35682,0,0,18.35629,7.01148,0,1);background:rgb(14,76,61)}
.dspin i:nth-child(20){transform:matrix3d(0.31829,-0.83329,0.515,0,0.77843,-0.11357,-0.66486,0,0.57735,0.57735,0.57735,0,11.34481,11.34481,11.34481,1);background:rgb(14,76,61)}

/* IT ROLLS. The first attempt travelled but did not roll — it stretched and
   jumped, and both faults had the same cause: rotation and position were
   keyframed independently, so the die could cross a third of the screen while
   barely turning and then spin on the spot while barely moving. That is not
   motion, it is two animations arguing.

   ROTATION IS NOW A FUNCTION OF DISTANCE. Twenty-five degrees per vw travelled,
   everywhere, which is what rolling means: something that turns because it is
   moving, not alongside it. Seventy-two vw of travel at 25°/vw is 1,800° —
   exactly five turns — so it also lands in the orientation it was lit for
   without anybody having to fudge the last keyframe.

   THE AXIS IS MOSTLY Z, because that is the one a thing rolling across your
   screen turns around. The small X and Y components are what make it a die
   rather than a wheel: it tumbles as it goes, but it goes the right way.

   NO SCALE. The pulsing was meant to read as impact and read as stretching,
   because a scale on a rotating object distorts along whichever axis happens to
   be vertical at that instant. Weight comes from the shadow instead.

   RIGHT TO LEFT is a constraint, not a preference: the panel sits at the left
   of a centred page, so there is room to the right of the heading and none to
   its left. Coming in from off the left edge would widen the document and hand
   every phone a horizontal scrollbar for two seconds. */
.rolled .d20{width:52px;height:52px;vertical-align:middle}
.rolled .dscale{transform:scale(1)}
/* IT ROLLS. The first attempt travelled but did not roll: it stretched and
   jumped, and both faults had the same cause. Rotation and position were
   keyframed independently, so the die could cross a third of the screen while
   barely turning and then spin on the spot while barely moving. That is not
   motion, it is two animations arguing.

   ROTATION IS A FUNCTION OF DISTANCE. Twenty-five degrees per vw travelled,
   which is what rolling means: something that turns because it is moving, not
   alongside it. Seventy-two vw at 25 deg/vw is 1,800 degrees, exactly five
   turns, so it also lands in the orientation it was lit for without anybody
   having to fudge the last keyframe.

   THE AXIS IS MOSTLY Z, because that is the one a thing rolling across your
   screen turns around. The small X and Y components are what make it a die
   rather than a wheel.

   NO SCALE. The pulsing was meant to read as impact and read as stretching,
   because a scale on a rotating object distorts along whichever axis happens to
   be vertical at that instant. Weight comes from the shadow instead.

   DO NOT "IMPROVE" THIS. It has been rebuilt twice on the grounds that the
   physics could be more accurate, and both times it looked worse and had to
   come back. Once the horizontal travel was split onto its own element so the
   die never sped up after a bounce, which is more correct and reads as wrong;
   once with a second rotation axis for tumble, which put it in a perspective
   frustum it was never designed for and made it fly like a ship. Accuracy is
   not the goal here. This version is the one Martin approved. Change it only
   if he asks, and change one thing at a time.

   RIGHT TO LEFT is a constraint, not a preference: the panel sits at the left
   of a centred page, so there is room to the right of the heading and none to
   its left. Coming in from off the left edge would widen the document and hand
   every phone a horizontal scrollbar for two seconds. */
.rolled .dspin{animation:throw 2s linear both}
.rolled .d20::after{
  content:"";position:absolute;left:8%;right:8%;bottom:-6px;height:7px;
  border-radius:50%;background:rgba(0,0,0,.55);filter:blur(3px);
  animation:landshadow 2s linear both;
}
/* Per-keyframe easing, because a bounce is two different motions: falling
   accelerates and rising decelerates. One timing function across the whole
   animation cannot do both, which is what made the arcs look mechanical. */
@keyframes throw{
  0%   {transform:translate3d(72vw,-190px,0)  rotate3d(.25,.15,1,0deg);
        opacity:0; animation-timing-function:ease-in}
  8%   {opacity:1}
  /* first contact */
  26%  {transform:translate3d(47vw,0,0)       rotate3d(.25,.15,1,-625deg);
        animation-timing-function:ease-out}
  38%  {transform:translate3d(33vw,-58px,0)   rotate3d(.25,.15,1,-975deg);
        animation-timing-function:ease-in}
  /* second */
  52%  {transform:translate3d(20vw,0,0)       rotate3d(.25,.15,1,-1300deg);
        animation-timing-function:ease-out}
  63%  {transform:translate3d(11vw,-30px,0)   rotate3d(.25,.15,1,-1525deg);
        animation-timing-function:ease-in}
  /* third, almost home */
  75%  {transform:translate3d(5vw,0,0)        rotate3d(.25,.15,1,-1675deg);
        animation-timing-function:ease-out}
  84%  {transform:translate3d(1.8vw,-11px,0)  rotate3d(.25,.15,1,-1755deg);
        animation-timing-function:ease-in}
  /* the last roll, coming to rest on a whole number of turns */
  94%  {transform:translate3d(.3vw,0,0)       rotate3d(.25,.15,1,-1793deg);
        animation-timing-function:ease-out}
  100% {transform:translate3d(0,0,0)          rotate3d(.25,.15,1,-1800deg)}
}
/* The shadow travels with it, squashing wide on each impact and thinning while
   the die is in the air. It is most of why the thing reads as having weight;
   without it the die is a sprite sliding across a page. */
@keyframes landshadow{
  0%   {opacity:0;   transform:translate3d(72vw,0,0)  scale(.35)}
  20%  {opacity:.16; transform:translate3d(54vw,0,0)  scale(.6)}
  26%  {opacity:.6;  transform:translate3d(47vw,0,0)  scale(1.25)}
  38%  {opacity:.16; transform:translate3d(33vw,0,0)  scale(.6)}
  52%  {opacity:.58; transform:translate3d(20vw,0,0)  scale(1.16)}
  63%  {opacity:.2;  transform:translate3d(11vw,0,0)  scale(.7)}
  75%  {opacity:.55; transform:translate3d(5vw,0,0)   scale(1.1)}
  84%  {opacity:.3;  transform:translate3d(1.8vw,0,0) scale(.85)}
  100% {opacity:.45; transform:translate3d(0,0,0)     scale(1)}
}
@media (prefers-reduced-motion:reduce){
  /* The die still arrives, it just does not perform. */
  .rolled .dspin,.rolled .d20::after{animation:none}
  /* The cards arrive dealt and face up. No flight, no rattle, no turn. */
  .slot,.dcard{animation:none}
  .dcard{transform:rotateY(180deg)}
}
.panel.roll{margin:0 0 18px}
.panel.roll h2{gap:9px}
.panel.roll h2 .d20{margin-right:2px}
/* The platform chips. Same .tab pill as the sort tabs everywhere else, because
   it is the same gesture: pick one, the page reloads showing that one. Sitting
   above the deck rather than in the toolrow so it is obviously part of the
   deal and not a filter on the library below. */
.platrow{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 4px}

/* ---- the deal ----

   THE WHOLE SEQUENCE IS ARITHMETIC, NOT SCRIPT. This site has never shipped a
   byte of JavaScript and a card trick was not going to be the first. Four
   phases chained on animation-delay off two custom properties:

     deal    cards fly in from the last slot, --step apart, and land with a pop
     hold    everything sits still, face down. This is the suspense
     rattle  they knock against each other, odd and even leaning opposite ways
     turn    one at a time, --tstep apart, read left to right

   Two animations share .slot, and the order in the list is load-bearing: where
   two animations touch the same property the later one wins while it is active
   or filling, so rattle takes forwards fill only. Given backwards fill it would
   apply its first keyframe during its own delay and cancel the deal entirely.
*/
.deck{
  --gap:14px;
  --deal:.58s; --step:78ms; --hold:320ms;
  --rattle:.66s; --rstep:45ms; --turn:.66s; --tstep:165ms;
  --dealt:calc(var(--deal) + var(--last) * var(--step));
  --shake-at:calc(var(--dealt) + var(--hold));
  --turn-at:calc(var(--shake-at) + var(--rattle) - 120ms);

  list-style:none;margin:16px 0 6px;padding:0;
  display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));
  gap:var(--gap);
  /* On the grid, so every card turns toward one vanishing point rather than
     each having its own and the outer ones flaring. */
  perspective:1500px;
}
/* NO FIXED RATIO. aspect-ratio:3/4.5 set the card's height before anything was
   in it, and .dfront was absolutely positioned so nothing inside could push
   back: a two-line title ate the points line, which is the one number the card
   exists to show. Height now comes from the front face, which is in flow, and
   the grid stretches every slot in a row to match the tallest. */
.slot{
  position:relative;
  animation:
    deal-in var(--deal) cubic-bezier(.16,.74,.24,1) calc(var(--i) * var(--step)) both,
    rattle var(--rattle) ease-in-out calc(var(--shake-at) + var(--i) * var(--rstep)) forwards;
}
.slot:nth-child(even){animation-name:deal-in,rattle-alt}

/* (last - i) columns of travel, so every card starts at the last slot. A fixed
   offset would start each one to the right of ITS OWN box: five cards sliding
   in parallel rather than one hand dealing them out. */
@keyframes deal-in{
  0%   {opacity:0;
        transform:translate3d(calc((var(--last) - var(--i)) * (100% + var(--gap))),-26px,0)
                  rotate(8deg) scale(.9)}
  55%  {opacity:1}
  /* Past the mark and back. That overshoot is the whole difference between a
     card landing on something and a card stopping. */
  70%  {transform:translate3d(0,0,0) rotate(0) scale(1.05)}
  85%  {transform:translate3d(0,1px,0) scale(.985)}
  100% {opacity:1;transform:translate3d(0,0,0) rotate(0) scale(1)}
}
@keyframes rattle{
  0%,100%{transform:translate3d(0,0,0) rotate(0)}
  16%{transform:translate3d(-3px,1px,0) rotate(-1.3deg)}
  34%{transform:translate3d(3px,-2px,0) rotate(1.1deg)}
  52%{transform:translate3d(-2px,1px,0) rotate(-.9deg)}
  70%{transform:translate3d(2px,-1px,0) rotate(.7deg)}
  86%{transform:translate3d(-1px,0,0) rotate(-.35deg)}
}
@keyframes rattle-alt{
  0%,100%{transform:translate3d(0,0,0) rotate(0)}
  16%{transform:translate3d(3px,-1px,0) rotate(1.2deg)}
  34%{transform:translate3d(-3px,2px,0) rotate(-1deg)}
  52%{transform:translate3d(2px,-1px,0) rotate(.85deg)}
  70%{transform:translate3d(-2px,1px,0) rotate(-.6deg)}
  86%{transform:translate3d(1px,0,0) rotate(.3deg)}
}

.dcard{
  position:relative;height:100%;transform-style:preserve-3d;
  animation:turn var(--turn) cubic-bezier(.2,.72,.24,1)
            calc(var(--turn-at) + var(--i) * var(--tstep)) forwards;
}
@keyframes turn{ from{transform:rotateY(0)} to{transform:rotateY(180deg)} }

/* The FRONT is in flow and sets the height; the back is laid over it. Only one
   of the two can be in flow or the card is twice as tall as it looks, and it
   has to be the front, because the front is the one with content in it. */
.dface{
  backface-visibility:hidden;
  border-radius:12px;overflow:hidden;
  border:1px solid var(--edge);background:var(--panel);
}
.dback{position:absolute;inset:0}
.dfront{position:relative;height:100%}

/* The back. It is what you look at for a second and a half, so it is the one
   surface here allowed to be decorative: hatch, inset rule, and the site's own
   mark. height:auto matters, the img carries width/height attributes and
   without it the logo stretches. */
.dback{
  display:grid;place-items:center;
  background:
    radial-gradient(120% 90% at 50% 0%,rgba(32,184,153,.18),transparent 62%),
    repeating-linear-gradient(45deg,rgba(32,184,153,.06) 0 2px,transparent 2px 9px),
    repeating-linear-gradient(-45deg,rgba(32,184,153,.06) 0 2px,transparent 2px 9px),
    var(--deep);
}
.dback::before{content:"";position:absolute;inset:8px;border-radius:8px;
  border:1px solid rgba(32,184,153,.24)}
.dback img{width:56%;max-width:92px;height:auto;aspect-ratio:1;object-fit:contain;
  opacity:.85;filter:drop-shadow(0 0 14px rgba(32,184,153,.3))}

.dfront{transform:rotateY(180deg);display:flex;flex-direction:column}
/* Two lines, then stop. A long title used to wrap to four and push the points
   line out of the card; now it sets the row height for its neighbours and no
   further. The whole name is one click away on the game page. */
a.dt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
  overflow:hidden;overflow-wrap:anywhere}
.dcover{position:relative;display:block;aspect-ratio:1;background:var(--deep);
  border-bottom:1px solid var(--edge)}
.dcover img{width:100%;height:100%;object-fit:cover;display:block}

.dpool,.dplat{
  position:absolute;top:7px;font-size:9.5px;font-weight:700;
  letter-spacing:.1em;text-transform:uppercase;padding:3px 7px;border-radius:99px;
}
.dpool{left:7px;background:rgba(4,33,27,.8);color:var(--kraken);
  border:1px solid rgba(32,184,153,.5)}
.wild .dpool{background:rgba(38,28,4,.8);color:var(--brass);
  border:1px solid rgba(216,171,62,.5)}
.dplat{right:7px;border-radius:5px;letter-spacing:.05em;
  background:rgba(0,0,0,.62);color:var(--soft);border:1px solid rgba(255,255,255,.12)}

.dbody{display:flex;flex-direction:column;gap:5px;padding:10px 11px 12px;flex:1 1 auto}
a.dt{color:var(--ink);text-decoration:none;font-weight:600;font-size:14.5px;line-height:1.2}
a.dt:hover{color:var(--kraken);text-decoration:underline}
.dmeta{font-size:11.5px;color:var(--faint)}
/* The number the card exists for, so it is the only thing on the face that
   takes the accent. */
.dpay{margin-top:auto;font-size:12px;color:var(--soft);font-variant-numeric:tabular-nums}
.dpay b{color:var(--kraken);font-size:14.5px;font-weight:700}
.wild .dpay b{color:var(--brass)}
.dbody .track{height:4px;border-radius:99px;background:var(--rule);overflow:hidden}
.dbody .fill{display:block;height:100%;border-radius:99px;background:var(--kraken)}

.dmark{display:inline-flex}
.dmark svg{width:16px;height:16px;display:block}

details.numbers{margin:0 0 18px}
details.numbers summary{cursor:pointer;color:var(--soft);font-size:13px;padding:4px 0}
details.numbers summary:hover{color:var(--kraken)}
/* Started life holding space for a feature that did not exist yet. It now
   carries the rivals count, which is what the space was being held for. */
.soon-tag{
  margin-left:14px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--faint);border:1px solid var(--edge);border-radius:99px;padding:2px 9px;
  opacity:.7;
}

/* ---- the contested board ----
   Same table language as the index, with three columns the index has no use
   for: position, who is closest, and the multiplier. The multiplier is the only
   number on this site that moves because of what OTHER people did, so it gets
   the accent colour and everything else stays quiet around it. */
table.contested .pos{
  color:var(--faint);font-variant-numeric:tabular-nums;text-align:right;
  width:2.6em;padding-right:2px;
}
table.contested .stuck{white-space:nowrap}
table.contested .mult{color:var(--kraken);font-weight:650;white-space:nowrap}

/* The name and the percentage stack on a phone and sit inline above it — a
   name and a number on one line is two columns pretending to be one, and the
   percentage is meaningless without the name beside it. */
.closest{white-space:nowrap;font-size:13.5px}
.closest a{color:var(--ink);text-decoration:none;font-weight:600}
.closest a:hover{color:var(--kraken);text-decoration:underline}
.cp{margin-left:7px;color:var(--soft);font-variant-numeric:tabular-nums}
.cnone{color:var(--faint);font-style:italic}

/* The lede sits between the hero and the table on this page only, so it needs
   the breathing room the front page gives it by being in a panel. */
.hero.plain + .lede{margin:0 0 22px}

/* A game where NOTHING can be earned, rather than some of it.
   Same warning shape, red instead of brass. Brass is the site's "careful" and
   this is past careful: XDefiant's servers are off, all thirteen trophies are
   gone, and the row for it looked exactly like a game missing four out of
   fifty-two. The colour is the difference between a caution and a verdict. */
p.warn.dead.whole{
  border-color:rgba(229,52,44,.45);
  background:linear-gradient(90deg,rgba(229,52,44,.14),rgba(229,52,44,.05) 60%,transparent);
}
p.warn.dead.whole .mk{color:#e5342c}
p.warn.dead.whole b{color:#ff8e86}
/* And the same in a list: brass means some of it, red means all of it. */
.mk.dead.whole{color:#e5342c}

/* ---- a trophy nobody can earn any more ----
   Amber, not red, and NOT struck through. The points still count for everybody
   who got there in time, so a style that reads as "this is worthless" would be
   lying about the one thing people care about. It is a warning to whoever comes
   next, sitting on the trophy rather than in a note on the game, because a game
   note cannot tell you which one to skip. */
.tc.dead .tcin{box-shadow:inset 3px 0 0 var(--brass)}

/* EARNED LIVE ON STREAM.
   Purple is not in this site's palette anywhere else, and that is deliberate:
   every other colour on a trophy card is about the trophy (its metal, its
   rarity, whether it is dead) and this one is about the night somebody got it.
   Twitch owns the colour in everybody's head already, so it needs no legend.

   A LEFT EDGE, matching how a dead trophy is marked, rather than a wash across
   the card: the card is already carrying a metal, a rarity band and a points
   figure, and a purple background would be arguing with all three. */
.tc.onair::before{border-left-color:var(--live)}
.tc.onair .tcin{box-shadow:inset 3px 0 0 var(--live)}
.livemark{
  display:inline-flex;align-items:center;gap:5px;margin-top:5px;
  font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;
  color:var(--live);border:1px solid rgba(176,125,255,.42);
  background:rgba(176,125,255,.12);border-radius:99px;padding:2px 9px;
}
.deadmark{
  display:block;margin-top:4px;font-size:11.5px;line-height:1.35;color:var(--brass);
}

/* ---- rivals ----
   Four columns and no <thead>. Rank, who, points, gap reads without a header
   the way a scoreboard does, and a header row on a five-row table is a third
   of the table spent saying what the numbers obviously are. */
.rivaltab{width:100%;border-collapse:collapse;font-size:14px}
.rivaltab td{padding:7px 10px;border-top:1px solid var(--edge);vertical-align:middle}
.rivaltab tr:first-child td{border-top:0}
.rivaltab .rk{color:var(--faint);font-variant-numeric:tabular-nums;width:3.2em;text-align:right}
.rivaltab .who a{color:var(--ink);text-decoration:none;font-weight:600}
.rivaltab .who a:hover{color:var(--kraken);text-decoration:underline}
.rivaltab .num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.rivaltab .gap{white-space:nowrap;font-size:13px}

/* The hunter's own row. A left edge rather than a background fill: the fill
   fought the zebra striping everywhere else and made the row look selected
   rather than owned. */
.rivaltab tr.isme td{background:rgba(45,212,191,.06)}
.rivaltab tr.isme .rk{box-shadow:inset 3px 0 0 var(--kraken);color:var(--ink)}
.rivaltab tr.isme .who a{color:var(--kraken)}

/* Green up, red down, matching the arrows in the Discord reply exactly. The
   colours are directional, not a judgement: somebody ahead of you is not a bad
   thing happening, and the site should not read as though it were. Reuse the
   board's own --up/--down rather than picking a second pair of greens. */
.gup{color:var(--up)}
.gdn{color:var(--down)}
.glv,.gme{color:var(--faint)}

.rivalnote{margin:8px 0 0;font-size:12px;color:var(--faint)}
.rivalnote code{background:var(--deep);border:1px solid var(--edge);border-radius:4px;padding:1px 5px}

/* ---- head to head ----
   The compare panel, opened with ?vs= from a hunter page.

   TWO COLOURS AND THEY NEVER SWAP. The hunter whose page this is takes the
   teal the rest of the site already uses for "you are here"; the challenger
   takes the brass. Colouring by who is winning would mean the colours change
   meaning halfway down the list, which is the one thing a legend cannot fix. */
.vsfind input::placeholder{color:var(--faint)}

.vs{margin:0 0 18px}
.vs h2{
  display:flex;align-items:baseline;gap:10px;margin:0 0 14px;
  font-size:17px;letter-spacing:.01em;
}
.vs h2 .vsclear{
  margin-left:auto;font-size:13px;font-weight:500;color:var(--faint);text-decoration:none;
}
.vs h2 .vsclear:hover{color:var(--ink)}
.vs h3{
  margin:20px 0 4px;font-size:14px;letter-spacing:.05em;text-transform:uppercase;
  color:var(--soft);font-weight:700;
}

/* Two cards and the word between them. On a phone the word drops out of the
   flow and the cards stack, which is the only thing that fits. */
.vshead{display:flex;align-items:stretch;gap:12px;flex-wrap:wrap}
.vscard{
  flex:1 1 240px;min-width:0;display:flex;align-items:center;gap:11px;
  background:var(--deep);border:1px solid var(--edge);border-radius:12px;padding:11px 13px;
}
.vscard.mine{box-shadow:inset 3px 0 0 var(--kraken)}
.vscard.them{box-shadow:inset 3px 0 0 var(--brass)}
.vsav{
  width:44px;height:44px;border-radius:10px;flex:0 0 auto;object-fit:cover;
  background:var(--panel);border:1px solid var(--edge);
}
.vswho{min-width:0;flex:1 1 auto}
/* The name and the supporter star are ONE line. The anchor was display:block,
   which pushed the star onto a line of its own under the name and read as a
   second, nameless row. */
.vsline{display:flex;align-items:center;gap:4px;min-width:0}
.vsline a{
  color:var(--ink);text-decoration:none;font-weight:700;font-size:15px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.vsline a:hover{color:var(--kraken)}
.vsrank{display:block;font-size:12px;color:var(--faint)}
.vsfacts{display:flex;gap:14px;margin:0;flex:0 0 auto}
.vsfacts div{text-align:right}
.vsfacts dt{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.vsfacts dd{margin:0;font-size:14px;font-weight:700;font-variant-numeric:tabular-nums}
.vsx{
  align-self:center;font-size:12px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--faint);font-weight:700;
}
.vsgap{margin:12px 0 0;font-size:14px;color:var(--soft)}
.vsgap b{color:var(--ink);font-variant-numeric:tabular-nums}

.vsnote{margin:4px 0 10px;font-size:12.5px;color:var(--faint);line-height:1.45}
.vsnote.foot{margin:18px 0 0;padding-top:12px;border-top:1px solid var(--edge)}
/* "There is more of this". Sits under a list, reads as the end of it. */
.vsmore{margin:10px 0 0;font-size:13px}
.vsmore a{color:var(--kraken);text-decoration:none;font-weight:600}
.vsmore a:hover{text-decoration:underline}
.vs.miss{padding:14px 16px}
.vs.miss .vsnote{margin:0}
.vs.miss a{color:var(--kraken)}

.vslist{list-style:none;margin:0;padding:0}
.vsrow{
  display:flex;align-items:center;gap:12px;
  padding:9px 0;border-top:1px solid var(--edge);
}
.vsrow:first-child{border-top:0}
.vsrow .ico{
  width:46px;height:46px;border-radius:8px;flex:0 0 auto;object-fit:cover;
  background:var(--panel);border:1px solid var(--edge);
}
.vsg{flex:1 1 auto;min-width:0}
.vsg .tname{
  color:var(--ink);text-decoration:none;font-weight:600;font-size:14.5px;
}
.vsg .tname:hover{color:var(--kraken);text-decoration:underline}
.vsmeta{display:block;margin-top:2px;font-size:12px;color:var(--faint);
  font-variant-numeric:tabular-nums}

/* The bars. Fixed width so every row's grooves start in the same column and
   the list can be read straight down without the eye hunting for the left
   edge of each one. */
.vsbars{flex:0 0 auto;width:clamp(150px,28vw,270px);display:grid;gap:4px}
.vsb{display:flex;align-items:center;gap:7px}
.vsb .track{
  flex:1 1 auto;height:7px;border-radius:99px;background:var(--rule);overflow:hidden;
}
.vsb .fill{display:block;height:100%;border-radius:99px}
.vsb.mine .fill{background:var(--kraken)}
.vsb.them .fill{background:var(--brass)}
.vsb i{
  font-style:normal;font-size:11.5px;color:var(--faint);
  font-variant-numeric:tabular-nums;width:3.1em;text-align:right;flex:0 0 auto;
}
.vsb.mine i{color:var(--kraken)}
.vsb.them i{color:var(--brass)}

/* On a phone the two cards stack, and flex:1 1 240px then reads as a 240px
   TALL card with the facts hanging off the right edge. Both halves of that are
   fixed here: the card sizes to its content, and the facts drop to their own
   line underneath the name. */
@media (max-width:560px){
  .vshead{flex-direction:column;align-items:stretch}
  .vscard{flex:0 0 auto;flex-wrap:wrap}
  .vsfacts{width:100%;justify-content:space-between;gap:8px;margin-top:2px}
  .vsx{align-self:flex-start}
  .vsrow{flex-wrap:wrap}
  .vsbars{width:100%;order:3}
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

/* The site credit, on every page. The studio link is LIVE now — it was plain
   text while the domain was unfinished, on the rule that a link going nowhere
   is worse than no link.
   It is deliberately the largest thing in this row. Somebody built this and the
   footer is where that gets said, so the disclaimer and the Discord line stay
   at 12.5px and the studio's name does not. */
.credit{
  margin-top:44px;padding:20px 0 0;border-top:1px solid var(--rule);
  display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;
  color:var(--faint);font-size:12.5px;
}
.credit .by{text-align:center;font-size:14px}
.credit .by a{
  color:var(--ink);font-weight:700;font-size:17px;text-decoration:none;
  border-bottom:1px solid transparent;transition:border-color .15s ease,color .15s ease;
}
.credit .by a:hover{color:var(--kraken);border-bottom-color:var(--kraken)}
/* THE ASK. A BUTTON NOW, BUT STILL AT THE BOTTOM OF THE PAGE.
   It used to be twelve-pixel grey text under the studio credit, which was so
   quiet that it read as small print rather than as something you could press.
   It is a pill with a border and a cup on it, so it is obvious it does
   something, and it stays where it was: the last thing on the page, after the
   trophies, never interrupting. Nobody arrives here to be asked for money.
   A banner would earn more this month and cost more than it earned by
   Christmas.

   BRASS, WHICH IS THE STAR'S COLOUR. The one visual connection between the ask
   and the thank-you, made without a word of copy about it. The button still
   never says what supporting gets you: the star is a thank-you sent afterwards,
   not a product on sale, and a footer that advertised it would turn the board
   into a shop.

   The specificity here is doing real work: ".credit .by a" sets 17px/700 for
   the studio name and a mobile query resets it to 16px, so this rule carries
   three classes to outrank both without touching either.
   NO BACKTICKS IN THIS COMMENT, and that is not a style preference. The whole
   stylesheet is a template literal, so a backtick here ends the string and the
   file stops being JavaScript. It has cost a build twice. */
.credit .by .kofi{
  display:inline-flex;align-items:center;gap:8px;
  margin-top:13px;padding:8px 17px;
  font-size:13.5px;font-weight:650;letter-spacing:.01em;
  color:var(--brass);
  background:rgba(216,171,62,.09);
  border:1px solid rgba(216,171,62,.45);
  border-bottom-color:rgba(216,171,62,.45);
  border-radius:99px;
  transition:background .15s ease,border-color .15s ease,color .15s ease;
}
.credit .by .kofi svg{width:16px;height:16px;flex:0 0 16px;display:block}
.credit .by .kofi:hover{
  background:rgba(216,171,62,.2);
  border-color:var(--brass);border-bottom-color:var(--brass);
  color:#f2d68f;text-decoration:none;
}
/* It looks like a button, so it has to behave like one for a keyboard. */
.credit .by .kofi:focus-visible{
  outline:2px solid var(--brass);outline-offset:3px;
  background:rgba(216,171,62,.2);color:#f2d68f;
}
@media (max-width:720px){ .credit .by a{font-size:16px} }
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

/* LIVE NOW.
   Cards, not a list. It was a list first and it read as an afterthought next to
   the trophy cards and the deck: a name and a dot is a fact about a person,
   while a still of what is on their screen with the viewer count on it is the
   thing itself. Only drawn when somebody actually is live, so it never sits
   empty at the top of the page. */
.live{width:100%;margin:4px 0 8px}
.live h2{
  display:flex;align-items:center;gap:8px;margin:0 0 10px;
  font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--soft);font-weight:700;
}
.live .dot{
  width:8px;height:8px;border-radius:50%;background:var(--down);flex:none;
  box-shadow:0 0 0 0 rgba(224,100,95,.55);animation:pulse 2.4s ease-out infinite;
}
@keyframes pulse{
  0%{box-shadow:0 0 0 0 rgba(224,100,95,.5)}
  70%{box-shadow:0 0 0 7px rgba(224,100,95,0)}
  100%{box-shadow:0 0 0 0 rgba(224,100,95,0)}
}
/* THE SHELF.
   Three across, the next one peeking past the right edge so it is obvious there
   is more, and it drags. Snapping is what makes a sideways scroller feel like a
   shelf rather than a runaway div.

   overflow-x:auto PROMOTES THE OTHER AXIS to auto as well, which is exactly the
   bug that turned the games table into a scroll box when a popup opened inside
   it. Nothing here is taller than the row and the lift on hover is paid for
   with padding, so there is never anything to scroll vertically. */
.lvwrap{position:relative;margin:0 -2px}
.lvs{
  display:grid;grid-auto-flow:column;
  /* Three across MINUS a sliver, so the fourth card is visibly waiting at the
     edge. Exactly three would fill the width and the shelf would look like it
     ends there, which is the whole thing this is meant to avoid. */
  grid-auto-columns:calc((100% - 2 * 12px - 52px) / 3);
  gap:12px;padding:4px 2px 6px;
  overflow-x:auto;overscroll-behavior-x:contain;
  scroll-snap-type:x mandatory;scroll-padding-left:2px;
  scrollbar-width:none;
}
.lvs::-webkit-scrollbar{display:none}
.lv{scroll-snap-align:start}
/* The edge fade, which is the whole "there is more behind this" signal. It sits
   over the shelf and must never eat a click meant for the card under it. */
.lvwrap::after{
  content:"";position:absolute;top:0;right:-2px;bottom:6px;width:56px;
  pointer-events:none;
  background:linear-gradient(90deg,rgba(12,22,24,0),var(--ground));
}
@media (max-width:760px){
  .lvs{grid-auto-columns:86%}
}
.lvdots{display:flex;gap:6px;justify-content:center;margin:8px 0 0}
.lvdots a{
  width:22px;height:4px;border-radius:99px;background:var(--rule);
  transition:background .16s ease;
}
.lvdots a:hover,.lvdots a:focus-visible{background:var(--soft)}

/* THE QUIET STATE.
   The dot stops pulsing and goes grey, because a red live light over "nobody is
   streaming" is the kind of small lie that makes people stop trusting the rest
   of the page. Naming the regulars turns an empty box into an answer to "come
   back when". */
.live.off .dot{background:var(--rule);animation:none}
.lvempty{
  border:1px solid var(--edge);border-radius:12px;background:var(--panel);
  padding:14px 16px;
}
.lvnone{margin:0;color:var(--soft);font-size:14px}
.lvwho{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0 0}
.lvwho a{
  display:inline-flex;align-items:center;gap:7px;
  padding:5px 11px 5px 5px;border-radius:99px;
  border:1px solid var(--rule);background:var(--ground);
  text-decoration:none;font-size:13px;font-weight:600;
}
.lvwho a:hover{border-color:var(--faint)}
.lvwho img{border-radius:50%;flex:none}
.lvrest{
  display:inline-flex;align-items:center;padding:5px 11px;border-radius:99px;
  color:var(--faint);font-size:12.5px;border:1px dashed var(--rule);
}
.lvhint{margin:10px 0 0;color:var(--faint);font-size:12.5px}
.live h2 .count{
  margin-left:2px;padding:1px 7px;border-radius:99px;
  background:rgba(224,100,95,.16);border:1px solid rgba(224,100,95,.4);
  color:var(--down);font-size:10.5px;letter-spacing:.04em;
}
.lv{
  display:block;text-decoration:none;border-radius:12px;overflow:hidden;
  border:1px solid var(--edge);background:var(--panel);
  transition:border-color .16s ease, transform .16s ease;
}
.lv:hover{border-color:var(--faint);transform:translateY(-2px)}
.lv .shot{
  position:relative;display:block;aspect-ratio:16/9;overflow:hidden;background:var(--deep);
}
/* The still, and the slow drift across it.
   A frozen frame looks like a broken video; two per cent of movement over
   twenty seconds reads as alive without ever pulling focus from the page. */
.lv .shot img{
  width:100%;height:100%;object-fit:cover;display:block;
  animation:driftshot 24s ease-in-out infinite alternate;
}
@keyframes driftshot{ from{transform:scale(1.02) translate3d(0,0,0)} to{transform:scale(1.08) translate3d(-1.5%,-1%,0)} }
.lv .noshot{
  position:absolute;inset:0;
  background:
    radial-gradient(120% 120% at 20% 15%, rgba(32,184,153,.18), transparent 60%),
    linear-gradient(160deg,#14262a,#0a1416);
}
.lv .shot::after{
  content:"";position:absolute;inset:auto 0 0 0;height:62%;
  background:linear-gradient(180deg,rgba(8,16,15,0),rgba(8,16,15,.86));
}
.lv .tag{
  position:absolute;top:9px;left:9px;z-index:2;
  display:inline-flex;align-items:center;gap:6px;
  padding:3px 8px;border-radius:5px;background:var(--down);
  color:#fff;font-size:10.5px;font-weight:800;letter-spacing:.1em;
}
.lv .tag .dot{width:5px;height:5px;background:#fff;animation:none;box-shadow:none}
.lv .watching{
  position:absolute;top:9px;right:9px;z-index:2;
  padding:3px 8px;border-radius:5px;background:rgba(8,16,15,.72);
  color:var(--ink);font-size:11px;font-variant-numeric:tabular-nums;
}
.lv .up{
  position:absolute;bottom:8px;right:10px;z-index:2;
  color:var(--ink);font-size:11.5px;font-variant-numeric:tabular-nums;opacity:.85;
}
.lv .meta{display:flex;align-items:center;gap:10px;padding:10px 12px;min-width:0}
.lv .meta img{border-radius:50%;flex:none}
.lv .txt{min-width:0;display:flex;flex-direction:column;flex:1}
.lv .nm{font-weight:700;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv .gm{color:var(--faint);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv .pos{
  flex:none;text-align:right;color:var(--brass);font-weight:800;font-size:14px;
  font-variant-numeric:tabular-nums;line-height:1.15;
}
.lv .pos .pts{display:block;color:var(--faint);font-weight:400;font-size:11px}

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
   left the fourth alone in a half-empty row. */
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

/* ---- the FAQ ----
   Folders again, and for the same reason the trophy packs are: six sections of
   prose is a wall, and a wall is what people scroll past looking for the one
   paragraph they came for. The first is open so the page is never a list of
   closed boxes. */
.faq{margin:0 0 8px;border:1px solid var(--edge);border-radius:10px;background:var(--panel)}
.faqhead{
  display:flex;align-items:baseline;gap:12px;padding:13px 16px;cursor:pointer;
  list-style:none;user-select:none;font-weight:700;color:var(--ink);font-size:15.5px;
}
.faqhead::-webkit-details-marker{display:none}
.faqhead:hover{color:var(--kraken)}
.faqhead .caret{font-size:10px;color:var(--faint);transition:transform .16s ease;
  align-self:center}
.faq[open] > .faqhead .caret{transform:rotate(90deg)}
.faqhead .fq{flex:0 0 auto}
.faqhead .fd{color:var(--faint);font-weight:400;font-size:12.5px;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:560px){ .faqhead .fd{display:none} }

.faqbody{padding:0 18px 18px;max-width:74ch;color:var(--soft);font-size:14.5px;
  line-height:1.65}
.faqbody h2{margin:0 0 10px;font-size:13px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--faint);font-weight:700}
.faqbody p{margin:0 0 13px}
.faqbody b{color:var(--ink)}
.faqbody code{background:var(--ground);border:1px solid var(--edge);border-radius:5px;
  padding:1px 6px;font-size:13px;color:var(--kraken)}
.faqbody pre{background:var(--ground);border:1px solid var(--edge);border-radius:8px;
  padding:12px 14px;overflow-x:auto;font-size:12.5px;line-height:1.7;margin:0 0 13px;
  color:var(--soft)}
.faqbody a{color:var(--kraken)}
.faqbody .fine{color:var(--faint);font-size:12.5px}
ul.faqlist{list-style:none;margin:0 0 13px;padding:0}
ul.faqlist li{position:relative;padding-left:18px;margin:0 0 6px}
ul.faqlist li::before{content:"";position:absolute;left:2px;top:.62em;width:6px;height:6px;
  border-radius:2px;background:var(--edge)}
@media (prefers-reduced-motion:reduce){ .faqhead .caret{transition:none} }

/* ---- the game page ----
   The first page here whose subject is a game rather than a person, so it gets
   the same furniture as a hunter — a hero, a cabinet bar, sort tabs, one table
   — and none of its own. A site where every page invents a layout is four
   sites. */
.ghero{display:flex;align-items:center;gap:18px;margin:4px 0 16px}
.bigico{width:96px;height:96px;border-radius:12px;flex:0 0 96px;background:var(--edge);
  object-fit:cover;box-shadow:0 6px 18px rgba(0,0,0,.4)}
.gh{min-width:0}
.gh h1{margin:0;font-size:clamp(21px,3.5vw,30px);letter-spacing:-.015em;line-height:1.2}
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
.tlist{list-style:none;margin:0;padding:0 5px;display:flex;flex-direction:column;gap:5px}

/* THE LEAN IS ON A BACKGROUND LAYER, AND THE TEXT NEVER MOVES.
   The first version skewed the card and un-skewed its contents, which cancels
   out geometrically and does NOT cancel out for the rasteriser: any transform
   drops the text into a composited layer at fractional coordinates and turns
   off subpixel antialiasing, so every description came out soft. It was most
   visible on the small grey line, which is exactly the text that could least
   afford it.
   So the card itself is untransformed and paints nothing. A pseudo-element
   behind it carries the whole shape — background, border, radius, the metal
   edge, the earned wash — and only THAT is skewed. Pixels have no glyphs in
   them, so a skewed rectangle costs nothing. The 5px padding on the list is for
   the corners the lean pushes outward. */
.tc{position:relative;isolation:isolate}
.tc::before{
  content:"";position:absolute;inset:0;z-index:-1;
  transform:skewX(-3deg);border-radius:5px;
  background:var(--panel);
  border:1px solid var(--edge);
  border-left:4px solid var(--rule);
}
.tcin{display:flex;align-items:center;gap:14px;padding:11px 20px 11px 16px;
  position:relative}

/* HOVER, BUT NOT A CURSOR.
   A card is not a link and nothing happens when you click it, so it must not
   grow a pointer or lift like a button — that promises something the page
   cannot deliver. What it does is brighten its own edge and rise a hair, which
   is enough to say "this is the row your eye is on" while scrolling a hundred
   and thirty-six of them.

   The scale is on the SKEWED BACKGROUND LAYER, never on the card, because the
   card contains text and the whole reason that layer exists is that a transform
   over glyphs turns the antialiasing to mush. 1.006 on a 70px row is under half
   a pixel of movement — felt rather than seen, which is the right size for
   something that happens forty times on the way down a page.

   Only where a mouse actually exists. The hover:hover query keeps it off
   phones, where
   :hover sticks after a tap and would leave a random card lit for good. */
@media (hover: hover) {
  .tc::before{transition:border-color .14s ease,transform .14s ease,filter .14s ease}
  .tc:hover::before{
    transform:skewX(-3deg) scale(1.006);
    border-color:var(--faint);
    filter:brightness(1.14);
  }
  /* An earned card is already carrying a metal wash, so brightness alone barely
     registers on it. It gets the same lift with a lighter touch on the colour. */
  .tc.got:hover::before{filter:brightness(1.1);border-color:rgba(255,255,255,.3)}
  /* A faded row brightens back toward full as you pass over it, so you can read
     one you have not earned without turning the whole list back on. */
  .tlist.viewing .tc:not(.got){transition:opacity .14s ease}
  .tlist.viewing .tc:not(.got):hover{opacity:.9}
}
@media (prefers-reduced-motion:reduce){
  .tc::before{transition:none}
  .tc:hover::before{transform:skewX(-3deg)}
}

/* The metal. Same vocabulary as the accent strip on every table: colour means
   which trophy, never how far along. */
.tc.m-p::before{border-left-color:#4a9eff}
.tc.m-g::before{border-left-color:#f0c419}
.tc.m-s::before{border-left-color:#c9ccd1}
.tc.m-b::before{border-left-color:#e08a4a}

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
/* ABOVE THE FOLDERS, NOT INSIDE THE FIRST ONE.
   It used to ride under the base game's heading, which read well until you
   folded the base game away — and then the labels went with it, leaving every
   DLC's numbers unexplained. A header that disappears when you close the one
   section that happens to contain it is not a header. */
.tlhead{display:flex;justify-content:flex-end;gap:22px;padding:0 20px 6px 0;
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
/* THE RAMP IS NARROWER THAN IT WAS, and that is a whole-page problem rather
   than a per-row one.
   Pure white at weight 800 for ultra rare against --faint at 500 for common is
   a huge spread, and rarity is not evenly spread across a game: a DLC pack is
   often ALL ultra rares and a base game is mostly commons. So the two rendered
   as two different designs — the pack glowing white, the base game looking
   switched off underneath it — when the only real difference was which
   trophies happened to be in which group.
   Compressed to --ink at the top and --soft at the bottom, the order still
   reads down a column and no group of trophies can make its neighbour look
   broken. */
.rb.ur{color:var(--ink);font-weight:800}
.rb.vr{color:var(--ink);font-weight:700}
.rb.r{color:var(--ink);font-weight:600}
.rb.u{color:var(--soft);font-weight:600}
.rb.c{color:var(--soft);font-weight:500}
.rb.none{color:var(--faint);font-weight:500}
.rl{display:block;font-size:11px;color:var(--faint);margin-top:3px;letter-spacing:.02em}
.tc.got .rb.none{color:var(--soft)}

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
.tc.got::before{border-color:rgba(255,255,255,.14);background:#16252a}
.tc.got .tcb .tname{color:#fff}
.tc.got .tcb .tdet{color:var(--soft)}
.tc.got .tpts,.tc.got .local{color:var(--ink)}
/* The four are NOT the same strength, because the four colours are not equally
   loud on a dark ground. Silver at the same opacity as bronze reads brighter
   than gold, which would make the cheapest trophies the most eye-catching thing
   on the page — so silver is pulled well down and the rest are trimmed until a
   screen full of earned bronzes stops looking like one brown block. */
.tc.got.m-p::before{background:linear-gradient(100deg,rgba(74,158,255,.26),rgba(74,158,255,.04) 55%,transparent)}
.tc.got.m-g::before{background:linear-gradient(100deg,rgba(240,196,25,.24),rgba(240,196,25,.04) 55%,transparent)}
.tc.got.m-s::before{background:linear-gradient(100deg,rgba(201,204,209,.14),rgba(201,204,209,.03) 55%,transparent)}
.tc.got.m-b::before{background:linear-gradient(100deg,rgba(224,138,74,.22),rgba(224,138,74,.04) 55%,transparent)}
/* A green edge on the right, because on a phone the wash is the first thing a
   dim screen loses. On the same skewed layer, so it leans with the card. */
.tc.got::before{border-right:4px solid var(--up)}

/* Only dim the unearned ones when somebody's trophies are actually being shown.
   With no viewer set, nothing here is "not done" — it is just a trophy list,
   and half-fading all of it would be a lie about a page nobody is signed in to. */
.tlist.viewing .tc:not(.got){opacity:.62}

/* WHOSE LIST THIS IS, AS A PERSON RATHER THAN A SETTING.
   This was a sentence with a button on the end reading "Turn off", and the
   honest verdict on that was that you could not tell what it turned off. A verb
   with no object is not a label.
   So the state is drawn as the person it is about: their face, their name, how
   far they have got, and an ✕. An ✕ on a chip reads as "remove this" to
   everybody who has ever closed a browser tab, and it needs no verb at all. */
.viewbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px;
  font-size:12.5px;color:var(--faint)}
.whochip{display:inline-flex;align-items:center;gap:8px;
  padding:4px 5px 4px 5px;border:1px solid var(--edge);border-radius:99px;
  background:var(--panel);color:var(--soft);font-size:13px}
.whochip .av{width:24px;height:24px;flex:0 0 24px}
.whochip b{color:var(--ink);font-weight:600}
.whochip .pc{color:var(--faint);font-variant-numeric:tabular-nums}
/* The ✕ is a real link with a real hit area — 26px square, which is the
   smallest thing a thumb can reliably hit. */
.whochip .x{display:inline-flex;align-items:center;justify-content:center;
  width:26px;height:26px;border-radius:50%;color:var(--faint);text-decoration:none;
  font-size:15px;line-height:1;flex:0 0 26px}
.whochip .x:hover{background:rgba(255,255,255,.09);color:var(--ink)}
.viewbar .why{color:var(--faint)}
@media (max-width:520px){ .viewbar .why{flex:1 1 100%} }
.viewbar a:hover{text-decoration:underline}
.vchip{font-size:11.5px;color:var(--faint);border:1px solid var(--edge);border-radius:99px;
  padding:2px 10px;text-decoration:none;white-space:nowrap}
.vchip:hover{color:var(--kraken);border-color:var(--kraken)}
.vchip.on{color:var(--deep);background:var(--kraken);border-color:var(--kraken);font-weight:600}

/* ---- packs, as folders ----
   A <details>, so this is HTML doing the work and not a script. It opens on a
   tap, on a click and from a keyboard, it survives JavaScript being off, and
   the browser's own find-in-page can open a closed one to show a match — none
   of which is true of a div with a click handler.

   The base game is open and the DLC is closed. Minecraft is a hundred and
   thirty-six trophies across nine groups: all-open is four screens of
   scrolling, all-closed makes a game with one small DLC cost two clicks to see
   anything, and this is the version that is right for both. */
.pack{margin:9px 0 0}
.pack:first-of-type{margin-top:0}
.pack[open]{margin-bottom:4px}
/* THE PACK NAME IS A PROPER NOUN, SO IT IS NOT SHOUTED.
   This row was styled as a section label — 12px, wide letter-spacing, all caps
   — back when the only things it could say were "BASE GAME" and "DLC 1". Then
   PSN's real names arrived and it started rendering GRAND THEFT AUTO ONLINE:
   THE DOOMSDAY HEIST, which is a title in a shouting voice and eats the row.
   Titles get sentence case at a readable size; only the count beside it keeps
   the small-label treatment, because that IS a label. */
.tgroup{
  display:flex;align-items:center;gap:12px;padding:10px 14px 10px 12px;
  border:1px solid var(--edge);border-radius:8px;background:var(--panel);
  cursor:pointer;list-style:none;user-select:none;
  font-size:14.5px;color:var(--soft);font-weight:700;letter-spacing:-.005em;
}
.tgroup::-webkit-details-marker{display:none}
.tgroup:hover{border-color:var(--faint);color:var(--ink)}
.pack[open] > .tgroup{border-bottom-left-radius:0;border-bottom-right-radius:0}
/* Our own arrow, because the native one cannot be positioned and looks like a
   different operating system on every browser. */
.tgroup .caret{
  flex:0 0 auto;color:var(--faint);font-size:10px;line-height:1;
  transition:transform .16s ease;transform:rotate(0deg);
}
.pack[open] > .tgroup .caret{transform:rotate(90deg)}
.tgroup img{width:26px;height:26px;border-radius:5px;flex:0 0 26px;object-fit:cover}
.tgroup .gname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
/* The reason to open it. Points first, because "is this pack worth my evening"
   is the question, and a trophy count has never answered it. */
.tgroup .gmeta{font-weight:500;color:var(--faint);font-size:11px;white-space:nowrap;
  letter-spacing:.07em;text-transform:uppercase}
.tgroup .gmeta b{letter-spacing:0}
.tgroup .gmeta b{color:var(--soft);font-weight:700;font-variant-numeric:tabular-nums;
  font-size:12.5px;letter-spacing:0}

/* DONE. Only ever shown when somebody's trophies are lit up — with nobody
   selected there is no such thing as finished, and a green bar claiming there
   is would be the site inventing a fact. */
.pack.done > .tgroup{border-color:rgba(46,204,113,.45);color:var(--up)}
.pack.done > .tgroup .gmeta,.pack.done > .tgroup .gmeta b{color:var(--up)}
.pack.done > .tgroup .caret{color:var(--up)}
.tick{font-size:13px;line-height:1}
.pack .tlist{padding-top:9px}
@media (prefers-reduced-motion:reduce){ .tgroup .caret{transition:none} }

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
  .tc::before{transform:none}
  .tcin{display:grid;grid-template-columns:auto 1fr;
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
/* Sized to sit in the tab row without being mistaken for a sort — it is the odd
   one out in that row and it should look it, so it keeps the panel background
   the tabs do not have. */
.spoillabel{display:inline-flex;align-items:center;gap:8px;cursor:pointer;
  color:var(--soft);font-size:13px;border:1px solid var(--edge);border-radius:99px;
  padding:6px 14px;background:var(--panel);user-select:none;margin-left:auto}
@media (max-width:640px){ .spoillabel{margin-left:0} }
.spoillabel::before{content:"\\2609";font-size:14px;line-height:1;color:var(--faint)}
.spoillabel:hover{color:var(--ink);border-color:var(--faint)}
.spoilbox:focus-visible + .tabs .spoillabel{outline:2px solid var(--kraken);outline-offset:2px}
.spoilbox:checked + .tabs .spoillabel{color:var(--kraken);border-color:var(--kraken)}
.spoilbox:checked + .tabs .spoillabel::before{content:"\\25C9";color:var(--kraken)}

.secret .spoil{filter:blur(5px);opacity:.75;transition:filter .18s ease,opacity .18s ease}
/* The row keeps its shape while blurred — the text is still there, just
   unreadable — so revealing does not reflow the table under the reader's
   thumb. */
/* The sibling combinator reaches every later sibling, and the packs are siblings of the input, so
   this unblurs a secret inside a folder whether the folder is open or shut. */
.spoilbox:checked ~ .tlist .secret .spoil,
.spoilbox:checked ~ .pack .secret .spoil,
.spoilbox:checked ~ .tablewrap .secret .spoil{filter:none;opacity:1}
.secretmark{display:inline-block;margin-top:5px;font-size:10px;letter-spacing:.08em;
  text-transform:uppercase;color:var(--brass);border:1px solid var(--edge);
  border-radius:99px;padding:2px 8px}
@media (prefers-reduced-motion:reduce){ .secret .spoil{transition:none} }

/* The index stripe. A game on its own has no progress, only a clock.

   TWO SHADES OF RED, and this used to be amber and TEAL. Teal is the accent
   this whole site uses for done, earned, yours and good; putting it on the
   stripe of a game with a deadline made people read the column as "do I have
   this?" and then work out, row by row, that it meant something else entirely.
   Martin hit exactly that and said so.

   A clock is bad news at both ends, so both ends are red and only the urgency
   changes: bright for inside a month, deep for further out. Nothing on the page
   is now coloured like the thing it is not. */
tr.st-dead  td.bar{background:#e5342c}
tr.st-soon  td.bar{background:var(--down)}
tr.st-clock td.bar{background:#8e3f3c}
tr.st-none  td.bar{background:var(--rule)}
@media (max-width:640px){
  .games tr.st-dead  td.gi{border-left-color:#e5342c}
  .games tr.st-soon  td.gi{border-left-color:var(--down)}
  .games tr.st-clock td.gi{border-left-color:#8e3f3c}
}

/* The lit row, borrowed from the trophy cards.

   A .got trophy card carries a wash that starts at its left edge and is gone by
   the middle, so a list of them reads as lit or unlit at a glance without any
   row shouting. The same treatment works on a table row and answers Martin's
   "even if it's half" literally: the gradient fades out at 45%, so the right
   half of the row stays plain and the numbers over there keep their contrast.

   On the ROW, not the cells. A background on a <td> would tile once per column
   and the gradient would restart at every cell boundary. */
tr.st-soon{background-image:linear-gradient(90deg,rgba(224,100,95,.17),rgba(224,100,95,.05) 22%,transparent 45%)}
tr.st-clock{background-image:linear-gradient(90deg,rgba(142,63,60,.19),rgba(142,63,60,.05) 22%,transparent 45%)}
/* DEAD IS THE ONE THAT DOES NOT FADE OUT.
   Martin: "dont half it full red so scrolling down i can see this is FUCKED".
   Closing soon is a warning and gets the half wash like everything else; a game
   whose trophies are already gone is not a warning, it is a verdict, and it
   carries colour the whole way across so it is unmissable at scrolling speed.
   Full width is what separates it from the two clock states, which are also red
   now — the shade says how bad, the WIDTH says whether it is over. */
tr.st-dead{background-image:linear-gradient(90deg,rgba(229,52,44,.22),rgba(229,52,44,.15) 55%,rgba(229,52,44,.11))}

/* And it brightens as your eye passes, the same half-pixel promise the cards
   make: this is the row you are on, nothing here is clickable. */
@media (hover: hover) {
  .games tbody tr{transition:background-color .14s ease}
  .games tbody tr:hover{background-color:rgba(255,255,255,.028)}
}

/* ---- who here has it ---- */
.games a.tname{color:inherit;text-decoration:none}
.games a.tname:hover{color:var(--kraken);text-decoration:underline}
.games a.who{color:inherit;text-decoration:none;font-weight:600;font-size:15px}
.games a.who:hover{color:var(--kraken);text-decoration:underline}
.games .av{width:34px;height:34px;flex:0 0 34px}
ul.feed a.t{color:inherit;text-decoration:none}
ul.feed a.t:hover{color:var(--kraken)}

/* The supporter star. Sized to sit on a name without shouting over it — it is
   a thank-you, not a rank, and the row already has a rank on it. */
.star{display:inline-flex;align-items:center;vertical-align:-2px;margin-left:6px;line-height:0}
.star svg{width:15px;height:15px;display:block}
.star.b{color:#e08a4a}
.star.s{color:#c9ccd1}
.star.g{color:#f0c419}
.star.p{color:#7fd6f5}
.hero h1 .star svg{width:22px;height:22px}
.hero h1 .star{margin-left:9px;vertical-align:-3px}


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
  // Plural, because the page behind it is now three boards and not one — and
  // the header and the front page read from this same array, so they cannot
  // disagree with each other or with the <h1> on the page itself.
  { href: '/leaderboard', label: 'Leaderboards', key: 'board' },
  { href: '/games', label: 'Games', key: 'games' },
  { href: '/contested', label: 'Contested', key: 'contested' },
  { href: '/faq', label: 'FAQ', key: 'faq' },
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
/**
 * THE UNFURL IS THE PITCH.
 *
 * Every time this domain is pasted into Discord, into a stream chat or into a
 * message, the first thing a stranger sees is the preview card, not the site.
 * It used to be whatever the crawler happened to scrape off the page. It is now
 * a deliberate picture with a deliberate sentence under it, which matters most
 * in exactly the situation the overlay was built for: somebody watching a
 * stream, seeing the link go past in chat.
 *
 * summary_large_image is what turns it from a thumbnail beside two lines of
 * grey text into the wide card people actually look at.
 *
 * The picture is public/og.png, built by tools/og-card.py, and it carries no
 * numbers on purpose. "70 hunters" baked into a file that never changes would
 * be wrong within a month. The counts go in the description, which every page
 * builds fresh from the database.
 */

/**
 * The canonical origin, for absolute URLs.
 *
 * og:image MUST be absolute. Discord, Twitter and every other unfurler fetch it
 * out of band, with no page to resolve a relative path against, so "/og.png"
 * silently produces a card with a blank space where the picture goes.
 */
export const SITE = 'https://platinumintel.co.uk';

export function page({
  title, body, description = '', here = '', bare = false, card = '/og.png',
}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0c1618">
<meta property="og:site_name" content="Platinum Intel">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
${description ? `<meta property="og:description" content="${esc(description)}">` : ''}
<meta property="og:image" content="${esc(SITE)}${esc(card)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
${description ? `<meta name="twitter:description" content="${esc(description)}">` : ''}
<meta name="twitter:image" content="${esc(SITE)}${esc(card)}">
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
    <span class="by">Brought to you by <a href="https://happysquidstudios.com"
      target="_blank" rel="noopener noreferrer">Happy Squid Studios</a>
      <a class="kofi" href="https://ko-fi.com/happysquidstudios"
        target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M3 9h13v5a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V9z" fill="currentColor"/><path
          d="M16.4 10.6h1.4a2.4 2.4 0 0 1 0 4.8h-1.4" fill="none" stroke="currentColor"
          stroke-width="1.7"/><path d="M6.6 6.2V4.3M10 6.2V3.2M13.4 6.2V4.3" fill="none"
          stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path
          d="M2.6 21.2h14.8" fill="none" stroke="currentColor" stroke-width="1.7"
          stroke-linecap="round"/></svg>Buy us a coffee</a></span>
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
