import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { displayBanked } from '../shared/scoring.mjs';

/**
 * The Streamers board. /leaderboard/streamers
 *
 * ONE RULE, TESTED FROM EVERY ANGLE: only trophies earned while live count, and
 * they are priced exactly the way the all-time board prices them. Most of what
 * is below is about the second half of that sentence, because the first half is
 * a WHERE clause nobody will break and the second half is a temptation.
 */
const mod = await import('../functions/leaderboard/streamers.js');

/**
 * A D1 that answers the board query with `rows` and the worker_state lookup with
 * `from`, so the start-date behaviour can be exercised without a real database.
 */
const fakeEnv = (rows, from = null) => ({
  DB: {
    prepare(sql) {
      const st = {
        sql,
        args: [],
        bind(...a) { st.args = a; return st; },
        async first() { return from === null ? null : { value: String(from) }; },
        async all() { return { results: rows }; },
      };
      return st;
    },
  },
});

const render = async (rows, from = null) => {
  const env = fakeEnv(rows, from);
  const res = await mod.onRequestGet({ env });
  return { res, out: await res.text() };
};

/** The real shape, and the real numbers off the live database on 8 September. */
const hunters = [
  {
    psn_account_id: 'a1', psn_online_id: 'JFL__Leon', country: 'GB', avatar_url: null,
    completion: 70.9, supporter_months: 0, twitch_login: 'jfl__leon',
    live_since: null, live_checked_at: Date.now(),
    live_trophies: 27, live_raw: 1321, last_live_at: Date.now() - 3600000,
  },
  {
    psn_account_id: 'a2', psn_online_id: 'Shinlight', country: 'DE', avatar_url: null,
    completion: 44.2, supporter_months: 0, twitch_login: 'shinlight',
    live_since: null, live_checked_at: null,
    live_trophies: 26, live_raw: 293, last_live_at: Date.now() - 4 * 86400000,
  },
  {
    psn_account_id: 'a3', psn_online_id: 'DebbyWebbyUwU', country: null, avatar_url: null,
    completion: 88.0, supporter_months: 3, twitch_login: 'debbywebby',
    live_since: Date.now() - 900000, live_checked_at: Date.now() - 60000,
    live_trophies: 12, live_raw: 187, last_live_at: Date.now() - 600000,
  },
];

test('it renders the hunters who have earned something live', async () => {
  const { res, out } = await render(hunters);

  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  assert.match(res.headers.get('Cache-Control'), /max-age=300/);

  assert.match(out, /<h1>Streamers<\/h1>/);
  for (const h of hunters) assert.ok(out.includes(h.psn_online_id), `${h.psn_online_id} missing`);
  assert.match(out, /<b>3<\/b> hunters/);
  assert.match(out, /<b>65<\/b> trophies earned live/, '27 + 26 + 12');
});

test('the points are the all-time board’s points, not a new currency', async () => {
  /**
   * THE WHOLE POINT OF THE BOARD IS THAT NOTHING NEW IS INVENTED. `trophies
   * .points` is the same blended global-and-local rarity figure the all-time
   * board reads, and the completion multiplier is applied identically. If this
   * ever needs its own explanation, something has gone wrong.
   */
  const { out } = await render(hunters);

  for (const h of hunters) {
    const banked = displayBanked(h.live_raw, h.completion);
    assert.ok(
      out.includes(`data-v="${banked}"`),
      `${h.psn_online_id} should bank ${banked} from ${h.live_raw} at ${h.completion}%`,
    );
    assert.ok(
      !out.includes(`data-v="${h.live_raw}"`) || banked === h.live_raw,
      'and never the raw figure with the multiplier skipped',
    );
  }
});

test('the order is by banked points, not by the raw total', async () => {
  /**
   * The bug this exists to prevent, and SQL cannot do it. Ordering by the raw
   * sum is right until two hunters have different completions: 400 raw at 90%
   * banks 360 and beats 500 raw at 40%, which banks 200. The query orders by raw
   * as a tiebreak and the real sort happens after the multiplier.
   */
  const { out } = await render([
    { ...hunters[0], psn_online_id: 'BigRawLowPct', live_raw: 500, completion: 40, live_trophies: 9 },
    { ...hunters[1], psn_online_id: 'SmallRawHighPct', live_raw: 400, completion: 90, live_trophies: 4 },
  ]);

  assert.ok(
    out.indexOf('SmallRawHighPct') < out.indexOf('BigRawLowPct'),
    '360 banked beats 200 banked, whatever the raw totals say',
  );
  assert.match(out, /<td class="rank">1st<\/td>[\s\S]{0,500}SmallRawHighPct/);
});

