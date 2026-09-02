import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyOf } from './helpers.mjs';

/**
 * The front page.
 *
 * It is five queries fired together, so the stub answers by looking at the SQL
 * it is handed. The tests that matter are the ones asserting it PRINTS stored
 * numbers rather than working anything out: the contested line in particular is
 * a subtraction of two columns and must never become a scoring decision.
 */
const mod = await import('../functions/index.js');

const TOTALS = { hunters: 64, points: 12809536, platinum: 68060, projects: 25928, completed: 9871 };

const TOP = [
  { rank: 1, prev_rank: 1, psn_online_id: 'coregamer1998', country: 'GB', avatar_url: null,
    points: 847332, completion: 90.18 },
  { rank: 2, prev_rank: 1, psn_online_id: 'RobThanatos', country: null, avatar_url: 'https://x.test/a.png',
    points: 784515, completion: 85.55 },
  { rank: 3, prev_rank: 4, psn_online_id: 'JFL__Leon', country: 'GB', avatar_url: null,
    points: 186406, completion: 87.45 },
];

const CONTESTED = [
  { np_comm_id: 'N1', title: 'Sea of Thieves', platform: 'PS5', local_started: 9,
    platted_here: 3, unobtainable: 0 },
  { np_comm_id: 'N2', title: 'Neverwinter', platform: 'PS4', local_started: 5,
    platted_here: 0, unobtainable: 1 },
];

const FINISHED = [
  { title: 'Bloodborne', np_comm_id: 'N3', psn_online_id: 'JFL__Leon', update_id: 90,
    points_gained: 4200, finished_at: Date.now() - 86400000 },
  { title: 'Sekiro', np_comm_id: 'N4', psn_online_id: 'Ziune', update_id: 88,
    points_gained: 3100, finished_at: Date.now() - 5 * 86400000 },
];

/**
 * A FIRST SCAN, deliberately: one update, three games, all 'new'.
 *
 * This is the shape that breaks a naive feed — a member joining writes a row
 * for every game they own, so "the six newest" becomes one person's library six
 * times. The panel keeps one row per update, and these three exist to prove it.
 */
const STARTED = [
  { title: 'Elden Ring', np_comm_id: 'N5', psn_online_id: 'MRTheChez', update_id: 91,
    points_gained: 26500, finished_at: Date.now() - 3600000 },
  { title: 'Bunny Mahjo', np_comm_id: 'N6', psn_online_id: 'MRTheChez', update_id: 91,
    points_gained: 0, finished_at: Date.now() - 3600000 },
  { title: 'Hollow Knight', np_comm_id: 'N7', psn_online_id: 'MRTheChez', update_id: 91,
    points_gained: 7100, finished_at: Date.now() - 3600000 },
  { title: 'Sifu', np_comm_id: 'N8', psn_online_id: 'Wilko', update_id: 87,
    points_gained: 5400, finished_at: Date.now() - 4 * 86400000 },
];

/**
 * The two feeds share one SQL string and differ only by the bound `kind`, so
 * the stub has to read what was BOUND rather than what was prepared. A stub
 * that only looked at the SQL would hand both panels the same rows and every
 * assertion below would pass over a page showing completions twice.
 */
const fakeEnv = (o = {}) => ({
  DB: {
    prepare(sql) {
      const rows = (kind) => {
        if (sql.includes('COUNT(*)')) return null;
        if (sql.includes('FROM update_changelog')) {
          return kind === 'new' ? (o.started ?? STARTED) : (o.finished ?? FINISHED);
        }
        if (sql.includes('JOIN trophies')) return o.contested ?? CONTESTED;
        // The live strip. Routed explicitly, because falling through to TOP
        // would hand it rows with no twitch_login on them and the strip would
        // render nonsense while every assertion still passed.
        if (sql.includes('live_since IS NOT NULL')) return o.live ?? [];
        if (sql.includes('live_since IS NULL')) return o.channels ?? [];
        return o.top ?? TOP;
      };
      const answer = (kind) => ({
        first: async () => o.totals ?? TOTALS,
        all: async () => ({ results: rows(kind) ?? [] }),
      });
      return { ...answer(), bind: (kind) => answer(kind) };
    },
  },
});


const render = async (o) => {
  const res = await mod.onRequestGet({ env: fakeEnv(o) });
  return { res, out: await res.text() };
};

