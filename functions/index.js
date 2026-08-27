/**
 * The front page. GET /
 *
 * WHAT THIS DELIBERATELY IS NOT: PSNProfiles. Those sites carry forums, guides,
 * news, sale round-ups and a wall of panels because they serve hundreds of
 * thousands of strangers who arrived from a search engine — the density is SEO
 * surface and ad inventory, not design. Every member here arrives from a Discord
 * link already knowing what this is, so copying that shape would produce a page
 * that looks busy and empty at once: most of the panels would have nothing to
 * put in them.
 *
 * What those sites cannot show is THIS SERVER. Who is stuck on what, who just
 * finished something at two in the morning, who turned up this week. That is the
 * whole page.
 *
 * FIVE SMALL QUERIES, each cached for five minutes at the edge, so the real cost
 * is a handful of reads per five minutes across everybody rather than per view.
 * And as everywhere else on this site: every number here is read, never
 * computed. "6 of 9 still in it" is two stored columns printed side by side.
 */

import { page, html, esc, n, flag, ordinal, navButtons } from './_lib/page.js';

const TOTALS = `
  SELECT COUNT(*)        AS hunters,
         SUM(points)     AS points,
         SUM(platinum)   AS platinum,
         SUM(projects)   AS projects,
         SUM(completed)  AS completed
    FROM members
   WHERE rank IS NOT NULL AND last_update_at IS NOT NULL`;

const TOP = `
  SELECT rank, prev_rank, psn_online_id, country, avatar_url, points, completion
    FROM members
   WHERE rank IS NOT NULL AND last_update_at IS NOT NULL
   ORDER BY rank ASC
   LIMIT 10`;

/**
 * Most contested — MIRRORED from shared/contested.mjs, not reinvented.
 *
 * That file is the canonical definition and the Discord `/contested` command
 * uses it. The site cannot import it without dragging the scoring module into
 * the Pages bundle, so the query is copied and the ordering left byte-identical.
 * If the definition ever changes it changes in both places; the comment in
 * contested.mjs is the one that explains WHY each exclusion is there.
 *
 * The multiplier is deliberately NOT computed here. The bot's version prices
 * the platinum; this one prints "6 of 9 still in it", which is two stored
 * numbers and cannot drift.
 */
const CONTESTED = `
  SELECT g.np_comm_id, g.title, g.platform, g.local_started, g.unobtainable,
         t.local_earned AS platted_here
    FROM games g
    JOIN trophies t
      ON t.np_comm_id = g.np_comm_id AND t.type = 'platinum'
   WHERE g.local_started >= 3
     AND t.local_earned < g.local_started
     AND g.max_points > 0
     AND g.unobtainable = 0
   ORDER BY (g.local_started + 0.5) / (t.local_earned + 0.5) DESC,
            g.local_started DESC,
            g.max_points DESC
   LIMIT 5`;

/**
 * Ordered by update_id rather than by a timestamp, so SQLite walks the
 * changelog's primary key backwards and stops after five matches instead of
 * scanning the table to sort it.
 */
const FINISHED = `
  SELECT c.title, c.np_comm_id, m.psn_online_id, u.finished_at
    FROM update_changelog c
    JOIN updates u ON u.id = c.update_id
    JOIN members m ON m.psn_account_id = u.psn_account_id
   WHERE c.progress_to = 100
   ORDER BY c.update_id DESC
   LIMIT 6`;

const NEWEST = `
  SELECT psn_online_id, country, avatar_url, rank, registered_at
    FROM members
   WHERE rank IS NOT NULL AND last_update_at IS NOT NULL
   ORDER BY registered_at DESC
   LIMIT 5`;

const when = (ms) => {
  const t = Number(ms);
  if (!t) return '';
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  const m = Math.floor(d / 30);
  return m < 24 ? `${m} month${m === 1 ? '' : 's'} ago` : `${Math.floor(d / 365)} years ago`;
};

const hunterLink = (name) => `/hunter/${encodeURIComponent(name)}`;

const avatar = (url, size = 26) =>
  url
    ? `<img class="av" src="${esc(url)}" alt="" loading="lazy" width="${size}" height="${size}">`
    : '<span class="av"></span>';

/**
 * NO TIER CHIP HERE, on purpose. It was squeezing PSN names into "RobTha..."
 * and "Bruc...", and a truncated name is the one thing in the row nobody can
 * infer from context — you can guess a rank from position and a tier from the
 * rank, but not a name from four letters. The tier is on the board itself,
 * one click away, where there is room for it.
 */
