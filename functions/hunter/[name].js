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
  closingState, closingLabel, isUrgent, gameHref, crumb, supporterStar, deadTitle,
  barShade,
} from '../_lib/page.js';
import { parseRivals, MAX_RIVALS } from '../../shared/rivals.mjs';
import { displayBanked } from '../../shared/scoring.mjs';

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
         projects, completed, last_update_at, supporter_months, rivals
    FROM members
   WHERE psn_online_id = ? COLLATE NOCASE
     AND rank IS NOT NULL
   LIMIT 1`;

const TOTAL = `SELECT COUNT(*) AS c FROM members WHERE rank IS NOT NULL AND last_update_at IS NOT NULL`;

/**
 * The hunters somebody is watching. Set in Discord with /rivals, read here.
 *
 * PUBLIC, AND THAT WAS A DECISION. The Discord reply is ephemeral, which made
 * it easy to assume the list was secret; it never was, it was just unbuilt.
 * Showing it on a page anybody can open means Snolib can see he is being
 * chased, and that is the point — a rivalry nobody knows about is just maths.
 * The wording in the bot was changed to match, because a footer promising
 * privacy that the website does not keep is worse than no footer at all.
 *
 * At most MAX_RIVALS ids, so the IN list is five placeholders at the very
 * worst and the query is a primary-key lookup of five rows. It is bounded by
 * construction rather than by a LIMIT.
 *
 * `rank IS NOT NULL` matches every other query on this site: somebody who has
 * left the board or never finished a scan cannot be ranked against, so they
 * quietly drop out of the list rather than rendering as a blank row.
 */
const rivalsSql = (count) => `
  SELECT psn_account_id, psn_online_id, avatar_url, rank, points, supporter_months
    FROM members
   WHERE psn_account_id IN (${Array.from({ length: count }, () => '?').join(',')})
     AND rank IS NOT NULL
   ORDER BY rank ASC`;

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
/**
 * Trophies this member earned in front of an audience, per game.
 *
 * ONE QUERY FOR THE WHOLE PAGE, keyed on the member, which is the leading
 * column of the log's primary key, so it reads their rows and nobody else's.
 * The log only goes back as far as migration 016 and only fills while people
 * stream, so this is hundreds of rows at most rather than a history of
 * everything.
 */
const ON_STREAM = `
  SELECT np_comm_id, COUNT(*) AS live
    FROM member_trophies
   WHERE psn_account_id = ? AND on_stream = 1
   GROUP BY np_comm_id`;

/**
 * COMPARING TWO HUNTERS. MRTheChez asked for this, and the shape of the ask
 * mattered more than the feature: he did not want a scoreboard, he wanted to
 * know which of the games he already owns somebody else has got further into.
 *
 * PUBLIC, on the hunter's own page, behind ?vs=. Martin's call. There is no
 * login, so a separate page would have meant typing two names to see something
 * you can already see one of; opening it from the page you are already on means
 * one name, and the address is shareable, which is the whole point of putting it
 * in the URL rather than in a script.
 *
 * ONLY ON SUBMIT, exactly like the search box, and for exactly the same reason:
 * the pair of queries below reads two libraries instead of fifty rows. Nobody
 * pays for that unless they asked a question.
 */
const VS_MEMBER = `
  SELECT psn_account_id, psn_online_id, country, avatar_url, rank,
         points, reported_points, completion, projects, completed, supporter_months
    FROM members
   WHERE psn_online_id = ? COLLATE NOCASE
     AND rank IS NOT NULL
   LIMIT 1`;

/**
 * How many rows, and why this is NOT a cost decision.
 *
 * Martin assumed showing everything would be expensive. It is not, and the
 * reason is worth writing down: both queries below end in ORDER BY on a
 * computed expression, which no index can serve, so SQLite has to produce and
 * sort every matching row before the LIMIT applies. LIMIT 12 reads exactly what
 * LIMIT 5000 reads. The limit buys nothing back from the database.
 *
 * What it buys is an ANSWER. Twelve rows ordered by what is still on the table
 * says "here is what to go and do"; four hundred says "here is your library
 * again, sorted differently". So the short list is the default and the whole
 * thing is one click away, because the expensive half is already paid for by
 * the time we know how many there are.
 *
 * Measured, gzipped, on the real renderer: 18 rows is 31.3KB and 600 rows is
 * 40.1KB. Game rows are near-identical markup and compression eats them.
 *
 * The ceiling is not about bytes either. It is images: every row is an icon
 * request to PSN's CDN, lazy-loaded, so only what somebody scrolls past is
 * actually fetched. Four hundred is past where anybody is still reading.
 */
const VS_ROWS = 12;
const VS_NEW_ROWS = 8;
const VS_ALL = 400;

/**
 * Shared games where the other hunter is further along.
 *
 * ORDERED BY WHAT IS LEFT ON THE TABLE, not by the size of the gap. "They are
 * 90% to your 10%" on a game worth nothing is a fact; "they have finished the
 * one you are eleven thousand points short on" is a plan. The subtraction is of
 * two stored numbers, same as everywhere else on this page.
 */
const VS_AHEAD = `
  SELECT g.np_comm_id, g.title, g.platform, g.icon_url, g.max_points, g.trophy_count,
         mine.points AS my_points, mine.progress AS my_progress,
         mine.earned_total AS my_trophies,
         them.points AS their_points, them.progress AS their_progress,
         them.earned_total AS their_trophies
    FROM member_games mine
    JOIN member_games them
      ON them.np_comm_id = mine.np_comm_id
     AND them.psn_account_id = ?
    JOIN games g ON g.np_comm_id = mine.np_comm_id
   WHERE mine.psn_account_id = ?
     AND them.progress > mine.progress
   ORDER BY (g.max_points - mine.points) DESC, g.title ASC
   LIMIT ?`;

/**
 * Games the other hunter has that this one has never touched.
 *
 * `max_points > 0` because a game no trophy in which is hard for anybody is not
 * a suggestion, it is noise, and this list is short enough that one wasted row
 * is a tenth of it.
 */
const VS_THEIRS = `
  SELECT g.np_comm_id, g.title, g.platform, g.icon_url, g.max_points, g.trophy_count,
         them.points AS their_points, them.progress AS their_progress,
         them.earned_total AS their_trophies
    FROM member_games them
    JOIN games g ON g.np_comm_id = them.np_comm_id
   WHERE them.psn_account_id = ?
     AND g.max_points > 0
     AND NOT EXISTS (SELECT 1 FROM member_games mine
                      WHERE mine.psn_account_id = ?
                        AND mine.np_comm_id = them.np_comm_id)
   ORDER BY g.max_points DESC, g.title ASC
   LIMIT ?`;

const gamesSql = (order, search) => `
  SELECT g.np_comm_id, g.title, g.platform, g.icon_url, g.max_points,
         g.unobtainable, g.unobtainable_note, g.closes_at, g.trophy_count,
         mg.points, mg.progress, mg.earned_total, mg.earned_platinum,
         mg.earned_gold, mg.earned_silver, mg.earned_bronze,
         mg.last_played_at, mg.last_earned_at,
         -- Derived rather than stored, so it cannot drift from the trophies it
         -- describes. Reads idx_trophies_dead, which is PARTIAL: dozens of rows
         -- rather than a million, so it costs less than one page of games.
         d.dead AS dead_trophies
    FROM member_games mg
    JOIN games g ON g.np_comm_id = mg.np_comm_id
    LEFT JOIN (SELECT np_comm_id, COUNT(*) AS dead
                 FROM trophies WHERE unobtainable = 1
                GROUP BY np_comm_id) d ON d.np_comm_id = g.np_comm_id
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
/**
 * Platforms you can narrow a deal to.
 *
 * A WHITELIST, and for the same reason the sort keys are one: the value goes
 * into a bound parameter, never into the SQL, and only these four keys can
 * reach it at all.
 *
 * MATCHED WITH LIKE, not equals, because PSN joins platforms for a cross-gen
 * title: a game released on both comes back as "PS4,PS5" in one column. An
 * exact match would hide every cross-gen game from both filters, which is a
 * silent wrong answer rather than a visible one. None of these four is a
 * substring of another, so a contains-match cannot collide.
 *
 * This is the ONLY filter, deliberately. Difficulty and time-to-platinum are
 * what people ask for next; Sony publishes neither, and inventing them means a
 * data-entry job for the mods that would sit half empty for years. Platform is
 * the one that is costing real slots: a deal that hands somebody four PS3 games
 * has wasted itself if the PS3 is in a cupboard.
 */
