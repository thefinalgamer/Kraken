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

import { page, html, esc, n, pct, flag, ordinal, cup, miniCups, TIER, tierFor } from '../_lib/page.js';

const PER_PAGE = 50;

// How far back the history goes. Somebody running /update daily for a year
// would otherwise put 365 rows into one page. The newest 200 is more than
// anybody will read and keeps the query the same size for everyone.
const HISTORY = 200;

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
// LAST PLAYED, not points. Opening on the biggest scores shows the same five
// games at the top of every hunter forever; opening on what they touched most
// recently is the only ordering that changes when they play, which is the
// question anybody landing on a profile is actually asking.
const DEFAULT_SORT = 'played';

const MEMBER = `
  SELECT psn_account_id, psn_online_id, country, avatar_url, rank, prev_rank,
         points, reported_points, completion, platinum, gold, silver, bronze,
         projects, completed, last_update_at
    FROM members
   WHERE psn_online_id = ? COLLATE NOCASE
     AND rank IS NOT NULL
   LIMIT 1`;

const TOTAL = `SELECT COUNT(*) AS c FROM members WHERE rank IS NOT NULL AND last_update_at IS NOT NULL`;

/**
 * Their score, backwards.
 *
 * NOTHING RECORDS A POINTS TOTAL PER DAY, and nothing needs to. Every finished
 * update already stores `d_points` — how much the score moved that time —
 * along with the three-way split of where the movement came from. So the curve
 * is reconstructed by taking the number the member is showing NOW and walking
 * the deltas backwards, which has two properties worth having: it needs no new
 * table and no new writes, and it reaches back to the very first scan instead
 * of starting from the day somebody thought to record it.
 *
 * ANCHORED AT THE RIGHT-HAND EDGE, deliberately. The last point on the graph is
 * `reported_points` — the number on their card — so the chart cannot end
 * somewhere Discord disagrees with. Any arithmetic error accumulates backwards
 * into the distant past, where it is cosmetic, rather than forwards into the
 * figure people check.
 */
const UPDATES = `
  SELECT id, started_at, finished_at, d_points,
         points_earned, points_backlog, points_drift
    FROM updates
   WHERE psn_account_id = ?
     AND status = 'done'
     AND finished_at IS NOT NULL
   ORDER BY id DESC
   LIMIT ?`;

/**
 * @param order  a fragment from SORTS, never a user string
 * @param search whether a title filter is being applied
 *
 * SEARCH IS A REAL QUERY, AND IT IS THE EXPENSIVE ONE ON THIS PAGE. Filtering
 * only the fifty rows already on screen would be a lie — a member with 1,512
 * games searching "batman" would be told there is no Batman because it is on
 * page nine. So it filters the whole library, which means reading every one of
 * their rows instead of fifty.
 *
 * That is affordable BECAUSE IT HAPPENS ON SUBMIT. A search-as-you-type box
 * turns one word into ten of these queries, none of them cacheable, because
 * every keystroke is a different URL. Fifteen thousand rows read to find one
 * game. The form posts on Enter and that is not an oversight.
 *
 * LIKE is escaped: a member typing "100%" would otherwise match everything,
 * because % is LIKE's own wildcard.
 */
const gamesSql = (order, search) => `
  SELECT g.np_comm_id, g.title, g.platform, g.icon_url, g.max_points,
         g.unobtainable, g.unobtainable_note, g.trophy_count,
         mg.points, mg.progress, mg.earned_total, mg.earned_platinum,
         mg.earned_gold, mg.earned_silver, mg.earned_bronze, mg.last_earned_at
    FROM member_games mg
    JOIN games g ON g.np_comm_id = mg.np_comm_id
   WHERE mg.psn_account_id = ?
     ${search ? `AND g.title LIKE ? ESCAPE '\\'` : ''}
   ORDER BY ${order}
   LIMIT ? OFFSET ?`;

const likeTerm = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

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

/**
 * Turn the update rows into a curve, and total up where the movement came from.
 *
 * `rows` arrive newest first. Walking them in that order from the anchor gives
 * the value BEFORE each update, which is the value AFTER the one before it —
 * so the whole series falls out of one pass with no second query and no stored
 * history.
 *
 * The leading point uses `started_at` of the oldest update rather than its
 * finish time, so a first scan that took fifteen minutes reads as a climb from
 * zero rather than a vertical wall.
 */
