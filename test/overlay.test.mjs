import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bodyOf } from './helpers.mjs';
import { localMultiplier } from '../shared/scoring.mjs';
import { displayBanked } from '../shared/scoring.mjs';

/**
 * The stream overlay. GET /overlay/<name>
 *
 * This one is not a page, it is a browser source sitting on top of somebody
 * else's gameplay, and almost every test here is about that difference: no
 * branding on it, no background behind it, no error card across their screen,
 * and no query that reads a library to print one line.
 */
const mod = await import('../functions/overlay/[name].js');

const MEMBER = {
  psn_account_id: 'acct-1', psn_online_id: 'Pelzio', rank: 2, points: 148220,
  completion: 92.55, platinum: 143, gold: 1050, silver: 1203, bronze: 2201,
  projects: 159, completed: 144,
};

// Nine own it here, three have the platinum, so the multiplier is real.
const PLAYING = {
  np_comm_id: 'NPWR_INDY', title: 'Indiana Jones and the Great Circle',
  platform: 'PS5', icon_url: 'https://x.test/indy.png', trophy_count: 46,
  max_points: 3948, local_started: 9, unobtainable: 0,
  points: 1410, progress: 90, earned_total: 43, plat_local: 3,
};

let lastPlayingSql = '';
let lastPlayingBind = [];

const fakeEnv = ({ member = MEMBER, playing = PLAYING, total = 70, ahead = null } = {}) => ({
  DB: {
    prepare(sql) {
      return {
        bind: (...args) => ({
          first: async () => {
            // The rank lookup and the member lookup are both FROM members, so
            // the stub has to tell them apart by what they select.
            if (sql.includes('SELECT rank, points')) return ahead;
            if (sql.includes('FROM members')) return member;
            lastPlayingSql = sql;
            lastPlayingBind = args;
            return playing;
          },
        }),
        // Only the ranked-count query is bound to nothing.
        first: async () => ({ c: total }),
      };
    },
  },
});

const render = async (opts = {}, qs = '') => {
  const res = await mod.onRequestGet({
    env: fakeEnv(opts),
    request: new Request(`https://platinumintel.co.uk/overlay/Pelzio${qs}`),
    params: { name: 'Pelzio' },
  });
  return { res, out: await res.text() };
};

test('it carries no branding of any kind', async () => {
  /**
   * THE RULE THE WHOLE FEATURE HANGS ON. Martin: "i dont want it to be OH LET
   * ME BRAND YOUR CHANNEL". An overlay that advertises a Discord comes off the
   * layout in a week, and the thing that actually spreads it is chat asking
   * the streamer what the bar is.
   *
   * This checks the WHOLE document rather than the body, because a logo hidden
   * in a background-image in the stylesheet would be just as visible on screen
   * as one in the markup.
   */
  const { out } = await render();
  for (const brand of ['Platinum Intel', 'platinumintel', 'Kraken', 'discord.gg', 'kofi', 'Ko-fi']) {
    assert.ok(!out.toLowerCase().includes(brand.toLowerCase()), `"${brand}" is on the overlay`);
  }
  assert.ok(!out.includes('<img src="/Kraken'), 'no mark');
});

