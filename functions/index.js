/**
 * The board. GET /
 *
 * ONE QUERY, and this page must never get cleverer than that. Everything shown
 * here is already computed and stored: `points` is the final score with the
 * completion multiplier applied, `rank` is the position the bot assigned, and
 * ordering by rank is the whole of the logic.
 *
 * The rule from the plan, restated because this is the file most likely to
 * break it: THE SITE COMPUTES NOTHING. If a number here ever disagrees with
 * Discord, that is a bug in this file, always. The scoring spec exists so the
 * figures can be checked, not so they can be recalculated.
 *
 * Sorting and filtering happen in the browser rather than in SQL. Sixty-odd
 * rows is nothing to sort client-side, and it means the page stays one cached
 * read no matter how many different ways people look at it.
 */

import { page, html, esc, n, pct, flag, tierFor, TIER, ordinal } from './_lib/page.js';

const BOARD = `
  SELECT rank, prev_rank, psn_online_id, country, avatar_url,
         points, completion, platinum, gold, silver, bronze,
         projects, completed
    FROM members
   WHERE rank IS NOT NULL AND last_update_at IS NOT NULL
   ORDER BY rank ASC`;

/** ▲ 3 / ▼ 2 / — since the last time ranks were recomputed. */
function movement(rank, prev) {
  if (!prev || !rank || prev === rank) return '<td class="move s">·</td>';
  const by = prev - rank;
  return by > 0
    ? `<td class="move u" title="up ${by}">▲${by}</td>`
    : `<td class="move d" title="down ${-by}">▼${-by}</td>`;
}

function row(m, total) {
  const tier = tierFor(m.rank, total);
  const { name, color } = TIER[tier];
  const country = flag(m.country);
  const trophies = (m.platinum ?? 0) + (m.gold ?? 0) + (m.silver ?? 0) + (m.bronze ?? 0);

  return `<tr>
    <td class="rank">${ordinal(m.rank)}</td>
    ${movement(m.rank, m.prev_rank)}
    <td>
      <span class="hunter">
        ${m.avatar_url ? `<img class="av" src="${esc(m.avatar_url)}" alt="" loading="lazy" width="26" height="26">` : '<span class="av"></span>'}
        <span class="name">${country ? `${country} ` : ''}${esc(m.psn_online_id)}</span>
      </span>
    </td>
    <td class="hide-s"><span class="tier" style="color:${color}">${name}</span></td>
    <td class="num pts" data-v="${Number(m.points) || 0}">${n(m.points)}</td>
    <td class="num" data-v="${Number(m.completion) || 0}">${pct(m.completion)}</td>
    <td class="num tro hide-s" data-v="${trophies}">${n(trophies)}</td>
    <td class="num tro hide-s" data-v="${Number(m.completed) || 0}">${n(m.completed)} / ${n(m.projects)}</td>
  </tr>`;
}

// Client-side sort. Reads data-v where a cell carries one, so "1,303" and
// "88.42%" sort as numbers rather than as strings beginning with 1 and 8.
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
  const { results = [] } = await env.DB.prepare(BOARD).all();
  const total = results.length;

  const sum = (k) => results.reduce((t, m) => t + (Number(m[k]) || 0), 0);

  const body = total
    ? `<p class="stats" style="margin:0 0 14px">
         <b>${n(total)}</b> hunters ·
         <b>${n(sum('points'))}</b> points ·
         <b>${n(sum('platinum'))}</b> platinums between them
       </p>
       <div class="tablewrap">
         <table>
           <thead><tr>
             <th>#</th><th></th><th>Hunter</th><th class="hide-s">Tier</th>
             <th class="num" aria-sort="descending">Points</th>
             <th class="num">Completion</th>
             <th class="num hide-s">Trophies</th>
             <th class="num hide-s">Finished</th>
           </tr></thead>
           <tbody>${results.map((m) => row(m, total)).join('')}</tbody>
         </table>
       </div>
       <footer>
         Scores come from <b>Kraken</b>, which prices every trophy on how rare it is
         worldwide, multiplies it by how many of us are still stuck on that game, and
         scales the lot by your completion. Click a column to sort.<br>
         Joining happens in Discord. This page is the window, not the door.
       </footer>
       <script>${SORT_JS}</script>`
    : `<div class="tablewrap"><p class="empty">Nobody has finished a scan yet.</p></div>`;

  return html(
    page({
      title: 'Hunters Lodge',
      description: `The Platinum Intel trophy leaderboard. ${total} hunters ranked by how hard their trophies were.`,
      body,
    }),
  );
}