function history(rows, anchorPoints) {
  if (!rows?.length) return { points: [], split: null };

  const split = { earned: 0, backlog: 0, drift: 0 };
  const points = [];
  let v = Number(anchorPoints) || 0;

  rows.forEach((r, i) => {
    points.unshift({ t: Number(r.finished_at), v });
    v -= Number(r.d_points) || 0;

    // The OLDEST update in the window is skipped in the split, because it is
    // not movement — it is the baseline the graph starts from. A first scan
    // banks a whole library at once; counting its 182,000 as "earned this
    // period" would drown every real week that followed and make the three
    // figures answer a different question to the one the curve is asking.
    if (i < rows.length - 1) {
      split.earned += Number(r.points_earned) || 0;
      split.backlog += Number(r.points_backlog) || 0;
      split.drift += Number(r.points_drift) || 0;
    }
  });

  // No synthetic zero at the front. We did not measure anybody before their
  // first scan, and drawing a line up from zero invents a climb that never
  // happened — it renders as a vertical wall at the left edge and squashes
  // everything real into the top of the plot.

  return { points, split };
}

/** +12,400 in green, −900 in red, 0 plain. */
const delta = (v) => {
  const x = Math.round(Number(v) || 0);
  if (x === 0) return '<span class="d">0</span>';
  return `<span class="d ${x > 0 ? 'pos' : 'neg'}">${x > 0 ? '+' : '\u2212'}${n(Math.abs(x))}</span>`;
};

