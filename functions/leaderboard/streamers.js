/**
 * The Streamers board. GET /leaderboard/streamers
 *
 * ONLY TROPHIES EARNED WHILE LIVE, and that one rule is the whole feature. The
 * scoring is not new and must never become new: `trophies.points` is the same
 * blended global-and-local rarity figure the all-time board reads, and the
 * completion multiplier is applied exactly as it is everywhere else. The single
 * difference is a WHERE clause. If a number here ever needs its own explanation,
 * something has gone wrong.
 *
 * WHY THE BACKLOG MUST NOT LEAK IN, which is the thing Martin spotted before a
 * line of this was written. On the all-time board, ticking 70% to 71% completion
 * re-prices EVERY trophy you have ever earned and pays out across the lot. If
 * that landed here, the play would be to grind offline all week, pop one trophy
 * on stream, and let the completion tick dump thousands of points onto a board
 * about streaming. It cannot, because a completion tick does not mark anything
 * `on_stream`; it only re-prices the trophies that are already marked. Your
 * score here moves when your completion moves, but only through work that was
 * on camera.
 *
 * THIS IS NOT THE SEASONAL BOARD. Seasonal is the third tab and a different
 * thing: every trophy, over a window of time. This one is all trophies ever
 * earned live, with no seasons and no resets built into it. The start value
 * below exists for ONE deliberate wipe of the soft-test period, not as a season
 * clock.
 *
 * DO NOT ADD functions/leaderboard/index.js. Cloudflare Pages routes `/foo` to
 * `foo/index.js` in preference to `foo.js`, so creating one would quietly steal
 * /leaderboard from functions/leaderboard.js. A sibling file in this directory
 * is fine; an index is not.
 */

import {
  page, html, esc, n, pct, flag, ordinal, supporterStar, secureUrl, boardTabs,
} from '../_lib/page.js';
import { displayBanked, hasCompletion } from '../../shared/scoring.mjs';

/**
 * Everything earned on camera, per hunter.
 *
 * `on_stream` is written by the live poll while somebody is streaming and by the
 * catch-up sweep afterwards, and has been filling since migration 024. It is set
 * to 1 or left NULL, never 0, so `= 1` is the whole test.
 *
 * The join to `trophies` is what prices it. Rows whose trophy definition has not
 * been scanned yet contribute 0 rather than dropping the hunter, which is why it
 * is COALESCE and not an inner condition.
 *
 * ORDERED BY THE RAW FIGURE ONLY AS A TIEBREAK. The real ordering happens after
 * the completion multiplier is applied, in JavaScript, because two hunters with
 * the same raw total and different completions do not finish level and SQL here
 * has no way to know that.
 */
const BOARD = `
  SELECT m.psn_account_id, m.psn_online_id, m.country, m.avatar_url,
         m.completion, m.supporter_months, m.twitch_login,
         m.live_since, m.live_checked_at,
         COUNT(*)                        AS live_trophies,
         SUM(COALESCE(t.points, 0))      AS live_raw,
         MAX(mt.earned_at)               AS last_live_at
    FROM member_trophies mt
    JOIN members  m ON m.psn_account_id = mt.psn_account_id
    JOIN trophies t ON t.np_comm_id = mt.np_comm_id
                   AND t.trophy_id  = mt.trophy_id
   WHERE mt.on_stream = 1
     AND mt.earned_at >= ?
     AND m.last_update_at IS NOT NULL
   GROUP BY m.psn_account_id
   ORDER BY live_raw DESC`;

/**
 * The line the whole board hangs off, and the reason it is a value in the
 * database rather than a constant in this file.
 *
 * The board opened as a soft test with the understanding that the points earned
 * during it would be cleared before any of it counted. Doing that as a DELETE
 * would destroy the `on_stream` marks, which are the ONLY record anywhere of
 * what was earned live: PSN cannot be asked what was on screen, so a deleted
 * mark is gone for good. A start date has the same effect for members, throws
 * nothing away, and is one statement in the D1 console rather than a code change
 * and a deploy.
 *
 * Zero means count everything, which is what it does until somebody sets it:
 *
 *   INSERT INTO worker_state (key, value) VALUES ('stream_board_from', '<ms>')
 *     ON CONFLICT(key) DO UPDATE SET value = excluded.value;
 */
const FROM_KEY = 'stream_board_from';

async function boardFrom(env) {
  const row = await env.DB
    .prepare('SELECT value FROM worker_state WHERE key = ?')
    .bind(FROM_KEY)
    .first()
    .catch(() => null);
  const at = Number(row?.value);
  return Number.isFinite(at) && at > 0 ? at : 0;
}

/** Fifteen minutes, the same staleness the home page shelf uses. */
const LIVE_STALE_MS = 15 * 60 * 1000;

/**
 * A purple dot for somebody on air right now.
 *
 * Purple is allowed here under the standing rule: it only ever appears on a page
 * that is about a person, and every row of this board is one person. There is no
 * name to add because the row already carries it.
 *
 * `live_since` alone would be a lie the moment the live check stops running, so
 * a recent `live_checked_at` is the other half of the answer.
 */
const liveNow = (m) =>
  Number(m.live_since) > 0 && Number(m.live_checked_at) > Date.now() - LIVE_STALE_MS;

const DAY = 86400000;

