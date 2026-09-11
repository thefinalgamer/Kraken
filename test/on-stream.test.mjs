import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  END_SLACK_MS, MIN_STREAM_MS, SWEEP_WINDOW_MS, LIVE_STALE_MS, ANNOUNCE_WINDOW_MS,
  MARK_WINDOW_SQL, COUNT_WINDOW_SQL, streamWindow, sweepable, announceable,
} from '../shared/on-stream.mjs';

/**
 * What counts as "earned on stream".
 *
 * Three places ask this — the live poll, the catch-up sweep and the scan — and
 * the whole reason the module exists is that they must give the same answer.
 * The tests that matter are the ones about the edges: a stream too short to
 * bother scanning, a trophy that popped a minute after the broadcast stopped,
 * and a window old enough to stop retrying.
 */

const H = 3600000;
const stream = (startAgo, endAgo) => ({
  last_stream_start: Date.now() - startAgo,
  last_stream_end: Date.now() - endAgo,
});

test('a window runs from the stream start to a little past the end', () => {
  /**
   * The slack is at the END only. A trophy that pops in the last seconds of a
   * broadcast has an earned_at fractionally after the moment Twitch noticed the
   * stream stop; a trophy earned BEFORE going live was not earned on stream,
   * and no amount of slack should let it in.
   */
  const m = stream(4 * H, 1 * H);
  const w = streamWindow(m);

  assert.equal(w.from, m.last_stream_start, 'starts exactly when they went live');
  assert.equal(w.to, m.last_stream_end + END_SLACK_MS, 'ends a couple of minutes late');
  assert.equal(w.durationMs, 3 * H);
  assert.ok(END_SLACK_MS > 0 && END_SLACK_MS <= 300000, 'and the slack stays small');
});

test('a short stream still counts, because a short stream is still a stream', () => {
  /**
   * THE THIRTY MINUTE RULE IS ABOUT WHETHER TO FIRE A SCAN, NOT ABOUT WHETHER
   * TROPHIES COUNT. Filtering short sessions out here would silently cost
   * short streamers their score, which is the opposite of what a board meant
   * to get people streaming should do.
   */
  const w = streamWindow(stream(20 * 60000, 0));
  assert.ok(w, 'twenty minutes is a window');
  assert.equal(w.durationMs, 20 * 60000);

  assert.equal(
    streamWindow(stream(20 * 60000, 0), { minMs: MIN_STREAM_MS }), null,
    'and only a caller that asks for the minimum gets it applied',
  );
});

test('a stream still running has a window, and it runs to right now', () => {
  /**
   * KHAYU2Z, 8 SEPTEMBER. He streamed from 18:43 to 02:35 and ran /update in
   * the middle of it. `last_stream_start` and `last_stream_end` are only
   * written when a stream ENDS, so mid-broadcast they still describe the
   * PREVIOUS session -- and everything reading them was handed last night's
   * window and quietly did nothing for tonight's.
   *
   * He earned Evil Train at 20:31 and Evil Exposure at 21:31. The second was
   * fresh enough for the live poll to catch; the first was eighty minutes old,
   * so it had no row for anything to mark, and stayed unmarked for hours until
   * the stream finally ended and the sweep ran. He noticed and reported it,
   * with timestamps, which is how this was found.
   */
  const now = Date.now();
  const w = streamWindow({
    live_since: now - 2 * H,
    live_checked_at: now - 60000,
    // Last night's stream, which is what it used to use by mistake.
    last_stream_start: now - 30 * H,
    last_stream_end: now - 26 * H,
  }, { now });

  assert.ok(w.live, 'it knows the stream is still running');
  assert.equal(w.from, now - 2 * H, 'from when they went live tonight');
  assert.equal(w.to, now, 'to this instant');
  assert.ok(w.to <= now, 'and never into the future, which would let the next trophy in early');
});

test('a stale live_since is not believed', () => {
  /**
   * `live_since` on its own is a lie the moment the live check stops running.
   * Without this, a Worker outage would leave somebody "live" for days and
   * every trophy they earned offline would be credited to a stream.
   */
  const now = Date.now();
  const stale = {
    live_since: now - 40 * H,
    live_checked_at: now - 3 * H,
    last_stream_start: now - 30 * H,
    last_stream_end: now - 26 * H,
  };
  const w = streamWindow(stale, { now });

  assert.ok(!w.live, 'it falls back to the finished stream');
  assert.equal(w.from, now - 30 * H);
  assert.ok(LIVE_STALE_MS <= 60 * 60000, 'and the staleness limit stays tight');
});

test('the minimum applies to a live stream too, so a fresh one fires nothing', () => {
  const now = Date.now();
  const justOn = { live_since: now - 4 * 60000, live_checked_at: now };
  assert.ok(streamWindow(justOn, { now }), 'four minutes is still a window worth marking');
  assert.equal(
    streamWindow(justOn, { now, minMs: MIN_STREAM_MS }), null,
    'but not one worth firing a whole scan for',
  );
});

