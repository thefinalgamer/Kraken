import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyOf } from './helpers.mjs';
import { readFile } from 'node:fs/promises';

/**
 * The game page, rendered against fake rows.
 *
 * ASSERT ON THE ELEMENT, NEVER ON THE CLASS. This is the third time that
 * lesson has been paid for on this site: an accent strip shipped with CSS and
 * no element, and every test passed because it checked the row's class name.
 * The stylesheet is INLINED into every page, so `out.includes('spoilbox')` is
 * true whether or not a checkbox was ever rendered. Everything below looks for
 * the tag.
 *
 * The stub reads the SQL it is handed and answers accordingly, so the page has
 * to issue the queries it actually issues or the assertions fail.
 */
const mod = await import('../functions/game/[id].js');

const DAY = 86400000;

const GAME = {
  np_comm_id: 'NPWR07110_00', title: 'Bloodborne', platform: 'PS4',
  icon_url: 'https://x.test/bb.png', trophy_count: 4, has_platinum: 1,
  max_points: 4200, estimated: 0, unobtainable: 0, unobtainable_note: null,
  flagged_at: null, closes_at: null, local_started: 3, refreshed_at: Date.now(),
};

const TROPHIES = [
  { group_id: 'default', trophy_id: 0, name: 'Bloodborne', detail: 'Collect all trophies.', type: 'platinum',
    icon_url: 'https://x.test/p.png', hidden: 0, earned_rate: 4.21, points: 900, local_earned: 1 },
  { group_id: 'default', trophy_id: 1, name: 'Blood Rapture', detail: 'Kill Mergo\'s Wet Nurse.', type: 'gold',
    icon_url: null, hidden: 0, earned_rate: 31.2, points: 300, local_earned: 2 },
  // The secret one. Its name is a plot point, which is the entire feature.
  { group_id: 'default', trophy_id: 2, name: 'Childhood\'s Beginning', detail: 'Became an infant Great One.',
    type: 'gold', icon_url: null, hidden: 1, earned_rate: 12.5, points: 420, local_earned: 0 },
  // No rarity published by PSN.
  { group_id: 'default', trophy_id: 3, name: 'Ill-Omened Nightmare', detail: null, type: 'bronze',
    icon_url: null, hidden: 0, earned_rate: null, points: 15, local_earned: 3 },
];

const OWNERS = [
  { psn_online_id: 'th3finalgamer--', avatar_url: 'https://x.test/a.png', rank: 3,
    progress: 100, points: 4200, earned_total: 4, earned_platinum: 1, earned_gold: 2,
    earned_silver: 0, earned_bronze: 1, last_played_at: Date.now() - DAY,
    last_earned_at: 1739318400000 },
  { psn_online_id: 'JFL__Leon', avatar_url: null, rank: 27,
    progress: 41, points: 900, earned_total: 2, earned_platinum: 0, earned_gold: 1,
    earned_silver: 0, earned_bronze: 1, last_played_at: Date.now() - 9 * DAY,
    last_earned_at: Date.now() - 9 * DAY },
  { psn_online_id: 'Wilko', avatar_url: null, rank: 12,
    progress: 0, points: 0, earned_total: 0, earned_platinum: 0, earned_gold: 0,
    earned_silver: 0, earned_bronze: 0, last_played_at: null, last_earned_at: null },
];

let lastTrophySql = '';

