/**
 * Games with a deadline.
 *
 * THE DISTINCTION IS THE WHOLE POINT, and it came from Martin:
 *
 *   "one icon says this is already dead
 *    one icon says ive got time to do this — this icon at a glance people
 *    think oh ill do it"
 *
 * A dead game is a warning. A dying game is a reason to start tonight. They
 * look similar in a database and do completely opposite things to a person, so
 * they get different icons, different words and different colours everywhere.
 *
 * ONE DEFINITION, imported by the bot and mirrored by the website, for the same
 * reason `contested.mjs` exists: the day these two disagree about whether a
 * game is closed is the day nobody believes either of them.
 */

/** Already gone. */
export const DEAD = 'dead';
/** Announced closure, still in the future. */
export const CLOSING = 'closing';
/** Nothing announced. */
export const FINE = 'fine';

/**
 * Under this many days the deadline is the point, not a footnote.
 *
 * Thirty is a month of evenings, which is roughly the shortest window in which
 * somebody can realistically decide to platinum a game they have not started.
 */
export const URGENT_DAYS = 30;

export const DAY_MS = 86400000;

/**
 * What state is this game in?
 *
 * `unobtainable` WINS over any date. A mod who flags a game by hand has looked
 * at it; a date is a prediction somebody typed weeks ago. If both are set, the
 * human is right.
 */
export function closingState(game, now = Date.now()) {
  if (Number(game?.unobtainable) === 1) return DEAD;
  const at = Number(game?.closes_at);
  if (!Number.isFinite(at) || at <= 0) return FINE;
  return at <= now ? DEAD : CLOSING;
}

/** Whole days left, rounded UP — "1 day left" while any of it remains. */
export function daysLeft(closesAt, now = Date.now()) {
  const at = Number(closesAt);
  if (!Number.isFinite(at) || at <= now) return 0;
  return Math.ceil((at - now) / DAY_MS);
}

export const isUrgent = (closesAt, now = Date.now()) => {
  const d = daysLeft(closesAt, now);
  return d > 0 && d <= URGENT_DAYS;
};

/**
 * "closes in 12 days", "closes tomorrow", "closes on 15 March 2027".
 *
 * Days while a countdown still means something, a date once it does not. "In
 * 400 days" is not a deadline anybody can feel, and "on 3 October 2027" is not
 * a thing anybody panics about — each phrasing is right in exactly one range.
 */
export function closingLabel(closesAt, now = Date.now()) {
  const at = Number(closesAt);
  if (!Number.isFinite(at) || at <= 0) return '';
  if (at <= now) return 'closed';

  const d = daysLeft(at, now);
  if (d === 1) return 'closes tomorrow';
  if (d <= 90) return `closes in ${d} days`;
  return `closes on ${new Date(at).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })}`;
}

/**
 * A date a moderator typed, or null.
 *
 * STRICT YYYY-MM-DD, and nothing else. Mods will otherwise type "March",
 * "next spring" and "soon", and a date field that accepts anything is a text
 * field wearing a hat — the note is already there for prose. Rejecting clearly
 * is kinder than storing something we cannot count down from.
 *
 * Parsed as UTC midnight at the START of the named day, then pushed to the END
 * of it: a server announced as closing "on the 15th" is up for all of the 15th.
 * Being a day generous is the harmless direction; being a day mean tells
 * somebody a game is dead while they can still play it.
 */
export function parseClosingDate(input, now = Date.now()) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: true, at: null };

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) {
    return { ok: false, reason: 'Use YYYY-MM-DD, like 2027-03-15.' };
  }

  const [, y, mo, d] = m.map(Number);
  const at = Date.UTC(y, mo - 1, d) + DAY_MS - 1;

  // Date.UTC happily rolls 2027-02-31 into March. Checking the parts survive
  // the round trip is what turns that from a silent wrong answer into an error.
  const back = new Date(at);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return { ok: false, reason: `There is no ${raw}.` };
  }

  if (at <= now) {
    return {
      ok: false,
      reason: 'That date has passed. Flag it with a note instead — it is already dead.',
    };
  }
  // Ten years is not a shutdown announcement, it is a typo in the year.
  if (at - now > 3650 * DAY_MS) {
    return { ok: false, reason: 'That is more than ten years away. Check the year.' };
  }

  return { ok: true, at };
}