test('nonsense never becomes a window', () => {
  assert.equal(streamWindow(null), null);
  assert.equal(streamWindow({}), null, 'never seen live');
  assert.equal(streamWindow({ last_stream_start: 0, last_stream_end: 0 }), null);
  assert.equal(
    streamWindow({ last_stream_start: Date.now(), last_stream_end: Date.now() - H }), null,
    'an end before the start is not a stream',
  );
});

test('the sweep gives up eventually, but not overnight', () => {
  /**
   * Twelve hours was too short and it cost Ragowit fourteen trophies: he
   * finished at 17:15 and updated at 08:56 the next morning, three hours and
   * forty-one minutes after the sweep had stopped looking.
   */
  assert.ok(SWEEP_WINDOW_MS > 16 * H, 'longer than a night between stream and update');
  assert.ok(SWEEP_WINDOW_MS <= 7 * 24 * H, 'and not forever');

  assert.ok(sweepable(streamWindow(stream(26 * H, 16 * H))), 'last night is still swept');
  assert.ok(!sweepable(streamWindow(stream(8 * 24 * H, 8 * 24 * H - H))), 'last week is not');
  assert.ok(!sweepable(null), 'and no window is never sweepable');
});

test('the marking statement can only ever touch one member, inside one window', () => {
  /**
   * Read as a sentence, because this is the statement that decides what the
   * Streamers board is made of. Anything missing from the WHERE clause is a
   * trophy credited to a stream that did not produce it.
   */
  assert.match(MARK_WINDOW_SQL, /SET on_stream = 1/);
  assert.match(MARK_WINDOW_SQL, /WHERE psn_account_id = \?/, 'one member');
  assert.match(MARK_WINDOW_SQL, /earned_at >= \?/, 'not before they went live');
  assert.match(MARK_WINDOW_SQL, /earned_at <= \?/, 'not after they went off');

  /**
   * Migration 024 adds `on_stream` with no default, so an untouched row is
   * NULL and `on_stream = 0` would match nothing at all.
   */
  assert.match(MARK_WINDOW_SQL, /COALESCE\(on_stream, 0\) = 0/, 'and never re-marks a row');
  assert.ok(!/DELETE|DROP|on_stream = 0(?! \))/.test(MARK_WINDOW_SQL), 'it only ever sets');
  assert.match(COUNT_WINDOW_SQL, /COUNT\(\*\)/);
});

test('every place that marks on_stream uses this one definition', () => {
  /**
   * The point of the module. Two copies of a window drift; three is a
   * certainty. Same reasoning as shared/contested.mjs, which holds one SQL
   * string for the Worker and the rescore job.
   */
  const read = (rel) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

  for (const f of ['../worker/src/twitch.mjs', '../jobs/scan.mjs']) {
    const src = read(f);
    assert.match(src, /on-stream\.mjs/, `${f} imports the shared definition`);
    assert.ok(
      !/UPDATE member_trophies\s+SET on_stream/.test(src),
      `${f} does not carry its own copy of the statement`,
    );
  }
});

test('marking looks back three days, announcing does not', () => {
  /**
   * PRIMALXFEAR, 9 SEPTEMBER. He streamed on the 8th from 17:12 to 20:30, ran
   * /update at 10:22 the next morning, and the channel was told "PrimalxFear
   * finished streaming! 11 trophies earned live over 3h 18m" -- fourteen hours
   * after he had finished.
   *
   * The eleven trophies were marked correctly; they really were earned on
   * camera. Only the announcement was wrong. Marking and announcing are
   * different questions and had been sharing one answer.
   */
  const now = Date.now();
  const yesterday = streamWindow({
    last_stream_start: now - 17 * H,
    last_stream_end: now - 14 * H,
  }, { now });

  assert.ok(sweepable(yesterday, now), 'still worth marking');
  assert.ok(!announceable(yesterday, now), 'not worth announcing');

  const justOff = streamWindow({
    last_stream_start: now - 3 * H,
    last_stream_end: now - 5 * 60000,
  }, { now });
  assert.ok(announceable(justOff, now), 'five minutes ago is the case this exists for');

  const onAir = streamWindow({ live_since: now - 2 * H, live_checked_at: now }, { now });
  assert.ok(announceable(onAir, now), 'and a stream still running is always news');

  assert.ok(!announceable(null, now));
  assert.ok(
    ANNOUNCE_WINDOW_MS < SWEEP_WINDOW_MS,
    'the announce window must never outrun the sweep window',
  );
});

// -------------------------------------------------- the streaming card ----