const fakeEnv = ({
  game = GAME, byTitle = null, trophies = TROPHIES, owners = OWNERS,
  groups = [], viewer = null, noGroupColumn = false, noFlagColumn = false,
  onStream = [], noStreamColumn = false,
} = {}) => ({
  DB: {
    prepare(sql) {
      if (sql.includes('FROM trophies')) {
        lastTrophySql = sql;
        // Stands in for D1 rejecting an unknown column before migration 012.
        if (noGroupColumn && sql.includes('group_id')) {
          return { bind: () => ({ all: async () => { throw new Error('no such column: group_id'); } }) };
        }
        // Stands in for D1 rejecting the trophy flag columns before 015. The
        // page must drop to the middle rung of the seatbelt, not the bottom.
        if (noFlagColumn && sql.includes('unobtainable')) {
          return {
            bind: () => ({ all: async () => { throw new Error('no such column: unobtainable'); } }),
          };
        }
        return { bind: () => ({ all: async () => ({ results: trophies }) }) };
      }
      if (sql.includes('FROM member_trophies')) {
        // Stands in for D1 rejecting on_stream before migration 024.
        return {
          bind: () => ({
            all: async () => {
              if (noStreamColumn) throw new Error('no such column: on_stream');
              return { results: onStream };
            },
          }),
        };
      }
      if (sql.includes('FROM trophy_groups')) {
        return { bind: () => ({ all: async () => ({ results: groups }) }) };
      }
      // The viewer lookup and the owners list both read member_games; only the
      // viewer one is filtered by online id.
      if (sql.includes('FROM member_games')) {
        return sql.includes('psn_online_id = ?')
          ? { bind: () => ({ first: async () => viewer }) }
          : { bind: () => ({ all: async () => ({ results: owners }) }) };
      }
      const row = sql.includes('COLLATE NOCASE') ? byTitle : game;
      return { bind: () => ({ first: async () => row, all: async () => ({ results: [] }) }) };
    },
  },
});


const render = async (opts = {}, query = '') => {
  const res = await mod.onRequestGet({
    params: { id: opts.id ?? 'NPWR07110_00' },
    env: fakeEnv(opts),
    request: new Request(`https://kraken.test/game/NPWR07110_00${query}`),
  });
  return { res, out: await res.text() };
};

test('the page renders the game, its trophies and its owners', async () => {
  const { res, out } = await render();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control'), /max-age=300/);

  assert.ok(out.includes('Bloodborne'), 'title');
  assert.ok(out.includes('4,200'), 'max points');
  assert.ok(out.includes('Blood Rapture'), 'a trophy name');
  assert.ok(out.includes('Kill Mergo'), 'a trophy description');
  for (const o of OWNERS) assert.ok(out.includes(o.psn_online_id), `${o.psn_online_id} missing`);
  assert.ok(out.includes('href="/hunter/th3finalgamer--"'), 'owners link to their pages');
});

