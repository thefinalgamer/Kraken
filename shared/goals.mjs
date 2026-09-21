/**
 * Personal goals. /goal in Discord, cards on the hunter page.
 *
 * Asked for by PrimalxFear on 8 September: "im close to 200k, and set that as a
 * goal for end of month... or set completion rate goal till end of year", with a
 * screenshot of another site's goal cards. Martin, 21 September: goals can be
 * seen by all, and they sit beside Rivals and Deal the cards.
 *
 * NOTHING HERE NEEDS A NEW NUMBER. Every kind of goal reads a column the members
 * row already carries and every scan and rescore already keeps current. A goal
 * stores two things of its own: where you started, and where you want to be.
 * Everything else on the card is arithmetic on those and the live row.
 *
 * Pure functions only, shared by the Worker (/goal), the site (the cards) and
 * the jobs (deciding a goal has been hit). One copy of the rules, so the bot
 * cannot congratulate somebody the page still says is short.
 */

/**
 * The kinds of goal, and which members column each one reads.
 *
 * `decimals` is how the number is written, not how it is stored. Completion is
 * a percentage to two places everywhere else on this site, so it is here too.
 */
export const GOAL_KINDS = {
  points: {
    label: 'points',
    title: (t) => `${fmt('points', t)} points`,
    value: (m) => Number(m?.points) || 0,
    decimals: 0,
  },
  completion: {
    label: 'completion',
    title: (t) => `${fmt('completion', t)}% completion`,
    value: (m) => Number(m?.completion) || 0,
    decimals: 2,
    max: 100,
  },
  platinum: {
    label: 'platinums',
    title: (t) => `${fmt('platinum', t)} platinums`,
    value: (m) => Number(m?.platinum) || 0,
    decimals: 0,
  },
  completed: {
    label: 'completed games',
    title: (t) => `${fmt('completed', t)} completed games`,
    value: (m) => Number(m?.completed) || 0,
    decimals: 0,
  },
  trophies: {
    label: 'trophies',
    title: (t) => `${fmt('trophies', t)} trophies`,
    value: (m) =>
      (Number(m?.platinum) || 0) + (Number(m?.gold) || 0) +
      (Number(m?.silver) || 0) + (Number(m?.bronze) || 0),
    decimals: 0,
  },
};

/**
 * How many goals somebody may have running at once.
 *
 * Six fills two rows of cards on a laptop. A goal list longer than that is a
 * to-do list, and nobody checks a to-do list for fun.
 */
export const MAX_ACTIVE_GOALS = 6;

/** How many finished goals the page keeps showing. The rest stay in the table. */
export const MAX_FINISHED_SHOWN = 6;

/** Five years. A deadline further out than that is not a deadline. */
export const MAX_DEADLINE_MS = 5 * 365 * 86_400_000;

const DAY = 86_400_000;

/** A number written the way this kind of goal writes it. */
export function fmt(kind, value) {
  const k = GOAL_KINDS[kind];
  const d = k ? k.decimals : 0;
  const v = Number(value) || 0;
  // The nudge is for floating point, not rounding: 75.57 * 100 is 7556.999...
  // and flooring that would print a start value one hundredth short.
  return d
    ? (Math.floor(v * 10 ** d + 1e-6) / 10 ** d).toFixed(d)
    : Math.round(v).toLocaleString('en-GB');
}

/**
 * An AMOUNT of this kind of goal, with its unit: "2,240 points", "3.45%",
 * "272 platinums". Completion is a percentage, so it takes a % sign rather than
 * the word, and "3.45 completion to go" never gets written.
 */
export function amount(kind, value) {
  return kind === 'completion'
    ? `${fmt(kind, value)}%`
    : `${fmt(kind, value)} ${GOAL_KINDS[kind]?.label ?? ''}`.trim();
}

/** A per-day amount, with its unit, for "needs 249 points a day". */
export function rateAmount(kind, value) {
  return kind === 'completion'
    ? `${rate(value)}%`
    : `${rate(value)} ${GOAL_KINDS[kind]?.label ?? ''}`.trim();
}

/**
 * A per-day figure. Whole numbers once they are big enough to be, two places
 * below ten, because "0.53 platinums a day" is the useful sentence and "1" is
 * not.
 */
export function rate(value) {
  const v = Number(value) || 0;
  return Math.abs(v) >= 10 ? Math.round(v).toLocaleString('en-GB') : v.toFixed(2);
}

/** "A total of 200,000 points" and friends. Unknown kinds render as nothing. */
export const goalTitle = (goal) => GOAL_KINDS[goal?.kind]?.title(goal.target) ?? '';

/** Where a member currently stands on one kind of goal. */
export const currentValue = (kind, member) => GOAL_KINDS[kind]?.value(member) ?? 0;

/**
 * A date typed into Discord, as the last moment of that day in UTC, or null.
 *
 * UK ORDER FIRST. The server is British and 1/10/2026 means the first of
 * October to everybody in it. ISO (2026-10-01) is accepted too, because it is
 * the one format nobody can misread. Two-digit years are read as 20xx.
 *
 * A date that does not exist (31/02) is refused rather than rolled forward into
 * March, which is what JavaScript would do left to itself.
 */
