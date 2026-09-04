/**
 * One game. GET /game/<np_comm_id>
 *
 * THE FIRST PAGE ON THIS SITE THAT IS NOT ABOUT A PERSON. The board ranks
 * hunters, a hunter page lists their library, and both answer "who is winning".
 * This one answers "what am I in for" — every trophy in a game, how rare each
 * one is out in the world, how rare it is HERE, and which of the sixty-four
 * have already done it.
 *
 * THE LOCAL COLUMN IS THE WHOLE POINT. PSN's global rarity is on every trophy
 * site there has ever been. "Four of us have this and three of them are in your
 * Discord" is on none of them, and it is the number that actually makes
 * somebody open the game — so it sits beside the world figure rather than
 * behind a tab, and the sort tabs open on neither.
 *
 * COST. Reading one game is a primary-key lookup, its trophies is `trophy_count`
 * rows — forty on a normal game, a hundred and thirty-six on Minecraft — and
 * its owners is capped by the size of the server. Under two hundred rows for a
 * page that then sits in the edge cache for five minutes, which makes this
 * cheaper than the board. No pagination, because nothing here is big enough to
 * need it. `?as=` adds exactly one more row.
 *
 * THE SITE COMPUTES NOTHING, same as everywhere else. `t.points` is what the
 * bot priced that trophy at, blended with local rarity; `g.max_points` is what
 * the bot says a full completion pays. This file adds up trophy TYPES for the
 * cabinet line and nothing else.
 */

import {
  page, html, esc, n, pct, cup, miniCups, trophyGlyph, crumb, gameHref,
  closingState, closingLabel, isUrgent, barShade,
} from '../_lib/page.js';
import { displayBanked, hasCompletion } from '../../shared/scoring.mjs';

/**
 * Sorts, as a whitelist. The key never reaches SQL — it picks a fragment.
 * Same rule as the hunter page: a user string in an ORDER BY is the database.
 *
 * Every one of them sorts by group FIRST, so the DLC sections stay intact
 * whichever way the trophies inside them are ordered. Sorting rarest-first
 * across the whole game would shuffle base-game and expansion trophies together
 * and destroy the only structure the console shows.
 */
const SORTS = {
  psn: { label: 'Trophy order', sql: 't.trophy_id ASC' },
  here: { label: 'Rarest here', sql: 't.local_earned ASC, t.earned_rate ASC, t.trophy_id ASC' },
  /*
   * "Rarest on PSN" IS GONE, and losing it costs nothing.
   *
   * It sorted by the world figure, which every trophy site already sorts by,
   * and on a sixty-four member server it produced almost the same order as
   * "Rarest here" — because a trophy hardly anybody on Earth has is a trophy
   * hardly anybody in the Discord has. Two tabs that mostly agree is one tab
   * and a decision to make for no reason. The world percentage is still on
   * every card; it just no longer gets its own way of arranging them.
   */
  points: { label: 'Most points', sql: 't.points DESC, t.trophy_id ASC' },
};

/**
 * PSN ORDER, and that was a choice with an argument on both sides.
 *
 * Rarest-first leads with our own data and puts the hard ones on top, which is
 * the better page for somebody deciding whether to bother. It is the worse page
 * for somebody who has decided — they are looking for the trophy they are
 * stuck on, and they know where it sits in the in-game list because they have
 * been staring at it. Sony's order is the order on their console, so it is the
 * one people can already navigate. Rarity is one tab away.
 */
const DEFAULT_SORT = 'psn';

const GAME_COLS = `np_comm_id, title, platform, icon_url, trophy_count, has_platinum,
         max_points, estimated, unobtainable, unobtainable_note, flagged_at,
         closes_at, local_started, refreshed_at`;

const GAME = `SELECT ${GAME_COLS} FROM games WHERE np_comm_id = ? LIMIT 1`;

/**
 * Which trophies in this game were earned in front of an audience.
 *
 * `on_stream` is set by the live poll and only by the live poll, which cannot
 * run unless Twitch says the member is on air. So this is not "earned by
 * somebody who streams", it is "earned while people were watching", which is a
 * different and much better fact.
 *
 * ONE ROW PER TROPHY, and the name of whoever did it first. Reads the partial
 * index from migration 024, so it touches only flagged rows: a handful, growing
 * one at a time, live.
 */
const ON_STREAM = `
  SELECT mt.trophy_id, MIN(mt.earned_at) AS at,
         (SELECT m.psn_online_id FROM members m
           WHERE m.psn_account_id = mt.psn_account_id) AS who
    FROM member_trophies mt
   WHERE mt.np_comm_id = ? AND mt.on_stream = 1
   GROUP BY mt.trophy_id`;

