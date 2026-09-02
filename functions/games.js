/**
 * The index. GET /games
 *
 * EVERY GAME ANYBODY HERE OWNS, which is roughly twenty-six thousand of them
 * and climbing every time somebody new runs a scan. This is the page that turns
 * "Games" in the header from grey text into a door, and it exists mostly to be
 * a way in to /game/<id> — a list nobody can reach is a list nobody has.
 *
 * NO COUNT(*), ANYWHERE. Counting twenty-six thousand rows to print "of 520"
 * reads twenty-six thousand rows, on every view, to produce a number that
 * changes twice a day. So the pager fetches one row more than it shows and the
 * existence of that row is the whole of "is there a next page" — the same trick
 * the hunter page uses while searching, applied here permanently.
 *
 * SEARCH IS THE EXPENSIVE ONE and it happens ON SUBMIT. A LIKE '%x%' cannot use
 * the title index, so a search reads the table. That is affordable once per
 * search and ruinous once per keystroke, which is why this is a form with a
 * button and not an input with a listener.
 */

import {
  page, html, esc, n, crumb, closingState, closingLabel, isUrgent,
} from './_lib/page.js';

const PER_PAGE = 50;

const SORTS = {
  owned: { label: 'Owned here', sql: 'g.local_started DESC, g.max_points DESC, g.title ASC' },
  points: { label: 'Most points', sql: 'g.max_points DESC, g.title ASC' },
  /**
   * Deadlines first, everything without one after.
   *
   * SQLite sorts NULL before everything, so a plain `closes_at ASC` would open
   * this tab on twenty-six thousand games that are not closing, followed
   * eventually by the four that are. The CASE puts the dated rows on top, which
   * is the only reason anybody clicks this tab.
   */
  closing: {
    label: 'Closing soon',
    sql: 'CASE WHEN g.closes_at IS NULL THEN 1 ELSE 0 END, g.closes_at ASC, g.title ASC',
  },
  trophies: { label: 'Most trophies', sql: 'g.trophy_count DESC, g.title ASC' },
  title: { label: 'Name', sql: 'g.title ASC' },
};

/**
 * OWNED HERE, not points.
 *
 * Opening on the most valuable games shows the same wall of thousand-trophy
 * shovelware every time, because that is what pays. Opening on what this server
 * actually plays makes the first screen recognisable — the games in the Discord
 * — and that is the difference between an index and a database dump.
 */
const DEFAULT_SORT = 'owned';

/**
 * `local_started > 0` is a floor, not a filter of convenience.
 *
 * The games table collects everything PSN mentions while scanning a library,
 * including titles nobody here has ever launched. Those are real rows and the
 * dice are allowed to reach them, but they have no business on page one of a
 * list called "what we play" — and they arrive with no icon and no owner, so
 * they render as a grey band with a name in it.
 */
/**
 * `dead_trophies` is what tells a wholly-gone game from a partly-broken one.
 *
 * DERIVED, NOT STORED. A column would need a migration and could drift out of
 * step with the trophies it describes; this counts them, so it cannot. The
 * subquery reads `idx_trophies_dead`, which is PARTIAL: it holds only rows
 * where unobtainable = 1, so it walks dozens rather than a million.
 *
 * LEFT JOIN, so a game with nothing flagged still appears, with a null count.
 */
const listSql = (order, search) => `
  SELECT g.np_comm_id, g.title, g.platform, g.icon_url, g.trophy_count,
         g.max_points, g.estimated, g.unobtainable, g.unobtainable_note,
         g.closes_at, g.local_started, d.dead AS dead_trophies
    FROM games g
    LEFT JOIN (SELECT np_comm_id, COUNT(*) AS dead
                 FROM trophies WHERE unobtainable = 1
                GROUP BY np_comm_id) d ON d.np_comm_id = g.np_comm_id
   WHERE g.local_started > 0
     ${search ? `AND g.title LIKE ? ESCAPE '\\'` : ''}
   ORDER BY ${order}
   LIMIT ? OFFSET ?`;

