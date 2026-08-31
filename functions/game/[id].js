/**
 * One game. GET /game/<np_comm_id>
 *
 * THE FIRST PAGE ON THIS SITE THAT IS NOT ABOUT A PERSON. The board ranks
 * hunters, a hunter page lists their library, and both answer "who is winning".
 * This one answers "what am I in for" — every trophy in a game, how rare each
 * one is out in the world, how rare it is HERE, and which of the sixty-four
 * have already done it.
 *
 * THE LOCAL COLUMN IS THE WHOLE POINT. PSN's global rarity is on every trophy
 * site there has ever been. "Four of us have this and three of them are in your
 * Discord" is on none of them, and it is the number that actually makes
 * somebody open the game — so it sits beside the world figure rather than
 * behind a tab, and the sort tabs open on neither.
 *
 * COST. Reading one game is a primary-key lookup, its trophies is `trophy_count`
 * rows — forty on a normal game, a hundred and twenty on the worst — and its
 * owners is capped by the size of the server, so sixty-four. Under two hundred
 * rows for a page that then sits in the edge cache for five minutes, which
 * makes this cheaper than the board. No pagination, because there is nothing
 * here big enough to need it.
 *
 * THE SITE COMPUTES NOTHING, same as everywhere else. `t.points` is what the
 * bot priced that trophy at, blended with local rarity; `g.max_points` is what
 * the bot says a full completion pays. This file adds up trophy TYPES for the
 * cabinet line and nothing else.
 */

import {
  page, html, esc, n, pct, cup, miniCups, trophyGlyph,
  closingState, closingLabel, isUrgent,
} from '../_lib/page.js';

/**
 * Sorts, as a whitelist. The key never reaches SQL — it picks a fragment.
 * Same rule as the hunter page: a user string in an ORDER BY is the database.
 */
const SORTS = {
  psn: { label: 'Trophy order', sql: 't.trophy_id ASC' },
  here: { label: 'Rarest here', sql: 't.local_earned ASC, t.earned_rate ASC, t.trophy_id ASC' },
  world: { label: 'Rarest on PSN', sql: 't.earned_rate ASC, t.trophy_id ASC' },
  points: { label: 'Most points', sql: 't.points DESC, t.trophy_id ASC' },
};

/**
 * PSN ORDER, and that was a choice with an argument on both sides.
 *
 * Rarest-first leads with our own data and puts the hard ones on top, which is
 * the better page for somebody deciding whether to bother. It is the worse page
 * for somebody who has decided — they are looking for the trophy they are
 * stuck on, and they know where it sits in the in-game list because they have
 * been staring at it. Sony's order is the order on their console, so it is the
 * one people can already navigate. Rarity is one tab away.
 */
const DEFAULT_SORT = 'psn';

const GAME = `
  SELECT np_comm_id, title, platform, icon_url, trophy_count, has_platinum,
         max_points, estimated, unobtainable, unobtainable_note, flagged_at,
         closes_at, local_started, refreshed_at
    FROM games
   WHERE np_comm_id = ?
   LIMIT 1`;

/**
 * The fallback, for URLs typed by hand.
 *
 * `NPWR07110_00` is unguessable, so /game/Bloodborne is what anybody types and
 * what anybody pastes into Discord from memory. It only runs when the id lookup
 * misses, so the normal path is still one primary-key read, and it is capped at
 * one row: several editions of a game share a title and picking the one most
 * people here own is the only answer that is right more often than not.
 */
const GAME_BY_TITLE = `
  SELECT np_comm_id, title, platform, icon_url, trophy_count, has_platinum,
         max_points, estimated, unobtainable, unobtainable_note, flagged_at,
         closes_at, local_started, refreshed_at
    FROM games
   WHERE title = ? COLLATE NOCASE
   ORDER BY local_started DESC, trophy_count DESC
   LIMIT 1`;

const trophiesSql = (order) => `
  SELECT trophy_id, name, detail, type, icon_url, hidden,
         earned_rate, points, local_earned
    FROM trophies t
   WHERE t.np_comm_id = ?
   ORDER BY ${order}`;

/**
 * Everybody here who owns it, finished or not.
 *
 * ALL OF THEM, not a top ten. On Elden Ring this is thirty rows and a leader
 * board in miniature; on some Vita visual novel it is two rows, and THAT is the
 * version worth having — "only me and Chez own this" is the sentence this panel
 * exists to produce, and a top-ten cut would render it identically to a game
 * nobody has heard of. Sixty-four rows is a smaller read than the board page.
 *
 * `rank IS NOT NULL` keeps members who have never finished a scan out of it,
 * matching every other list on the site.
 */
