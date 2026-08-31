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
  page, html, esc, n, closingState, closingLabel, isUrgent,
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
const listSql = (order, search) => `
  SELECT g.np_comm_id, g.title, g.platform, g.icon_url, g.trophy_count,
         g.max_points, g.estimated, g.unobtainable, g.unobtainable_note,
         g.closes_at, g.local_started
    FROM games g
   WHERE g.local_started > 0
     ${search ? `AND g.title LIKE ? ESCAPE '\\'` : ''}
   ORDER BY ${order}
   LIMIT ? OFFSET ?`;

const likeTerm = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The mark beside a title. Identical rules to every other page. */
function clock(g) {
  const state = closingState(g);
  if (state === 'closing') {
    const soon = isUrgent(g.closes_at);
    return `<details class="flagwrap clock${soon ? ' soon' : ''}"><summary
        aria-label="Closing soon">${soon ? '&#8987;' : '&#128338;'}</summary><span
        class="flagnote"><b>${esc(closingLabel(g.closes_at))}</b>. Everything in it is
        still earnable until then.${
          g.unobtainable_note ? ` ${esc(g.unobtainable_note)}` : ''
        }</span></details>`;
  }
  if (state === 'dead') {
    return `<details class="flagwrap"><summary aria-label="Has unobtainable trophies"
        >&#9888;</summary><span class="flagnote">${esc(
          g.unobtainable_note || 'Some trophies in this game can no longer be earned.',
        )}</span></details>`;
  }
  return '';
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
        class="tname" href="${esc(href)}">${esc(g.title)}</a>${clock(g)}
      <span class="meta">${n(g.trophy_count)} ${
        Number(g.trophy_count) === 1 ? 'trophy' : 'trophies'
      }</span>${
        closingState(g) === 'closing'
          ? `<span class="closes${isUrgent(g.closes_at) ? '' : ' later'}">${esc(
              closingLabel(g.closes_at),
            )}</span>`
          : ''
      }
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