const likeTerm = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The mark beside a title, and the sentence under it. Same shape as the hunter
 * page, and for the same reason — see the note there. Short version: the popup
 * this replaced turned the table into a scroll container on every phone.
 */
function clockMarks(g) {
  const state = closingState(g);

  if (state === 'closing') {
    const soon = isUrgent(g.closes_at);
    return {
      mark: `<span class="mk clock${soon ? ' soon' : ''}" title="${esc(
        closingLabel(g.closes_at),
      )}">${soon ? '&#8987;' : '&#128338;'}</span>`,
      note: '',
    };
  }

  if (state === 'dead') {
    /**
     * THE MOD'S NOTE MOVES ONTO THE SYMBOL, and none of their work is lost.
     *
     * "4 Trophies Unobtainable - UGC Servers Shutdown 31st August 2026" is a
     * good note and a bad table row: it is longer than the game title, wraps to
     * a second line, and pushes every row below it down. In a list of forty
     * games the exception ends up shouting louder than the games.
     *
     * It is a `title` attribute rather than a styled tooltip ON PURPOSE. A
     * positioned popup inside `.tablewrap` is exactly what caused Leon's
     * scrollbar bug: `overflow-x:auto` promotes the other axis to auto, so an
     * absolutely positioned child made the whole table scroll vertically. The
     * browser's own tooltip has no layout at all and cannot do that.
     *
     * The note is still printed IN FULL on the game page itself, so a phone,
     * where `title` does nothing, is one tap from the whole sentence.
     */
    /**
     * RED WHEN ALL OF IT IS GONE, brass when only some is. In a list of forty
     * games the colour is the only thing separating "skip four of these" from
     * "do not start this at all", and JFL__Leon's point was that XDefiant and
     * WWE 2K24 looked identical while one of them was entirely dead.
     */
    const whole =
      Number(g.trophy_count) > 0 && Number(g.dead_trophies || 0) >= Number(g.trophy_count);
    return {
      mark: `<span class="mk dead${whole ? ' whole' : ''}" title="${esc(
        g.unobtainable_note ||
          (whole
            ? 'Nothing in this game can be earned any more.'
            : 'Some trophies in this game can no longer be earned.'),
      )}">&#9888;</span>`,
      note: '',
    };
  }

  return { mark: '', note: '' };
}

/**
 * The stripe down the side of a row.
 *
 * ON A HUNTER PAGE that column is their progress, because a game on a person's
 * page has one. A game on the index has no "your" in it, so the only status it
 * carries by itself is the clock — and shading by it means the "Closing soon"
 * tab is readable as a column of colour before a single date is read. Nothing
 * here contradicts the other tables; it is a different question on a different
 * page, answered in the same place.
 */
const stripe = (g) => {
  const state = closingState(g);
  if (state === 'dead') return 'st-dead';
  if (state === 'closing') return isUrgent(g.closes_at) ? 'st-soon' : 'st-clock';
  return 'st-none';
};

function row(g) {
  const marks = clockMarks(g);
  const owned = Number(g.local_started) || 0;
  const href = `/game/${encodeURIComponent(g.np_comm_id)}`;

  return `<tr class="${stripe(g)}">
    <td class="gi">${
      g.icon_url
        ? `<img class="ico" src="${esc(g.icon_url)}" alt="" loading="lazy" width="56" height="56">`
        : '<span class="ico"></span>'
    }</td>
    <td class="gt">
      ${g.platform ? `<span class="plat-chip">${esc(g.platform)}</span>` : ''}<a
        class="tname" href="${esc(href)}">${esc(g.title)}</a>${marks.mark}
      <span class="meta">${n(g.trophy_count)} ${
        Number(g.trophy_count) === 1 ? 'trophy' : 'trophies'
      }</span>${
        closingState(g) === 'closing'
          ? `<span class="closes${isUrgent(g.closes_at) ? '' : ' later'}">${esc(
              closingLabel(g.closes_at),
            )}</span>`
          : ''
      }${marks.note}
    </td>
    <td class="num" data-v="${owned}">${n(owned)} <span class="of-max">${
      owned === 1 ? 'hunter' : 'hunters'
    }</span></td>
    <td class="num pts" data-v="${Number(g.max_points) || 0}">${n(g.max_points)}${
      Number(g.estimated) === 1 ? '<span class="est sm">est</span>' : ''
    }</td>
    <td class="bar"></td>
  </tr>`;
}