test('a hunter with no completion yet shows their raw total, not zero', async () => {
  /**
   * `applyCompletion` returns 0 for a completion it cannot use, which is correct
   * when scoring and badly wrong on a page: somebody mid-first-scan would render
   * as nil across the board, and "all my points vanished" is a worse bug than a
   * figure still waiting on its multiplier. Every other page uses displayBanked
   * for exactly this, and so does this one.
   */
  const { out } = await render([{ ...hunters[0], completion: null, live_raw: 640 }]);
  assert.ok(out.includes('data-v="640"'), 'the raw total stands in');
  assert.match(out, /raw total until their completion lands/, 'and the footer says why');
});

test('a completion tick cannot drag the backlog onto this board', async () => {
  /**
   * The rule the board exists for, stated as a query rather than as prose.
   *
   * On the all-time board, 70% to 71% re-prices every trophy a member has ever
   * earned and pays out across the lot. If that leaked in here, the play would
   * be to grind offline all week, pop one trophy on stream, and let the tick
   * dump thousands of points onto a board about streaming.
   *
   * It cannot, because the SUM only ever runs over rows this WHERE clause
   * admits. A completion tick marks nothing `on_stream`; it only re-prices what
   * is already marked.
   */
  const src = readFileSync(
    fileURLToPath(new URL('../functions/leaderboard/streamers.js', import.meta.url)), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  assert.match(src, /WHERE mt\.on_stream = 1/, 'marked trophies only');
  assert.match(
    src,
    /SUM\(COALESCE\(t\.points, 0\)\)\s+AS live_raw/,
    'the sum is over the joined trophy rows, never over a member column',
  );
  /**
   * Scoped to the QUERY. The page has a local `m.points` after the multiplier is
   * applied, which is fine and is not what this guards; what must never appear
   * is the members table's own points column, which already contains the
   * backlog.
   */
  const sql = src.slice(src.indexOf('const BOARD = `'), src.indexOf('const FROM_KEY'));
  assert.ok(
    !/\bm\.points\b|\bm\.raw_points\b/.test(sql),
    'the members points column is never selected, because it includes the backlog',
  );
});

test('a trophy worth less than a point reads "<1", not "0"', async () => {
  /**
   * TheExtermiNater, off the real board: one live trophy, one raw point, and a
   * completion multiplier takes it under one where the floor makes it nothing.
   * "0" beside "1 live trophy" reads as a bug or as an insult and is neither.
   *
   * Same instinct as the "335 of 335" card: a number that is technically
   * correct and tells the reader the wrong thing.
   */
  const { out } = await render([
    { ...hunters[0], psn_online_id: 'TheExtermiNater', live_raw: 1, completion: 80, live_trophies: 1 },
  ]);

  assert.match(out, /&lt;1/, 'it says less than one');
  assert.ok(!/class="num pts" data-v="0">0</.test(out), 'and never prints a bare nought');
  assert.match(out, /data-v="0"/, 'while still sorting as the zero it is');
});

test('the price join is OUTER, pinned in the SQL itself', () => {
  /**
   * THE ONLY TEST THAT COULD HAVE CAUGHT THIS ONE. Every other test here feeds
   * rows straight past a stubbed database, so the join never runs and an inner
   * join is completely invisible to them. Pelziowo vanished from a live board
   * while the whole suite stayed green.
   *
   * So this reads the query as text. A `SUM(COALESCE(t.points, 0))` sitting on
   * top of an inner join is two decisions that contradict each other, and the
   * inner one always wins.
   */
  const src = readFileSync(
    fileURLToPath(new URL('../functions/leaderboard/streamers.js', import.meta.url)), 'utf8',
  );
  const sql = src.slice(src.indexOf('const BOARD = `'), src.indexOf('`;', src.indexOf('const BOARD = `')));

  assert.match(sql, /LEFT JOIN trophies/, 'an unpriced trophy must not delete its hunter');
  assert.ok(
    !/\n\s+JOIN trophies/.test(sql),
    'and no inner join to trophies anywhere in it',
  );
  assert.match(sql, /COALESCE\(t\.points, 0\)/, 'a missing price is worth zero, not nothing');
  assert.match(sql, /t\.trophy_id IS NULL THEN 1 ELSE 0 END\) AS unpriced/,
    'and the page is told how many were never priced');

  // members is still an inner join: a trophy row with no member is meaningless.
  assert.match(sql, /JOIN members\s+m ON/, 'members stays inner');
});

