/**
 * What counts as "earned on stream", in one place.
 *
 * THREE THINGS ASK THIS QUESTION AND THEY MUST NOT DISAGREE:
 *
 *   1. the live poll, marking a trophy the moment it pops while somebody is
 *      on air (worker/src/live.mjs)
 *   2. the catch-up sweep on the five minute tick, for rows that only turn up
 *      when a member finally runs /update (worker/src/twitch.mjs)
 *   3. the scan itself, which is what WRITES those rows and is therefore the
 *      earliest honest moment to classify them (jobs/scan.mjs)
 *
 * The third one arrived last and is the reason this file exists. Two copies of
 * a window definition drift; three would be a certainty. Same reasoning as
 * shared/contested.mjs, which holds one SQL string for the Worker and the
 * rescore job for exactly this reason.
 */

/**
 * A trophy that pops in the last minute of a broadcast has an `earned_at`
 * fractionally after the moment Twitch noticed the stream stop, so the window
 * gets two minutes of slack at the end. Not at the start: a trophy earned
 * before going live was not earned on stream.
 */
export const END_SLACK_MS = 120000;

/**
 * How long after a stream we keep re-running the sweep, waiting for rows that
 * have not arrived yet.
 *
 * IT WAS TWELVE HOURS AND THAT WAS TOO SHORT. Ragowit streamed for ten hours on
 * 8 September, finished at 17:15, and ran /update the next morning at 08:56 --
 * three hours and forty-one minutes after the sweep had given up. Fourteen
 * trophies earned on camera, none marked, nothing anywhere saying why he was
 * missing from the Streamers board.
 *
 * WIDENING THIS CANNOT MARK A TROPHY EARNED OFF CAMERA. The window being swept
 * is fixed by the member's own stream start and end; this only decides how long
 * the same sweep keeps being retried.
 */
export const SWEEP_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * The shortest stream worth firing a scan for.
 *
 * Martin's rule, and it is better than the cooldown it replaced: *"could we do
 * if they have been streaming for at least 30 mins, that way someone dropping
 * net wont be an issue"*. A flapping connection reads as a stream ending and
 * restarting; each fragment is short, so none of them qualifies. A real session
 * that drops once and comes back for another hour fires twice, which is two
 * scans for one evening and entirely affordable.
 */
export const MIN_STREAM_MS = 30 * 60 * 1000;

/**
 * How recently a stream has to have finished for it to be worth ANNOUNCING.
 *
 * MARKING AND ANNOUNCING ARE DIFFERENT QUESTIONS AND THIS IS WHERE THEY SPLIT.
 * Marking looks back three days, because a trophy earned on camera on Sunday is
 * still a trophy earned on camera when the member finally updates on Tuesday.
 * Announcing must not: PrimalxFear streamed on the 8th from 17:12 to 20:30, ran
 * /update at 10:22 the next morning, and the card went out reading "PrimalxFear
 * finished streaming! 11 trophies earned live over 3h 18m" fourteen hours after
 * he had finished.
 *
 * The stream-end scan fires within about five minutes of going off air, so half
 * an hour is generous for the case this exists to serve and short enough that
 * yesterday never qualifies.
 */
export const ANNOUNCE_WINDOW_MS = 30 * 60 * 1000;

/** Is this window current enough to say something about in a channel? */
export const announceable = (window, now = Date.now()) =>
  !!window && (window.live === true || window.to > now - ANNOUNCE_WINDOW_MS);

/**
 * Mark everything a member earned inside their last stream.
 *
 * `COALESCE(on_stream, 0) = 0` is not an optimisation. Migration 024 adds the
 * column with no default, so the untouched state is NULL rather than 0, and
 * `on_stream = 0` would match nothing at all.
 */
export const MARK_WINDOW_SQL = `
  UPDATE member_trophies
     SET on_stream = 1
   WHERE psn_account_id = ?
     AND earned_at >= ?
     AND earned_at <= ?
     AND COALESCE(on_stream, 0) = 0`;

/** How many of their trophies fall inside that window, marked or not. */
export const COUNT_WINDOW_SQL = `
  SELECT COUNT(*) AS n
    FROM member_trophies
   WHERE psn_account_id = ?
     AND earned_at >= ?
     AND earned_at <= ?`;

/**
 * How stale a live check has to be before `live_since` stops being believed.
 * The same fifteen minutes the home page shelf uses: `live_since` on its own is
 * a lie the moment the check stops running.
 */
export const LIVE_STALE_MS = 15 * 60 * 1000;

/**
 * The bounds to bind, or null when there is no usable window.
 *
 * A STREAM STILL RUNNING HAS A WINDOW TOO, and missing that was a real bug.
 * `last_stream_start` and `last_stream_end` are only written when a stream
 * ENDS, so mid-broadcast they still describe the PREVIOUS session. Khayu2z ran
 * /update an hour into an eight hour stream, and everything that depended on
 * this got handed last night's window and quietly did nothing for tonight's.
 *
 * So a member the live check currently believes is on air gets a window that
 * runs from the moment they went live to right now. Anything they earned in it
 * was earned in front of an audience by definition.
 *
 * `minMs` DEFAULTS TO ZERO, and that is deliberate. A twenty minute stream is a
 * stream: the trophies earned in it count on the board like anybody else's, and
 * filtering them out here would silently cost short streamers their score. The
 * thirty minute rule is about whether firing a whole scan is WORTH IT, which is
 * a different question, so only the dispatch passes MIN_STREAM_MS.
 */
export function streamWindow(member, { minMs = 0, now = Date.now() } = {}) {
  const since = Number(member?.live_since) || 0;
  const checked = Number(member?.live_checked_at) || 0;

  if (since > 0 && since < now && checked > now - LIVE_STALE_MS) {
    const durationMs = now - since;
    // No end slack: the window already runs to this instant, and a bound in the
    // future would let the next trophy in before it has been earned.
    return durationMs < minMs ? null : { from: since, to: now, durationMs, live: true };
  }

  const from = Number(member?.last_stream_start) || 0;
  const to = Number(member?.last_stream_end) || 0;
  if (from <= 0 || to <= from) return null;
  if (to - from < minMs) return null;
  return { from, to: to + END_SLACK_MS, durationMs: to - from, live: false };
}

/** Is that window recent enough to still be worth sweeping? */
export const sweepable = (window, now = Date.now()) =>
  !!window && window.to > now - SWEEP_WINDOW_MS;