function gameRow(g) {
  const done = Number(g.progress) === 100;
  const max = Number(g.max_points) || 0;
  const got = Number(g.points) || 0;
  const left = Math.max(0, max - got);

  /**
   * The accent bar, lifted straight from the old site because it was the best
   * idea on it: BLUE once the platinum is in, GREEN once everything is, DLC
   * included, and nothing at all otherwise. Two colours doing what a column of
   * forty "done"s was doing badly, in four pixels, with no text.
   *
   * Green wins where both apply — 100% is the stronger statement, and a game
   * with no platinum at all still earns it.
   */
  const mark = done ? 'full' : Number(g.earned_platinum) > 0 ? 'plat' : '';

  /**
   * The progress bar, from the old site.
   *
   * IT FILLS TO `progress` AND NOTHING ELSE. The temptation was to segment it by
   * the trophies earned — a bronze stripe, then silver, then gold — but PSN's
   * progress percentage is weighted and the trophy counts are not, so the
   * segments would add up to a different width than the number printed beside
   * them. A bar that disagrees with its own label is worse than no bar.
   *
   * THE COLOUR is the best trophy in the cabinet: bronze until a silver lands,
   * silver until a gold, gold until the platinum, and green the moment the
   * whole thing is done. So the bar answers two questions at a glance — how far
   * along, and how far up — without either encoding lying about the other.
   */
  const shade = done
    ? 'ok'
    : Number(g.earned_platinum) > 0
      ? 'p'
      : Number(g.earned_gold) > 0
        ? 'g'
        : Number(g.earned_silver) > 0
          ? 's'
          : 'b';
  const width = Math.max(0, Math.min(100, Number(g.progress) || 0));
  const got_left = Math.max(0, (Number(g.trophy_count) || 0) - (Number(g.earned_total) || 0));

  return `<tr${mark ? ` class="${mark}"` : ''}>
    <td class="bar"><span class="pip"></span></td>
    <td class="gi">${
      g.icon_url
        ? `<img class="ico" src="${esc(g.icon_url)}" alt="" loading="lazy" width="40" height="40">`
        : '<span class="ico"></span>'
    }</td>
    <td class="gt">
      ${g.platform ? `<span class="plat-chip">${esc(g.platform)}</span>` : ''}<span
        class="tname">${esc(g.title)}</span>${
        g.unobtainable
          ? ` <span class="warn" title="${esc(g.unobtainable_note || 'Has unobtainable trophies.')}">&#9888;</span>`
          : ''
      }
      <span class="meta">${
        g.last_earned_at ? `${ago(g.last_earned_at)} · ` : ''
      }${miniCups(g.earned_platinum, g.earned_gold, g.earned_silver, g.earned_bronze)}</span>
    </td>
    <td class="num prog" data-v="${width}">
      <span class="${done ? 'done' : ''}">${width}%</span>
      <span class="track"><span class="fill ${shade}" style="width:${width}%"></span></span>
      <span class="tcount">${n(g.earned_total)} / ${n(g.trophy_count)}${
        got_left > 0 ? ` · ${n(got_left)} to go` : ''
      }</span>
    </td>
    <td class="num pts" data-v="${got}" title="${
      max ? `${n(left)} points left to earn` : 'No trophy in this game is hard for anybody'
    }">${max ? `${n(got)} <span class="of-max">/ ${n(max)}</span>` : '<span class="zero">0</span>'}</td>
  </tr>`;
}

/**
 * Previous / Next.
 *
 * `pages` is null while searching. Counting the matches would mean a second
 * full scan of the library to print "of 4", so instead one extra row is
 * fetched and its existence is the whole of "is there a next page".
 */
function pager(name, sort, q, pageNo, pages, hasNext) {
  const href = (p) =>
    `/hunter/${encodeURIComponent(name)}?sort=${sort}&page=${p}` +
    (q ? `&q=${encodeURIComponent(q)}` : '');

  const forward = pages ? pageNo < pages : hasNext;
  if (pageNo <= 1 && !forward) return '';

  const bits = [];
  if (pageNo > 1) bits.push(`<a href="${esc(href(pageNo - 1))}">‹ Previous</a>`);
  bits.push(`<span class="of">${pages ? `Page ${pageNo} of ${pages}` : `Page ${pageNo}`}</span>`);
  if (forward) bits.push(`<a href="${esc(href(pageNo + 1))}">Next ›</a>`);
  return `<nav class="pager">${bits.join('')}</nav>`;
}

export async function onRequestGet({ params, env, request }) {
  const name = decodeURIComponent(params.name || '');
  const url = new URL(request.url);

  const sort = SORTS[url.searchParams.get('sort')] ? url.searchParams.get('sort') : DEFAULT_SORT;
  const pageNo = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));
  // 60 characters is longer than any game anybody is looking for, and it caps
  // what a bored person can put into a LIKE pattern.
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);

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
  // Page count is known when browsing (members.projects is stored) and unknown
  // when searching, where counting would cost a second full scan.
  const pages = q ? null : Math.max(1, Math.ceil(projects / PER_PAGE));
  const shownPage = pages ? Math.min(pageNo, pages) : pageNo;
  const offset = (shownPage - 1) * PER_PAGE;

  // One extra row, purely so Next knows whether it exists.
  const args = q
    ? [m.psn_account_id, likeTerm(q), PER_PAGE + 1, offset]
    : [m.psn_account_id, PER_PAGE + 1, offset];

  const { results: fetched = [] } = await env.DB.prepare(gamesSql(SORTS[sort].sql, !!q))
    .bind(...args)
    .all();

  const hasNext = fetched.length > PER_PAGE;
  const games = fetched.slice(0, PER_PAGE);

  // History rides the first page only, and never a search. Somebody on page 6
  // of their library is reading the table; it would be the same figures every
  // time at the cost of another query.
  const { results: updates = [] } =
    pageNo === 1 && !q
      ? await env.DB.prepare(UPDATES).bind(m.psn_account_id, HISTORY).all()
      : { results: [] };

  const { points: curve, split } = history(
    updates,
    m.reported_points ?? m.points,
  );

  const country = flag(m.country);

  const tabs = Object.entries(SORTS)
    .map(
      ([key, s]) =>
        `<a class="tab${key === sort ? ' on' : ''}" href="/hunter/${encodeURIComponent(
          m.psn_online_id,
        )}?sort=${key}${q ? `&q=${encodeURIComponent(q)}` : ''}">${esc(s.label)}</a>`,
    )
    .join('');

  /**
   * Where the points came from, and the movements behind it.
   *
   * THERE WAS A GRAPH HERE AND IT IS GONE ON PURPOSE. Kraken is ten days old,
   * so a member's curve was three points across two days on an axis spanning
   * six thousand out of eight hundred thousand. The design would have come good
   * in six months; what members would have seen today was a nearly flat line
   * that made the site look unfinished. The reconstruction below survives it,
   * because these three figures read perfectly well from three updates.
   *
   * "FROM THE SERVER" IS NAMED CAREFULLY. `points_drift` is
   * `rawAfter - rawBefore - earnedRaw` — every re-pricing of trophies already
   * held. On a 64-member server most of that is the local rarity layer moving
   * as people start and finish each other's games, but some of it is worldwide
   * PSN rarity drifting, which refreshes monthly. Calling it "from Discord"
   * would be wrong a fifth of the time, so the sub-line names both.
   *
   * TWO UPDATES is the floor. The oldest update in the window sets the baseline
   * and is excluded from the totals, so with one update every figure is zero.
   */
  const splitBlock =
    updates.length >= 2 && curve.length >= 2
      ? `<ul class="split">
           <li><span class="k">From trophies</span><span class="v">${delta(split.earned)}</span>
               <span class="d">what you actually earned</span></li>
           <li><span class="k">From completion</span><span class="v">${delta(split.backlog)}</span>
               <span class="d">your % moving, re-pricing everything</span></li>
           <li><span class="k">From the server</span><span class="v">${delta(split.drift)}</span>
               <span class="d">others starting and finishing your games, and world rarity drifting</span></li>
         </ul>
         <details class="numbers">
           <summary>Show the numbers</summary>
           <div class="tablewrap"><table><thead><tr>
             <th>When</th><th class="num">Points</th><th class="num">Change</th>
           </tr></thead><tbody>${curve
             .slice(1)
             .map(
               (p, i) =>
                 `<tr><td>${esc(
                   new Date(p.t).toLocaleDateString('en-GB', {
                     day: 'numeric', month: 'short', year: 'numeric',
                   }),
                 )}</td><td class="num">${n(Math.round(p.v))}</td>` +
                 `<td class="num">${delta(p.v - curve[i].v)}</td></tr>`,
             )
             .reverse()
             .join('')}</tbody></table></div>
         </details>`
      : '';

  const body = `
    <section class="hero">
      ${
        m.avatar_url
          ? `<img class="bigav" src="${esc(m.avatar_url)}" alt="" width="76" height="76">`
          : '<span class="bigav"></span>'
      }
      <h1>${country ? `${country} ` : ''}${esc(m.psn_online_id)}</h1>
      <p class="sub">
        <b>${ordinal(m.rank)}</b> of ${n(total)}
        <span class="tier" style="color:${color}">${tierName}</span>
      </p>
    </section>

    <div class="cups">
      ${cup('p', m.platinum, 'Platinum')}
      ${cup('g', m.gold, 'Gold')}
      ${cup('s', m.silver, 'Silver')}
      ${cup('b', m.bronze, 'Bronze')}
      <dl class="facts">
        <div><dt>Points</dt><dd>${n(m.points)}</dd></div>
        <div><dt>Completion</dt><dd>${pct(m.completion)}</dd></div>
        <div><dt>Finished</dt><dd>${n(m.completed)} / ${n(projects)}</dd></div>
      </dl>
    </div>

    ${splitBlock}

    <form class="find" method="get" action="/hunter/${encodeURIComponent(m.psn_online_id)}">
      <input type="search" name="q" value="${esc(q)}" placeholder="Search this library"
             aria-label="Search this library" maxlength="60">
      <input type="hidden" name="sort" value="${esc(sort)}">
      <button type="submit">Search</button>
    </form>

    ${
      q
        ? `<p class="found">Showing games matching <b>${esc(q)}</b>.
             <a href="/hunter/${encodeURIComponent(m.psn_online_id)}?sort=${esc(sort)}">Clear</a></p>`
        : ''
    }

    <div class="tabs">${tabs}</div>

    ${
      games.length
        ? `<div class="tablewrap">
             <table>
               <thead><tr>
                 <th class="bar"></th>
                 <th class="gi"></th>
                 <th>Game</th>
                 <th class="num">Progress</th>
                 <th class="num" title="Earned out of what a full completion pays">Points</th>
               </tr></thead>
               <tbody>${games.map(gameRow).join('')}</tbody>
             </table>
           </div>
           ${pager(m.psn_online_id, sort, q, shownPage, pages, hasNext)}`
        : `<div class="tablewrap"><p class="empty">${
            q ? `No games matching <b>${esc(q)}</b>.` : 'No games on this page.'
          }</p></div>`
    }

    <footer>
      <b>Points</b> is what this hunter has banked in a game against what a full
      completion pays. A game showing <b>0</b> has no trophy in it that is hard for
      anybody. The bar down the left is <b style="color:#4a9eff">blue</b> for a
      platinum and <b style="color:var(--up)">green</b> for everything, DLC included.<br>
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