test('a hunter is never dropped for owning a game nobody has priced', async () => {
  /**
   * PELZIOWO, 9 SEPTEMBER. He streamed for five and a half hours, earned seven
   * trophies on camera, got a Discord card saying exactly that, and did not
   * appear on the board at all. All seven were in NPWR41929_00, a game with no
   * rows in `trophies`, and the query reached that table through an INNER join
   * -- so it deleted him before the `COALESCE(t.points, 0)` sitting right above
   * it could turn the missing price into a zero. Two decisions in one query that
   * contradicted each other.
   *
   * ANY FIGURE THAT DISAGREES WITH ANOTHER FIGURE IS A BUG. This one disagreed
   * with a message Kraken had already sent him.
   */
  const { out } = await render([
    { ...hunters[0], psn_online_id: 'Pelziowo', live_trophies: 7, live_raw: 0, unpriced: 7 },
  ]);

  assert.ok(out.includes('Pelziowo'), 'he is on the board');
  assert.match(out, /not priced yet/, 'and the reason is on the row');
  assert.ok(!/&lt;1/.test(out), 'never "<1", which would claim we weighed them and found them wanting');
  assert.match(out, /start paying the moment the game is priced/, 'the footer explains it');
});

test('"<1" and "not priced yet" are different states and stay different', async () => {
  /**
   * They look identical at zero points and mean opposite things: one has been
   * valued and is worth a fraction, the other has never been valued at all.
   */
  const { out } = await render([
    { ...hunters[0], psn_online_id: 'Priced', live_trophies: 1, live_raw: 1, unpriced: 0, completion: 80 },
    { ...hunters[1], psn_online_id: 'Unpriced', live_trophies: 7, live_raw: 0, unpriced: 7 },
  ]);

  const rowIn = (name) => out.split('<tr>').find((tr) => tr.includes(`>${name}<`)) ?? '';
  assert.match(rowIn('Priced'), /&lt;1/, 'valued, and worth under a point');
  assert.ok(!/not priced yet/.test(rowIn('Priced')));
  assert.match(rowIn('Unpriced'), /not priced yet/, 'never valued');
  assert.ok(!/&lt;1/.test(rowIn('Unpriced')));
});

test('a partly priced hunter still shows the points they have earned', async () => {
  // Only "nothing at all is priced" gets the label. Some priced and some not is
  // an ordinary score with a bit missing, and printing a number is honest.
  const { out } = await render([
    { ...hunters[0], live_trophies: 10, live_raw: 400, unpriced: 3, completion: 90 },
  ]);
  assert.ok(!/not priced yet/.test(out.split('<tbody>')[1] ?? ''), 'no label on the row');
  assert.match(out, /data-v="360"/, 'and the priced half still pays');
});

test('nobody is listed at zero', async () => {
  /**
   * Sixty-seven people tied on nil is not a board, it is a membership list with
   * a column of noughts. A member who has never streamed has no marked trophies
   * and so no row at all, and the footer says how to get one.
   */
  const { out } = await render([]);
  assert.match(out, /Nobody on the board yet/);
  assert.match(out, /No trophies have been earned on stream yet/);
  assert.match(out, /\/twitch/, 'and how to get on it');
  assert.ok(!out.includes('<table>'), 'no empty table');
});

test('the start date is a filter, and it defaults to counting everything', async () => {
  /**
   * The soft test will be cleared, and the clear must NOT be a DELETE: the
   * `on_stream` marks are the only record anywhere of what was earned live, and
   * PSN cannot be asked what was on screen. A start date has the same effect for
   * members, throws nothing away, and is one statement in the D1 console.
   */
  // Comments stripped: the one explaining why this is NOT a DELETE contains the
  // word, and scanning raw text failed on its own explanation.
  const src = readFileSync(
    fileURLToPath(new URL('../functions/leaderboard/streamers.js', import.meta.url)), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /mt\.earned_at >= \?/, 'the query filters on it');
  assert.ok(!/DELETE/i.test(src), 'and nothing here ever deletes a mark');

  // Unset means zero means everything.
  const none = fakeEnv(hunters, null);
  let bound;
  none.DB.prepare = ((real) => (sql) => {
    const st = real(sql);
    const bind = st.bind.bind(st);
    st.bind = (...a) => { if (sql.includes('on_stream')) bound = a[0]; return bind(...a); };
    return st;
  })(none.DB.prepare);
  await mod.onRequestGet({ env: none });
  assert.equal(bound, 0, 'no value set counts every trophy ever marked');

  const { out } = await render(hunters, 1757000000000);
  assert.ok(out.includes('JFL__Leon'), 'and a value set still renders normally');
});