function pager(sort, q, pageNo, hasNext) {
  const href = (p) => `/games?sort=${sort}&page=${p}` + (q ? `&q=${encodeURIComponent(q)}` : '');
  if (pageNo <= 1 && !hasNext) return '';

  const bits = [];
  if (pageNo > 1) bits.push(`<a href="${esc(href(pageNo - 1))}">&lsaquo; Previous</a>`);
  bits.push(`<span class="of">Page ${n(pageNo)}</span>`);
  if (hasNext) bits.push(`<a href="${esc(href(pageNo + 1))}">Next &rsaquo;</a>`);
  return `<nav class="pager">${bits.join('')}</nav>`;
}

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const sort = SORTS[url.searchParams.get('sort')] ? url.searchParams.get('sort') : DEFAULT_SORT;
  const pageNo = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);
  const offset = (pageNo - 1) * PER_PAGE;

  const args = q
    ? [likeTerm(q), PER_PAGE + 1, offset]
    : [PER_PAGE + 1, offset];

  const { results: fetched = [] } = await env.DB.prepare(listSql(SORTS[sort].sql, !!q))
    .bind(...args)
    .all();

  const hasNext = fetched.length > PER_PAGE;
  const games = fetched.slice(0, PER_PAGE);

  const tabs = Object.entries(SORTS)
    .map(
      ([key, s]) =>
        `<a class="tab${key === sort ? ' on' : ''}" href="/games?sort=${key}${
          q ? `&q=${encodeURIComponent(q)}` : ''
        }">${esc(s.label)}</a>`,
    )
    .join('');

  const body = `
    ${crumb('/', 'Home')}

    <section class="hero plain">
      <h1>The index</h1>
      <p class="sub">Every game somebody here owns, and what finishing it pays.</p>
    </section>

    <form class="find" method="get" action="/games">
      <input type="search" name="q" value="${esc(q)}" placeholder="Search every game"
             aria-label="Search every game" maxlength="60">
      <input type="hidden" name="sort" value="${esc(sort)}">
      <button type="submit">Search</button>
    </form>

    ${
      q
        ? `<p class="found">Showing games matching <b>${esc(q)}</b>.
             <a href="/games?sort=${esc(sort)}">Clear</a></p>`
        : ''
    }

    <div class="tabs">${tabs}</div>

    ${
      games.length
        ? `<div class="tablewrap">
             <table class="games">
               <thead><tr>
                 <th class="gi"></th>
                 <th>Game</th>
                 <th class="num" title="Members here who own it">Owned</th>
                 <th class="num" title="What a full completion pays">Points</th>
                 <th class="bar"></th>
               </tr></thead>
               <tbody>${games.map(row).join('')}</tbody>
             </table>
           </div>
           ${pager(sort, q, pageNo, hasNext)}`
        : `<div class="tablewrap"><p class="empty">${
            q
              ? `No games matching <b>${esc(q)}</b>. Only games somebody here owns are listed.`
              : 'No games on this page.'
          }</p></div>`
    }

    <footer>
      <a href="/leaderboard">Back to the board</a>
    </footer>`;

  return html(
    page({
      title: 'Games · Kraken',
      description: 'Every game the Platinum Intel hunters own, and what finishing each one pays.',
      here: 'games',
      body,
    }),
  );
}
