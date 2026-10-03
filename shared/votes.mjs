/**
 * Votes: what chat plays next. /vote in Discord, the Vote tab on the panel.
 *
 * Agreed with Martin on 21 September from a mockup:
 *   - three sources: the streamer's LIST (Leon's channel-point requests already
 *     land there), a separate BACKLOG, or five RANDOM unfinished games
 *   - backlog and random never offer a game flagged broken
 *   - no timer: the streamer opens it and the streamer closes it
 *   - results stay hidden until you have voted ("FUCKING GOLDEN I LOVE IT")
 *   - one vote per Twitch account, and it cannot be changed
 *   - the winner is NOT put on the overlay automatically
 *
 * Pure rules only, shared by the Worker (/vote) and the site (the panel API).
 */

export const VOTE_SOURCES = {
  list: { label: 'My list', question: 'Which one do I play next?' },
  backlog: { label: 'Backlog', question: 'Help me clear the backlog' },
  random: { label: 'Random 5', question: 'The dice picked five. You pick one.' },
};

/** Fewer than this is not a vote. */
export const MIN_OPTIONS = 2;

/** The most a ballot can hold. The wishlist caps at twelve, so the list fits. */
export const MAX_OPTIONS = 12;

/** How many games Random picks. Five fits the panel without scrolling. */
export const RANDOM_PICKS = 5;

/** How many games the backlog may hold. */
export const BACKLOG_MAX = 12;

/**
 * How long a closed vote's result stays on the panel.
 *
 * Long enough to cover "we voted tonight, I'll play it tomorrow", which is the
 * reason the winner does not go straight onto the overlay.
 */
export const RESULT_SHOWN_MS = 48 * 3_600_000;

/**
 * A game that cannot be finished. The game flag, or any trophy in it flagged,
 * because a game with one unobtainable trophy cannot be 100%'d either. SQL, so
 * it runs where the rows are; `g` is the games alias.
 */
export const FINISHABLE_SQL = `COALESCE(g.unobtainable, 0) = 0
  AND NOT EXISTS (SELECT 1 FROM trophies t
                   WHERE t.np_comm_id = g.np_comm_id AND COALESCE(t.unobtainable, 0) = 1)`;

/** Parse the frozen options column. A broken blob is an empty ballot, never a throw. */
export function parseOptions(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).slice(0, MAX_OPTIONS) : [];
  } catch {
    return [];
  }
}

/**
 * The count for every option, most votes first, and who won.
 *
 * `counts` is rows of { np_comm_id, n }. Options nobody voted for still appear,
 * at zero, because "nobody wanted Hawken" is part of the result.
 *
 * A TIE IS REPORTED AS A TIE. Picking one of the tied games by some hidden rule
 * (the order they were listed, who voted first) would be the bot deciding
 * something chat did not decide. `winner` is null and `tied` names them, and
 * the streamer calls it.
 */
export function tally(options, counts) {
  const by = new Map((counts ?? []).map((r) => [r.np_comm_id, Number(r.n) || 0]));
  const order = new Map(options.map((id, i) => [id, i]));
  const rows = options
    .map((id) => ({ id, votes: by.get(id) ?? 0 }))
    .sort((a, b) => b.votes - a.votes || order.get(a.id) - order.get(b.id));
  const total = rows.reduce((s, r) => s + r.votes, 0);
  for (const r of rows) r.percent = total ? Math.round((r.votes / total) * 100) : 0;

  const top = rows[0]?.votes ?? 0;
  const leaders = top ? rows.filter((r) => r.votes === top).map((r) => r.id) : [];
  return {
    rows,
    total,
    winner: leaders.length === 1 ? leaders[0] : null,
    tied: leaders.length > 1 ? leaders : [],
  };
}

/**
 * Twitch's opaque id for a viewer who can vote, or null.
 *
 * "U" ids belong to logged-in viewers and stay the same for them on this
 * extension. "A" ids are logged-out viewers and change every session, so
 * letting them vote would be one vote per page refresh.
 *
 * THE FIRST CHARACTER IS THE ONLY THING TWITCH ACTUALLY PROMISES. This used to
 * be `/^U[A-Za-z0-9]{1,64}$/`, written from the documented shape: "U" followed
 * by the numeric Twitch user id, as in `U15185913`. That is not what everybody
 * gets. Twitch's own issue tracker has it as issue 559 - with ID linking in the
 * picture the id comes back as "U" followed by a long random token instead, and
 * one `-`, one `_` or a sixty-fifth character was enough for us to call a
 * signed-in viewer anonymous.
 *
 * WHAT IT COST. UncleUrbi, JoJo and GD could not vote for a fortnight, and it
 * read as a Twitch problem the whole time because the panel's own message said
 * "Log in to Twitch to vote" to three people who plainly were. They were sent
 * off to turn off ad blockers, VPNs, antivirus and Firefox's tracking
 * protection, none of which was ever going to help, because the refusal was
 * ours. Migration 039's `panel_log` is what caught it: a row saying `anon` with
 * the prefix `U` on it, which cannot happen if the rule is right.
 *
 * SO THE RULE IS NOW WHAT IT ALWAYS MEANT. Starts with U, is not empty, has no
 * spaces or control characters in it, and is a sane length. The old pattern was
 * guarding against SQL that cannot happen anyway: this value is only ever bound
 * as a parameter, never pasted into a statement.
 */
export const voterId = (opaqueUserId) => {
  const id = String(opaqueUserId ?? '').trim();
  if (id.length < 2 || id.length > 255) return null;
  if (id[0] !== 'U') return null;
  // Printable ASCII only - no spaces, no control characters, nothing exotic.
  return /^[\x21-\x7e]+$/.test(id) ? id : null;
};

/**
 * The SHAPE of an opaque id: letters become `a`, digits become `9`, and
 * anything else is left as itself. `U15185913` reads `U99999999`.
 *
 * For the diagnostic only, and it exists so that a question like "what is in
 * these ids" can be answered without storing anybody's id. It is the difference
 * between knowing there is a hyphen in there and knowing who that is.
 */
export const idShape = (opaqueUserId) => {
  const id = String(opaqueUserId ?? '').slice(0, 80);
  return id.slice(0, 1) + id.slice(1).replace(/[A-Za-z]/g, 'a').replace(/[0-9]/g, '9');
};
