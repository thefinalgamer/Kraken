import test from 'node:test';
import assert from 'node:assert/strict';
import { D1 } from '../jobs/lib/d1.mjs';

/**
 * D1 over HTTP, and the thing it does when Cloudflare says slow down.
 *
 * THE RUN THIS EXISTS FOR: the trophy name backfill died most of the way
 * through 26,000 games with "D1 query failed (429): internal error". A 429 is
 * Cloudflare asking to be talked to more slowly, not a statement being wrong,
 * and treating the two the same threw away an hour of work.
 */

const db = () => new D1({ accountId: 'a', databaseId: 'b', apiToken: 'c' });

/** Answers with the given statuses in order, then success forever. */
function fakeFetch(statuses) {
  const seen = [];
  globalThis.fetch = async () => {
    const status = statuses[seen.length] ?? 200;
    seen.push(status);
    if (status === 200) {
      return { ok: true, status, json: async () => ({ success: true, result: [{ results: [{ ok: 1 }] }] }) };
    }
    return {
      ok: false,
      status,
      statusText: 'internal error',
      json: async () => ({ success: false, errors: [{ message: 'internal error' }] }),
    };
  };
  return seen;
}

test('a 429 is waited out, not thrown', async () => {
  const seen = fakeFetch([429, 429, 200]);
  const rows = await db().query('SELECT 1');
  assert.deepEqual(rows, [{ ok: 1 }]);
  assert.equal(seen.length, 3, 'two knockbacks, then through');
});

test('a wobble from the database is retried too', async () => {
  // 500s from D1 are intermittent and clear on the next attempt. The one thing
  // that never helps is giving up on the first one.
  const seen = fakeFetch([500, 200]);
  await db().query('SELECT 1');
  assert.equal(seen.length, 2);
});

test('a broken statement fails immediately', async () => {
  /**
   * Retrying a syntax error is a slower way to fail, and it hides the actual
   * mistake behind half a minute of waiting.
   */
  const seen = fakeFetch([400, 400, 400]);
  await assert.rejects(() => db().query('SELECT nonsense'), /D1 query failed \(400\)/);
  assert.equal(seen.length, 1, 'asked once');
});

test('it gives up eventually rather than hanging a job forever', async () => {
  const seen = fakeFetch(Array(20).fill(429));
  await assert.rejects(() => db().query('SELECT 1'), /after 5 attempts/);
  assert.equal(seen.length, D1.ATTEMPTS);
});

test('a dropped connection counts as worth retrying', async () => {
  // A runner losing its network for a second should not lose the whole run.
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error('socket hang up');
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: [] }] }) };
  };
  await db().query('SELECT 1');
  assert.equal(calls, 2);
});