/**
 * The fallback, for URLs typed by hand.
 *
 * `NPWR07110_00` is unguessable, so /game/Bloodborne is what anybody types and
 * what anybody pastes into Discord from memory. It only runs when the id lookup
 * misses, so the normal path is still one primary-key read, and it is capped at
 * one row: several editions of a game share a title and picking the one most
 * people here own is the only answer that is right more often than not.
 */
const GAME_BY_TITLE = `
  SELECT ${GAME_COLS} FROM games
   WHERE title = ? COLLATE NOCASE
   ORDER BY local_started DESC, trophy_count DESC
   LIMIT 1`;

const TROPHY_COLS = `trophy_id, name, detail, type, icon_url, hidden,
         earned_rate, points, local_earned`;

const trophiesSql = (order, grouped, flags = true) => `
  SELECT ${TROPHY_COLS}${grouped ? ', group_id' : ''}${
    flags ? ', unobtainable, unobtainable_note' : ''
  }
    FROM trophies t
   WHERE t.np_comm_id = ?
   ORDER BY ${grouped ? "CASE WHEN t.group_id IS NULL OR t.group_id = 'default' THEN '' ELSE t.group_id END ASC, " : ''}${order}`;

const GROUPS = `
  SELECT group_id, name, icon_url
    FROM trophy_groups
   WHERE np_comm_id = ?
   ORDER BY CASE WHEN group_id = 'default' THEN '' ELSE group_id END ASC`;

/**
 * Everybody here who owns it, finished or not.
 *
 * ALL OF THEM, not a top ten. On Elden Ring this is thirty rows and a leader
 * board in miniature; on some Vita visual novel it is two rows, and THAT is the
 * version worth having — "only me and Chez own this" is the sentence this panel
 * exists to produce, and a top-ten cut would render it identically to a game
 * nobody has heard of. Sixty-four rows is a smaller read than the board page.
 *
 * `rank IS NOT NULL` keeps members who have never finished a scan out of it,
 * matching every other list on the site.
 */
const OWNERS = `
  SELECT m.psn_online_id, m.avatar_url, m.rank, m.completion,
         mg.progress, mg.points, mg.earned_total, mg.earned_platinum,
         mg.earned_gold, mg.earned_silver, mg.earned_bronze,
         mg.last_played_at, mg.last_earned_at
    FROM member_games mg
    JOIN members m ON m.psn_account_id = mg.psn_account_id
   WHERE mg.np_comm_id = ?
     AND m.rank IS NOT NULL
   ORDER BY mg.progress DESC, mg.points DESC, m.rank ASC`;

/**
 * WHOSE trophies to light up.
 *
 * There is no login until Phase 4, so the page cannot know who is reading it —
 * but it very often knows whose page you came from. A link out of a hunter's
 * library carries `?as=<their id>`, and this one extra row turns the trophy
 * list from a catalogue into somebody's actual progress through the game.
 *
 * `earned_ids` is already stored on every scanned row: a JSON array of trophy
 * ids. Nothing new is fetched and nothing is computed — the bot decided what
 * they earned, this reads it back.
 */
const VIEWER = `
  SELECT m.psn_online_id, m.avatar_url, mg.earned_ids, mg.progress, mg.points
    FROM member_games mg
    JOIN members m ON m.psn_account_id = mg.psn_account_id
   WHERE m.psn_online_id = ? COLLATE NOCASE
     AND mg.np_comm_id = ?
   LIMIT 1`;

/**
 * Sony's own rarity bands, not ones we invented.
 *
 * Every PlayStation owner has seen these five words attached to these five
 * ranges since 2018. Making up our own thresholds would put "Rare" on a trophy
 * the console calls Common, and the console is the thing people believe.
 */
const BANDS = [
  [5, 'Ultra rare', 'ur'],
  [10, 'Very rare', 'vr'],
  [20, 'Rare', 'r'],
  [50, 'Uncommon', 'u'],
  [Infinity, 'Common', 'c'],
];

function band(rate) {
  const v = Number(rate);
  if (!Number.isFinite(v) || v <= 0) return null;
  return BANDS.find(([max]) => v <= max);
}

const METALS = { platinum: 'p', gold: 'g', silver: 's', bronze: 'b' };

/** "12 Feb 2026". */
const on = (ms) =>
  Number(ms)
    ? new Date(Number(ms)).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    : '';