const OWNERS = `
  SELECT m.psn_online_id, m.avatar_url, m.rank,
         mg.progress, mg.points, mg.earned_total, mg.earned_platinum,
         mg.earned_gold, mg.earned_silver, mg.earned_bronze,
         mg.last_played_at, mg.last_earned_at
    FROM member_games mg
    JOIN members m ON m.psn_account_id = mg.psn_account_id
   WHERE mg.np_comm_id = ?
     AND m.rank IS NOT NULL
   ORDER BY mg.progress DESC, mg.points DESC, m.rank ASC`;

/**
 * Sony's own rarity bands, not ones we invented.
 *
 * Every PlayStation owner has seen these five words attached to these five
 * ranges since 2018. Making up our own thresholds would put "Rare" on a trophy
 * the console calls Common, and the console is the thing people believe.
 */
const BANDS = [
  [5, 'Ultra rare', 'ur'],
  [10, 'Very rare', 'vr'],
  [20, 'Rare', 'r'],
  [50, 'Uncommon', 'u'],
  [Infinity, 'Common', 'c'],
];

function band(rate) {
  const v = Number(rate);
  if (!Number.isFinite(v) || v <= 0) return null;
  return BANDS.find(([max]) => v <= max);
}

/** "12 Feb 2026". */
const on = (ms) =>
  Number(ms)
    ? new Date(Number(ms)).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    : '';

/**
 * The clock, matching the hunter page exactly.
 *
 * Copied rather than shared because the two pages want different wrappers
 * around it and the shared version would grow a flag argument within a week.
 * If the marks ever change they change in shared/closing.mjs, which both read.
 */
function clockBlock(g) {
  const state = closingState(g);
  if (state === 'closing') {
    const soon = isUrgent(g.closes_at);
    // ONE TEXT NODE, not two. The mark and the sentence are the flex items; if
    // the <b> is a third, "closes in 21 days" becomes its own column on a phone
    // and wraps three words tall beside a paragraph that does not.
    return `<p class="warn clock${soon ? ' soon' : ''}">
      <span class="mk">${soon ? '&#8987;' : '&#128338;'}</span>
      <span><b>${esc(closingLabel(g.closes_at))}.</b> Everything in it is still earnable
        until then.${g.unobtainable_note ? ` ${esc(g.unobtainable_note)}` : ''}</span></p>`;
  }
  if (state === 'dead') {
    return `<p class="warn dead">
      <span class="mk">&#9888;</span>
      <span><b>Some trophies here can no longer be earned.</b> ${esc(
        g.unobtainable_note || 'A moderator flagged this game as no longer completable.',
      )}</span></p>`;
  }
  return '';
}

/**
 * One trophy.
 *
 * SECRET TROPHIES ARE BLURRED, NOT WITHHELD. The name and the description are
 * in the HTML — same as PSNProfiles, and the same as any page with a reveal
 * button, because a reveal that costs a round trip is a reveal nobody clicks.
 * What the blur buys is that you cannot be spoiled BY ACCIDENT while scrolling
 * a game you have not played, which is the entire risk. Somebody determined to
 * read it through the blur has, by definition, decided to.
 *
 * The toggle is a checkbox and a sibling selector — no JavaScript, works on a
 * phone, and it is one control for the whole page rather than a button per row.
 */
function trophyRow(t, { localTotal }) {
  const b = band(t.earned_rate);
  const metal = ['platinum', 'gold', 'silver', 'bronze'].includes(String(t.type))
    ? String(t.type)[0]
    : 'b';
  const secret = Number(t.hidden) === 1;
  const here = Number(t.local_earned) || 0;
  const share = localTotal > 0 ? Math.round((here / localTotal) * 100) : 0;

  return `<tr class="tr-${metal}${secret ? ' secret' : ''}">
    <td class="gi">${
      t.icon_url
        ? `<img class="ico sm" src="${esc(t.icon_url)}" alt="" loading="lazy" width="44" height="44">`
        : `<span class="ico sm cup ${metal}">${trophyGlyph()}</span>`
    }</td>
    <td class="tn">
      <span class="spoil">
        <span class="tname">${esc(t.name || 'Unnamed trophy')}</span>
        ${t.detail ? `<span class="tdet">${esc(t.detail)}</span>` : ''}
      </span>
      ${secret ? '<span class="secretmark">Secret</span>' : ''}
    </td>
    <td class="num rare">${
      b
        ? `<span class="rb ${b[2]}">${pct(t.earned_rate)}</span><span class="rl">${esc(b[1])}</span>`
        : '<span class="rb none">&mdash;</span><span class="rl">Not published</span>'
    }</td>
    <td class="num local" data-v="${here}">
      <span class="${here === 0 ? 'nobody' : ''}">${n(here)} <span class="of-max">/ ${n(
        localTotal,
      )}</span></span>
      <span class="track sm"><span class="fill here" style="width:${share}%"></span></span>
      <span class="tcount">${
        here === 0 ? 'nobody here' : here === 1 ? 'one of us' : `${share}% of us`
      }</span>
    </td>
    <td class="num pts" data-v="${Number(t.points) || 0}">${n(t.points)}</td>
    <td class="bar"></td>
  </tr>`;
}

