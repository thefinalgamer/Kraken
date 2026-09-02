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

import {
  page, html, esc, n, flag, ordinal, navButtons,
  closingState, closingLabel, isUrgent,
  gameHref,
} from './_lib/page.js';

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
         g.closes_at, t.local_earned AS platted_here
    FROM games g
    JOIN trophies t
      ON t.np_comm_id = g.np_comm_id AND t.type = 'platinum'
   WHERE g.local_started >= 3
     AND t.local_earned < g.local_started
     AND g.max_points > 0
     AND g.unobtainable = 0
   ORDER BY CASE WHEN g.closes_at IS NOT NULL THEN 0 ELSE 1 END,
            g.closes_at ASC,
            (g.local_started + 0.5) / (t.local_earned + 0.5) DESC,
            g.local_started DESC,
            g.max_points DESC
   LIMIT 6`;
/* Six, matching the two feed panels beside it rather than the ten Discord's
   /contested shows. The ORDERING is what must stay byte-identical with
   shared/contested.mjs — how many of the same list you print is a layout
   choice, and four rows left a visible hole under a ten-row leaderboard. */

/**
 * Ordered by update_id rather than by a timestamp, so SQLite walks the
 * changelog's primary key backwards and stops after five matches instead of
 * scanning the table to sort it.
 */
/**
 * The two activity feeds, from one shape.
 *
 * `kind` RATHER THAN progress_to = 100, so the site and Discord agree on what
 * counts. The scan writes 'new' when a game appears in somebody's library for
 * the first time, 'completed' on the scan where progress crosses to 100, and
 * 'progress' for everything else — and Discord's cards are built from the same
 * column. Testing `progress_to = 100` instead would have quietly included a
 * game that was already finished before we ever saw it.
 *
 * SIXTY ROWS FETCHED TO SHOW SIX, and that is not waste, it is the fix for a
 * real problem. A member's FIRST scan writes a 'new' row for every game they
 * own — fifteen hundred of them for MRTheChez — so a naive "six newest" would
 * be one person's library six times over on the day they joined, and again for
 * the next person to register. Keeping one row per UPDATE means a scan
 * contributes one line no matter how big it was, which is also how Discord
 * posts it. The rows walk the changelog's primary key backwards, so sixty costs
 * essentially what six did.
 */
const feedSql = (kind) => `
  SELECT c.title, c.np_comm_id, c.points_gained, c.update_id,
         m.psn_online_id, u.finished_at
    FROM update_changelog c
    JOIN updates u ON u.id = c.update_id
    JOIN members m ON m.psn_account_id = u.psn_account_id
   WHERE c.kind = ?
   ORDER BY c.update_id DESC
   LIMIT 60`;

/**
 * One row per update: the most valuable game in it.
 *
 * A scan where somebody starts six games is one event and gets one line. Which
 * of the six is a real choice — the biggest is the one worth reading, because
 * "started Elden Ring" says more than "started a shovelware quiz game they also
 * happened to install".
 */
function perUpdate(rows, limit = 6) {
  const best = new Map();
  for (const r of rows ?? []) {
    const seen = best.get(r.update_id);
    if (!seen || (Number(r.points_gained) || 0) > (Number(seen.points_gained) || 0)) {
      best.set(r.update_id, r);
    }
  }
  return [...best.values()].slice(0, limit);
}

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

/**
 * Who is on air, from the last Twitch check.
 *
 * `live_checked_at` is half the answer. `live_since` on its own would be a lie
 * the moment the five minute cron stopped: a stream that ended while the check
 * was broken would sit on the front page all week. A live answer that nobody
 * has confirmed for fifteen minutes is treated as no answer, which is the same
 * rule the overlay uses.
 *
 * Ordered by who went on most recently, never by points. This strip is not a
 * second leaderboard.
 */
const LIVE_STALE_MS = 15 * 60 * 1000;

const LIVE = `
  SELECT psn_online_id, avatar_url, twitch_login, rank, points,
         live_since, live_game, live_viewers, live_thumb, live_mature
    FROM members
   WHERE live_since IS NOT NULL
     AND twitch_login IS NOT NULL
     AND live_checked_at > ?
   ORDER BY live_since DESC
   LIMIT 3`;


/**
 * Who is on air, as cards rather than a list.
 *
 * IT WAS A LIST AND THE LIST WAS THE PROBLEM. A name and a dot is a fact about
 * a person; this is what is on their screen right now, how many people are
 * watching it, how long they have been at it, and where they sit on the board.
 * Martin, on the first version: "kinda lack lust, kinda beneath me, we have
 * done better".
 *
 * ALL OF IT COMES FROM THE SAME TWITCH RESPONSE the live check already makes,
 * so a card costs no more requests than the line did.
 *
 * RENDERED ONLY WHEN SOMEBODY IS LIVE. Seventy members and maybe three who
 * stream means an always-on panel would be an empty box most hours of the week,
 * and a dead zone at the top of a page is worse than no feature.
 *
 * Nobody appears here without having run /twitch themselves.
 */
function liveStrip(rows) {
  if (!rows.length) return '';

  const card = (m) => {
    const url = `https://twitch.tv/${encodeURIComponent(m.twitch_login)}`;
    const mins = Math.max(0, Math.floor((Date.now() - Number(m.live_since || 0)) / 60000));
    const hours = Math.floor(mins / 60);
    const uptime = hours ? `${hours}h ${mins % 60}m` : `${mins}m`;

    /**
     * NO PICTURE FOR A MATURE STREAM, and no picture is not the same as no
     * card. This is a frame of somebody else's broadcast hotlinked onto the
     * front of the site; Twitch's own flag is the only warning available, and
     * the honest response to it is to print the words and leave the picture
     * out rather than to hide that they are live.
     */
    const showThumb = m.live_thumb && Number(m.live_mature) !== 1;

    return `<a class="lv" href="${esc(url)}" target="_blank" rel="noopener noreferrer">
      <span class="shot">
        ${
          showThumb
            ? `<img src="${esc(m.live_thumb)}" alt="" loading="lazy" width="640" height="360">`
            : '<span class="noshot"></span>'
        }
        <span class="tag"><span class="dot" aria-hidden="true"></span>LIVE</span>
        ${
          m.live_viewers != null
            ? `<span class="watching">${n(m.live_viewers)} watching</span>`
            : ''
        }
        <span class="up">${esc(uptime)}</span>
      </span>
      <span class="meta">
        ${avatar(m.avatar_url, 34)}
        <span class="txt">
          <span class="nm">${esc(m.psn_online_id)}</span>
          <span class="gm">${m.live_game ? esc(m.live_game) : 'Streaming now'}</span>
        </span>
        ${
          /**
           * The one thing Twitch cannot put on this card. A stranger sees a
           * stream; a member sees the person sitting second on the board.
           */
          m.rank != null
            ? `<span class="pos">${ordinal(m.rank)}<span class="pts">${n(m.points)}</span></span>`
            : ''
        }
      </span>
    </a>`;
  };

  return `<section class="live">
    <h2><span class="dot" aria-hidden="true"></span>Live now</h2>
    <div class="lvs">${rows.map(card).join('')}</div>
  </section>`;
}