/** "today", "yesterday", "6 days ago", then a date. Relative only while it helps. */
function when(at) {
  const ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const days = Math.floor((Date.now() - ms) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function row(m, rank) {
  const country = flag(m.country);
  const live = liveNow(m);

  return `<tr>
    <td class="rank">${ordinal(rank)}</td>
    <td>
      <span class="hunter">
        ${m.avatar_url ? `<img class="av" src="${esc(secureUrl(m.avatar_url))}" alt="" loading="lazy" width="26" height="26">` : '<span class="av"></span>'}
        <span class="name">${country ? `${country} ` : ''}<a href="/hunter/${encodeURIComponent(
          m.psn_online_id,
        )}">${esc(m.psn_online_id)}</a>${supporterStar(m.supporter_months)}${
          live ? ' <span class="livedot" title="Live on Twitch now">&#9679; LIVE</span>' : ''
        }</span>
      </span>
    </td>
    <td class="num pts" data-v="${m.points}">${
      /**
       * "<1", NOT "0". A single very common trophy is worth about a point raw,
       * and a completion multiplier takes it under one, where the floor makes it
       * nothing. Printing 0 next to "1 live trophy" reads as a bug or as an
       * insult, and it is neither: they earned something, it is just worth less
       * than a whole point. This is the same instinct as "335 of 335" -- a
       * number that is technically correct and tells the reader the wrong thing.
       */
      m.points === 0 && Number(m.live_trophies) > 0 ? '&lt;1' : n(m.points)
    }</td>
    <td class="num tro hide-s" data-v="${Number(m.live_trophies) || 0}">${n(m.live_trophies)}</td>
    <td class="num hide-s" data-v="${Number(m.completion) || 0}">${pct(m.completion)}</td>
    <td class="num hide-s" data-v="${Number(m.last_live_at) || 0}">${esc(when(m.last_live_at))}</td>
  </tr>`;
}

// The same client-side sort the all-time board uses, reading data-v so points
// and dates sort as numbers rather than as the strings they are printed as.
const SORT_JS = `
const table=document.querySelector('table');
if(table){
  const tb=table.tBodies[0];
  table.tHead.querySelectorAll('th').forEach((th,i)=>{
    th.tabIndex=0;
    const go=()=>{
      const desc=th.getAttribute('aria-sort')!=='descending';
      table.tHead.querySelectorAll('th').forEach(o=>o.removeAttribute('aria-sort'));
      th.setAttribute('aria-sort',desc?'descending':'ascending');
      const val=tr=>{const c=tr.children[i];const d=c.dataset.v;
        return d!==undefined?parseFloat(d):c.textContent.trim().toLowerCase();};
      [...tb.rows].sort((a,b)=>{const x=val(a),y=val(b);
        const r=typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y));
        return desc?-r:r;}).forEach(tr=>tb.appendChild(tr));
    };
    th.addEventListener('click',go);
    th.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}});
  });
}`;

export async function onRequestGet({ env }) {
  const from = await boardFrom(env);

  const { results = [] } = await env.DB.prepare(BOARD).bind(from).all();

  /**
   * The multiplier, then the order. `displayBanked` rather than
   * `applyCompletion` for the same reason every other page uses it: a member
   * mid-first-scan has no completion written yet, and scoring them at zero would
   * read as "all my points vanished" rather than as a figure waiting on a scan.
   */
  const rows = results
    .map((m) => ({ ...m, points: displayBanked(Number(m.live_raw) || 0, m.completion) }))
    .sort((a, b) => b.points - a.points || b.live_trophies - a.live_trophies);

  const total = rows.length;
  const trophies = rows.reduce((sum, m) => sum + (Number(m.live_trophies) || 0), 0);

  /**
   * NOBODY IS LISTED AT ZERO. A member who has never streamed has no marked
   * trophies and so no row, which is the honest shape: sixty-seven people tied
   * on nil is not a board, it is a membership list with a column of noughts. The
   * footer says how to get on it instead.
   */
  const body = total
    ? `<section class="hero">
         <h1>Streamers</h1>
         <p class="sub"><b>${n(total)}</b> hunter${total === 1 ? '' : 's'} &middot; <b>${n(trophies)}</b> ${
           trophies === 1 ? 'trophy' : 'trophies'
         } earned live</p>
       </section>

       ${boardTabs('streamer')}

       <div class="tablewrap">
         <table>
           <thead><tr>
             <!-- Points is the ranking, so it is the one column that never
                  stands down. Everything else here has a hide-s: four columns
                  plus a LIVE pill pushed it off the right of a phone, and a
                  board whose score needs a sideways scroll is not a board. -->
             <th>#</th><th>Hunter</th>
             <th class="num" aria-sort="descending">Points</th>
             <th class="num hide-s">Live trophies</th>
             <th class="num hide-s">Completion</th>
             <th class="num hide-s">Last on stream</th>
           </tr></thead>
           <tbody>${rows.map((m, i) => row(m, i + 1)).join('')}</tbody>
         </table>
       </div>
       <footer>
         Only trophies earned while the hunter was live on Twitch count here. The points are
         the same ones the all-time board pays, rarity and completion and all; the difference
         is what gets in, and a backlog cleared off camera does not.
         ${
           rows.some((m) => !hasCompletion(m.completion))
             ? 'A hunter part-way through their first scan shows their raw total until their completion lands.<br>'
             : '<br>'
         }
         To appear here, run <b>/twitch</b> in the Discord so Kraken knows when you are live.
         Nothing earned before you did that can be counted, because PSN does not say what was
         on screen.
       </footer>
       <script>${SORT_JS}</script>`
    : `<section class="hero">
         <h1>Streamers</h1>
         <p class="sub">Nobody on the board yet</p>
       </section>

       ${boardTabs('streamer')}

       <div class="tablewrap">
         <p class="empty">
           No trophies have been earned on stream yet. Run <b>/twitch</b> in the Discord so
           Kraken knows when you are live, then go and stream. A 0 viewer stream counts.
         </p>
       </div>`;

  return html(
    page({
      title: 'Streamers · Kraken',
      description:
        'The Platinum Intel streamers board. Only trophies earned live on Twitch count, priced the same way as the all-time board.',
      here: 'board',
      body,
    }),
  );
}