/** One member who owns it. */
function ownerRow(o) {
  const width = Math.max(0, Math.min(100, Number(o.progress) || 0));
  const done = width === 100;
  const shade = done
    ? 'ok'
    : Number(o.earned_platinum) > 0
      ? 'p'
      : Number(o.earned_gold) > 0
        ? 'g'
        : Number(o.earned_silver) > 0
          ? 's'
          : Number(o.earned_total) > 0
            ? 'b'
            : 'none';

  return `<tr class="sh-${shade}">
    <td class="gi">${
      o.avatar_url
        ? `<img class="av" src="${esc(o.avatar_url)}" alt="" loading="lazy" width="34" height="34">`
        : '<span class="av"></span>'
    }</td>
    <td class="gt"><a class="who" href="/hunter/${encodeURIComponent(
      o.psn_online_id,
    )}">${esc(o.psn_online_id)}</a>
      <span class="meta">${miniCups(
        o.earned_platinum, o.earned_gold, o.earned_silver, o.earned_bronze,
      )}${
        // The date only means something once they have stopped: mid-grind it is
        // "when they last got one", which is already the trophy count's job.
        done && o.last_earned_at ? ` · finished ${esc(on(o.last_earned_at))}` : ''
      }</span>
    </td>
    <td class="num prog" data-v="${width}">
      <span class="${done ? 'done' : ''}">${width}%</span>
      <span class="track"><span class="fill ${shade}" style="width:${width}%"></span></span>
    </td>
    <td class="num pts" data-v="${Number(o.points) || 0}">${n(o.points)}</td>
    <td class="bar"></td>
  </tr>`;
}