test('the background is transparent, so it does not black out the gameplay', async () => {
  const { out } = await render();
  assert.match(out, /html,body\{margin:0;background:transparent\}/, 'the body paints nothing');
  // The bar itself is allowed a surface. That is the point of it.
  assert.match(out, /\.bar\{[\s\S]*?background:linear-gradient/, 'but the bar has one');
});

test('it repaints itself without any JavaScript', async () => {
  const { out } = await render();
  assert.match(out, /<meta http-equiv="refresh" content="60">/, 'a meta refresh, not a script');
  assert.ok(!out.includes('<script'), 'no script tag anywhere');
  assert.ok(!/on(load|click|error)=/.test(out), 'and no inline handlers');
});

test('the three zones, in the order they were asked for', async () => {
  const body = bodyOf((await render()).out);
  const game = body.indexOf('Indiana Jones');
  const points = body.indexOf('class="pts"');
  const rank = body.indexOf('class="rank"');
  const cups = body.indexOf('class="cups"');

  assert.ok(game > 0 && points > game, 'the game comes before ours');
  assert.ok(cups > rank, 'and the cabinet comes last');

  /**
   * POINTS LEAD THE MIDDLE, NOT RANK. Martin: "i wouldnt start with rank i
   * would start with points since its next to the game". The points are about
   * the game, so they belong beside it; the rank is about the person.
   */
  assert.ok(points < rank, 'points before rank inside the middle');
});

test('the middle is the only part that can be switched off', async () => {
  const on = bodyOf((await render()).out);
  const off = bodyOf((await render({}, '?mid=0')).out);

  assert.match(on, /class="rank"/, 'rank shows by default');
  assert.ok(!off.includes('class="rank"'), 'and goes with the middle');
  assert.ok(!off.includes('class="pts"'), 'so do the points');

  // The two ends must survive, and the gap they leave must be a spacer rather
  // than a jump.
  assert.match(off, /Indiana Jones/, 'the game stays');
  assert.match(off, /class="cups"/, 'so does the cabinet');
  assert.match(off, /class="spacer"/, 'and the middle leaves a hole, not a shuffle');
});

test('the hours slot is drawn empty rather than left out', async () => {
  /**
   * It belongs to the streaming board, which does not exist yet. Drawing it
   * dim now means the day the number arrives nothing else on the bar moves
   * sideways to make room, which is the kind of change a streamer notices
   * because their layout was built around where things sat.
   */
  const body = bodyOf((await render()).out);
  assert.match(body, /class="seg hold"/, 'the slot is there');
  assert.match(body, /00\.0h/, 'holding a zero');
});

test('the multiplier only appears when it is doing something', async () => {
  // Three of nine finished, so it is genuinely paying more here.
  const busy = bodyOf((await render()).out);
  const mult = localMultiplier(3, 9);
  assert.ok(mult > 1.005, 'the fixture is a live multiplier');
  assert.match(busy, new RegExp(`&times;${mult.toFixed(2)}`), 'and it is printed');
  /**
   * THE NUMBER ALONE. It printed "x1.13 7 stuck" and Martin cut the tail:
   * seven words of explanation on a bar with no room to spare, for something
   * chat asks about anyway. The number is the hook, the streamer is the answer.
   */
  assert.ok(!/stuck/.test(busy), 'and nothing explaining it');

  // Everybody who owns it has finished it, so the chip is noise.
  const settled = bodyOf(
    (await render({ playing: { ...PLAYING, plat_local: 9 } })).out,
  );
  assert.ok(!settled.includes('class="mult"'), 'a flat 1.00 chip takes space to say nothing');

  // Two owners is below the contested floor, so there is no local evidence yet.
  const lonely = bodyOf(
    (await render({ playing: { ...PLAYING, local_started: 2, plat_local: 0 } })).out,
  );
  assert.ok(!lonely.includes('class="mult"'), 'no multiplier off two owners');
});

test('points are banked through the completion, like every other surface', async () => {
  /**
   * The same trap the hunter page fell into: `mg.points` is the price list for
   * the game, identical for everybody holding those trophies, and printing it
   * raw tells two members with very different completions that they are
   * getting the same number.
   */
  const body = bodyOf((await render()).out);
  const got = displayBanked(PLAYING.points, MEMBER.completion);
  const max = displayBanked(PLAYING.max_points, MEMBER.completion);
  assert.ok(got < PLAYING.points, 'the fixture actually exercises the multiplier');
  assert.match(body, new RegExp(got.toLocaleString('en-GB')), 'banked, not raw');
  assert.match(body, new RegExp(max.toLocaleString('en-GB')), 'out of the banked full');
});

test('the cabinet is started against completed, with the account percent', async () => {
  const body = bodyOf((await render()).out);
  assert.match(body, /144\/159/, 'completed out of started');
  assert.match(body, /92\.55%/, 'and their completion');
  assert.match(body, /143/, 'platinums');
  assert.match(body, /2,201/, 'and bronzes, formatted');
});

test('a name nobody has shows nothing at all, and is not cached', async () => {
  /**
   * A visible "no such hunter" card would sit across somebody's gameplay for a
   * whole stream, and they would have no idea where it came from. Empty is the
   * only safe failure for something living in another person's layout.
   */
  const { res, out } = await render({ member: null });
  assert.equal(res.status, 404);
  // Two stylesheets now: the sheet, then the one line carrying the size dial.
  const empty = out.slice(out.lastIndexOf('</style>'))
    .replace(/<\/style>|<\/head>|<body>|<\/body>|<\/html>|\s/g, '');
  assert.equal(empty, '', 'nothing between body and the end of the document');
  assert.match(res.headers.get('cache-control'), /no-store/, 'a typo must not stick');
});

test('one row for the game, and it leans on the index that makes that possible', async () => {
  /**
   * THIS IS THE COST TEST. It runs every sixty seconds for as long as somebody
   * streams. MRTheChez owns 1,512 games, so a query that sorted a library to
   * find one row would read close to a million rows over one evening, against
   * a free tier of five million a day for the entire board.
   */
  await render();
  assert.match(lastPlayingSql, /LIMIT 1/, 'one row');
  assert.match(lastPlayingSql, /ORDER BY COALESCE\(mg\.last_played_at/, 'newest first');
  assert.deepEqual(lastPlayingBind, ['acct-1'], 'scoped to one member');
  assert.ok(!/COUNT\(\*\)[\s\S]*FROM member_games/.test(lastPlayingSql), 'nothing counted');

  const migration = await readFile(
    new URL('../migrations/017-overlay-recent.sql', import.meta.url), 'utf8',
  );
  assert.match(
    migration,
    /ON member_games\(psn_account_id, last_played_at DESC\)/,
    'and the index that ORDER BY needs actually exists',
  );
});

test('it caches for less time than it refreshes', async () => {
  // A five minute cache on a bar that repaints every sixty seconds would mean
  // four out of five repaints showed the same numbers back.
  const { res } = await render();
  const max = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control'))?.[1]);
  assert.ok(max > 0 && max <= 30, `cache ${max}s should sit under the refresh`);
});

test('position is a whitelist, not a string from the query', async () => {
  const bottom = bodyOf((await render()).out);
  assert.match(bottom, /class="bar bottom"/, 'bottom by default');

  const top = bodyOf((await render({}, '?pos=top')).out);
  assert.match(top, /class="bar top"/);

  const junk = bodyOf((await render({}, '?pos=" onload="alert(1)')).out);
  assert.match(junk, /class="bar bottom"/, 'anything else falls back');
  assert.ok(!junk.includes('onload'), 'and never reaches the markup');
});

test('a member the scan has not reached yet still renders', async () => {
  /**
   * Somebody registers, adds the overlay before their first scan finishes, and
   * goes live. Their cabinet is known from their member row; the game is not.
   * The bar has to survive that rather than throw a 500 into OBS.
   */
  const { res, out } = await render({ playing: null });
  const body = bodyOf(out);
  assert.equal(res.status, 200);
  assert.match(body, /Nothing scanned yet/);
  assert.match(body, /class="cups"/, 'the cabinet still shows');
  assert.ok(!body.includes('class="pts"'), 'and the middle has nothing to say');
});

test('a flagged game says so on the bar', async () => {
  const body = bodyOf((await render({ playing: { ...PLAYING, unobtainable: 1 } })).out);
  assert.match(body, /class="warn"/, 'the mark is there');
});

test('the ordinal is right, including the teens', async () => {
  for (const [rank, mark] of [[1, 'st'], [2, 'nd'], [3, 'rd'], [4, 'th'],
    [11, 'th'], [12, 'th'], [13, 'th'], [21, 'st'], [22, 'nd'], [23, 'rd']]) {
    const body = bodyOf((await render({ member: { ...MEMBER, rank } })).out);
    assert.match(body, new RegExp(`>${rank}<sup>${mark}</sup>`), `${rank}${mark}`);
  }
});

test('the size dial is a dial, and it is clamped', async () => {
  /**
   * "text is very small" came back from more than one person, and no single
   * number fixes it: people stream at 1080 and at 1440 with layouts of every
   * size. The bar is sized in em off one root value, so this is one parameter
   * rather than a redesign. Clamped, because a URL handed to a streamer must
   * not be able to draw a bar taller than their game.
   */
  assert.match((await render()).out, /--s:1\}/, 'normal by default');
  assert.match((await render({}, '?scale=125')).out, /--s:1\.25\}/);
  assert.match((await render({}, '?scale=900')).out, /--s:2\}/, 'clamped at the top');
  assert.match((await render({}, '?scale=10')).out, /--s:0\.7\}/, 'and at the bottom');
  assert.match((await render({}, '?scale=nonsense')).out, /--s:1\}/, 'junk falls back');
});