test('the front page leads with what this is and where to go', async () => {
  const { res, out } = await render();
  assert.equal(res.status, 200);

  assert.ok(out.includes('Platinum Intel'), 'names the server');
  assert.ok(out.includes('href="/leaderboard"'), 'sends you to the board');
  assert.ok(out.includes('discord.com/invite/gdSqDYrXaH'), 'and to Discord');

  // No top bar here. The front page carries the same four links as buttons in
  // the middle, and drawing the header too would be the navigation twice on one
  // screen.
  assert.ok(!out.includes('<header class="top">'), 'no header on the door');
  assert.ok(out.includes('class="doornav"'), 'buttons instead');
  assert.ok(out.includes('class="doormark"'), 'and the mark, big');

  // All four routes appear, built or not, so a page can never exist in one
  // navigation and be missing from the other.
  for (const label of ['Leaderboards', 'Games', 'Contested', 'Discord']) {
    assert.ok(out.includes(`>${label}<`), `${label} missing from the door`);
  }
  // Every route in NAV is a door now — Contested was the last label and it
  // shipped. Nothing in the navigation is allowed to be decoration: a link that
  // does nothing teaches people not to click the header.
  assert.ok(out.includes('href="/games"'), 'the index is reachable from the door');
  assert.ok(out.includes('href="/contested"'), 'and so is the contested board');
  assert.ok(!out.includes('class="soon"'), 'no coming-soon labels left in the navigation');
});

test('the panels are still under the door', async () => {
  // The door is judged on the first visit; the panels are why anybody comes
  // back to the front page rather than straight past it.
  const { out } = await render();
  assert.ok(out.includes('Most contested'));
  assert.ok(out.includes('Completed'), 'named as Discord names it, not "Just finished"');
  assert.ok(out.includes('New projects'));
  assert.ok(out.includes('Leading the board'));
  assert.ok(!bodyOf(out).includes('Newest hunters'), 'that panel is gone');
});

test('a first scan cannot fill the New projects panel', async () => {
  // A member joining writes a "new" row for every game they own — fifteen
  // hundred for the biggest library here. One row per UPDATE means that scan
  // contributes one line, exactly as it does in Discord.
  const { out } = await render();
  const panel = out.slice(out.indexOf('New projects'));
  assert.equal(
    (panel.match(/MRTheChez/g) || []).length,
    2,
    'one line for their whole first scan — the name appears once in it, twice in the row',
  );
  assert.ok(panel.includes('Elden Ring'), 'and it is the most valuable game in that scan');
  assert.ok(!panel.includes('Bunny Mahjo'), 'not the shovelware they also installed');
  assert.ok(panel.includes('Sifu'), 'a different update still gets its own line');
});

test('the two feeds ask for different kinds of event', async () => {
  // Both panels share one SQL string and differ only by the bound value. If the
  // binding is ever dropped they silently become the same list.
  const { out } = await render();
  const done = out.slice(out.indexOf('Completed'), out.indexOf('New projects'));
  assert.ok(done.includes('Bloodborne'), 'completions in the completed panel');
  assert.ok(!done.includes('Elden Ring'), 'and nothing that was merely started');
});

test('the totals are the stored ones, grouped', async () => {
  const { out } = await render();
  assert.ok(out.includes('12,809,536'), 'points');
  assert.ok(out.includes('68,060'), 'platinums');
  assert.ok(out.includes('>64<'), 'hunters');

  // These two are SUMS ACROSS MEMBERS, so the labels must not claim distinct
  // counts. 83,809 games owned between 64 people is true; "83,809 games
  // tracked" was not, when the database holds about 26,000.
  assert.ok(out.includes('Games owned'), 'sum, and labelled as one');
  assert.ok(out.includes('100% completions'), 'completions, not distinct games');
  assert.ok(!out.includes('Games tracked'), 'the misleading label is gone');
  assert.ok(!out.includes('Taken to 100%'));
});

test('the top five link through to their pages, with tiers', async () => {
  const { out } = await render();
  for (const m of TOP) {
    assert.ok(out.includes(`/hunter/${encodeURIComponent(m.psn_online_id)}`), `${m.psn_online_id} link`);
  }
  assert.ok(out.includes('1st') && out.includes('3rd'), 'ordinals');
  assert.ok(out.includes('847,332'), 'points');

  // The tier chip was cut: it squeezed names into "RobTha..." and a truncated
  // name is the one thing in the row you cannot infer from context.
  assert.ok(!out.includes('mini-tier'), 'no tier chip crowding the name');
  assert.ok(out.includes('RobThanatos'), 'names print in full');
});