test('the cabinet counts trophy types from the rows, not from trophy_count', async () => {
  // One platinum, two gold, zero silver, one bronze. The fixture's trophy_count
  // agrees, but the counting must come from the list or a game with a missing
  // trophy row would print a cabinet that does not add up to its own table.
  const { out } = await render();
  const cabinet = out.slice(out.indexOf('class="cups"'), out.indexOf('class="tabs"'));
  assert.match(cabinet, /Platinum">.*?1</s, 'one platinum');
  assert.match(cabinet, /Gold">.*?2</s, 'two gold');
  assert.match(cabinet, /Silver">.*?0</s, 'no silver');
});

test("Sony's rarity bands, and its words", async () => {
  const { out } = await render();
  assert.ok(out.includes('Ultra rare'), '4.21% is ultra rare');
  assert.ok(out.includes('Uncommon'), '31.2% is uncommon');
  assert.ok(out.includes('Rare'), '12.5% is rare');
  assert.ok(out.includes('Not published'), 'a null rate says so rather than printing 0%');
  assert.ok(!out.includes('0.00%'), 'and never prints it as zero percent');
});

test('the local column counts people here, not percentages of the world', async () => {
  const { out } = await render();
  // Three owners in the fixture, so the denominator is three every time.
  assert.ok(out.includes('/ 3</span>'), 'denominator is the number of owners listed');
  assert.ok(out.includes('nobody here'), 'a trophy nobody here has says so');
  assert.ok(out.includes('one of us'), 'and one person is named as one person');
});

test('the denominator is the owners listed, not the stored local_started', async () => {
  // local_started counts members mid-first-scan too, and those are not in the
  // panel below. Printing "1 / 3" above a list of two people is a bug that
  // looks exactly like a bug.
  const { out } = await render({ owners: OWNERS.slice(0, 2) });
  assert.ok(out.includes('/ 2</span>'), 'two owners listed means a denominator of two');
  assert.ok(!out.includes('/ 3</span>'), 'the stored 3 is not used');
});

test('a secret trophy is blurred behind a real checkbox', async () => {
  const { out } = await render();

  // THE ELEMENT, not the class. The stylesheet is inlined, so searching for
  // "spoilbox" alone would pass on a page with no checkbox on it at all.
  assert.match(out, /<input type="checkbox" id="spoilers" class="spoilbox">/, 'the input exists');
  assert.match(out, /<label for="spoilers"/, 'and its label');
  assert.ok(out.includes('Reveal 1 secret trophy'), 'singular, and counted');

  // The blurred row must carry the class the stylesheet blurs, AND the text
  // must be inside the element that gets blurred.
  assert.match(out, /class="tc m-g secret"/, 'the secret card is marked');
  assert.match(
    out,
    /<span class="spoil">[\s\S]{0,200}Childhood/,
    'the secret name is inside the blurred span',
  );
});

test('the checkbox is a sibling of the list, or the reveal does nothing', async () => {
  // `:checked ~ .tlist` only reaches siblings. The label now lives INSIDE the
  // tab row, so the input must stay outside it — nested, it could style the
  // label beside it and nothing else, the blur would never lift, and every
  // other assertion in this file would still pass.
  const { out } = await render();
  const input = out.indexOf('class="spoilbox"');
  const tabs = out.indexOf('class="tabs"');
  const list = out.indexOf('class="tlist', input);

  assert.ok(input > -1, 'the input is rendered');
  assert.ok(tabs > input, 'the input comes before the tab row');
  assert.ok(list > input, 'and before the list it unblurs');
  assert.ok(
    !out.slice(tabs, list).includes('class="spoilbox"'),
    'the input is not nested inside the tab row',
  );
  // The label is in the tab row with the sorts, not on a second line of its own.
  assert.match(out.slice(tabs, list), /class="spoillabel"/, 'the label rides with the tabs');
});

test('there is no Rarest-on-PSN sort any more', async () => {
  // It agreed with "Rarest here" nearly always on a 64-member server, so it was
  // a decision to make for no reason. The world percentage is still on the card.
  const { out } = await render();
  assert.ok(!out.includes('Rarest on PSN'), 'the tab is gone');
  assert.ok(out.includes('Rarest here') && out.includes('Most points'), 'the useful two stay');
  assert.ok(out.includes('Ultra rare'), 'and the world rarity is still shown');
});

test('no secrets means no toggle', async () => {
  const { out } = await render({ trophies: TROPHIES.filter((t) => !t.hidden) });
  assert.ok(!out.includes('<input type="checkbox"'), 'no control for nothing to reveal');
});

test('the sort whitelist is a whitelist', async () => {
  await render({}, '?sort=here');
  assert.match(lastTrophySql, /t\.local_earned ASC/);

  // A sort that was REMOVED must fall back, not resurrect itself.
  await render({}, '?sort=world');
  assert.ok(!lastTrophySql.includes('t.earned_rate ASC, t.trophy_id ASC'));

  // Anything not in the list falls back to PSN order rather than reaching SQL.
  await render({}, '?sort=; DROP TABLE trophies--');
  assert.match(lastTrophySql, /t\.trophy_id ASC/);
  assert.ok(!lastTrophySql.includes('DROP TABLE'));
});

test('a game with a deadline says so above the trophy list', async () => {
  const { out } = await render({
    game: { ...GAME, closes_at: Date.now() + 12 * DAY, unobtainable_note: 'Servers close in May' },
  });
  const warn = out.indexOf('class="warn');
  const table = out.indexOf('<ol class="tlist');
  assert.ok(warn > -1 && warn < table, 'the deadline is above the list, not below it');
  assert.ok(out.includes('Servers close in May'), 'the note a mod typed is shown');
});

test('a dead game gets the warning, not the clock', async () => {
  const { out } = await render({ game: { ...GAME, unobtainable: 1, unobtainable_note: 'MP closed' } });
  assert.ok(out.includes('warn dead'), 'the dead treatment');
  assert.ok(out.includes('&#9888;'), 'the triangle');
  assert.ok(!out.includes('&#8987;'), 'and not the hourglass');
});

test('an estimated game admits it', async () => {
  const { out } = await render({ game: { ...GAME, estimated: 1 } });
  assert.ok(out.includes('estimated'), 'the word is on the page');
});

test('a title in the URL falls back to a title lookup', async () => {
  const { out } = await render({ id: 'Bloodborne', game: null, byTitle: GAME });
  assert.ok(out.includes('Blood Rapture'), 'the page rendered from the title match');
});

test('an unknown game is a 404 that explains itself', async () => {
  const { res, out } = await render({ id: 'nope', game: null, byTitle: null });
  assert.equal(res.status, 404);
  assert.ok(out.includes('is in the index') || out.includes('No game called'));
  assert.ok(out.includes('/games'), 'and offers a way out');
});

test('a game nobody here owns still renders', async () => {
  const { out } = await render({ owners: [] });
  assert.ok(out.includes('Nobody on the board owns this one yet'));
  assert.ok(out.includes('Blood Rapture'), 'the trophy list is still there');
});

test('a game with no trophy rows says why rather than rendering an empty table', async () => {
  const { out } = await render({ trophies: [] });
  assert.ok(out.includes('No trophy list for this game yet'));
});

test('a hostile trophy name cannot inject markup', async () => {
  const { out } = await render({
    trophies: [{ ...TROPHIES[0], name: '<img src=x onerror=alert(1)>', detail: '"><script>x' }],
  });
  assert.ok(out.includes('&lt;img'), 'escaped');
  assert.ok(!out.includes('<img src=x'), 'not rendered as a tag');
  assert.ok(!out.includes('<script>x'), 'and neither is the detail');
});

test('a hostile game title cannot break out of the description meta tag', async () => {
  const { out } = await render({ game: { ...GAME, title: '" onload="alert(1)' } });
  assert.ok(!out.includes('onload="alert'));
});

// ------------------------------------------------------ the earned view ----

const VIEWER = {
  psn_online_id: 'JFL__Leon', avatar_url: null, progress: 64, points: 1710,
  // Trophy 1 and 3 only. Trophy 0 (the platinum) and 2 are NOT earned.
  earned_ids: '[1,3]',
};

test('?as= lights up that hunter\'s trophies and nobody else\'s', async () => {
  const { out } = await render({ viewer: VIEWER }, '?as=JFL__Leon');

  // A PERSON, not a sentence with a verb on the end. The chip carries their
  // name and an ✕; "Turn off" was a verb with no object and nobody could say
  // what it turned off.
  assert.match(out, /class="whochip"[\s\S]{0,300}<b>JFL__Leon<\/b>/, 'the chip names them');
  assert.match(out, /class="x" href="\/game\/[^"]*"/, 'and carries a way to clear it');
  assert.ok(out.includes('highlighted below'), 'and says what the highlighting means');
  assert.ok(!bodyOf(out).includes('Turn off'), 'the unlabelled verb is gone');
  assert.match(out, /<ol class="tlist viewing"/, 'the list is in viewing mode');

  // Assert on the CARD, not the class name — the stylesheet is inlined, so
  // out.includes('got') is true on every page ever rendered. The inline trophy
  // SVG sits between the class and the name, so it is stripped first rather
  // than guessed around with a wider window.
  const bare = out.replace(/<svg[\s\S]*?<\/svg>/g, '');
  assert.match(bare, /class="tc m-g got"[\s\S]{0,300}Blood Rapture/, 'earned gold is lit');
  assert.match(bare, /class="tc m-b got"[\s\S]{0,300}Ill-Omened/, 'earned bronze is lit');
  assert.ok(
    !/class="tc m-p got"/.test(out),
    'the platinum is NOT lit — they have not earned it',
  );
});

test('no ?as= means nothing is dimmed', async () => {
  // With nobody signed in there is no such thing as "not done", and fading
  // half the list would be a claim the page cannot support.
  const { out } = await render();
  assert.ok(!out.includes('tlist viewing'), 'no viewing mode');
  assert.ok(!/class="tc [^"]*got"/.test(out), 'nothing is marked earned');
});

test('?as= for somebody who does not own it says so instead of lying', async () => {
  const { out } = await render({ viewer: null }, '?as=Nobody');
  assert.ok(out.includes('does not own this one'), 'says why nothing is lit');
  assert.ok(!out.includes('tlist viewing'), 'and does not dim the list');
});

test('a corrupt earned_ids renders the page without the highlight', async () => {
  // The column is text written by another process. A decoration is never worth
  // a 500.
  const { res, out } = await render({ viewer: { ...VIEWER, earned_ids: '{not json' } }, '?as=JFL__Leon');
  assert.equal(res.status, 200);
  assert.ok(!/class="tc [^"]*got"/.test(out), 'nothing lit');
  assert.ok(out.includes('Blood Rapture'), 'the list is still there');
});

test('the local count has no bar, and no percentage caption', async () => {
  // The bar filled with how many OTHER people had the trophy, so your own
  // finished trophy sat under a half-empty bar. The fraction says it better.
  const { out } = await render();
  assert.ok(out.includes('2 <span class="of-max">/ 3</span>'), 'the fraction stays');
  assert.ok(!out.includes('fill here'), 'the bar is gone');
  assert.ok(!out.includes('% of us'), 'and so is the percentage caption');
  assert.ok(out.includes('nobody here'), 'but the two end cases keep their words');
  assert.ok(out.includes('one of us'));
});

test('there is a way back at the top of the page, not just the bottom', async () => {
  const { out } = await render();
  const crumbAt = out.indexOf('class="crumb"');
  const hero = out.indexOf('class="ghero"');
  assert.ok(crumbAt > -1 && crumbAt < hero, 'the crumb is above the title');
  assert.ok(out.includes('All games'));
});

test('the crumb goes back to the hunter you came from', async () => {
  const { out } = await render({ viewer: VIEWER }, '?as=JFL__Leon');
  assert.match(out, /class="crumb"><a href="\/hunter\/JFL__Leon">[^<]*JFL__Leon/);
});

// ------------------------------------------------------------ DLC packs ----

const PACKED = [
  { ...TROPHIES[0], group_id: 'default' },
  { ...TROPHIES[1], group_id: 'default' },
  { ...TROPHIES[2], group_id: '001' },
  { ...TROPHIES[3], group_id: '002' },
];

test('a game with DLC is split into named sections', async () => {
  const { out } = await render({
    trophies: PACKED,
    groups: [
      { group_id: 'default', name: 'Minecraft', icon_url: null },
      { group_id: '001', name: 'Expansion Pack 1', icon_url: null },
      { group_id: '002', name: 'Expansion Pack 4', icon_url: null },
    ],
  });
  assert.ok(out.includes('Base game'), 'the default group is never called "default"');
  assert.ok(out.includes('Expansion Pack 1'), 'PSN\'s own pack name');
  assert.ok(out.includes('Expansion Pack 4'), 'including a non-sequential one');
  assert.equal((out.match(/<ol class="tlist/g) || []).length, 3, 'three lists');
});

test('packs with no fetched name fall back to DLC, never Pack', async () => {
  // Between two words that both mean "an add-on", DLC is the one every
  // PlayStation owner already uses. The number is the group id with its zero
  // padding stripped, so '002' reads as 2.
  const { out } = await render({ trophies: PACKED, groups: [] });
  assert.ok(out.includes('Base game'));
  assert.ok(out.includes('DLC 1') && out.includes('DLC 2'), 'a heading beats one heap');
  assert.ok(!bodyOf(out).includes('Pack 1'), 'and it is not called Pack');
});

test('a pack is a real folder, open for the base game and shut for DLC', async () => {
  // A <details>, so find-in-page can open a shut one and none of it needs
  // JavaScript. Assert on the ELEMENT and its open attribute, not the class.
  const { out } = await render({
    trophies: PACKED,
    groups: [{ group_id: '001', name: 'Expansion Pack 1', icon_url: null }],
  });
  assert.match(out, /<details class="pack" open>[\s\S]{0,400}Base game/, 'base game opens');
  assert.match(out, /<details class="pack">[\s\S]{0,400}Expansion Pack 1/, 'DLC starts shut');
  assert.equal((out.match(/<summary class="tgroup">/g) || []).length, 3, 'three folders');
});

test('a shut folder says what is in it and what it pays', async () => {
  const { out } = await render({ trophies: PACKED, groups: [] });
  // "Is this pack worth an evening" is the question; a trophy count alone has
  // never answered it.
  assert.match(out, /1 trophy[\s\S]{0,80}420<\/b> points/, 'count and points, singular');
});

test('a finished pack goes green, but only when somebody is being viewed', async () => {
  const all = PACKED.map((t) => t.trophy_id);
  const viewer = { psn_online_id: 'JFL__Leon', avatar_url: null, progress: 100, points: 1,
    earned_ids: JSON.stringify(all) };

  const lit = await render({ trophies: PACKED, groups: [], viewer }, '?as=JFL__Leon');
  assert.match(lit.out, /class="pack done" open/, 'the base game is marked done');
  assert.ok(lit.out.includes('done'), 'and says so');

  // With nobody selected there is no such thing as finished, and a green bar
  // claiming otherwise would be the site inventing a fact.
  const plain = await render({ trophies: PACKED, groups: [] });
  assert.ok(!plain.out.includes('class="pack done"'), 'nothing is green');
});

test('a game with no DLC gets no headings at all', async () => {
  // Every game has a "default" group. A heading above the only list on the page
  // is a label for a distinction that does not exist.
  const { out } = await render();
  assert.ok(!out.includes('Base game'), 'no heading');
  assert.equal((out.match(/<ol class="tlist/g) || []).length, 1, 'one list');
});

test('the page survives the migration not having been run', async () => {
  // This exact failure took the whole site down once, with closes_at: SQLite
  // rejects the entire query for one unknown column. Missing DLC headings is
  // an acceptable degradation; a 500 on every game page is not.
  const { res, out } = await render({ noGroupColumn: true });
  assert.equal(res.status, 200);
  assert.ok(out.includes('Blood Rapture'), 'the trophy list renders');
  assert.ok(!out.includes('Base game'), 'just without the pack headings');
});

test('the column labels survive folding the base game away', async () => {
  // They used to live INSIDE the first folder, so closing it took the header
  // with it and left every DLC's numbers unexplained. A header that vanishes
  // with one section is not a header.
  const { out } = await render({
    trophies: PACKED,
    groups: [{ group_id: '001', name: 'Expansion Pack 1', icon_url: null }],
  });
  const head = out.indexOf('class="tlhead"');
  const firstPack = out.indexOf('<details class="pack');
  assert.ok(head > -1, 'the header is rendered');
  assert.ok(head < firstPack, 'and sits above every folder, not inside one');
  assert.equal((out.match(/class="tlhead"/g) || []).length, 1, 'exactly once');
});

test('the local column is headed Hunters, not Here', async () => {
  const { out } = await render();
  assert.ok(out.includes('>Hunters<'), 'it counts people, so it is named after them');
  assert.ok(!bodyOf(out).includes('>Here<'));
});

/* ---------------------------------------------------------------------------
 * The completion multiplier on the owners panel.
 *
 * The bug this covers: Nurse_Feel_Good (85.27%) and Hawkeyejojon (73.95%) both
 * read 41,181 on the same game, because `member_games.points` is the rarity sum
 * and rarity is shared. Neither of them banks that. The scoring was never
 * wrong — the column was.
 * ------------------------------------------------------------------------ */

test('an owner is shown what they bank, not what the game is worth', async () => {
  const owners = [
    { psn_online_id: 'Nurse_Feel_Good', avatar_url: null, rank: 12, completion: 85.27,
      progress: 100, points: 41181, earned_total: 195, earned_platinum: 1,
      earned_gold: 6, earned_silver: 6, earned_bronze: 286, last_earned_at: null },
    { psn_online_id: 'Hawkeyejojon', avatar_url: null, rank: 15, completion: 73.95,
      progress: 100, points: 41181, earned_total: 195, earned_platinum: 1,
      earned_gold: 6, earned_silver: 6, earned_bronze: 286, last_earned_at: null },
  ];
  const { out } = await render({ owners });

  // Same trophies, same raw worth, different completions — so the column has to
  // separate them. It did not, and that is what Martin caught.
  assert.ok(out.includes('35,115') || out.includes('35,003'), 'Nurse banks ~85% of it');
  assert.ok(out.includes('30,453') || out.includes('30,062'), 'Hawks banks ~74%');
  assert.ok(!out.includes('>41,181<'), 'and neither of them sees the raw figure');
});

test('an owner with no completion yet shows the raw figure, never zero', async () => {
  /**
   * applyCompletion returns 0 for an unusable completion, which is correct
   * scoring and catastrophic display: a member mid-first-scan would render as
   * zero on every game they own. displayBanked falls back to raw instead.
   */
  const owners = [
    { psn_online_id: 'BrandNew', avatar_url: null, rank: 70, completion: null,
      progress: 40, points: 1234, earned_total: 8, earned_platinum: 0,
      earned_gold: 0, earned_silver: 1, earned_bronze: 7, last_earned_at: null },
  ];
  const { out } = await render({ owners });
  assert.ok(out.includes('1,234'), 'raw, rather than a wiped-out zero');
  assert.ok(!out.includes('0.00% completion'), 'and no note claiming it was scaled');
});

test('a trophy nobody can earn any more is marked, and keeps its points', async () => {
  /**
   * The points stay on the card deliberately. Everybody who earned it before it
   * broke still holds them — "we cant take points away from people for earning
   * something that no longer achievable" — so a struck-through or zeroed card
   * would be lying about the thing people care about most.
   */
  const trophies = [
    { ...TROPHIES[0], trophy_id: 1, name: 'Fireworks Fanatic', points: 279,
      unobtainable: 1, unobtainable_note: 'Server event ended in 2024' },
    { ...TROPHIES[0], trophy_id: 2, name: 'Still Fine', points: 12, unobtainable: 0,
      unobtainable_note: null },
  ];
  const { out } = await render({ trophies });

  // bodyOf, because `.deadmark{...}` is in the inlined stylesheet on every
  // page — counting matches against `out` counts the CSS rule as a trophy.
  const body = bodyOf(out);
  assert.match(body, /class="tc [^"]*dead"/, 'the card carries the flag');
  assert.ok(body.includes('Server event ended in 2024'), 'and says what happened');
  assert.ok(body.includes('279'), 'the points are still shown');
  // The healthy trophy must not pick up the mark.
  assert.equal((body.match(/deadmark/g) || []).length, 1, 'exactly one trophy is marked');
});

test('the page survives migration 015 not having run, without losing DLC folders', async () => {
  /**
   * The seatbelt is three-tiered for this reason. A two-tier try/catch would
   * have made a database missing 015 fall all the way back to the ungrouped
   * query, turning off DLC folders as a punishment for an unrelated migration.
   */
  const { res, out } = await render({
    noFlagColumn: true,
    trophies: PACKED,
    groups: [
      { group_id: 'default', name: 'Bloodborne', icon_url: null },
      { group_id: '001', name: 'The Old Hunters', icon_url: null },
    ],
  });
  assert.equal(res.status, 200, 'the page renders');
  assert.ok(!bodyOf(out).includes('deadmark'), 'no flags, because the column is not there');
  assert.ok(out.includes('The Old Hunters'), 'but the DLC folders survive');
});

test('the game page still prints the mod note in full, which is the phone answer', async () => {
  /**
   * The index and the hunter page now carry the note as a `title` on the ⚠,
   * which does nothing on a touch screen. That is only acceptable because this
   * page spells it out, so a phone is one tap from the whole sentence rather
   * than locked out of it. If this ever stops rendering, that trade breaks and
   * the note becomes desktop-only.
   */
  const g = {
    ...GAME,
    unobtainable: 1,
    unobtainable_note: '4 Trophies Unobtainable - UGC Servers Shutdown 31st August 2026',
    closes_at: null,
  };
  const { out } = await render({ game: g });
  const body = bodyOf(out);

  assert.ok(body.includes('4 Trophies Unobtainable'), 'the mod\'s words, in full');
  assert.match(body, /class="warn dead"/, 'as a proper banner, not a tooltip');
});

test('a wholly dead game says so, rather than "some trophies"', async () => {
  /**
   * XDefiant is entirely online, its servers closed in June 2025, and the page
   * said "Some trophies here can no longer be earned" over a trophy list where
   * every row looked perfectly ordinary. JFL__Leon put the row and the page
   * side by side and the page was the weaker of the two, which is backwards:
   * clicking into a dead game should make it look MORE dead, not less.
   */
  const allDead = TROPHIES.map((t) => ({
    ...t, unobtainable: 1, unobtainable_note: 'Servers closed on 4 June 2025',
  }));
  const { out } = await render({
    game: { ...GAME, unobtainable: 1, unobtainable_note: 'The servers closed on 4 June 2025.' },
    trophies: allDead,
  });
  const body = bodyOf(out);

  assert.match(body, /class="warn dead whole"/, 'the banner knows the difference');
  assert.ok(body.includes('Nothing here can be earned any more.'), 'and says it plainly');
  assert.ok(!body.includes('Some trophies here'), 'the understatement is gone');
});

test('a partly broken game keeps the softer wording', async () => {
  // The distinction is the whole point. inFAMOUS 2 is 4 of 52, and telling
  // people nothing in it works would be as wrong as the other way round.
  const some = TROPHIES.map((t, i) =>
    i === 0 ? { ...t, unobtainable: 1, unobtainable_note: 'Event ended' } : t);
  const { out } = await render({
    game: { ...GAME, unobtainable: 1, unobtainable_note: '4 trophies unobtainable.' },
    trophies: some,
  });
  const body = bodyOf(out);

  assert.ok(body.includes('Some trophies here can no longer be earned.'));
  assert.ok(!body.includes('class="warn dead whole"'), 'not the red treatment');
});

test('the count comes from the rows on the page, not a second query', async () => {
  // Anything else could disagree with the list printed underneath it, which is
  // the one place a reader can check the claim.
  const src = await readFile(new URL('../functions/game/[id].js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function clockBlock'), src.indexOf('export async function'));
  assert.match(fn, /trophies\.filter\(\(t\) => Number\(t\.unobtainable\) === 1\)\.length/);
  assert.ok(!/db|prepare|SELECT/.test(fn), 'and asks the database nothing');
});


test('a trophy earned in front of an audience is marked, and says who', async () => {
  /**
   * `on_stream` is set by the live poll and only by the live poll, which cannot
   * run unless Twitch says the member is on air. So this is not "earned by
   * somebody who streams", it is "earned while people were watching", which is
   * a different and much better fact, and nothing else on the internet records
   * it.
   */
  const { out } = await render({
    onStream: [{ trophy_id: 2, at: Date.now() - 3600000, who: 'JFL__Leon' }],
  });
  const body = bodyOf(out);

  assert.match(body, /class="livemark"/, 'the mark is there');
  /**
   * THE BADGE IS TWO WORDS. It read "EARNED LIVE BY JFL__LEON" across every
   * card it touched, on a page usually already filtered to that hunter, which
   * is a lot of shouting to say something the reader knows. The name lives in
   * the tooltip now, for somebody browsing the game cold.
   */
  assert.match(body, /class="livemark"[^>]*>&#9679; Live<\/span>/);
  assert.match(body, /title="JFL__Leon earned this live on stream"/);
  assert.match(body, /class="tc [^"]*onair/, 'and the card carries the purple edge');

  // Exactly one of them. The other trophies are ordinary.
  assert.equal([...body.matchAll(/class="livemark"/g)].length, 1);
});

test('no live marks at all when nobody has earned one on stream', async () => {
  const body = bodyOf((await render()).out);
  assert.ok(!body.includes('class="livemark"'));
  assert.ok(!/class="tc [^"]*onair/.test(body));
});

test('the page survives a database without migration 024', async () => {
  // One un-run migration costs one detail, never a page. Same seatbelt as the
  // trophy flags and the live strip.
  const { res, out } = await render({ noStreamColumn: true });
  assert.equal(res.status, 200);
  assert.ok(!bodyOf(out).includes('class="livemark"'));
  assert.match(bodyOf(out), /Bloodborne/, 'and the game still renders');
});