const PLATFORMS = {
  ps5: { label: 'PS5', match: 'PS5' },
  ps4: { label: 'PS4', match: 'PS4' },
  ps3: { label: 'PS3', match: 'PS3' },
  vita: { label: 'Vita', match: 'PSVITA' },
};

const rollBacklogSql = (plat) => `
  SELECT g.np_comm_id, g.title, g.platform, g.icon_url, g.max_points,
         g.trophy_count, g.unobtainable, g.closes_at, mg.points, mg.progress
    FROM member_games mg
    JOIN games g ON g.np_comm_id = mg.np_comm_id
   WHERE mg.psn_account_id = ?
     AND mg.progress < 100
     AND g.unobtainable = 0
     AND g.max_points > mg.points
     ${plat ? "AND g.platform LIKE '%' || ? || '%'" : ''}
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
const rollWildSql = (plat) => `
  SELECT np_comm_id, title, platform, icon_url, max_points, trophy_count,
         unobtainable, closes_at, local_started
    FROM games
   WHERE rowid >= ?
     AND max_points > 0
     AND unobtainable = 0
     AND title IS NOT NULL AND TRIM(title) <> ''
     ${plat ? "AND platform LIKE '%' || ? || '%'" : ''}
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
async function wildcards(env, accountId, count, plat = null) {
  const top = await env.DB.prepare(MAX_ROWID).first();
  const max = Number(top?.m) || 0;
  if (!max) return [];

  const sql = rollWildSql(plat);
  // The bound values in the order the clauses appear: rowid, then the platform
  // if there is one, then the account for the NOT EXISTS.
  const args = (from) => (plat ? [from, plat, accountId] : [from, accountId]);

  const picked = [];
  const seen = new Set();

  for (let i = 0; i < count * 3 && picked.length < count; i++) {
    const from = Math.floor(Math.random() * max);
    let row = await env.DB.prepare(sql).bind(...args(from)).first();
    if (!row) row = await env.DB.prepare(sql).bind(...args(0)).first();
    if (row && !seen.has(row.np_comm_id)) {
      seen.add(row.np_comm_id);
      picked.push(row);
    }
  }
  return picked;
}

