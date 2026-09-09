import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  END_SLACK_MS, MIN_STREAM_MS, SWEEP_WINDOW_MS,
  MARK_WINDOW_SQL, COUNT_WINDOW_SQL, streamWindow, sweepable,
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
    result: { ...base, onStream: { count: 14, durationMs: 10.5 * 3600000 } },
  }).catch(() => {});
  const streaming = headingOf();
  assert.match(streaming, /finished streaming/, 'the streaming heading');
  assert.match(streaming, /14/, 'and how many were earned live');
  assert.match(streaming, /10h 30m/, 'and how long they were on for');

  posted.length = 0;
  await postUpdateResult({ member, result: { ...base } }).catch(() => {});
  const plain = headingOf();
  assert.match(plain, /update finished/, 'no stream, the ordinary heading');
  assert.ok(!/finished streaming/.test(plain));

  posted.length = 0;
  await postUpdateResult({
    member,
    result: { ...base, onStream: { count: 0, durationMs: 2 * 3600000 } },
  }).catch(() => {});
  assert.ok(
    !/finished streaming/.test(headingOf()),
    'a stream that produced nothing is not announced as one',
  );
});