test('nothing on the bar is grey', async () => {
  /**
   * Martin: "the gray text is almost impossible to see with backgrounds so keep
   * it white". The site's palette does not transfer here, because a page has a
   * dark surface behind it and this has whatever the game is doing. Hierarchy
   * is carried by weight and size, and every scrap of text sits on its own
   * shadow so it never depends on the panel behind it.
   */
  const { out } = await render();
  const vars = out.slice(out.indexOf(':root{'), out.indexOf('}', out.indexOf(':root{')));
  assert.match(vars, /--ink:#ffffff/);
  assert.match(vars, /--soft:#eaf2f0/, 'the second tier is still nearly white');
  assert.match(out, /text-shadow:0 1px 2px rgba\(0,0,0,\.9\)/, 'and it carries its own edge');
});

test('the four metals show for the game on screen', async () => {
  // The board has always shown a person's cabinet; nothing showed the same
  // breakdown for the thing they are actually playing.
  const body = bodyOf((await render({
    playing: {
      ...PLAYING, earned_platinum: 0, earned_gold: 3, earned_silver: 8, earned_bronze: 32,
    },
  })).out);

  // Scoped to the GAME's cups. The account cabinet on the right always carries
  // a platinum count, so checking the whole document for "c-plat" would be
  // asserting against the wrong half of the bar.
  const i = body.indexOf('class="cups gcups"');
  assert.ok(i > 0, 'the game cups are drawn');
  const gcups = body.slice(i, body.indexOf('</span>', body.indexOf('</span>', i) + 1));

  assert.match(gcups, /class="c-gold">.*?3/s);
  assert.ok(/class="c-bron"/.test(body.slice(i)), 'and the bronzes');
  // A game with no platinum earned must not print a blank platinum: half the
  // width of the bar would go on noughts.
  assert.ok(!/class="c-plat"/.test(gcups), 'zeroes are left out');
});

test('the gap to the next place is shown, and only when there is one', async () => {
  /**
   * "32nd of 71" says where you are and nothing about whether 31st is forty
   * points away or four thousand, which is the only question anybody looks at
   * their own rank to answer.
   */
  const body = bodyOf((await render({ ahead: { rank: 1, points: 152000 } })).out);
  assert.match(body, /class="gap"/);
  assert.match(body, /3,780<\/b> to 1st/, 'the difference of two stored numbers');

  // First place has nobody to chase, and must not be told they need 0 to 0th.
  const first = bodyOf((await render({ member: { ...MEMBER, rank: 1 } })).out);
  assert.ok(!first.includes('class="gap"'));
});

test('the game points sit on the left but belong to the middle', async () => {
  /**
   * Martin: "could we have the game points ... on the left hand side next to
   * the time, still count it as the middle section so if people hide our side
   * of things it hides". So position and ownership are different things here,
   * and the switch has to respect ownership.
   */
  const on = bodyOf((await render()).out);
  const left = on.indexOf('class="pts"');
  const mid = on.indexOf('class="zone mid"');
  assert.ok(left > 0 && left < mid, 'printed before the middle zone starts');

  const off = bodyOf((await render({}, '?mid=0')).out);
  assert.ok(!off.includes('class="pts"'), 'and it goes when the middle goes');
});

test('the games icon is a controller, not three rectangles', async () => {
  const { out } = await render();
  assert.match(out, /class="ic pad"/);
  assert.ok(!out.includes('<rect x="3" y="4"'), 'the old stacked bars are gone');
});

test('the bar wears the best metal earned in the game so far', async () => {
  /**
   * Martin: "if we earn bronze have bronze once it earns silver turn to that
   * gold turn to that like we do". Bronze while it is only bronzes, and up
   * from there as better ones land.
   *
   * NOT SEGMENTS, deliberately. Bands by trophy type cannot be honest here:
   * PSN's progress percentage is weighted and the trophy counts are not, so
   * the bands would add up to a different width than the percentage printed
   * beside them.
   */
  const withCups = (cups) => render({ playing: { ...PLAYING, ...cups } });
  const fillOf = (out) => /class="fill"[^>]*background:([^"]+)"/.exec(bodyOf(out))?.[1];

  assert.equal(
    fillOf((await withCups({ earned_platinum: 0, earned_gold: 0, earned_silver: 0, earned_bronze: 9 })).out),
    'var(--bronze)',
  );
  assert.equal(
    fillOf((await withCups({ earned_platinum: 0, earned_gold: 0, earned_silver: 2, earned_bronze: 9 })).out),
    'var(--silver)',
  );
  assert.equal(
    fillOf((await withCups({ earned_platinum: 0, earned_gold: 1, earned_silver: 2, earned_bronze: 9 })).out),
    'var(--gold)',
  );
  assert.equal(
    fillOf((await withCups({ earned_platinum: 1, earned_gold: 1, earned_silver: 2, earned_bronze: 9 })).out),
    'var(--plat)',
    'the platinum outranks everything under it',
  );
  assert.equal(
    fillOf((await withCups({ earned_platinum: 0, earned_gold: 0, earned_silver: 0, earned_bronze: 0 })).out),
    'var(--accent)',
    'and a game with nothing earned yet is not painted bronze',
  );
});

test('the controller ring is the green one', async () => {
  // Martin picked the console card icon for the ring, and the ring is the part
  // that makes it read at a glance.
  assert.match((await render()).out, /<circle[^>]*stroke="var\(--accent\)"/);
});


test('a fresh live note beats the scan, but only for the counts', async () => {
  /**
   * Leon popped a trophy, the card appeared, and the bar still said 10 of 18.
   * The poll was writing the trophy log and nothing else, so the counts stayed
   * on whatever his last update knew.
   *
   * The live note fixes the COUNTS and deliberately does not touch the POINTS.
   * Points are the rescore's to decide; an overlay guessing at them would be
   * the one place on this project where a number is invented rather than
   * printed.
   */
  const live = JSON.stringify({
    id: 'NPWR_INDY', at: Date.now() - 4000,
    progress: 61, platinum: 0, gold: 2, silver: 3, bronze: 6,
  });
  const body = bodyOf((await render({ member: { ...MEMBER, live_play: live } })).out);

  assert.match(body, />11\/46</, 'the counts are the poll\'s, seconds old');
  assert.match(body, /61\.00%/, 'and so is the progress');
  assert.match(body, /width:61\.00%/);

  // The price list is untouched: still the scan's banked figure.
  const got = displayBanked(PLAYING.points, MEMBER.completion);
  assert.match(body, new RegExp(got.toLocaleString('en-GB')), 'points stay the scan\'s');
});

test('a stale live note is ignored and the scan takes over again', async () => {
  /**
   * The poll only writes while somebody is streaming with the overlay up, so
   * the note stops the moment they stop. Fifteen minutes later the bar goes
   * back to what the scan knows rather than insisting forever that they are
   * still on last night's game.
   */
  const stale = JSON.stringify({
    id: 'NPWR_INDY', at: Date.now() - 40 * 60000,
    progress: 61, platinum: 0, gold: 2, silver: 3, bronze: 6,
  });
  const body = bodyOf((await render({ member: { ...MEMBER, live_play: stale } })).out);
  assert.match(body, />43\/46</, 'back to the stored counts');
  assert.match(body, /90\.00%/);
});

test('a live note that is not valid JSON is simply no note', async () => {
  // There is no version of a broken blob that is worth an exception on
  // somebody's stream.
  const { res, out } = await render({ member: { ...MEMBER, live_play: '{not json' } });
  assert.equal(res.status, 200);
  assert.match(bodyOf(out), />43\/46</);
});

test('the live note never writes to the scan\'s own numbers', async () => {
  /**
   * THE TRAP THIS AVOIDS. Writing fresh counts into `member_games` was the
   * obvious fix and it would have been quietly catastrophic: the scan decides
   * whether to re-fetch a game by comparing its stored count against PSN's, so
   * an updated count there would make it skip the game and never award the
   * points. Right for an evening, wrong forever.
   */
  const live = readFileSync(
    fileURLToPath(new URL('../worker/src/live.mjs', import.meta.url)), 'utf8',
  );
  assert.match(live, /UPDATE members SET live_play/, 'the note goes on the member row');
  assert.ok(!/UPDATE member_games/.test(live), 'and nothing here touches the scan\'s record');
  assert.ok(!/INSERT INTO member_games/.test(live));
});