/**
 * One dealt card.
 *
 * REPLACED THE DICE, and the reason is what the die could not do: it showed
 * twenty blank faces and revealed nothing until it stopped, so the whole wait
 * was spent on an object with no information on it. A card lands face down,
 * holds, and turns over to show the game itself. The suspense is the point of a
 * reveal, and this is the only version of it where the waiting means anything.
 *
 * NO JAVASCRIPT. This site has never shipped a byte of it and this feature did
 * not earn the first one. The whole sequence, deal to hold to rattle to turn,
 * is animation-delay arithmetic keyed off --i and --last. See the keyframes in
 * page.js.
 *
 * Same rows the roll always read: nothing new is fetched to draw this.
 */
function dealCard(g, { mine, who, completion, i }) {
  const max = displayBanked(g.max_points, completion);
  const got = displayBanked(g.points, completion);
  const left = Math.max(0, max - got);
  const progress = Math.max(0, Math.min(100, Number(g.progress) || 0));
  const soon = closingState(g) === 'closing';
  const count = Number(g.trophy_count) || 0;

  /**
   * "on the table" for a game they do not own, "left" for one they do, because
   * those are different numbers: one is the whole game, the other is what is
   * still unclaimed in it. Both already through the completion multiplier, so
   * the card promises what the update will actually pay.
   */
  const pay = mine
    ? `${progress}% done &middot; <b>${n(left)}</b> points left`
    : `<b>${n(max)}</b> on the table${
        Number(g.local_started) > 0
          ? ` &middot; ${n(g.local_started)} here own it`
          : ' &middot; nobody here owns it'
      }`;

  return `<li class="slot" style="--i:${i}">
    <div class="dcard">
      <div class="dface dback"><img src="/Kraken.png" alt="" width="192" height="192"></div>
      <div class="dface dfront${mine ? '' : ' wild'}">
        <span class="dcover">${
          g.icon_url
            ? `<img src="${esc(g.icon_url)}" alt="" loading="lazy" width="160" height="160">`
            : ''
        }<span class="dpool">${mine ? 'Backlog' : 'Wildcard'}</span>${
    g.platform ? `<span class="dplat">${esc(g.platform)}</span>` : ''
  }</span>
        <span class="dbody">
          <a class="dt" href="${esc(gameHref(g.np_comm_id, who))}">${esc(g.title)}</a>
          ${count ? `<span class="dmeta">${n(count)} ${count === 1 ? 'trophy' : 'trophies'}</span>` : ''}
          ${
            soon
              ? `<span class="closes${isUrgent(g.closes_at) ? '' : ' later'}">${esc(
                  closingLabel(g.closes_at),
                )}</span>`
              : ''
          }
          <span class="dpay">${pay}</span>
          ${
            mine
              ? `<span class="track"><span class="fill ${barShade(g)}" style="width:${progress}%"></span></span>`
              : ''
          }
        </span>
      </div>
    </div>
  </li>`;
}