export async function onRequestGet({ params, env, request }) {
  const id = decodeURIComponent(params.id || '');
  const url = new URL(request.url);
  const sort = SORTS[url.searchParams.get('sort')] ? url.searchParams.get('sort') : DEFAULT_SORT;

  const g =
    (await env.DB.prepare(GAME).bind(id).first()) ||
    (await env.DB.prepare(GAME_BY_TITLE).bind(id).first());

  if (!g) {
    return html(
      page({
        title: 'Not found',
        here: 'games',
        body: `<div class="tablewrap"><p class="empty">
                 No game called <b>${esc(id)}</b> is in the index.<br>
                 Games arrive here when somebody who owns one runs an update.<br>
                 <a href="/games">Browse the index</a>
               </p></div>`,
      }),
      { status: 404, maxAge: 60 },
    );
  }

  const [{ results: trophies = [] }, { results: owners = [] }] = await Promise.all([
    env.DB.prepare(trophiesSql(SORTS[sort].sql)).bind(g.np_comm_id).all(),
    env.DB.prepare(OWNERS).bind(g.np_comm_id).all(),
  ]);

  // The cabinet, counted from the rows already in hand rather than by asking
  // the database for four more numbers it would have to scan for anyway.
  const cabinet = { platinum: 0, gold: 0, silver: 0, bronze: 0 };
  let secrets = 0;
  for (const t of trophies) {
    if (cabinet[t.type] !== undefined) cabinet[t.type] += 1;
    if (Number(t.hidden) === 1) secrets += 1;
  }

  /**
   * The denominator on the local column.
   *
   * `owners.length`, NOT `g.local_started`. The stored count includes members
   * whose rank is null — anybody mid-first-scan — and the panel below does not
   * list them, so using the stored figure would print "3 / 12" above a list of
   * eleven people and look like a bug, because it would be one.
   */
  const here = owners.length;
  const finished = owners.filter((o) => Number(o.progress) === 100).length;
  const started = owners.filter((o) => Number(o.earned_total) > 0).length;

  const tabs = Object.entries(SORTS)
    .map(
      ([key, s]) =>
        `<a class="tab${key === sort ? ' on' : ''}" href="/game/${encodeURIComponent(
          g.np_comm_id,
        )}?sort=${key}">${esc(s.label)}</a>`,
    )
    .join('');

  const body = `
    <section class="ghero">
      ${
        g.icon_url
          ? `<img class="bigico" src="${esc(g.icon_url)}" alt="" width="96" height="96">`
          : '<span class="bigico"></span>'
      }
      <div class="gh">
        <h1>${g.platform ? `<span class="plat-chip">${esc(g.platform)}</span>` : ''}${esc(
          g.title,
        )}</h1>
        <p class="sub">
          <b>${n(g.max_points)}</b> points for a full completion
          ${
            // A guess, said out loud. PSN publishes no rarity for some games,
            // usually brand new ones, and the bot prices those from the trophy
            // mix alone. Printing that number without a word beside it is how a
            // site loses the argument about its own scoring.
            Number(g.estimated) === 1
              ? '<span class="est" title="PSN has published no rarity for this game yet">estimated</span>'
              : ''
          }
        </p>
      </div>
    </section>

    ${clockBlock(g)}

    <div class="cups">
      ${cup('p', cabinet.platinum, 'Platinum')}
      ${cup('g', cabinet.gold, 'Gold')}
      ${cup('s', cabinet.silver, 'Silver')}
      ${cup('b', cabinet.bronze, 'Bronze')}
      <dl class="facts">
        <div><dt>Trophies</dt><dd>${n(trophies.length || g.trophy_count)}</dd></div>
        <div><dt>Owned here</dt><dd>${n(here)}</dd></div>
        <div><dt>Finished here</dt><dd>${n(finished)}</dd></div>
      </dl>
    </div>

    <div class="tabs">${tabs}</div>

    ${
      /*
       * THE CHECKBOX SITS OUTSIDE THE TOOLROW, and that is not tidiness.
       *
       * The reveal is a sibling selector — `:checked ~ .tablewrap` — and a
       * sibling combinator only reaches elements with the same parent. Wrapped
       * in the toolrow div with its label, the input could style the label
       * beside it and nothing else on the page; the blur would never lift and
       * every test asserting on the CSS would still pass. So the input is a
       * direct child of the page body, immediately before the row that carries
       * its label, and the table it unblurs is a later sibling of the input.
       */
      secrets
        ? `<input type="checkbox" id="spoilers" class="spoilbox">
           <div class="toolrow"><label for="spoilers" class="spoillabel"
             >Reveal ${n(secrets)} secret ${
               secrets === 1 ? 'trophy' : 'trophies'
             }</label></div>`
        : ''
    }

    ${
      trophies.length
        ? `<div class="tablewrap">
             <table class="games trophies">
               <thead><tr>
                 <th class="gi"></th>
                 <th>Trophy</th>
                 <th class="num" title="How many PlayStation owners worldwide have earned it">PSN</th>
                 <th class="num" title="How many people on this server have earned it">Here</th>
                 <th class="num">Points</th>
                 <th class="bar"></th>
               </tr></thead>
               <tbody>${trophies.map((t) => trophyRow(t, { localTotal: here })).join('')}</tbody>
             </table>
           </div>`
        : `<div class="tablewrap"><p class="empty">
             No trophy list for this game yet. It arrives the next time somebody
             who owns it runs a deep scan.
           </p></div>`
    }

    <section class="panel">
      <h2>Who here has it</h2>
      ${
        owners.length
          ? `<div class="tablewrap">
               <table class="games">
                 <thead><tr>
                   <th class="gi"></th>
                   <th>Hunter</th>
                   <th class="num">Progress</th>
                   <th class="num">Points</th>
                   <th class="bar"></th>
                 </tr></thead>
                 <tbody>${owners.map(ownerRow).join('')}</tbody>
               </table>
             </div>
             <p class="note">${
               finished === here
                 ? `Everybody here who owns it has finished it.`
                 : `${n(finished)} of ${n(here)} finished it${
                     started > finished ? `, ${n(started - finished)} more have started` : ''
                   }.`
             }</p>`
          : `<p class="note">Nobody on the board owns this one yet. It is in the
               index because the dice can reach it.</p>`
      }
    </section>

    <footer>
      <a href="/games">Back to the index</a>
    </footer>`;

  return html(
    page({
      title: `${g.title} · Kraken`,
      description: `${g.title} is worth ${n(g.max_points)} points. ${
        here ? `${here} on Platinum Intel own it, ${finished} have finished it.` : ''
      }`,
      here: 'games',
      body,
    }),
  );
}