function topRow(m) {
  const country = flag(m.country);
  return `<li>
    <span class="pos">${ordinal(m.rank)}</span>
    ${avatar(m.avatar_url)}
    <a class="who" href="${esc(hunterLink(m.psn_online_id))}">${
      country ? `${country} ` : ''
    }${esc(m.psn_online_id)}</a>
    <span class="val">${n(m.points)}</span>
  </li>`;
}

export async function onRequestGet({ env }) {
  const [totals, top, contested, finished, newest] = await Promise.all([
    env.DB.prepare(TOTALS).first(),
    env.DB.prepare(TOP).all(),
    env.DB.prepare(CONTESTED).all(),
    env.DB.prepare(FINISHED).all(),
    env.DB.prepare(NEWEST).all(),
  ]);

  const hunters = Number(totals?.hunters) || 0;
  const rows = top?.results ?? [];

  const stat = (label, value) =>
    `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;

  const body = `
    <section class="hero home">
      <img class="doormark" src="/Kraken.png" alt="Kraken" width="132" height="132">
      <h1>The trophy board for <span>Platinum Intel</span></h1>
      <p class="lede">
        Kraken scores your PlayStation trophies on how <b>hard</b> they are, not how many
        you have. Easy trophies pay nothing, rare ones pay properly, and a game is worth
        more while people here are still stuck on it.
      </p>
      <nav class="doornav">${navButtons()}</nav>
    </section>

    <dl class="totals">
      ${stat('Hunters', n(hunters))}
      ${stat('Points banked', n(totals?.points))}
      ${stat('Platinums', n(totals?.platinum))}
      ${stat('Games tracked', n(totals?.projects))}
      ${stat('Taken to 100%', n(totals?.completed))}
    </dl>

    <div class="cols">
      <section class="panel">
        <h2>Leading the board <a href="/leaderboard">All ${n(hunters)} &rsaquo;</a></h2>
        ${
          rows.length
            ? `<ol class="top">${rows.map(topRow).join('')}</ol>`
            : '<p class="empty">Nobody has finished a scan yet.</p>'
        }
      </section>

      <section class="panel">
        <h2>Most contested</h2>
        ${
          contested?.results?.length
            ? `<ul class="feed">${contested.results
                .map(
                  (g) => `<li>
                    <span class="t">${esc(g.title)}${
                      g.unobtainable ? ' <span class="warn">&#9888;</span>' : ''
                    }</span>
                    <span class="s">${n(
                      (Number(g.local_started) || 0) - (Number(g.platted_here) || 0),
                    )} of ${n(g.local_started)} still in it</span>
                  </li>`,
                )
                .join('')}</ul>
               <p class="note">Games several of us own and nobody here has finished.
                 Every trophy in them is worth more until somebody does.</p>`
            : '<p class="empty">Nothing contested right now.</p>'
        }
      </section>

      <section class="panel">
        <h2>Just finished</h2>
        ${
          finished?.results?.length
            ? `<ul class="feed">${finished.results
                .map(
                  (f) => `<li>
                    <span class="t">${esc(f.title)}</span>
                    <span class="s"><a href="${esc(
                      hunterLink(f.psn_online_id),
                    )}">${esc(f.psn_online_id)}</a> &middot; ${esc(when(f.finished_at))}</span>
                  </li>`,
                )
                .join('')}</ul>`
            : '<p class="empty">Nothing finished yet.</p>'
        }
      </section>

      <section class="panel">
        <h2>Newest hunters</h2>
        ${
          newest?.results?.length
            ? `<ul class="feed people">${newest.results
                .map(
                  (m) => `<li>
                    ${avatar(m.avatar_url, 30)}
                    <span class="t"><a href="${esc(hunterLink(m.psn_online_id))}">${
                      flag(m.country) ? `${flag(m.country)} ` : ''
                    }${esc(m.psn_online_id)}</a></span>
                    <span class="s">${esc(when(m.registered_at))} &middot; ${ordinal(m.rank)}</span>
                  </li>`,
                )
                .join('')}</ul>`
            : '<p class="empty">Nobody yet.</p>'
        }
      </section>
    </div>`;

  return html(
    page({
      title: 'Kraken',
      description:
        `The trophy board for Platinum Intel. ${hunters} hunters scored on how hard ` +
        'their trophies were, not how many they have.',
      here: 'home',
      bare: true,
      body,
    }),
  );
}