/**
 * The mark beside a game title, and the sentence under it.
 *
 * THIS WAS A POPUP AND THE POPUP WAS THE BUG. The note used to be an absolutely
 * positioned panel inside a <details>, which looked right on a desktop and did
 * something horrible everywhere else: `.tablewrap` sets `overflow-x:auto` so
 * the table can scroll sideways on a phone, and CSS turns the OTHER axis into
 * `auto` the moment one axis is not `visible`. So a panel hanging below the
 * table made the table itself scrollable, and reading a flag meant scrolling a
 * box you did not know you were in. Leon found it within a day.
 *
 * It is a line under the title now — no click, no layer, no overflow. The site
 * already prints "closes in 21 days" exactly this way, so the two now match,
 * and the information arrives without anybody having to discover that the icon
 * was a button.
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
        deadTitle(g),
      )}">&#9888;</span>`,
      note: '',
    };
  }

  return { mark: '', note: '' };
}

function gameRow(g, who, completion, live = 0) {
  const marks = clockMarks(g);
  const done = Number(g.progress) === 100;

  /**
   * BANKED, NOT RAW — see the note on the same change in functions/game/[id].js.
   *
   * `mg.points` and `g.max_points` are rarity sums, identical for any two people
   * with the same trophies. What this hunter actually scores is that multiplied
   * by their completion. Printing the raw figure told a 70.41% member a game
   * was worth 1,400 when it pays them 980 — the exact thing `/backlog` in the
   * bot has always been careful not to do.
   *
   * BOTH numbers are multiplied, never one. Half a fraction in the member's
   * currency and half in the game's is worse than either on its own.
   */
  const max = displayBanked(g.max_points, completion);
  const got = displayBanked(g.points, completion);
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
  const shade = barShade(g);
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
        marks.mark
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
      }${marks.note}
    </td>
    <td class="num prog" data-v="${width}">
      <span class="${done ? 'done' : ''}">${width}%</span>
      <span class="track"><span class="fill ${shade}" style="width:${width}%">${
    /**
     * The share of the filled bar that was earned in front of an audience.
     *
     * By trophy count, laid over the end of the fill, so the bar's total width
     * still equals the percentage above it and only the split inside is
     * approximate. Same rule as the overlay, and the same reason: getting the
     * split exactly right would mean re-deriving PSN's own weighting, and being
     * wrong about that would move the number people read.
     */
    live > 0 && Number(g.earned_total) > 0
      ? `<span class="onair" style="width:${(
          Math.min(1, live / Number(g.earned_total)) * 100
        ).toFixed(2)}%"></span>`
      : ''
  }</span></span>
      <span class="tcount">${n(g.earned_total)} / ${n(g.trophy_count)}${
    live > 0
      ? `<span class="livecount" title="${n(live)} earned live on stream">${n(live)} live</span>`
      : ''
  }</span>
    </td>
    <td class="num pts" data-v="${got}" title="${
      max ? `${n(left)} points left to earn` : 'No trophy in this game is hard for anybody'
    }">${max ? `${n(got)} <span class="of-max">/ ${n(max)}</span>` : '<span class="zero">0</span>'}</td>
    <td class="bar"></td>
  </tr>`;
}

/**
 * One hunter's header card inside the compare panel.
 *
 * The same four figures as the top of the page, at a size that lets two of them
 * sit side by side. Rank first, because rank is the only one of the four that is
 * a comparison already.
 */
function vsCard(x, side) {
  const country = flag(x.country);
  return `<div class="vscard ${side}">
    ${
      x.avatar_url
        ? `<img class="vsav" src="${esc(x.avatar_url)}" alt="" width="44" height="44" loading="lazy">`
        : '<span class="vsav"></span>'
    }
    <div class="vswho">
      <span class="vsline"><a href="/hunter/${encodeURIComponent(x.psn_online_id)}">${
        country ? `${country} ` : ''
      }${esc(x.psn_online_id)}</a>${supporterStar(x.supporter_months)}</span>
      <span class="vsrank">${ordinal(x.rank)}</span>
    </div>
    <dl class="vsfacts">
      <div><dt>Points</dt><dd>${n(x.points)}</dd></div>
      <div><dt>Completion</dt><dd>${pct(x.completion)}</dd></div>
      <div><dt>Finished</dt><dd>${n(x.completed)} / ${n(x.projects)}</dd></div>
    </dl>
  </div>`;
}

/**
 * Two bars, or one.
 *
 * SAME BAR AS THE LIBRARY TABLE, stacked. Two hunters on one track would need
 * two colours inside one groove and the reader has to work out which end is
 * whose; two grooves one above the other reads instantly and costs eight pixels.
 *
 * The colours are fixed by SIDE, not by score: this hunter is always the teal
 * and the challenger is always the amber, on every row, so the eye learns it
 * once. Nothing here goes green for finished, because a row where both are
 * green tells you less than a row where both are full.
 */
function vsBar(side, progress) {
  const w = Math.max(0, Math.min(100, Number(progress) || 0));
  return `<span class="vsb ${side}">
    <span class="track"><span class="fill" style="width:${w}%"></span></span>
    <i>${w}%</i>
  </span>`;
}

function vsRow(g, meName, themName, myCompletion) {
  const has = g.my_progress != null;
  const left = Math.max(0, displayBanked(g.max_points, myCompletion) - displayBanked(g.my_points ?? 0, myCompletion));

  return `<li class="vsrow">
    ${
      g.icon_url
        ? `<img class="ico" src="${esc(g.icon_url)}" alt="" loading="lazy" width="46" height="46">`
        : '<span class="ico"></span>'
    }
    <div class="vsg">
      ${g.platform ? `<span class="plat-chip">${esc(g.platform)}</span>` : ''}<a
        class="tname" href="${esc(gameHref(g.np_comm_id, themName))}">${esc(g.title)}</a>
      <span class="vsmeta">${
        has
          ? `${n(g.my_trophies)} v ${n(g.their_trophies)} of ${n(g.trophy_count)} trophies`
          : `${n(g.their_trophies)} of ${n(g.trophy_count)} trophies`
      }${left > 0 ? ` &middot; ${n(left)} left for ${esc(meName)}` : ''}</span>
    </div>
    <div class="vsbars">
      ${has ? vsBar('mine', g.my_progress) : ''}
      ${vsBar('them', g.their_progress)}
    </div>
  </li>`;
}

/**
 * The compare panel.
 *
 * POINTS ARE NOT COMPARED PER GAME AND THAT IS SAID OUT LOUD. Two people
 * holding the identical set of trophies score differently here, because the
 * board multiplies a game by the hunter's own completion. Printing "4,200 v
 * 2,900" beside one game would look like a scoring bug to everybody who did not
 * already know that, so the per-game columns are progress and trophies, both of
 * which mean the same thing for both people, and the points sit in the header
 * where they belong.
 */
function comparePanel(me, them, ahead, theirs, clearHref, moreHref) {
  const gap = (Number(them.points) || 0) - (Number(me.points) || 0);
  const line =
    gap > 0
      ? `${esc(them.psn_online_id)} is <b>${n(gap)}</b> points ahead.`
      : gap < 0
        ? `${esc(them.psn_online_id)} is <b>${n(-gap)}</b> points behind.`
        : 'Dead level.';

  /**
   * "There are more of these" is a LINK, not a count.
   *
   * Counting them would mean a third query over the same two libraries to print
   * a number, and the honest version of that number is the one thing the query
   * already knows: whether it filled up. So the row budget is fetched with one
   * spare, the spare is dropped, and its existence is the whole of "there is
   * more".
   */
  const more = (rows, label) =>
    rows.more && moreHref
      ? `<p class="vsmore"><a href="${esc(moreHref)}">${esc(label)}</a></p>`
      : '';

  const aheadBlock = ahead.length
    ? `<h3>Further along than ${esc(me.psn_online_id)}</h3>
       <p class="vsnote">Games you both own where ${esc(them.psn_online_id)} is deeper in,
         biggest prize first.</p>
       <ul class="vslist">${ahead
         .map((g) => vsRow(g, me.psn_online_id, them.psn_online_id, me.completion))
         .join('')}</ul>
       ${more(ahead, 'Show every game they are ahead on')}`
    : `<h3>Further along than ${esc(me.psn_online_id)}</h3>
       <p class="vsnote">Nothing. On every game they both own, ${esc(
         me.psn_online_id,
       )} is level or ahead.</p>`;

  const theirsBlock = theirs.length
    ? `<h3>${esc(them.psn_online_id)} plays, ${esc(me.psn_online_id)} has not</h3>
       <p class="vsnote">Worth the most first. Nothing here is a recommendation about
         difficulty.</p>
       <ul class="vslist">${theirs
         .map((g) => vsRow(g, me.psn_online_id, them.psn_online_id, me.completion))
         .join('')}</ul>
       ${more(theirs, 'Show everything they have that you have not')}`
    : '';

  return `<section class="panel vs">
    <h2>Head to head <a class="vsclear" href="${esc(clearHref)}">Close</a></h2>
    <div class="vshead">
      ${vsCard(me, 'mine')}
      <span class="vsx">vs</span>
      ${vsCard(them, 'them')}
    </div>
    <p class="vsgap">${line}</p>
    ${aheadBlock}
    ${theirsBlock}
    <p class="vsnote foot">Points are not compared game by game on purpose. The board
      multiplies every game by the hunter's own completion, so the same trophies are
      worth different amounts to different people. Progress and trophy counts mean the
      same thing for both of you, so those are what the rows show.</p>
  </section>`;
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

  // PSN online ids top out at sixteen characters. Forty is generous and still
  // caps what an idle person can put through a lookup.
  const vsName = String(url.searchParams.get('vs') || '').trim().slice(0, 40);
  // The long version of a comparison. Costs no extra rows read, so it is a
  // display switch rather than a second, heavier feature.
  const vsAll = url.searchParams.has('all');

  /**
   * Which platform this deal is narrowed to, or null for all of them.
   *
   * A key from the whitelist and nothing else. An unknown value is treated as
   * no filter rather than as an error: somebody editing the URL by hand should
   * get a normal deal, not a broken page.
   */
  const platKey = PLATFORMS[url.searchParams.get('plat')] ? url.searchParams.get('plat') : null;
  const plat = platKey ? PLATFORMS[platKey].match : null;

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

  /**
   * Wrapped, because `on_stream` arrives in migration 024. One un-run migration
   * costs the purple, never the page.
   */
  const { results: liveRows = [] } = await env.DB.prepare(ON_STREAM)
    .bind(m.psn_account_id)
    .all()
    .catch(() => ({ results: [] }));

  const onStream = new Map(liveRows.map((r) => [r.np_comm_id, Number(r.live) || 0]));

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

  /**
   * Rivals ride the first page too, and for the same reason — it is the same
   * five rows however deep into somebody's library you are, so paying for them
   * on page 6 buys nothing.
   *
   * parseRivals never throws. A column mangled by an older build renders as no
   * rivals at all, which is the correct failure: a decoration on a page must
   * not be able to take the page down.
   */
  const rivalIds = pageNo === 1 && !q ? parseRivals(m.rivals) : [];
  const { results: rivals = [] } = rivalIds.length
    ? await env.DB.prepare(rivalsSql(rivalIds.length)).bind(...rivalIds).all()
    : { results: [] };

  // Only when asked. Nobody pays for the dice unless somebody rolls them.
  const [backlogPicks, wildPicks] = rolling
    ? await Promise.all([
        env.DB.prepare(rollBacklogSql(plat))
          .bind(...(plat
            ? [m.psn_account_id, plat, BACKLOG_PICKS]
            : [m.psn_account_id, BACKLOG_PICKS]))
          .all()
          .then((r) => r.results ?? []),
        wildcards(env, m.psn_account_id, WILDCARD_PICKS, plat),
      ])
    : [[], []];

  /**
   * The comparison, and only when one was asked for.
   *
   * THREE THINGS CAN GO WRONG and each of them says so in a sentence rather
   * than 404ing the page: the name is nobody, the name is this hunter, or the
   * name is somebody with no library. None of those is an error worth losing
   * the page you were already reading.
   */
  const vsHref = `/hunter/${encodeURIComponent(m.psn_online_id)}?sort=${encodeURIComponent(sort)}${
    q ? `&q=${encodeURIComponent(q)}` : ''
  }`;

  let vsBlock = '';
  if (vsName) {
    const them = await env.DB.prepare(VS_MEMBER).bind(vsName).first();
    const same = them && them.psn_account_id === m.psn_account_id;

    if (!them) {
      vsBlock = `<section class="panel vs miss"><p class="vsnote">
          No hunter called <b>${esc(vsName)}</b> is on the board.
          <a href="${esc(vsHref)}">Close</a></p></section>`;
    } else if (same) {
      vsBlock = `<section class="panel vs miss"><p class="vsnote">
          That is the same hunter. Pick somebody else to compare against.
          <a href="${esc(vsHref)}">Close</a></p></section>`;
    } else {
      const aheadCap = vsAll ? VS_ALL : VS_ROWS;
      const theirsCap = vsAll ? VS_ALL : VS_NEW_ROWS;

      // One spare row each, exactly like the library pager. Its existence is
      // the whole of "there is more", and it costs one row rather than a
      // COUNT over both libraries.
      const [aheadRes, theirsRes] = await Promise.all([
        env.DB.prepare(VS_AHEAD)
          .bind(them.psn_account_id, m.psn_account_id, aheadCap + 1)
          .all(),
        env.DB.prepare(VS_THEIRS)
          .bind(them.psn_account_id, m.psn_account_id, theirsCap + 1)
          .all(),
      ]);

      const trim = (rows, cap) => {
        const all = rows ?? [];
        const out = all.slice(0, cap);
        out.more = all.length > cap;
        return out;
      };

      vsBlock = comparePanel(
        m,
        them,
        trim(aheadRes?.results, aheadCap),
        trim(theirsRes?.results, theirsCap),
        vsHref,
        `${vsHref}&vs=${encodeURIComponent(them.psn_online_id)}&all=1`,
      );
    }
  }

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

  /**
   * The rivals panel.
   *
   * SORTED BY RANK, NEVER BY GAP. Sorting by the gap would reshuffle the list
   * every time anybody played anything, and the whole use of this thing is
   * glancing at it and knowing where people sit. Rank is the order they are in
   * on the board, so the list reads the same way the board does.
   *
   * The hunter is folded into their own list. A watchlist that does not show
   * you is a table of five numbers with nothing to measure against — the row
   * that says "you" is what turns it into a race.
   *
   * EVERY GAP IS MEASURED FROM THE HUNTER WHOSE PAGE THIS IS, not from whoever
   * is reading. The site still has no idea who is looking, so "8,263 ahead" on
   * Leon's page means ahead of Leon. Saying it any other way would be a lie to
   * everybody except one person.
   */
  const mine = Number(m.points) || 0;
  const rivalRows = [...rivals, m]
    .filter((r) => r && r.rank)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => {
      const isMe = r.psn_account_id === m.psn_account_id;
      const gap = (Number(r.points) || 0) - mine;
      const tail = isMe
        ? '<span class="gme">this hunter</span>'
        : gap > 0
          ? `<span class="gup">&#9650; ${n(gap)} ahead</span>`
          : gap < 0
            ? `<span class="gdn">&#9660; ${n(-gap)} behind</span>`
            : '<span class="glv">level</span>';
      return (
        `<tr${isMe ? ' class="isme"' : ''}>` +
        `<td class="rk">${n(r.rank)}</td>` +
        `<td class="who"><a href="/hunter/${encodeURIComponent(r.psn_online_id)}">${esc(
          r.psn_online_id,
        )}</a>${supporterStar(r.supporter_months)}</td>` +
        `<td class="num">${n(r.points)}</td>` +
        `<td class="gap">${tail}</td></tr>`
      );
    })
    .join('');

  const rivalsBlock = rivals.length
    ? `<details class="numbers rivals">
         <summary>Rivals<span class="soon-tag">${rivals.length} of ${MAX_RIVALS}</span></summary>
         <div class="tablewrap"><table class="rivaltab"><tbody>${rivalRows}</tbody></table></div>
         <p class="rivalnote">Set with <code>/rivals</code> in Discord.</p>
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
  const rollHref = `/hunter/${encodeURIComponent(m.psn_online_id)}?roll=${Date.now() % 100000}${
    platKey ? `&plat=${platKey}` : ''
  }`;

  /**
   * A chip per platform, each one its own deal.
   *
   * Every chip carries a fresh roll value, because changing the platform IS a
   * new deal: leaving the old one on screen under a different filter would show
   * five games that do not match the chip now lit.
   */
  const platHref = (key) =>
    `/hunter/${encodeURIComponent(m.psn_online_id)}?roll=${(Date.now() + 1) % 100000}${
      key ? `&plat=${key}` : ''
    }`;

  const platChips =
    `<div class="platrow">` +
    `<a class="tab${platKey ? '' : ' on'}" href="${esc(platHref(null))}">All</a>` +
    Object.entries(PLATFORMS)
      .map(
        ([key, p]) =>
          `<a class="tab${key === platKey ? ' on' : ''}" href="${esc(platHref(key))}">${esc(
            p.label,
          )}</a>`,
      )
      .join('') +
    `</div>`;

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

  /**
   * ONE DECK, NOT TWO LISTS.
   *
   * The backlog picks and the wildcards used to be two labelled lists stacked
   * on top of each other. Dealt, they have to be a single row or it stops being
   * one gesture and becomes two smaller ones. Which pool a card came from is
   * still said, on the card, where it belongs: the chip reads Backlog or
   * Wildcard and the accent follows it.
   *
   * --last is what lets every card fly in from the same place. A card is
   * translated relative to its OWN box, so a fixed offset would start all five
   * the same distance right of their own slot and slide them in parallel;
   * (last - i) columns of travel starts them all at the last slot instead,
   * which is what being dealt from one hand looks like.
   */
  const picks = [
    ...backlogPicks.map((g) => ({ g, mine: true })),
    ...wildPicks.map((g) => ({ g, mine: false })),
  ];

  const rollBlock = rolling
    ? `<section class="panel roll rolled">
         <h2>What should ${whose} play?
           <a href="${esc(rollHref)}">Deal again &rsaquo;</a>
         </h2>
         ${platChips}
         ${
           picks.length
             ? `<ul class="deck" style="--last:${picks.length - 1}">${picks
                 .map(({ g, mine }, i) =>
                   dealCard(g, {
                     mine,
                     who: mine ? m.psn_online_id : '',
                     completion: m.completion,
                     i,
                   }),
                 )
                 .join('')}</ul>`
             : platKey
               ? `<p class="note">Nothing on <b>${esc(PLATFORMS[platKey].label)}</b> to deal.
                    ${whose} either has none left worth finishing there, or none at all.
                    <a href="${esc(platHref(null))}">Deal from everything</a></p>`
               : `<p class="note">Nothing unfinished worth points, which is its own kind of answer.</p>`
         }
         <p class="note">Three from ${whose}'s backlog and two from games this library does
           not have${platKey ? `, ${esc(PLATFORMS[platKey].label)} only` : ''}. Nothing here is a
           recommendation about difficulty. It is a coin toss with the shovelware filtered
           out.</p>
       </section>`
    : '';

  /**
   * The invitation. A deck rather than a die, so the button and the thing it
   * does are the same object.
   */
  const cardMark =
    '<span class="dmark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none">' +
    '<rect x="2.6" y="5.4" width="10.4" height="14.2" rx="2" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M7.6 3.4h9.2a2.4 2.4 0 0 1 2.4 2.4v10.4" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round"/></svg></span>';

  const rollLink = `<a class="rollcta" href="${esc(rollHref)}">${cardMark}${
    rolling ? 'Deal again' : 'Deal the cards'
  }</a>`;

  const body = `
    ${crumb('/leaderboard', 'Leaderboard')}

    <section class="hero">
      ${
        m.avatar_url
          ? `<img class="bigav" src="${esc(m.avatar_url)}" alt="" width="76" height="76">`
          : '<span class="bigav"></span>'
      }
      <h1>${country ? `${country} ` : ''}${esc(m.psn_online_id)}${supporterStar(
        m.supporter_months,
      )}</h1>
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

    <div class="toolrow">${rivalsBlock}${numbersBlock}${rollLink}</div>

    ${rollBlock}

    <form class="find vsfind" method="get" action="/hunter/${encodeURIComponent(m.psn_online_id)}">
      <input type="search" name="vs" value="${esc(vsName)}"
             placeholder="Compare ${esc(m.psn_online_id)} with another hunter"
             aria-label="Compare with another hunter" maxlength="40">
      <input type="hidden" name="sort" value="${esc(sort)}">
      ${q ? `<input type="hidden" name="q" value="${esc(q)}">` : ''}
      <button type="submit">Compare</button>
    </form>

    ${vsBlock}

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
               <tbody>${games
                 .map((g) =>
                   gameRow(g, m.psn_online_id, m.completion, onStream.get(g.np_comm_id) ?? 0),
                 )
                 .join('')}</tbody>
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
