/**
 * What the server is collectively stuck on. GET /contested
 *
 * The last grey link in the header, and the only page on this site that is
 * about the SERVER rather than about a person or a game. The leaderboard says
 * who is winning; the index says what exists; this says what everybody is
 * currently banging their head against, which is the one question a trophy
 * Discord actually talks about out loud.
 *
 * THE DEFINITION IS NOT INVENTED HERE. `shared/contested.mjs` is canonical and
 * the Discord `/contested` command uses it. The ordering below is copied from
 * it byte for byte — if the two ever disagree, members get one answer in the
 * channel and a different one on the site, and both look wrong.
 *
 * WHAT THIS PAGE ADDS over the Discord card, which is a ten-line list:
 *
 *   the whole board, paged, rather than the top ten
 *   WHO IS CLOSEST — the unfinished owner furthest along, by name
 *   the multiplier the scoring is actually applying right now
 *   what the platinum pays at that multiplier
 *
 * "Who is closest" is the reason the page exists. "Six of nine are still stuck
 * on Elden Ring" is a statistic; "six of nine, and Leon is on 94%" is a race,
 * and the difference between those two sentences is the whole feature.
 */

import {
  page, html, esc, n, pct, crumb, gameHref,
  closingState, closingLabel, isUrgent,
} from './_lib/page.js';
import { localMultiplier } from '../shared/scoring.mjs';
import { CONTESTED_MIN_OWNERS } from '../shared/contested.mjs';

/**
 * Twenty-five, not fifty.
 *
 * Each row costs a second lookup for its closest hunter, so the page size is
 * also the size of that second query. Fifty games at ten owners each would read
 * five hundred member_games rows to print fifty names.
 */
const PER_PAGE = 25;

/**
 * MIRRORED from shared/contested.mjs. Only the SELECT list differs — this page
 * needs the icon and the platinum's own price, which the Discord card does not
 * print. Every WHERE and every ORDER BY term is identical, deliberately.
 *
 * The ORDER BY omits the exponent and cap that localMultiplier() applies, for
 * the reason given in contested.mjs: both are monotonic, so they cannot change
 * the ordering, and leaving them out keeps this to arithmetic SQLite does
 * without complaint.
 */
const LIST = `
  SELECT g.np_comm_id, g.title, g.platform, g.icon_url, g.trophy_count,
         g.max_points, g.estimated, g.local_started,
         g.unobtainable, g.unobtainable_note, g.closes_at,
         t.local_earned AS platted_here,
         t.points       AS plat_points,
         t.earned_rate  AS plat_rate
    FROM games g
    JOIN trophies t
      ON t.np_comm_id = g.np_comm_id AND t.type = 'platinum'
   WHERE g.local_started >= ?
     AND t.local_earned < g.local_started
     AND g.max_points > 0
     AND g.unobtainable = 0
   ORDER BY CASE WHEN g.closes_at IS NOT NULL THEN 0 ELSE 1 END,
            g.closes_at ASC,
            (g.local_started + 0.5) / (t.local_earned + 0.5) DESC,
            g.local_started DESC,
            g.max_points DESC
   LIMIT ? OFFSET ?`;

/**
 * The nearest miss in each game on this page.
 *
 * ONE QUERY FOR THE WHOLE PAGE, not one per row. Twenty-five round trips to
 * name twenty-five people would cost more in latency than the entire rest of
 * the page costs in rows.
 *
 * `progress < 100` is what makes somebody "still in it" — a member sitting at
 * 100% has finished and is not part of the contest, whatever the platinum row
 * says about them. `rank IS NOT NULL` matches every other list on the site: a
 * member mid-first-scan is not somebody you are racing yet.
 */
const closestSql = (count) => `
  SELECT mg.np_comm_id, mg.progress, m.psn_online_id
    FROM member_games mg
    JOIN members m ON m.psn_account_id = mg.psn_account_id
   WHERE mg.np_comm_id IN (${Array.from({ length: count }, () => '?').join(',')})
     AND mg.progress < 100
     AND m.rank IS NOT NULL
   ORDER BY mg.progress DESC`;

/**
 * The stripe down the side, same language as the index.
 *
 * A contested game has no deadline most of the time, so the default row is
 * unshaded and the coloured ones are exactly the urgent ones. That is the whole
 * job of this column: make the rows that are running out of time findable
 * without reading a single date.
 */
const stripe = (g) => {
  const state = closingState(g);
  if (state === 'closing') return isUrgent(g.closes_at) ? 'st-soon' : 'st-clock';
  return 'st-none';
};

