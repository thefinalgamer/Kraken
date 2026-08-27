/**
 * One hunter's game list. GET /hunter/<psn online id>
 *
 * THE SITE COMPUTES NOTHING — the rule from index.js applies here word for
 * word. `mg.points` is what the bot decided this member's copy of this game is
 * worth, `g.max_points` is what a full completion would pay, and the "worth
 * finishing" column is the subtraction of two stored numbers, not a scoring
 * decision. Nothing on this page re-prices anything.
 *
 * PAGINATED SERVER-SIDE, and that is a cost decision rather than a design one.
 * MRTheChez has 1,512 projects. D1 bills on rows read, so rendering his whole
 * library on every view would read fifteen hundred rows to show fifty, and the
 * board page next door reads sixty-four. Fifty at a time keeps a hunter page
 * roughly as cheap as the board, and every distinct URL — page and sort — sits
 * in the edge cache for five minutes on top of that.
 *
 * The total for the pager comes from `members.projects`, which the bot already
 * maintains. A COUNT(*) would read every one of their rows to produce a number
 * we are already storing, which is the exact thing this file is avoiding.
 */

import { page, html, esc, n, pct, flag, ordinal, TIER, tierFor } from '../_lib/page.js';

const PER_PAGE = 50;

/**
 * Sorts, as a whitelist.
 *
 * The key from the query string picks a fragment from this object and is never
 * interpolated into SQL itself. That is deliberate: the moment a user-supplied
 * string reaches an ORDER BY clause you have handed them the database.
 */
const SORTS = {
  points: { label: 'Points', sql: 'mg.points DESC, g.title ASC' },
  worth: { label: 'Worth finishing', sql: '(g.max_points - mg.points) DESC, g.title ASC' },
  progress: { label: 'Progress', sql: 'mg.progress DESC, mg.points DESC' },
  played: { label: 'Last played', sql: 'COALESCE(mg.last_earned_at, 0) DESC, g.title ASC' },
  title: { label: 'Name', sql: 'g.title ASC' },
};
const DEFAULT_SORT = 'points';

const MEMBER = `
  SELECT psn_account_id, psn_online_id, country, avatar_url, rank, prev_rank,
         points, completion, platinum, gold, silver, bronze, projects, completed,
         last_update_at
    FROM members
   WHERE psn_online_id = ? COLLATE NOCASE
     AND rank IS NOT NULL
   LIMIT 1`;

const TOTAL = `SELECT COUNT(*) AS c FROM members WHERE rank IS NOT NULL AND last_update_at IS NOT NULL`;

const gamesSql = (order) => `
  SELECT g.np_comm_id, g.title, g.platform, g.icon_url, g.max_points,
         g.unobtainable, g.unobtainable_note, g.trophy_count,
         mg.points, mg.progress, mg.earned_total, mg.last_earned_at
    FROM member_games mg
    JOIN games g ON g.np_comm_id = mg.np_comm_id
   WHERE mg.psn_account_id = ?
   ORDER BY ${order}
   LIMIT ? OFFSET ?`;

