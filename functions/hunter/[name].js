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

import {
  page, html, esc, n, pct, flag, ordinal, cup, miniCups, TIER, tierFor,
  closingState, closingLabel, isUrgent, d20, gameHref, crumb,
} from '../_lib/page.js';

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
  /**
   * LAST PLAYED means last PLAYED.
   *
   * This sorted on `last_earned_at` — the date of the last trophy — which is a
   * different thing and produced a visibly wrong list: Wilko had Suikoden at
   * the top having not touched it in sixteen months, because that was when its
   * last trophy popped, while a game he had played that week sat further down
   * for the crime of not paying out.
   *
   * `last_played_at` is PSN's own `lastUpdatedDateTime` for the title, which is
   * exactly the field PSNProfiles sorts by. The COALESCE is for rows scanned
   * before we stored it.
   */
  played: {
    label: 'Last played',
    sql: 'COALESCE(mg.last_played_at, mg.last_earned_at, 0) DESC, g.title ASC',
  },
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
         g.unobtainable, g.unobtainable_note, g.closes_at, g.trophy_count,
         mg.points, mg.progress, mg.earned_total, mg.earned_platinum,
         mg.earned_gold, mg.earned_silver, mg.earned_bronze,
         mg.last_played_at, mg.last_earned_at
    FROM member_games mg
    JOIN games g ON g.np_comm_id = mg.np_comm_id
   WHERE mg.psn_account_id = ?
     ${search ? `AND g.title LIKE ? ESCAPE '\\'` : ''}
   ORDER BY ${order}
   LIMIT ? OFFSET ?`;

/**
 * "What should I play?" — three from the backlog, two from the whole index.
 *
 * COST, because this is the one feature on the site that cannot be cached.
 * A random picker that sits in the edge cache for five minutes gives everybody
 * the same three games and returns the same three when you click again, which
 * is not a picker, it is a list. So every roll is real queries, and the two
 * expensive ways to write this had to be avoided:
 *
 *   1. `ORDER BY RANDOM()` over the games table reads all 26,000 rows, every
 *      click, forever. The version below jumps to a random rowid and takes the
 *      first row at or after it, which reads a handful.
 *
 *   2. Their backlog IS `ORDER BY RANDOM()`, over their own rows only — up to
 *      1,500 for the biggest library here, which is what the search box already
 *      costs and happens far less often. Doing it properly would need a COUNT
 *      first, so it would be two queries to save one scan of a small table.
 *
 * At every member rolling five times a day that is a rounding error beside the
 * 78 million rows the bot already reads daily.
 */
const BACKLOG_PICKS = 3;
const WILDCARD_PICKS = 2;

/**
 * Games they own, have not finished, and would gain points for finishing.
 *
 * `max_points > mg.points` is doing real work: without it the picker cheerfully
 * suggests shovelware worth nothing, which is exactly the advice this board
 * exists to stop people taking.
 */
const ROLL_BACKLOG = `
  SELECT g.np_comm_id, g.title, g.platform, g.icon_url, g.max_points,
         g.unobtainable, g.closes_at, mg.points, mg.progress
    FROM member_games mg
    JOIN games g ON g.np_comm_id = mg.np_comm_id
   WHERE mg.psn_account_id = ?
     AND mg.progress < 100
     AND g.unobtainable = 0
     AND g.max_points > mg.points
   ORDER BY RANDOM()
   LIMIT ?`;

/**
 * One wildcard from the whole index.
 *
 * The rowid jump is the trick that makes this affordable: pick a number, take
 * the first qualifying row after it. `ORDER BY rowid` then `LIMIT 1` stops as
 * soon as it finds one instead of sorting the table.
 *
 * Run once per wildcard rather than LIMIT 2, because two rows next to each
 * other in rowid order are usually two editions of the same game.
 */
const ROLL_WILD = `
  SELECT np_comm_id, title, platform, icon_url, max_points, trophy_count,
         unobtainable, closes_at, local_started
    FROM games
   WHERE rowid >= ?
     AND max_points > 0
     AND unobtainable = 0
     AND title IS NOT NULL AND TRIM(title) <> ''
     AND NOT EXISTS (
           SELECT 1 FROM member_games mg
            WHERE mg.psn_account_id = ? AND mg.np_comm_id = games.np_comm_id)
   ORDER BY rowid
   LIMIT 1`;

const MAX_ROWID = `SELECT MAX(rowid) AS m FROM games`;

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

/**
 * Two wildcards, drawn one at a time.
 *
 * WRAPS AROUND. A jump near the end of the table can land past the last
 * qualifying row and come back empty — so a miss retries from rowid 0, which is
 * the same query and always finds something. Without it the picker would
 * silently show one wildcard instead of two, roughly whenever the dice landed
 * high, and nobody would ever work out why.
 */
async function wildcards(env, accountId, count) {
  const top = await env.DB.prepare(MAX_ROWID).first();
  const max = Number(top?.m) || 0;
  if (!max) return [];

  const picked = [];
  const seen = new Set();

  for (let i = 0; i < count * 3 && picked.length < count; i++) {
    const from = Math.floor(Math.random() * max);
    let row = await env.DB.prepare(ROLL_WILD).bind(from, accountId).first();
    if (!row) row = await env.DB.prepare(ROLL_WILD).bind(0, accountId).first();
    if (row && !seen.has(row.np_comm_id)) {
      seen.add(row.np_comm_id);
      picked.push(row);
    }
  }
  return picked;
}

function rollCard(g, { mine, who }) {
  const max = Number(g.max_points) || 0;
  const got = Number(g.points) || 0;
  const left = Math.max(0, max - got);
  const state = closingState(g);

  return `<li>
    ${
      g.icon_url
        ? `<img class="ico" src="${esc(g.icon_url)}" alt="" loading="lazy" width="48" height="48">`
        : '<span class="ico"></span>'
    }
    <div class="rb">
      <a class="t" href="${esc(gameHref(g.np_comm_id, who))}">${
        g.platform ? `<span class="plat-chip">${esc(g.platform)}</span>` : ''
      }${esc(g.title)}</a>
      <span class="s">${
        mine
          ? `${Number(g.progress) || 0}% done &middot; <b>${n(left)}</b> points left`
          : `<b>${n(max)}</b> points on the table${
              Number(g.local_started) > 0
                ? ` &middot; ${n(g.local_started)} here own it`
                : ' &middot; nobody here owns it'
            }`
      }${
        state === 'closing'
          ? ` &middot; <b class="closes${isUrgent(g.closes_at) ? '' : ' later'}"
                style="display:inline">${esc(closingLabel(g.closes_at))}</b>`
          : ''
      }</span>
    </div>
  </li>`;
}

/**
 * The mark beside a game title: nothing, a countdown, or a warning.
 *
 * Both live in a <details> so the reason is readable by tapping, which a title
 * attribute never was on a phone.
 */
function clock(g) {
  const state = closingState(g);

  if (state === 'closing') {
    const soon = isUrgent(g.closes_at);
    const note = g.unobtainable_note ? ` ${esc(g.unobtainable_note)}` : '';
    return `<details class="flagwrap clock${soon ? ' soon' : ''}"><summary
        aria-label="Closing soon">${soon ? '&#8987;' : '&#128338;'}</summary><span
        class="flagnote"><b>${esc(closingLabel(g.closes_at))}</b>. Everything in it is
        still earnable until then.${note}</span></details>`;
  }

  if (state === 'dead') {
    return `<details class="flagwrap"><summary aria-label="Has unobtainable trophies"
        >&#9888;</summary><span class="flagnote">${esc(
          g.unobtainable_note || 'Some trophies in this game can no longer be earned.',
        )}</span></details>`;
  }

  return '';
}

function gameRow(g, who) {
  const done = Number(g.progress) === 100;
  const max = Number(g.max_points) || 0;
  const got = Number(g.points) || 0;
  const left = Math.max(0, max - got);


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
          : Number(g.earned_total) > 0
            ? 'b'
            : 'none';
  const width = Math.max(0, Math.min(100, Number(g.progress) || 0));

  return `<tr class="sh-${shade}">
    <td class="gi">${
      g.icon_url
        ? `<img class="ico" src="${esc(g.icon_url)}" alt="" loading="lazy" width="56" height="56">`
        : '<span class="ico"></span>'
    }</td>
    <td class="gt">
      ${g.platform ? `<span class="plat-chip">${esc(g.platform)}</span>` : ''}<a
        class="tname" href="${esc(gameHref(g.np_comm_id, who))}">${esc(g.title)}</a>${
        /*
         * A <details>, not a title attribute.
         *
         * The tooltip was invisible on a phone — there is no hover on a touch
         * screen, so the reason a game was flagged could not be read at all on
         * the device most people use. This opens on tap, on click and on
         * keyboard focus, and needs no JavaScript.
         *
         * It also quietly answers the PSNProfiles clock icon: the note already
         * says "servers closed May 2024" when a mod types that into /flag, so
         * making the note readable delivers the same thing without a schema
         * change and without asking mods to type dates in a fixed format.
         */
        /*
         * DYING AND DEAD GET DIFFERENT MARKS, and that is the entire feature.
         * The warning triangle is a closed door. The hourglass is an invitation
         * with a deadline, and it is the only thing on this page that makes
         * anybody hurry — so it is never the same colour or the same shape as
         * the thing that means "do not bother".
         */
        clock(g)
      }
      <span class="meta">${
        // The same field the sort uses, or the column and the order would tell
        // two different stories about the same row.
        g.last_played_at || g.last_earned_at
          ? `${ago(g.last_played_at || g.last_earned_at)} · `
          : ''
      }${miniCups(g.earned_platinum, g.earned_gold, g.earned_silver, g.earned_bronze)}</span>${
        // A deadline is worth a line of its own, not just an icon. An icon says
        // "something is up"; "closes in 12 days" says what to do about it.
        closingState(g) === 'closing'
          ? `<span class="closes${isUrgent(g.closes_at) ? '' : ' later'}">${esc(
              closingLabel(g.closes_at),
            )}</span>`
          : ''
      }
    </td>
    <td class="num prog" data-v="${width}">
      <span class="${done ? 'done' : ''}">${width}%</span>
      <span class="track"><span class="fill ${shade}" style="width:${width}%"></span></span>
      <span class="tcount">${n(g.earned_total)} / ${n(g.trophy_count)}</span>
    </td>
    <td class="num pts" data-v="${got}" title="${
      max ? `${n(left)} points left to earn` : 'No trophy in this game is hard for anybody'
    }">${max ? `${n(got)} <span class="of-max">/ ${n(max)}</span>` : '<span class="zero">0</span>'}</td>
    <td class="bar"></td>
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
  const rolling = url.searchParams.has('roll');

  const m = await env.DB.prepare(MEMBER).bind(name).first();
  if (!m) {
    return html(
      page({
        title: 'Not found',
        body: `<div class="tablewrap"><p class="empty">
                 No hunter called <b>${esc(name)}</b> is on the board.<br>
                 <a href="/leaderboard">Back to the board</a>
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

  // Only when asked. Nobody pays for the dice unless somebody rolls them.
  const [backlogPicks, wildPicks] = rolling
    ? await Promise.all([
        env.DB.prepare(ROLL_BACKLOG).bind(m.psn_account_id, BACKLOG_PICKS).all()
          .then((r) => r.results ?? []),
        wildcards(env, m.psn_account_id, WILDCARD_PICKS),
      ])
    : [[], []];

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
         </ul>`
      : '';

  const numbersBlock =
    updates.length >= 2 && curve.length >= 2
      ? `<details class="numbers">
           <summary>Show the numbers<span class="soon-tag">Rivals &middot; soon</span></summary>
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

  /**
   * The dice.
   *
   * The link carries a throwaway number so the browser treats every click as a
   * new address. The response is no-store as well, but a browser that has just
   * been handed the identical URL will happily not ask at all, and "click again
   * for the same three games" is the one behaviour this feature cannot have.
   */
  const rollHref = `/hunter/${encodeURIComponent(m.psn_online_id)}?roll=${Date.now() % 100000}`;

  /**
   * "THEIR backlog", never "yours".
   *
   * The site has no idea who is reading it — there is no login until Phase 4 —
   * so a roll on somebody else's page draws from THEIR library, which is
   * correct behaviour said wrongly: "From your backlog" on Leon's page was a
   * flat lie to anybody who was not Leon. Naming the hunter is true on every
   * page including your own, and costs nothing.
   */
  const whose = esc(m.psn_online_id);

  const rollBlock = rolling
    ? `<section class="panel roll rolled">
         <h2>${d20()} What should ${whose} play?
           <a href="${esc(rollHref)}">Roll again &rsaquo;</a>
         </h2>
         ${
           backlogPicks.length
             ? `<p class="rlabel">From ${whose}'s backlog</p>
                <ul class="rolls">${backlogPicks
                  .map((g) => rollCard(g, { mine: true, who: m.psn_online_id }))
                  .join('')}</ul>`
             : `<p class="note">Nothing unfinished worth points — which is its own kind of answer.</p>`
         }
         ${
           wildPicks.length
             ? `<p class="rlabel">Wildcards from the index</p>
                <ul class="rolls">${wildPicks
                  .map((g) => rollCard(g, { mine: false }))
                  .join('')}</ul>`
             : ''
         }
         <p class="note">Three from this library and two from games it does not have.
           Nothing here is a recommendation about difficulty — it is a coin toss with
           the shovelware filtered out.</p>
       </section>`
    : '';

  const rollLink = `<a class="rollcta" href="${esc(rollHref)}">${d20()}${
    rolling ? 'Roll again' : 'Roll the dice'
  }</a>`;

  const body = `
    ${crumb('/leaderboard', 'Leaderboard')}

    <section class="hero">
      ${
        m.avatar_url
          ? `<img class="bigav" src="${esc(m.avatar_url)}" alt="" width="76" height="76">`
          : '<span class="bigav"></span>'
      }
      <h1>${country ? `${country} ` : ''}${esc(m.psn_online_id)}</h1>
      <p class="sub">
        <b>${ordinal(m.rank)}</b>
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

    <!-- The row that was half empty. Rivals will land in the same one. -->
    <div class="toolrow">${numbersBlock}${rollLink}</div>

    ${rollBlock}

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
             <table class="games">
               <thead><tr>
                 <th class="gi"></th>
                 <th>Game</th>
                 <th class="num">Progress</th>
                 <th class="num" title="Earned out of what a full completion pays">Points</th>
                 <th class="bar"></th>
               </tr></thead>
               <tbody>${games.map((g) => gameRow(g, m.psn_online_id)).join('')}</tbody>
             </table>
           </div>
           ${pager(m.psn_online_id, sort, q, shownPage, pages, hasNext)}`
        : `<div class="tablewrap"><p class="empty">${
            q ? `No games matching <b>${esc(q)}</b>.` : 'No games on this page.'
          }</p></div>`
    }

    <footer>
      <a href="/leaderboard">Back to the board</a>
    </footer>`;

  return html(
    page({
      title: `${m.psn_online_id} · Kraken`,
      description: `${m.psn_online_id} is ${ordinal(m.rank)} of ${total} on Platinum Intel with ${n(m.points)} points.`,
      body,
    }),
    // A ROLL IS NEVER CACHED. Five minutes in the edge cache would hand every
    // member the same three games and return the same three when they click
    // again, which is a list wearing a dice emoji.
    rolling ? { maxAge: 0 } : undefined,
  );
}