test('the card says "finished streaming" only when trophies were earned live', async () => {
  /**
   * Martin: *"yes have the card a streaming one! thats a good idea still send
   * it to the updates thats fine with me"*.
   *
   * THE CONDITION IS THE COUNT, NOT THE TRIGGER. It reads "finished streaming"
   * because trophies landed inside the window, not because a cron fired. So a
   * member who runs /update themselves twenty minutes after going off air gets
   * the streaming heading, which is correct; and a stream that produced nothing
   * gets the ordinary one, instead of announcing a session with nothing in it.
   */
  const posted = [];
  globalThis.fetch = async (url, opts) => {
    posted.push({ url: String(url), body: JSON.parse(opts?.body ?? '{}') });
    return { ok: true, status: 200, json: async () => ({ id: '1' }) };
  };

  process.env.DISCORD_UPDATES_CHANNEL_ID = '123';
  process.env.DISCORD_BOT_TOKEN = 'x';
  const { postUpdateResult } = await import('../jobs/lib/discord.mjs');

  const member = { psn_online_id: 'Ragowit', discord_id: '1', supporter_months: 0 };
  const base = {
    updateNo: 797, before: {}, after: {}, delta: {}, gamesChanged: 1,
    durationSeconds: 16, repaired: null, changelog: [],
  };

  const headingOf = () => JSON.stringify(posted.at(-1)?.body ?? {});

  await postUpdateResult({
    member,
    // Just off air, which is when the stream-end scan fires.
    result: {
      ...base,
      onStream: {
        count: 14, durationMs: 10.5 * 3600000, live: false, to: Date.now() - 5 * 60000,
      },
    },
  }).catch(() => {});
  const streaming = headingOf();
  assert.match(streaming, /finished streaming/, 'the streaming heading');
  assert.match(streaming, /14/, 'and how many were earned live');
  assert.match(streaming, /10h 30m/, 'and how long they were on for');

  /**
   * IT WENT OUT READING "Pelziowo finished streaming!" WHILE HE WAS STILL ON.
   * He ran /update three and a half hours into a stream he had not finished.
   * The count was right and the duration was right; the verb was a guess left
   * over from when only a stream ending could reach this code.
   */
  posted.length = 0;
  await postUpdateResult({
    member,
    result: { ...base, onStream: { count: 4, durationMs: 3.55 * 3600000, live: true, to: Date.now() } },
  }).catch(() => {});
  const midStream = headingOf();
  assert.match(midStream, /is streaming/, 'present tense while they are on air');
  assert.ok(!/finished streaming/.test(midStream), 'and never says they have finished');
  assert.match(midStream, /so far/, 'the count is a running total, not a result');
  assert.match(midStream, /3h 33m in/, 'and the time is how long they have been on');

  posted.length = 0;
  await postUpdateResult({ member, result: { ...base } }).catch(() => {});
  const plain = headingOf();
  assert.match(plain, /update finished/, 'no stream, the ordinary heading');
  assert.ok(!/finished streaming/.test(plain));

  posted.length = 0;
  await postUpdateResult({
    member,
    result: { ...base, onStream: { count: 0, durationMs: 2 * 3600000, live: false } },
  }).catch(() => {});
  assert.ok(
    !/finished streaming/.test(headingOf()),
    'a stream that produced nothing is not announced as one',
  );

  /**
   * And yesterday's stream is not today's news. PrimalxFear updated fourteen
   * hours after going off air; the trophies still count, the card does not
   * mention it.
   */
  posted.length = 0;
  await postUpdateResult({
    member,
    result: {
      ...base,
      onStream: {
        count: 11, durationMs: 3.3 * 3600000, live: false,
        to: Date.now() - 14 * 3600000,
      },
    },
  }).catch(() => {});
  const stale = headingOf();
  assert.match(stale, /update finished/, 'the ordinary card');
  assert.ok(!/streaming/.test(stale), 'yesterday is not announced as if it just happened');
});

/* ---- migration 031: every stream ---- */

test('streamWindows returns every stored stream, oldest first, without doubling the newest', async () => {
  const { streamWindows } = await import('../shared/on-stream.mjs');
  const now = Date.now();
  const member = { last_stream_start: now - 26 * H, last_stream_end: now - 22 * H };
  const stored = [
    { started_at: now - 26 * H, ended_at: now - 22 * H }, // the same stream as the pair
    { started_at: now - 50 * H, ended_at: now - 46 * H }, // Monday
    { started_at: now - 100 * H, ended_at: now - 96 * H }, // too old to sweep
    { started_at: 0, ended_at: 0 },                         // junk
  ];
  const ws = streamWindows(member, stored, { now });
  assert.deepEqual(ws.map((w) => w.from), [now - 50 * H, now - 26 * H]);
  assert.ok(ws.every((w) => w.live === false));
  assert.equal(ws[0].to, now - 46 * H + END_SLACK_MS, 'stored windows get the same end slack');
});

test('with no stored rows it is exactly the old single window', async () => {
  const { streamWindows } = await import('../shared/on-stream.mjs');
  const m = stream(4 * H, 1 * H);
  assert.deepEqual(streamWindows(m, []), [streamWindow(m)]);
  assert.deepEqual(streamWindows({}, undefined), []);
});

test('migration 031 is safe to run twice', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../migrations/031-stream-windows.sql', import.meta.url)), 'utf8',
  ).replace(/--[^\n]*/g, '');
  const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 3);
  for (const s of statements) {
    assert.match(s, /IF NOT EXISTS|OR IGNORE/, `not idempotent:\n${s}`);
  }
});

test('the scan marks every stored stream, through the shared SQL', () => {
  const src = readFileSync(fileURLToPath(new URL('../jobs/scan.mjs', import.meta.url)), 'utf8');
  assert.match(src, /MEMBER_WINDOWS_SQL/);
  assert.match(src, /streamWindows\(member, stored\)/);
});