export function parseDeadline(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;

  let d, mo, y;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    [y, mo, d] = [m[1], m[2], m[3]].map(Number);
  } else {
    m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/);
    if (!m) return null;
    [d, mo, y] = [m[1], m[2], m[3]].map(Number);
    if (y < 100) y += 2000;
  }

  const at = Date.UTC(y, mo - 1, d);
  const back = new Date(at);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  // The END of the day they named. "By 30 September" includes the 30th.
  return at + DAY - 1;
}

/**
 * Whether a new goal makes sense, as an error sentence or null.
 *
 * A goal has to be somewhere you are not yet. Setting "100 platinums" when you
 * have 140 would be marked reached on the next scan and posted to the channel
 * as an achievement, which it is not.
 */
export function goalProblem({ kind, target, deadline, member, now = Date.now() }) {
  const k = GOAL_KINDS[kind];
  if (!k) return 'Pick what the goal is for from the list.';
  const t = Number(target);
  if (!Number.isFinite(t) || t <= 0) return 'The target has to be a number above zero.';
  if (k.max && t > k.max) return `A ${k.label} goal can go up to ${k.max}, not past it.`;
  if (!k.decimals && !Number.isInteger(t)) return `A ${k.label} goal has to be a whole number.`;

  const cur = k.value(member);
  if (t <= cur) {
    return `You are already on **${fmt(kind, cur)}** ${k.label}. ` +
      'A goal has to be somewhere you have not got to yet.';
  }

  if (deadline !== null && deadline !== undefined) {
    if (!Number.isFinite(deadline)) {
      return 'That date did not make sense. Try it like `31/12/2026`.';
    }
    if (deadline <= now) return 'That date has already gone. Pick one in the future.';
    if (deadline - now > MAX_DEADLINE_MS) return 'Pick a date within the next five years.';
  }
  return null;
}

/**
 * Everything a goal card shows, worked out from the goal and the live row.
 *
 * `state` is one of:
 *   active   still going
 *   reached  hit it (reached_at set by a job, or the live number is already there)
 *   missed   the deadline passed first
 *
 * PROGRESS IS MEASURED FROM WHERE THEY STARTED, not from zero. 197,760 of
 * 200,000 points is 98.9% of the target and says nothing; 13,640 of the 15,880
 * they set out to gain is 86% and is the number worth watching. Same as the
 * screenshot Primal sent.
 *
 * It can go backwards. Points re-price every night and completion drops when
 * somebody starts a new game, so "current" below "start" is real and the bar
 * simply sits at zero rather than pretending.
 */
export function goalStatus(goal, member, now = Date.now()) {
  const kind = goal.kind;
  const start = Number(goal.start_value) || 0;
  const target = Number(goal.target) || 0;
  const deadline = goal.deadline_at == null ? null : Number(goal.deadline_at);
  const created = Number(goal.created_at) || now;

  const reachedAt = goal.reached_at == null ? null : Number(goal.reached_at);
  const endedAt = goal.ended_at == null ? null : Number(goal.ended_at);
  const frozen = goal.final_value == null ? null : Number(goal.final_value);

  const live = currentValue(kind, member);
  let state = 'active';
  if (reachedAt) state = 'reached';
  else if (endedAt) state = 'missed';
  else if (live >= target) state = 'reached';
  else if (deadline && now > deadline) state = 'missed';

  // A finished goal shows the number it finished on, not whatever the row says
  // months later. Before the job has frozen it, the live number stands in.
  const current = state === 'active' || frozen === null ? live : frozen;

  const span = target - start;
  const done = current - start;
  const ratio = span > 0 ? Math.max(0, Math.min(1, done / span)) : 1;
  const remaining = Math.max(0, target - current);

  const elapsedDays = Math.max(0, (now - created) / DAY);
  const daysLeft = deadline ? Math.max(0, Math.ceil((deadline - now) / DAY)) : null;
  const timeRatio = deadline
    ? Math.max(0, Math.min(1, (now - created) / Math.max(1, deadline - created)))
    : null;

  /**
   * THE PACE, and the one judgement on the card.
   *
   * What they need per day from here, against what they have actually managed
   * per day since they set it. Under a day old there is no "actually managed"
   * worth the name, so it says nothing rather than calling somebody behind an
   * hour after they started.
   */
  const actualPerDay = elapsedDays >= 1 ? done / elapsedDays : null;
  const neededPerDay = daysLeft ? remaining / daysLeft : null;
  let pace = null;
  if (state === 'active' && deadline && actualPerDay !== null && neededPerDay !== null) {
    pace = actualPerDay >= neededPerDay ? 'on' : 'behind';
  }

  return {
    kind,
    title: goalTitle(goal),
    state,
    start,
    target,
    current,
    remaining,
    percent: ratio * 100,
    deadline,
    daysLeft,
    timeRatio,
    actualPerDay,
    neededPerDay,
    pace,
    created,
    reachedAt: state === 'reached' ? reachedAt ?? null : null,
    endedAt: state === 'missed' ? endedAt ?? deadline : null,
  };
}

/**
 * What a job should write for one open goal, or null if nothing has changed.
 *
 * `{ reached: true }` is the one that gets posted to Discord. A missed goal is
 * frozen quietly: nobody wants their miss announced to the server.
 */
export function goalSettlement(goal, member, now = Date.now()) {
  if (goal.reached_at != null || goal.ended_at != null) return null;
  const live = currentValue(goal.kind, member);
  if (live >= Number(goal.target)) return { reached: true, value: live, at: now };
  if (goal.deadline_at != null && now > Number(goal.deadline_at)) {
    return { reached: false, value: live, at: now };
  }
  return null;
}