export async function onRequestGet({ env }) {
  const [totals, top, contested, finishedRows, startedRows, liveRows] = await Promise.all([
    env.DB.prepare(TOTALS).first(),
    env.DB.prepare(TOP).all(),
    env.DB.prepare(CONTESTED).all(),
    env.DB.prepare(feedSql('completed')).bind('completed').all(),
    env.DB.prepare(feedSql('new')).bind('new').all(),
    /**
     * Wrapped, because the twitch columns arrive in migration 019 and this page
     * must not go down on a database that has not run it yet. Same seatbelt the
     * flags have: one un-run migration disables one strip, not the front page.
     */
    env.DB.prepare(LIVE).bind(Date.now() - LIVE_STALE_MS).all().catch(() => ({ results: [] })),
  ]);

  const finished = perUpdate(finishedRows?.results);
  const started = perUpdate(startedRows?.results);

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

    ${liveStrip(liveRows?.results ?? [])}

    <dl class="totals">
      ${stat('Hunters', n(hunters))}
      ${stat('Points banked', n(totals?.points))}
      ${stat('Platinums', n(totals?.platinum))}
      ${/*
         "Games owned", not "Games tracked", and "100% completions", not "Taken
         to 100%". Both figures are SUMS ACROSS MEMBERS: a game five people own
         counts five times, and a game five people finished counts five times.
         The old labels claimed 83,809 distinct games when the database holds
         about 26,000, and 70,301 games taken to 100% when it is 70,301
         completions of far fewer games.

         Counting distinct instead would mean COUNT(*) over the whole games
         table on every cache miss, to print a number nobody asked for. The
         honest fix was the label, not the query — the site prints stored
         numbers, so the words have to match what is stored.
      */ ''}
      ${stat('Games owned', n(totals?.projects))}
      ${stat('100% completions', n(totals?.completed))}
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
                    <a class="t" href="${esc(gameHref(g.np_comm_id))}">${esc(g.title)}</a>
                    <span class="s">${n(
                      (Number(g.local_started) || 0) - (Number(g.platted_here) || 0),
                    )} of ${n(g.local_started)} still in it${
                      // A deadline outranks the contest, so it is said out loud
                      // rather than left as an icon.
                      closingState(g) === 'closing'
                        ? ` &middot; <b class="closes${
                            isUrgent(g.closes_at) ? '' : ' later'
                          }" style="display:inline">${esc(closingLabel(g.closes_at))}</b>`
                        : ''
                    }</span>
                  </li>`,
                )
                .join('')}</ul>
               <p class="note">Games several of us own and nobody here has finished.
                 Every trophy in them is worth more until somebody does.
                 <a href="/contested">The whole board &rsaquo;</a></p>`
            : '<p class="empty">Nothing contested right now.</p>'
        }
      </section>

      <section class="panel">
        <h2>Completed</h2>
        ${
          finished.length
            ? `<ul class="feed">${finished
                .map(
                  (f) => `<li>
                    <a class="t" href="${esc(gameHref(f.np_comm_id))}">${esc(f.title)}</a>
                    <span class="s"><a href="${esc(
                      hunterLink(f.psn_online_id),
                    )}">${esc(f.psn_online_id)}</a> &middot; ${esc(when(f.finished_at))}</span>
                  </li>`,
                )
                .join('')}</ul>`
            : '<p class="empty">Nothing completed yet.</p>'
        }
      </section>

      <section class="panel">
        <h2>New projects</h2>
        ${
          /*
           * WHAT PEOPLE HAVE JUST PICKED UP, which "Newest hunters" was not.
           * That panel answered a question nobody on a 70-member server asks
           * twice — you meet new members in Discord, not on a web page — and it
           * went stale the moment registrations slowed. What somebody started
           * this week changes every day and is the thing that makes another
           * member think "oh, I have that one too".
           */
          started.length
            ? `<ul class="feed">${started
                .map(
                  (g) => `<li>
                    <a class="t" href="${esc(gameHref(g.np_comm_id))}">${esc(g.title)}</a>
                    <span class="s"><a href="${esc(
                      hunterLink(g.psn_online_id),
                    )}">${esc(g.psn_online_id)}</a> &middot; ${esc(when(g.finished_at))}</span>
                  </li>`,
                )
                .join('')}</ul>
               <p class="note">Games somebody here has just started. One per update, so a
                 first scan does not fill the panel with one library.</p>`
            : '<p class="empty">Nobody has started anything new yet.</p>'
        }
      </section>
    </div>`;

  return html(
    page({
      title: 'Kraken',
      /**
       * THIS IS THE UNFURL TEXT, so it is written for somebody who has not been
       * here before: what the place is and how big it is. The count comes from
       * the database on every render, which is why the card image itself
       * carries no numbers.
       *
       * IT NAMES NOBODY. A line about a particular member went in here and came
       * straight back out: putting somebody's name and a claim about them on the
       * front of a website is theirs to agree to, not ours to decide.
       */
      description:
        `${hunters} hunters, one Discord, and every trophy scored on how hard it was ` +
        'rather than how many you have.',
      here: 'home',
      bare: true,
      body,
    }),
  );
}