test('the live pin is only for somebody actually on air', async () => {
  /**
   * `live_since` alone is a lie the moment the live check stops running, so a
   * recent `live_checked_at` is the other half of the answer. Purple is allowed
   * on this page under the standing rule: it only ever appears on a page about a
   * person, and every row here is one person.
   */
  const { out } = await render(hunters);

  /**
   * Per ROW, not by proximity. A window of characters after a name runs into the
   * next hunter's row and reports their pin as this one's, which is exactly the
   * false pass a test about who is live must not give.
   */
  const rowIn = (html, name) =>
    html.split('<tr>').find((tr) => tr.includes(`>${name}<`)) ?? '';

  assert.match(rowIn(out, 'DebbyWebbyUwU'), /livedot/, 'live now, checked a minute ago');
  assert.doesNotMatch(rowIn(out, 'JFL__Leon'), /livedot/, 'not live, no pin');
  assert.doesNotMatch(rowIn(out, 'Shinlight'), /livedot/, 'never checked, no pin');

  /**
   * Scoped to the row for a second reason: the stylesheet defines .livedot and
   * is inlined into every page, so a whole-document `includes('livedot')` passes
   * on a page that never draws one.
   */
  const stale = await render([
    { ...hunters[2], live_since: Date.now() - 9e6, live_checked_at: Date.now() - 9e6 },
  ]);
  assert.doesNotMatch(
    rowIn(stale.out, 'DebbyWebbyUwU'), /livedot/,
    'a stale check is not a live stream',
  );
});

test('a hostile PSN name cannot inject markup', async () => {
  const { out } = await render([{ ...hunters[0], psn_online_id: '<img src=x onerror=alert(1)>' }]);
  assert.ok(out.includes('&lt;img'), 'escaped');
  assert.ok(!out.includes('<img src=x'), 'and not live in the document');
});

test('an http avatar is upgraded before it reaches the page', async () => {
  /**
   * PSN serves avatars over plain http and the site is https, so the browser
   * blocks them with no error anybody sees. Every page runs them through
   * secureUrl; this one is no exception.
   */
  const { out } = await render([{
    ...hunters[0],
    avatar_url: 'http://static-resource.np.community.playstation.net/avatar/a.png',
  }]);
  assert.ok(out.includes('https://static-resource.np.community.playstation.net/avatar/a.png'));
  assert.ok(!out.includes('"http://'), 'nothing plain-http in an attribute');
});

test('points is the one column that never stands down on a phone', async () => {
  /**
   * Four columns plus a LIVE pill pushed POINTS off the right of a 420px screen,
   * behind a sideways scroll nobody would find. A board whose score is not on
   * screen is not a board, so every other column carries hide-s and this one
   * never does.
   */
  const { out } = await render(hunters);
  const head = out.slice(out.indexOf('<thead>'), out.indexOf('</thead>'));

  assert.match(head, /<th class="num" aria-sort="descending">Points<\/th>/, 'no hide-s on points');
  for (const col of ['Live trophies', 'Completion', 'Last on stream']) {
    assert.ok(
      new RegExp(`<th class="num hide-s">${col}<\\/th>`).test(head),
      `${col} stands down on a phone`,
    );
  }
});

test('it is the Streamers tab that is marked, not All-time', async () => {
  const { out } = await render(hunters);
  assert.match(out, /<a class="tab on" href="\/leaderboard\/streamers">Streamers<\/a>/);
  assert.match(out, /<a class="tab" href="\/leaderboard">All-time<\/a>/);
  assert.match(out, /<span class="tab soon">Seasonal<i>soon<\/i><\/span>/);
});

test('this board has no seasons in it', async () => {
  /**
   * Streamers and Seasonal are different boards and the difference kept getting
   * lost in conversation. Streamers is a different set of TROPHIES: all time,
   * only the ones earned live. Seasonal is a different WINDOW OF TIME. Season
   * numbers, monthly resets and "Season 1" belong to the third tab, and copy on
   * this page promising any of them would be a promise the code does not keep.
   */
  const { out } = await render(hunters);
  assert.ok(!/[Ss]eason \d/.test(out), 'no season numbering');
  assert.ok(!/resets? (each|every) month/i.test(out), 'and no reset schedule promised');
});
