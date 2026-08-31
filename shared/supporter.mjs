/**
 * The supporter star.
 *
 * ONE DEFINITION, read by the website and the bot, for exactly the reason the
 * closing clock got its own file: the badge appears on the leaderboard, on a
 * hunter page and on Discord cards, and three copies of a threshold table is
 * three chances for somebody's star to be gold in one place and silver in
 * another.
 *
 * COSMETIC. Nothing here may ever reach the scoring — not points, not rank, not
 * tier, not the order of a list. The board's whole worth is that it records
 * what people earned. A star says thank you; it does not buy anything.
 */

/**
 * The steps, in months.
 *
 * Borrowed from Twitch rather than invented, because these are the numbers
 * people already have a feel for: something happens at the start, at three
 * months, at six, and at a year. Trophy hunters understand patience being
 * rewarded on that curve.
 *
 * Ordered high to low so the lookup below can return the first match.
 */
export const SUPPORTER_TIERS = [
  { months: 12, key: 'p', name: 'Platinum', color: '#7fd6f5' },
  { months: 6, key: 'g', name: 'Gold', color: '#f0c419' },
  { months: 3, key: 's', name: 'Silver', color: '#c9ccd1' },
  { months: 1, key: 'b', name: 'Bronze', color: '#e08a4a' },
];

/**
 * @param months how many months they have supported, ever
 * @returns the tier, or null for somebody who has not
 *
 * A missing, zero or nonsense value is "not a supporter" rather than an error.
 * This runs inside a table row on a page that must render for everybody, and a
 * decoration is never worth a broken page.
 */
export function supporterTier(months) {
  const m = Math.floor(Number(months) || 0);
  if (m < 1) return null;
  return SUPPORTER_TIERS.find((t) => m >= t.months) ?? null;
}

/** "Supporter · 8 months" — the whole of what the badge says on hover. */
export function supporterLabel(months) {
  const tier = supporterTier(months);
  if (!tier) return '';
  const m = Math.floor(Number(months) || 0);
  return `${tier.name} supporter · ${m} month${m === 1 ? '' : 's'}`;
}