test('contested never suggests a game nobody can finish', async () => {
  // Asserted on the QUERY, not on the stub's rows: the stub returns whatever it
  // is handed, so checking the output would only prove the fake behaved. The
  // clause is the thing that has to exist.
  let seen = '';
  const env = {
    DB: {
      prepare(sql) {
        if (sql.includes('JOIN trophies')) seen = sql;
        const pick = () => ({
          first: async () => TOTALS,
          all: async () => ({ results: sql.includes('JOIN trophies') ? CONTESTED : [] }),
        });
        return { ...pick(), bind: () => pick() };
      },
    },
  };
  await mod.onRequestGet({ env });
  assert.match(seen, /g\.unobtainable = 0/);
});

test('contested prints two stored numbers and works nothing out', async () => {
  const { out } = await render();
  // 9 own it, 3 have platted it. The page subtracts, and that is the whole of
  // its arithmetic — no multiplier, no re-pricing.
  assert.ok(out.includes('6 of 9 still in it'), 'Sea of Thieves');
  assert.ok(out.includes('5 of 5 still in it'), 'nobody has finished Neverwinter');
  // The flag markup still exists for anywhere else it is needed; the board
  // itself simply never selects a flagged game any more.
});

test('a hostile game title cannot inject markup', async () => {
  const { out } = await render({
    contested: [{ ...CONTESTED[0], title: '<script>alert(1)</script>' }],
  });
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(!out.includes('<script>alert(1)</script>'));
});

test('an empty server renders rather than crashing', async () => {
  const { res, out } = await render({
    totals: { hunters: 0, points: 0, platinum: 0, projects: 0, completed: 0 },
    top: [], contested: [], finished: [], newest: [],
  });
  assert.equal(res.status, 200);
  assert.ok(out.includes('Nobody has finished a scan yet'));
  assert.ok(out.includes('Nothing contested right now'));
});

test('the link previews properly, and the card names nobody', async () => {
  /**
   * Everything else on that page is written for members. This one line is for
   * somebody who followed a link out of a stream, and the unfurl is what they
   * see before the page itself.
   */
  const { out } = await render();
  const body = bodyOf(out);

  /**
   * AND IT NAMES NOBODY. A line about one member was added here and removed
   * within the hour. Whose name is on the front of a website is that person's
   * call, and nobody had asked him.
   */
  assert.ok(!body.includes('class="headline"'), 'no pitch line about a member');
  assert.ok(!/in the world on/.test(out), 'and no claim about anybody in the unfurl either');

  // The card. og:image MUST be absolute or the unfurler has nothing to resolve
  // it against and shows a blank space where the picture goes.
  assert.match(out, /<meta property="og:image" content="https:\/\/platinumintel\.co\.uk\/og\.png">/);
  assert.match(out, /<meta name="twitter:card" content="summary_large_image">/, 'the wide card');
  assert.match(out, /<meta property="og:description" content="[^"]+hunters[^"]+"/, 'with real counts');
  assert.ok(!/content="\/og\.png"/.test(out), 'never a relative image');
});

const LIVE = [
  { psn_online_id: 'Pelzio', avatar_url: null, twitch_login: 'pelzio', rank: 2, points: 748220,
    live_since: Date.now() - 135 * 60000, live_game: 'Elden Ring', live_viewers: 37,
    live_thumb: 'https://static-cdn.jtvnw.net/x-640x360.jpg', live_mature: 0 },
  { psn_online_id: 'JFL__Leon', avatar_url: 'https://x.test/l.png', twitch_login: 'jfl__leon',
    rank: 5, points: 412880, live_since: Date.now() - 5 * 60000, live_game: null,
    live_viewers: 12, live_thumb: 'https://static-cdn.jtvnw.net/y-640x360.jpg', live_mature: 0 },
];

test('with nobody live, the section names who to expect instead of vanishing', async () => {
  /**
   * A "Live now" heading over nothing is a dead zone, but hiding the whole
   * section means somebody visiting on a quiet Tuesday never learns that people
   * here stream at all. Naming the regulars answers "come back when" without
   * anybody having to write it.
   */
  const channels = [
    { psn_online_id: 'Pelzio', avatar_url: null, twitch_login: 'pelzio' },
    { psn_online_id: 'JFL__Leon', avatar_url: null, twitch_login: 'jfl__leon' },
  ];
  const body = bodyOf((await render({ channels })).out);

  assert.match(body, /class="live off"/, 'the section stays');
  assert.match(body, /Nobody is streaming/);
  assert.match(body, /twitch\.tv\/pelzio/, 'with a way to find them');
  assert.ok(!body.includes('class="lv"'), 'but no cards for streams that are not happening');
});