/** "3 days ago". Coarse on purpose — nobody needs the minute they last played. */
function ago(ms) {
  const t = Number(ms);
  if (!t) return '';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} month${months === 1 ? '' : 's'} ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function gameRow(g) {
  const done = Number(g.progress) === 100;
  const left = Math.max(0, (Number(g.max_points) || 0) - (Number(g.points) || 0));
  const worthless = !Number(g.max_points);

  return `<tr>
    <td class="gi">${
      g.icon_url
        ? `<img class="ico" src="${esc(g.icon_url)}" alt="" loading="lazy" width="40" height="40">`
        : '<span class="ico"></span>'
    }</td>
    <td class="gt">
      <span class="tname">${esc(g.title)}</span>${
        g.unobtainable
          ? ` <span class="warn" title="${esc(g.unobtainable_note || 'Has unobtainable trophies.')}">&#9888;</span>`
          : ''
      }
      <span class="meta">${esc(g.platform || '')}${
        g.last_earned_at ? ` · ${ago(g.last_earned_at)}` : ''
      }</span>
    </td>
    <td class="num" data-v="${Number(g.progress) || 0}">
      <span class="${done ? 'done' : ''}">${Number(g.progress) || 0}%</span>
    </td>
    <td class="num pts" data-v="${Number(g.points) || 0}">${n(g.points)}</td>
    <td class="num hide-s" data-v="${worthless ? -1 : left}">${
      worthless ? '<span class="zero">pays nothing</span>' : done ? '<span class="zero">done</span>' : n(left)
    }</td>
  </tr>`;
}

function pager(name, sort, pageNo, pages) {
  if (pages <= 1) return '';
  const href = (p) => `/hunter/${encodeURIComponent(name)}?sort=${sort}&page=${p}`;
  const bits = [];
  if (pageNo > 1) bits.push(`<a href="${esc(href(pageNo - 1))}">‹ Previous</a>`);
  bits.push(`<span class="of">Page ${pageNo} of ${pages}</span>`);
  if (pageNo < pages) bits.push(`<a href="${esc(href(pageNo + 1))}">Next ›</a>`);
  return `<nav class="pager">${bits.join('')}</nav>`;
}

export async function onRequestGet({ params, env, request }) {
  const name = decodeURIComponent(params.name || '');
  const url = new URL(request.url);

  const sort = SORTS[url.searchParams.get('sort')] ? url.searchParams.get('sort') : DEFAULT_SORT;
  const pageNo = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));

  const m = await env.DB.prepare(MEMBER).bind(name).first();
  if (!m) {
    return html(
      page({
        title: 'Not found',
        body: `<div class="tablewrap"><p class="empty">
                 No hunter called <b>${esc(name)}</b> is on the board.<br>
                 <a href="/">Back to the board</a>
               </p></div>`,
      }),
      { status: 404, maxAge: 60 },
    );
  }

  const totalRow = await env.DB.prepare(TOTAL).first();
  const total = Number(totalRow?.c) || 0;
  const { name: tierName, color } = TIER[tierFor(m.rank, total)];

  const projects = Number(m.projects) || 0;
  const pages = Math.max(1, Math.ceil(projects / PER_PAGE));
  const offset = (Math.min(pageNo, pages) - 1) * PER_PAGE;

  const { results: games = [] } = await env.DB.prepare(gamesSql(SORTS[sort].sql))
    .bind(m.psn_account_id, PER_PAGE, offset)
    .all();

  const country = flag(m.country);
  const trophies =
    (m.platinum ?? 0) + (m.gold ?? 0) + (m.silver ?? 0) + (m.bronze ?? 0);

  const tabs = Object.entries(SORTS)
    .map(
      ([key, s]) =>
        `<a class="tab${key === sort ? ' on' : ''}" href="/hunter/${encodeURIComponent(
          m.psn_online_id,
        )}?sort=${key}">${esc(s.label)}</a>`,
    )
    .join('');

  const body = `
    <section class="hero">
      ${
        m.avatar_url
          ? `<img class="bigav" src="${esc(m.avatar_url)}" alt="" width="72" height="72">`
          : '<span class="bigav"></span>'
      }
      <div class="who">
        <h1>${country ? `${country} ` : ''}${esc(m.psn_online_id)}</h1>
        <p class="sub">
          <b>${ordinal(m.rank)}</b> of ${n(total)} ·
          <span class="tier" style="color:${color}">${tierName}</span>
        </p>
      </div>
      <dl class="facts">
        <div><dt>Points</dt><dd>${n(m.points)}</dd></div>
        <div><dt>Completion</dt><dd>${pct(m.completion)}</dd></div>
        <div><dt>Trophies</dt><dd>${n(trophies)}</dd></div>
        <div><dt>Finished</dt><dd>${n(m.completed)} / ${n(projects)}</dd></div>
      </dl>
    </section>

    <div class="tabs">${tabs}</div>

    ${
      games.length
        ? `<div class="tablewrap">
             <table>
               <thead><tr>
                 <th class="gi"></th>
                 <th>Game</th>
                 <th class="num">Progress</th>
                 <th class="num">Points</th>
                 <th class="num hide-s" title="What finishing it would add">Worth finishing</th>
               </tr></thead>
               <tbody>${games.map(gameRow).join('')}</tbody>
             </table>
           </div>
           ${pager(m.psn_online_id, sort, Math.min(pageNo, pages), pages)}`
        : `<div class="tablewrap"><p class="empty">No games on this page.</p></div>`
    }

    <footer>
      <b>Points</b> is what this hunter's copy of a game is worth right now, after
      rarity and their completion. <b>Worth finishing</b> is what taking it to 100%
      would add on top. A game that pays nothing has no trophy in it that is hard
      for anybody.<br>
      <a href="/">Back to the board</a>
    </footer>`;

  return html(
    page({
      title: `${m.psn_online_id} · Kraken`,
      description: `${m.psn_online_id} is ${ordinal(m.rank)} of ${total} on Platinum Intel with ${n(m.points)} points.`,
      body,
    }),
  );
}