/**
 * Their earned trophy ids, as a Set.
 *
 * Defensive because `earned_ids` is a text column holding JSON written by a
 * different process. A row that predates the field, or one truncated by a
 * failed write, must render the page WITHOUT the highlight rather than fail —
 * a decoration is never worth a 500.
 */
function earnedSet(raw) {
  if (!raw) return null;
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? new Set(ids.map(Number)) : null;
  } catch {
    return null;
  }
}

/**
 * The clock, matching the hunter page exactly.
 *
 * Copied rather than shared because the two pages want different wrappers
 * around it and the shared version would grow a flag argument within a week.
 * If the marks ever change they change in shared/closing.mjs, which both read.
 */
function clockBlock(g, trophies = []) {
  const state = closingState(g);
  if (state === 'closing') {
    const soon = isUrgent(g.closes_at);
    // ONE TEXT NODE, not two. The mark and the sentence are the flex items; if
    // the <b> is a third, "closes in 21 days" becomes its own column on a phone
    // and wraps three words tall beside a paragraph that does not.
    return `<p class="warn clock${soon ? ' soon' : ''}">
      <span class="mk">${soon ? '&#8987;' : '&#128338;'}</span>
      <span><b>${esc(closingLabel(g.closes_at))}.</b> Everything in it is still earnable
        until then.${g.unobtainable_note ? ` ${esc(g.unobtainable_note)}` : ''}</span></p>`;
  }
  if (state === 'dead') {
    /**
     * "SOME" IS A LIE ON A GAME THAT IS WHOLLY GONE.
     *
     * XDefiant is entirely online, its servers closed in June 2025, and this
     * banner told people some of it still worked. JFL__Leon put the row and the
     * page side by side and the page was the weaker of the two, which is the
     * wrong way round: clicking in should make a dead game look MORE dead.
     *
     * The count is taken from the rows already in hand, so it costs nothing and
     * cannot disagree with the list underneath it.
     */
    const dead = trophies.filter((t) => Number(t.unobtainable) === 1).length;
    const total = trophies.length;
    const whole = total > 0 && dead === total;

    return `<p class="warn dead${whole ? ' whole' : ''}">
      <span class="mk">&#9888;</span>
      <span><b>${
        whole
          ? 'Nothing here can be earned any more.'
          : 'Some trophies here can no longer be earned.'
      }</b> ${esc(
        g.unobtainable_note || 'A moderator flagged this game as no longer completable.',
      )}</span></p>`;
  }
  return '';
}

/**
 * One trophy, as a card.
 *
 * A TABLE BECAME CARDS, and that is not decoration. The console draws a trophy
 * as a wide card with a slight lean and a hairline of dark between each one,
 * and everybody on this server has scrolled thousands of them on a DualSense.
 * The same information in a table is correct and reads like a spreadsheet.
 *
 * SECRET TROPHIES ARE BLURRED, NOT WITHHELD. The name and the description are
 * in the HTML — same as PSNProfiles, and the same as any page with a reveal
 * button, because a reveal that costs a round trip is a reveal nobody clicks.
 * What the blur buys is that you cannot be spoiled BY ACCIDENT while scrolling
 * a game you have not played, which is the entire risk. Somebody determined to
 * read it through the blur has, by definition, decided to.
 */