function row(g, closest, position) {
  const owners = Number(g.local_started) || 0;
  const done = Number(g.platted_here) || 0;
  const stuck = Math.max(0, owners - done);
  const mult = localMultiplier(done, owners);
  const soon = closingState(g) === 'closing';

  /**
   * The multiplier is shown to two decimals and never rounded to a whole
   * number. ×1.00 and ×1.4 are completely different situations and "×1" for
   * both would flatten the only figure on this page that moves week to week.
   */
  const multLabel = `&times;${mult.toFixed(2)}`;

  return `<tr class="${stripe(g)}">
    <td class="pos">${n(position)}</td>
    <td class="gi">${
      g.icon_url
        ? `<img class="ico" src="${esc(g.icon_url)}" alt="" loading="lazy" width="56" height="56">`
        : '<span class="ico"></span>'
    }</td>
    <td class="gt">
      ${g.platform ? `<span class="plat-chip">${esc(g.platform)}</span>` : ''}<a
        class="tname" href="${esc(gameHref(g.np_comm_id))}">${esc(g.title)}</a>${
    soon
      ? `<span class="mk clock${isUrgent(g.closes_at) ? ' soon' : ''}" title="${esc(
          closingLabel(g.closes_at),
        )}">${isUrgent(g.closes_at) ? '&#8987;' : '&#128338;'}</span>`
      : ''
  }
      <span class="meta">${n(g.trophy_count)} ${
    Number(g.trophy_count) === 1 ? 'trophy' : 'trophies'
  }${
    g.plat_rate != null && Number(g.plat_rate) > 0
      ? ` &middot; ${pct(g.plat_rate)} of the world has the platinum`
      : ''
  }</span>${
    soon
      ? `<span class="closes${isUrgent(g.closes_at) ? '' : ' later'}">${esc(
          closingLabel(g.closes_at),
        )}</span>`
      : ''
  }
    </td>
    <td class="num stuck" data-v="${stuck}">${n(stuck)} <span class="of-max">of ${n(
    owners,
  )}</span></td>
    <td class="closest">${
      /**
       * The name is the point. A row that says only "6 of 9" is a fact about a
       * game; the same row with somebody's name on 94% is a fact about a person
       * you talk to every day, and that is what gets read.
       */
      closest
        ? `<a href="/hunter/${encodeURIComponent(closest.psn_online_id)}">${esc(
            closest.psn_online_id,
          )}</a><span class="cp">${n(Math.floor(Number(closest.progress) || 0))}%</span>`
        : '<span class="cnone">no progress yet</span>'
    }</td>
    <td class="num mult" data-v="${mult.toFixed(4)}" title="Every trophy in this game is worth ${
    multLabel
  } while people here are still stuck on it">${multLabel}</td>
    <td class="num pts" data-v="${Number(g.plat_points) || 0}">${n(g.plat_points)}${
    Number(g.estimated) === 1 ? '<span class="est sm">est</span>' : ''
  }</td>
    <td class="bar"></td>
  </tr>`;
}

function pager(pageNo, hasNext) {
  if (pageNo <= 1 && !hasNext) return '';
  const bits = [];
  if (pageNo > 1) bits.push(`<a href="/contested?page=${pageNo - 1}">&lsaquo; Previous</a>`);
  bits.push(`<span class="of">Page ${n(pageNo)}</span>`);
  if (hasNext) bits.push(`<a href="/contested?page=${pageNo + 1}">Next &rsaquo;</a>`);
  return `<nav class="pager">${bits.join('')}</nav>`;
}

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const pageNo = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));
  const offset = (pageNo - 1) * PER_PAGE;

  // One more than shown, so the existence of that row IS "is there a next
  // page". No COUNT anywhere on this site, for the reason /games explains.
  const { results: fetched = [] } = await env.DB.prepare(LIST)
    .bind(CONTESTED_MIN_OWNERS, PER_PAGE + 1, offset)
    .all();

  const hasNext = fetched.length > PER_PAGE;
  const games = fetched.slice(0, PER_PAGE);

  /**
   * The closest hunter per game, from one query over exactly the ids on this
   * page. Sorted by progress descending, so the FIRST row seen for a game is
   * its leader and every later one is discarded.
   */
  const closest = new Map();
  if (games.length) {
    const ids = games.map((g) => g.np_comm_id);
    const { results: near = [] } = await env.DB.prepare(closestSql(ids.length))
      .bind(...ids)
      .all();
    for (const r of near) if (!closest.has(r.np_comm_id)) closest.set(r.np_comm_id, r);
  }

  const body = `
    ${crumb('/', 'Home')}

    <section class="hero plain">
      <h1>Contested</h1>
      <p class="sub">What we are all still stuck on, and what it is paying because of it.</p>
    </section>

    <p class="lede">
      A game gets <b>more valuable while people here are still stuck on it</b>, and settles back
      down as they finish. These are the ones several of us own and nobody has closed out.
      Every trophy in them is worth more right now than it will be once somebody does.
    </p>

    ${
      games.length
        ? `<div class="tablewrap">
             <table class="games contested">
               <thead><tr>
                 <th class="pos"></th>
                 <th class="gi"></th>
                 <th>Game</th>
                 <th class="num" title="Members here who own it and have not finished it">Stuck</th>
                 <th title="The one furthest along who has not finished">Closest</th>
                 <th class="num" title="What every trophy in it is multiplied by right now">Worth</th>
                 <th class="num" title="What the platinum pays at that multiplier">Platinum</th>
                 <th class="bar"></th>
               </tr></thead>
               <tbody>${games
                 .map((g, i) => row(g, closest.get(g.np_comm_id), offset + i + 1))
                 .join('')}</tbody>
             </table>
           </div>
           ${pager(pageNo, hasNext)}
           <p class="note">
             Games with an announced closing date sort to the top, soonest first. A deadline
             beats a difficulty ranking. Games whose trophies are already unearnable are left
             off entirely: a board headed &ldquo;contested&rdquo; is a suggestion, and there is
             no point suggesting a wall. They still pay their owners exactly what they always
             did.
           </p>`
        : `<div class="tablewrap"><p class="empty">
             Nothing is contested right now. That means every game ${n(CONTESTED_MIN_OWNERS)} or
             more of us own has been finished by somebody here, which is either very impressive
             or very quiet.
           </p></div>`
    }

    <footer>
      <a href="/games">The whole index</a> &middot;
      <a href="/leaderboard">Back to the board</a>
    </footer>`;

  return html(
    page({ title: 'Contested', active: 'contested', body }),
    // Five minutes, like every other list. The underlying numbers only move
    // when the nightly rescore runs.
    { maxAge: 300 },
  );
}