test('seventy channels do not become seventy pins', async () => {
  /**
   * Martin, looking ahead: "what if 70 streamers sign up and thats 70 pins".
   * Eight names is a line and a half; the rest become a number, and the query
   * reads a few more than it shows so the number can exist at all.
   */
  const many = Array.from({ length: 20 }, (_, i) => ({
    psn_online_id: `hunter${i}`, avatar_url: null, twitch_login: `hunter${i}`,
  }));
  const body = bodyOf((await render({ channels: many })).out);

  const pins = [...body.matchAll(/class="lvwho"[\s\S]*?<\/div>/g)][0][0];
  assert.equal([...pins.matchAll(/twitch\.tv\//g)].length, 8, 'eight names, not twenty');
  assert.match(body, /and 12 more/, 'and the rest are a count');
});

test('and it disappears completely when nobody has connected a channel', async () => {
  // Which is the state of the board until people start running /twitch.
  const body = bodyOf((await render()).out);
  assert.ok(!body.includes('class="live'), 'no empty box');
  assert.ok(!/Live now/.test(body), 'and no heading over nothing');
});

test('a live stream is a card, not a line', async () => {
  /**
   * The first version was a name and a dot, and it read as an afterthought next
   * to the trophy cards. Martin: "kinda lack lust, kinda beneath me, we have
   * done better". Everything asserted here arrives in the same Twitch response
   * the live check already makes, so the card costs no extra requests.
   */
  const body = bodyOf((await render({ live: LIVE })).out);

  assert.match(body, /class="live"/);
  assert.match(body, /<img src="https:\/\/static-cdn\.jtvnw\.net\/x-640x360\.jpg"/,
    'what is actually on their screen');
  assert.match(body, /37 watching/, 'how many are there');
  assert.match(body, /2h 15m/, 'and how long they have been on');
  assert.match(body, /Elden Ring/, 'what they are playing');
  assert.match(body, /href="https:\/\/twitch\.tv\/pelzio"/, 'straight to their channel');
  assert.match(body, /rel="noopener noreferrer"/, 'no window.opener handle back to us');

  // The one thing Twitch could never put on this card.
  assert.match(body, /class="pos">2nd/, 'where they sit on the board');
  assert.match(body, /748,220/);

  // A stream with no game set still renders rather than showing an empty line.
  assert.match(body, /Streaming now/);
});

test('a mature stream keeps its name and loses its picture', async () => {
  /**
   * The thumbnail is a frame of somebody else's broadcast hotlinked onto the
   * front of this site. Twitch's own flag is the only warning available, and
   * the honest answer to it is to print the words without the picture rather
   * than to hide that they are live.
   */
  const body = bodyOf(
    (await render({ live: [{ ...LIVE[0], live_mature: 1 }] })).out,
  );
  assert.ok(!body.includes('<img src="https://static-cdn.jtvnw.net'), 'no still');
  assert.match(body, /class="noshot"/, 'a plain tile in its place');
  assert.match(body, /Pelzio/, 'and they are still shown as live');
});

test('a live answer nobody has confirmed lately is not shown', async () => {
  /**
   * `live_since` on its own would be a lie the moment the five minute cron
   * stopped: a stream that ended while the check was broken would sit on the
   * front page all week. The query only takes rows checked in the last fifteen
   * minutes, and this pins that the bound cutoff is real.
   */
  const src = await (await import('node:fs/promises'))
    .readFile(new URL('../functions/index.js', import.meta.url), 'utf8');
  assert.match(src, /live_checked_at > \?/, 'the freshness cutoff is in the query');
  assert.match(src, /LIVE_STALE_MS = 15 \* 60 \* 1000/);
  assert.match(src, /bind\(Date\.now\(\) - LIVE_STALE_MS\)/, 'and it is what gets bound');
});

test('the strip survives a database that has not run migration 019', async () => {
  // One un-run migration disables one strip, never the front page.
  const env = {
    DB: {
      prepare(sql) {
        const answer = () => ({
          first: async () => ({ hunters: 64, points: 1, platinum: 1, projects: 1, completed: 1 }),
          all: async () => {
            if (sql.includes('live_since IS NOT NULL')) throw new Error('no such column');
            return { results: [] };
          },
        });
        return { ...answer(), bind: () => answer() };
      },
    },
  };
  const res = await mod.onRequestGet({ env });
  assert.equal(res.status, 200);
  const out = await res.text();
  assert.ok(!bodyOf(out).includes('class="live"'));
});