function trophyCard(t, { localTotal, earned, live }) {
  const b = band(t.earned_rate);
  const metal = METALS[String(t.type)] || 'b';
  const secret = Number(t.hidden) === 1;
  const here = Number(t.local_earned) || 0;
  const got = earned ? earned.has(Number(t.trophy_id)) : false;

  /**
   * A DEAD TROPHY IS MARKED, AND ITS POINTS ARE LEFT ALONE.
   *
   * The card keeps showing what it pays, because people who earned it before it
   * broke still hold those points and always will — "we cant take points away
   * from people for earning something that no longer achievable". The warning
   * is for whoever comes next, and it is on the trophy rather than buried in a
   * note on the game, because the game note cannot tell you WHICH one to skip.
   */
  const dead = Number(t.unobtainable) === 1;

  /**
   * EARNED IN FRONT OF AN AUDIENCE.
   *
   * Purple, which on this site means nothing else and on Twitch means exactly
   * one thing. It is the only mark on a trophy card that is about a moment
   * rather than about the trophy: the rarity, the points and the count are all
   * facts about the game, and this is a fact about the night somebody got it.
   */
  const onAir = live?.get(Number(t.trophy_id)) ?? null;

  return `<li class="tc m-${metal}${secret ? ' secret' : ''}${got ? ' got' : ''}${
    dead ? ' dead' : ''
  }${onAir ? ' onair' : ''}">
    <span class="tcin">
      ${
        t.icon_url
          ? `<img class="tic" src="${esc(t.icon_url)}" alt="" loading="lazy" width="52" height="52">`
          : `<span class="tic cup ${metal}">${trophyGlyph()}</span>`
      }
      <span class="tcb">
        <span class="spoil">
          <span class="tname">${esc(t.name || 'Unnamed trophy')}</span>
          ${t.detail ? `<span class="tdet">${esc(t.detail)}</span>` : ''}
        </span>
        ${secret ? '<span class="secretmark">Secret</span>' : ''}
        ${
          /**
           * THE NAME CAME OFF. It read "EARNED LIVE BY JFL__LEON" and Martin
           * cut it: on a page already filtered to one hunter it says something
           * the reader knows, in the widest possible way, on every card it
           * touches. The name survives in the tooltip for the case where it is
           * genuinely news, which is somebody browsing the game cold.
           */
          onAir
            ? `<span class="livemark" title="${esc(
                `${onAir.who ?? 'Somebody here'} earned this live on stream`,
              )}">&#9679; Live</span>`
            : ''
        }
        ${
          dead
            ? `<span class="deadmark" title="${esc(
                t.unobtainable_note || 'This trophy can no longer be earned.',
              )}">&#9888; ${esc(t.unobtainable_note || 'No longer earnable')}</span>`
            : ''
        }
      </span>
      <span class="tcr">
        <span class="rare">${
          b
            ? `<span class="rb ${b[2]}">${pct(t.earned_rate)}</span><span class="rl">${esc(
                b[1],
              )}</span>`
            : '<span class="rb none">&mdash;</span><span class="rl">Not published</span>'
        }</span>
        <span class="local">${n(here)} <span class="of-max">/ ${n(localTotal)}</span>${
          // The word only earns its line at the two ends. "93% of us" was noise
          // beside a fraction that already said it; "nobody here" is a fact
          // about people you know and is the reason to open the game.
          here === 0
            ? '<span class="lcap">nobody here</span>'
            : here === 1
              ? '<span class="lcap">one of us</span>'
              : ''
        }</span>
        <span class="tpts">${n(t.points)}</span>
      </span>
    </span>
  </li>`;
}

/**
 * What this game is worth TO ONE MEMBER, rather than what it is worth.
 *
 * `member_games.points` is the rarity sum — the same figure for any two people
 * holding the same trophies, because rarity is shared. What lands in somebody's
 * score is that multiplied by their completion, once, at the member total. So
 * printing the stored number under a column headed "Points" was answering a
 * question nobody asked: Nurse_Feel_Good at 85.27% and Hawkeyejojon at 73.95%
 * both read 41,181 on Sea of Thieves, and neither of them banks that.
 *
 * THIS DOES NOT BREAK THE ONE RULE. The site still computes no scoring — this
 * is a product of two stored numbers through the same `applyCompletion()` the
 * bot uses, which is the same class of thing as "worth finishing" being a
 * subtraction of two stored numbers. If it ever disagrees with Discord it is
 * still a bug in the site.
 *
 * It will not add up to the card exactly. Flooring per game and summing drifts
 * a point or so per game against flooring the total once. `members.points` is
 * the truth; these are what each game contributes to it.
 */
const banked = (raw, completion) => displayBanked(raw, completion);

/** One member who owns it. */
function ownerRow(o, id, viewing) {
  const width = Math.max(0, Math.min(100, Number(o.progress) || 0));
  const done = width === 100;
  const shade = barShade(o);
  const isViewing = viewing && viewing.toLowerCase() === String(o.psn_online_id).toLowerCase();

  return `<tr class="sh-${shade}">
    <td class="gi">${
      o.avatar_url
        ? `<img class="av" src="${esc(o.avatar_url)}" alt="" loading="lazy" width="34" height="34">`
        : '<span class="av"></span>'
    }</td>
    <td class="gt"><a class="who" href="/hunter/${encodeURIComponent(
      o.psn_online_id,
    )}">${esc(o.psn_online_id)}</a>
      <span class="meta">${miniCups(
        o.earned_platinum, o.earned_gold, o.earned_silver, o.earned_bronze,
      )}${
        // The date only means something once they have stopped: mid-grind it is
        // "when they last got one", which is already the trophy count's job.
        done && o.last_earned_at ? ` &middot; finished ${esc(on(o.last_earned_at))}` : ''
      }</span>
    </td>
    <td class="num prog" data-v="${width}">
      <span class="${done ? 'done' : ''}">${width}%</span>
      <span class="track"><span class="fill ${shade}" style="width:${width}%"></span></span>
    </td>
    <td class="num pts" data-v="${banked(o.points, o.completion)}"${
      // The explainer and the multiplier appear and disappear together. A row
      // showing the raw figure must not carry a note claiming it was scaled.
      hasCompletion(o.completion)
        ? ` title="${esc(`${n(o.points)} rarity points \u00d7 ${pct(o.completion)} completion`)}"`
        : ''
    }>${n(banked(o.points, o.completion))}</td>
    <td class="num"><a class="vchip${isViewing ? ' on' : ''}" href="${esc(
      isViewing ? gameHref(id) : gameHref(id, o.psn_online_id),
    )}">${isViewing ? 'Viewing' : 'View'}</a></td>
    <td class="bar"></td>
  </tr>`;
}

export async function onRequestGet({ params, env, request }) {
  const id = decodeURIComponent(params.id || '');
  const url = new URL(request.url);
  const sort = SORTS[url.searchParams.get('sort')] ? url.searchParams.get('sort') : DEFAULT_SORT;
  const as = String(url.searchParams.get('as') || '').trim().slice(0, 40);
  /**
   * The other hunter, for the trophy level half of head to head.
   *
   * Only meaningful ALONGSIDE `as`: a rival with nobody to be a rival to is a
   * comparison with one side in it. It costs one row, because `earned_ids` on
   * member_games is already the complete set of what somebody holds in a game
   * and the trophy list is loaded either way.
   */
  const vsName = as ? String(url.searchParams.get('vs') || '').trim().slice(0, 40) : '';

  const g =
    (await env.DB.prepare(GAME).bind(id).first()) ||
    (await env.DB.prepare(GAME_BY_TITLE).bind(id).first());

  if (!g) {
    return html(
      page({
        title: 'Not found',
        here: 'games',
        body: `${crumb('/games', 'All games')}
               <div class="tablewrap"><p class="empty">
                 No game called <b>${esc(id)}</b> is in the index.<br>
                 Games arrive here when somebody who owns one runs an update.<br>
                 <a href="/games">Browse the index</a>
               </p></div>`,
      }),
      { status: 404, maxAge: 60 },
    );
  }

  /**
   * A SEATBELT, and it is here because this exact failure took the site down
   * once already.
   *
   * `group_id` and `trophy_groups` arrive in migrations/012. If the code ships
   * before the migration runs, SQLite rejects the WHOLE query for the unknown
   * column and every game page 500s — which is what happened with `closes_at`.
   * Falling back to the ungrouped query turns "site down" into "DLC sections
   * missing until the migration runs", which is a difference worth five lines.
   *
   * Delete this once 012 is applied everywhere it needs to be.
   */
  let trophies = [];
  let groups = [];
  let grouped = true;

  /**
   * THREE TIERS, NOT TWO, and the reason is migration 015.
   *
   * The original seatbelt was try-grouped / catch-plain. Adding the trophy flag
   * columns to the same query would have meant that a database missing 015 fell
   * all the way back to the plain query and silently lost DLC folders too —
   * punishing one un-run migration by turning off a feature that had nothing to
   * do with it. So each optional migration gets its own rung.
   */
  const attempts = [
    [true, true],   // 012 and 015 both applied
    [true, false],  // 012 only
    [false, false], // neither
  ];
  for (const [wantGroups, wantFlags] of attempts) {
    try {
      const [t, gr] = await Promise.all([
        env.DB.prepare(trophiesSql(SORTS[sort].sql, wantGroups, wantFlags)).bind(g.np_comm_id).all(),
        wantGroups
          ? env.DB.prepare(GROUPS).bind(g.np_comm_id).all()
          : Promise.resolve({ results: [] }),
      ]);
      trophies = t.results ?? [];
      groups = gr.results ?? [];
      grouped = wantGroups;
      break;
    } catch {
      grouped = false;
      groups = [];
    }
  }

  const [{ results: owners = [] }, viewer, rival, { results: onStream = [] }] = await Promise.all([
    env.DB.prepare(OWNERS).bind(g.np_comm_id).all(),
    as ? env.DB.prepare(VIEWER).bind(as, g.np_comm_id).first() : Promise.resolve(null),
    vsName ? env.DB.prepare(VIEWER).bind(vsName, g.np_comm_id).first() : Promise.resolve(null),
    /**
     * Wrapped, because `on_stream` arrives in migration 024 and a game page
     * must not go down on a database that has not run it. Same seatbelt as the
     * flags and the live strip: one un-run migration costs one detail, never a
     * page.
     */
    env.DB.prepare(ON_STREAM).bind(g.np_comm_id).all().catch(() => ({ results: [] })),
  ]);

  const live = new Map(onStream.map((r) => [Number(r.trophy_id), r]));

  const earned = viewer ? earnedSet(viewer.earned_ids) : null;
  const theirs = rival ? earnedSet(rival.earned_ids) : null;
  /**
   * Comparing somebody against themselves is refused the same way it is on the
   * hunter page, and for the same reason: four sections, three of them empty.
   */
  const comparing =
    !!earned && !!theirs &&
    String(rival.psn_online_id).toLowerCase() !== String(viewer.psn_online_id).toLowerCase();

  // The cabinet, counted from the rows already in hand rather than by asking
  // the database for four more numbers it would have to scan for anyway.
  const cabinet = { platinum: 0, gold: 0, silver: 0, bronze: 0 };
  let secrets = 0;
  for (const t of trophies) {
    if (cabinet[t.type] !== undefined) cabinet[t.type] += 1;
    if (Number(t.hidden) === 1) secrets += 1;
  }

  /**
   * The denominator on the local column.
   *
   * `owners.length`, NOT `g.local_started`. The stored count includes members
   * whose rank is null — anybody mid-first-scan — and the panel below does not
   * list them, so using the stored figure would print "3 / 12" above a list of
   * eleven people and look like a bug, because it would be one.
   */
  const here = owners.length;
  const finished = owners.filter((o) => Number(o.progress) === 100).length;
  const started = owners.filter((o) => Number(o.earned_total) > 0).length;

  /**
   * The DLC split.
   *
   * Only when there is genuinely more than one group. A game with everything in
   * "default" must render exactly as it did before — a heading saying "Base
   * game" above the only list on the page is a label for a distinction that
   * does not exist.
   */
  const byGroup = new Map();
  if (grouped) {
    for (const t of trophies) {
      const key = t.group_id || 'default';
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(t);
    }
  }
  const hasPacks = grouped && byGroup.size > 1;
  const groupName = new Map(groups.map((r) => [r.group_id, r]));

  const href = (extra = {}) => {
    const q = new URLSearchParams();
    if ((extra.sort ?? sort) !== DEFAULT_SORT) q.set('sort', extra.sort ?? sort);
    if (extra.as ?? as) q.set('as', extra.as ?? as);
    const s = q.toString();
    return `/game/${encodeURIComponent(g.np_comm_id)}${s ? `?${s}` : ''}`;
  };

  const tabs = Object.entries(SORTS)
    .map(
      ([key, s]) =>
        `<a class="tab${key === sort ? ' on' : ''}" href="${esc(
          href({ sort: key }),
        )}">${esc(s.label)}</a>`,
    )
    .join('');

  /**
   * The sort tabs and the reveal, on ONE line.
   *
   * They were two rows, and the second row held a single control — which read
   * as a second, unrelated toolbar and pushed the trophy list further down the
   * page for no gain. The reveal is not a sort, so it keeps a filled background
   * the tabs do not have and sits at the far end of the row rather than
   * pretending to be a fourth option.
   *
   * THE CHECKBOX STAYS OUTSIDE, immediately before this row. The reveal is a
   * sibling selector — `:checked ~ .tlist` — and a sibling combinator only
   * reaches elements with the same parent. Inside the row it could style the
   * label beside it and nothing else: the blur would never lift, and every test
   * that asserted on the CSS would still pass.
   */
  const toolRow = secrets
    ? `<input type="checkbox" id="spoilers" class="spoilbox">
       <div class="tabs">${tabs}<label for="spoilers" class="spoillabel"
         >Reveal ${n(secrets)} secret ${secrets === 1 ? 'trophy' : 'trophies'}</label></div>`
    : `<div class="tabs">${tabs}</div>`;

  /**
   * A header, because the table had one and the cards do not. "28 / 30" with
   * nothing above it is a riddle; three words once, at the top, answer it for
   * the whole page. It sits above the FIRST list only — repeating it over every
   * DLC pack would be labelling the same three columns eight times.
   */
  const HEAD =
    '<div class="tlhead"><span class="h-rare">PSN</span>' +
    '<span class="h-local">Hunters</span><span class="h-pts">Points</span></div>';

  const list = (rows) =>
    `<ol class="tlist${earned ? ' viewing' : ''}">${rows
      .map((t) => trophyCard(t, { localTotal: here, earned, live }))
      .join('')}</ol>`;

  /**
   * HEAD TO HEAD, PER TROPHY.
   *
   * NOT A GRID, and that was the whole design decision. The obvious build is
   * PSNProfiles' table: every trophy, a column each, ticks all the way down.
   * Martin: "it also doesnt have to be that layout if there is a cheaper way
   * that matches our site and not someone elses". A grid makes the reader scan
   * forty rows to find the four that differ. Splitting the list puts those four
   * at the top and folds the rest away, which is the same shape as the panel on
   * the hunter page: the section heading IS the answer.
   *
   * NO DATES, deliberately. `member_trophies` only holds what the scan saw as
   * new, capped to ninety days for a game it meets for the first time, so a
   * trophy earned in 2018 has no row and a date column would be blank almost
   * everywhere. `earned_ids` on member_games is complete, which is why this
   * costs one row per hunter and says has or has not rather than when.
   */
  const splitBlock = () => {
    const mineName = esc(viewer.psn_online_id);
    const themName = esc(rival.psn_online_id);
    const has = (set, t) => set.has(Number(t.trophy_id));

    const onlyThem = trophies.filter((t) => has(theirs, t) && !has(earned, t));
    const onlyMine = trophies.filter((t) => has(earned, t) && !has(theirs, t));
    const both = trophies.filter((t) => has(earned, t) && has(theirs, t));
    const neither = trophies.filter((t) => !has(earned, t) && !has(theirs, t));

    const cards = (rows, cls) =>
      `<ol class="tlist viewing ${cls}">${rows
        .map((t) => trophyCard(t, { localTotal: here, earned, live }))
        .join('')}</ol>`;

    const fold = (rows, label) =>
      rows.length
        ? `<details class="vsfold"><summary>${esc(label)}</summary>${cards(rows, '')}</details>`
        : '';

    return `<div class="vsplit">
      <h3 class="them">Only ${themName}<span class="c">${n(onlyThem.length)}</span></h3>
      ${
        onlyThem.length
          ? `<p class="why">What ${mineName} would have to go and get.</p>
             ${cards(onlyThem, 'them')}`
          : `<p class="vsempty">Nothing. ${mineName} has everything ${themName} has.</p>`
      }

      <h3 class="mine">Only ${mineName}<span class="c">${n(onlyMine.length)}</span></h3>
      ${
        onlyMine.length
          ? cards(onlyMine, 'mine')
          : `<p class="vsempty">Nothing. ${themName} has everything ${mineName} has.</p>`
      }

      ${fold(both, `Both of you: ${both.length}`)}
      ${fold(neither, `Neither of you: ${neither.length}`)}
    </div>`;
  };

  const trophyBlock = !trophies.length
    ? `<div class="tablewrap"><p class="empty">
         No trophy list for this game yet. It arrives the next time somebody
         who owns it runs a deep scan.
       </p></div>`
    : comparing
      ? splitBlock()
      : hasPacks
      ? HEAD +
        [...byGroup.entries()]
          .map(([key, rows]) => {
            const meta = groupName.get(key);
            const base = key === 'default';

            /**
             * "DLC 1", never "Pack 1".
             *
             * PSN's own name is what the console shows and what people call it
             * in Discord — "Expansion Pack 4", "The Doomsday Heist" — so it
             * wins whenever it has been fetched. The fallback only matters
             * until the naming job reaches a game, and between two words that
             * both mean "an add-on", DLC is the one every PlayStation owner
             * already uses. The number is the group id with its zero padding
             * removed, so '004' reads as 4.
             */
            const label = base
              ? 'Base game'
              : meta?.name || `DLC ${String(key).replace(/^0+/, '') || key}`;

            const done = earned ? rows.filter((t) => earned.has(Number(t.trophy_id))).length : 0;
            const complete = Boolean(earned) && done === rows.length && rows.length > 0;

            // Points on the shut folder, because "is this pack worth an evening"
            // is the question, and a trophy count has never answered it.
            const worth = rows.reduce((sum, t) => sum + (Number(t.points) || 0), 0);

            const meta2 = earned
              ? `<b>${n(done)}</b> of ${n(rows.length)}${
                  complete ? ' &middot; <span class="tick">&#10003;</span> done' : ''
                }`
              : `${n(rows.length)} ${rows.length === 1 ? 'trophy' : 'trophies'} &middot; <b>${n(
                  worth,
                )}</b> points`;

            return `<details class="pack${complete ? ' done' : ''}"${base ? ' open' : ''}>
              <summary class="tgroup">
                <span class="caret" aria-hidden="true">&#9654;</span>${
                  meta?.icon_url
                    ? `<img src="${esc(meta.icon_url)}" alt="" loading="lazy" width="26" height="26">`
                    : ''
                }<span class="gname">${esc(label)}</span>
                <span class="gmeta">${meta2}</span>
              </summary>${list(rows)}
            </details>`;
          })
          .join('')
      : HEAD + list(trophies);

  const body = `
    ${
      // Back to where you came from, at the TOP. If a hunter's view is being
      // shown then their page is where you came from and saying so is better
      // than a generic link to the index.
      as && viewer
        ? crumb(`/hunter/${encodeURIComponent(viewer.psn_online_id)}`, `${viewer.psn_online_id}'s games`)
        : crumb('/games', 'All games')
    }

    <section class="ghero">
      ${
        g.icon_url
          ? `<img class="bigico" src="${esc(g.icon_url)}" alt="" width="96" height="96">`
          : '<span class="bigico"></span>'
      }
      <div class="gh">
        <h1>${g.platform ? `<span class="plat-chip">${esc(g.platform)}</span>` : ''}${esc(
          g.title,
        )}</h1>
        <p class="sub">
          <b>${n(g.max_points)}</b> points for a full completion
          ${
            // A guess, said out loud. PSN publishes no rarity for some games,
            // usually brand new ones, and the bot prices those from the trophy
            // mix alone. Printing that number without a word beside it is how a
            // site loses the argument about its own scoring.
            Number(g.estimated) === 1
              ? '<span class="est" title="PSN has published no rarity for this game yet">estimated</span>'
              : ''
          }
        </p>
      </div>
    </section>

    ${clockBlock(g, trophies)}

    <div class="cups">
      ${cup('p', cabinet.platinum, 'Platinum')}
      ${cup('g', cabinet.gold, 'Gold')}
      ${cup('s', cabinet.silver, 'Silver')}
      ${cup('b', cabinet.bronze, 'Bronze')}
      <dl class="facts">
        <div><dt>Trophies</dt><dd>${n(trophies.length || g.trophy_count)}</dd></div>
        <div><dt>Owned here</dt><dd>${n(here)}</dd></div>
        <div><dt>Finished here</dt><dd>${n(finished)}</dd></div>
      </dl>
    </div>

    ${
      viewer
        ? `<div class="viewbar">
             <span class="whochip">${
               viewer.avatar_url
                 ? `<img class="av" src="${esc(viewer.avatar_url)}" alt="" width="24" height="24">`
                 : '<span class="av"></span>'
             }<b>${esc(viewer.psn_online_id)}</b><span class="pc">${
               Number(viewer.progress) || 0
             }%</span><a class="x" href="${esc(href({ as: null }))}"
                 aria-label="Stop showing ${esc(viewer.psn_online_id)}'s trophies"
                 title="Stop showing ${esc(viewer.psn_online_id)}'s trophies">&times;</a></span>
             <span class="why">trophies they have earned are highlighted below</span>
           </div>`
        : as
          ? `<div class="viewbar"><span class="why"><b>${esc(
              as,
            )}</b> does not own this one, so there is nothing to highlight.</span></div>`
          : ''
    }

    ${toolRow}

    ${trophyBlock}

    <section class="panel">
      <h2>Who here has it</h2>
      ${
        owners.length
          ? `<div class="tablewrap">
               <table class="games">
                 <thead><tr>
                   <th class="gi"></th>
                   <th>Hunter</th>
                   <th class="num">Progress</th>
                   <th class="num">Points</th>
                   <th class="num"></th>
                   <th class="bar"></th>
                 </tr></thead>
                 <tbody>${owners
                   .map((o) => ownerRow(o, g.np_comm_id, viewer?.psn_online_id || ''))
                   .join('')}</tbody>
               </table>
             </div>
             <p class="note">${
               finished === here
                 ? 'Everybody here who owns it has finished it.'
                 : `${n(finished)} of ${n(here)} finished it${
                     started > finished ? `, ${n(started - finished)} more have started` : ''
                   }.`
             } <b>View</b> lights up that hunter's trophies in the list above.</p>`
          : `<p class="note">Nobody on the board owns this one yet. It is in the
               index because the dice can reach it.</p>`
      }
    </section>`;

  return html(
    page({
      title: `${g.title} · Kraken`,
      description: `${g.title} is worth ${n(g.max_points)} points. ${
        here ? `${here} on Platinum Intel own it, ${finished} have finished it.` : ''
      }`,
      here: 'games',
      body,
    }),
  );
}
